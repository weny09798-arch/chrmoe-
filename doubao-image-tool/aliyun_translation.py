"""Single paid SDK request and bounded, public HTTPS result download helpers."""
import base64
import http.client
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit,urljoin,urlencode
from urllib.request import Request,build_opener
from PIL import Image
from storage import validate_inputs
from image_batch import MAX_DOWNLOAD_BYTES, _download_launcher, NoRedirect

PAID_PROCESS_SECONDS=24
RESULT_PROCESS_SECONDS=18
PRICE_PER_IMAGE=0.06
FAKE_DNS_NETWORK=ipaddress.ip_network('198.18.0.0/15')
DNS_RESPONSE_LIMIT=64*1024
MESSAGES={
    'image':'阿里云拒绝此图片，已跳过；请检查格式、尺寸或图片内容。',
    'auth':'阿里云鉴权失败，请检查 AccessKey 和权限后继续。',
    'service':'阿里云服务未开通，请开通图片翻译后继续。',
    'quota':'阿里云额度或余额不足，请处理账户后继续。',
    'rate':'阿里云限流，请稍后继续。',
    'uncertain':'阿里云提交结果不确定，可能已计费；继续不会重新提交，重新生成需再次确认付费。',
}
class AliyunError(RuntimeError):
    def __init__(self,kind='uncertain'):
        self.kind=kind if kind in MESSAGES else 'uncertain'
        super().__init__(MESSAGES[self.kind])

def classify_error(code,status=None):
    code=str(code or '')
    try:status=int(status) if status is not None else None
    except (TypeError,ValueError):status=None
    # An HTTP server failure cannot prove that the paid operation was rejected.
    if status is not None and status>=500:return 'uncertain'
    if code in {'InvalidAccessKeyId.NotFound','InvalidAccessKeyId','SignatureDoesNotMatch','Forbidden','Forbidden.RAM','Unauthorized','System.subNotPermission','10009','10011'}:return 'auth'
    if code in {'ServiceNotOpened','ServiceNotActivated','System.AccountNotActivated','10010'}:return 'service'
    if code in {'InsufficientBalance','QuotaExceeded','Account.Arrearage','10013'}:return 'quota'
    if code in {'Throttling','Throttling.User','Throttling.Api','Throttling.Rate','RequestLimitExceeded'} or status==429:return 'rate'
    if code in {'Parameter.ImageSizeError','Parameter.ImageFileSizeError','Parameter.ImageRatioError','Parameter.ImageTypeError','Parameter.ImageFormatError','Parameter.ImageUrlError','InvalidParameter','InvalidParameter.Image','ImageTranslate.ImageDownloadError','ImageTranslate.ImageDecodeError','ImageTranslate.NoText','10003','10004','10005','10006','10007','10008'}:return 'image'
    return 'uncertain'

def validate_aliyun_image(data,name):
    if len(data)>10*1024*1024:raise ValueError('阿里云单图不能超过 10MB')
    validate_inputs([(name,data)])
    with Image.open(io.BytesIO(data)) as im:
        if min(im.size)<15 or max(im.size)>8192 or max(im.size)/min(im.size)>=10:
            raise ValueError('阿里云图片双边须为 15–8192 像素，长宽比须小于 10:1')
    return data

