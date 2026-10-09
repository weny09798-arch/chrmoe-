from license_fakes import PermittingAuthority
import base64
import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
import pytest
from PIL import Image
from core import QueueService
from app import create_app

def image(size=(32, 32), color='red'):
    out=io.BytesIO(); Image.new('RGB', size, color).save(out,'PNG'); return out.getvalue()

def entries(kinds=('main','detail','sku')):
    return [dict(platform='pdd', product_id=str(n),title='杯子',kind=k,sku='',order=1,url=f'https://img.pddpic.com/{n}.png') for n,k in enumerate(kinds)]

def wait(q, predicate):
    end=time.monotonic()+5
    while time.monotonic()<end:
        s=q.snapshot()
        if predicate(s): return s
        time.sleep(.01)
    raise AssertionError(q.snapshot())

class Translator:
    def __init__(self): self.calls=0
    def translate(self,path):
        self.calls+=1
        return {'request_id':'r','final_image_url':'https://public.example/result.png?sign=private'}

def never_browser(): raise AssertionError('Aliyun must not open Chrome')

def test_dpapi_roundtrip_delete_and_reset_retains_credentials(tmp_path):
    from credentials import CredentialStore
    store=CredentialStore(tmp_path)
    store.save('test-id','secret-value')
    assert store.configured()
    assert store.load()=={'access_key_id':'test-id','access_key_secret':'secret-value'}
    assert b'secret-value' not in store.path.read_bytes()
    from storage import clear_task_state
    state=tmp_path/'state';state.mkdir();clear_task_state(state)
    assert store.configured()
    store.delete();assert not store.configured()

def test_credentials_routes_guard_status_and_no_secret(tmp_path):
    app=create_app(never_browser,tmp_path,token='token', license_authority=PermittingAuthority())
    try:
        with app.test_client() as c:
            assert c.post('/api/aliyun/credentials',json={'access_key_id':'id','access_key_secret':'s'}).status_code==403
            h={'X-Tool-Token':'token'}
            assert c.post('/api/aliyun/credentials',headers={**h,'Origin':'https://evil.test'},json={'access_key_id':'id','access_key_secret':'s'}).status_code==403
            r=c.post('/api/aliyun/credentials',headers=h,json={'access_key_id':'id','access_key_secret':'s'})
            assert r.status_code==200 and r.json=={'aliyun_configured':True,'aliyun_price_per_image':0.06,'oss_configured':False,'image_link_replacement':True}
            assert c.get('/api/aliyun/credentials',headers=h).json==r.json
            assert c.post('/api/reset',headers=h,json={}).status_code==200
            assert c.get('/api/aliyun/credentials',headers=h).json['aliyun_configured']
            assert c.delete('/api/aliyun/credentials',headers=h).json['aliyun_configured'] is False
    finally: app.extensions['queue'].close(clear_state=True)

def test_sdk_parameters_base64_runtime_and_success(tmp_path):
    from aliyun_translation import sdk_translate
    path=tmp_path/'i.png';path.write_bytes(image())
    class Client:
        def __init__(self, config):
            # Official Hangzhou endpoint; the RAM service prefix alimt is not a DNS endpoint.
            assert config.endpoint=='mt.cn-hangzhou.aliyuncs.com'
            assert config.access_key_id=='id' and config.access_key_secret=='secret'
        def translate_image_with_options(self, request, runtime):
            assert request.source_language=='zh' and request.target_language=='zh-tw'
            assert json.loads(request.ext)=={'ignoreEntityRecognize':'false'}
            assert request.image_base_64==base64.b64encode(path.read_bytes()).decode()
            assert runtime.autoretry is False
            assert runtime.connect_timeout+runtime.read_timeout<30000
            return SimpleNamespace(body=SimpleNamespace(code='200',request_id='request',data=SimpleNamespace(final_image_url='https://public.example/r.png')))
    assert sdk_translate({'access_key_id':'id','access_key_secret':'secret'},path,Client, license_authority=PermittingAuthority())=={'request_id':'request','final_image_url':'https://public.example/r.png'}

