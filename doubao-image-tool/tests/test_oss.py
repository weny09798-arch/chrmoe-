import hashlib
import io
from pathlib import Path
from types import SimpleNamespace
import pytest
from PIL import Image

CONFIG = dict(bucket='collector-images-test',region='cn-hangzhou',credential_mode='independent',access_key_id='test-id',access_key_secret='SECRET')

def picture():
    stream=io.BytesIO(); Image.new('RGB',(32,32),'red').save(stream,'PNG');return stream.getvalue()

def test_oss_configuration_encrypted_and_secret_not_in_status(tmp_path):
    from oss_storage import OSSConfigStore
    store=OSSConfigStore(tmp_path)
    store.save(CONFIG)
    assert store.load()==CONFIG
    assert b'SECRET' not in store.path.read_bytes()
    status=store.status()
    assert status['oss_configured'] and status['bucket']==CONFIG['bucket']
    assert 'SECRET' not in str(status) and 'access_key_id' not in status
    store.delete();assert not store.status()['oss_configured']

def test_oss_reuses_translation_credentials_only_when_selected(tmp_path):
    from oss_storage import OSSConfigStore
    calls=[]
    def load():calls.append(1);return dict(access_key_id='translate-id',access_key_secret='translate-secret')
    store=OSSConfigStore(tmp_path,load)
    store.save(dict(bucket='collector-images-test',region='cn-hangzhou',credential_mode='translation'))
    assert store.load()['access_key_id']=='translate-id' and calls
    assert b'translate-secret' not in store.path.read_bytes()

@pytest.mark.parametrize('value',[dict(CONFIG,bucket='../bad'),dict(CONFIG,region='localhost'),dict(CONFIG,credential_mode='auto'),dict(CONFIG,access_key_secret='')])
def test_invalid_oss_configuration_rejected(tmp_path,value):
    from oss_storage import OSSConfigStore,OSSError
    with pytest.raises(OSSError):OSSConfigStore(tmp_path).save(value)

class Client:
    def __init__(self):self.objects={};self.puts=[];self.uncertain=False
    def put_object(self,r):
        self.puts.append(r);self.objects[r.key]=r.body
        if self.uncertain:raise TimeoutError('SECRET https://bad')
        return SimpleNamespace(status_code=200)

def test_publish_uses_sdk_v2_public_object_nonoverwrite_and_checks_content(tmp_path):
    from oss_storage import OSSPublisher
    data=picture();path=tmp_path/'中文.png';path.write_bytes(data);c=Client();reads=[]
    def read(url):reads.append(url);return c.objects[url.split('.com/',1)[1]]
    publisher=OSSPublisher(CONFIG,client_factory=lambda cfg:c,reader=read)
    result=publisher.publish(path);again=publisher.publish(path)
    assert result==again and len(c.puts)==1
    request=c.puts[0]
    assert request.acl=='public-read' and request.forbid_overwrite is True
    assert request.key==f'converted-images/{hashlib.sha256(data).hexdigest()}.png'
    assert result['url'].startswith('https://collector-images-test.oss-cn-hangzhou.aliyuncs.com/') and '?' not in result['url']
    assert reads

def test_timed_out_upload_recovers_existing_object_without_second_put(tmp_path):
    from oss_storage import OSSPublisher
    data=picture();path=tmp_path/'a.png';path.write_bytes(data);c=Client();c.uncertain=True
    def read(url):return c.objects[url.split('.com/',1)[1]]
    p=OSSPublisher(CONFIG,client_factory=lambda cfg:c,reader=read)
    assert p.publish(path)['sha256']==hashlib.sha256(data).hexdigest()
    assert len(c.puts)==1

def test_unreadable_or_wrong_public_bytes_never_publish_link(tmp_path):
    from oss_storage import OSSPublisher,OSSError
    path=tmp_path/'a.png';path.write_bytes(picture());c=Client()
    with pytest.raises(OSSError) as caught:OSSPublisher(CONFIG,client_factory=lambda cfg:c,reader=lambda url:b'wrong').publish(path)
    assert 'SECRET' not in str(caught.value)

def test_auth_error_is_configuration_failure_with_sanitized_message(tmp_path):
    from oss_storage import OSSPublisher,OSSError
    class Forbidden(Exception):code='AccessDenied'
    class BadClient:
        def put_object(self,r):raise Forbidden('SECRET')
    path=tmp_path/'a.png';path.write_bytes(picture())
    with pytest.raises(OSSError) as e:OSSPublisher(CONFIG,client_factory=lambda cfg:BadClient(),reader=lambda url:(_ for _ in ()).throw(OSError())).publish(path)
    assert e.value.kind=='configuration' and 'SECRET' not in str(e.value)

def test_real_sdk_wrapped_service_error_pauses_for_configuration(tmp_path):
    from oss_storage import OSSPublisher,OSSError
    from alibabacloud_oss_v2.exceptions import OperationError,ServiceError
    class BadClient:
        def put_object(self,r):raise OperationError(name='PutObject',error=ServiceError(code='AccessDenied',message='SECRET',status_code=403,request_id='r',ec='e',timestamp='t',request_target='test'))
    path=tmp_path/'a.png';path.write_bytes(picture())
    with pytest.raises(OSSError) as e:OSSPublisher(CONFIG,client_factory=lambda cfg:BadClient(),reader=lambda url:(_ for _ in ()).throw(OSError())).publish(path)
    assert e.value.kind=='configuration'

def test_oss_verifier_accepts_saved_png_above_source_download_limit(monkeypatch):
    import aliyun_translation as transport
    from oss_storage import read_public
    buf=io.BytesIO();Image.new('RGB',(2500,2500),'red').save(buf,'PNG',compress_level=0)
    data=buf.getvalue();assert len(data)>16*1024*1024
    class Response:
        status=200
        def __init__(self):self.body=io.BytesIO(data)
        def getheader(self,name):return str(len(data)) if name=='Content-Length' else None
        def read1(self,n):return self.body.read(n)
    class Connection:
        def __init__(self,*args):pass
        def request(self,*args,**kwargs):pass
        def getresponse(self):return Response()
        def close(self):pass
    monkeypatch.setattr(transport,'PublicHTTPSConnection',Connection)
    monkeypatch.setattr(transport,'_public_addresses',lambda host:['1.1.1.1'])
    assert read_public('https://bucket.oss-cn-hangzhou.aliyuncs.com/a.png')==data
