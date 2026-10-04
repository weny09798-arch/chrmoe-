"""Save new PNG/report pairs with safe basenames and exclusive creation."""
import json
from pathlib import Path
import re


def _safe_stem(source_name):
    name = str(source_name).replace('\\', '/').rsplit('/', 1)[-1]
    stem = name.rsplit('.', 1)[0] if '.' in name else name
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', stem).strip(' .')[:80]
    return (stem or 'image') + '_繁體'


def save_result(output_dir, source_name, png, report):
    directory = Path(output_dir)
    if not directory.is_absolute() or (directory.exists() and not directory.is_dir()):
        raise ValueError('输出路径必须是绝对目录路径，且不能是已有文件')
    # Serialize first, so an invalid report cannot create a partial pair.
    report_bytes = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ValueError('无法创建输出目录') from exc
    directory = directory.resolve()
    stem = _safe_stem(source_name)
    for number in range(1, 100_001):
        name = stem if number == 1 else f'{stem}_{number}'
        png_path = directory / f'{name}.png'
        report_path = directory / f'{name}.json'
        try:
            png_file = png_path.open('xb')
        except FileExistsError:
            continue
        try:
            report_file = report_path.open('xb')
        except FileExistsError:
            png_file.close()
            png_path.unlink()
            continue
        except BaseException:
            png_file.close()
            png_path.unlink()
            raise
        try:
            with png_file, report_file:
                png_file.write(png)
                report_file.write(report_bytes)
        except BaseException:
            png_path.unlink(missing_ok=True)
            report_path.unlink(missing_ok=True)
            raise
        return {'png': str(png_path), 'report': str(report_path)}
    raise ValueError('同名输出文件过多，请选择新的输出目录')
