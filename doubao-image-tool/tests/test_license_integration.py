import io
import threading
import time
from pathlib import Path
import pytest
from app import create_app
from core import QueueService
from license_authority import LicenseRequiredError
from license_fakes import PermittingAuthority
from test_core import Cloud, png, wait
from test_aliyun import image, entries, Translator, never_browser
from oss_fakes import FakePublisher
from test_license_components import signer


def test_production_default_denies_start_without_configuration(tmp_path):
    q = QueueService(Cloud, tmp_path/'state')
    try:
        with pytest.raises(LicenseRequiredError):
            q.start([('a.png', png())], tmp_path/'out', 'convert')
        assert q.snapshot()['id'] is None
    finally: q.close()


@pytest.mark.parametrize('state', ['expired', 'disabled', 'unbound'])
def test_direct_start_urls_cannot_bypass_license(tmp_path, state):
    authority = PermittingAuthority(); authority.deny(state)
    q = QueueService(Cloud, tmp_path/'state', license_authority=authority)
    try:
        with pytest.raises(LicenseRequiredError):
            q.start_urls(entries(), tmp_path/'out', 'convert', 'source')
        assert q.snapshot()['id'] is None
    finally: q.close()


def test_exact_send_gate_expiry_is_known_not_sent(tmp_path):
    authority = PermittingAuthority()
    class Expiring(Cloud):
        def submit(self, path, prompt, send_gate):
            authority.deny()
            super().submit(path, prompt, send_gate)
    cloud = Expiring()
    q = QueueService(lambda: cloud, tmp_path/'state', license_authority=authority)
    try:
        q.start([('a.png', png())], tmp_path/'out', 'convert')
        s = wait(q, lambda s:s['status']=='paused')
        assert s['items'][0]['phase']=='ready' and not cloud.sends
        with pytest.raises(LicenseRequiredError): q.action('redo', 0)
    finally:q.close()


@pytest.mark.parametrize('count', [1, 2])
def test_expiry_finishes_submitted_save_then_pauses_and_renewal_is_manual(tmp_path, count):
    authority = PermittingAuthority(); cloud = Cloud()
    q = QueueService(lambda:cloud, tmp_path/'state', license_authority=authority)
    try:
        q.start([(f'{n}.png', png()) for n in range(count)], tmp_path/'out', 'convert')
        wait(q, lambda s:s['items'][0]['phase']=='pending')
        authority.deny(); time.sleep(.07); cloud.result=png()
        s=wait(q, lambda s:s['status']=='paused')
        assert s['items'][0]['status']=='completed'
        assert Path(s['items'][0]['result']['output_path']).is_file()
        assert len(cloud.sends)==1
        authority.activate('renewed'); time.sleep(.07)
        assert q.snapshot()['status']=='paused' and len(cloud.sends)==1
        q.action('continue'); wait(q, lambda s:s['status']=='completed')
        assert len(cloud.sends)==count
    finally:q.close()


def test_denied_pending_retry_and_upload_finish_without_new_charge(tmp_path, monkeypatch):
    import core
    authority=PermittingAuthority(); t=Translator()
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    def result(url):
        authority.deny('disabled')
        return image(),'.png'
    monkeypatch.setattr(core,'download_aliyun_result',result)
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t,oss_factory=FakePublisher,license_authority=authority)
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='paused')
        assert s['items'][0]['upload_result'] and t.calls==1
        q.action('retry-upload',0)
        wait(q,lambda s:s['status']=='paused')
        assert t.calls==1 and q.snapshot()['paid_calls']==1
    finally:q.close()


def test_helper_denial_resets_paid_attempt_to_ready(tmp_path):
    authority=PermittingAuthority()
    class Denied(Translator):
        def translate(self,path):
            authority.deny(); raise LicenseRequiredError(authority.status())
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=Denied,license_authority=authority)
    try:
        q.start([('a.png',image())],tmp_path/'out','convert',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='paused')
        assert s['items'][0]['phase']=='aliyun-ready' and s['paid_calls']==0
    finally:q.close()


def test_periodic_monitor_start_reset_and_close(tmp_path, monkeypatch):
    monkeypatch.setattr(QueueService,'license_poll_interval',.02,raising=False)
    authority=PermittingAuthority()
    app=create_app(Cloud,tmp_path,token='t',license_authority=authority)
    old=app.extensions['queue']
    try:
        time.sleep(.07)
        assert authority.startups==1 and authority.reads>=3
        response=app.test_client().post('/api/reset',headers={'X-Tool-Token':'t'},json={})
        assert response.status_code==200
        assert not old.license_worker.is_alive() and not authority.closed
        assert app.extensions['queue'].license is authority
    finally:app.extensions['queue'].close()
    assert authority.closed and not app.extensions['queue'].license_worker.is_alive()


