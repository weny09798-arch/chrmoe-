import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import save_result


def test_duplicate_names_never_overwrite_existing_files(tmp_path):
    original = tmp_path / '商品.png'
    original.write_bytes(b'original')
    first = save_result(str(tmp_path), '商品.png', b'png1', {'traditional': '細菌'})
    second = save_result(str(tmp_path), '商品.png', b'png2', {'count': 2})
    assert first['png'] != second['png']
    assert Path(first['png']).read_bytes() == b'png1'
    assert Path(second['png']).read_bytes() == b'png2'
    assert original.read_bytes() == b'original'
    assert json.loads(Path(first['report']).read_text(encoding='utf-8')) == {'traditional': '細菌'}


@pytest.mark.parametrize('source', ['../../danger.png', r'C:\elsewhere\danger.jpg', 'CON.png', '..', 'a:b*?<>|.png'])
def test_source_names_cannot_escape_output_directory(tmp_path, source):
    result = save_result(str(tmp_path), source, b'png', {})
    assert Path(result['png']).parent == tmp_path
    assert Path(result['report']).parent == tmp_path
    assert Path(result['png']).suffix == '.png'


def test_relative_output_directory_rejected():
    with pytest.raises(ValueError):
        save_result('relative', 'test.png', b'png', {})


def test_existing_file_output_directory_rejected(tmp_path):
    target = tmp_path / 'file'
    target.write_bytes(b'existing')
    with pytest.raises(ValueError):
        save_result(str(target), 'test.png', b'png', {})
    assert target.read_bytes() == b'existing'


def test_new_absolute_directory_is_created(tmp_path):
    target = tmp_path / 'new' / 'folder'
    result = save_result(str(target), 'test.png', b'png', {})
    assert Path(result['png']).read_bytes() == b'png'


def test_concurrent_saves_use_exclusive_names(tmp_path):
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda n: save_result(str(tmp_path), 'same.png', str(n).encode(), {'n': n}), range(12)))
    assert len({result['png'] for result in results}) == 12
    for n, result in enumerate(results):
        assert Path(result['png']).read_bytes() == str(n).encode()
        assert json.loads(Path(result['report']).read_text('utf-8'))['n'] == n


def test_report_failure_leaves_no_partial_result(tmp_path):
    with pytest.raises((TypeError, ValueError)):
        save_result(str(tmp_path), 'bad.png', b'png', {'invalid': object()})
    assert list(tmp_path.iterdir()) == []
