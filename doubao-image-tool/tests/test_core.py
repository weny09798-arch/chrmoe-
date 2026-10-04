import io
import threading
import time
from pathlib import Path
import pytest
from PIL import Image
from core import QueueService, NeedsUser, SubmissionUncertain

def png():
    out = io.BytesIO(); Image.new('RGB', (2, 2), 'red').save(out, 'PNG'); return out.getvalue()

def wait(service, predicate):
    end = time.monotonic() + 3
    while time.monotonic() < end:
        state = service.snapshot()
        if predicate(state): return state
        time.sleep(.01)
    raise AssertionError(service.snapshot())

class Cloud:
    def __init__(self): self.sends = []; self.result = None; self.owner = None; self.closed = False
    def open(self): self.owner = threading.get_ident()
    def submit(self, path, prompt):
        assert threading.get_ident() == self.owner
        self.sends.append((Path(path).read_bytes(), prompt))
    def poll(self): return self.result
    def close(self):
        assert threading.get_ident() == self.owner
        self.closed = True

def test_stop_continue_keeps_pending_request(tmp_path):
    cloud = Cloud(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png()), ('b.png', png())], tmp_path/'out', 'convert')
        wait(service, lambda s: s['items'][0]['phase'] == 'pending')
        service.action('stop'); cloud.result = png(); time.sleep(.05)
        assert len(cloud.sends) == 1
        service.action('continue')
        wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 2
    finally: service.close()
    assert cloud.closed

def test_save_retry_reuses_generated_bytes(tmp_path):
    cloud = Cloud(); cloud.result = png(); blocker = tmp_path/'out'; blocker.write_text('block')
    service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], blocker, 'convert')
        wait(service, lambda s: s['status'] == 'paused')
        assert service.snapshot()['items'][0]['phase'] == 'saving'
        blocker.unlink(); service.action('retry', 0)
        wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 1
    finally: service.close()

def test_timeout_continue_does_not_resubmit(tmp_path):
    cloud = Cloud(); service = QueueService(lambda: cloud, tmp_path/'state'); service.generation_timeout = .02
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert')
        wait(service, lambda s: s['status'] == 'paused')
        cloud.result = png(); service.action('continue')
        wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 1
    finally: service.close()

def test_restart_requires_review_before_any_send(tmp_path):
    cloud = Cloud(); service = QueueService(lambda: cloud, tmp_path/'state')
    service.start([('a.png', png())], tmp_path/'out', 'convert')
    wait(service, lambda s: s['items'][0]['phase'] == 'pending'); service.close()
    other = Cloud(); restored = QueueService(lambda: other, tmp_path/'state')
    try:
        assert restored.snapshot()['items'][0]['status'] == 'needs-review'
        restored.action('continue'); time.sleep(.05)
        assert other.sends == []
        other.result = png(); restored.action('retry', 0)
        wait(restored, lambda s: s['status'] == 'completed')
        assert len(other.sends) == 1
    finally: restored.close()

