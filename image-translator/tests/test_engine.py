import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import Region, Translator, decode_image, translate_regions

FONT = r'C:\Windows\Fonts\msjh.ttc'


def sample(mode='RGB'):
    image = Image.new(mode, (400, 100), (255, 255, 255, 123) if mode == 'RGBA' else 'white')
    ImageDraw.Draw(image).text((24, 24), '减少细菌滋生', font=ImageFont.truetype(FONT, 36), fill=(210, 20, 30, 123) if mode == 'RGBA' else (210, 20, 30))
    return image


def encoded(image, format='PNG', **kwargs):
    stream = io.BytesIO()
    image.save(stream, format=format, **kwargs)
    return stream.getvalue()


@pytest.mark.parametrize('mode', ['RGB', 'RGBA'])
def test_high_confidence_converts_only_local_text_and_preserves_alpha(mode):
    image = sample(mode)
    before = np.array(image)
    result, report = translate_regions(image, [Region((20, 20, 260, 72), '减少细菌滋生', .99)])
    after = np.array(result)
    assert report['regions'][0]['traditional'] == '減少細菌滋生'
    assert report['regions'][0]['status'] == 'changed'
    assert report['changed'] == 1
    assert report['dimensions'] == {'width': 400, 'height': 100}
    assert result.size == image.size
    assert result.mode == image.mode
    assert np.any(after[20:72, 20:260, :3] != before[20:72, 20:260, :3])
    outside = np.ones((100, 400), bool)
    outside[20:72, 20:260] = False
    assert np.array_equal(before[outside], after[outside])
    assert np.array_equal(before, np.array(image))
    if mode == 'RGBA':
        assert np.array_equal(before[:, :, 3], after[:, :, 3])
    json.dumps(report, allow_nan=False)


@pytest.mark.parametrize('box,score,reason', [
    ((20, 20, 260, 72), .3, 'low_confidence'),
    ((20, 20, 260, 28), .99, 'too_small'),
    ((-1, 20, 260, 72), .99, 'out_of_bounds'),
    ((20, 20, 401, 72), .99, 'out_of_bounds'),
    (((20, 20), (260, 50), (260, 80), (20, 50)), .99, 'rotated'),
    ((20, 20, 20, 72), .99, 'invalid_box'),
])
def test_unsafe_regions_leave_image_identical(box, score, reason):
    image = sample()
    result, report = translate_regions(image, [Region(box, '减少细菌滋生', score)])
    assert result.tobytes() == image.tobytes()
    assert report['regions'][0]['reason'] == reason
    assert report['skipped'] == 1


def test_numbers_do_not_change_and_mixed_numbers_remain_exact():
    image = sample()
    result, report = translate_regions(image, [Region((20, 20, 260, 72), '1.25% 500g 2026', .99)])
    assert result.tobytes() == image.tobytes()
    assert report['regions'][0]['status'] == 'unchanged'
    _, report = translate_regions(image, [Region((20, 20, 360, 72), '细菌减少99.9% 500g', .99)])
    assert report['regions'][0]['traditional'] == '細菌減少99.9% 500g'


@pytest.mark.parametrize('mode,target', [('s2t', '軟件'), ('s2tw', '軟件'), ('s2twp', '軟體'), ('s2hk', '軟件')])
def test_conversion_modes(mode, target):
    _, report = translate_regions(sample(), [Region((20, 20, 260, 72), '软件', .99)], mode=mode)
    assert report['regions'][0]['traditional'] == target


def test_invalid_conversion_mode_rejected():
    with pytest.raises(ValueError):
        translate_regions(sample(), [], mode='invalid')


def test_transparent_glyphs_are_kept_intact_instead_of_corrupted():
    image = Image.new('RGBA',(400,100),(255,255,255,0))
    ImageDraw.Draw(image).text((24,24),'减少细菌滋生',font=ImageFont.truetype(FONT,36),fill=(210,20,30,255))
    result, report = translate_regions(image,[Region((20,20,260,72),'减少细菌滋生',.99)])
    assert result.tobytes() == image.tobytes()
    assert report['regions'][0]['reason'] == 'transparent_text'
    assert report['skipped'] == 1


def test_text_over_texture_is_skipped_without_erasing_background():
    random = np.random.default_rng(7)
    image = Image.fromarray(random.integers(100,230,size=(100,400,3),dtype=np.uint8))
    ImageDraw.Draw(image).text((24,24),'减少细菌滋生',font=ImageFont.truetype(FONT,36),fill='black')
    result,report = translate_regions(image,[Region((20,20,260,72),'减少细菌滋生',.99)])
    assert result.tobytes() == image.tobytes()
    assert report['regions'][0]['reason'] == 'complex_background'


def test_gently_shaded_background_is_not_mistaken_for_photo_texture():
    pixels=np.zeros((100,400,3),dtype=np.uint8)
    pixels[:,:,0]=220
    pixels[:,:,1]=np.arange(100,dtype=np.uint8)[:,None]*2
    pixels[:,:,2]=20
    image=Image.fromarray(pixels)
    ImageDraw.Draw(image).text((24,24),'减少细菌滋生',font=ImageFont.truetype(FONT,36),fill='white')
    result,report=translate_regions(image,[Region((20,20,260,72),'减少细菌滋生',.99)])
    assert report['changed']==1
    assert result.tobytes()!=image.tobytes()


@pytest.mark.parametrize('format', ['PNG', 'JPEG', 'WEBP'])
def test_decode_allowed_static_images(format):
    assert decode_image(encoded(sample(), format)).size == (400, 100)


def test_decode_preserves_alpha_and_applies_orientation():
    assert decode_image(encoded(sample('RGBA'))).getchannel('A').tobytes() == sample('RGBA').getchannel('A').tobytes()
    exif = Image.Exif()
    exif[274] = 6
    assert decode_image(encoded(Image.new('RGB', (20, 30)), 'JPEG', exif=exif)).size == (30, 20)


@pytest.mark.parametrize('data', [b'not an image', encoded(Image.new('RGB', (10, 10)), 'GIF'), encoded(Image.new('RGB', (16001, 1))), encoded(Image.new('L', (4001, 4000)))], ids=['invalid', 'gif', 'long-side', 'pixels'])
def test_decode_rejects_invalid_format_or_oversized_images(data):
    with pytest.raises(ValueError):
        decode_image(data)


def test_decode_rejects_animated_png():
    data = encoded(Image.new('RGB', (10, 10), 'white'), save_all=True, append_images=[Image.new('RGB', (10, 10), 'red')])
    with pytest.raises(ValueError):
        decode_image(data)


def test_translator_runs_real_bundled_ocr_and_returns_png():
    image = Image.new('RGB', (600, 150), 'white')
    ImageDraw.Draw(image).text((30, 40), '减少细菌滋生', font=ImageFont.truetype(FONT, 56), fill='red')
    png, report = Translator().convert(encoded(image))
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    assert Image.open(io.BytesIO(png)).size == (600, 150)
    assert any(row['traditional'] == '減少細菌滋生' and row['status'] == 'changed' for row in report['regions'])
