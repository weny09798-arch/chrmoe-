import json
from pathlib import Path
import threading
import pytest
from core import QueueService
from test_core import Cloud,wait,png
from test_image_batch import entry
from oss_storage import OSSError

class Publisher:
    target_id='target-1'
    def __init__(self):self.paths=[];self.error=None
    def publish(self,path):
        self.paths.append(str(path))
        if self.error:raise self.error
        return dict(url='https://bucket.oss-cn-hangzhou.aliyuncs.com/converted-images/test.png',object_key='converted-images/test.png',sha256='a'*64)

def setup(tmp_path,monkeypatch,publisher):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(png(),'.png'))
    cloud=Cloud();cloud.result=png()
    q=QueueService(lambda:cloud,tmp_path/'state',oss_factory=lambda:publisher)
    return q,cloud

def test_save_then_upload_publishes_every_position_without_xlsx(tmp_path,monkeypatch):
    publisher=Publisher();q,cloud=setup(tmp_path,monkeypatch,publisher)
    try:
        q.start_urls([entry(),{**entry(),'kind':'sku','sku':'same','order':2,'sku_index':1}],tmp_path/'out','p','task')
        state=wait(q,lambda s:s['status']=='completed')
        assert len(cloud.sends)==1 and len(publisher.paths)==1
        refs=state['items'][0]['refs']
        assert all(r['published_url']=='https://bucket.oss-cn-hangzhou.aliyuncs.com/converted-images/test.png' for r in refs)
        assert refs[1]['sku_index']==1 and refs[0]['sku_index'] is None
        assert state['counts']['uploaded']==1
        assert not list((tmp_path/'out').rglob('*.xlsx'))
    finally:q.close()

def test_upload_failure_retry_reuses_local_result_without_regeneration(tmp_path,monkeypatch):
    p=Publisher();p.error=OSSError();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry()],tmp_path/'out','p','task')
        failed=wait(q,lambda s:s['status']=='completed')
        item=failed['items'][0]
        assert item['phase']=='upload-failed' and item['result']['output_path']
        assert not item['refs'][0].get('published_url')
        saved=item['result']['output_path'];p.error=None;q.action('retry-upload',0)
        done=wait(q,lambda s:s['items'][0]['phase']=='done')
        assert len(cloud.sends)==1 and done['items'][0]['result']['output_path']==saved
    finally:q.close()

def test_account_error_pauses_before_next_translation(tmp_path,monkeypatch):
    p=Publisher();p.error=OSSError('configuration');q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','p','task')
        state=wait(q,lambda s:s['status']=='paused')
        assert len(cloud.sends)==1 and state['items'][0]['phase']=='upload-failed'
    finally:q.close()

def test_stop_during_upload_keeps_verified_result_and_does_not_start_next(tmp_path,monkeypatch):
    entered=threading.Event();release=threading.Event()
    class Slow(Publisher):
        def publish(self,path):entered.set();release.wait(2);return super().publish(path)
    q,cloud=setup(tmp_path,monkeypatch,Slow())
    try:
        q.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','p','task')
        assert entered.wait(2);q.action('stop');release.set()
        state=wait(q,lambda s:bool(s['items'][0]['refs'][0].get('published_url')))
        assert state['status']=='stopped' and len(cloud.sends)==1
    finally:release.set();q.close()

def test_clear_during_upload_cannot_publish_old_results(tmp_path,monkeypatch):
    entered=threading.Event();release=threading.Event()
    class Slow(Publisher):
        def publish(self,path):entered.set();release.wait(2);return super().publish(path)
    q,cloud=setup(tmp_path,monkeypatch,Slow())
    q.start_urls([entry()],tmp_path/'out','p','task')
    assert entered.wait(2)
    mapping=Path(q.snapshot()['mapping_path'])
    q.request_close(clear_state=True);release.set();q.close(clear_state=True)
    assert q.snapshot()['id'] is None
    assert mapping.exists()
    assert all(not row.get('published_url') for row in json.loads(mapping.read_text(encoding='utf-8'))['rows'])

