"""Input validation and exclusive local result files."""
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image

def validate_inputs(files):
    if not 1 <= len(files) <= 20: raise ValueError('請選擇 1–20 張圖片')
    if sum(len(data) for _, data in files) > 80 * 1024 * 1024: raise ValueError('總大小不能超過 80MB')
    checked = []
    for name, data in files:
        if Path(name).suffix.lower() not in {'.jpg', '.jpeg', '.png', '.webp'}: raise ValueError('僅支援 JPG、PNG、WebP')
        try:
            with Image.open(io.BytesIO(data)) as im:
                if im.format not in {'JPEG', 'PNG', 'WEBP'} or getattr(im, 'n_frames', 1) != 1: raise ValueError('僅支援靜態圖片')
                if im.width * im.height > 16_000_000 or max(im.size) > 16000: raise ValueError('圖片尺寸超過限制')
                im.verify()
            with Image.open(io.BytesIO(data)) as im: im.load()
        except Exception as exc: raise ValueError(f'無效圖片：{name}') from exc
        checked.append((Path(name).name, bytes(data)))
    return checked

def save_result(output_dir, name, data, prompt):
    folder = Path(output_dir).expanduser().resolve(); folder.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(data)) as im:
        im.load(); output = io.BytesIO(); im.convert('RGBA' if 'A' in im.getbands() else 'RGB').save(output, 'PNG')
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', Path(name).stem).strip(' .')[:150] or 'image'
    for number in range(10000):
        suffix = '' if number == 0 else f'_{number}'
        path = folder / f'{stem}_繁體{suffix}.png'; record = path.with_suffix('.json')
        try:
            with path.open('xb') as handle: handle.write(output.getvalue())
        except FileExistsError: continue
        metadata = {'output_path': str(path), 'record_path': str(record), 'prompt': prompt,
                    'time': datetime.now(timezone.utc).isoformat(), 'status': 'completed', 'review_needed': True}
        try:
            handle = record.open('x', encoding='utf-8')
        except FileExistsError:
            path.unlink(missing_ok=True)
            continue
        except Exception:
            path.unlink(missing_ok=True)
            raise
        try:
            with handle:
                json.dump(metadata, handle, ensure_ascii=False, indent=2)
        except Exception:
            path.unlink(missing_ok=True)
            record.unlink(missing_ok=True)
            raise
        return metadata
    raise OSError('無法建立唯一結果檔名')
