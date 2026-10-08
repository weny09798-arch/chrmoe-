"""Bridge boundaries use no network or live cloud browser."""
import pytest
from app import create_app
from core import NeedsUser

EXT = 'a' * 32
OTHER = 'b' * 32
HEADERS = {'X-Tool-Token': 'secret', 'X-Extension-Id': EXT, 'Origin': f'chrome-extension://{EXT}'}

class Browser:
    def open(self): raise NeedsUser('Test browser never submits')
    def close(self): pass

@pytest.fixture
def client(tmp_path):
    app = create_app(Browser, tmp_path/'private', tmp_path/'out', 'secret')
    app.config['TESTING'] = True
    with app.test_client() as c:
        yield c
    app.extensions['queue'].close(clear_state=True)

def pair(c):
    r = c.post('/api/bridge/pair', headers=HEADERS, json={'extension_id': EXT})
    assert r.status_code == 200
    return r

def collector(c, tmp_path):
    q = c.application.extensions['queue']
    out=tmp_path/'out';out.mkdir(exist_ok=True)
    with q.cv:
        q.job = {'id':'job', 'kind':'collector', 'source_task_id':'source', 'status':'stopped',
                 'output_dir':str(out),'run_dir':str(out),'manifest_path':str(out/'图片转换清单.xlsx'),'mapping_path':str(out/'图片转换清单.json'),
                 'prompt':'convert', 'items':[{'index':0,'phase':'ready','status':'queued','result':None,'message':'',
                 'refs':[{'platform':'pdd','product_id':'1','title':'product','kind':'main','sku':'','order':1,'url':'https://img.pddpic.com/a.png','product_url':'','position':0,'output_path':None}]}], 'message':''}
    return q

def test_pair_requires_token_origin_matching_and_binds_once(client):
    assert client.post('/api/bridge/pair', json={'extension_id': EXT}).status_code == 403
    assert client.post('/api/bridge/pair', headers=HEADERS, json={'extension_id': OTHER}).status_code == 403
    assert client.post('/api/bridge/pair', headers={**HEADERS,'Origin':'https://evil.test'}, json={'extension_id':EXT}).status_code == 403
    r = pair(client)
    assert 'secret' not in r.get_data(as_text=True)
    assert r.headers['Access-Control-Allow-Origin'] == HEADERS['Origin']
    other = {**HEADERS,'X-Extension-Id':OTHER,'Origin':f'chrome-extension://{OTHER}'}
    assert client.post('/api/bridge/pair', headers=other, json={'extension_id':OTHER}).status_code == 403

def test_malformed_unicode_token_is_rejected_without_server_error(client):
    assert client.post('/api/bridge/pair',headers={**HEADERS,'X-Tool-Token':'错误'},json={'extension_id':EXT}).status_code==403

def test_preflight_only_pair_before_binding_then_only_bound_origin(client):
    headers = {'Origin':HEADERS['Origin'], 'Access-Control-Request-Method':'POST',
               'Access-Control-Request-Headers':'content-type,x-tool-token,x-extension-id'}
    assert client.options('/api/bridge/jobs',headers=headers).status_code == 403
    assert client.options('/api/bridge/pair',headers=headers).status_code == 204
    pair(client)
    r=client.options('/api/bridge/jobs',headers=headers)
    assert r.status_code == 204
    assert 'X-Extension-Id' in r.headers['Access-Control-Allow-Headers']
    assert client.options('/api/bridge/jobs',headers={**headers,'Origin':f'chrome-extension://{OTHER}'}).status_code == 403
    assert client.options('/api/bridge/jobs',headers={**headers,'Access-Control-Request-Headers':'authorization'}).status_code == 403

def test_state_needs_client_header_even_if_origin_absent(client,tmp_path):
    pair(client); collector(client,tmp_path)
    assert client.get('/api/bridge/state?job_id=job',headers={'X-Tool-Token':'secret'}).status_code == 403
    assert client.get('/api/bridge/state?job_id=job',headers={'X-Tool-Token':'secret','X-Extension-Id':EXT}).status_code == 200
    assert client.get('/api/bridge/state?job_id=old',headers=HEADERS).status_code == 409

def test_action_rejects_wrong_source_and_job_without_mutation(client,tmp_path):
    pair(client); q=collector(client,tmp_path)
    for job,source in [('old','source'),('job','other')]:
        assert client.post('/api/bridge/action',headers=HEADERS,json={'job_id':job,'source_task_id':source,'action':'continue'}).status_code == 409
        assert q.snapshot()['status']=='stopped'
    assert client.post('/api/bridge/action',headers=HEADERS,json={'job_id':'job','source_task_id':'source','action':'continue'}).status_code==200

