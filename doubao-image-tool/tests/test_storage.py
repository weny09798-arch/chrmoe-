import io
import json
from pathlib import Path
import pytest
from PIL import Image
from storage import validate_inputs, save_result

def png():
    out = io.BytesIO(); Image.new('RGB', (2, 2)).save(out, 'PNG'); return out.getvalue()

def test_rejects_corrupt_input():
    with pytest.raises(ValueError): validate_inputs([('broken.png', b'invalid')])

def test_exclusive_output_is_png_and_original_unchanged(tmp_path):
    original = tmp_path/'a.png'; original.write_bytes(png())
    first = save_result(tmp_path, 'a.png', png(), 'convert')
    second = save_result(tmp_path, 'a.png', png(), 'convert')
    assert first['output_path'] != second['output_path']
    assert Path(first['output_path']).name == 'a_繁體.png'
    assert Image.open(first['output_path']).format == 'PNG'
    assert original.read_bytes() == png()
    record = json.loads(Path(first['record_path']).read_text(encoding='utf-8'))
    assert record['prompt'] == 'convert' and record['status'] == 'completed'

@pytest.mark.parametrize('files', [[], [('x.gif', b'bad')], [('x.png', b'x')]*21])
def test_rejects_invalid_batch(files):
    with pytest.raises(ValueError): validate_inputs(files)

def test_json_write_error_removes_owned_partial_files(tmp_path, monkeypatch):
    import storage
    original = storage.json.dump
    calls = []
    def fail_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            args[1].write('{partial')
            raise OSError('disk full')
        return original(*args, **kwargs)
    monkeypatch.setattr(storage.json, 'dump', fail_once)
    with pytest.raises(OSError, match='disk full'):
        save_result(tmp_path, 'a.png', png(), 'convert')
    assert list(tmp_path.iterdir()) == []
