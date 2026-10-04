import pytest
from pathlib import Path
from html.parser import HTMLParser
from browser import select_result, select_fullsize, DoubaoBrowser
from core import NeedsUser, SubmissionUncertain

A = 'a' * 32
B = 'b' * 32
def candidate(identity=A, **extra):
    return dict(src=f'https://example.test/rc_gen_image/{identity}.jpeg?thumb=1', complete=True,
                natural_width=200, natural_height=200, finished=True, generated=True, **extra)

def test_history_is_rejected():
    assert select_result([candidate()], {A}) is None

def test_original_and_unloaded_images_are_rejected():
    original = candidate(); original['src'] = 'https://example.test/upload/original.png'
    unloaded = candidate(); unloaded['natural_width'] = 0
    assert select_result([original, unloaded], set()) is None

def test_multiple_generated_images_pause():
    with pytest.raises(NeedsUser): select_result([candidate(), candidate(B)], set())

def test_fullsize_uses_actual_observed_matching_url():
    full = candidate(); full.update(src=f'https://example.test/rc_gen_image/{A}.jpeg?cgen&signed=observed', natural_width=1344, natural_height=1792)
    assert select_fullsize([candidate(B), candidate(), full], A) == full['src']

def test_fullsize_rejects_thumbnail_and_unloaded_image():
    with pytest.raises(NeedsUser): select_fullsize([candidate()], A)

def test_loaded_small_cgen_is_fullsize_while_cthumb_is_not():
    full = candidate(); full.update(src=f'https://example.test/rc_gen_image/{A}.jpeg?cgen=observed', natural_width=512, natural_height=512)
    assert select_fullsize([candidate(), full], A) == full['src']

def test_send_error_is_uncertain_and_keeps_pending(tmp_path):
    adapter = DoubaoBrowser(tmp_path)
    adapter._prepare = lambda path, prompt: set()
    class Send:
        def click(self, **kwargs): raise RuntimeError('lost response')
    class Page:
        def get_by_test_id(self, name): return Send()
    adapter.page = Page()
    with pytest.raises(SubmissionUncertain): adapter.submit(tmp_path / 'a.png', 'prompt')
    assert adapter.pending is not None

def test_poll_failure_preserves_result_identity_for_retry(tmp_path):
    adapter = DoubaoBrowser(tmp_path); adapter.pending = {'baseline': set(), 'identity': A}
    adapter._signals = lambda: None
    adapter._download = lambda: (_ for _ in ()).throw(RuntimeError('download failed'))
    with pytest.raises(NeedsUser): adapter.poll()
    assert adapter.pending['identity'] == A

def test_fixture_upload_cannot_be_paired_as_generated_result():
    class Images(HTMLParser):
        def __init__(self): super().__init__(); self.images = []
        def handle_starttag(self, tag, attrs):
            if tag == 'img':
                attrs = dict(attrs)
                self.images.append(dict(src=attrs['src'], complete=True, natural_width=200,
                                        natural_height=200, generated=attrs.get('alt') == 'image', finished=True))
    parsed = Images()
    parsed.feed((Path(__file__).parent / 'fixtures' / 'doubao.html').read_text(encoding='utf-8'))
    assert select_result(parsed.images, {A}) is None

def test_readiness_failure_does_not_mark_submission_pending(tmp_path):
    adapter = DoubaoBrowser(tmp_path)
    adapter._prepare = lambda path, prompt: (_ for _ in ()).throw(RuntimeError('missing upload control'))
    with pytest.raises(NeedsUser): adapter.submit(tmp_path / 'a.png', 'prompt')
    assert adapter.pending is None

def test_poll_throttle_does_not_touch_dom_again(tmp_path):
    adapter = DoubaoBrowser(tmp_path); adapter.pending = {'baseline': set(), 'identity': A}
    adapter._signals = lambda: None
    adapter._download = lambda: b'image'
    assert adapter.poll() == b'image'
    adapter._signals = lambda: (_ for _ in ()).throw(RuntimeError('DOM read'))
    assert adapter.poll() is None

