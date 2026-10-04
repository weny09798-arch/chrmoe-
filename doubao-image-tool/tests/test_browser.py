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