def test_local_and_bridge_license_security_and_status(tmp_path):
    authority=PermittingAuthority();authority.deny('disabled')
    app=create_app(Cloud,tmp_path,token='t',license_authority=authority)
    try:
        c=app.test_client(); h={'X-Tool-Token':'t'}
        assert c.get('/api/license/status').status_code==403
        assert c.post('/api/license/activate',headers={**h,'Origin':'https://evil.test'},json={'code':'renewed'}).status_code==403
        assert c.get('/api/license/status',headers=h).json['status']=='disabled'
        r=c.post('/api/jobs',headers=h,data={'files':(io.BytesIO(png()),'a.png'),'output_dir':str(tmp_path/'out')})
        assert r.status_code==423 and r.json['license']['status']=='disabled'
        extension='a'*32; bh={**h,'X-Extension-Id':extension,'Origin':'chrome-extension://'+extension}
        assert c.get('/api/bridge/license/status',headers=bh).status_code==403
        assert c.post('/api/bridge/pair',headers=bh,json={'extension_id':extension}).status_code==200
        assert c.get('/api/bridge/capabilities',headers=bh).json['licensing'] is True
        preflight=c.options('/api/bridge/license/status',headers={'Origin':bh['Origin'],'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'X-Tool-Token,X-Extension-Id'})
        assert preflight.status_code==204
        r=c.post('/api/bridge/license/activate',headers=bh,json={'code':'renewed'})
        assert r.status_code==200 and r.json['allowed']
        assert 'renewed' not in r.get_data(as_text=True)
        assert c.post('/api/bridge/license/refresh',headers=bh,json={}).json['allowed']
        assert app.extensions['queue'].snapshot()['id'] is None
    finally:app.extensions['queue'].close()


def test_sdk_guard_after_client_preparation_prevents_call(tmp_path):
    from aliyun_translation import sdk_translate
    authority=PermittingAuthority();path=tmp_path/'a.png';path.write_bytes(image())
    class Client:
        def __init__(self,config):authority.deny()
        def translate_image_with_options(self,*args):raise AssertionError('paid call bypassed license')
    with pytest.raises(LicenseRequiredError):
        sdk_translate({'access_key_id':'id','access_key_secret':'secret'},path,Client,license_authority=authority)


def test_refresh_denial_during_continue_still_allows_pending_retrieval(tmp_path):
    class RevokeOnRefresh(PermittingAuthority):
        revoke=False
        def require_new_work(self, *, force_refresh=True):
            if force_refresh and self.revoke:self.deny('disabled')
            return super().require_new_work(force_refresh=force_refresh)
    authority=RevokeOnRefresh();cloud=Cloud()
    q=QueueService(lambda:cloud,tmp_path/'state',license_authority=authority)
    try:
        q.start([('a.png',png()),('b.png',png())],tmp_path/'out','convert')
        wait(q,lambda s:s['items'][0]['phase']=='pending');q.action('stop')
        authority.revoke=True;cloud.result=png()
        q.action('continue')
        s=wait(q,lambda s:s['status']=='paused')
        assert s['items'][0]['status']=='completed' and len(cloud.sends)==1
    finally:q.close()


def test_upload_retry_later_item_ignores_earlier_new_work_while_denied(tmp_path, monkeypatch):
    import core
    authority=PermittingAuthority();t=Translator()
    monkeypatch.setattr(core,'download_image',lambda u:(image(color='red' if '/0.' in u else 'blue'),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(),'.png'))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t,oss_factory=FakePublisher,license_authority=authority)
    try:
        q.start_urls(entries(('main','detail')),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        wait(q,lambda s:s['status']=='completed')
        with q.cv:
            q.job['status']='paused'
            q.job['items'][0].update(status='queued',phase='aliyun-ready',result=None)
            q.job['items'][1].update(status='failed',phase='upload-failed')
            q.job['items'][1].pop('upload_result',None)
        authority.deny()
        q.action('retry-upload',1)
        s=wait(q,lambda s:s['status']=='paused')
        assert s['items'][1].get('upload_result') and t.calls==2
    finally:q.close()


def test_monitor_denial_latches_until_manual_resume_even_if_renewed_inflight(tmp_path, monkeypatch):
    monkeypatch.setattr(QueueService,'license_poll_interval',.01)
    authority=PermittingAuthority();cloud=Cloud()
    q=QueueService(lambda:cloud,tmp_path/'state',license_authority=authority)
    try:
        q.start([('a.png',png()),('b.png',png())],tmp_path/'out','convert')
        wait(q,lambda s:s['items'][0]['phase']=='pending')
        authority.deny('disabled');time.sleep(.04)
        authority.activate('renewed');cloud.result=png()
        s=wait(q,lambda s:s['status']=='paused')
        assert s['items'][0]['status']=='completed' and len(cloud.sends)==1
        q.action('continue');wait(q,lambda s:s['status']=='completed')
    finally:q.close()


def test_real_authority_idle_scheduler_validates_at_300_seconds_and_throttles_outage(tmp_path, monkeypatch, signer):
    from test_licensing import Clock, Store, Service
    from license_authority import LicenseAuthority
    from license_config import LicenseBuildConfig
    clock=Clock();store=Store();service=Service(signer[0],clock,store)
    authority=LicenseAuthority(config=LicenseBuildConfig('https://license.example',signer[1]),store=store,transport=service,hardware_provider=lambda:'a'*64,wall_clock=lambda:clock.wall,monotonic_clock=lambda:clock.mono)
    authority.activate('test-only-code-0123456789-abcdefghij')
    monkeypatch.setattr(QueueService,'license_poll_interval',.01)
    q=QueueService(Cloud,tmp_path/'state',license_authority=authority)
    try:
        assert len(service.calls)==2 and service.calls[-1][0]=='validate'
        service.result='outage';clock.advance(300)
        time.sleep(.07)
        assert len(service.calls)==3
        for _ in range(10):q.snapshot()
        assert len(service.calls)==3
    finally:q.close()


def test_real_helper_denial_is_known_not_submitted_and_uses_isolated_root(tmp_path):
    from aliyun_translation import AliyunTranslator
    path=tmp_path/'a.png';path.write_bytes(image())
    translator=AliyunTranslator({'access_key_id':'test-id','access_key_secret':'test-secret'},profile_root=tmp_path/'profile')
    with pytest.raises(LicenseRequiredError) as caught:translator.translate(path)
    assert caught.value.status.state=='unconfigured'


def test_default_app_reset_preserves_license_file_and_is_locked(tmp_path):
    marker=tmp_path/'license.dpapi';marker.write_bytes(b'isolated-license-record')
    app=create_app(Cloud,tmp_path,token='t')
    try:
        c=app.test_client();h={'X-Tool-Token':'t'}
        assert c.get('/api/license/status',headers=h).json['status']=='unconfigured'
        assert c.post('/api/reset',headers=h,json={}).status_code==200
        assert marker.read_bytes()==b'isolated-license-record'
        assert c.get('/api/license/status',headers=h).json['allowed'] is False
        assert c.post('/api/exit',headers=h,json={}).status_code==200
        assert marker.read_bytes()==b'isolated-license-record'
    finally:app.extensions['queue'].close()


def test_manual_refresh_denial_is_latched_before_immediate_reactivation(tmp_path, monkeypatch):
    class DenyRefresh(PermittingAuthority):
        def refresh(self):self.deny('disabled');return self.status()
    monkeypatch.setattr(QueueService,'license_poll_interval',60)
    authority=DenyRefresh();cloud=Cloud()
    app=create_app(lambda:cloud,tmp_path,token='t',license_authority=authority)
    q=app.extensions['queue']
    try:
        q.start([('a.png',png()),('b.png',png())],tmp_path/'out','convert')
        wait(q,lambda s:s['items'][0]['phase']=='pending')
        c=app.test_client();h={'X-Tool-Token':'t'}
        assert c.post('/api/license/refresh',headers=h,json={}).json['allowed'] is False
        assert c.post('/api/license/activate',headers=h,json={'code':'renewed'}).json['allowed']
        cloud.result=png()
        s=wait(q,lambda s:s['status'] in {'paused','completed'})
        assert s['status']=='paused' and len(cloud.sends)==1
    finally:q.close()


def test_rejected_new_job_cannot_clear_inflight_manual_resume_latch(tmp_path):
    authority=PermittingAuthority();cloud=Cloud()
    q=QueueService(lambda:cloud,tmp_path/'state',license_authority=authority)
    try:
        q.start([('a.png',png()),('b.png',png())],tmp_path/'out','convert')
        wait(q,lambda s:s['items'][0]['phase']=='pending')
        authority.deny();q.snapshot();authority.activate('renewed')
        with pytest.raises(ValueError):q.start([('c.png',png())],tmp_path/'out','convert')
        cloud.result=png()
        s=wait(q,lambda s:s['status'] in {'paused','completed'})
        assert s['status']=='paused' and len(cloud.sends)==1
    finally:q.close()


def test_denied_start_attempt_also_latches_inflight_pause(tmp_path, monkeypatch):
    monkeypatch.setattr(QueueService,'license_poll_interval',60)
    authority=PermittingAuthority();cloud=Cloud()
    q=QueueService(lambda:cloud,tmp_path/'state',license_authority=authority)
    try:
        q.start([('a.png',png()),('b.png',png())],tmp_path/'out','convert')
        wait(q,lambda s:s['items'][0]['phase']=='pending')
        authority.deny()
        with pytest.raises(LicenseRequiredError):q.start([('c.png',png())],tmp_path/'out','convert')
        authority.activate('renewed');cloud.result=png()
        s=wait(q,lambda s:s['status'] in {'paused','completed'})
        assert s['status']=='paused' and len(cloud.sends)==1
    finally:q.close()
