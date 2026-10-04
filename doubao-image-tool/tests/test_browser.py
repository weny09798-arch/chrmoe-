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

@pytest.mark.parametrize('failure', [None, 'filename', 'unloaded', 'progress', 'prompt', 'disabled', 'composer'])
def test_actual_prepare_rejects_each_negative_readiness_condition_before_send(tmp_path, failure):
    sends = []
    class Node:
        def __init__(self, name=''): self.name = name
        @property
        def first(self): return self
        def filter(self, **kwargs): return self
        def count(self): return 0 if failure == 'composer' else 1
        def get_by_test_id(self, name): return Node(name)
        def get_by_text(self, text, **kwargs):
            raise TimeoutError('filename exists only as aria-label')
        def locator(self, selector): return Node('composer')
        def click(self, **kwargs):
            if self.name == 'chat_input_send_button': sends.append('sent')
        def wait_for(self, **kwargs):
            if failure == 'filename': raise TimeoutError('filename absent')
        def is_visible(self): return True
        def is_enabled(self): return failure != 'disabled'
        def fill(self, text): self.text = text
        def inner_text(self): return 'partial' if failure == 'prompt' else self.text
        def all(self): return []
        def evaluate_all(self, script):
            if self.name == 'attachment-image-card':
                return [{'label': 'wrong.png' if failure == 'filename' else 'a.png',
                         'visible': True, 'loaded': failure != 'unloaded', 'progress': failure == 'progress'}]
            return []
    class Chooser:
        def set_files(self, path): assert Path(path).name == 'a.png'
    class Event:
        value = Chooser()
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Page:
        def locator(self, selector): return Node()
        def get_by_role(self, role): assert role == 'main'; return Node()
        def get_by_test_id(self, name): return Node(name)
        def get_by_text(self, text, **kwargs): return Node()
        def expect_file_chooser(self, **kwargs): return Event()
        def wait_for_timeout(self, delay): raise TimeoutError('attachment not ready')
        def wait_for_function(self, script, arg, timeout):
            assert arg == 'a.png'
            if failure in {'unloaded', 'progress'}: raise TimeoutError('upload readiness not satisfied')
    adapter = DoubaoBrowser(tmp_path); adapter.page = Page()
    if failure is None:
        adapter.submit(tmp_path / 'a.png', 'exact prompt')
        assert sends == ['sent']
        assert adapter.pending is not None
    else:
        with pytest.raises(NeedsUser): adapter.submit(tmp_path / 'a.png', 'exact prompt')
        assert not sends
        assert adapter.pending is None
