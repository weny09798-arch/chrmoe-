"""Temporary collector image files and previews after cloud publication."""
import io
import re
from pathlib import Path
from flask import send_file, jsonify
from storage import save_result
from image_batch import download_image
from oss_storage import read_public


def save_cached_result(job, item, data):
    return save_result(job['run_dir'], f"result_{item['index']}_{item.get('revision',0)}", data, job['prompt'])


def clean_cached_images(job, item, state_dir):
    if not job.get('cloud_only'):return
    root=Path(state_dir).resolve()
    if not re.fullmatch('[a-f0-9]{32}',job['id']):return
    folder=(root/job['id']).resolve()
    if folder.parent!=root:return
    result=item.get('result') or {}
    for value in [item.get('input_path'),item.get('cached_path'),result.get('output_path'),result.get('record_path')]:
        if not value:continue
        path=Path(value)
        if path.is_symlink() or folder not in path.resolve().parents:continue
        try:path.unlink(missing_ok=True)
        except OSError:pass  # Normal close still clears this owned temporary directory.


def image_response(snap,item,kind):
    path=item.get('input_path') if kind=='original' else (item.get('result') or {}).get('output_path') if kind=='result' else None
    if path and Path(path).is_file():return send_file(path)
    if not snap.get('cloud_only') or kind not in ('original','result'):return jsonify(error='图片尚未生成'),404
    url=item.get('url') if kind=='original' else (item.get('result') or {}).get('public_url')
    if not url:return jsonify(error='图片尚未生成'),404
    try:
        data=download_image(url)[0] if kind=='original' else read_public(url)
        return send_file(io.BytesIO(data),mimetype='image/png' if kind=='result' else None,download_name='preview.png')
    except Exception:return jsonify(error='预览图片暂时无法读取，请稍后重试'),502
