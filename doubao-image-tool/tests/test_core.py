from contextlib import nullcontext
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
    def submit(self, path, prompt, send_gate=nullcontext):
        assert threading.get_ident() == self.owner
        with send_gate(): self.sends.append((Path(path).read_bytes(), prompt))
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
        def submit(self, path, prompt, send_gate=nullcontext):
            super().submit(path, prompt, send_gate); raise SubmissionUncertain('inspect Chrome')
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
        def submit(self, path, prompt, send_gate=nullcontext):
            if not self.ready: raise NeedsUser('請登入')
            super().submit(path, prompt, send_gate)
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
        def submit(path, prompt, send_gate=nullcontext):
            original_submit(path, prompt, send_gate)
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

@pytest.mark.parametrize('operation', ['stop', 'exit', 'redo'])
def test_cancel_prepared_unsent_request_before_commit(tmp_path, operation):
    entered, release = threading.Event(), threading.Event()
    class Preparing(Cloud):
        def submit(self, path, prompt, send_gate=None):
            entered.set(); release.wait(2)
            if send_gate:
                with send_gate(): self.sends.append((Path(path).read_bytes(), prompt))
            else: self.sends.append((Path(path).read_bytes(), prompt))
    cloud=Preparing(); service=QueueService(lambda:cloud,tmp_path/'state')
    service.start([('a.png',png())],tmp_path/'out','convert'); assert entered.wait(1)
    closer=None
    try:
        if operation=='exit':
            closer=threading.Thread(target=service.close); closer.start()
            with service.cv: assert service.closed
        else:
            service.action('stop')
            if operation=='redo':
                service.action('redo',0); service.action('stop')
        release.set()
        if closer: closer.join(3); assert not closer.is_alive()
        else: wait(service, lambda s:s['items'][0]['phase']=='ready')
        assert cloud.sends==[], 'An unsent stopped/closed/stale preparation must not commit Send'
        if operation!='exit':
            assert service.snapshot()['status']=='stopped'
            service.action('continue'); wait(service,lambda s:s['items'][0]['phase']=='pending')
            assert len(cloud.sends)==1
    finally: release.set(); service.close()

def test_restart_keeps_known_unsent_items_queued_but_submitted_needs_review(tmp_path):
    import json
    root=tmp_path/'state';root.mkdir()
    source=root/'input.png';source.write_bytes(png())
    items=[{'index':i,'name':f'{i}.png','input_path':str(source),'status':'running' if i==0 else 'queued','phase':'pending' if i==0 else 'ready','message':'','result':None} for i in range(2)]
    (root/'job.json').write_text(json.dumps({'id':'job','status':'running','output_dir':str(tmp_path/'out'),'prompt':'convert','items':items,'message':''}),encoding='utf-8')
    cloud=Cloud();cloud.result=png();service=QueueService(lambda:cloud,root)
    try:
        snapshot=service.snapshot();assert snapshot['status']=='paused'
        assert snapshot['items'][0]['status']=='needs-review'
        assert snapshot['items'][1]['status']=='queued'
        service.action('continue');time.sleep(.03);assert cloud.sends==[]
        service.action('retry',0);wait(service,lambda s:s['status']=='completed')
        assert len(cloud.sends)==2
    finally:service.close()

@pytest.mark.parametrize('command', ['continue','retry'])
def test_accepted_resume_clears_stale_job_error(tmp_path,command):
    cloud=Cloud();service=QueueService(lambda:cloud,tmp_path/'state')
    try:
        service.start([('a.png',png())],tmp_path/'out','convert')
        wait(service,lambda s:s['items'][0]['phase']=='pending')
        service.action('stop')
        with service.cv:
            service.job['message']='旧的上传错误'
            service.job['items'][0]['message']='旧的上传错误'
        service.action(command,0 if command=='retry' else None)
        assert service.snapshot()['message']=='', 'Accepted resume should remove old job error'
    finally:service.close()

def test_explicit_close_clears_task_cache_but_keeps_login_and_outputs(tmp_path):
    profile = tmp_path/'chrome-profile'; profile.mkdir(); (profile/'login').write_text('keep')
    cloud=Cloud(); cloud.result=png(); root=tmp_path/'state'
    service=QueueService(lambda:cloud,root)
    service.start([('a.png',png())],tmp_path/'out','convert')
    state=wait(service,lambda s:s['status']=='completed')
    output=Path(state['items'][0]['result']['output_path'])
    service.close(clear_state=True)
    assert not list(root.iterdir())
    assert output.exists() and output.with_suffix('.json').exists()
    assert (profile/'login').read_text()=='keep'
    restored=QueueService(lambda:Cloud(),root)
    try: assert restored.snapshot()['status']=='idle'
    finally: restored.close()

def test_close_waits_for_inflight_work_before_clearing_cache(tmp_path):
    entered,release=threading.Event(),threading.Event()
    class Slow(Cloud):
        def poll(self): entered.set(); release.wait(2); return png()
    service=QueueService(lambda:Slow(),tmp_path/'state')
    service.start([('a.png',png())],tmp_path/'out','convert'); assert entered.wait(1)
    cache=Path(service.snapshot()['items'][0]['input_path'])
    closer=threading.Thread(target=lambda:service.close(clear_state=True))
    closer.start()
    try:
        time.sleep(.05); assert closer.is_alive() and cache.exists()
        release.set(); closer.join(3)
        assert not closer.is_alive()
        assert not list((tmp_path/'state').iterdir())
    finally: release.set(); service.close()

def test_regenerate_submits_again_and_does_not_show_previous_output_as_new(tmp_path):
    cloud=Cloud(); cloud.result=png(); service=QueueService(lambda:cloud,tmp_path/'state')
    try:
        service.start([('a.png',png())],tmp_path/'out','convert')
        saved=wait(service,lambda s:s['status']=='completed')['items'][0]['result']['output_path']
        cloud.result=None; service.action('redo',0)
        pending=wait(service,lambda s:s['items'][0]['phase']=='pending')
        assert pending['items'][0]['result'] is None
        assert len(cloud.sends)==2
        cloud.result=png(); result=wait(service,lambda s:s['status']=='completed')
        assert result['items'][0]['result']['output_path']!=saved
        assert Path(saved).exists()
    finally: service.close()

def test_restart_can_download_known_conversation_without_resubmitting(tmp_path):
    import json
    cloud=Cloud();service=QueueService(lambda:cloud,tmp_path/'state')
    service.start([('a.png',png())],tmp_path/'out','convert')
    wait(service,lambda s:s['items'][0]['phase']=='pending');service.close()
    path=tmp_path/'state'/'job.json';job=json.loads(path.read_text(encoding='utf-8'))
    job['items'][0]['download_recovery']={'conversation_url':'https://www.doubao.com/chat/12345678','identity':'a'*32}
    path.write_text(json.dumps(job),encoding='utf-8')
    class Recovered(Cloud):
        def resume_from(self,state):self.restored=state
        def poll(self):return png()
    other=Recovered();restored=QueueService(lambda:other,tmp_path/'state')
    try:
        assert restored.snapshot()['items'][0]['status']=='paused'
        restored.action('continue');result=wait(restored,lambda s:s['status']=='completed')
        assert other.sends==[]
        assert other.restored['conversation_url']=='https://www.doubao.com/chat/12345678'
        assert Path(result['items'][0]['result']['output_path']).exists()
    finally:restored.close()
