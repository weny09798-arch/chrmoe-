"""Offline OCR and constrained text replacement. No remote requests are used."""
from dataclasses import dataclass
from functools import lru_cache
import io
import math
import os
from pathlib import Path
import threading

import cv2
import numpy as np
from opencc import OpenCC
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

MAX_PIXELS = 16_000_000
MAX_SIDE = 16_000
MODES = ('s2t', 's2tw', 's2twp', 's2hk')


@dataclass(frozen=True)
class Region:
    """A rectangle (x0,y0,x1,y1) or RapidOCR quadrilateral, text and confidence."""
    box: object
    text: str
    score: float


def decode_image(data: bytes) -> Image.Image:
    """Validate before decoding, orient EXIF, return independent RGB/RGBA pixels."""
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in ('PNG', 'JPEG', 'WEBP'):
                raise ValueError('仅支持 PNG、JPG 和 WebP 图片')
            if getattr(source, 'n_frames', 1) != 1:
                raise ValueError('不支持动画图片')
            width, height = source.size
            if width * height > MAX_PIXELS or max(width, height) > MAX_SIDE:
                raise ValueError('图片不能超过 1600 万像素或单边 16000 像素')
            source.load()
            oriented = ImageOps.exif_transpose(source)
            alpha = 'A' in oriented.getbands() or 'transparency' in oriented.info
            return oriented.convert('RGBA' if alpha else 'RGB')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('图片损坏或格式无效') from exc


@lru_cache(maxsize=4)
def _converter(mode):
    if mode not in MODES:
        raise ValueError('不支持的繁体转换模式')
    return OpenCC(mode)


def _font_path(explicit):
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            raise ValueError('指定的字体文件不存在')
        return str(path)
    # Windows owns these fonts; the portable application never copies them.
    fonts = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Fonts'
    for name in ('msjh.ttc', 'msjhbd.ttc', 'mingliu.ttc'):
        path = fonts / name
        if path.is_file():
            return str(path)
    raise ValueError('未找到繁体中文系统字体，请安装微软正黑体')


def _coordinates(box, size):
    try:
        points = np.asarray(box, dtype=float)
        if points.shape == (4,):
            x0, y0, x1, y1 = points
            points = np.array(((x0, y0), (x1, y0), (x1, y1), (x0, y1)))
        if points.shape != (4, 2) or not np.isfinite(points).all():
            return None, [], 'invalid_box'
        serial = points.tolist()
        x0, y0 = np.floor(points.min(axis=0)).astype(int)
        x1, y1 = np.ceil(points.max(axis=0)).astype(int)
        if x1 <= x0 or y1 <= y0 or abs(cv2.contourArea(points.astype(np.float32))) < 1:
            return None, serial, 'invalid_box'
        if x0 < 0 or y0 < 0 or x1 > size[0] or y1 > size[1]:
            return None, serial, 'out_of_bounds'
        for start, end in ((points[0], points[1]), (points[3], points[2])):
            dx, dy = end - start
            if abs(dx) < 1 or abs(math.degrees(math.atan2(dy, dx))) > 5:
                return None, serial, 'rotated'
        if y1 - y0 < 12 or x1 - x0 < 8:
            return None, serial, 'too_small'
        return (int(x0), int(y0), int(x1), int(y1)), serial, ''
    except (TypeError, ValueError, OverflowError):
        return None, [], 'invalid_box'