def _result_url_parts(url):
    if not isinstance(url,str) or len(url)>16384 or any(c.isspace() for c in url):raise ValueError('结果地址无效')
    try:
        parsed=urlsplit(url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.port not in (None,443) or parsed.fragment:raise ValueError()
    except ValueError:raise ValueError('结果地址必须为公网 HTTPS') from None
    return parsed

def _is_public_address(ip):
    return (ip.is_global and not ip.is_multicast and
        not (ip.version==6 and ip.ipv4_mapped and
             (not ip.ipv4_mapped.is_global or ip.ipv4_mapped.is_multicast)))

def _resolve_fake_dns(host):
    """Verified HTTPS resolver through the system proxy; no redirect or private result."""
    try:
        url='https://dns.alidns.com/resolve?'+urlencode({'name':host,'type':'A'})
        # Default handlers retain the system proxy and HTTPS certificate verification.
        with build_opener(NoRedirect()).open(Request(url,headers={'Accept':'application/dns-json'}),timeout=4) as response:
            if response.getcode()!=200:raise ValueError()
            length=response.getheader('Content-Length')
            if length is not None and not 0<=int(length)<=DNS_RESPONSE_LIMIT:raise ValueError()
            body=response.read(DNS_RESPONSE_LIMIT+1)
            if len(body)>DNS_RESPONSE_LIMIT:raise ValueError()
        value=json.loads(body)
        if not isinstance(value,dict) or type(value.get('Status')) is not int or value['Status']!=0 or not isinstance(value.get('Answer'),list):raise ValueError()
        addresses=[]
        for answer in value['Answer']:
            if not isinstance(answer,dict):raise ValueError()
            if answer.get('type')!=1:continue
            if type(answer.get('type')) is not int or not isinstance(answer.get('data'),str):raise ValueError()
            ip=ipaddress.ip_address(answer['data'])
            if ip.version!=4 or not _is_public_address(ip):raise ValueError()
            addresses.append(str(ip))
        if not addresses:raise ValueError()
        return list(dict.fromkeys(addresses))
    except Exception:
        raise ValueError('结果域名解析失败或没有有效公网地址') from None

def _public_addresses(host):
    try:
        literal=ipaddress.ip_address(host)
    except ValueError:literal=None
    if literal is not None and not _is_public_address(literal):raise ValueError('结果地址不能指向本机或内网')
    addresses=socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)
    resolved=[ipaddress.ip_address(address[4][0]) for address in addresses]
    if literal is None and resolved and all(ip.version==4 and ip in FAKE_DNS_NETWORK for ip in resolved):
        return _resolve_fake_dns(host)
    ips=[]
    for ip in resolved:
        if not _is_public_address(ip):raise ValueError('结果地址不能指向本机或内网')
        ips.append(str(ip))
    if not ips:raise ValueError('结果地址无公网目标')
    return ips

def validate_result_url(url):
    parsed=_result_url_parts(url);_public_addresses(parsed.hostname);return url

