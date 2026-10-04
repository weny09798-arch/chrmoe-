import io
import sys
import time
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def image_bytes(color='red', size=(80, 50)):
    stream = io.BytesIO()
    Image.new('RGB', size, color).save(stream, 'PNG')
    return stream.getvalue()


class LocalConverter:
    # The slow OCR boundary is substituted; routes, validation, writes and previews stay real.
    def convert(self, data, mode='s2t'):
        from engine import translate_regions
        image = Image.open(io.BytesIO(data)).convert('RGBA')
        output, report = translate_regions(image, [], mode)
        buffer = io.BytesIO()
        output.save(buffer, 'PNG')
        return buffer.getvalue(), report


def setup_app(tmp_path):
    from app import create_app
    app = create_app(LocalConverter(), tmp_path / 'outputs', 'test-token')
    app.config['TESTING'] = True
    return app, app.test_client()


def submit(client, path, filename='商品.png', data=None, **kwargs):
    return client.post('/api/jobs', data={
        'output_dir': str(path), 'mode': 's2t',
        'images': (io.BytesIO(data if data is not None else image_bytes()), filename)
    }, headers={'X-Local-Token': 'test-token', **kwargs}, content_type='multipart/form-data')


def wait_job(client, job_id):
    for _ in range(100):
        result = client.get(f'/api/jobs/{job_id}', headers={'X-Local-Token': 'test-token'})
        assert result.status_code == 200
        state = result.json
        if state['status'] in ('done', 'partial', 'error'):
            return state
        time.sleep(.02)
    pytest.fail('Job never reached a terminal state')


def test_untrusted_requests_cannot_start_file_writes(tmp_path):
    app, client = setup_app(tmp_path)
    assert client.post('/api/jobs').status_code == 403
    assert client.get('/api/jobs/missing?token=%E7%B9%81%E9%AB%94').status_code == 403
    target = tmp_path / 'cross-origin'
    assert submit(client, target, Origin='https://example.com').status_code == 403
    assert not target.exists()
    assert client.get('/api/jobs/missing', headers={'X-Local-Token':'test-token','Host':'evil.example'}).status_code == 403
    app.extensions['image_service'].close()


def test_index_has_no_external_dependencies_and_shutdown_is_authenticated(tmp_path):
    import threading
    app, client = setup_app(tmp_path)
    stopped = threading.Event()
    app.extensions['shutdown'] = stopped.set
    index = client.get('/')
    assert index.status_code == 200
    assert b'test-token' in index.data and b'/assets/app.js' in index.data
    assert 'frame-ancestors' in index.headers['Content-Security-Policy']
    assert client.post('/api/shutdown').status_code == 403
    assert not stopped.is_set()
    assert client.post('/api/shutdown', headers={'X-Local-Token':'test-token'}).status_code == 200
    assert stopped.wait(1)
    app.extensions['image_service'].close()


def test_batch_limit_and_upload_size_are_enforced(tmp_path):
    app, client = setup_app(tmp_path)
    response = client.post('/api/jobs', data={'output_dir':str(tmp_path), 'images':[
        (io.BytesIO(image_bytes()), f'{i}.png') for i in range(21)
    ]}, headers={'X-Local-Token':'test-token'}, content_type='multipart/form-data')
    assert response.status_code == 400 and not app.extensions['image_service'].jobs
    app.config['MAX_CONTENT_LENGTH'] = 100
    assert submit(client,tmp_path).status_code == 413
    app.extensions['image_service'].close()


def test_busy_batch_is_rejected_before_any_image_decoding(tmp_path,monkeypatch):
    import threading
    import engine
    from app import create_app
    entered,release=threading.Event(),threading.Event()
    class BlockingConverter(LocalConverter):
        def convert(self,data,mode='s2t'):
            entered.set()
            assert release.wait(3)
            return super().convert(data,mode)
    app=create_app(BlockingConverter(),tmp_path,'test-token')
    client=app.test_client()
    try:
        assert submit(client,tmp_path).status_code==202
        assert entered.wait(1)
        def forbidden_decode(data):
            pytest.fail('A rejected batch must not decode uploads')
        monkeypatch.setattr(engine,'decode_image',forbidden_decode)
        assert submit(client,tmp_path).status_code==409
    finally:
        release.set()
        app.extensions['image_service'].close()


