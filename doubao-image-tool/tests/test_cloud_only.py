import json
from pathlib import Path
from core import QueueService
from app import create_app
from test_core import Cloud,wait,png
from test_oss_queue import Publisher,setup
from test_image_batch import entry
from oss_storage import OSSError


def test_cloud_only_success_cleans_images_and_preserves_all_shared_refs(tmp_path,monkeypatch):
    p=Publisher();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry(),entry('https://img.pddpic.com/alias.png')],None,'p','task',cloud_only=True)
        state=wait(q,lambda s:s['status']=='completed')
        assert state['cloud_only'] and state['output_dir'] is None
        assert len(p.paths)==1 and len(cloud.sends)==1
        assert state['counts']['uploaded']==1 and state['counts']['converted']==1 and state['counts']['total']==2
        assert all(i['result']['public_url'] and i['refs'][0]['published_url'] for i in state['items'])
        assert not [f for f in (tmp_path/'state').rglob('*') if f.suffix in ('.png','.result','.jpg','.webp')]
        assert all(r['output_path'] is None for i in state['items'] for r in i['refs'])
        assert not list(tmp_path.glob('图片转换_*'))
    finally:q.close()


def test_cloud_only_failed_upload_is_retried_from_cache_then_removed(tmp_path,monkeypatch):
    p=Publisher();p.error=OSSError();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry(),entry('https://img.pddpic.com/alias.png')],None,'p','task',cloud_only=True)
        failed=wait(q,lambda s:s['status']=='completed');cached=Path(failed['items'][0]['result']['output_path'])
        assert cached.is_file() and tmp_path/'state' in cached.parents
        q.close()
        p.error=None;q=QueueService(lambda:cloud,tmp_path/'state',oss_factory=lambda:p)
        q.action('retry-upload',1);done=wait(q,lambda s:s['status']=='completed')
        assert len(cloud.sends)==1 and not cached.exists() and done['items'][0]['result']['public_url']
        assert all(i['phase']=='done' and i['refs'][0]['published_url'] for i in done['items'])
    finally:q.close()


def test_cloud_only_redo_redownloads_input_after_cache_cleanup(tmp_path,monkeypatch):
    p=Publisher();q,cloud=setup(tmp_path,monkeypatch,p)
    try:
        q.start_urls([entry()],None,'p','task',cloud_only=True)
        wait(q,lambda s:s['status']=='completed');cloud.result=png()
        q.action('redo',0);done=wait(q,lambda s:s['status']=='completed')
        assert len(cloud.sends)==2 and len(p.paths)==2 and done['items'][0]['phase']=='done'
        assert done['items'][0]['refs'][0]['published_revision']==1
    finally:q.close()


def test_bridge_cloud_batch_needs_no_folder_and_remote_preview_after_cleanup(tmp_path,monkeypatch):
    import core,cloud_images
    monkeypatch.setattr(core,'download_image',lambda url:(png(),'.png'))
    monkeypatch.setattr(cloud_images,'download_image',lambda url:(png(),'.png'))
    monkeypatch.setattr(cloud_images,'read_public',lambda url:png())
    cloud=Cloud();cloud.result=png();p=Publisher()
    app=create_app(lambda:cloud,tmp_path/'private',token='t',oss_factory=lambda:p)
    h={'X-Tool-Token':'t','X-Extension-Id':'a'*32,'Origin':'chrome-extension://'+'a'*32}
    try:
        with app.test_client() as c:
            c.post('/api/bridge/pair',headers=h,json={'extension_id':'a'*32})
            assert c.get('/api/bridge/capabilities',headers=h).json['cloud_image_storage']
            response=c.post('/api/bridge/jobs',headers=h,json={'source_task_id':'task','entries':[entry()],'cloud_only':True})
            assert response.status_code==200,response.json
            state=wait(app.extensions['queue'],lambda s:s['status']=='completed')
            for kind in ('original','result'):
                assert c.get(f"/api/bridge/images/{state['id']}/0/{kind}",headers=h).status_code==200
                assert c.get(f"/api/images/{state['id']}/0/{kind}",headers={'X-Tool-Token':'t'}).status_code==200
    finally:app.extensions['queue'].close(clear_state=True)


def test_restart_cleans_leftover_successful_cloud_cache_without_touching_outputs(tmp_path,monkeypatch):
    p=Publisher();q,cloud=setup(tmp_path,monkeypatch,p)
    q.start_urls([entry()],None,'p','task',cloud_only=True)
    state=wait(q,lambda s:s['status']=='completed');cached=Path(state['items'][0]['result']['output_path'])
    q.close();cached.write_bytes(png())
    outside=tmp_path/'already-saved.png';outside.write_bytes(png())
    # A stale record cannot cause cleanup to reach another output directory.
    job_file=tmp_path/'state/job.json';job=json.loads(job_file.read_text(encoding='utf-8'))
    job['items'][0]['result']['record_path']=str(outside);job_file.write_text(json.dumps(job),encoding='utf-8')
    q=QueueService(lambda:cloud,tmp_path/'state',oss_factory=lambda:p)
    try:assert not cached.exists() and outside.exists() and len(cloud.sends)==1
    finally:q.close()


def test_paid_cloud_upload_retry_keeps_paid_calls_at_one(tmp_path,monkeypatch):
    import core
    from test_aliyun import Translator,image,never_browser
    monkeypatch.setattr(core,'download_image',lambda url:(image(),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda url:(image(),'.png'))
    translator=Translator();p=Publisher();p.error=OSSError()
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:translator,oss_factory=lambda:p)
    try:
        q.start_urls([entry()],None,'p','task',provider='aliyun',paid_confirmed=True,cloud_only=True)
        state=wait(q,lambda s:s['status']=='completed');assert state['paid_calls']==translator.calls==1
        p.error=None;q.action('retry-upload',0);state=wait(q,lambda s:s['status']=='completed')
        assert state['paid_calls']==translator.calls==1 and state['items'][0]['result']['public_url']
        assert not Path(state['items'][0]['result']['output_path']).exists()
    finally:q.close()