def test_uncertain_submit_continue_does_not_resend(tmp_path):
    class Uncertain(Cloud):
        def submit(self, path, prompt):
            super().submit(path, prompt); raise SubmissionUncertain('inspect Chrome')
    cloud = Uncertain(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert')
        wait(service, lambda s: s['status'] == 'paused')
        service.action('continue'); time.sleep(.05)
        assert len(cloud.sends) == 1
    finally: service.close()

def test_download_retry_polls_existing_request(tmp_path):
    class DownloadFailure(Cloud):
        def __init__(self): super().__init__(); self.fail = True
        def poll(self):
            if self.fail: raise NeedsUser('下載失敗，請重試')
            return png()
    cloud = DownloadFailure(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert')
        wait(service, lambda s: s['status'] == 'paused')
        cloud.fail = False; service.action('retry', 0)
        wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 1
    finally: service.close()

def test_pre_send_readiness_can_continue(tmp_path):
    class Readiness(Cloud):
        def __init__(self): super().__init__(); self.ready = False
        def submit(self, path, prompt):
            if not self.ready: raise NeedsUser('請登入')
            super().submit(path, prompt)
    cloud = Readiness(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert')
        wait(service, lambda s: s['status'] == 'paused')
        assert service.snapshot()['items'][0]['phase'] == 'ready'
        cloud.ready = True; cloud.result = png(); service.action('continue')
        wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 1
    finally: service.close()

def test_finished_result_survives_restart(tmp_path):
    cloud = Cloud(); cloud.result = png(); service = QueueService(lambda: cloud, tmp_path/'state')
    service.start([('a.png', png())], tmp_path/'out', 'convert')
    state = wait(service, lambda s: s['status'] == 'completed'); service.close()
    restored = QueueService(lambda: Cloud(), tmp_path/'state')
    try:
        assert restored.snapshot()['items'][0]['result']['output_path'] == state['items'][0]['result']['output_path']
        assert restored.snapshot()['status'] == 'completed'
    finally: restored.close()

def test_open_failure_closes_browser_on_worker(tmp_path):
    class OpenFailure(Cloud):
        def open(self):
            super().open(); raise NeedsUser('請登入')
    cloud = OpenFailure(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert')
        wait(service, lambda s: s['status'] == 'paused')
    finally: service.close()
    assert cloud.closed

def test_redo_rejects_old_inflight_poll_result(tmp_path):
    entered = threading.Event(); release = threading.Event()
    class BarrierCloud(Cloud):
        def poll(self):
            if len(self.sends) == 1:
                entered.set(); assert release.wait(3)
            return png()
    cloud = BarrierCloud(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert')
        assert entered.wait(3)
        service.action('stop'); service.action('redo', 0); release.set()
        wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 2
    finally: release.set(); service.close()

def test_persistence_failure_is_visible_and_rejects_actions(tmp_path, monkeypatch):
    entered = threading.Event(); release = threading.Event()
    class BarrierCloud(Cloud):
        def poll(self):
            entered.set(); assert release.wait(3); return png()
    cloud = BarrierCloud(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert'); assert entered.wait(3)
        original = Path.write_text
        def failing_write(path, *args, **kwargs):
            if path.name == 'job.json.tmp': raise OSError('disk full')
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'write_text', failing_write); release.set()
        wait(service, lambda s: s['status'] == 'storage-error')
        assert 'disk full' in service.snapshot()['message']
        with pytest.raises(RuntimeError): service.action('continue')
        with pytest.raises(RuntimeError): service.action('redo', 0)
    finally: release.set(); service.close()

@pytest.mark.parametrize('stage', ['submit', 'save'])
def test_redo_rejects_old_inflight_submit_and_save(tmp_path, monkeypatch, stage):
    import core
    entered = threading.Event(); release = threading.Event()
    cloud = Cloud(); cloud.result = png()
    if stage == 'submit':
        original_submit = cloud.submit
        def submit(path, prompt):
            original_submit(path, prompt)
            if len(cloud.sends) == 1:
                entered.set(); assert release.wait(3)
        cloud.submit = submit
    else:
        original_save = core.save_result
        calls = []
        def save(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                entered.set(); assert release.wait(3)
            return original_save(*args, **kwargs)
        monkeypatch.setattr(core, 'save_result', save)
    service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert'); assert entered.wait(3)
        service.action('stop'); service.action('redo', 0); release.set()
        state = wait(service, lambda s: s['status'] == 'completed')
        assert len(cloud.sends) == 2
        if stage == 'save':
            assert Path(state['items'][0]['result']['output_path']).name == 'a_繁體_1.png'
    finally: release.set(); service.close()

@pytest.mark.parametrize('error', [NeedsUser('login expired'), OSError('download failed')])
def test_late_poll_error_cannot_clear_terminal_storage_failure(tmp_path, monkeypatch, error):
    entered = threading.Event(); release = threading.Event()
    class BarrierCloud(Cloud):
        def poll(self):
            entered.set(); assert release.wait(3); raise error
    cloud = BarrierCloud(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert'); assert entered.wait(3)
        original = Path.write_text
        failed = []
        def fail_once(path, *args, **kwargs):
            if path.name == 'job.json.tmp' and not failed:
                failed.append(True); raise OSError('one-shot disk failure')
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'write_text', fail_once)
        with pytest.raises(RuntimeError, match='one-shot disk failure'): service.action('stop')
        release.set(); service.worker.join(1)
        assert service.snapshot()['status'] == 'storage-error'
        assert 'one-shot disk failure' in service.snapshot()['message']
        with pytest.raises(RuntimeError): service.action('continue')
    finally: release.set(); service.close()

def test_late_poll_success_cannot_change_terminal_item_phase(tmp_path, monkeypatch):
    entered = threading.Event(); release = threading.Event()
    class BarrierCloud(Cloud):
        def poll(self):
            entered.set(); assert release.wait(3); return png()
    cloud = BarrierCloud(); service = QueueService(lambda: cloud, tmp_path/'state')
    try:
        service.start([('a.png', png())], tmp_path/'out', 'convert'); assert entered.wait(3)
        original = Path.write_text
        failed = []
        def fail_once(path, *args, **kwargs):
            if path.name == 'job.json.tmp' and not failed:
                failed.append(True); raise OSError('one-shot disk failure')
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'write_text', fail_once)
        with pytest.raises(RuntimeError): service.action('stop')
        release.set(); service.worker.join(1)
        assert service.snapshot()['status'] == 'storage-error'
        assert service.snapshot()['items'][0]['phase'] == 'pending'
        assert not list((tmp_path/'state').glob('*/*.result'))
    finally: release.set(); service.close()
