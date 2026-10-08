"""Whole HTTP-to-worker-to-published-mapping flow with external I/O replaced."""
import io
import json
import time
from pathlib import Path
from contextlib import nullcontext
from PIL import Image
from app import create_app
from core import NeedsUser
from oss_fakes import FakePublisher


def image(color):
    stream = io.BytesIO()
    Image.new('RGB', (8, 8), color).save(stream, 'PNG')
    return stream.getvalue()


class Cloud:
    def __init__(self):
        self.submissions = 0
        self.verified = False

    def open(self): pass
    def close(self): pass

    def submit(self, path, prompt, send_gate=nullcontext):
        with send_gate():
            assert Path(path).is_file()
            assert '包裝' in prompt and '原樣保留' in prompt
            self.submissions += 1

    def poll(self):
        if not self.verified:
            raise NeedsUser('请完成网页验证，再获取同一结果')
        return image('blue')


def wait(queue, predicate):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        snapshot = queue.snapshot()
        if predicate(snapshot): return snapshot
        time.sleep(.01)
    raise AssertionError(queue.snapshot())


def test_paired_mixed_product_batch_recovers_same_generation_and_exports_mapping(tmp_path, monkeypatch):
    import core
    monkeypatch.setattr(core, 'download_image', lambda url: (image('red'), '.png'))
    cloud = Cloud()
    app = create_app(lambda: cloud, tmp_path / 'private', token='test-secret', oss_factory=FakePublisher)
    extension = 'a' * 32
    headers = {'X-Tool-Token': 'test-secret', 'X-Extension-Id': extension,
               'Origin': f'chrome-extension://{extension}'}
    entries = [
        {'platform': 'pdd', 'product_id': '001', 'title': '玻璃杯', 'kind': 'main',
         'sku': '', 'order': 1, 'url': 'https://img.pddpic.com/a.png?signature=keep'},
        {'platform': 'taobao', 'product_id': '002', 'title': '玻璃杯', 'kind': 'detail',
         'sku': '', 'order': 2, 'url': 'https://img.alicdn.com/b.png'},
        {'platform': '1688', 'product_id': '003', 'title': '玻璃杯', 'kind': 'sku',
         'sku': '透明/大号', 'order': 1, 'url': 'https://img.pddpic.com/a.png?signature=keep'},
    ]
    queue = app.extensions['queue']
    try:
        with app.test_client() as client:
            assert client.post('/api/bridge/pair', headers=headers, json={'extension_id': extension}).status_code == 200
            response = client.post('/api/bridge/jobs', headers=headers, json={
                'source_task_id': 'mixed-products', 'output_dir': str(tmp_path / '结果'), 'entries': entries})
            assert response.status_code == 200, response.json
            job_id = response.json['id']
            paused = wait(queue, lambda s: s['status'] == 'paused')
            assert paused['source_task_id'] == 'mixed-products' and cloud.submissions == 1
            cloud.verified = True
            assert client.post('/api/bridge/action', headers=headers, json={
                'job_id': job_id, 'source_task_id': 'mixed-products', 'action': 'continue'}).status_code == 200
            complete = wait(queue, lambda s: s['status'] == 'completed')
            assert cloud.submissions == 1  # Both URL and byte dedup reuse this result.
            assert complete['counts'] == {'total': 3, 'unique': 1, 'downloaded': 1, 'converted': 1, 'failed': 0, 'uploaded': 1, 'upload_failed': 0}
            result = client.get('/api/bridge/manifest?job_id=' + job_id, headers=headers)
            assert result.status_code == 410
            rows = json.loads(Path(complete['mapping_path']).read_text(encoding='utf-8'))['rows']
            assert [(row['platform'], row['product_id']) for row in rows] == [('pdd', '001'), ('taobao', '002'), ('1688', '003')]
            assert [row['kind'] for row in rows] == ['main', 'detail', 'sku']
            assert rows[2]['sku'] == '透明/大号' and rows[2]['sku_index'] == 0
            assert rows[0]['url'] == 'https://img.pddpic.com/a.png?signature=keep'
            assert all(Path(row['output_path']).is_file() for row in rows)
            assert all(row['published_url'].startswith('https://collector-test.oss-cn-hangzhou.aliyuncs.com/converted-images/') for row in rows)
            assert len({row['published_url'] for row in rows}) == 1
            assert client.get(f'/api/bridge/images/{job_id}/0/result', headers=headers).status_code == 200
            assert client.post('/api/reset', headers={'X-Tool-Token': 'test-secret'}, json={}).status_code == 200
            assert client.get('/api/bridge/state?job_id=' + job_id, headers=headers).status_code == 409
            assert all(Path(row['output_path']).is_file() for row in rows)
            assert Path(complete['mapping_path']).is_file()
            assert not list(Path(complete['run_dir']).rglob('*.xlsx'))
    finally:
        app.extensions['queue'].close(clear_state=True)
