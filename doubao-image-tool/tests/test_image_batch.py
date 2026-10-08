import io
import json
import threading
from pathlib import Path
from urllib.error import HTTPError

import pytest
from PIL import Image

from core import QueueService
from test_core import Cloud, wait


def picture(color='red'):
    stream = io.BytesIO()
    Image.new('RGB', (2, 2), color).save(stream, 'PNG')
    return stream.getvalue()


def entry(url='https://img.pddpic.com/a.png?x=1', **changes):
    return dict(platform='pdd', product_id='001', title='示例/商品', kind='main',
                sku='', order=1, url=url, product_url='https://mobile.yangkeduo.com/goods.html?goods_id=001', **changes)


def test_url_queue_groups_positions_keeps_order_and_writes_all_outputs(tmp_path, monkeypatch):
    import core
    downloads = []
    def download(url):
        downloads.append((url, threading.get_ident()))
        return picture(), '.png'
    monkeypatch.setattr(core, 'download_image', download, raising=False)
    cloud = Cloud(); cloud.result = picture('blue')
    service = QueueService(lambda: cloud, tmp_path/'state')
    entries = [entry(), {**entry(), 'kind':'detail', 'order':2},
               {**entry(), 'platform':'1688', 'product_id':'002', 'kind':'sku', 'sku':'红/色'}]
    try:
        service.start_urls(entries, tmp_path/'out', 'protected', 'source-1')
        entries[0]['title'] = 'mutated'
        state = wait(service, lambda s:s['status']=='completed')
        assert state['kind']=='collector' and state['source_task_id']=='source-1'
        assert state['counts']=={'total':3,'unique':1,'downloaded':1,'converted':1,'failed':0,'uploaded':0,'upload_failed':0}
        refs = state['items'][0]['refs']
        assert [r['position'] for r in refs] == [0,1,2]
        assert refs[0]['title']=='示例/商品'
        paths = [Path(r['output_path']) for r in refs]
        assert len(set(paths)) == 3 and all(p.exists() for p in paths)
        assert 'main_001' in paths[0].name and 'detail_002' in paths[1].name and 'sku_001_红_色' in paths[2].name
        assert downloads==[(entry()['url'], cloud.owner)] and len(cloud.sends)==1
        mapping = Path(state['mapping_path'])
        rows = json.loads(mapping.read_text(encoding='utf-8'))['rows']
        assert len(rows)==3 and rows[0]['product_id']=='001' and rows[2]['sku']=='红/色'
        assert rows[0]['output_path'] == str(paths[0])
        assert not list(Path(state['run_dir']).rglob('*.xlsx'))
    finally: service.close(clear_state=True)
    assert mapping.exists()
    assert len(json.loads(mapping.read_text(encoding='utf-8'))['rows'])==3


def test_more_than_twenty_urls_byte_dedup_and_failed_download_retry(tmp_path, monkeypatch):
    import core
    failed = True
    def download(url):
        if '/bad' in url and failed: raise ValueError('bad image')
        return picture('green' if '/bad' in url else 'red'), '.png'
    monkeypatch.setattr(core,'download_image',download,raising=False)
    cloud=Cloud(); cloud.result=picture('blue'); service=QueueService(lambda:cloud,tmp_path/'state')
    entries=[{**entry(f'https://img.pddpic.com/{i}.png'), 'order':i+1} for i in range(21)]
    entries.insert(0,entry('https://img.pddpic.com/bad.png'))
    try:
        service.start_urls(entries,tmp_path/'out','protected','source')
        state=wait(service,lambda s:s['status']=='completed')
        assert state['items'][0]['status']=='failed'
        assert len(cloud.sends)==1
        assert state['counts']=={'total':22,'unique':2,'downloaded':1,'converted':1,'failed':1,'uploaded':0,'upload_failed':0}
        assert state['items'][2]['alias_of']==1
        assert all(i['status']=='completed' for i in state['items'][1:])
        rows=json.loads(Path(state['mapping_path']).read_text(encoding='utf-8'))['rows']
        assert rows[0]['status']=='failed' and rows[0]['reason']=='bad image'
        failed=False; service.action('retry',0)
        state=wait(service,lambda s:s['status']=='completed')
        assert state['counts']['failed']==0 and state['counts']['converted']==2
        assert len(cloud.sends)==2
    finally:service.close()


def test_redo_byte_alias_refreshes_dependents_without_overwrite(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(picture(),'.png'),raising=False)
    cloud=Cloud();cloud.result=picture('blue');service=QueueService(lambda:cloud,tmp_path/'state')
    try:
        service.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','prompt','source')
        state=wait(service,lambda s:s['status']=='completed')
        old=[i['result']['output_path'] for i in state['items']]
        cloud.result=None;service.action('redo',1)
        state=wait(service,lambda s:s['items'][0]['phase']=='pending')
        assert all(i['result'] is None for i in state['items'])
        cloud.result=picture('green');state=wait(service,lambda s:s['status']=='completed')
        assert len(cloud.sends)==2
        assert all(Path(p).exists() for p in old)
        assert all(i['result']['output_path']!=p for i,p in zip(state['items'],old))
    finally:service.close()