@pytest.mark.parametrize('size',[(14,32),(32,8193),(15,150),(320,32)])
def test_aliyun_limits_reject_without_cropping(size):
    from aliyun_translation import validate_aliyun_image
    with pytest.raises(ValueError): validate_aliyun_image(image(size),'x.png')

def test_result_urls_reject_private_hosts_and_preserve_signature(monkeypatch):
    from aliyun_translation import validate_result_url
    import socket
    monkeypatch.setattr(socket,'getaddrinfo',lambda host,*a,**kw: [(socket.AF_INET,socket.SOCK_STREAM,6,'',( '127.0.0.1' if host=='local.test' else '8.8.8.8',443))])
    for url in ['http://example.com/x','https://127.0.0.1/x','https://local.test/x','https://user:pass@example.com/x','https://224.0.0.1/x']:
        with pytest.raises(ValueError):validate_result_url(url)
    assert validate_result_url('https://public.example/x?sign=a%2Fb&x=1')=='https://public.example/x?sign=a%2Fb&x=1'

def test_paid_confirmation_and_type_filter(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda u: (_ for _ in ()).throw(ValueError('offline')))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:Translator(), license_authority=PermittingAuthority())
    try:
        for kwargs in [dict(provider='invalid'),dict(image_kinds=[]),dict(image_kinds=['bad']),dict(provider='aliyun')]:
            with pytest.raises(ValueError):q.start_urls(entries(),tmp_path/'out','convert','source',**kwargs)
        q.start_urls(entries(),tmp_path/'out','convert','source',provider='aliyun',image_kinds=['sku'],paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='completed')
        assert s['provider']=='aliyun' and s['image_kinds']==['sku'] and s['counts']['total']==1
        assert s['paid_calls']==0 and s['estimated_cost_upper']==0.06
    finally:q.close()

def test_multi_product_same_bytes_one_paid_call_no_chrome_and_private_result(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(color='blue'),'.png'))
    t=Translator();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='completed')
        assert s['paid_calls']==1 and t.calls==1 and s['counts']['converted']==1
        assert all(Path(i['refs'][0]['output_path']).is_file() for i in s['items'])
        assert 'sign=private' not in json.dumps(s)
        assert 'sign=private' in (tmp_path/'state/job.json').read_text(encoding='utf-8')
    finally:q.close()

def test_stop_preserves_inflight_address_download_only_resume(tmp_path,monkeypatch):
    import core
    started=threading.Event();release=threading.Event()
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(),'.png'))
    class Blocking(Translator):
        def translate(self,path): started.set();release.wait(3);return super().translate(path)
    t=Blocking();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        assert started.wait(2);q.action('stop');release.set()
        wait(q,lambda s:s['items'][0]['phase']=='aliyun-downloading')
        assert q.snapshot()['status']=='stopped'
        q.action('continue');s=wait(q,lambda s:s['status']=='completed')
        assert t.calls==1 and s['paid_calls']==1
    finally:release.set();q.close()

@pytest.mark.parametrize('kind,want',[('image','completed'),('auth','paused'),('uncertain','paused')])
def test_cloud_error_policy_redacted_and_continue_never_resubmits_uncertain(tmp_path,monkeypatch,kind,want):
    from aliyun_translation import AliyunError
    import core
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    class Error(Translator):
        def translate(self,path):self.calls+=1;raise AliyunError(kind)
    t=Error();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']==want)
        if kind=='uncertain':
            q.action('continue');time.sleep(.04);assert t.calls==1
            with pytest.raises(ValueError):q.action('redo',0)
        assert s['paid_calls']==1
    finally:q.close()

def test_download_failure_restart_retry_preserves_cloud_result(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(_ for _ in ()).throw(TimeoutError('offline')))
    t=Translator();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
    wait(q,lambda s:s['status']=='paused');q.close()
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(),'.png'))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        assert q.snapshot()['items'][0]['phase']=='aliyun-downloading'
        q.action('retry',0);wait(q,lambda s:s['status']=='completed');assert t.calls==1
    finally:q.close()

