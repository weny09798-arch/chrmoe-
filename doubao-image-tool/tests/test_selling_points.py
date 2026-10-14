import io
import json
import threading
import time
from pathlib import Path
import pytest
from PIL import Image, ImageOps

def png(size=(180,20), mode='RGBA'):
    out=io.BytesIO();Image.new(mode,size,(30,50,60,90) if mode=='RGBA' else 'red').save(out,'PNG');return out.getvalue()

def test_renderer_preserves_alpha_and_wraps():
    from selling_renderer import decode_original, render
    original=decode_original(png())
    result=Image.open(io.BytesIO(render(original,'傳統商品',['這是很長的說明文字'*6])))
    assert result.crop((0,0,*original.size)).tobytes()==original.tobytes()
    assert result.height>original.height+100

@pytest.mark.parametrize('data',[b'bad',png((159,10)),png((5000,5000))],ids=['invalid','narrow','large'])
def test_invalid_original(data):
    from selling_renderer import decode_original
    with pytest.raises(ValueError):decode_original(data)

def wait(service):
    for _ in range(300):
        if service.snapshot()['status'] not in {'generating','rendering','uploading'}:return service.snapshot()
        time.sleep(.01)
    raise AssertionError('worker did not finish')

class Client:
    def __init__(self):self.calls=0;self.block=None
    def generate(self,*args):
        self.calls+=1
        if self.block:self.block.wait(3)
        return {'headline':'优质商品','points':['包装完整','外观清晰'],'needs_information':'','request_id':'req-1','usage':{'input_tokens':12,'output_tokens':8}}

class Publisher:
    def __init__(self):self.fail=True;self.calls=0
    def publish(self,path):
        self.calls+=1
        if self.fail:raise ValueError('secret raw error')
        return {'url':'https://example.test/result.png'}

def test_independent_service_paid_revision_cache_restart(tmp_path):
    from selling_points import SellingPointService
    client=Client();publisher=Publisher()
    service=SellingPointService(tmp_path,lambda:client,lambda:publisher)
    snap=service.create('../image.png',png(),'商品','事实')
    identifier=snap['id']
    assert client.calls==0
    with pytest.raises(ValueError):service.generate(identifier,False)
    service.generate(identifier,True);snap=wait(service)
    assert snap['headline']=='優質商品' and snap['paid_calls']==1
    with pytest.raises(RuntimeError):service.draft(identifier,'新标题',['点'],0)
    snap=service.draft(identifier,'新标题',['包装完整'],snap['draft_revision'])
    service.render(identifier,snap['draft_revision']);snap=wait(service)
    assert snap['phase']=='upload-failed' and snap['result_available'] and not snap['public_url']
    assert 'secret' not in json.dumps(snap)
    restored=SellingPointService(tmp_path,lambda:client,lambda:publisher)
    assert restored.snapshot()==snap
    publisher.fail=False;restored.retry_upload(identifier);snap=wait(restored)
    assert snap['status']=='completed' and client.calls==1
    edited=restored.draft(identifier,'标题',['描述'],snap['draft_revision'])
    assert not edited['public_url'] and not edited['result_available']

def test_busy_replacement_and_restart_do_not_replay(tmp_path):
    from selling_points import SellingPointService
    client=Client();client.block=threading.Event()
    service=SellingPointService(tmp_path,lambda:client,lambda:Publisher())
    old=service.create('a.png',png(),'商品','')['id'];service.generate(old,True)
    with pytest.raises(RuntimeError):service.generate(old,True)
    reload=SellingPointService(tmp_path,lambda:client,lambda:Publisher())
    assert reload.snapshot()['status']=='paused'
    new=service.create('b.png',png(),'商品','')['id'];client.block.set();time.sleep(.1)
    assert service.snapshot()['id']==new and service.snapshot()['headline']==''
    service.clear(new);assert service.snapshot()=={'id':None,'status':'idle'}

def test_credentials_dpapi(tmp_path):
    from bailian import BailianCredentials
    store=BailianCredentials(tmp_path)
    store.save('sk-test-private-key','workspace-123')
    assert b'sk-test-private-key' not in store.path.read_bytes()
    assert store.load()['api_key']=='sk-test-private-key'
    assert store.status()=={'bailian_configured':True,'workspace_id':'workspace-123'}
    with pytest.raises(ValueError):store.save('sk-secret','evil.example/host')
    store.delete();assert not store.status()['bailian_configured']

