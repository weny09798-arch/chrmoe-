"""Offline regressions for diagnostic loss without another paid submission."""
import copy
import io
import json
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest
from Tea.exceptions import TeaException, UnretryableException
from requests.exceptions import ConnectionError, ReadTimeout

import aliyun_translation as aliyun
import core
from core import QueueService
from oss_fakes import FakePublisher
from test_aliyun import entries, image, never_browser, wait

CREDENTIALS = {'access_key_id': 'LTAI_PRIVATE_KEY', 'access_key_secret': 'PRIVATE_SECRET'}
RAW = 'PRIVATE_SECRET https://signed.example/image?Signature=private'


def sdk_error(tmp_path, exception=None, response=None):
    path = tmp_path/'input.png'
    path.write_bytes(image())
    class Client:
        def __init__(self, config): pass
        def translate_image_with_options(self, request, runtime):
            assert runtime.autoretry is False
            assert runtime.connect_timeout == 4000 and runtime.read_timeout == 18000
            if exception is not None: raise exception
            return response
    with pytest.raises(aliyun.AliyunError) as info:
        aliyun.sdk_translate(CREDENTIALS, path, Client)
    return info.value


def assert_private_absent(value):
    text = json.dumps(value, ensure_ascii=False)
    for token in ('PRIVATE_SECRET', 'LTAI_PRIVATE_KEY', 'signed.example', 'Signature=private'):
        assert token not in text


def test_wrapped_tea_provider_error_retains_only_safe_metadata(tmp_path):
    wrapped = UnretryableException(None, TeaException({'code': 'Parameter.ImageUrlError',
        'message': RAW, 'data': {'statusCode': 503, 'RequestId': 'req-503', 'headers': RAW}}))
    error = sdk_error(tmp_path, exception=wrapped)
    assert error.kind == 'uncertain'
    assert error.diagnostics == {'reason': 'provider-error', 'code': 'Parameter.ImageUrlError',
                                  'status': 503, 'request_id': 'req-503'}
    assert '503' in str(error) and 'req-503' in str(error)
    assert_private_absent([str(error), error.diagnostics])


@pytest.mark.parametrize('exception,reason,words', [
    (ReadTimeout(RAW), 'sdk-timeout', '网络超时'),
    (ConnectionError(RAW), 'sdk-connection', '连接失败'),
    (TimeoutError(RAW), 'sdk-timeout', '网络超时'),
], ids=['read-timeout', 'connection', 'timeout'])
def test_sdk_unwraps_network_causes_without_exception_text(tmp_path, exception, reason, words):
    error = sdk_error(tmp_path, exception=UnretryableException(None, exception))
    assert error.kind == 'uncertain' and error.diagnostics == {'reason': reason}
    assert words in str(error)
    assert_private_absent(str(error))


def test_wrapped_cycle_is_bounded_without_stringifying_exception(tmp_path):
    class Hostile(RuntimeError):
        def __str__(self): raise AssertionError('must never stringify raw exception')
    exception = Hostile()
    exception.inner_exception = exception
    error = sdk_error(tmp_path, exception=exception)
    assert error.diagnostics == {'reason': 'sdk-error'}


@pytest.mark.parametrize('code,request_id,url,want', [
    ('Throttling.User', 'body-request', None,
     {'reason': 'provider-error', 'code': 'Throttling.User', 'status': 429, 'request_id': 'body-request'}),
    ('200', 'body-request', None, {'reason': 'response-invalid', 'status': 429, 'request_id': 'body-request'}),
    ('200', None, 'https://public.example/result.png', {'reason': 'response-invalid', 'status': 429}),
])
def test_body_errors_and_invalid_success_keep_known_request_id(tmp_path, code, request_id, url, want):
    response = SimpleNamespace(status_code=429, body=SimpleNamespace(code=code, request_id=request_id,
        data=SimpleNamespace(final_image_url=url)))
    error = sdk_error(tmp_path, response=response)
    assert error.diagnostics == want
    assert error.kind == ('rate' if code != '200' else 'uncertain')


@pytest.mark.parametrize('diagnostics', [
    {'reason': RAW, 'code': RAW, 'request_id': RAW, 'status': True, 'message': RAW},
    {'reason': [], 'code': {}, 'request_id': ['req'], 'status': '503', 'headers': RAW},
    {'code': 'PRIVATE_SECRET', 'request_id': 'prefix-LTAI_PRIVATE_KEY', 'status': 999},
    {'code': 'x'*129, 'request_id': 'x'*201, 'status': -1},
    None, ['not-a-dict'],
])
def test_parent_filters_untrusted_helper_metadata(monkeypatch, diagnostics):
    reply = {'error': 'uncertain', 'diagnostics': diagnostics, 'message': RAW}
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 1, json.dumps(reply), RAW))
    with pytest.raises(aliyun.AliyunError) as info:
        aliyun.AliyunTranslator(CREDENTIALS).translate('unused.png')
    assert info.value.diagnostics == {}
    assert_private_absent([str(info.value), info.value.diagnostics])


