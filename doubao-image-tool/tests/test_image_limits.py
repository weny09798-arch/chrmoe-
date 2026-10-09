from license_fakes import PermittingAuthority
import itertools
import json

import pytest

from core import QueueService
from test_core import Cloud, wait
from test_image_batch import entry
from test_oss_queue import Publisher, setup
from oss_storage import OSSError


KINDS = ('main', 'detail', 'sku')
UNLIMITED = dict.fromkeys(KINDS)


def stopped_queue(tmp_path, monkeypatch):
    monkeypatch.setattr(QueueService, '_run', lambda self: None)
    return QueueService(Cloud, tmp_path / 'state', license_authority=PermittingAuthority())


@pytest.mark.parametrize('kinds', [list(c) for n in (1, 2, 3) for c in itertools.combinations(KINDS, n)])
def test_limits_all_type_combinations_before_url_dedup(tmp_path, monkeypatch, kinds):
    q = stopped_queue(tmp_path, monkeypatch)
    entries = [{**entry(), 'kind': kind, 'order': order, 'sku_index': order + 10}
               for order in (7, 3, 9) for kind in KINDS]
    limits = {'main': 2, 'detail': 1, 'sku': 2}
    try:
        q.start_urls(entries, tmp_path / 'out', 'p', 'task', image_kinds=kinds, image_limits=limits)
        state = q.snapshot()
        refs = state['items'][0]['refs']
        expected = [e for e in entries if e['kind'] in kinds and e['order'] in ((7, 3) if limits[e['kind']] == 2 else (7,))]
        assert [(r['kind'], r['order'], r['sku_index']) for r in refs] == [(e['kind'], e['order'], e['sku_index']) for e in expected]
        assert state['image_limits'] == {k: limits[k] if k in kinds else None for k in KINDS}
        assert len(state['items']) == 1
    finally:
        q.close()


@pytest.mark.parametrize('value', [0, -1, 1.0, True, False, '2', 9007199254740992, [], {}])
def test_selected_limit_rejects_invalid_values(tmp_path, monkeypatch, value):
    q = stopped_queue(tmp_path, monkeypatch)
    try:
        with pytest.raises(ValueError, match='数量'):
            q.start_urls([entry()], tmp_path / 'out', 'p', 'task', image_limits={'main': value})
        assert q.snapshot()['status'] == 'idle'
    finally:
        q.close()


@pytest.mark.parametrize('limits', [None, {}, UNLIMITED, {'main': 9007199254740991}])
def test_unlimited_compatibility_and_safe_max(tmp_path, monkeypatch, limits):
    q = stopped_queue(tmp_path, monkeypatch)
    try:
        q.start_urls([entry(), {**entry(), 'order': 2}], tmp_path / 'out', 'p', 'task', image_limits=limits)
        assert len(q.snapshot()['items'][0]['refs']) == 2
    finally:
        q.close()


def test_unselected_limits_ignored_and_configuration_frozen_on_restart(tmp_path, monkeypatch):
    q = stopped_queue(tmp_path, monkeypatch)
    limits = {'main': 1, 'sku': 'invalid', 'detail': -4}
    try:
        q.start_urls([entry(), {**entry(), 'order': 2}], tmp_path / 'out', 'p', 'task', image_kinds=['main'], image_limits=limits)
        limits['main'] = 20
        snapshot = q.snapshot()
        snapshot['image_limits']['main'] = 30
        assert q.snapshot()['image_limits'] == {**UNLIMITED, 'main': 1}
    finally:
        q.close()
    restored = stopped_queue(tmp_path, monkeypatch)
    try:
        assert restored.snapshot()['image_limits'] == {**UNLIMITED, 'main': 1}
        assert len(restored.snapshot()['items'][0]['refs']) == 1
    finally:
        restored.close()
    path = tmp_path / 'state' / 'job.json'
    legacy = json.loads(path.read_text(encoding='utf-8'))
    legacy.pop('image_limits')
    path.write_text(json.dumps(legacy), encoding='utf-8')
    old = stopped_queue(tmp_path, monkeypatch)
    try:
        assert old.snapshot()['image_limits'] == UNLIMITED
    finally:
        old.close()