def test_paired_capabilities_get_cors_and_configured_gate(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda u:(_ for _ in ()).throw(ValueError('offline')))
    app=create_app(never_browser,tmp_path/'private',token='token', license_authority=PermittingAuthority())
    ext='a'*32;h={'X-Tool-Token':'token','X-Extension-Id':ext,'Origin':f'chrome-extension://{ext}'}
    try:
        with app.test_client() as c:
            assert c.get('/api/bridge/capabilities',headers=h).status_code==403
            assert c.post('/api/bridge/pair',headers=h,json={'extension_id':ext}).status_code==200
            assert c.options('/api/bridge/capabilities',headers={'Origin':h['Origin'],'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-tool-token,x-extension-id'}).status_code==204
            assert c.get('/api/bridge/capabilities',headers=h).json=={'licensing':True,'version':'1.7.0','cloud_image_storage':True,'image_type_limits':True,'providers':['doubao','aliyun'],'image_kinds':['main','detail','sku'],'aliyun_configured':False,'aliyun_price_per_image':0.06,'oss_configured':False,'image_link_replacement':True}
            job={'entries':entries(),'output_dir':str(tmp_path/'out'),'source_task_id':'source','provider':'aliyun','image_kinds':['detail'],'paid_confirmed':True}
            r=c.post('/api/bridge/jobs',headers=h,json=job)
            assert r.status_code==400 and app.extensions['queue'].snapshot()['id'] is None
            assert c.post('/api/aliyun/credentials',headers={'X-Tool-Token':'token'},json={'access_key_id':'id','access_key_secret':'secret'}).status_code==200
            assert c.get('/api/bridge/capabilities',headers=h).json['aliyun_configured']
            assert c.post('/api/bridge/jobs',headers=h,json={**job,'paid_confirmed':'true'}).status_code==400
            assert c.post('/api/bridge/jobs',headers=h,json=job).status_code==400
            assert app.extensions['queue'].snapshot()['id'] is None
            assert c.post('/api/oss/config',headers={'X-Tool-Token':'token'},json={
                'bucket':'collector-test','region':'cn-hangzhou','credential_mode':'translation'}).status_code==200
            assert c.get('/api/bridge/capabilities',headers=h).json['oss_configured']
            s=c.post('/api/bridge/jobs',headers=h,json=job).json
            assert s['provider']=='aliyun' and s['counts']['total']==1
    finally:app.extensions['queue'].close(clear_state=True)

def test_uncertain_retry_rejected_redo_requires_confirmation_and_reuses_new_aliases(tmp_path,monkeypatch):
    import core
    from aliyun_translation import AliyunError
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(color='blue'),'.png'))
    class Once(Translator):
        def translate(self,path):
            if not self.calls:self.calls+=1;raise AliyunError()
            return super().translate(path)
    t=Once();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        wait(q,lambda s:s['status']=='paused')
        with pytest.raises(ValueError):q.action('retry',0)
        q.action('redo',0,paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='completed');assert s['paid_calls']==2 and t.calls==2
        first=s['items'][0]['result']['output_path']
        q.action('redo',2,paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='completed');assert s['paid_calls']==3 and t.calls==3
        assert s['items'][0]['result']['output_path']!=first
        for item in s['items']:
            with Image.open(item['refs'][0]['output_path']) as im:assert im.getpixel((0,0))==(0,0,255)
    finally:q.close()

def test_oversized_image_fails_before_paid_call_and_next_image_continues(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_image',lambda u:(image((14,32) if '/0.' in u else (32,32)),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(),'.png'))
    t=Translator();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main','detail')),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='completed')
        assert s['items'][0]['status']=='failed' and s['items'][1]['status']=='completed'
        assert s['paid_calls']==1
    finally:q.close()

def test_local_upload_aliyun_requires_confirmation_and_supports_no_chrome(tmp_path,monkeypatch):
    import core
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(),'.png'))
    t=Translator();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        with pytest.raises(ValueError):q.start([('x.png',image())],tmp_path/'out','convert',provider='aliyun')
        q.start([('x.png',image())],tmp_path/'out','convert',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='completed');assert s['paid_calls']==1 and t.calls==1
    finally:q.close()

@pytest.mark.parametrize('code,status,kind',[
    ('Parameter.ImageSizeError',406,'image'),('ImageTranslate.TextTranslationError',500,'uncertain'),
    ('InvalidAccessKeyId.NotFound',401,'auth'),('Throttling.User',429,'rate'),
    ('10010',400,'service'),('10013',400,'quota'),('unknown secret-url',500,'uncertain')])