def test_concurrent_upload_is_rejected_during_first_batch_validation(tmp_path,monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    import engine
    entered,release=threading.Event(),threading.Event()
    real_decode=engine.decode_image
    calls=[]
    def blocking_decode(data):
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return real_decode(data)
    app,client=setup_app(tmp_path)
    monkeypatch.setattr(engine,'decode_image',blocking_decode)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            first=pool.submit(submit,app.test_client(),tmp_path)
            try:
                assert entered.wait(1)
                assert submit(client,tmp_path).status_code==409
                assert len(calls)==1
            finally:release.set()
            response=first.result(timeout=3)
            assert response.status_code==202
            assert wait_job(client,response.json['id'])['status']=='done'
    finally:
        release.set()
        app.extensions['image_service'].close()


def test_second_batch_waits_and_old_previews_are_evicted_without_deleting_outputs(tmp_path):
    import threading
    from app import create_app
    entered, release = threading.Event(), threading.Event()
    class BlockedConverter(LocalConverter):
        def convert(self,data,mode='s2t'):
            entered.set()
            assert release.wait(3)
            return super().convert(data,mode)
    app = create_app(BlockedConverter(),tmp_path,'test-token')
    client = app.test_client()
    try:
        first = submit(client,tmp_path)
        assert entered.wait(1)
        assert submit(client,tmp_path).status_code == 409
        release.set()
        old = wait_job(client,first.json['id'])
        old_file = Path(old['results'][0]['paths']['png'])
        for _ in range(4):
            batch = submit(client,tmp_path)
            wait_job(client,batch.json['id'])
        assert client.get(f"/api/jobs/{old['id']}?token=test-token").status_code == 404
        assert old_file.exists()
    finally:
        release.set()
        app.extensions['image_service'].close()


def test_invalid_upload_and_relative_output_never_create_a_job(tmp_path):
    app, client = setup_app(tmp_path)
    assert submit(client, tmp_path / 'invalid', data=b'not an image').status_code == 400
    assert submit(client, 'relative/folder').status_code == 400
    assert not (tmp_path / 'invalid').exists()
    assert client.get('/api/jobs/unknown', headers={'X-Local-Token':'test-token'}).status_code == 404
    app.extensions['image_service'].close()


def test_generated_files_and_authenticated_previews_match_chosen_path(tmp_path):
    app, client = setup_app(tmp_path)
    target = tmp_path / '指定位置'
    reply = submit(client, target, filename='../../商品.png')
    assert reply.status_code == 202
    job = wait_job(client, reply.json['id'])
    assert job['processed'] == job['total'] == 1
    assert job['status'] == 'done'
    result = job['results'][0]
    saved = Path(result['paths']['png'])
    assert saved.parent == target
    assert saved.exists() and Path(result['paths']['report']).exists()
    preview = f"/api/jobs/{job['id']}/image/0/result"
    assert client.get(preview).status_code == 403
    response = client.get(preview + '?token=test-token')
    assert response.data == saved.read_bytes()
    assert Image.open(io.BytesIO(response.data)).size == (80, 50)
    assert client.get(f"/api/jobs/{job['id']}/image/0/anything?token=test-token").status_code == 404
    assert client.get('/api/file?path=C:/Windows/win.ini&token=test-token').status_code == 404
    app.extensions['image_service'].close()


def test_static_image_name_must_match_real_format(tmp_path):
    app, client = setup_app(tmp_path)
    assert submit(client, tmp_path / 'bad-extension', filename='image.jpg').status_code == 400
    response = client.post('/api/jobs', data={'output_dir':str(tmp_path), 'mode':'unsafe',
        'images':(io.BytesIO(image_bytes()), 'image.png')}, headers={'X-Local-Token':'test-token'}, content_type='multipart/form-data')
    assert response.status_code == 400
    app.extensions['image_service'].close()


def test_oversized_and_animated_images_are_rejected(tmp_path):
    app, client = setup_app(tmp_path)
    assert submit(client, tmp_path / 'huge', data=image_bytes(size=(16001, 1))).status_code == 400
    first, second = Image.new('RGB', (2, 2), 'red'), Image.new('RGB', (2, 2), 'blue')
    animated = io.BytesIO()
    first.save(animated, 'WEBP', save_all=True, append_images=[second], duration=100)
    assert submit(client, tmp_path / 'animated', filename='image.webp', data=animated.getvalue()).status_code == 400
    app.extensions['image_service'].close()


def test_one_failed_image_does_not_discard_the_other_results(tmp_path):
    from app import create_app
    class SometimesFails(LocalConverter):
        def convert(self, data, mode='s2t'):
            if Image.open(io.BytesIO(data)).getpixel((0, 0)) == (0, 0, 255):
                raise ValueError('这张图片无法可靠处理')
            return super().convert(data, mode)
    app = create_app(SometimesFails(), tmp_path, 'test-token')
    client = app.test_client()
    response = client.post('/api/jobs', data={'output_dir':str(tmp_path), 'mode':'s2t', 'images':[
        (io.BytesIO(image_bytes('blue')), 'blue.png'), (io.BytesIO(image_bytes()), 'red.png')
    ]}, headers={'X-Local-Token':'test-token'}, content_type='multipart/form-data')
    state = wait_job(client, response.json['id'])
    assert state['status'] == 'partial' and state['processed'] == 2
    assert state['results'][0]['status'] == 'error'
    assert state['results'][1]['status'] == 'ok'
    assert Path(state['results'][1]['paths']['png']).exists()
    app.extensions['image_service'].close()
