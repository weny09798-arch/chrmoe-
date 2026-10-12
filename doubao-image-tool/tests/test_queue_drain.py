"""Drain barriers use deterministic provider events; no real browser or paid call."""
import copy
import json
import threading
import time
from pathlib import Path
import pytest
import core
from core import QueueService
from test_core import Cloud, wait, png
from test_image_batch import entry
from test_oss_queue import Publisher
from test_aliyun import image, Translator, never_browser
from aliyun_translation import AliyunError


def collector_queue(tmp_path, monkeypatch, cloud=None, publisher=None):
    monkeypatch.setattr(core, 'download_image', lambda url: (image(color='red' if '/a.' in url else 'blue'), '.png'))
    cloud = cloud or Cloud()
    publisher = publisher or Publisher()
    queue = QueueService(lambda: cloud, tmp_path / 'state', oss_factory=lambda: publisher)
    queue.start_urls([entry(), entry('https://img.pddpic.com/b.png')], None, 'p', 'source', cloud_only=True)
    return queue, cloud


def test_drain_finishes_submitted_result_and_published_aliases_without_next_send(tmp_path, monkeypatch):
    queue, cloud = collector_queue(tmp_path, monkeypatch)
    try:
        wait(queue, lambda s: s['items'][0]['phase'] == 'pending')
        with queue.cv:
            alias = copy.deepcopy(queue.job['items'][1]); alias.update(index=2, alias_of=0, phase='alias')
            queue.job['items'].append(alias)
        queue.begin_drain()
        assert not queue.drain_complete()
        cloud.result = png()
        state = wait(queue, lambda s: queue.drain_complete())
        assert state['items'][0]['result']['public_url']
        assert state['items'][2]['refs'][0]['published_url'] == state['items'][0]['result']['public_url']
        assert state['items'][1]['phase'] == 'downloading' and len(cloud.sends) == 1
        assert state['status'] == 'paused'
        queue.action('continue')
        wait(queue, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 2
    finally: queue.close()


@pytest.mark.parametrize('barrier', ['original-download', 'browser-open', 'send-gate'])
def test_drain_blocks_selected_preparation_and_final_send_gate(tmp_path, monkeypatch, barrier):
    entered, release = threading.Event(), threading.Event()
    class Preparing(Cloud):
        def open(self):
            super().open()
            if barrier == 'browser-open': entered.set(); assert release.wait(3)
        def submit(self, path, prompt, send_gate):
            if barrier == 'send-gate': entered.set(); assert release.wait(3)
            super().submit(path, prompt, send_gate)
    cloud = Preparing()
    if barrier == 'original-download':
        def download(url): entered.set(); assert release.wait(3); return png(), '.png'
        monkeypatch.setattr(core, 'download_image', download)
        queue = QueueService(lambda: cloud, tmp_path/'state', oss_factory=Publisher)
        queue.start_urls([entry()], None, 'p', 'source', cloud_only=True)
    else: queue, cloud = collector_queue(tmp_path, monkeypatch, cloud)
    try:
        assert entered.wait(2); queue.begin_drain(); assert not queue.drain_complete()
        release.set(); wait(queue, lambda s: queue.drain_complete())
        assert cloud.sends == []
        assert queue.snapshot()['items'][0]['phase'] in {'downloading', 'ready'}
    finally: release.set(); queue.close()


def test_drain_blocks_aliyun_final_commit_after_configuration(tmp_path):
    entered, release = threading.Event(), threading.Event(); translator = Translator(); calls = 0
    def factory():
        nonlocal calls
        calls += 1
        if calls > 1: entered.set(); assert release.wait(3)
        return translator
    queue = QueueService(never_browser, tmp_path/'state', aliyun_factory=factory)
    try:
        queue.start([('a.png', image())], tmp_path/'out', 'p', provider='aliyun', paid_confirmed=True)
        assert entered.wait(2); queue.begin_drain(); release.set()
        wait(queue, lambda s: queue.drain_complete())
        assert translator.calls == 0 and queue.snapshot()['paid_calls'] == 0
    finally: release.set(); queue.close()


@pytest.mark.parametrize('timeout', [False, True])
def test_aliyun_committed_result_drains_or_preserves_uncertain_without_retry(tmp_path, monkeypatch, timeout):
    entered, release = threading.Event(), threading.Event()
    class Slow(Translator):
        def translate(self, path):
            self.calls += 1; entered.set(); assert release.wait(3)
            if timeout: raise AliyunError('uncertain')
            return {'request_id': 'r', 'final_image_url': 'https://public.example/result.png'}
    translator = Slow()
    monkeypatch.setattr(core, 'download_aliyun_result', lambda url: (image(), '.png'))
    queue = QueueService(never_browser, tmp_path/'state', aliyun_factory=lambda: translator)
    try:
        queue.start([('a.png', image()), ('b.png', image(color='blue'))], tmp_path/'out', 'p', provider='aliyun', paid_confirmed=True)
        assert entered.wait(2); queue.begin_drain(); release.set()
        state = wait(queue, lambda s: queue.drain_complete())
        assert translator.calls == 1 and state['paid_calls'] == 1
        assert state['items'][0]['phase'] == ('uncertain' if timeout else 'done')
        if timeout:
            queue.action('continue'); time.sleep(.03); assert translator.calls == 1
        else: assert Path(state['items'][0]['result']['output_path']).is_file()
    finally: release.set(); queue.close()


def test_drain_finishes_cached_save_then_upload(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event(); save = core.save_cached_result
    def slow_save(*args): entered.set(); assert release.wait(3); return save(*args)
    monkeypatch.setattr(core, 'save_cached_result', slow_save)
    cloud = Cloud(); cloud.result = png()
    queue, cloud = collector_queue(tmp_path, monkeypatch, cloud)
    try:
        assert entered.wait(2); queue.begin_drain(); release.set()
        state = wait(queue, lambda s: queue.drain_complete())
        assert state['items'][0]['result']['public_url'] and len(cloud.sends) == 1
    finally: release.set(); queue.close()


def test_failed_reset_wait_preserves_live_queue_and_upload_can_finish(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    class Slow(Publisher):
        def publish(self, path): entered.set(); assert release.wait(3); return super().publish(path)
    cloud = Cloud(); cloud.result = png()
    queue, cloud = collector_queue(tmp_path, monkeypatch, cloud, Slow())
    try:
        assert entered.wait(2)
        queue.close_timeout = .02
        with pytest.raises(RuntimeError): queue.close(clear_state=True)
        assert not queue.closed and queue.worker.is_alive()
        assert (queue.state_dir/'job.json').is_file()
        release.set()
        wait(queue, lambda s: bool(s['items'][0]['refs'][0].get('published_url')))
        assert len(cloud.sends) == 1
        queue.close_timeout = 2
        queue.close(clear_state=True)
        assert not list(queue.state_dir.iterdir())
    finally: release.set(); queue.close_timeout = 2; queue.close()


def test_reset_wait_bound_exceeds_oss_helper_and_joins_before_clear(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    class Slow(Publisher):
        def publish(self, path): entered.set(); assert release.wait(3); return super().publish(path)
    cloud = Cloud(); cloud.result = png()
    queue, cloud = collector_queue(tmp_path, monkeypatch, cloud, Slow())
    closer = None
    try:
        assert entered.wait(2)
        assert queue.close_timeout > 65
        closer = threading.Thread(target=lambda: queue.close(clear_state=True)); closer.start()
        time.sleep(.03); assert closer.is_alive() and (queue.state_dir/'job.json').exists()
        release.set(); closer.join(2)
        assert not closer.is_alive() and not queue.worker.is_alive()
        assert queue.snapshot()['id'] is None and not list(queue.state_dir.iterdir())
    finally:
        release.set()
        if closer: closer.join(3)
        queue.close()


def test_drain_during_selected_publisher_check_does_not_prepare_browser(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event(); checks = 0
    cloud = Cloud(); publisher = Publisher()
    def factory():
        nonlocal checks
        checks += 1
        if checks == 2: entered.set(); assert release.wait(3)
        return publisher
    monkeypatch.setattr(core, 'download_image', lambda url: (png(), '.png'))
    queue = QueueService(lambda: cloud, tmp_path/'state', oss_factory=factory)
    try:
        queue.start_urls([entry()], None, 'p', 'source', cloud_only=True)
        assert entered.wait(2); queue.begin_drain(); release.set()
        wait(queue, lambda s: queue.drain_complete())
        assert cloud.owner is None and cloud.sends == []
    finally: release.set(); queue.close()


def test_clear_cancels_queued_browser_open_without_waiting_for_it(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event(); run = QueueService._run
    def delayed_run(self): entered.set(); assert release.wait(3); run(self)
    monkeypatch.setattr(QueueService, '_run', delayed_run)
    cloud = Cloud(); queue = QueueService(lambda: cloud, tmp_path/'state')
    closer = None
    try:
        assert entered.wait(2)
        queue.open_browser()
        closer = threading.Thread(target=lambda: queue.close(clear_state=True)); closer.start()
        wait(queue, lambda s: queue.closed)
        release.set(); closer.join(2)
        assert not closer.is_alive()
        assert not queue.worker.is_alive() and cloud.owner is None
    finally:
        release.set()
        if closer: closer.join(3)
        queue.close()


def test_close_wakes_when_manual_browser_open_finishes(tmp_path):
    entered, release = threading.Event(), threading.Event()
    class Opening(Cloud):
        def open(self): super().open(); entered.set(); assert release.wait(3)
    cloud = Opening(); queue = QueueService(lambda: cloud, tmp_path/'state'); closer = None
    try:
        queue.open_browser(); assert entered.wait(2)
        closer = threading.Thread(target=lambda: queue.close(clear_state=True)); closer.start()
        wait(queue, lambda s: queue.closing)
        release.set(); closer.join(.5)
        assert not closer.is_alive() and not queue.worker.is_alive()
    finally:
        release.set()
        with queue.cv: queue.cv.notify_all()
        if closer: closer.join(3)
        queue.close()


@pytest.mark.parametrize('status,phase', [('stopped', 'ready'), ('paused', 'uncertain'), ('completed', 'done'), ('paused', 'saving')])
def test_drain_keeps_user_pauses_failures_and_restart_never_submits(tmp_path, status, phase):
    root = tmp_path/'state'; root.mkdir(); source = root/'input.png'; source.write_bytes(png())
    (root/'job.json').write_text(json.dumps({'id': 'legacy', 'status': status, 'prompt': 'p',
        'output_dir': str(tmp_path/'out'), 'message': '', 'items': [
            {'index': 0, 'name': 'a.png', 'input_path': str(source), 'phase': phase,
             'status': 'completed' if status == 'completed' else 'paused', 'result': None, 'message': ''},
            {'index': 1, 'name': 'bad.png', 'phase': 'download-failed', 'status': 'failed', 'message': 'keep', 'result': None}]}), encoding='utf-8')
    cloud = Cloud(); queue = QueueService(lambda: cloud, root)
    try:
        before = queue.snapshot()
        queue.begin_drain(); assert queue.drain_complete()
        time.sleep(.02)
        assert queue.snapshot() == before and cloud.sends == [] and cloud.owner is None
        assert queue.snapshot()['items'][1]['status'] == 'failed'
    finally: queue.close()


@pytest.mark.parametrize('command', ['retry', 'redo', 'retry-upload'])
def test_explicit_retry_actions_release_drain(tmp_path, monkeypatch, command):
    from oss_storage import OSSError
    publisher = Publisher(); publisher.error = OSSError()
    cloud = Cloud(); cloud.result = png()
    queue, cloud = collector_queue(tmp_path, monkeypatch, cloud, publisher)
    try:
        wait(queue, lambda s: s['status'] == 'completed')
        queue.begin_drain(); assert queue.drain_complete()
        publisher.error = None
        queue.action(command, 0)
        assert not queue.draining
        state = wait(queue, lambda s: s['status'] == 'completed')
        assert state['items'][0]['refs'][0]['published_url']
        assert len(cloud.sends) == (2 if command == 'retry-upload' else 3)
    finally: queue.close()