def test_sdk_error_whitelist_never_returns_response_message(tmp_path,code,status,kind):
    from aliyun_translation import sdk_translate,AliyunError
    p=tmp_path/'i.png';p.write_bytes(image())
    class Client:
        def __init__(self,c):pass
        def translate_image_with_options(self,*args):
            exc=RuntimeError('SECRET https://signed.example/input?secret=1');exc.code=code;exc.status_code=status;raise exc
    with pytest.raises(AliyunError) as info:sdk_translate({'access_key_id':'id','access_key_secret':'SECRET'},p,Client, license_authority=PermittingAuthority())
    assert info.value.kind==kind and 'SECRET' not in str(info.value) and 'signed.example' not in str(info.value)

@pytest.mark.parametrize('code,want',[('System.subNotPermission','auth'),('System.AccountNotActivated','service')])
def test_official_image_account_errors_pause(code,want):
    from aliyun_translation import classify_error
    assert classify_error(code)==want

def test_deleted_credentials_pause_without_marking_image_failed(tmp_path,monkeypatch):
    from credentials import CredentialError
    import core
    entered=threading.Event();release=threading.Event()
    def download(u):entered.set();release.wait(3);return image(),'.png'
    monkeypatch.setattr(core,'download_image',download)
    available=[True]
    def factory():
        if not available[0]:raise CredentialError('not configured')
        return Translator()
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=factory, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        assert entered.wait(2);available[0]=False;release.set()
        s=wait(q,lambda s:s['status'] in {'completed','paused'})
        assert s['status']=='paused' and s['paid_calls']==0 and s['items'][0]['phase']=='aliyun-ready'
    finally:release.set();q.close()

def test_cloud_auth_return_during_stop_does_not_resume_job(tmp_path,monkeypatch):
    from aliyun_translation import AliyunError
    import core
    entered=threading.Event();release=threading.Event()
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    class Blocking(Translator):
        def translate(self,path):entered.set();release.wait(3);raise AliyunError('auth')
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:Blocking(), license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        assert entered.wait(2);q.action('stop');release.set()
        wait(q,lambda s:s['items'][0]['phase']=='aliyun-ready')
        assert q.snapshot()['status']=='stopped'
    finally:release.set();q.close()

def test_paid_and_download_helpers_source_frozen_use_stdin_and_hard_bounds(tmp_path,monkeypatch):
    import aliyun_translation as a
    import subprocess,sys,os
    observed=[];p=tmp_path/'input.png';p.write_bytes(image())
    def execute(argv,**kw):
        observed.append((argv,kw));payload=json.loads(kw['input'])
        if argv[-1]=='--aliyun-translate':value={'request_id':'r','final_image_url':'https://public.example/x?secret=signature'}
        else:Path(payload['output_path']).write_bytes(image());value={'extension':'.png'}
        return subprocess.CompletedProcess(argv,0,json.dumps(value),'')
    monkeypatch.setattr(subprocess,'run',execute)
    for frozen in (False,True):
        monkeypatch.setattr(sys,'frozen',frozen,raising=False)
        r=a.AliyunTranslator({'access_key_id':'id','access_key_secret':'SECRET'}, profile_root=tmp_path).translate(p)
        assert a.download_aliyun_result(r['final_image_url'])[1]=='.png'
    assert observed[0][0][-2].endswith('run.py') and observed[2][0]==[sys.executable,'--aliyun-translate']
    for argv,kw in observed:
        assert kw['timeout']<=48 and 'SECRET' not in ' '.join(argv) and 'signature' not in ' '.join(argv)
        assert kw['creationflags']==(subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)

@pytest.mark.parametrize('helper',['--aliyun-translate','--aliyun-result'])
def test_hidden_helpers_redact_errors_and_never_create_state(tmp_path,helper):
    import subprocess,sys
    from aliyun_translation import __file__ as module
    r=subprocess.run([sys.executable,str(Path(module).with_name('run.py')),helper,'--state-dir',str(tmp_path/'state')],input=json.dumps({'credentials':{'access_key_secret':'SECRET'},'input_path':'missing','url':'http://localhost/?secret=1','output_path':str(tmp_path/'result')}),capture_output=True,text=True,timeout=5)
    assert r.returncode==1 and set(json.loads(r.stdout))=={'error'}
    assert not r.stderr and 'SECRET' not in r.stdout and 'secret=1' not in r.stdout
    assert not (tmp_path/'state').exists()