def test_changed_destination_blocks_before_first_translation(tmp_path,monkeypatch):
    import core
    entered=threading.Event();release=threading.Event()
    def download(url):entered.set();assert release.wait(3);return png(),'.png'
    p=Publisher();q,cloud=setup(tmp_path,monkeypatch,p)
    monkeypatch.setattr(core,'download_image',download)
    try:
        q.start_urls([entry()],tmp_path/'out','p','task')
        assert entered.wait(2);p.target_id='different-target';release.set()
        state=wait(q,lambda s:s['status']=='paused')
        assert cloud.sends==[] and state['items'][0]['phase']=='ready'
        assert state['items'][0]['result'] is None
    finally:release.set();q.close()

def test_byte_aliases_share_one_verified_cloud_result(tmp_path,monkeypatch):
    p=Publisher();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','p','task')
        state=wait(q,lambda s:s['status']=='completed')
        assert len(cloud.sends)==1 and len(p.paths)==1
        assert state['items'][1]['alias_of']==0
        assert all(i['refs'][0]['published_url']=='https://bucket.oss-cn-hangzhou.aliyuncs.com/converted-images/test.png' for i in state['items'])
        assert all(Path(i['result']['output_path']).exists() for i in state['items'])
    finally:q.close()

def test_alias_upload_retry_finishes_canonical_and_alias_without_translation(tmp_path,monkeypatch):
    p=Publisher();p.error=OSSError();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','p','task')
        wait(q,lambda s:s['status']=='completed');p.error=None
        q.action('retry-upload',1)
        state=wait(q,lambda s:s['status']=='completed')
        assert all(i['phase']=='done' and i['refs'][0].get('published_url') for i in state['items'])
        assert len(cloud.sends)==1 and len(p.paths)==2
    finally:q.close()

def test_restart_uploading_resumes_local_result_without_translation(tmp_path,monkeypatch):
    p=Publisher();q,cloud=setup(tmp_path,monkeypatch,p)
    q.start_urls([entry()],tmp_path/'out','p','task')
    done=wait(q,lambda s:s['status']=='completed');saved=done['items'][0]['result']['output_path']
    with q.cv:
        q.job['status']='stopped';q.job['items'][0].update(phase='uploading',status='queued')
        q.job['items'][0].pop('upload_result')
        for ref in q.job['items'][0]['refs']:ref.pop('published_url');ref.pop('published_revision')
        q._persist()
    q.close()
    restored=QueueService(lambda:(_ for _ in ()).throw(AssertionError('must not open browser')),tmp_path/'state',oss_factory=lambda:p)
    try:
        assert restored.snapshot()['status']=='paused'
        restored.action('continue');state=wait(restored,lambda s:s['status']=='completed')
        assert state['items'][0]['result']['output_path']==saved and len(p.paths)==2
        assert state['items'][0]['refs'][0]['published_url']
    finally:restored.close()

def test_redo_retains_old_published_reference_until_replacement_verified(tmp_path,monkeypatch):
    class Replacement(Publisher):
        url='https://bucket.oss-cn-hangzhou.aliyuncs.com/converted-images/old.png'
        def publish(self,path):return {**super().publish(path),'url':self.url}
    p=Replacement();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry()],tmp_path/'out','p','task')
        old=wait(q,lambda s:s['status']=='completed')['items'][0]['refs'][0]
        p.url='https://bucket.oss-cn-hangzhou.aliyuncs.com/converted-images/replacement.png'
        p.error=OSSError();q.action('redo',0)
        failed=wait(q,lambda s:s['status']=='completed')['items'][0]
        assert failed['phase']=='upload-failed'
        assert failed['refs'][0]['published_url']==old['published_url']
        assert failed['refs'][0]['published_revision']==old['published_revision']==0
        p.error=None;q.action('retry-upload',0)
        done=wait(q,lambda s:s['status']=='completed')['items'][0]
        assert done['refs'][0]['published_revision']==1 and len(cloud.sends)==2
        assert done['refs'][0]['published_url']=='https://bucket.oss-cn-hangzhou.aliyuncs.com/converted-images/replacement.png'
    finally:q.close()