def test_manual_queue_cannot_be_read_stopped_or_replaced(client,tmp_path):
    pair(client); q=collector(client,tmp_path)
    with q.cv: q.job.pop('kind'); q.job.pop('source_task_id')
    assert client.get('/api/bridge/state?job_id=job',headers=HEADERS).status_code==409
    assert client.post('/api/bridge/action',headers=HEADERS,json={'job_id':'job','source_task_id':'source','action':'stop'}).status_code==409
    assert client.post('/api/bridge/jobs',headers=HEADERS,json={'source_task_id':'source','output_dir':str(tmp_path/'out'),'entries':[]}).status_code==409
    assert q.snapshot()['status']=='stopped'

def test_collector_start_uses_protected_prompt_and_writes_manifest(client,tmp_path,monkeypatch):
    import core
    def fail_download(url): raise ValueError('offline fixture')
    monkeypatch.setattr(core,'download_image',fail_download)
    pair(client)
    r=client.post('/api/bridge/jobs',headers=HEADERS,json={
        'source_task_id':'source','output_dir':str(tmp_path/'out'),
        'entries':[{'platform':'pdd','product_id':'p1','title':'product','kind':'main','sku':'','order':1,'url':'https://img.pddpic.com/a.png','product_url':''}],
        'prompt':'改变包装','background':True,'typography':True,
    })
    assert r.status_code==200
    assert r.json['kind']=='collector' and r.json['source_task_id']=='source'
    assert '逐字原樣保留，不轉繁體' in r.json['prompt']
    assert '保留原有背景' in r.json['prompt'] and '保留原有排版' in r.json['prompt']
    assert '改变包装' not in r.json['prompt']
    manifest=client.get('/api/bridge/manifest?job_id='+r.json['id'],headers=HEADERS)
    assert manifest.status_code==200 and manifest.data.startswith(b'PK')

def test_folder_cancel_invalid_and_private_paths(client,tmp_path,monkeypatch):
    pair(client)
    import bridge_routes
    monkeypatch.setattr(bridge_routes,'choose_folder',lambda:'')
    assert client.post('/api/bridge/folder',headers=HEADERS,json={}).json == {'path':''}
    for path in ['relative',str(tmp_path/'private'/'state'),str(tmp_path/'private'/'chrome-profile')]:
        monkeypatch.setattr(bridge_routes,'choose_folder',lambda:path)
        assert client.post('/api/bridge/folder',headers=HEADERS,json={}).status_code==400
        assert client.post('/api/bridge/jobs',headers=HEADERS,json={'source_task_id':'source','output_dir':path,'entries':[]}).status_code==400

def test_manifest_and_download_pending_preview(client,tmp_path):
    pair(client); q=collector(client,tmp_path)
    assert client.get('/api/bridge/images/job/0/original',headers=HEADERS).status_code==404
    assert client.get('/api/images/job/0/original?token=secret').status_code==404
    output=tmp_path/'out';output.mkdir(exist_ok=True)
    manifest=output/'图片转换清单.xlsx';manifest.write_bytes(b'mapping')
    image=output/'result.png';image.write_bytes(b'image')
    with q.cv:
        q.job['manifest_path']=str(manifest)
        q.job['items'][0]['result']={'output_path':str(image)}
    assert client.get('/api/bridge/manifest?job_id=job',headers=HEADERS).data==b'mapping'
    assert client.get('/api/bridge/images/job/0/result',headers=HEADERS).data==b'image'
    assert client.get(f'/api/bridge/images/job/0/result?token=secret&extension_id={EXT}').data==b'image'
    assert client.get('/api/bridge/images/old/0/result',headers=HEADERS).status_code==409

def test_completed_manual_job_allows_open_browser_without_claiming_it(client,tmp_path):
    pair(client);q=collector(client,tmp_path)
    with q.cv:
        q.job.pop('kind');q.job.pop('source_task_id');q.job['status']='completed'
    r=client.post('/api/bridge/action',headers=HEADERS,json={'job_id':None,'source_task_id':'source','action':'open-browser'})
    assert r.status_code==200 and q.snapshot()['id']=='job'