def test_public_result_redirect_revalidates_and_preserves_query(monkeypatch):
    import aliyun_translation as a
    observed=[]
    monkeypatch.setattr(a,'_public_addresses',lambda host: (_ for _ in ()).throw(ValueError('private')) if host=='private.test' else ['8.8.8.8'])
    class Response:
        status=302
        def getheader(self,k):return 'https://private.test/result?sign=private'
    class Connection:
        def __init__(self,host,addr):observed.append(host)
        def request(self,method,path,headers):assert path=='/x?sign=a%2Fb&x=1'
        def getresponse(self):return Response()
        def close(self):pass
    monkeypatch.setattr(a,'PublicHTTPSConnection',Connection)
    with pytest.raises(ValueError):a._result_transport('https://public.example/x?sign=a%2Fb&x=1')
    assert observed==['public.example']

def test_stop_before_paid_commit_does_not_call_or_charge(tmp_path,monkeypatch):
    import core
    entered=threading.Event();release=threading.Event();calls=[0];t=Translator()
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    def factory():
        calls[0]+=1
        if calls[0]>1:entered.set();release.wait(3)
        return t
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=factory, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        assert entered.wait(2);q.action('stop');release.set();time.sleep(.04)
        assert q.snapshot()['paid_calls']==0 and t.calls==0
    finally:release.set();q.close()

def test_clear_during_paid_request_cannot_write_result_to_replacement(tmp_path,monkeypatch):
    import core
    entered=threading.Event();release=threading.Event();downloads=[]
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:downloads.append(u) or (image(),'.png'))
    class Blocking(Translator):
        def translate(self,path):entered.set();release.wait(3);return super().translate(path)
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:Blocking(), license_authority=PermittingAuthority())
    q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
    assert entered.wait(2)
    q.request_close(clear_state=True);release.set();q.close(clear_state=True)
    assert not downloads and q.snapshot()['id'] is None and not list((tmp_path/'state').iterdir())
    other=QueueService(never_browser,tmp_path/'state', license_authority=PermittingAuthority())
    try:assert other.snapshot()['id'] is None
    finally:other.close(clear_state=True)

def test_real_paid_helper_timeout_is_uncertain_and_close_clears_under_bound(tmp_path,monkeypatch):
    import core,aliyun_translation as a,sys
    module_root=Path(a.__file__).parent
    marker=tmp_path/'entered';harness=tmp_path/'helper.py'
    harness.write_text(f"import sys,time\nfrom pathlib import Path\nsys.path.insert(0,{str(module_root)!r})\nimport aliyun_translation as a\ndef delayed(*args,**kwargs):\n Path({str(marker)!r}).write_text('entered')\n time.sleep(5)\na.sdk_translate=delayed\nraise SystemExit(a.translate_helper_main())\n",encoding='utf-8')
    monkeypatch.setattr(a,'_download_launcher',lambda:[sys.executable,str(harness)])
    monkeypatch.setattr(a,'PAID_PROCESS_SECONDS',1.2)
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:a.AliyunTranslator({'access_key_id':'id','access_key_secret':'SECRET'}, profile_root=tmp_path), license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='paused')
        assert marker.exists() and s['items'][0]['phase']=='uncertain' and s['paid_calls']==1
        q.action('continue');assert q.snapshot()['status']=='paused'
        start=time.monotonic();q.close(clear_state=True)
        assert time.monotonic()-start<2.5 and not q.worker.is_alive()
    finally:q.close(clear_state=True)