def test_client_fixed_request_and_usage():
    from bailian import BailianClient
    calls=[]
    def transport(url,headers,payload):
        calls.append((url,headers,payload))
        return {'id':'safe-id','choices':[{'message':{'content':json.dumps({'headline':'商品','points':['外觀'],'needs_information':''})}}],'usage':{'prompt_tokens':7,'completion_tokens':9}}
    value=BailianClient({'api_key':'key','workspace_id':'abc'},transport).generate(png(),'image/png','商品','事实')
    assert value['usage']=={'input_tokens':7,'output_tokens':9}
    url,headers,payload=calls[0]
    assert url=='https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
    assert payload['model']=='qwen3-vl-plus' and payload['enable_thinking'] is False and payload['max_tokens']==1000
    assert payload['response_format']=={'type':'json_object'}

def test_client_malformed_is_safe():
    from bailian import BailianClient
    with pytest.raises(ValueError) as caught:BailianClient({'api_key':'secret','workspace_id':'abc'},lambda *args: {'raw':'secret'}).generate(png(),'image/png','','')
    assert 'secret' not in str(caught.value)

def test_paired_routes_and_isolation(tmp_path):
    from app import create_app
    client=Client();publisher=Publisher()
    app=create_app(browser_factory=lambda:None,state_dir=tmp_path,token='tool-secret',bailian_factory=lambda:client,oss_factory=lambda:publisher)
    http=app.test_client();extension='a'*32
    headers={'X-Tool-Token':'tool-secret','X-Extension-Id':extension,'Origin':'chrome-extension://'+extension}
    assert http.get('/api/bridge/selling-points/current',headers=headers).status_code==403
    assert http.post('/api/bridge/pair',headers=headers,json={'extension_id':extension}).status_code==200
    caps=http.get('/api/bridge/capabilities',headers=headers).json
    assert caps['selling_point_images'] and caps['bailian_configured'] is False
    assert caps['providers']==['doubao','aliyun']
    preflight=http.options('/api/bridge/selling-points/jobs',headers={'Origin':headers['Origin'],'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Tool-Token,X-Extension-Id,Content-Type'})
    assert preflight.status_code==204 and preflight.headers['Access-Control-Allow-Origin']==headers['Origin']
    before=app.extensions['queue'].snapshot()
    snap=http.post('/api/bridge/selling-points/jobs',headers=headers,data={'image':(io.BytesIO(png()),'../../a.png'),'product_name':'商品','facts':'事实'}).json
    identifier=snap['id'];base='/api/bridge/selling-points/'+identifier
    assert http.get(base+'/images/original?token=tool-secret&extension_id='+extension).status_code==403
    image=http.get(base+'/images/original',headers=headers)
    assert image.status_code==200 and image.content_type=='image/png'
    foreign=dict(headers,Origin='https://evil.test')
    assert http.get(base+'/images/original',headers=foreign).status_code==403
    assert http.post(base+'/generate',headers=headers,json={'paid_confirmed':True,'extra':1}).status_code==400
    assert http.post(base+'/generate',headers=headers,json={'paid_confirmed':True}).status_code==200
    snap=wait(app.extensions['selling_points'])
    assert http.post(base+'/render',headers=headers,json={'draft_revision':0}).status_code==409
    http.post(base+'/render',headers=headers,json={'draft_revision':snap['draft_revision']});snap=wait(app.extensions['selling_points'])
    assert snap['result_available'] and app.extensions['queue'].snapshot()==before
    result=http.get(base+'/images/result',headers=headers)
    assert result.status_code==200 and 'filename=' in result.headers['Content-Disposition']
    assert str(tmp_path) not in json.dumps(snap)
    assert http.post('/api/bridge/settings/bailian',headers=headers,json={'api_key':'supplied-secret','workspace_id':'evil.example'}).status_code==400
    assert 'supplied-secret' not in http.post('/api/bridge/settings/bailian',headers=headers,json={'api_key':'supplied-secret','workspace_id':'evil.example'}).text
    app.extensions['queue'].close();app.extensions['selling_points'].close()

def test_timeout_and_explicit_repeat_no_auto_retry(tmp_path):
    from selling_points import SellingPointService
    from bailian import BailianError
    class TimeoutClient:
        calls=0
        def generate(self,*args):self.calls+=1;raise BailianError('request-uncertain','bad\nsecret')
    client=TimeoutClient();service=SellingPointService(tmp_path,lambda:client,lambda:Publisher())
    identifier=service.create('a.png',png(),'商品','')['id']
    service.generate(identifier,True);snap=wait(service)
    assert snap['status']=='paused' and snap['phase']=='request-uncertain' and snap['request_id']==''
    time.sleep(.05);assert client.calls==1
    service.generate(identifier,True);assert wait(service)['paid_calls']==2 and client.calls==2