def test_started_stalled_download_is_cancelled_without_waiting_and_can_retry(tmp_path):
    import io
    import time
    from PIL import Image
    image = io.BytesIO(); Image.new('RGB', (8, 8)).save(image, format='PNG')
    class Download:
        cancelled = False
        path_called = False
        def path(self):
            self.path_called = True
            raise AssertionError('unbounded completion wait')
        def delete(self): raise AssertionError('unbounded completion wait')
        def cancel(self): self.cancelled = True
    download = Download()
    class Event:
        value = download
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Node:
        def is_visible(self): return True
        def click(self, **kwargs): pass
        def evaluate_all(self, js):
            full = candidate(); full['src'] += '&cgen=observed'; return [full]
    class Page:
        def get_by_test_id(self, name): return Node()
        def locator(self, selector): return Node()
        def wait_for_function(self, *args, **kwargs): pass
        def expect_download(self, **kwargs): return Event()
    class Response:
        ok = True
        def body(self): return image.getvalue()
    class Request:
        fail = True
        def get(self, src, timeout):
            assert timeout <= 8000
            if self.fail: raise TimeoutError()
            return Response()
    class Context: request = Request()
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page(); adapter.context = Context()
    adapter.pending = {'baseline': set(), 'identity': A}; adapter._signals = lambda: None
    start = time.monotonic()
    with pytest.raises(NeedsUser): adapter.poll()
    assert time.monotonic() - start < 1
    assert download.cancelled
    assert not download.path_called
    assert adapter.pending['identity'] == A
    adapter.context.request.fail = False; adapter._next_poll = 0
    assert adapter.poll() == image.getvalue()