def sdk_translate(credentials,path,client_factory=None):
    from alibabacloud_alimt20181012.client import Client
    from alibabacloud_alimt20181012.models import TranslateImageRequest
    from alibabacloud_tea_openapi.models import Config
    from alibabacloud_tea_util.models import RuntimeOptions
    data=validate_aliyun_image(Path(path).read_bytes(),Path(path).name)
    config=Config(access_key_id=credentials['access_key_id'],access_key_secret=credentials['access_key_secret'],endpoint='mt.cn-hangzhou.aliyuncs.com',protocol='https')
    request=TranslateImageRequest(image_base_64=base64.b64encode(data).decode('ascii'),source_language='zh',target_language='zh-tw',field='e-commerce',ext=json.dumps({'ignoreEntityRecognize':'false'}))
    runtime=RuntimeOptions(autoretry=False,connect_timeout=4000,read_timeout=18000)
    try:
        body=(client_factory or Client)(config).translate_image_with_options(request,runtime).body
        if str(body.code)!='200':raise AliyunError(classify_error(body.code))
        url=getattr(getattr(body,'data',None),'final_image_url',None)
        request_id=getattr(body,'request_id',None)
        _result_url_parts(url)
        if not isinstance(request_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',request_id):raise AliyunError()
        return {'request_id':request_id,'final_image_url':url}
    except AliyunError:raise
    except Exception as exc:
        raise AliyunError(classify_error(getattr(exc,'code',None),getattr(exc,'statusCode',getattr(exc,'status_code',None)))) from None

class AliyunTranslator:
    def __init__(self,credentials):self.credentials=dict(credentials)
    def translate(self,path):
        try:
            r=subprocess.run(_download_launcher()+['--aliyun-translate'],input=json.dumps({'credentials':self.credentials,'input_path':str(path)}),capture_output=True,text=True,encoding='utf-8',timeout=PAID_PROCESS_SECONDS,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            value=json.loads(r.stdout)
            if r.returncode or 'error' in value:raise AliyunError(value.get('error'))
            _result_url_parts(value['final_image_url'])
            if not isinstance(value.get('request_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',value['request_id']):raise AliyunError()
            return {'request_id':value['request_id'],'final_image_url':value['final_image_url']}
        except AliyunError:raise
        except Exception:raise AliyunError() from None

def translate_helper_main():
    try:
        payload=json.loads(sys.stdin.read())
        print(json.dumps(sdk_translate(payload['credentials'],payload['input_path'])),flush=True);return 0
    except Exception as exc:
        print(json.dumps({'error':exc.kind if isinstance(exc,AliyunError) else 'uncertain'}),flush=True);return 1

class PublicHTTPSConnection(http.client.HTTPSConnection):
    """Pin vetted DNS address; keep original hostname for TLS and HTTP Host."""
    def __init__(self,host,address):
        super().__init__(host,timeout=4,context=ssl.create_default_context());self.address=address
    def connect(self):
        raw=socket.create_connection((self.address,443),timeout=self.timeout)
        try:self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
        except BaseException:raw.close();raise

def _result_transport(url):
    current=url
    for hop in range(6):
        parsed=_result_url_parts(current);addresses=_public_addresses(parsed.hostname)
        connection=PublicHTTPSConnection(parsed.hostname,addresses[0])
        try:
            # Keep the original escaped query bytes. Never rebuild signed parameters.
            path=parsed.path or '/'
            if parsed.query:path+='?'+parsed.query
            connection.request('GET',path,headers={'Accept':'image/png,image/jpeg,image/webp'})
            response=connection.getresponse()
            if response.status in (301,302,303,307,308):
                location=response.getheader('Location')
                if not location or hop==5:raise ValueError('结果重定向无效')
                current=urljoin(current,location);continue
            if response.status!=200:raise OSError('结果下载失败')
            length=response.getheader('Content-Length')
            if length and int(length)>MAX_DOWNLOAD_BYTES:raise ValueError('结果图片过大')
            chunks=[];size=0
            while True:
                chunk=response.read1(min(65536,MAX_DOWNLOAD_BYTES+1-size))
                if not chunk:break
                size+=len(chunk)
                if size>MAX_DOWNLOAD_BYTES:raise ValueError('结果图片过大')
                chunks.append(chunk)
            data=b''.join(chunks)
            with Image.open(io.BytesIO(data)) as im:extension={'PNG':'.png','JPEG':'.jpg','WEBP':'.webp'}.get(im.format)
            if not extension:raise ValueError('结果格式无效')
            validate_inputs([('result'+extension,data)])
            return data,extension
        finally:connection.close()

def result_helper_main():
    try:
        payload=json.loads(sys.stdin.read());data,extension=_result_transport(payload['url'])
        with Path(payload['output_path']).open('xb') as handle:handle.write(data)
        print(json.dumps({'extension':extension}),flush=True);return 0
    except Exception:
        print(json.dumps({'error':'download'}),flush=True);return 1

def download_aliyun_result(url):
    _result_url_parts(url)
    with tempfile.TemporaryDirectory(prefix='aliyun-result-') as folder:
        output=Path(folder)/'image.bin'
        try:
            result=subprocess.run(_download_launcher()+['--aliyun-result'],input=json.dumps({'url':url,'output_path':str(output)}),capture_output=True,text=True,encoding='utf-8',timeout=RESULT_PROCESS_SECONDS,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            value=json.loads(result.stdout);extension=value.get('extension')
            if result.returncode or extension not in {'.png','.jpg','.webp'} or not output.is_file() or output.stat().st_size>MAX_DOWNLOAD_BYTES:raise ValueError()
            data=output.read_bytes();validate_inputs([('result'+extension,data)]);return data,extension
        except Exception:raise OSError('阿里云结果下载失败，继续获取将复用已有结果；重新生成会再次计费。') from None