def test_jpeg_exif_webp_animation_and_font_coverage():
    from selling_renderer import decode_original, FONT_PATH
    from PIL import ImageFont
    image=Image.new('RGB',(20,180),'red');exif=Image.Exif();exif[274]=6
    out=io.BytesIO();image.save(out,'JPEG',exif=exif)
    decoded=decode_original(out.getvalue())
    assert decoded.size==(180,20)
    out=io.BytesIO();Image.new('RGB',(180,12),'red').save(out,'WEBP')
    assert decode_original(out.getvalue()).size==(180,12)
    out=io.BytesIO();frames=[Image.new('RGBA',(180,12),color) for color in ['red','blue']]
    frames[0].save(out,'PNG',save_all=True,append_images=frames[1:])
    with pytest.raises(ValueError):decode_original(out.getvalue())
    font=ImageFont.truetype(str(FONT_PATH),24)
    missing=bytes(font.getmask('\U0010ffff'))
    for char in '繁體賣點商品包裝優質齒龜臺':assert bytes(font.getmask(char))!=missing

def test_render_limit_is_clear_and_keeps_original(tmp_path):
    from selling_renderer import render
    with pytest.raises(ValueError,match='OSS'):render(Image.new('RGBA',(16000,999)),'標題',['說明'])

def test_request_transport_has_no_retry_or_redirect(monkeypatch):
    import bailian
    import requests
    seen={}
    class Session:
        trust_env=True
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def mount(self,prefix,adapter):seen['retry']=adapter.max_retries.total
        def post(self,url,**kwargs):
            seen.update(kwargs);seen['trust_env']=self.trust_env
            return type('Response',(),{'status_code':200,'content':b'{}','json':lambda self:{}})()
    monkeypatch.setattr(requests,'Session',Session)
    assert bailian.transport('https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',{}, {})=={}
    assert seen['retry']==0 and seen['allow_redirects'] is False and seen['timeout']==(5,60) and seen['trust_env'] is False

def test_model_needs_info_and_malformed_pause(tmp_path):
    from selling_points import SellingPointService
    class Info:
        def generate(self,*args):return {'headline':'','points':[],'needs_information':'请补充材质'}
    service=SellingPointService(tmp_path,lambda:Info(),lambda:Publisher())
    identifier=service.create('a.png',png(),'商品','')['id'];service.generate(identifier,True)
    snap=wait(service);assert snap['phase']=='needs-information' and '請' in snap['message']
    with pytest.raises(ValueError):service.render(identifier,snap['draft_revision'])
    class Broken:
        def generate(self,*args):return {'headline':'secret','points':None}
    service.bailian_factory=lambda:Broken();service.generate(identifier,True)
    assert wait(service)['status']=='paused' and 'secret' not in json.dumps(service.snapshot())

def test_clear_defers_busy_cleanup_and_never_deletes_collector(tmp_path):
    from selling_points import SellingPointService
    client=Client();client.block=threading.Event();service=SellingPointService(tmp_path,lambda:client,lambda:Publisher())
    collector=tmp_path/'state';collector.mkdir();(collector/'job.json').write_text('collector')
    identifier=service.create('a.png',png(),'商品','')['id'];service.generate(identifier,True)
    directory=service.directory(identifier);service.clear(identifier)
    assert directory.exists();client.block.set()
    for _ in range(100):
        if not directory.exists():break
        time.sleep(.01)
    assert not directory.exists() and (collector/'job.json').read_text()=='collector'

def test_static_original_size_and_text_controls(tmp_path):
    from selling_renderer import decode_original, validate_draft
    with pytest.raises(ValueError,match='10MiB'):decode_original(b'x'*(10*1024*1024+1))
    for headline,points in [('标题\n注入',['卖点']),('x'*41,['a']),('标题',['x'*61]),('标题',[])]:
        with pytest.raises(ValueError):validate_draft(headline,points)

def test_current_record_symlink_refuses_overwrite(tmp_path):
    from selling_points import SellingPointService
    service=SellingPointService(tmp_path,lambda:Client(),lambda:Publisher())
    outside=tmp_path/'outside';outside.write_text('keep')
    try:(service.root/'current.json.tmp').symlink_to(outside)
    except OSError:pytest.skip('Windows symlink creation unavailable')
    with pytest.raises(ValueError):service.create('a.png',png(),'商品','')
    assert outside.read_text()=='keep'