def test_stopped_upload_configuration_error_does_not_resume_or_pause_job(tmp_path,monkeypatch):
    entered=threading.Event();release=threading.Event()
    class Failing(Publisher):
        def publish(self,path):entered.set();assert release.wait(3);raise OSSError('configuration')
    q,cloud=setup(tmp_path,monkeypatch,Failing())
    try:
        q.start_urls([entry()],tmp_path/'out','p','task')
        assert entered.wait(2);q.action('stop');release.set()
        state=wait(q,lambda s:s['items'][0]['phase']=='upload-failed')
        assert state['status']=='stopped' and len(cloud.sends)==1
    finally:release.set();q.close()

def test_destination_change_during_doubao_preparation_blocks_send_gate(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(png(),'.png'))
    p=Publisher()
    class Preparing(Cloud):
        def submit(self,path,prompt,send_gate):
            p.target_id='changed-before-send'
            return super().submit(path,prompt,send_gate)
    cloud=Preparing();cloud.result=png()
    q=QueueService(lambda:cloud,tmp_path/'state',oss_factory=lambda:p)
    try:
        q.start_urls([entry()],tmp_path/'out','p','task')
        state=wait(q,lambda s:s['status']=='paused')
        assert cloud.sends==[] and state['items'][0]['phase']=='ready'
    finally:q.close()

def test_destination_change_during_aliyun_setup_blocks_paid_commit(tmp_path,monkeypatch):
    import core
    from test_aliyun import Translator,image,never_browser
    monkeypatch.setattr(core,'download_image',lambda url:(image(),'.png'))
    p=Publisher();translator=Translator();setup_count=0
    def aliyun_factory():
        nonlocal setup_count
        setup_count+=1
        if setup_count>1:p.target_id='changed-before-paid-commit'
        return translator
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=aliyun_factory,oss_factory=lambda:p)
    try:
        q.start_urls([entry()],tmp_path/'out','p','task',provider='aliyun',paid_confirmed=True)
        state=wait(q,lambda s:s['status']=='paused')
        assert translator.calls==0 and state['paid_calls']==0
        assert state['items'][0]['phase']=='aliyun-ready'
    finally:q.close()

def test_legacy_unfinished_job_restores_sku_index_without_enabling_cloud_upload(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(png(),'.png'))
    save=core.save_positions
    monkeypatch.setattr(core,'save_positions',lambda *args:(_ for _ in ()).throw(OSError('disk blocked')))
    cloud=Cloud();cloud.result=png();q=QueueService(lambda:cloud,tmp_path/'state')
    q.start_urls([{**entry(),'kind':'sku','order':3}],tmp_path/'out','p','task')
    wait(q,lambda s:s['status']=='paused')
    with q.cv:
        q.job.pop('upload_enabled');q.job.pop('oss_target_id')
        q.job['items'][0]['refs'][0].pop('sku_index');q._persist()
    q.close();monkeypatch.setattr(core,'save_positions',save)
    def unexpected():raise AssertionError('legacy local job must not acquire a publisher')
    restored=QueueService(lambda:cloud,tmp_path/'state',oss_factory=unexpected)
    try:
        assert restored.snapshot()['items'][0]['refs'][0]['sku_index']==2
        restored.action('continue');state=wait(restored,lambda s:s['status']=='completed')
        assert state['counts']['uploaded']==0 and not state['items'][0]['refs'][0].get('published_url')
        assert len(cloud.sends)==1 and Path(state['items'][0]['result']['output_path']).is_file()
    finally:restored.close()