def test_limited_doubao_oss_retry_never_generates_or_backfills_excluded_slots(tmp_path, monkeypatch):
    publisher = Publisher()
    publisher.error = OSSError()
    q, cloud = setup(tmp_path, monkeypatch, publisher)
    try:
        q.start_urls([entry(), entry('https://img.pddpic.com/excluded.png')], None, 'p', 'task',
                     cloud_only=True, image_limits={'main': 1})
        failed = wait(q, lambda s: s['status'] == 'completed')
        assert len(failed['items']) == 1
        assert failed['items'][0]['phase'] == 'upload-failed'
        publisher.error = None
        q.action('retry-upload', 0)
        done = wait(q, lambda s: s['items'][0]['phase'] == 'done')
        assert len(cloud.sends) == 1 and len(publisher.paths) == 2
        assert done['image_limits'] == {**UNLIMITED, 'main': 1}
        assert len(done['items'][0]['refs']) == 1
    finally:
        q.close()


@pytest.mark.parametrize('fail_download', [False, True])
def test_content_dedup_and_download_failure_never_backfill(tmp_path, monkeypatch, fail_download):
    import core
    from test_core import png
    downloads = []
    publisher = Publisher()
    q, cloud = setup(tmp_path, monkeypatch, publisher)
    def download(url):
        downloads.append(url)
        if fail_download:
            raise ValueError('offline failure')
        return png(), '.png'
    monkeypatch.setattr(core, 'download_image', download)
    entries = [entry(f'https://img.pddpic.com/{i}.png') for i in range(4)]
    try:
        q.start_urls(entries, tmp_path / 'out', 'p', 'task', image_limits={'main': 2})
        state = wait(q, lambda s: s['status'] == 'completed')
        assert downloads == [e['url'] for e in entries[:2]]
        assert sum(len(i['refs']) for i in state['items']) == 2
        assert len(cloud.sends) == (0 if fail_download else 1)
        assert len(publisher.paths) == (0 if fail_download else 1)
    finally:
        q.close()


@pytest.mark.parametrize('limits', [[], 1, '1', True])
def test_malformed_limit_container(tmp_path, monkeypatch, limits):
    q = stopped_queue(tmp_path, monkeypatch)
    try:
        with pytest.raises(ValueError, match='数量'):
            q.start_urls([entry()], tmp_path / 'out', 'p', 'task', image_limits=limits)
    finally:
        q.close()


def test_bridge_passes_limits_and_rejects_invalid_before_start(tmp_path, monkeypatch):
    from app import create_app
    from oss_fakes import FakePublisher
    from test_bridge import HEADERS, pair
    monkeypatch.setattr(QueueService, '_run', lambda self: None)
    app = create_app(Cloud, tmp_path / 'private', token='secret', oss_factory=FakePublisher, license_authority=PermittingAuthority())
    try:
        with app.test_client() as client:
            pair(client)
            capabilities = client.get('/api/bridge/capabilities', headers=HEADERS).json
            assert capabilities['version'] == '1.7.0' and capabilities['image_type_limits'] is True
            payload = {'source_task_id': 'task', 'entries': [entry(), {**entry(), 'order': 2}], 'image_limits': {'main': 0}}
            assert client.post('/api/bridge/jobs', headers=HEADERS, json=payload).status_code == 400
            assert app.extensions['queue'].snapshot()['status'] == 'idle'
            payload['image_limits']['main'] = 1
            response = client.post('/api/bridge/jobs', headers=HEADERS, json=payload)
            assert response.status_code == 200
            assert response.json['image_limits'] == {**UNLIMITED, 'main': 1}
            assert len(response.json['items'][0]['refs']) == 1
    finally:
        app.extensions['queue'].close()
