"""Packaging translation must survive UI/queue/SDK boundaries without paid calls."""
import io
import json
from types import SimpleNamespace

import pytest

from app import create_app
from core import QueueService
from prompts import build_prompt
from test_aliyun import image, entries, wait, never_browser


@pytest.mark.parametrize('enabled,expected', [(False, 'false'), (True, 'true')])
def test_sdk_packaging_switch_keeps_ecommerce_price_category(tmp_path, enabled, expected):
    from aliyun_translation import sdk_translate
    path = tmp_path / '商品.png'
    path.write_bytes(image())
    class Client:
        def __init__(self, config): pass
        def translate_image_with_options(self, request, runtime):
            assert request.field == 'e-commerce'
            assert request.source_language == 'zh' and request.target_language == 'zh-tw'
            assert json.loads(request.ext) == {'ignoreEntityRecognize': expected}
            assert runtime.autoretry is False
            return SimpleNamespace(body=SimpleNamespace(code=200, request_id='request', data=SimpleNamespace(final_image_url='https://public.example/result.png')))
    result = sdk_translate({'access_key_id': 'test', 'access_key_secret': 'test'}, path, Client, translate_product_text=enabled)
    assert result['request_id'] == 'request'


def test_packaging_switch_reaches_paid_helper_without_retry(monkeypatch, tmp_path):
    import aliyun_translation as module
    payloads = []
    def run(args, **kwargs):
        payloads.append(json.loads(kwargs['input']))
        return SimpleNamespace(returncode=0, stdout=json.dumps({'request_id': 'r', 'final_image_url': 'https://public.example/a.png'}))
    monkeypatch.setattr(module.subprocess, 'run', run)
    module.AliyunTranslator({'access_key_id':'test','access_key_secret':'test'}).translate(tmp_path/'x.png', translate_product_text=True)
    assert len(payloads) == 1 and payloads[0]['translate_product_text'] is True


def test_enabled_doubao_prompt_has_no_packaging_preservation_conflict():
    prompt = build_prompt(translate_product_text=True, extra='保留背景')
    assert '商品本體及包裝' in prompt and '繁體中文' in prompt
    assert '所有數字' in prompt and '單位' in prompt
    assert '不轉繁體' not in prompt and '包裝上的簡體字應保留' not in prompt
    assert '不增刪文案' in prompt and '保留原有排版' in prompt


@pytest.mark.parametrize('enabled', [True, False])
def test_paid_queue_uses_frozen_packaging_switch_and_restores_it(tmp_path, monkeypatch, enabled):
    import core
    attempts = []
    class Translator:
        def translate(self, path, translate_product_text=False):
            attempts.append(translate_product_text)
            return {'request_id':'r','final_image_url':'https://public.example/a.png'}
    monkeypatch.setattr(core, 'download_image', lambda url: (image(), '.png'))
    monkeypatch.setattr(core, 'download_aliyun_result', lambda url: (_ for _ in ()).throw(OSError('offline')))
    queue = QueueService(never_browser, tmp_path/'state', aliyun_factory=Translator)
    try:
        queue.start_urls(entries(('main',)), tmp_path/'out', build_prompt(translate_product_text=enabled), 'source', provider='aliyun', paid_confirmed=True, translate_product_text=enabled)
        state = wait(queue, lambda s: s['status'] == 'paused')
        assert state['translate_product_text'] is enabled and attempts == [enabled]
        assert state['paid_calls'] == 1 and state['estimated_cost_upper'] == 0.06
    finally:
        queue.close()
    restored = QueueService(never_browser, tmp_path/'state', aliyun_factory=Translator)
    try:
        assert restored.snapshot()['translate_product_text'] is enabled
        restored.action('continue')
        wait(restored, lambda s: s['status'] == 'paused')
        assert attempts == [enabled]
    finally:
        restored.close()
    legacy_path = tmp_path/'state/job.json'
    legacy = json.loads(legacy_path.read_text(encoding='utf-8'))
    legacy.pop('translate_product_text')
    legacy_path.write_text(json.dumps(legacy), encoding='utf-8')
    old = QueueService(never_browser, tmp_path/'state', aliyun_factory=Translator)
    try:
        assert old.snapshot()['translate_product_text'] is False
    finally:
        old.close()


@pytest.mark.parametrize('invalid', ['true', 1, None, {}])
def test_queue_rejects_non_boolean_packaging_option(tmp_path, invalid):
    queue = QueueService(never_browser, tmp_path/'state')
    try:
        with pytest.raises(ValueError):
            queue.start_urls(entries(('main',)), tmp_path/'out', 'p', 'source', translate_product_text=invalid)
        assert queue.snapshot()['id'] is None
    finally:
        queue.close()


def test_paired_bridge_exposes_switch_and_passes_it_into_prompt_and_job(tmp_path, monkeypatch):
    import core
    monkeypatch.setattr(core, 'download_image', lambda url: (_ for _ in ()).throw(OSError('offline')))
    app = create_app(never_browser, tmp_path/'private', token='secret', oss_factory=lambda: None)
    headers = {'X-Tool-Token':'secret','X-Extension-Id':'a'*32,'Origin':'chrome-extension://'+'a'*32}
    try:
        with app.test_client() as client:
            assert client.post('/api/bridge/pair', headers=headers, json={'extension_id':'a'*32}).status_code == 200
            assert client.get('/api/bridge/capabilities', headers=headers).json['product_text_translation'] is True
            body = {'source_task_id':'source','entries':entries(('main',)),'output_dir':str(tmp_path/'out'),'translate_product_text':True}
            response = client.post('/api/bridge/jobs', headers=headers, json=body)
            assert response.status_code == 200 and response.json['translate_product_text'] is True
            assert '不轉繁體' not in response.json['prompt']
    finally:
        app.extensions['queue'].close(clear_state=True)


def test_local_file_form_passes_packaging_choice(tmp_path):
    class Browser:
        stage = ''
        def open(self): pass
        def close(self): pass
        def submit(self, path, prompt, gate):
            with gate(): pass
        def poll(self): return None
    app = create_app(Browser, tmp_path, token='secret')
    try:
        with app.test_client() as client:
            response = client.post('/api/jobs', headers={'X-Tool-Token':'secret'}, data={'output_dir':str(tmp_path/'out'),'translate_product_text':'true','files':(io.BytesIO(image()),'x.png')})
            assert response.status_code == 200 and response.json['translate_product_text'] is True
            assert '不轉繁體' not in response.json['prompt']
    finally:
        app.extensions['queue'].close(clear_state=True)
