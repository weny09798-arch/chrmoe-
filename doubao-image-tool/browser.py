"""Visible, standard Chrome DOM automation; no model API or session export."""
from contextlib import nullcontext
import io
import json
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
ATTACHMENT_OBSERVATION = '''cards => {
 const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
 return cards.map(card => ({label:card.getAttribute('aria-label'),visible:visible(card),
 loaded:Array.from(card.querySelectorAll('img[alt="image"]')).some(i => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0),
 progress:Array.from(card.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-label="upload progress percent"], [aria-description="upload progress percent"]')).some(visible)}));
}'''

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
                and 'cgen' in image['src']]
    # Dimensions alone cannot distinguish a large cthumb from the original media.
    if not eligible:
        raise NeedsUser('下載：尚未讀取到同一結果的完整尺寸圖片，請檢查 Chrome 後重試。')
    eligible.sort(key=lambda image: image['natural_width'] * image['natural_height'], reverse=True)
    return eligible[0]['src']

class DoubaoBrowser:
    def _mode_diagnostics(self):
        """Failure-only structural observations; never collect conversation text."""
        labels = ('图片模式', '模型', '比例', '图像生成', '模型 Seedream 5.0 Flash')
        try:
            raw = self.page.get_by_role('main').evaluate('''main => {
                const labels = ['图片模式','模型','比例','图像生成','模型 Seedream 5.0 Flash'];
                const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
                const ancestors = e => {
                    const result = [];
                    for (let p=e.parentElement;p && main.contains(p);p=p.parentElement) {
                        const id=p.getAttribute('data-testid'); if(id) result.push(id);
                        if(result.length>=6) break;
                    } return result;
                };
                return {chat_input_count:main.querySelectorAll('[data-testid="chat_input"]').length,
                    editors:Array.from(main.querySelectorAll('[contenteditable="true"]')).filter(visible).slice(0,2).map(ancestors),
                    controls:labels.map(label => {
                        const nodes=Array.from(main.querySelectorAll('*')).filter(e => e.textContent.trim()===label &&
                            (e.tagName==='BUTTON' || e.getAttribute('role')==='button' || !Array.from(e.children).some(c=>c.textContent.trim()===label)));
                        return {label,count:nodes.length,visible_count:nodes.filter(visible).length,
                            nodes:nodes.filter(visible).slice(0,2).map(e=>({tag:e.tagName.toLowerCase(),
                                role:e.getAttribute('role') || (e.tagName==='BUTTON'?'button':''),
                                testid:e.getAttribute('data-testid') || '',ancestors:ancestors(e)}))};
                    })};
            }''')
            # Defense in depth: retain only expected keys, fixed mode labels and
            # bounded structural tokens even if a DOM boundary returns extra data.
            def token(value):
                return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value) else ''
            def ids(values): return [token(value) for value in values[:6] if token(value)] if isinstance(values, list) else []
            def number(value): return min(max(value, 0), 999) if type(value) is int else 0
            controls = []
            for control in raw.get('controls', [])[:10]:
                if not isinstance(control, dict) or control.get('label') not in labels: continue
                nodes = []
                for node in control.get('nodes', [])[:2]:
                    if isinstance(node, dict): nodes.append({key: token(node.get(key)) for key in ('tag', 'role', 'testid')} | {'ancestors': ids(node.get('ancestors', []))})
                controls.append({'label': control['label'], 'count': number(control.get('count')),
                                 'visible_count': number(control.get('visible_count')), 'nodes': nodes})
            return {'chat_input_count': number(raw.get('chat_input_count')),
                    'editors': [ids(values) for values in raw.get('editors', [])[:2]], 'controls': controls}
        except Exception:
            return {'diagnostics': 'unavailable'}

    def _mode_failure(self, message):
        return NeedsUser(message + '；模式結構診斷：' + json.dumps(self._mode_diagnostics(), ensure_ascii=False, separators=(',', ':')))

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

    def _wait_composer(self, main):
        composer = main.locator('[contenteditable="true"]').filter(visible=True)
        deadline = time.monotonic() + 5
        while True:
            count = composer.count()
            if count == 1: return composer
            if count > 1 or time.monotonic() >= deadline:
                raise NeedsUser('輸入：無法唯一辨識輸入框，請先在 Chrome 完成登入。')
            self.page.wait_for_timeout(250)

    def _wait_attachment(self, main, path):
        deadline = time.monotonic() + 15
        while True:
            cards = main.get_by_test_id('attachment-image-card').evaluate_all(ATTACHMENT_OBSERVATION)
            matching = [card for card in cards if card['visible'] and card['label'] == path.name]
            if len(matching) == 1 and matching[0]['loaded'] and not matching[0]['progress']:
                return
            if time.monotonic() >= deadline:
                raise NeedsUser('上傳：指定圖片尚未載入或仍在上傳，請檢查 Chrome。')
            self.page.wait_for_timeout(250)

    def _image_mode_ready(self, main):
        badge = any(node.is_visible() and node.inner_text().strip() == '图像生成'
                    for node in main.get_by_test_id('skill_input_exit_button').all())
        toolbar = main.get_by_test_id('chat_input')
        model = toolbar.get_by_role(
            'button', name=re.compile(r'^模型\s+Seedream 5\.0 Flash$'))
        if badge and model.count() == 1 and model.is_visible():
            self._mode_diagnostic = ''
            return True
        missing = []
        for name in ('图片模式', '模型', '比例'):
            control = toolbar.get_by_role('button', name=name, exact=True).filter(visible=True)
            if control.count() == 0:
                control = toolbar.get_by_text(name, exact=True).filter(visible=True)
            if control.count() != 1: missing.append(name)
        entered = badge or getattr(self, '_entered_image_mode', False)
        self._mode_diagnostic = ('未確認圖像生成；' if not entered else '') + '缺少唯一可見工具列：' + '、'.join(missing)
        return entered and not missing

    def _prepare(self, path, prompt):
        self.stage = '登入與新對話'
        self._entered_image_mode = False
        self._mode_diagnostic = ''
        self._signals()
        main = self.page.get_by_role('main')
        create = main.get_by_test_id('create_conversation_button').filter(visible=True)
        if create.count() == 0:
            # Fresh /chat guidance shows the functional control in the sidebar.
            create = self.page.get_by_test_id('create_conversation_button').filter(visible=True)
        if create.count() != 1:
            raise NeedsUser('新對話：無法唯一辨識可見的新對話按鈕，請檢查 Chrome。')
        create.click(timeout=5000)
        composer = self._wait_composer(main)
        reset_deadline = time.monotonic() + 5
        while composer.inner_text().strip() or main.get_by_test_id('attachment-image-card').filter(visible=True).count():
            if time.monotonic() >= reset_deadline:
                raise NeedsUser('新對話：輸入框或附件未清空，尚未發送；請檢查 Chrome。')
            self.page.wait_for_timeout(250)
        self.stage = '上傳圖片'
        upload = main.get_by_test_id('upload_file_button').filter(visible=True)
        if upload.count() == 1:
            upload.click(timeout=5000)
            with self.page.expect_file_chooser(timeout=10000) as chooser:
                self.page.get_by_text('上传文件或图片', exact=True).click()
            chooser.value.set_files(str(path))
        else:
            file_input = main.get_by_test_id('upload-file-input')
            if file_input.count() != 1 or file_input.get_attribute('type') != 'file':
                raise NeedsUser('上傳：找不到唯一圖片檔案輸入，請檢查 Chrome。')
            file_input.set_input_files(str(path), timeout=10000)
        # Actual cards name the file only via aria-label, never visible text.
        self._wait_attachment(main, path)
        self.stage = '確認圖像生成模式'
        if not self._image_mode_ready(main):
            main.get_by_role('button', name='图像生成', exact=True).click(timeout=5000)
            self._entered_image_mode = True
        mode_deadline = time.monotonic() + 5
        while not self._image_mode_ready(main):
            if time.monotonic() >= mode_deadline:
                raise self._mode_failure(f'模式：{self._mode_diagnostic}；請檢查 Chrome。')
            self.page.wait_for_timeout(250)
        composer = self._wait_composer(main)
        self._wait_attachment(main, path)
        self._signals()
        self.stage = '檢查提示詞'
        composer.fill(prompt)
        # Rich text paragraphs render one logical break as multiple innerText
        # newlines. Normalize only line-break runs; retain every other character.
        normalize_breaks = lambda value: re.sub(r'\n+', '\n', value.replace('\r\n', '\n').replace('\r', '\n'))
        if normalize_breaks(composer.inner_text()) != normalize_breaks(prompt):
            raise NeedsUser('輸入：提示詞未完整寫入，請檢查 Chrome。')
        if not self._image_mode_ready(main):
            raise self._mode_failure(f'模式：圖像生成工具列已變更，尚未發送；{self._mode_diagnostic}；請檢查 Chrome。')
        send = main.get_by_test_id('chat_input_send_button')
        if not send.is_visible() or not send.is_enabled():
            raise NeedsUser('上傳：發送按鈕尚未就緒，請檢查圖片上傳。')
        return {_identity(x['src']) for x in self.page.locator(RESULT_SELECTOR).evaluate_all(IMAGE_OBSERVATION)} - {None}

    def submit(self, path: Path, prompt: str, send_gate=nullcontext):
        try:
            baseline = self._prepare(Path(path), prompt)
        except NeedsUser: raise
        except Exception:
            detail = getattr(self, '_mode_diagnostic', '') if self.stage == '確認圖像生成模式' else ''
            if self.stage == '確認圖像生成模式':
                raise self._mode_failure(f'{self.stage}：操作未就緒，尚未發送；{detail}；請檢查 Chrome 後繼續。') from None
            raise NeedsUser(f'{self.stage}：操作未就緒，尚未發送；{detail}；請檢查 Chrome 後繼續。') from None
        with send_gate():
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
        self.page.wait_for_function('''identity => Array.from(document.images).some(i => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0 && (i.currentSrc||i.src).includes('/rc_gen_image/'+identity) && (i.currentSrc||i.src).includes('cgen'))''', arg=identity, timeout=12000)
        src = select_fullsize(self.page.locator('img').evaluate_all(IMAGE_OBSERVATION), identity)
        data = None
        button = self.page.get_by_test_id('edit_image_download_button')
        if button.is_visible():
            try:
                with self.page.expect_download(timeout=3000) as download:
                    button.click(timeout=3000)
                # Sync path/save_as wait indefinitely for completion. Cancel the
                # native transfer immediately and use the bounded request below
                # for the already observed full-size DOM media instead.
                download.value.cancel()
            except Exception:
                # Exact URL observed in the live DOM, never assembled from a thumbnail.
                data = None
        if data is None:
            response = self.context.request.get(src, timeout=8000)
            if not response.ok: raise NeedsUser('下載：完整尺寸圖片取得失敗，重試會繼續使用同一結果。')
            data = response.body()
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        if close.is_visible(): close.click(timeout=3000)
        return data

