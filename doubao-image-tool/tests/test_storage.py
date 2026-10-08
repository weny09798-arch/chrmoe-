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

@pytest.mark.parametrize('name', ['bad<>name.png', '商品'*100+'.png', 'same.png'])
def test_metadata_maps_original_name_despite_sanitized_duplicate_output(tmp_path, name):
    first=save_result(tmp_path,name,png(),'convert');second=save_result(tmp_path,name,png(),'convert')
    assert first['output_path']!=second['output_path']
    for result in [first,second]:
        record=json.loads(Path(result['record_path']).read_text(encoding='utf-8'))
        assert record['original_name']==name

def test_clear_task_state_removes_only_owned_cache_and_records(tmp_path):
    from storage import clear_task_state
    root=tmp_path/'state'; root.mkdir()
    cache=root/('a'*32); cache.mkdir(); (cache/'input.png').write_bytes(png())
    (cache/'download.result').write_bytes(png()); (root/'job.json').write_text('{}')
    (root/'job.json.tmp').write_text('{}')
    unrelated=root/'notes'; unrelated.mkdir(); (unrelated/'keep.txt').write_text('keep')
    clear_task_state(root)
    assert not cache.exists() and not (root/'job.json').exists()
    assert not (root/'job.json.tmp').exists()
    assert (unrelated/'keep.txt').read_text()=='keep'

def test_clear_rejects_linked_cache_before_deleting_other_caches(tmp_path,monkeypatch):
    from storage import clear_task_state
    root=tmp_path/'state'; root.mkdir()
    good=root/('a'*32); good.mkdir(); (good/'keep').write_text('keep')
    linked=root/('b'*32); linked.mkdir()
    original=Path.is_junction
    monkeypatch.setattr(Path,'is_junction',lambda path:path==linked or original(path))
    with pytest.raises(OSError,match='任务缓存路径异常'): clear_task_state(root)
    assert (good/'keep').exists()