def test_pending_report_and_collector_restart_never_automatically_resend(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(picture(),'.png'),raising=False)
    cloud=Cloud();service=QueueService(lambda:cloud,tmp_path/'state')
    service.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','prompt','source')
    state=wait(service,lambda s:s['items'][0]['phase']=='pending');service.close()
    rows=json.loads(Path(state['mapping_path']).read_text(encoding='utf-8'))['rows']
    assert len(rows)==2 and rows[1]['status']=='queued' and rows[1]['output_path'] is None
    other=Cloud();restored=QueueService(lambda:other,tmp_path/'state')
    try:
        assert restored.snapshot()['items'][1]['phase']=='downloading'
        assert restored.snapshot()['items'][1]['status']=='queued'
        restored.action('continue'); assert other.sends==[]
    finally:restored.close()


@pytest.mark.parametrize('url',['http://img.pddpic.com/a.png','https://img.pddpic.com.evil.test/a.png',
    'https://user:pw@img.pddpic.com/a.png','https://127.0.0.1/a.png','https://img.pddpic.com:444/a.png'])
def test_downloader_rejects_unsafe_urls_before_network(url):
    import image_batch
    with pytest.raises(ValueError): image_batch.download_image(url)


class Response(io.BytesIO):
    def __init__(self,data,url,headers=None,status=200):
        super().__init__(data);self.url=url;self.headers=headers or {};self.status=status
    def geturl(self):return self.url


def test_downloader_preserves_query_limits_attempts_and_redirects(monkeypatch):
    import image_batch
    urls=[]
    class Opener:
        def open(self,request,timeout):
            urls.append(request.full_url)
            if len(urls)==1:raise OSError('temporary')
            return Response(picture(),request.full_url)
    monkeypatch.setattr(image_batch,'build_opener',lambda *a:Opener())
    assert image_batch._download_image_transport(entry()['url'])==(picture(),'.png')
    assert urls==[entry()['url'],entry()['url']]
    class Redirect:
        def open(self,request,timeout):
            raise HTTPError(request.full_url,302,'redirect',{'Location':'https://localhost/secret'},None)
    monkeypatch.setattr(image_batch,'build_opener',lambda *a:Redirect())
    with pytest.raises(ValueError,match='HTTPS|域名'):image_batch._download_image_transport(entry()['url'])


def test_downloader_caps_stream_and_validates_real_image(monkeypatch):
    import image_batch
    class Opener:
        def open(self,request,timeout):return Response(b'x'*100,request.full_url)
    monkeypatch.setattr(image_batch,'build_opener',lambda *a:Opener())
    monkeypatch.setattr(image_batch,'MAX_DOWNLOAD_BYTES',32)
    with pytest.raises(ValueError,match='大小'):image_batch._download_image_transport(entry()['url'])
    monkeypatch.setattr(image_batch,'MAX_DOWNLOAD_BYTES',1024)
    with pytest.raises(ValueError,match='图片|圖片'):image_batch._download_image_transport(entry()['url'])


def test_alias_of_later_retried_download_can_redo_without_deadlock(tmp_path,monkeypatch):
    import core
    fail=True
    def download(url):
        if '/a.' in url and fail:raise OSError('offline')
        return picture(),'.png'
    monkeypatch.setattr(core,'download_image',download)
    cloud=Cloud();cloud.result=picture('blue');service=QueueService(lambda:cloud,tmp_path/'state')
    try:
        service.start_urls([entry('https://img.pddpic.com/a.png'),entry('https://img.pddpic.com/b.png')],tmp_path/'out','prompt','source')
        wait(service,lambda s:s['status']=='completed')
        fail=False;service.action('retry',0)
        state=wait(service,lambda s:s['status']=='completed')
        assert state['items'][0]['alias_of']==1 and len(cloud.sends)==1
        service.action('redo',0)
        state=wait(service,lambda s:s['status']=='completed')
        assert len(cloud.sends)==2 and all(i['status']=='completed' for i in state['items'])
    finally:service.close()


def test_alias_save_retry_reuses_canonical_generated_result(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(picture(),'.png'))
    actual=core.save_positions;fail=True
    def save(job,refs,data):
        if refs[0]['position']==1 and fail:raise OSError('folder unavailable')
        return actual(job,refs,data)
    monkeypatch.setattr(core,'save_positions',save)
    cloud=Cloud();cloud.result=picture('blue');service=QueueService(lambda:cloud,tmp_path/'state')
    try:
        service.start_urls([entry(),entry('https://img.pddpic.com/b.png')],tmp_path/'out','prompt','source')
        wait(service,lambda s:s['status']=='paused')
        fail=False;service.action('retry',1)
        state=wait(service,lambda s:s['status']=='completed')
        assert len(cloud.sends)==1 and state['items'][1]['result']['output_path']
    finally:service.close()


