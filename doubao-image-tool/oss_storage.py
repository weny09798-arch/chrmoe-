"""User-encrypted OSS configuration and immutable, verified public image publishing."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from PIL import Image
from credentials import _crypt
from storage import validate_inputs

PREFIX='converted-images/'
CONFIG_KEYS={'bucket','region','credential_mode','access_key_id','access_key_secret'}

class OSSError(ValueError):
    def __init__(self,kind='upload'):
        self.kind=kind
        super().__init__('OSS 配置或权限不可用，请检查 Bucket、地域、密钥和公共访问设置。' if kind=='configuration'
                         else 'OSS 上传或公开图片校验失败；本地结果保留，重试上传不会再次翻译。')

def validate_config(value):
    if not isinstance(value,dict):raise OSSError('configuration')
    result={k:value[k] for k in CONFIG_KEYS if k in value}
    if not isinstance(result.get('bucket'),str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',result['bucket']):raise OSSError('configuration')
    if not isinstance(result.get('region'),str) or not re.fullmatch(r'(?:cn|ap|eu|us|me|sa|af)-[a-z0-9]+(?:-[a-z0-9]+)*',result['region']):raise OSSError('configuration')
    if result.get('credential_mode') not in {'translation','independent'}:raise OSSError('configuration')
    if result['credential_mode']=='independent':
        for key in ('access_key_id','access_key_secret'):
            text=result.get(key)
            if not isinstance(text,str) or not text or len(text)>512 or any(c.isspace() for c in text):raise OSSError('configuration')
    else:
        result.pop('access_key_id',None);result.pop('access_key_secret',None)
    return result

def target_id(config):
    return hashlib.sha256(json.dumps([config['bucket'],config['region'],PREFIX]).encode()).hexdigest()

class OSSConfigStore:
    def __init__(self,root,translation_loader=None):
        self.path=Path(root)/'oss-config.dpapi';self.translation_loader=translation_loader;self.lock=threading.RLock()
    def save(self,value):
        value=validate_config(value)
        if value['credential_mode']=='translation':
            try:self.translation_loader()
            except Exception:raise OSSError('configuration') from None
        with self.lock:
            try:
                encrypted=_crypt(json.dumps(value).encode());self.path.parent.mkdir(parents=True,exist_ok=True)
                pending=self.path.with_suffix('.tmp');pending.write_bytes(encrypted);pending.replace(self.path)
            except Exception:raise OSSError('configuration') from None
    def load(self):
        with self.lock:
            try:
                result=validate_config(json.loads(_crypt(self.path.read_bytes(),True)))
                if result['credential_mode']=='translation':result.update(self.translation_loader())
                return result
            except Exception:raise OSSError('configuration') from None
    def status(self):
        try:
            value=self.load()
            return {'oss_configured':True,'bucket':value['bucket'],'region':value['region'],'credential_mode':value['credential_mode'],'target_id':target_id(value)}
        except OSSError:return {'oss_configured':False}
    def delete(self):
        with self.lock:
            try:self.path.unlink(missing_ok=True);self.path.with_suffix('.tmp').unlink(missing_ok=True)
            except Exception:raise OSSError('configuration') from None

def make_client(config):
    import alibabacloud_oss_v2 as oss
    cfg=oss.config.load_default()
    cfg.region=config['region'];cfg.endpoint=f"https://oss-{config['region']}.aliyuncs.com"
    cfg.credentials_provider=oss.credentials.StaticCredentialsProvider(config['access_key_id'],config['access_key_secret'])
    cfg.retry_max_attempts=1;cfg.connect_timeout=4;cfg.readwrite_timeout=12
    cfg.enabled_redirect=False;cfg.disable_ssl=False;cfg.insecure_skip_verify=False
    return oss.Client(cfg)

def read_public(url):
    from aliyun_translation import _result_transport
    return _result_transport(url,max_bytes=80*1024*1024)[0]

class OSSPublisher:
    def __init__(self,config,client_factory=None,reader=None):
        # Validate the non-secret target separately; reused translation credentials are already resolved.
        validate_config(config)
        self.config=dict(config);self.target_id=target_id(config)
        self.client_factory=client_factory or make_client;self.reader=reader or read_public
        self.injected=client_factory is not None or reader is not None
    def publish(self,path):
        if self.injected:return self._publish(path)
        from image_batch import _download_launcher
        try:
            run=subprocess.run(_download_launcher()+['--oss-publish'],input=json.dumps({'config':self.config,'path':str(path)}),capture_output=True,text=True,encoding='utf-8',timeout=65,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            value=json.loads(run.stdout)
            if run.returncode or 'error' in value:raise OSSError(value.get('error','upload'))
            if not self._valid_result(value):raise OSSError()
            return value
        except OSSError:raise
        except Exception:raise OSSError() from None
    def _valid_result(self,value):
        digest=value.get('sha256','')
        key=value.get('object_key','')
        return isinstance(digest,str) and bool(re.fullmatch('[a-f0-9]{64}',digest)) and key in [PREFIX+digest+ext for ext in ('.png','.jpg','.webp')] and value.get('url')==self.url(key)
    def url(self,key):return f"https://{self.config['bucket']}.oss-{self.config['region']}.aliyuncs.com/{key}"
    def _publish(self,path):
        import alibabacloud_oss_v2 as oss
        try:
            path=Path(path)
            if path.stat().st_size>80*1024*1024:raise OSSError()
            data=path.read_bytes()
            with Image.open(io.BytesIO(data)) as image:extension={'PNG':'.png','JPEG':'.jpg','WEBP':'.webp'}.get(image.format)
            if not extension:raise OSSError()
            validate_inputs([('image'+extension,data)])
            digest=hashlib.sha256(data).hexdigest();key=PREFIX+digest+extension;url=self.url(key)
            def verified():
                try:return hashlib.sha256(self.reader(url)).hexdigest()==digest
                except Exception:return False
            if verified():return {'url':url,'object_key':key,'sha256':digest}
            client=self.client_factory(self.config)
            try:
                client.put_object(oss.PutObjectRequest(bucket=self.config['bucket'],key=key,body=data,
                    acl='public-read',forbid_overwrite=True,content_type={'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[extension],
                    cache_control='public, max-age=31536000, immutable'))
            except Exception as exc:
                if verified():return {'url':url,'object_key':key,'sha256':digest}
                from alibabacloud_oss_v2.exceptions import OperationError
                for _ in range(4):
                    if not isinstance(exc,OperationError):break
                    exc=exc.unwrap()
                code=getattr(exc,'code','')
                if code in {'AccessDenied','InvalidAccessKeyId','SignatureDoesNotMatch','NoSuchBucket','InvalidBucketName','PermanentRedirect','PublicAccessBlockEnabled','InvalidArgument'}:raise OSSError('configuration') from None
                raise OSSError() from None
            if not verified():raise OSSError()
            return {'url':url,'object_key':key,'sha256':digest}
        except OSSError:raise
        except Exception:raise OSSError() from None
    def check(self):
        import tempfile
        stream=io.BytesIO();Image.new('RGB',(16,16),'white').save(stream,'PNG')
        with tempfile.TemporaryDirectory(prefix='oss-check-') as root:
            path=Path(root)/'check.png';path.write_bytes(stream.getvalue());self.publish(path)
        return {'ok':True,'message':'OSS 上传与匿名图片读取正常。测试图片保留在专用前缀，可能产生少量请求费用。'}

def oss_helper_main():
    try:
        payload=json.loads(sys.stdin.read());p=OSSPublisher(payload['config'])
        print(json.dumps(p._publish(payload['path'])));return 0
    except Exception as exc:
        print(json.dumps({'error':exc.kind if isinstance(exc,OSSError) else 'upload'}));return 1