@pytest.mark.parametrize('reply,reason,words', [
    ('not-json '+RAW, 'helper-protocol', '返回内容无效'),
    ('[]', 'helper-protocol', '返回内容无效'),
    ('{"error": []}', 'helper-protocol', '返回内容无效'),
    ('{}', 'helper-protocol', '返回内容无效'),
    ('x'*65537, 'helper-protocol', '返回内容无效'),
    (None, 'helper-timeout', '处理进程超时'),
], ids=['bad-json', 'array', 'bad-kind', 'missing-result', 'oversized', 'timeout'])
def test_helper_protocol_and_timeout_are_distinct_and_safe(monkeypatch, reply, reason, words):
    def execute(*args, **kwargs):
        assert kwargs['timeout'] == 24
        if reply is None: raise subprocess.TimeoutExpired(['private'], 24, output=RAW, stderr=RAW)
        return subprocess.CompletedProcess(args, 0, reply, RAW)
    monkeypatch.setattr(subprocess, 'run', execute)
    with pytest.raises(aliyun.AliyunError) as info:
        aliyun.AliyunTranslator(CREDENTIALS).translate('unused.png')
    assert info.value.kind == 'uncertain' and info.value.diagnostics == {'reason': reason}
    assert words in str(info.value)
    assert_private_absent(str(info.value))


def test_helper_roundtrip_preserves_provider_details_without_raw_fields(tmp_path, monkeypatch):
    exception = UnretryableException(None, TeaException({'code': 'Forbidden.RAM', 'message': RAW,
        'data': {'statusCode': 403, 'request_id': 'safe-req', 'response': RAW}}))
    error = sdk_error(tmp_path, exception=exception)
    monkeypatch.setattr(aliyun, 'sdk_translate', lambda *a, **kw: (_ for _ in ()).throw(error))
    payload = json.dumps({'credentials': CREDENTIALS, 'input_path': 'unused.png'})
    output = io.StringIO()
    monkeypatch.setattr(sys, 'stdin', io.StringIO(payload))
    monkeypatch.setattr(sys, 'stdout', output)
    assert aliyun.translate_helper_main() == 1
    reply = json.loads(output.getvalue())
    assert reply == {'error': 'auth', 'diagnostics': {'reason': 'provider-error', 'code': 'Forbidden.RAM',
                                                   'status': 403, 'request_id': 'safe-req'}}
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 1, json.dumps(reply), RAW))
    with pytest.raises(aliyun.AliyunError) as info:
        aliyun.AliyunTranslator(CREDENTIALS).translate('unused.png')
    assert info.value.diagnostics == reply['diagnostics'] and info.value.kind == 'auth'
    assert_private_absent([reply, str(info.value)])
    queue = QueueService(never_browser, tmp_path/'state', aliyun_factory=lambda: aliyun.AliyunTranslator(CREDENTIALS))
    try:
        queue.start([('input.png', image())], tmp_path/'out', 'convert', provider='aliyun', paid_confirmed=True)
        state = wait(queue, lambda s: s['status'] == 'paused')
        assert state['items'][0]['aliyun_error'] == reply['diagnostics']
        assert 'safe-req' in state['items'][0]['message'] and state['paid_calls'] == 1
        assert_private_absent([state, json.loads((tmp_path/'state/job.json').read_text(encoding='utf-8'))])
    finally: queue.close()


@pytest.mark.parametrize('code', [10**5000, object()], ids=['oversized-int', 'object'])
def test_malformed_sdk_metadata_is_ignored_without_a_raw_exception(tmp_path, code):
    exception = RuntimeError(RAW)
    exception.code = code
    exception.statusCode = 503
    exception.data = {'RequestId': 'typed-request'}
    error = sdk_error(tmp_path, exception=exception)
    assert error.diagnostics == {'reason': 'provider-error', 'status': 503, 'request_id': 'typed-request'}
    assert_private_absent([str(error), error.diagnostics])


def test_legacy_errors_remain_usable(monkeypatch):
    error = aliyun.AliyunError('auth')
    assert error.kind == 'auth' and error.diagnostics == {}
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 1, '{"error":"uncertain"}', RAW))
    with pytest.raises(aliyun.AliyunError) as info:
        aliyun.AliyunTranslator(CREDENTIALS).translate('unused.png')
    assert info.value.kind == 'uncertain' and info.value.diagnostics == {}


def test_queue_revalidates_mutated_error_and_explicit_retry_clears_diagnosis(tmp_path, monkeypatch):
    error = aliyun.AliyunError('auth', {'reason': 'provider-error', 'code': 'Forbidden.RAM',
                                      'status': 403, 'request_id': 'auth-req'})
    error.diagnostics.update(message=RAW, headers=RAW, extra={'secret': RAW})
    error.args = (RAW,)
    calls = []
    entered, release = threading.Event(), threading.Event()
    class Translator:
        def translate(self, path):
            calls.append(path)
            if len(calls) == 1: raise error
            entered.set(); assert release.wait(3)
            return {'request_id': 'ok', 'final_image_url': 'https://public.example/r.png'}
    translator = Translator()
    monkeypatch.setattr(core, 'download_aliyun_result', lambda url: (image(), '.png'))
    queue = QueueService(never_browser, tmp_path/'state', aliyun_factory=lambda: translator)
    try:
        queue.start([('input.png', image())], tmp_path/'out', 'convert', provider='aliyun', paid_confirmed=True)
        state = wait(queue, lambda s: s['status'] == 'paused')
        assert state['items'][0]['aliyun_error'] == {'reason': 'provider-error', 'code': 'Forbidden.RAM',
                                                  'status': 403, 'request_id': 'auth-req'}
        assert_private_absent([state, json.loads((tmp_path/'state/job.json').read_text(encoding='utf-8'))])
        queue.action('retry', 0)
        assert entered.wait(2)
        assert 'aliyun_error' not in queue.snapshot()['items'][0]
        release.set(); wait(queue, lambda s: s['status'] == 'completed')
    finally:
        release.set(); queue.close()


