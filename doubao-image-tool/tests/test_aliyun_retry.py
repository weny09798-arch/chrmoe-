import copy
import threading
import pytest
from app import create_app
from core import QueueService
from test_aliyun import Translator, entries, image, never_browser, wait

@pytest.fixture
def completed_queue(tmp_path, monkeypatch):
    import core
    monkeypatch.setattr(core, 'download_image', lambda url: (image(), '.png'))
    monkeypatch.setattr(core, 'download_aliyun_result', lambda url: (image(color='blue'), '.png'))
    translator = Translator()
    queue = QueueService(never_browser, tmp_path / 'state', aliyun_factory=lambda: translator)
    try:
        queue.start_urls(entries(), tmp_path / 'out', 'convert', 'source', provider='aliyun', paid_confirmed=True)
        wait(queue, lambda state: state['status'] == 'completed')
        yield queue, translator
    finally:
        queue.close()

@pytest.mark.parametrize('paid_confirmed', [False, True])
def test_completed_original_retry_rejects_without_discarding_paid_result(completed_queue, paid_confirmed):
    queue, translator = completed_queue
    with queue.cv:
        before = copy.deepcopy(queue.job)
    with pytest.raises(ValueError):
        queue.action('retry', 0, paid_confirmed=paid_confirmed)
    with queue.cv:
        assert queue.job == before
    assert queue.snapshot()['paid_calls'] == 1
    assert translator.calls == 1

@pytest.mark.parametrize('alias_phase', ['done', 'aliyun-failed'])
def test_alias_retry_recopies_completed_owner_without_paid_submission(completed_queue, alias_phase):
    from pathlib import Path
    queue, translator = completed_queue
    with queue.cv:
        owner = copy.deepcopy(queue.job['items'][0])
        alias = queue.job['items'][1]
        assert alias['alias_of'] == 0
        target = Path(alias['refs'][0]['output_path'])
        target.unlink()
        alias.update(phase=alias_phase, status='failed' if alias_phase == 'aliyun-failed' else 'completed')
    queue.action('retry', 1)
    state = wait(queue, lambda state: state['status'] == 'completed')
    recovered = Path(state['items'][1]['refs'][0]['output_path'])
    assert recovered.is_file()
    assert recovered.read_bytes() == Path(owner['result']['output_path']).read_bytes()
    assert state['items'][1]['status'] == 'completed'
    assert state['paid_calls'] == 1
    assert translator.calls == 1
    with queue.cv:
        assert queue.job['items'][0] == owner

@pytest.mark.parametrize('owner_phase', ['submitting', 'uncertain', 'aliyun-failed', 'done'])
def test_alias_retry_checks_owner_before_enabling_paid_submission(completed_queue, owner_phase):
    queue, translator = completed_queue
    with queue.cv:
        queue.job['status'] = 'paused'
        owner = queue.job['items'][0]
        owner.update(phase=owner_phase, status='failed' if owner_phase == 'aliyun-failed' else 'needs-review')
        queue.job['items'][1].update(phase='alias', status='paused')
        before = copy.deepcopy(queue.job)
    with pytest.raises(ValueError):
        queue.action('retry', 1)
    with queue.cv:
        assert queue.job == before
    assert translator.calls == 1

@pytest.mark.parametrize('phase', ['saving', 'aliyun-downloading'])
def test_saved_paid_response_needs_review_retry_recovers_without_resubmission(completed_queue, monkeypatch, phase):
    import core
    queue, translator = completed_queue
    with queue.cv:
        queue.job['status'] = 'paused'
        item = queue.job['items'][0]
        cloud_result = copy.deepcopy(item['aliyun_result'])
        revision = item.get('revision', 0)
        item.update(status='needs-review', phase=phase, result=None)
        if phase == 'aliyun-downloading':
            item.pop('cached_path', None)
    if phase == 'saving':
        def unexpected_download(url):
            raise AssertionError('Cached result must be saved without downloading')
        monkeypatch.setattr(core, 'download_aliyun_result', unexpected_download)
    queue.action('retry', 0)
    state = wait(queue, lambda state: state['status'] == 'completed')
    assert state['items'][0]['result']['output_path']
    assert state['paid_calls'] == 1
    assert state['estimated_cost_upper'] == 0.18
    assert translator.calls == 1
    with queue.cv:
        assert queue.job['items'][0]['aliyun_result'] == cloud_result
        assert queue.job['items'][0].get('revision', 0) == revision

@pytest.mark.parametrize('endpoint', ['/api/action', '/api/bridge/action'])
def test_stale_http_retry_of_completed_original_returns_400(tmp_path, monkeypatch, endpoint):
    import core
    entered = threading.Event()
    release = threading.Event()
    def download_result(url):
        entered.set()
        assert release.wait(5)
        return image(color='blue'), '.png'
    monkeypatch.setattr(core, 'download_image', lambda url: (image(), '.png'))
    monkeypatch.setattr(core, 'download_aliyun_result', download_result)
    translator = Translator()
    app = create_app(never_browser, tmp_path / 'private', token='token', aliyun_factory=lambda: translator)
    queue = app.extensions['queue']
    try:
        with app.test_client() as client:
            headers = {'X-Tool-Token': 'token'}
            if endpoint == '/api/bridge/action':
                extension = 'a' * 32
                headers.update({'X-Extension-Id': extension, 'Origin': f'chrome-extension://{extension}'})
                response = client.post('/api/bridge/pair', headers=headers, json={'extension_id': extension})
                assert response.status_code == 200
            queue.start_urls(entries(('main',)), tmp_path / 'out', 'convert', 'source', provider='aliyun', paid_confirmed=True)
            assert entered.wait(5)
            queue.action('stop')
            stale = queue.snapshot()
            assert stale['items'][0]['phase'] == 'aliyun-downloading'
            release.set()
            queue.action('continue')
            wait(queue, lambda state: state['status'] == 'completed')
            with queue.cv:
                before = copy.deepcopy(queue.job)
            response = client.post(endpoint, headers=headers, json={'action': 'retry', 'index': stale['items'][0]['index'], 'job_id': stale['id'], 'source_task_id': stale['source_task_id']})
            assert response.status_code == 400
            with queue.cv:
                assert queue.job == before
            assert queue.snapshot()['paid_calls'] == 1
            assert translator.calls == 1
    finally:
        release.set()
        queue.close()

def test_completed_original_only_confirmed_redo_enables_another_paid_request(completed_queue):
    queue, translator = completed_queue
    with pytest.raises(ValueError):
        queue.action('redo', 0)
    assert translator.calls == 1
    queue.action('redo', 0, paid_confirmed=True)
    state = wait(queue, lambda state: state['status'] == 'completed')
    assert state['paid_calls'] == 2
    assert state['estimated_cost_upper'] == 0.24
    assert translator.calls == 2