def test_downloader_safe_relative_redirect_keeps_parameters_and_stops_after_two_failures(monkeypatch):
    import image_batch
    urls=[]
    class Redirect:
        def open(self,request,timeout):
            urls.append(request.full_url)
            if len(urls)==1:raise HTTPError(request.full_url,302,'moved',{'Location':'/b.png?sig=abc&size=3'},None)
            return Response(picture(),request.full_url)
    monkeypatch.setattr(image_batch,'build_opener',lambda *a:Redirect())
    assert image_batch._download_image_transport(entry()['url'])[0]==picture()
    assert urls==[entry()['url'],'https://img.pddpic.com/b.png?sig=abc&size=3']
    urls.clear()
    class Fail:
        def open(self,request,timeout):urls.append(request.full_url);raise OSError('offline')
    monkeypatch.setattr(image_batch,'build_opener',lambda *a:Fail())
    with pytest.raises(OSError):image_batch._download_image_transport(entry()['url'])
    assert len(urls)==2


def test_collector_save_retry_and_restart_recover_generated_bytes(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda url:(picture(),'.png'))
    actual=core.save_positions
    monkeypatch.setattr(core,'save_positions',lambda *args:(_ for _ in ()).throw(OSError('disk blocked')))
    cloud=Cloud();cloud.result=picture('blue');service=QueueService(lambda:cloud,tmp_path/'state')
    service.start_urls([entry()],tmp_path/'out','prompt','source')
    state=wait(service,lambda s:s['status']=='paused');service.close()
    assert state['items'][0]['phase']=='saving'
    monkeypatch.setattr(core,'save_positions',actual)
    other=Cloud();restored=QueueService(lambda:other,tmp_path/'state')
    try:
        assert restored.snapshot()['items'][0]['phase']=='saving'
        restored.action('retry',0);state=wait(restored,lambda s:s['status']=='completed')
        assert other.sends==[] and Path(state['items'][0]['result']['output_path']).exists()
    finally:restored.close()


def test_collector_restart_can_resume_known_generation_and_preserves_terminal_download_failure(tmp_path,monkeypatch):
    import core
    def download(url):
        if '/bad' in url:raise OSError('offline')
        return picture(),'.png'
    monkeypatch.setattr(core,'download_image',download)
    class Recoverable(Cloud):
        def recovery_state(self):return {'conversation_url':'https://www.doubao.com/chat/12345678','identity':'a'*32}
    cloud=Recoverable();service=QueueService(lambda:cloud,tmp_path/'state')
    service.start_urls([entry('https://img.pddpic.com/bad.png'),entry()],tmp_path/'out','prompt','source')
    wait(service,lambda s:s['items'][1].get('download_recovery'));service.close()
    class Recovered(Cloud):
        def resume_from(self,state):self.recovered=state
    other=Recovered();other.result=picture('blue');restored=QueueService(lambda:other,tmp_path/'state')
    try:
        state=restored.snapshot()
        assert state['items'][0]['status']=='failed' and state['items'][1]['status']=='paused'
        restored.action('continue');state=wait(restored,lambda s:s['status']=='completed')
        assert other.sends==[] and state['counts']['failed']==1 and other.recovered
    finally:restored.close()


def test_stopped_downloader_cannot_submit_and_mapping_preserves_metadata_text(tmp_path,monkeypatch):
    import core
    entered=threading.Event();release=threading.Event()
    def download(url):entered.set();release.wait(2);return picture(),'.png'
    monkeypatch.setattr(core,'download_image',download)
    cloud=Cloud();service=QueueService(lambda:cloud,tmp_path/'state')
    try:
        source={**entry(),'title':'=HYPERLINK("https://bad.invalid")','product_id':'001'}
        service.start_urls([source],tmp_path/'out','prompt','source');assert entered.wait(1)
        service.action('stop');release.set()
        state=service.snapshot()
        assert state['status']=='stopped' and cloud.sends==[]
        rows=json.loads(Path(state['mapping_path']).read_text(encoding='utf-8'))['rows']
        assert rows[0]['title']=='=HYPERLINK("https://bad.invalid")' and rows[0]['product_id']=='001'
    finally:release.set();service.close()


def test_downloader_has_total_attempt_deadline(monkeypatch):
    import image_batch
    clock=[0]
    class Slow(Response):
        def read1(self,size=-1):clock[0]+=20;return super().read1(1)
    class Opener:
        def open(self,request,timeout):return Slow(picture(),request.full_url)
    monkeypatch.setattr(image_batch,'build_opener',lambda *a:Opener())
    monkeypatch.setattr(image_batch,'monotonic',lambda:clock[0],raising=False)
    with pytest.raises(TimeoutError):image_batch._download_image_transport(entry()['url'])