@pytest.mark.parametrize('failure', [None, 'classic', 'classic-missing-picture', 'classic-missing-model', 'classic-missing-ratio', 'classic-switch', 'plain-chat', 'mode-missing', 'mode-failed', 'mode-disappears', 'attachment-lost', 'model-missing', 'persisted-mode', 'hydrating', 'persistent-zero', 'multiple-composers', 'guidance', 'paragraphs', 'dropped-line', 'changed-line', 'changed-space', 'ambiguous', 'stale-composer', 'stale-card', 'filename', 'unloaded', 'progress', 'prompt', 'disabled', 'composer'])
def test_actual_prepare_rejects_each_negative_readiness_condition_before_send(tmp_path, failure, monkeypatch):
    sends = []
    uploaded = False
    mode = failure == 'persisted-mode'
    clock = [0.0]
    waits = []
    if failure == 'persistent-zero': monkeypatch.setattr('browser.time.monotonic', lambda: clock[0])
    class Guidance(HTMLParser):
        in_main = False
        main_creates = 0
        page_creates = 0
        def handle_starttag(self, tag, attrs):
            if tag == 'main': self.in_main = True
            if dict(attrs).get('data-testid') == 'create_conversation_button':
                self.page_creates += 1
                if self.in_main: self.main_creates += 1
        def handle_endtag(self, tag):
            if tag == 'main': self.in_main = False
    guidance = Guidance()
    guidance.feed((Path(__file__).parent / 'fixtures' / 'doubao-guidance.html').read_text(encoding='utf-8'))
    class Node:
        def __init__(self, name=''):
            self.name = name; self.count_calls = 0; self.text = 'old prompt' if failure == 'stale-composer' and name == 'composer' else ''
        @property
        def first(self): return self
        def filter(self, **kwargs): return self
        def count(self):
            if self.name in {'图片模式', '模型', '比例'}:
                if not mode or not (str(failure).startswith('classic') or failure == 'plain-chat'): return 0
                missing = {'classic-missing-picture': '图片模式', 'classic-missing-model': '模型', 'classic-missing-ratio': '比例', 'plain-chat': '图片模式'}
                return int(self.name != missing.get(failure))
            if self.name == 'upload_file_button' and failure == 'persisted-mode': return 0
            if self.name == 'model' and (failure == 'model-missing' or str(failure).startswith('classic') or failure == 'plain-chat'): return 0
            if self.name == 'composer':
                self.count_calls += 1
                if failure == 'hydrating' and self.count_calls == 1: return 0
                if failure == 'persistent-zero': return 0
                if failure == 'multiple-composers': return 2
            if self.name == 'main-create' and failure in {'guidance', 'ambiguous'}: return guidance.main_creates
            if self.name == 'create_conversation_button' and failure in {'guidance', 'ambiguous'}:
                return 2 if failure == 'ambiguous' else guidance.page_creates
            if self.name == 'attachment-image-card': return int(uploaded or failure == 'stale-card')
            return 0 if failure == 'composer' and self.name == 'composer' else 1
        def get_by_test_id(self, name):
            return Node('main-create' if self.name == 'main' and name == 'create_conversation_button' else name)
        def get_by_role(self, role, name, **kwargs):
            return Node('select-mode' if name == '图像生成' else name if isinstance(name, str) else 'model')
        def get_attribute(self, name): return 'file'
        def set_input_files(self, path, **kwargs):
            nonlocal uploaded
            uploaded = True
        def get_by_text(self, text, **kwargs):
            if text in {'图片模式', '模型', '比例'}: return Node(text)
            raise TimeoutError('filename exists only as aria-label')
        def locator(self, selector): return Node('composer')
        def click(self, **kwargs):
            nonlocal mode
            if self.name == 'select-mode':
                if failure == 'mode-missing': raise TimeoutError('missing mode selector')
                if failure != 'mode-failed': mode = True
            if self.name == 'main-create' and failure == 'guidance': raise TimeoutError('main has no create control')
            if self.name == 'chat_input_send_button': sends.append('sent')
        def wait_for(self, **kwargs):
            if failure == 'filename': raise TimeoutError('filename absent')
        def is_visible(self): return True
        def is_enabled(self): return failure != 'disabled'
        def fill(self, text):
            nonlocal mode
            self.text = text
            if failure in {'mode-disappears', 'classic-switch'}: mode = False
        def inner_text(self):
            if self.name == 'badge': return '图像生成'
            if not self.text: return ''
            if failure == 'prompt': return 'partial'
            if failure == 'paragraphs': return self.text.replace('\n', '\r\n\r\n')
            if failure == 'dropped-line': return self.text.split('\n')[0]
            if failure == 'changed-line': return self.text.replace('第二行', 'changed')
            if failure == 'changed-space': return self.text.replace('  ', ' ')
            return self.text
        def all(self): return [Node('badge'), Node('badge')] if self.name == 'skill_input_exit_button' and mode and not str(failure).startswith('classic') else []
        def evaluate_all(self, script):
            if self.name == 'attachment-image-card':
                if not uploaded: return []
                if failure == 'attachment-lost' and mode: return []
                return [{'label': 'wrong.png' if failure == 'filename' else 'a.png',
                         'visible': True, 'loaded': failure != 'unloaded', 'progress': failure == 'progress'}]
            return []
    class Chooser:
        def set_files(self, path):
            nonlocal uploaded
            assert Path(path).name == 'a.png'; uploaded = True
    class Event:
        value = Chooser()
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Page:
        def locator(self, selector): return Node()
        def get_by_role(self, role): assert role == 'main'; return Node('main')
        def get_by_test_id(self, name): return Node(name)
        def get_by_text(self, text, **kwargs): return Node()
        def expect_file_chooser(self, **kwargs): return Event()
        def wait_for_timeout(self, delay):
            waits.append(delay)
            if failure in {'hydrating', 'persistent-zero'}:
                clock[0] += delay / 1000
                return
            raise TimeoutError('attachment not ready')
        def wait_for_function(self, script, arg, timeout):
            assert arg == 'a.png'
            if failure in {'unloaded', 'progress'}: raise TimeoutError('upload readiness not satisfied')
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page()
    prompt = 'line one  two\n第二行\nthird line'
    if failure in {None, 'classic', 'persisted-mode', 'hydrating', 'guidance', 'paragraphs'}:
        adapter.submit(tmp_path / 'a.png', prompt)
        assert sends == ['sent']
        assert adapter.pending is not None
    else:
        with pytest.raises(NeedsUser) as paused: adapter.submit(tmp_path / 'a.png', prompt)
        assert not sends
        assert adapter.pending is None
        missing = {'classic-missing-picture': '图片模式', 'classic-missing-model': '模型', 'classic-missing-ratio': '比例'}
        if failure in missing: assert missing[failure] in str(paused.value)
    if failure == 'hydrating': assert waits == [250, 250]
    if failure == 'persistent-zero': assert 5 <= clock[0] <= 5.25
    if failure == 'multiple-composers': assert not waits

def test_search_material_thumbnail_is_not_generated_output():
    material = candidate()
    material['src'] = 'https://example.test/ecom-shop-material/jpeg_m_41676237671e82e229043c75d0c7f837_sx_85007_www800-800~tplv-be4g95zd3a-448x448.jpeg'
    assert select_result([material], set()) is None

