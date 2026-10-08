"""Fake-DNS compatibility keeps the transport bound to validated public addresses."""
import json
import socket
from urllib.parse import parse_qs, urlsplit
from urllib.error import HTTPError
import pytest
import aliyun_translation as a

def system_dns(monkeypatch, addresses):
    monkeypatch.setattr(socket,'getaddrinfo',lambda *args,**kw:[
        (socket.AF_INET6 if ':' in address else socket.AF_INET,socket.SOCK_STREAM,6,'',(address,443))
        for address in addresses])

class Response:
    def __init__(self,body,status=200,length=None):self.body=body;self.status=status;self.length=length;self.reads=[]
    def getcode(self):return self.status
    def getheader(self,name):return self.length if name=='Content-Length' else None
    def read(self,size):self.reads.append(size);return self.body[:size]
    def __enter__(self):return self
    def __exit__(self,*args):pass

def doh_boundary(monkeypatch, response):
    calls=[]
    class Opener:
        def open(self,request,timeout):
            calls.append((request,timeout))
            if isinstance(response,Exception):raise response
            return response
    def build(*handlers):
        from image_batch import NoRedirect
        assert any(isinstance(handler,NoRedirect) for handler in handlers)
        return Opener()
    monkeypatch.setattr(a,'build_opener',build,raising=False)
    return calls

def answer(*addresses):return json.dumps({'Status':0,'Answer':[{'type':1,'data':address} for address in addresses]}).encode()

def test_all_system_fake_ipv4_uses_verified_aliyun_doh_public_answers(monkeypatch):
    system_dns(monkeypatch,['198.18.0.1','198.19.255.254'])
    response=Response(answer('163.181.60.211','163.181.60.212'))
    calls=doh_boundary(monkeypatch,response)
    assert a._public_addresses('cbu01.alicdn.com')==['163.181.60.211','163.181.60.212']
    request,timeout=calls[0];parsed=urlsplit(request.full_url)
    assert parsed.scheme=='https' and parsed.netloc=='dns.alidns.com' and parsed.path=='/resolve'
    assert parse_qs(parsed.query)=={'name':['cbu01.alicdn.com'],'type':['A']}
    assert timeout==4 and response.reads==[65537]

@pytest.mark.parametrize('host,addresses',[
    ('127.0.0.1',['127.0.0.1']),('198.18.0.1',['198.18.0.1']),('8.8.8.8',['198.18.0.1']),
    ('private.test',['10.0.0.1']),('private.test',['192.168.1.1']),('private.test',['::1']),
    ('mixed.test',['198.18.0.1','10.0.0.1']),('mixed.test',['198.18.0.1','8.8.8.8']),
    ('mixed.test',['198.18.0.1','::ffff:198.18.0.1']),('empty.test',[]),
])
def test_literals_private_and_mixed_answers_never_query_doh(monkeypatch,host,addresses):
    system_dns(monkeypatch,addresses);calls=doh_boundary(monkeypatch,Response(answer('8.8.8.8')))
    with pytest.raises(ValueError):a._public_addresses(host)
    assert not calls

def test_normal_public_dns_never_queries_fallback(monkeypatch):
    system_dns(monkeypatch,['163.181.60.211','2606:4700:4700::1111'])
    calls=doh_boundary(monkeypatch,Response(answer('8.8.8.8')))
    assert a._public_addresses('public.test')==['163.181.60.211','2606:4700:4700::1111']
    assert not calls

@pytest.mark.parametrize('body',[
    b'bad-json',b'[]',b'{"Status":3,"Answer":[]}',b'{"Status":false,"Answer":[{"type":1,"data":"8.8.8.8"}]}',
    b'{"Status":0}',b'{"Status":0,"Answer":[]}',b'{"Status":0,"Answer":"8.8.8.8"}',
    answer('127.0.0.1'),answer('10.0.0.1'),answer('198.18.0.1'),answer('224.0.0.1'),
    answer('8.8.8.8','192.168.1.1'),answer('not-ip'),answer('::1'),answer('2606:4700:4700::1111'),
    b'{"Status":0,"Answer":[{"type":1}]}',b'{"Status":0,"Answer":[{"type":5,"data":"cname.example"}]}',
    b'x'*65537,
],ids=[f'case_{i}' for i in range(18)])
def test_fake_dns_doh_rejects_empty_malformed_private_and_oversize_answers(monkeypatch,body):
    system_dns(monkeypatch,['198.18.0.1']);doh_boundary(monkeypatch,Response(body))
    with pytest.raises(ValueError):a._public_addresses('vendor.test')

@pytest.mark.parametrize('response',[
    Response(answer('8.8.8.8'),status=302),
    Response(answer('8.8.8.8'),length='65537'),
    HTTPError('https://dns.alidns.com/resolve',302,'redirect',{},None),
])
def test_doh_redirect_and_oversize_headers_fail_closed(monkeypatch,response):
    system_dns(monkeypatch,['198.18.0.1']);doh_boundary(monkeypatch,response)
    with pytest.raises(ValueError):a._public_addresses('vendor.test')

def test_doh_query_encodes_host_in_one_parameter(monkeypatch):
    calls=doh_boundary(monkeypatch,Response(answer('8.8.8.8')))
    assert a._resolve_fake_dns('vendor.test&other=private')==['8.8.8.8']
    assert parse_qs(urlsplit(calls[0][0].full_url).query)=={'name':['vendor.test&other=private'],'type':['A']}

def test_fake_dns_download_pins_resolved_public_address_and_keeps_tls_host(monkeypatch):
    from test_aliyun import image
    system_dns(monkeypatch,['198.18.0.1']);doh_boundary(monkeypatch,Response(answer('163.181.60.211')))
    connections=[]
    class ImageResponse:
        status=200
        def __init__(self):self.data=image()
        def getheader(self,name):return str(len(self.data)) if name=='Content-Length' else None
        def read1(self,size):data,self.data=self.data[:size],self.data[size:];return data
    class Connection:
        def __init__(self,host,address):connections.append((host,address))
        def request(self,method,path,headers):assert path=='/result?sign=a%2Fb&x=1'
        def getresponse(self):return ImageResponse()
        def close(self):pass
    monkeypatch.setattr(a,'PublicHTTPSConnection',Connection)
    data,extension=a._result_transport('https://vendor.test/result?sign=a%2Fb&x=1')
    assert data==image() and extension=='.png' and connections==[('vendor.test','163.181.60.211')]

def test_doh_cname_and_public_a_records_are_supported(monkeypatch):
    system_dns(monkeypatch,['198.18.0.1'])
    body=json.dumps({'Status':0,'Answer':[{'type':5,'data':'cdn.example'},
        {'type':1,'data':'163.181.60.211'},{'type':1,'data':'163.181.60.211'}]}).encode()
    doh_boundary(monkeypatch,Response(body))
    assert a._public_addresses('vendor.test')==['163.181.60.211']