def _replace(crop, text, font_path):
    """Return local pixels, or a reason when a safe foreground cannot be found."""
    height, width = crop.shape[:2]
    if crop.shape[2] == 4 and np.ptp(crop[:, :, 3]) != 0:
        return None, 'transparent_text'
    rgb = crop[:, :, :3].copy()
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    background = np.median(border, axis=0)
    distance = np.linalg.norm(rgb.astype(float) - background, axis=2)
    # Suppress tiny texture differences; preserve every pixel outside the masks.
    peak = float(np.percentile(distance, 95))
    if peak < 25:
        return None, 'no_clear_foreground'
    # OCR boxes may touch strokes. Exclude high-contrast ink from the border
    # check, while still detecting texture and secondary outline colours.
    border_distance = np.linalg.norm(border.astype(float) - background, axis=1)
    background_samples = border_distance[border_distance < max(40, peak * .65)]
    if len(background_samples) < len(border) * .2 or np.percentile(background_samples, 90) > 55:
        return None, 'complex_background'
    foreground = distance > max(24, peak * .42)
    if not foreground.any() or foreground.mean() > .65:
        return None, 'complex_background'
    ink = np.median(rgb[foreground], axis=0).astype(np.uint8)
    ys, xs = np.where(foreground)
    glyph_width, glyph_height = int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
    font = None
    bounds = None
    for font_size in range(min(height, glyph_height * 2), 7, -1):
        candidate = ImageFont.truetype(font_path, font_size)
        bbox = candidate.getbbox(text)
        if bbox[2] - bbox[0] <= min(width - 2, glyph_width + 2) and bbox[3] - bbox[1] <= min(height - 2, glyph_height + 1):
            font, bounds = candidate, bbox
            break
    if font is None:
        return None, 'text_does_not_fit'
    # Position the new visible glyph bounds over the original visible bounds.
    text_width, text_height = bounds[2] - bounds[0], bounds[3] - bounds[1]
    left = min(max(0, int(xs.min() + (glyph_width - text_width) / 2)), width - text_width)
    top = min(max(0, int(ys.min() + (glyph_height - text_height) / 2)), height - text_height)
    glyph = Image.new('L', (width, height), 0)
    ImageDraw.Draw(glyph).text((left - bounds[0], top - bounds[1]), text, font=font, fill=255)
    glyph_alpha = np.asarray(glyph, dtype=np.float32) / 255
    old_mask = cv2.dilate(foreground.astype(np.uint8), np.ones((3, 3), np.uint8))
    inpainted = cv2.inpaint(rgb, old_mask * 255, 3, cv2.INPAINT_TELEA)
    merged = rgb.copy()
    merged[old_mask.astype(bool)] = inpainted[old_mask.astype(bool)]
    rendered = np.rint(merged * (1 - glyph_alpha[:, :, None]) + ink * glyph_alpha[:, :, None]).astype(np.uint8)
    result = crop.copy()
    result[:, :, :3] = rendered
    return result, ''


def translate_regions(image: Image.Image, regions, mode='s2t', font_path=None):
    converter = _converter(mode)
    if image.mode not in ('RGB', 'RGBA'):
        image = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
    pixels = np.array(image)
    rows = []
    selected_font = None
    for region in regions:
        target = converter.convert(region.text)
        rectangle, serial, reason = _coordinates(region.box, image.size)
        try:
            score = float(region.score)
        except (TypeError, ValueError):
            score = float('nan')
        row = {'source': region.text, 'traditional': target, 'score': score if math.isfinite(score) else None,
               'status': 'unchanged', 'reason': '', 'box': serial}
        if target != region.text:
            if not math.isfinite(score) or score < .75:
                reason = 'low_confidence'
            if not reason:
                selected_font = selected_font or _font_path(font_path)
                x0, y0, x1, y1 = rectangle
                patch, reason = _replace(pixels[y0:y1, x0:x1], target, selected_font)
                if patch is not None:
                    pixels[y0:y1, x0:x1] = patch
            row['status'] = 'skipped' if reason else 'changed'
            row['reason'] = reason
        rows.append(row)
    report = {'regions': rows, 'changed': sum(row['status'] == 'changed' for row in rows),
              'skipped': sum(row['status'] == 'skipped' for row in rows), 'count': len(rows),
              'dimensions': {'width': image.width, 'height': image.height}}
    return Image.fromarray(pixels), report


class Translator:
    """Lazily load package-local ONNX models once; serialize CPU OCR calls."""
    def __init__(self, font_path=None):
        self.font_path = font_path
        self._ocr = None
        self._lock = threading.Lock()

    def convert(self, image_bytes: bytes, mode='s2t'):
        _converter(mode)
        image = decode_image(image_bytes)
        with self._lock:
            if self._ocr is None:
                from rapidocr_onnxruntime import RapidOCR
                self._ocr = RapidOCR(intra_op_num_threads=min(4, os.cpu_count() or 1), inter_op_num_threads=1,
                                     text_score=.3, max_side_len=2000)
            # RapidOCR ndarray input expects OpenCV BGR, independent of alpha.
            results, _ = self._ocr(cv2.cvtColor(np.array(image.convert('RGB')), cv2.COLOR_RGB2BGR))
            regions = [Region(box, text, float(score)) for box, text, score in (results or [])]
            converted, report = translate_regions(image, regions, mode, self.font_path)
        stream = io.BytesIO()
        converted.save(stream, format='PNG')
        return stream.getvalue(), report