def test_mode_diagnostics_report_missing_scope_without_private_dom_fields(tmp_path):
    import json
    class Main:
        def evaluate(self, script):
            return {'chat_input_count': 0, 'editors': [['toolbar_outer', 'main_panel']],
                    'controls': [{'label': '图片模式', 'count': 1, 'visible_count': 1,
                                  'nodes': [{'tag': 'div', 'role': 'button', 'testid': 'mode_picker',
                                             'ancestors': ['toolbar_outer', 'main_panel'], 'url': 'https://private.test/signed?token=secret'}]},
                                 {'label': 'my private prompt', 'count': 1, 'nodes': []}],
                    'public_controls': [{'label': '模型', 'count': 1, 'visible_count': 1,
                                         'nodes': [{'tag': 'button', 'role': 'button', 'testid': 'model_picker',
                                                    'ancestors': ['portal_toolbar'], 'inside_main': False,
                                                    'match': 'prefix', 'raw_text': '模型 private suffix'}]}],
                    'prompt': 'my private prompt', 'cookie': 'secret-cookie', 'url': 'https://private.test/signed'}
    class Page:
        def get_by_role(self, role): assert role == 'main'; return Main()
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page()
    diagnostics = adapter._mode_diagnostics()
    assert diagnostics['chat_input_count'] == 0
    assert diagnostics['controls'][0]['nodes'][0]['ancestors'] == ['toolbar_outer', 'main_panel']
    assert diagnostics['public_controls'][0]['nodes'][0]['inside_main'] is False
    assert diagnostics['public_controls'][0]['nodes'][0]['match'] == 'prefix'
    text = json.dumps(diagnostics)
    visible_message = str(adapter._mode_failure('模式尚未就緒'))
    assert '"chat_input_count":0' in visible_message
    assert 'mode_picker' in visible_message
    for forbidden in ('private', 'secret', 'cookie', 'prompt', 'https', 'token'):
        assert forbidden not in text
        assert forbidden not in visible_message

def test_download_pause_identifies_failed_step_without_exposing_exception_url(tmp_path):
    class Page:
        def locator(self, selector): return self
        def evaluate(self, script, identity):
            assert identity == A
            return {'close_count': 2, 'close_visible': 0, 'matched_count': 1,
                    'matched_visible': 1, 'loaded_cgen_count': 0,
                    'url': 'https://private.test/signed?token=secret', 'prompt': 'private words'}
        def get_by_test_id(self, name):
            raise RuntimeError('https://private.test/signed?token=secret')
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page(); adapter._signals = lambda: None
    adapter.pending = {'baseline': set(), 'identity': A}
    with pytest.raises(NeedsUser) as paused: adapter.poll()
    message = str(paused.value)
    assert '開啟生成圖片預覽' in message
    assert 'RuntimeError' in message
    assert '"close_count":2' in message
    assert '"matched_visible":1' in message
    assert adapter.pending['identity'] == A
    for forbidden in ('https', 'private', 'secret', 'token', 'prompt'):
        assert forbidden not in message

@pytest.mark.parametrize('variant', ['one', 'hidden-copy', 'ambiguous', 'only-hidden', 'unloaded', 'wrong-identity'])
def test_preview_opens_actual_unique_visible_matched_image_not_picture_parent(tmp_path, variant):
    import io
    from PIL import Image
    from browser import RESULT_SELECTOR
    stream = io.BytesIO(); Image.new('RGB', (8, 8)).save(stream, format='PNG')
    opened = []
    observations = [dict(candidate(), visible=variant != 'only-hidden')]
    if variant == 'unloaded': observations[0]['natural_width'] = 0
    if variant == 'wrong-identity': observations[0]['src'] = candidate(B)['src']
    if variant in {'hidden-copy', 'ambiguous'}:
        observations.insert(0, dict(candidate(), visible=variant == 'ambiguous'))
    class Parent:
        def click(self, **kwargs): raise TimeoutError('PICTURE parent is not actionable')
    class Thumbnail:
        def __init__(self, index): self.index = index
        def locator(self, selector): assert selector == '..'; return Parent()
        def click(self, **kwargs):
            assert kwargs['timeout'] <= 5000
            assert observations[self.index]['visible']
            opened.append(self.index)
    class Images:
        def evaluate_all(self, script): return observations
        def nth(self, index): return Thumbnail(index)
    class Fullsize:
        def evaluate_all(self, script):
            full = candidate(); full['src'] += '&cgen=observed'; return [full]
    class Close:
        def is_visible(self): return bool(opened)
        def click(self, **kwargs): pass
    class Download:
        def is_visible(self): return False
    class Page:
        def get_by_test_id(self, name): return Close() if name == 'canvas_close_btn' else Download()
        def locator(self, selector): return Images() if selector == RESULT_SELECTOR else Fullsize()
        def wait_for_function(self, *args, **kwargs): assert opened
    class Response:
        ok = True
        def body(self): return stream.getvalue()
    class Request:
        def get(self, src, **kwargs): assert opened; return Response()
    class Context: request = Request()
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page(); adapter.context = Context()
    adapter.pending = {'baseline': set(), 'identity': A}
    if variant in {'ambiguous', 'only-hidden', 'unloaded', 'wrong-identity'}:
        with pytest.raises(NeedsUser): adapter._download()
        assert not opened
    else:
        assert adapter._download() == stream.getvalue()
        assert opened == [1 if variant == 'hidden-copy' else 0]
    assert adapter.pending['identity'] == A