def test_queue_restart_revalidates_new_metadata_but_legacy_job_stays_usable(tmp_path):
    root = tmp_path/'state'; root.mkdir()
    job = {'id': 'old', 'status': 'paused', 'provider': 'aliyun', 'prompt': 'p',
        'message': '', 'output_dir': str(tmp_path/'out'), 'items': [
            {'index': 0, 'name': 'bad.png', 'phase': 'uncertain', 'status': 'paused', 'result': None,
             'message': 'old uncertain message', 'aliyun_error': {'reason': 'sdk-timeout', 'request_id': RAW,
                                                                'status': True, 'headers': RAW}},
            {'index': 1, 'name': 'legacy.png', 'phase': 'uncertain', 'status': 'paused', 'result': None,
             'message': 'legacy uncertain message'}]}
    (root/'job.json').write_text(json.dumps(job), encoding='utf-8')
    queue = QueueService(never_browser, root)
    try:
        state = queue.snapshot()
        assert state['items'][0]['aliyun_error'] == {'reason': 'sdk-timeout'}
        assert state['items'][1]['message'] == 'legacy uncertain message'
        queue.action('continue')
        assert state['items'][1]['phase'] == 'uncertain' and queue.snapshot()['status'] == 'paused'
        assert_private_absent([state, json.loads((root/'job.json').read_text(encoding='utf-8'))])
    finally: queue.close()


def test_two_distinct_images_keep_first_published_and_only_confirmed_second_redo(tmp_path, monkeypatch):
    monkeypatch.setattr(core, 'download_image', lambda url: (image(color='red' if '/0.' in url else 'blue'), '.png'))
    monkeypatch.setattr(core, 'download_aliyun_result', lambda url: (image(color='green'), '.png'))
    calls = []
    release, entered = threading.Event(), threading.Event()
    error = sdk_error(tmp_path, exception=UnretryableException(None, ReadTimeout(RAW)))
    class Translator:
        def translate(self, path):
            calls.append(str(path))
            if len(calls) == 2: raise error
            if len(calls) == 3: entered.set(); assert release.wait(3)
            return {'request_id': 'safe-success', 'final_image_url': 'https://public.example/result.png'}
    translator = Translator()
    root = tmp_path/'state'
    queue = QueueService(never_browser, root, aliyun_factory=lambda: translator, oss_factory=FakePublisher)
    try:
        queue.start_urls(entries(('main', 'detail')), tmp_path/'out', 'convert', 'source', provider='aliyun', paid_confirmed=True)
        state = wait(queue, lambda s: s['status'] == 'paused')
        first = copy.deepcopy(state['items'][0])
        assert first['status'] == 'completed' and first['refs'][0]['published_url']
        second = state['items'][1]
        assert second['phase'] == 'uncertain' and second['aliyun_error'] == {'reason': 'sdk-timeout'}
        assert '网络超时' in second['message'] and 'aliyun_result' not in second
        queue.action('continue'); time.sleep(.03)
        assert len(calls) == 2 and queue.snapshot()['items'][1]['aliyun_error'] == {'reason': 'sdk-timeout'}
        queue.close()
        queue = QueueService(never_browser, root, aliyun_factory=lambda: translator, oss_factory=FakePublisher)
        state = queue.snapshot()
        assert state['items'][0] == first
        assert state['items'][1]['phase'] == 'uncertain' and '网络超时' in state['items'][1]['message']
        assert state['items'][1]['aliyun_error'] == {'reason': 'sdk-timeout'}
        assert_private_absent([state, json.loads((root/'job.json').read_text(encoding='utf-8'))])
        queue.action('continue'); time.sleep(.03)
        with pytest.raises(ValueError): queue.action('retry', 1)
        with pytest.raises(ValueError): queue.action('redo', 1)
        assert len(calls) == 2
        queue.action('redo', 1, paid_confirmed=True)
        assert entered.wait(2)
        assert 'aliyun_error' not in queue.snapshot()['items'][1]
        release.set()
        state = wait(queue, lambda s: s['status'] == 'completed')
        assert len(calls) == 3 and calls[1] == calls[2] and calls[0] != calls[1]
        assert state['paid_calls'] == 3 and state['items'][0] == first
        assert 'aliyun_error' not in state['items'][1]
    finally:
        release.set(); queue.close()
