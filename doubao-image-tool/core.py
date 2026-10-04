"""Serial, persistent queue. All browser calls run on the owning worker."""
from contextlib import contextmanager
import copy
import json
import threading
import time
import uuid
from pathlib import Path
from storage import validate_inputs, save_result

class NeedsUser(Exception):
    """Readiness failure before send, or a recoverable pending-request pause."""
class SubmissionUncertain(Exception):
    """Send may have reached the service; explicit retry is required."""

class SubmissionCancelled(Exception):
    """Preparation was cancelled before the Send commit."""

class StorageFailure(RuntimeError):
    """State could not be persisted; restart is required before more work."""

class QueueService:
    generation_timeout = 8 * 60
    poll_interval = .1

    def __init__(self, browser_factory, state_dir):
        self.factory = browser_factory
        self.state_dir = Path(state_dir).resolve(); self.state_dir.mkdir(parents=True, exist_ok=True)
        self.cv = threading.Condition(threading.RLock()); self.closed = False; self.browser = None
        self.open_requested = False; self.browser_message = ""; self.browser_busy = False
        self.job = None
        path = self.state_dir / 'job.json'
        if path.exists():
            self.job = json.loads(path.read_text(encoding='utf-8'))
            for item in self.job['items']:
                if item['status'] != 'completed':
                    if item['phase'] == 'ready':
                        item['status'] = 'queued'; item['message'] = '程式已重新啟動；此圖片尚未發送，待繼續處理。'
                    else:
                        item['status'] = 'needs-review'; item['message'] = '程式已重新啟動；請檢查 Chrome，明確重試後才會繼續。'
            if any(i['status'] != 'completed' for i in self.job['items']): self.job['status'] = 'paused'
            self._persist()
        self.worker = threading.Thread(target=self._run, name='doubao-browser', daemon=True); self.worker.start()

    def _check_storage(self):
        if self.job and self.job['status'] == 'storage-error':
            raise StorageFailure(self.job['message'])

    def _persist(self):
        if self.job is None:
            return
        self._check_storage()
        temp = self.state_dir / 'job.json.tmp'
        try:
            temp.write_text(json.dumps(self.job, ensure_ascii=False, indent=2), encoding='utf-8')
            temp.replace(self.state_dir / 'job.json')
        except Exception as exc:
            self.job['status'] = 'storage-error'
            self.job['message'] = f'任務狀態儲存失敗，請修復儲存位置並重新啟動：{exc}'
            raise StorageFailure(self.job['message']) from exc

    def start(self, files, output_dir, prompt):
        checked = validate_inputs(files)
        with self.cv:
            if self.closed: raise RuntimeError('服務已關閉')
            if self.job and self.job['status'] != 'completed': raise ValueError('請先完成目前任務')
            job_id = uuid.uuid4().hex; folder = self.state_dir / job_id; folder.mkdir()
            items = []
            for index, (name, data) in enumerate(checked):
                source = folder / f'{index}{Path(name).suffix.lower()}'; source.write_bytes(data)
                items.append({'index': index, 'name': name, 'input_path': str(source), 'status': 'queued',
                              'phase': 'ready', 'message': '', 'result': None, 'review_needed': True})
            self.job = {'id': job_id, 'status': 'running', 'output_dir': str(Path(output_dir).resolve()),
                        'prompt': prompt, 'items': items, 'message': '', 'review_needed': True}
            self._persist(); self.cv.notify_all(); return job_id

    def snapshot(self, job_id=None):
        with self.cv:
            if job_id and (not self.job or job_id != self.job['id']): raise KeyError(job_id)
            state = copy.deepcopy(self.job) if self.job else {'id': None, 'status': 'idle', 'items': [], 'message': ''}
            state.update(browser_stage=getattr(self.browser, 'stage', '尚未开启'), browser_message=self.browser_message, browser_busy=self.browser_busy)
            return state

    def open_browser(self):
        with self.cv:
            self._check_storage()
            if self.closed: raise RuntimeError("服务已关闭，请重新启动")
            self.open_requested = True; self.browser_busy = True; self.browser_message = "正在打开 Chrome"; self.cv.notify_all()

    def _open(self):
        if self.browser is None:
            browser = self.factory()
            try: browser.open()
            except Exception:
                browser.close()
                raise
            with self.cv: self.browser = browser

    def action(self, command, index=None):
        with self.cv:
            if not self.job: raise ValueError('沒有任務')
            if self.closed or self.job['status'] == 'storage-error':
                raise RuntimeError('服務已停止，請修復儲存位置並重新啟動')
            if command == 'stop': self.job['status'] = 'stopped'
            elif command == 'continue':
                if any(i['status'] == 'needs-review' or i['phase'] == 'uncertain' for i in self.job['items']): return
                for i in self.job['items']:
                    if i['status'] == 'paused': i['status'] = 'queued'; i.pop('started', None)
                self.job['status'] = 'running'
            elif command in {'retry', 'redo'}:
                if index is None or not 0 <= index < len(self.job['items']): raise ValueError('請選擇有效圖片')
                item = self.job['items'][index]
                if self.job['status'] == 'running': raise ValueError('請先停止任務')
                if command == 'redo' or item['status'] == 'needs-review' or item['phase'] not in {'saving', 'pending'}:
                    item['revision'] = item.get('revision', 0) + 1
                    item['phase'] = 'ready'
                    item.pop('cached_path', None)
                item['status'] = 'queued'; item['message'] = ''; item.pop('started', None)
                self.job['status'] = 'running'
            else: raise ValueError('未知操作')
            self._persist(); self.cv.notify_all()

    def _pause(self, item, message):
        self._check_storage()
        item['status'] = 'paused'; item['message'] = message
        self.job['status'] = 'paused'; self.job['message'] = message; self._persist()

    def _run(self):
        try:
            while True:
                with self.cv:
                    self.cv.wait_for(lambda: self.closed or self.open_requested or (self.job and self.job['status'] == 'running'))
                    if self.closed: return
                    if self.open_requested:
                        self.open_requested = False
                        self.cv.release()
                        try:
                            self._open()
                            message = "Chrome 已打开，请在独立窗口登录豆包"
                        except Exception as exc: message = str(exc)
                        finally: self.cv.acquire()
                        self.browser_message = message; self.browser_busy = False
                        continue
                    item = next((i for i in self.job['items'] if i['status'] != 'completed'), None)
                    if item is None:
                        self.job['status'] = 'completed'; self.job['message'] = '圖片已生成並儲存；請人工確認繁體字和文案。'; self._persist(); continue
                    if item['status'] == 'needs-review':
                        self._pause(item, '請檢查 Chrome 後明確重試'); item['status'] = 'needs-review'; self._persist(); continue
                    phase = item['phase']
                    revision = item.get('revision', 0)
                try:
                    if phase == 'ready':
                        if self.browser is None:
                            browser = self.factory()
                            try: browser.open()
                            except Exception:
                                browser.close()
                                raise
                            self.browser = browser
                        with self.cv:
                            if self.closed or self.job['status'] != 'running' or item.get('revision', 0) != revision:
                                continue
                            item['phase'] = 'submitting'; item['status'] = 'running'; self._persist()
                        @contextmanager
                        def send_gate():
                            # Only the worker executes the DOM click; stop/close/revision changes
                            # serialize against this last authorization and Send commit.
                            with self.cv:
                                self._check_storage()
                                if self.closed or self.job['status'] != 'running' or item.get('revision', 0) != revision:
                                    raise SubmissionCancelled()
                                yield
                        self.browser.submit(Path(item['input_path']), self.job['prompt'], send_gate)
                        with self.cv:
                            self._check_storage()
                            if item.get('revision', 0) != revision:
                                continue
                            item['phase'] = 'pending'
                            item['started'] = time.time()
                            self._persist()
                    elif phase == 'pending':
                        if self.browser is None: raise SubmissionUncertain('重新啟動後請檢查並明確重試')
                        data = self.browser.poll()
                        with self.cv:
                            self._check_storage()
                            if item.get('revision', 0) != revision:
                                continue
                            if data is not None:
                                cached = Path(item['input_path']).with_suffix('.result'); cached.write_bytes(data)
                                item['cached_path'] = str(cached); item['phase'] = 'saving'; self._persist()
                            elif time.time() - item.setdefault('started', time.time()) >= self.generation_timeout:
                                self._pause(item, '生成等待超過 8 分鐘；請檢查 Chrome，繼續將等待同一請求。')
                        if data is None:
                            with self.cv: self.cv.wait(timeout=self.poll_interval)
                    elif phase == 'saving':
                        result = save_result(self.job['output_dir'], item['name'], Path(item['cached_path']).read_bytes(), self.job['prompt'])
                        with self.cv:
                            self._check_storage()
                            if item.get('revision', 0) != revision:
                                continue
                            item['result'] = result
                            item['status'] = 'completed'
                            item['phase'] = 'done'
                            item['message'] = '已儲存，請人工檢查。'
                            self._persist()
                    else:
                        with self.cv: self._pause(item, '提交狀態不確定；請明確重試。')
                except SubmissionCancelled:
                    with self.cv:
                        self._check_storage()
                        if item.get('revision', 0) == revision:
                            item['phase'] = 'ready'; item['status'] = 'queued'
                            self._persist()
                except StorageFailure:
                    raise
                except NeedsUser as exc:
                    with self.cv:
                        self._check_storage()
                        if item.get('revision', 0) != revision:
                            continue
                        if item['phase'] == 'submitting': item['phase'] = 'ready'
                        self._pause(item, str(exc))
                except SubmissionUncertain as exc:
                    with self.cv:
                        self._check_storage()
                        if item.get('revision', 0) != revision:
                            continue
                        item['phase'] = 'uncertain'
                        self._pause(item, str(exc))
                except Exception as exc:
                    with self.cv:
                        self._check_storage()
                        if item.get('revision', 0) != revision:
                            continue
                        if item['phase'] == 'submitting': item['phase'] = 'uncertain'
                        self._pause(item, f'{item["phase"]}：{exc}')
        except StorageFailure:
            # _persist already records terminal failure in memory; never persist it again.
            pass
        finally:
            if self.browser is not None: self.browser.close()

    def request_close(self):
        """Cancel synchronously without joining or touching worker-owned browser objects."""
        with self.cv: self.closed = True; self.cv.notify_all()

    def close(self):
        self.request_close()
        self.worker.join(timeout=30)
        if self.worker.is_alive(): raise RuntimeError('瀏覽器操作尚未結束')