def test_local_html_has_connection_code_without_state_or_cors_leak(client):
    from html.parser import HTMLParser
    class Inputs(HTMLParser):
        code=None
        def handle_starttag(self,tag,attrs):
            values=dict(attrs)
            if values.get('id')=='connection-code': self.code=values.get('value')
    r=client.get('/');parser=Inputs();parser.feed(r.get_data(as_text=True))
    assert parser.code=='http://localhost/#token=secret'
    assert 'Access-Control-Allow-Origin' not in r.headers
    assert 'secret' not in client.get('/api/state',headers={'X-Tool-Token':'secret'}).get_data(as_text=True)
    assert client.get('/',headers={'Origin':f'chrome-extension://{EXT}'}).status_code==403

def test_local_reset_keeps_pairing_and_uses_replacement_queue(client,tmp_path):
    pair(client);collector(client,tmp_path)
    assert client.post('/api/reset',headers={'X-Tool-Token':'secret'},json={}).status_code==200
    r=client.get('/api/bridge/state',headers=HEADERS)
    assert r.status_code==200 and r.json['status']=='idle'
    assert client.post('/api/exit',headers={'X-Tool-Token':'secret'},json={}).status_code==200
    assert client.application.extensions['queue'].closed

@pytest.mark.parametrize('job,source',[('old','source'),('job','other'),('job',None)])
def test_cancel_rejects_wrong_ownership_without_mutation(client,tmp_path,job,source):
    pair(client);q=collector(client,tmp_path)
    r=client.post('/api/bridge/action',headers=HEADERS,json={'job_id':job,'source_task_id':source,'action':'cancel'})
    assert r.status_code==409
    assert client.application.extensions['queue'] is q
    assert not q.closed and q.snapshot()['id']=='job' and q.snapshot()['status']=='stopped'

def test_cancel_clears_owned_temp_keeps_output_login_pairing_and_accepts_new_job(client,tmp_path,monkeypatch):
    import core
    def offline(url): raise ValueError('offline fixture')
    monkeypatch.setattr(core,'download_image',offline)
    pair(client);old=collector(client,tmp_path)
    old_id='c'*32
    temporary=old.state_dir/old_id;temporary.mkdir()
    (temporary/'input.png').write_bytes(b'temporary')
    with old.cv:
        old.job['id']=old_id
        old._persist()
    output=tmp_path/'out'/'saved.png';output.write_bytes(b'saved output')
    mapping=tmp_path/'out'/'图片转换清单.xlsx';mapping_bytes=mapping.read_bytes()
    profile=tmp_path/'private'/'chrome-profile';profile.mkdir()
    login=profile/'login-test';login.write_bytes(b'login fixture')
    r=client.post('/api/bridge/action',headers=HEADERS,json={'job_id':old_id,'source_task_id':'source','action':'cancel'})
    assert r.status_code==200 and r.json['status']=='idle' and r.json['id'] is None and r.json['items']==[]
    fresh=client.application.extensions['queue']
    assert fresh is not old and old.closed and not old.worker.is_alive()
    assert not list(old.state_dir.iterdir())
    assert output.read_bytes()==b'saved output' and mapping.read_bytes()==mapping_bytes and login.read_bytes()==b'login fixture'
    assert client.get('/api/bridge/state',headers=HEADERS).json['status']=='idle'
    started=client.post('/api/bridge/jobs',headers=HEADERS,json={
        'source_task_id':'new-source','output_dir':str(tmp_path/'out'),
        'entries':[{'platform':'pdd','product_id':'2','title':'new product','kind':'main','sku':'','order':1,'url':'https://img.pddpic.com/b.png','product_url':''}],
    })
    assert started.status_code==200 and started.json['source_task_id']=='new-source'
    assert client.post('/api/bridge/action',headers=HEADERS,json={'job_id':old_id,'source_task_id':'source','action':'cancel'}).status_code==409
    assert fresh.snapshot()['id']==started.json['id']

def test_cancel_cannot_clear_manual_queue(client,tmp_path):
    pair(client);q=collector(client,tmp_path)
    with q.cv: q.job.pop('kind');q.job.pop('source_task_id')
    r=client.post('/api/bridge/action',headers=HEADERS,json={'job_id':'job','source_task_id':'source','action':'cancel'})
    assert r.status_code==409 and client.application.extensions['queue'] is q and not q.closed

def test_stop_preserves_queue_for_continue(client,tmp_path):
    pair(client);q=collector(client,tmp_path)
    stopped=client.post('/api/bridge/action',headers=HEADERS,json={'job_id':'job','source_task_id':'source','action':'stop'})
    assert stopped.status_code==200 and stopped.json['status']=='stopped'
    assert client.application.extensions['queue'] is q and not q.closed
    assert client.post('/api/bridge/action',headers=HEADERS,json={'job_id':'job','source_task_id':'source','action':'continue'}).status_code==200