def test_visible_chrome_launch_enables_os_sandbox(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    launches = []
    class Page:
        def goto(self, url, **kwargs): assert url == 'https://www.doubao.com/chat'
    class Context:
        pages = [Page()]
        def set_default_timeout(self, value): pass
    class Chromium:
        def launch_persistent_context(self, path, **kwargs):
            launches.append(kwargs); return Context()
    class Playwright:
        chromium = Chromium()
        def start(self): return self
    monkeypatch.setitem(sys.modules, 'playwright.sync_api', SimpleNamespace(sync_playwright=lambda: Playwright()))
    DoubaoBrowser(tmp_path).open()
    assert launches[0]['chromium_sandbox'] is True
    assert launches[0]['headless'] is False
    assert launches[0]['channel'] == 'chrome'

def test_stale_draft_reset_pause_includes_mode_structure_without_deleting_draft(tmp_path, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr('browser.time.monotonic', lambda: clock[0])
    class Node:
        def filter(self, **kwargs): return self
        def count(self): return 1
        def click(self, **kwargs): pass
        def inner_text(self): return 'existing unsent draft'
        def get_by_test_id(self, name): return self
    class Page:
        def get_by_role(self, role): return Node()
        def wait_for_timeout(self, delay): clock[0] += delay / 1000
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page()
    adapter._signals = lambda: None
    adapter._wait_composer = lambda main: Node()
    adapter._mode_diagnostics = lambda: {'chat_input_count': 1, 'public_controls': []}
    with pytest.raises(NeedsUser) as paused: adapter.submit(tmp_path / 'a.png', 'prompt')
    assert '"chat_input_count":1' in str(paused.value)
    assert 'existing unsent draft' not in str(paused.value)
    assert adapter.pending is None
    assert 5 <= clock[0] <= 5.25

@pytest.mark.parametrize('scope', ['unique', 'missing', 'ambiguous', 'failed'])
def test_failure_capture_is_only_unique_visible_input_and_bounded(tmp_path, scope):
    captured = []
    class Input:
        def filter(self, **kwargs): assert kwargs == {'visible': True}; return self
        def count(self): return {'missing': 0, 'ambiguous': 2}.get(scope, 1)
        def screenshot(self, **kwargs):
            assert kwargs['timeout'] <= 3000
            assert set(kwargs) == {'path', 'timeout'}
            if scope == 'failed': raise RuntimeError('https://private.test/signed')
            captured.append(Path(kwargs['path']))
            Path(kwargs['path']).write_bytes(b'local-only-image')
    class Main:
        def get_by_test_id(self, name): assert name == 'chat_input'; return Input()
    class Page:
        def get_by_role(self, role): assert role == 'main'; return Main()
    adapter = DoubaoBrowser(tmp_path / 'profile'); adapter.page = Page()
    adapter._mode_diagnostics = lambda: {'chat_input_count': 1}
    captured_ok = adapter._capture_input_diagnostic()
    assert captured_ok is (scope == 'unique')
    screenshot = tmp_path / 'diagnostics' / 'last-input.png'
    assert screenshot.exists() is (scope == 'unique')
    assert captured == ([screenshot] if scope == 'unique' else [])
    message = str(adapter._mode_failure('原始暫停原因'))
    assert '原始暫停原因' in message
    assert 'private' not in message
    assert 'signed' not in message
    if scope == 'unique': assert str(screenshot) in message

def test_cancel_gate_prevents_actual_adapter_click(tmp_path):
    from contextlib import contextmanager
    adapter=DoubaoBrowser(tmp_path);adapter._prepare=lambda path,prompt:set()
    clicks=[]
    class Page:
        def get_by_test_id(self,name):
            class Send:
                def click(self,**kwargs): clicks.append(name)
            return Send()
    adapter.page=Page()
    @contextmanager
    def reject():
        raise RuntimeError('cancelled before send')
        yield
    with pytest.raises(RuntimeError, match='cancelled before send'):
        adapter.submit(tmp_path/'a.png','convert',reject)
    assert clicks==[]
    assert adapter.pending is None
