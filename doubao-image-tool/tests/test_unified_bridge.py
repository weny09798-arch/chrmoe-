"""Paired settings and recovery use temporary DPAPI stores and no network."""
import pytest
from test_bridge import client, pair, collector, HEADERS, OTHER


@pytest.mark.parametrize('resource', ['aliyun', 'oss'])
@pytest.mark.parametrize('method', ['post', 'delete'])
def test_unpaired_settings_cannot_mutate(client, resource, method):
    response = getattr(client, method)('/api/bridge/settings/' + resource, headers=HEADERS, json={})
    assert response.status_code == 403
    pair(client)
    foreign = {**HEADERS, 'X-Extension-Id': OTHER, 'Origin': 'chrome-extension://' + OTHER}
    assert getattr(client, method)('/api/bridge/settings/' + resource, headers=foreign, json={}).status_code == 403
    assert not client.application.extensions['aliyun_credentials'].configured()
    assert not client.application.extensions['oss_config'].status()['oss_configured']


def test_settings_redacted_reused_credentials_and_delete(client):
    pair(client)
    keys = {'access_key_id': 'fixture-key', 'access_key_secret': 'fixture-secret'}
    response = client.post('/api/bridge/settings/aliyun', headers=HEADERS, json=keys)
    assert response.status_code == 200 and response.json['aliyun_configured']
    config = {'bucket': 'fixture-bucket', 'region': 'cn-hangzhou', 'credential_mode': 'translation'}
    response = client.post('/api/bridge/settings/oss', headers=HEADERS, json=config)
    assert response.status_code == 200 and response.json['oss_configured']
    for resource in ('aliyun', 'oss'):
        text = client.get('/api/bridge/settings/' + resource, headers=HEADERS).get_data(as_text=True)
        assert 'fixture-secret' not in text and 'fixture-key' not in text and 'access_key_secret' not in text
    assert client.application.extensions['oss_config'].load()['access_key_secret'] == 'fixture-secret'
    assert not client.delete('/api/bridge/settings/oss', headers=HEADERS).json['oss_configured']
    assert not client.delete('/api/bridge/settings/aliyun', headers=HEADERS).json['aliyun_configured']


@pytest.mark.parametrize('path,methods', [
    ('settings/aliyun', ('GET', 'POST', 'DELETE')),
    ('settings/oss', ('GET', 'POST', 'DELETE')),
    ('settings/oss/check', ('POST',)), ('current', ('GET',)), ('reset', ('POST',)),
])
def test_preflight_matches_endpoint_methods(client, path, methods):
    pair(client)
    for method in ('GET', 'POST', 'DELETE', 'PUT'):
        response = client.options('/api/bridge/' + path, headers={
            'Origin': HEADERS['Origin'], 'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': 'content-type,x-tool-token,x-extension-id'})
        assert response.status_code == (204 if method in methods else 403)
        if method in methods:
            assert method in response.headers['Access-Control-Allow-Methods']


def test_oss_check_uses_existing_publisher(client, monkeypatch):
    from oss_fakes import FakePublisher
    monkeypatch.setattr(FakePublisher, 'check', lambda self: {'ok': True}, raising=False)
    assert client.post('/api/bridge/settings/oss/check', headers=HEADERS, json={}).status_code == 403
    pair(client)
    assert client.post('/api/bridge/settings/oss/check', headers=HEADERS, json={}).json == {'ok': True}


def test_current_is_read_only_and_reset_requires_exact_snapshot_ids(client, tmp_path):
    pair(client)
    queue = collector(client, tmp_path)
    response = client.get('/api/bridge/current', headers=HEADERS)
    assert response.status_code == 200 and response.json['source_task_id'] == 'source'
    assert queue.snapshot()['status'] == 'stopped'
    for body in ({}, {'job_id': 'old', 'source_task_id': 'source'}, {'job_id': 'job', 'source_task_id': 'other'}):
        assert client.post('/api/bridge/reset', headers=HEADERS, json=body).status_code == 409
        assert client.application.extensions['queue'] is queue and not queue.closed
    response = client.post('/api/bridge/reset', headers=HEADERS, json={'job_id': 'job', 'source_task_id': 'source'})
    assert response.status_code == 200 and response.json['status'] == 'idle'
    assert client.application.extensions['queue'] is not queue
    assert client.post('/api/bridge/reset', headers=HEADERS, json={'job_id': 'job', 'source_task_id': 'source'}).status_code == 409
    assert client.post('/api/bridge/reset', headers=HEADERS, json={}).status_code == 200


def test_current_foreign_source_can_be_detected_without_resuming(client, tmp_path):
    pair(client); queue = collector(client, tmp_path)
    response = client.get('/api/bridge/current?source_task_id=other', headers=HEADERS)
    assert response.status_code == 409
    assert queue.snapshot()['status'] == 'stopped'
    caps = client.get('/api/bridge/capabilities', headers=HEADERS).json
    assert caps['version'] == '1.6.6'
    assert all(caps[name] for name in ('unified_plugin', 'automatic_backend', 'settings_in_plugin'))


@pytest.mark.parametrize('resource', ['aliyun', 'oss'])
def test_paired_settings_still_validate_body_and_token(client, resource):
    pair(client)
    path = '/api/bridge/settings/' + resource
    for body in (None, [], {}, {'access_key_id': 'id', 'access_key_secret': 'bad secret'}):
        assert client.post(path, headers=HEADERS, json=body).status_code == 400
    for method in ('get', 'post', 'delete'):
        assert getattr(client, method)(path, headers={**HEADERS, 'X-Tool-Token': 'invalid'}, json={}).status_code == 403


def test_reset_timeout_keeps_same_queue_for_later_safe_reset(client, tmp_path, monkeypatch):
    import threading
    from test_core import Cloud, wait, png
    import core
    from test_image_batch import entry
    from oss_fakes import FakePublisher
    entered, release = threading.Event(), threading.Event()
    original_publish = FakePublisher.publish
    def publish(self, path): entered.set(); assert release.wait(3); return original_publish(self, path)
    monkeypatch.setattr(FakePublisher, 'publish', publish)
    monkeypatch.setattr(core, 'download_image', lambda url: (png(), '.png'))
    pair(client); queue = client.application.extensions['queue']; cloud = Cloud(); cloud.result = png()
    queue.factory = lambda: cloud
    queue.start_urls([entry()], None, 'p', 'source', cloud_only=True)
    body = {'job_id': queue.snapshot()['id'], 'source_task_id': 'source'}
    try:
        assert entered.wait(2); queue.close_timeout = .02
        assert client.post('/api/bridge/reset', headers=HEADERS, json=body).status_code == 409
        assert client.application.extensions['queue'] is queue and not queue.closed
        release.set(); wait(queue, lambda s: bool(s['items'][0]['refs'][0].get('published_url')))
        queue.close_timeout = 2
        assert client.post('/api/bridge/reset', headers=HEADERS, json=body).status_code == 200
        fresh = client.application.extensions['queue']
        assert fresh is not queue and not queue.worker.is_alive() and fresh.snapshot()['id'] is None
        assert client.get('/api/bridge/current', headers=HEADERS).json['id'] is None
    finally: release.set(); queue.close_timeout = 2
