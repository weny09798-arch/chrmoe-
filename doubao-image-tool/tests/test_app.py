import io, time
import pytest
from PIL import Image
from app import create_app
from core import NeedsUser

class Browser:
    stage = '生成'
    def open(self): pass
    def close(self): pass
    def submit(self, path, prompt, send_gate):
        with send_gate(): pass
    def poll(self): return None

@pytest.fixture
def client(tmp_path):
    app = create_app(Browser, tmp_path / 'state', tmp_path / 'out', 'secret')
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client
    app.extensions['queue'].close()

def png():
    out = io.BytesIO(); Image.new('RGB', (2, 2)).save(out, 'PNG'); return out.getvalue()

def test_api_requires_token(client):
    assert client.get('/api/state').status_code == 403

@pytest.mark.parametrize('headers', [{'Host':'evil.com','X-Tool-Token':'secret'}, {'Origin':'https://evil.com','X-Tool-Token':'secret'}])
def test_rejects_untrusted_host_origin(client, headers):
    assert client.get('/api/state', headers=headers).status_code == 403

def test_validated_job_and_known_preview(client, tmp_path):
    headers = {'X-Tool-Token':'secret'}
    r = client.post('/api/jobs', headers=headers, data={'files':(io.BytesIO(png()), '<img>.png'), 'output_dir':str(tmp_path / 'out')})
    assert r.status_code == 200
    state = client.get('/api/state', headers=headers).json
    assert state['items'][0]['name'] == '<img>.png'
    assert '保留原有背景' in state['prompt']
    assert client.get(f"/api/images/{state['id']}/0/original?token=secret").status_code == 200
    assert client.get(f"/api/images/{state['id']}/0/../job.json?token=secret").status_code == 404
    assert client.get('/api/images/unknown/0/original?token=secret').status_code == 404

def test_invalid_image_rejected(client, tmp_path):
    r = client.post('/api/jobs', headers={'X-Tool-Token':'secret'}, data={'files':(io.BytesIO(b'bad'),'x.png'), 'output_dir':str(tmp_path)})
    assert r.status_code == 400

def test_open_browser_failure_is_visible(tmp_path):
    class Missing(Browser):
        def open(self): raise NeedsUser('请安装 Chrome')
    app = create_app(Missing, tmp_path / 'state', tmp_path)
    with app.test_client() as c:
        token = app.config['TOOL_TOKEN']
        assert c.post('/api/action', headers={'X-Tool-Token':token}, json={'action':'open-browser'}).status_code == 200
        for _ in range(100):
            state = c.get('/api/state', headers={'X-Tool-Token':token}).json
            if 'Chrome' in state['browser_message']: break
            time.sleep(.01)
        assert 'Chrome' in state['browser_message']
        assert state['id'] is None
    app.extensions['queue'].close()

def test_index_specific_redo_and_terminal_storage_error(client, tmp_path):
    q = client.application.extensions['queue']; q.start([('a.png',png()),('b.png',png())],tmp_path,'转换')
    q.action('stop')
    assert client.post('/api/action', headers={'X-Tool-Token':'secret'}, json={'action':'redo','index':1}).status_code == 200
    assert q.snapshot()['items'][1]['revision'] == 1
    with q.cv: q.job['status'] = 'storage-error'
    assert client.post('/api/action', headers={'X-Tool-Token':'secret'}, json={'action':'open-browser'}).status_code == 409

def test_state_remains_readable_while_chrome_opens(tmp_path):
    import threading
    entered, release = threading.Event(), threading.Event()
    class Slow(Browser):
        def open(self): entered.set(); release.wait(2)
    app = create_app(Slow, tmp_path)
    q = app.extensions['queue']; q.open_browser(); assert entered.wait(1)
    snapshots = []
    reader = threading.Thread(target=lambda: snapshots.append(q.snapshot()))
    reader.start(); reader.join(.2)
    readable = not reader.is_alive()
    release.set(); reader.join(); q.close()
    assert readable, 'Chrome open must not block local UI polling'
    assert snapshots[0]['browser_busy']

def test_default_redesign_options_are_off(client):
    from html.parser import HTMLParser
    class Inputs(HTMLParser):
        def __init__(self): super().__init__(); self.inputs={}
        def handle_starttag(self, tag, attrs):
            values=dict(attrs)
            if tag=='input' and values.get('type')=='checkbox': self.inputs[values['id']]=values
    parser=Inputs();parser.feed(client.get('/').get_data(as_text=True))
    assert set(parser.inputs)=={'background','typography'}
    assert all('checked' not in attrs for attrs in parser.inputs.values())
