"""Real socket regressions for downloads whose peer never becomes idle."""
import json
import http.client
import os
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import image_batch
from core import QueueService
from test_core import Cloud


@pytest.fixture
def slow_transport(tmp_path, monkeypatch):
    mode = ['body']; entered = threading.Event(); stopped = threading.Event()
    class Slow(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.recv(4096)
            try:
                if mode[0] == 'image':
                    from test_image_batch import picture
                    data=picture()
                    self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(data)).encode()+b'\r\n\r\n'+data)
                    entered.set(); return
                if mode[0] == 'headers':
                    self.request.sendall(b'HTTP/1.1 200 OK\r\nX-Slow: ')
                    entered.set()
                else:
                    self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n')
                    entered.set()
                for _ in range(200):
                    if stopped.wait(.025): break
                    self.request.sendall(b'x')
            except OSError: pass
    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
    server = Server(('127.0.0.1', 0), Slow)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    module_root = Path(image_batch.__file__).parent
    harness = tmp_path/'download_child.py'
    harness.write_text(f'''import sys,http.client
sys.path.insert(0,{str(module_root)!r})
import image_batch
class Response:
    def __init__(self,response,connection,url):
        self.response=response;self.connection=connection;self.headers=response.headers;self.url=url
    def geturl(self):return self.url
    def read(self,size):return self.response.read(size)
    def read1(self,size):return self.response.read1(size)
    def __enter__(self):return self
    def __exit__(self,*args):self.response.close();self.connection.close()
class Opener:
    def open(self,request,timeout):
        connection=http.client.HTTPConnection('127.0.0.1',{server.server_address[1]},timeout=timeout)
        connection.request('GET','/')
        return Response(connection.getresponse(),connection,request.full_url)
image_batch.build_opener=lambda *args:Opener()
raise SystemExit(image_batch.download_helper_main())
''', encoding='utf-8')
    monkeypatch.setattr(image_batch, '_download_launcher', lambda:[sys.executable,str(harness)], raising=False)
    monkeypatch.setattr(image_batch, 'DOWNLOAD_PROCESS_SECONDS', 1.2, raising=False)
    # Before the process boundary exists, reproduce against the real socket in-process.
    class Response:
        def __init__(self,response,connection,url):
            self.response=response;self.connection=connection;self.headers=response.headers;self.url=url
        def geturl(self):return self.url
        def read(self,size):return self.response.read(size)
        def read1(self,size):return self.response.read1(size)
        def __enter__(self):return self
        def __exit__(self,*args):self.response.close();self.connection.close()
    class Opener:
        def open(self,request,timeout):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=timeout)
            connection.request('GET','/')
            return Response(connection.getresponse(),connection,request.full_url)
    monkeypatch.setattr(image_batch,'build_opener',lambda *args:Opener())
    monkeypatch.setattr(image_batch,'DOWNLOAD_ATTEMPT_SECONDS',.2)
    monkeypatch.setattr(image_batch,'DOWNLOAD_TIMEOUT',.1)
    yield mode, entered
    stopped.set(); server.shutdown(); server.server_close(); thread.join(2)


@pytest.mark.parametrize('mode', ['headers', 'body'])
def test_hard_process_deadline_terminates_trickling_transport(slow_transport, mode):
    selected, entered = slow_transport; selected[0] = mode
    start = time.monotonic()
    with pytest.raises(TimeoutError):image_batch.download_image('https://img.pddpic.com/trickle.png?signature=private')
    assert entered.is_set(), 'The real HTTP peer must have begun trickling'
    assert time.monotonic()-start < 2.5


@pytest.mark.parametrize('mode', ['headers', 'body'])
def test_close_and_clear_finish_after_trickling_download(tmp_path, slow_transport, mode):
    selected, entered = slow_transport; selected[0] = mode
    cloud = Cloud();service = QueueService(lambda:cloud,tmp_path/'state')
    service.start_urls([{'platform':'pdd','product_id':'1','title':'product','kind':'main','sku':'',
        'order':1,'url':'https://img.pddpic.com/trickle.png','product_url':''}],tmp_path/'out','prompt','source')
    try:
        assert entered.wait(2)
        service.action('stop')
        start=time.monotonic();service.close(clear_state=True)
        assert time.monotonic()-start < 2.5 and not service.worker.is_alive()
        assert cloud.sends==[] and not list((tmp_path/'state').iterdir())
    finally:service.close(clear_state=True)


def test_source_and_frozen_helpers_keep_signed_url_off_argv(tmp_path,monkeypatch):
    url='https://img.pddpic.com/a.png?signature=private'
    observed=[]
    def execute(argv,**kwargs):
        observed.append((argv,kwargs))
        payload=json.loads(kwargs['input'])
        Path(payload['output_path']).write_bytes(__import__('test_image_batch').picture())
        return subprocess.CompletedProcess(argv,0,json.dumps({'extension':'.png'}),'')
    monkeypatch.setattr(subprocess,'run',execute)
    monkeypatch.setattr(image_batch,'build_opener',lambda *args:(_ for _ in ()).throw(AssertionError('missing process boundary')))
    for frozen in (False,True):
        monkeypatch.setattr(sys,'frozen',frozen,raising=False)
        data,extension=image_batch.download_image(url)
        assert data and extension=='.png'
    source, frozen=observed
    assert source[0][-1]=='--download-image' and source[0][-2].endswith('run.py')
    assert frozen[0]==[sys.executable,'--download-image']
    for argv,kwargs in observed:
        assert url not in argv and kwargs['timeout']<=20
        assert json.loads(kwargs['input'])['url']==url
        assert kwargs['creationflags']==(subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)


def test_real_child_returns_validated_image_and_reaps_successful_transport(slow_transport):
    from test_image_batch import picture
    selected,entered=slow_transport;selected[0]='image'
    assert image_batch.download_image('https://img.pddpic.com/a.png?signature=private')==(picture(),'.png')
    assert entered.is_set()


def test_hidden_source_dispatch_rejects_unsafe_url_without_creating_state(tmp_path):
    state=tmp_path/'state';output=tmp_path/'image.bin'
    result=subprocess.run([sys.executable,str(Path(image_batch.__file__).with_name('run.py')),
        '--download-image','--state-dir',str(state)],input=json.dumps({'url':'http://localhost/private',
        'output_path':str(output)}),capture_output=True,text=True,timeout=5,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    assert result.returncode==1 and json.loads(result.stdout)=={'error':'invalid'}
    assert not state.exists() and not output.exists() and not result.stderr