def test_sdk_tea_status_code_5xx_overrides_single_image_code(tmp_path):
    from aliyun_translation import sdk_translate,AliyunError
    from Tea.exceptions import TeaException
    path=tmp_path/'input.png';path.write_bytes(image())
    class Client:
        def __init__(self,c):pass
        def translate_image_with_options(self,*a):raise TeaException({'code':'Parameter.ImageUrlError','message':'SECRET','data':{'statusCode':500}})
    with pytest.raises(AliyunError) as info:sdk_translate({'access_key_id':'id','access_key_secret':'secret'},path,Client, license_authority=PermittingAuthority())
    assert info.value.kind=='uncertain'

def test_failed_cloud_duplicate_propagates_failure_and_next_unique_continues(tmp_path,monkeypatch):
    import core
    from aliyun_translation import AliyunError
    monkeypatch.setattr(core,'download_image',lambda u:(image(color='blue' if '/2.' in u else 'red'),'.png'))
    monkeypatch.setattr(core,'download_aliyun_result',lambda u:(image(),'.png'))
    class Once(Translator):
        def translate(self,path):
            if not self.calls:self.calls+=1;raise AliyunError('image')
            return super().translate(path)
    t=Once();q=QueueService(never_browser,tmp_path/'state',aliyun_factory=lambda:t, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status'] in {'paused','completed'})
        assert s['status']=='completed' and [i['status'] for i in s['items']]==['failed','failed','completed'] and t.calls==2
        with pytest.raises(ValueError):q.action('retry',0)
        with pytest.raises(ValueError):q.action('retry',1)
    finally:q.close()

def test_aliyun_ten_megabyte_limit_rejected_before_decode():
    from aliyun_translation import validate_aliyun_image
    with pytest.raises(ValueError,match='10MB'):validate_aliyun_image(b'x'*(10*1024*1024+1),'input.png')

def test_legacy_persisted_job_gets_free_defaults(tmp_path):
    state=tmp_path/'state';state.mkdir()
    (state/'job.json').write_text(json.dumps({'id':'legacy','status':'completed','items':[],'message':''}),encoding='utf-8')
    q=QueueService(never_browser,state, license_authority=PermittingAuthority())
    try:
        s=q.snapshot();assert s['provider']=='doubao' and s['image_kinds']==['main','detail','sku'] and s['paid_calls']==0 and s['estimated_cost_upper']==0
    finally:q.close()

RETRYABLE_ACCOUNT_CODES = [
    'InvalidAccessKeyId.NotFound','InvalidAccessKeyId','SignatureDoesNotMatch','Forbidden',
    'Forbidden.RAM','Unauthorized','System.subNotPermission','10009','10011',
    'ServiceNotOpened','ServiceNotActivated','System.AccountNotActivated','10010',
    'InsufficientBalance','QuotaExceeded','Account.Arrearage','10013',
    'Throttling','Throttling.User','Throttling.Api','Throttling.Rate','RequestLimitExceeded',
]

@pytest.mark.parametrize('code',RETRYABLE_ACCOUNT_CODES)
def test_http_500_precedes_all_account_error_codes(code):
    from aliyun_translation import classify_error
    assert classify_error(code,500)=='uncertain'

@pytest.mark.parametrize('code',['System.subNotPermission','System.AccountNotActivated','InsufficientBalance','Throttling.User'])
def test_sdk_http_500_account_codes_cannot_resubmit_on_continue(tmp_path,monkeypatch,code):
    from aliyun_translation import sdk_translate
    from Tea.exceptions import TeaException
    import core
    calls=[]
    class Client:
        def __init__(self,config):pass
        def translate_image_with_options(self,request,runtime):
            calls.append(request)
            raise TeaException({'code':code,'message':'SECRET','data':{'statusCode':500}})
    class Cloud:
        def translate(self,path):return sdk_translate({'access_key_id':'id','access_key_secret':'SECRET'},path,Client, license_authority=PermittingAuthority())
    monkeypatch.setattr(core,'download_image',lambda u:(image(),'.png'))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=Cloud, license_authority=PermittingAuthority())
    try:
        q.start_urls(entries(('main',)),tmp_path/'out','convert','source',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='paused')
        assert s['items'][0]['phase']=='uncertain'
        q.action('continue');time.sleep(.04)
        assert q.snapshot()['status']=='paused' and q.snapshot()['paid_calls']==1 and len(calls)==1
        with pytest.raises(ValueError):q.action('retry',0)
    finally:q.close()