def test_atomic_rejects_link_targets_even_without_windows_symlink_permission(tmp_path,monkeypatch):
    from selling_points import atomic
    original=Path.is_symlink
    monkeypatch.setattr(Path,'is_symlink',lambda self:self.name=='current.json.tmp' or original(self))
    with pytest.raises(ValueError):atomic(tmp_path/'current.json',b'content')
    assert not (tmp_path/'current.json').exists()

def test_private_root_rejects_junction(tmp_path,monkeypatch):
    from selling_points import SellingPointService
    original=Path.is_junction
    monkeypatch.setattr(Path,'is_junction',lambda self:self.name=='selling-points' or original(self))
    with pytest.raises(ValueError):SellingPointService(tmp_path,lambda:Client(),lambda:Publisher())

def test_render_failure_reports_actionable_limit(tmp_path):
    from selling_points import SellingPointService
    service=SellingPointService(tmp_path,lambda:Client(),lambda:Publisher())
    identifier=service.create('a.png',png((16000,999)),'商品','')['id']
    snap=service.draft(identifier,'商品',['外觀'],0)
    service.render(identifier,snap['draft_revision']);snap=wait(service)
    assert snap['status']=='paused' and '1600 萬' in snap['message'] and snap['phase']=='render-failed'

def test_private_windows_cache_dacl(tmp_path):
    import ctypes
    import os
    if os.name!='nt':pytest.skip('Windows only')
    from selling_points import SellingPointService
    advapi=ctypes.WinDLL('advapi32',use_last_error=True)
    root=tmp_path/'selling-points';root.mkdir()
    descriptor=ctypes.c_void_p()
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p]
    advapi.SetFileSecurityW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.c_void_p]
    assert advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW('D:P(A;OICI;FA;;;WD)',1,ctypes.byref(descriptor),None)
    try:assert advapi.SetFileSecurityW(str(root),0x80000004,descriptor)
    finally:
        kernel=ctypes.WinDLL('kernel32');kernel.LocalFree.argtypes=[ctypes.c_void_p];kernel.LocalFree(descriptor)
    service=SellingPointService(tmp_path,lambda:Client(),lambda:Publisher())
    advapi.GetFileSecurityW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong)]
    needed=ctypes.c_ulong();advapi.GetFileSecurityW(str(service.root),4,None,0,ctypes.byref(needed))
    buffer=ctypes.create_string_buffer(needed.value)
    assert advapi.GetFileSecurityW(str(service.root),4,buffer,len(buffer),ctypes.byref(needed))
    output=ctypes.c_wchar_p()
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.POINTER(ctypes.c_wchar_p),ctypes.c_void_p]
    assert advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer,1,4,ctypes.byref(output),None)
    try:
        value=output.value
        assert value.startswith('D:P') and ';;;OW)' in value and ';;;SY)' in value and ';;;BU)' not in value
    finally:
        kernel=ctypes.WinDLL('kernel32');kernel.LocalFree.argtypes=[ctypes.c_void_p];kernel.LocalFree(ctypes.cast(output,ctypes.c_void_p))

@pytest.mark.parametrize('status,code,part',[(401,'invalid-key','API Key'),(403,'permission-denied','權限'),(429,'rate-limit','稍後'),(503,'service-unavailable','稍後')])
def test_http_errors_are_actionable_and_ids_do_not_echo_keys(monkeypatch,status,code,part):
    import requests
    from bailian import transport,BailianError
    class Session:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def mount(self,*args):pass
        def post(self,*args,**kwargs):return type('Response',(),{'status_code':status,'headers':{'x-request-id':'prefix-sk-private'},'content':b'{"code":"sk-private"}','json':lambda self:{'code':'sk-private'}})()
    monkeypatch.setattr(requests,'Session',Session)
    with pytest.raises(BailianError) as caught:transport('https://example.test',{'Authorization':'Bearer sk-private'}, {})
    assert caught.value.code==code and part in str(caught.value) and caught.value.request_id=='' and 'sk-private' not in str(caught.value)

def test_success_request_id_cannot_echo_key():
    from bailian import BailianClient
    value=BailianClient({'api_key':'sk-private','workspace_id':'abc'},lambda *args:{'id':'prefix-sk-private','choices':[{'message':{'content':json.dumps({'headline':'商品','points':['外觀'],'needs_information':''})}}]}).generate(png(),'image/png','','')
    assert value['request_id']==''

@pytest.mark.parametrize('name,facts',[('', ''),('x'*101,''),('商品','x'*2001)])
def test_product_input_matches_frontend_limits(tmp_path,name,facts):
    from selling_points import SellingPointService
    service=SellingPointService(tmp_path,lambda:Client(),lambda:Publisher())
    with pytest.raises(ValueError):service.create('a.png',png(),name,facts)
