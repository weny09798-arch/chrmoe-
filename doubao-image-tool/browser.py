"""Visible, standard Chrome DOM automation; no model API or session export."""
import io
import re
import time
from pathlib import Path
from urllib.parse import urlsplit
from PIL import Image
from core import NeedsUser, SubmissionUncertain

RESULT_SELECTOR = '[data-testid="message_image_content"][data-finished="true"] [data-testid="mdbox_image"] img[alt="image"]'
IMAGE_OBSERVATION = '''imgs => imgs.map(img => ({src:img.currentSrc || img.src,
 complete:img.complete,natural_width:img.naturalWidth,natural_height:img.naturalHeight,
 finished:!!img.closest('[data-finished="true"]'),generated:!!img.closest('[data-testid="mdbox_image"]')}))'''

def _identity(src):
    match = re.search(r'/rc_gen_image/([a-fA-F0-9]{32})(?:\.|/|$)', urlsplit(src).path)
    return match.group(1).lower() if match else None

def _loaded(image):
    return image.get('complete') and image.get('natural_width', 0) > 0 and image.get('natural_height', 0) > 0

def select_result(candidates: list[dict], baseline: set[str]) -> dict | None:
    eligible = {}
    for candidate in candidates:
        identity = _identity(candidate.get('src', ''))
        if identity and identity not in baseline and _loaded(candidate) and candidate.get('finished') and candidate.get('generated'):
            eligible[identity] = dict(candidate, identity=identity)
    if len(eligible) > 1:
        raise NeedsUser('辨識結果：出現多張新生成圖片，請檢查 Chrome。')
    return next(iter(eligible.values()), None)

def select_fullsize(images: list[dict], identity: str) -> str:
    eligible = [image for image in images if _identity(image.get('src', '')) == identity and _loaded(image)
                and max(image['natural_width'], image['natural_height']) >= 1024
                and 'cgen' in image['src']]
    # Dimensions alone cannot distinguish a large cthumb from the original media.
    if not eligible:
        raise NeedsUser('下載：尚未讀取到同一結果的完整尺寸圖片，請檢查 Chrome 後重試。')
    eligible.sort(key=lambda image: image['natural_width'] * image['natural_height'], reverse=True)
    return eligible[0]['src']

class DoubaoBrowser:
    def __init__(self, profile_dir: Path, timeout_seconds=480):
        self.profile_dir = Path(profile_dir)
        self.timeout_seconds = timeout_seconds  # QueueService owns generation timeout.
        self.stage = '尚未開啟'
        self.pending = None
        self.page = self.context = self.playwright = None
        self._next_poll = 0

    def open(self):
        self.stage = '開啟 Chrome'
        from playwright.sync_api import sync_playwright
        try:
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            self.playwright = sync_playwright().start()
            self.context = self.playwright.chromium.launch_persistent_context(
                str(self.profile_dir), channel='chrome', headless=False, accept_downloads=True)
            self.context.set_default_timeout(10000)
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            self.page.goto('https://www.doubao.com/chat', wait_until='domcontentloaded')
        except Exception:
            raise NeedsUser('開啟 Chrome：請確認已安裝 Chrome，並關閉使用本工具專用設定檔的其他視窗。') from None

    def close(self):
        try:
            if self.context: self.context.close()
        finally:
            if self.playwright: self.playwright.stop()
            self.context = self.playwright = self.page = None

    def _signals(self):
        # Only visible dialogs/alerts; never scan historical conversation text.
        for node in self.page.locator('[role="dialog"], [role="alert"]').all():
            if not node.is_visible(): continue
            text = node.inner_text()
            if re.search('登录|登入|验证码|驗證|安全验证|安全驗證|次数|额度|額度|上限|稍后再试|稍後再試|失败|失敗', text):
                raise NeedsUser(f'{self.stage}：請在 Chrome 處理登入、驗證、額度或錯誤提示後繼續。')

    def _prepare(self, path, prompt):
        self.stage = '登入與新對話'
        self._signals()
        main = self.page.get_by_role('main')
        main.get_by_test_id('create_conversation_button').click()
        composer = main.locator('[contenteditable="true"]').filter(visible=True)
        if composer.count() != 1:
            raise NeedsUser('輸入：無法唯一辨識輸入框，請先在 Chrome 完成登入。')
        self.stage = '上傳圖片'
        main.get_by_test_id('upload_file_button').click()
        with self.page.expect_file_chooser(timeout=10000) as chooser:
            self.page.get_by_text('上传文件或图片', exact=True).click()
        chooser.value.set_files(str(path))
        # Confirm the exact staged file and absence of upload progress, without submitting.
        main.get_by_text(path.name, exact=True).first.wait_for(state='visible', timeout=30000)
        self.page.wait_for_function('''() => !Array.from(document.querySelectorAll('main [role="progressbar"], main [data-testid*="upload"]')).some(e => e.getAttribute('aria-busy') === 'true' || e.getAttribute('role') === 'progressbar')''', timeout=30000)
        self._signals()
        self.stage = '檢查提示詞'
        composer.fill(prompt)
        if composer.inner_text() != prompt:
            raise NeedsUser('輸入：提示詞未完整寫入，請檢查 Chrome。')
        send = main.get_by_test_id('chat_input_send_button')
        if not send.is_visible() or not send.is_enabled():
            raise NeedsUser('上傳：發送按鈕尚未就緒，請檢查圖片上傳。')
        return {_identity(x['src']) for x in self.page.locator(RESULT_SELECTOR).evaluate_all(IMAGE_OBSERVATION)} - {None}

    def submit(self, path: Path, prompt: str):
        try:
            baseline = self._prepare(Path(path), prompt)
        except NeedsUser: raise
        except Exception:
            raise NeedsUser(f'{self.stage}：操作未就緒，尚未發送；請檢查 Chrome 後繼續。') from None
        self.pending = {'baseline': baseline, 'identity': None}
        self.stage = '提交'
        try:
            self.page.get_by_test_id('chat_input_send_button').click(timeout=10000)
        except Exception:
            raise SubmissionUncertain('提交：可能已發送，請檢查 Chrome；明確重試才會再次提交。') from None
        self.stage = '等待生成'
        self._next_poll = 0

    def poll(self):
        if not self.pending: raise NeedsUser('等待：沒有可追蹤的請求，請檢查 Chrome。')
        if time.monotonic() < self._next_poll: return None
        self._next_poll = time.monotonic() + 1
        try:
            self._signals()
            if not self.pending['identity']:
                result = select_result(self.page.locator(RESULT_SELECTOR).evaluate_all(IMAGE_OBSERVATION), self.pending['baseline'])
                if result is None: return None
                self.pending['identity'] = result['identity']
            self.stage = '下載圖片'
            data = self._download()
            self.stage = '圖片已取得'
            return data
        except NeedsUser: raise
        except Exception:
            raise NeedsUser(f'{self.stage}：讀取失敗，請檢查 Chrome 後繼續等待同一結果。') from None

    def _download(self):
        identity = self.pending['identity']
        # Open only the matched new result; keep existing canvas on a download retry.
        close = self.page.get_by_test_id('canvas_close_btn')
        if not close.is_visible():
            candidates = self.page.locator(RESULT_SELECTOR)
            for index, image in enumerate(candidates.evaluate_all(IMAGE_OBSERVATION)):
                if _identity(image['src']) == identity:
                    candidates.nth(index).locator('..').click(); break
            else: raise NeedsUser('下載：生成圖片已不在畫面，請檢查 Chrome。')
        self.page.wait_for_function('''identity => Array.from(document.images).some(i => i.complete && i.naturalWidth > 0 && Math.max(i.naturalWidth,i.naturalHeight)>=1024 && (i.currentSrc||i.src).includes('/rc_gen_image/'+identity) && (i.currentSrc||i.src).includes('cgen'))''', arg=identity, timeout=15000)
        src = select_fullsize(self.page.locator('img').evaluate_all(IMAGE_OBSERVATION), identity)
        data = None
        button = self.page.get_by_test_id('edit_image_download_button')
        if button.is_visible():
            try:
                with self.page.expect_download(timeout=3000) as download:
                    button.click(timeout=3000)
                data = Path(download.value.path()).read_bytes()
                download.value.delete()
            except Exception:
                # Exact URL observed in the live DOM, never assembled from a thumbnail.
                data = None
        if data is None:
            response = self.context.request.get(src, timeout=30000)
            if not response.ok: raise NeedsUser('下載：完整尺寸圖片取得失敗，重試會繼續使用同一結果。')
            data = response.body()
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        if close.is_visible(): close.click(timeout=3000)
        return data
