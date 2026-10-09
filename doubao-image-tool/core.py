"""Serial, persistent queue. All browser calls run on the owning worker."""
from contextlib import contextmanager
import copy
import json
import threading
import time
import uuid
import hashlib
from datetime import datetime
from pathlib import Path
from storage import validate_inputs, save_result, clear_task_state
from image_batch import build_items, counts, download_image, save_positions, write_report
from aliyun_translation import AliyunError, validate_aliyun_image, download_aliyun_result, PRICE_PER_IMAGE
from credentials import CredentialError
from license_authority import LicenseAuthority, LicenseRequiredError
from oss_storage import OSSError
from cloud_images import save_cached_result,clean_cached_images

IMAGE_KINDS = ('main', 'detail', 'sku')

def image_limit_options(image_limits, kinds):
    if image_limits is None:
        image_limits = {}
    if not isinstance(image_limits, dict):
        raise ValueError('图片数量设置无效')
    limits = dict.fromkeys(IMAGE_KINDS)
    for kind in kinds:
        value = image_limits.get(kind)
        if value is not None and (type(value) is not int or not 1 <= value <= 9007199254740991):
            raise ValueError('图片数量必须是正整数（最大 9007199254740991），留空不限')
        limits[kind] = value
    return limits


def select_image_entries(entries, kinds, limits):
    selected = []
    used = dict.fromkeys(IMAGE_KINDS, 0)
    for entry in entries:
        if not isinstance(entry, dict) or entry.get('kind') not in kinds:
            continue
        kind = entry['kind']
        if limits[kind] is None or used[kind] < limits[kind]:
            selected.append(entry)
            used[kind] += 1
    return selected

def conversion_options(provider, image_kinds):
    if provider not in ('doubao', 'aliyun'): raise ValueError('转换服务无效')
    kinds = list(IMAGE_KINDS) if image_kinds is None else image_kinds
    if not isinstance(kinds, list) or not kinds or any(k not in IMAGE_KINDS for k in kinds):
        raise ValueError('请选择有效的图片类型')
    return list(dict.fromkeys(kinds))

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
    license_poll_interval = 1.0

    def __init__(self, browser_factory, state_dir, aliyun_factory=None, oss_factory=None, license_authority=None):
        self.factory = browser_factory
        self.aliyun_factory = aliyun_factory
        self.oss_factory = oss_factory
        self.state_dir = Path(state_dir).resolve(); self.state_dir.mkdir(parents=True, exist_ok=True)
        self.cv = threading.Condition(threading.RLock()); self.closed = False; self.browser = None
        self.clear_on_close = False
        self.open_requested = False; self.browser_message = ""; self.browser_busy = False
        self.job = None
        path = self.state_dir / 'job.json'
        if path.exists():
            self.job = json.loads(path.read_text(encoding='utf-8'))
            self.job.setdefault('provider', 'doubao')
            self.job.setdefault('image_kinds', list(IMAGE_KINDS))
            self.job.setdefault('image_limits', dict.fromkeys(IMAGE_KINDS))
            self.job.setdefault('paid_calls', 0)
            self.job.setdefault('estimated_cost_upper', 0)
            for item in self.job['items']:
                for ref in item.get('refs',[]):
                    ref.setdefault('sku_index',ref['order']-1 if ref['kind']=='sku' else None)
                if item['status'] not in {'completed', 'failed'}:
                    if item['phase'] in {'uploading','upload-failed'} and item.get('result'):
                        item.update(phase='uploading',status='queued',message='已有本地转换图，继续只上传 OSS，不重新翻译。')
                    elif item.get('aliyun_result'):
                        item['phase'] = 'saving' if item.get('cached_path') and Path(item['cached_path']).is_file() else 'aliyun-downloading'
                        item['status'] = 'queued'; item['message'] = '程序已重新启动，继续将获取已有阿里云结果，不重新提交。'
                    elif item['phase'] in {'ready', 'aliyun-ready', 'downloading', 'alias', 'saving'}:
                        item['status'] = 'queued'; item['message'] = '程式已重新啟動；此圖片尚未發送，待繼續處理。'
                    elif item['phase'] == 'pending' and item.get('download_recovery',{}).get('conversation_url'):
                        item['status'] = 'paused'; item['message'] = '程序已重新启动，可继续获取已生成结果，不重新提交。'
                    else:
                        item['status'] = 'needs-review'; item['message'] = '程式已重新啟動；請檢查 Chrome，明確重試後才會繼續。'
            if any(i['status'] not in {'completed', 'failed'} for i in self.job['items']): self.job['status'] = 'paused'
            self._persist()
            for item in self.job['items']:
                if item['status']=='completed' and item.get('upload_result'):clean_cached_images(self.job,item,self.state_dir)
        self.license = license_authority if license_authority is not None else LicenseAuthority(self.state_dir.parent)
        self._license_blocked = None
        self._license_stop = threading.Event()
        self.license.startup()
        self.license_worker = threading.Thread(target=self._monitor_license, name='license-monitor', daemon=True)
        self.license_worker.start()
        self.worker = threading.Thread(target=self._run, name='doubao-browser', daemon=True); self.worker.start()

    def _observe_license(self, status):
        with self.cv:
            if not status.allowed and self.job and self.job['status'] == 'running':
                self._license_blocked = status
        return status

    def license_status(self):
        return self._observe_license(self.license.status())

    def activate_license(self, code):
        return self._observe_license(self.license.activate(code))

    def refresh_license(self):
        return self._observe_license(self.license.refresh())

    def _monitor_license(self):
        while not self._license_stop.wait(self.license_poll_interval):
            self.license_status()

    def _check_license(self, *, force_refresh):
        try:
            return self.license.require_new_work(force_refresh=force_refresh)
        except LicenseRequiredError as exc:
            self._observe_license(exc.status)
            raise

    def _require_new_work(self, *, force_refresh=False, manual=False):
        status = self._check_license(force_refresh=force_refresh)
        if manual:
            self._license_blocked = None
        elif self._license_blocked is not None:
            raise LicenseRequiredError(self._license_blocked)
        return status

    @staticmethod
    def _existing_result(item):
        return item['phase'] in {'pending', 'saving', 'aliyun-downloading', 'uploading', 'upload-failed', 'alias'}

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
            if self.job.get('kind') == 'collector': write_report(self.job)
        except Exception as exc:
            self.job['status'] = 'storage-error'
            self.job['message'] = f'任務狀態儲存失敗，請修復儲存位置並重新啟動：{exc}'
            raise StorageFailure(self.job['message']) from exc

    def start(self, files, output_dir, prompt, provider='doubao', paid_confirmed=False):
        self._check_license(force_refresh=True)
        conversion_options(provider,None)
        if provider=='aliyun':
            if paid_confirmed is not True:raise ValueError('阿里云转换按 ¥0.06/张计费，请先确认付费')
            if self.aliyun_factory is None:raise ValueError('请先在本机工具配置阿里云 AccessKey')
            self.aliyun_factory()
        checked = validate_inputs(files)
        with self.cv:
            if self.closed: raise RuntimeError('服務已關閉')
            if self.job and self.job['status'] != 'completed': raise ValueError('請先完成目前任務')
            self._license_blocked = None
            job_id = uuid.uuid4().hex; folder = self.state_dir / job_id; folder.mkdir()
            items = []
            for index, (name, data) in enumerate(checked):
                source = folder / f'{index}{Path(name).suffix.lower()}'; source.write_bytes(data)
                items.append({'index': index, 'name': name, 'input_path': str(source), 'status': 'queued',
                              'phase': 'aliyun-ready' if provider=='aliyun' else 'ready', 'message': '', 'result': None, 'review_needed': True})
            self.job = {'id': job_id, 'status': 'running', 'output_dir': str(Path(output_dir).resolve()),
                        'prompt': prompt, 'items': items, 'message': '', 'review_needed': True}
            self.job.update(provider=provider,image_kinds=list(IMAGE_KINDS),paid_calls=0,
                            estimated_cost_upper=round(len(items)*PRICE_PER_IMAGE,2) if provider=='aliyun' else 0)
            self._persist(); self.cv.notify_all(); return job_id

    def start_urls(self, entries, output_dir, prompt, source_task_id, provider='doubao', image_kinds=None, paid_confirmed=False, cloud_only=False, image_limits=None):
        self._check_license(force_refresh=True)
        kinds = conversion_options(provider, image_kinds)
        limits = image_limit_options(image_limits, kinds)
        if not isinstance(entries, list): raise ValueError('图片清单无效')
        items = build_items(select_image_entries(entries, kinds, limits))
        if provider == 'aliyun':
            if paid_confirmed is not True: raise ValueError('阿里云转换按 ¥0.06/张计费，请先确认付费')
            if self.aliyun_factory is None: raise ValueError('请先在本机工具配置阿里云 AccessKey')
            self.aliyun_factory()  # Snapshot configuration only; never makes a paid call.
        if not isinstance(source_task_id, str) or not source_task_id: raise ValueError('缺少采集任务ID')
        output = None if cloud_only else Path(output_dir).expanduser().resolve()
        publisher = self.oss_factory() if self.oss_factory else None
        if cloud_only and publisher is None:raise OSSError('configuration')
        if output is not None and output.exists() and not output.is_dir(): raise ValueError('输出位置必须是目录')
        with self.cv:
            if self.closed: raise RuntimeError('服务已关闭')
            if self.job and self.job['status'] != 'completed': raise ValueError('请先完成目前任务')
            self._license_blocked = None
            job_id = uuid.uuid4().hex
            folder = self.state_dir / job_id; folder.mkdir()
            if output is not None:output.mkdir(parents=True, exist_ok=True)
            run = folder/'converted' if cloud_only else output / ('图片转换_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + job_id[:12])
            run.mkdir()
            self.job = {'id': job_id, 'kind': 'collector', 'source_task_id': source_task_id,
                        'status': 'running', 'output_dir': str(output) if output is not None else None, 'run_dir': str(run), 'cloud_only':bool(cloud_only),
                        'mapping_path': str(run / '图片转换对应记录.json'),
                        'prompt': prompt, 'items': items, 'message': '', 'review_needed': True}
            self.job.update(provider=provider, image_kinds=kinds, image_limits=limits, paid_calls=0,
                            upload_enabled=publisher is not None,oss_target_id=publisher.target_id if publisher else None,
                            estimated_cost_upper=round(len(items)*PRICE_PER_IMAGE, 2) if provider=='aliyun' else 0)
            self._persist(); self.cv.notify_all(); return job_id

    def snapshot(self, job_id=None):
        license_status = self.license_status().to_dict()
        with self.cv:
            if job_id and (not self.job or job_id != self.job['id']): raise KeyError(job_id)
            state = copy.deepcopy(self.job) if self.job else {'id': None, 'status': 'idle', 'items': [], 'message': ''}
            state['license'] = license_status
            state.setdefault('provider', 'doubao'); state.setdefault('image_kinds', list(IMAGE_KINDS))
            state.setdefault('image_limits', dict.fromkeys(IMAGE_KINDS))
            state.setdefault('paid_calls', 0); state.setdefault('estimated_cost_upper', 0)
            for item in state['items']:
                item.pop('aliyun_result', None)
            state.update(browser_stage=getattr(self.browser, 'stage', '尚未开启'), browser_message=self.browser_message, browser_busy=self.browser_busy)
            if state.get('kind') == 'collector': state['counts'] = counts(state)
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
        elif callable(getattr(self.browser,'is_open',None)) and not self.browser.is_open():
            self.browser.open()

    def action(self, command, index=None, paid_confirmed=False):
        with self.cv:
            if not self.job: raise ValueError('沒有任務')
            if self.closed or self.job['status'] == 'storage-error':
                raise RuntimeError('服務已停止，請修復儲存位置並重新啟動')
            if command == 'stop': self.job['status'] = 'stopped'
            elif command == 'continue':
                if any(i['status'] == 'needs-review' or i['phase'] == 'uncertain' for i in self.job['items']): return
                remaining = [i for i in self.job['items'] if i['status'] not in {'completed', 'failed'}]
                if not any(self._existing_result(i) for i in remaining):
                    self._require_new_work(force_refresh=True, manual=True)
                elif self.license_status().allowed:
                    try:
                        self._require_new_work(force_refresh=True, manual=True)
                    except LicenseRequiredError as exc:
                        # A newly received denial stops new work, not retrieval already owed.
                        self._license_blocked = exc.status
                for i in self.job['items']:
                    if i['status'] == 'paused': i['status'] = 'queued'; i.pop('started', None)
                self.job['status'] = 'running'; self.job['message'] = ''
            elif command == 'retry-upload':
                if index is None or not 0 <= index < len(self.job['items']):raise ValueError('请选择有效图片')
                if self.job['status']=='running':raise ValueError('请先停止任务')
                item=self.job['items'][index]
                if 'alias_of' in item:item=self.job['items'][item['alias_of']]
                if not self.job.get('upload_enabled') or not item.get('result') or not Path(item['result']['output_path']).is_file():raise ValueError('没有可上传的本地转换图')
                self._publisher(self.job)
                item.update(phase='uploading',status='queued',message='');self.job.update(status='running',message='')
            elif command in {'retry', 'redo'}:
                if index is None or not 0 <= index < len(self.job['items']): raise ValueError('請選擇有效圖片')
                item = self.job['items'][index]
                if self.job['status'] == 'running': raise ValueError('請先停止任務')
                aliyun = self.job.get('provider') == 'aliyun'
                if aliyun and command == 'redo':
                    if paid_confirmed is not True: raise ValueError('重新生成会再次按 ¥0.06/张计费，请先确认付费')
                    if self.aliyun_factory is None: raise ValueError('请先配置阿里云 AccessKey')
                    self.aliyun_factory()
                alias_retry = ('alias_of' in item and command == 'retry'
                    and self.job['items'][item['alias_of']]['status'] == 'completed')
                if 'alias_of' in item and not alias_retry:
                    item = self.job['items'][item['alias_of']]
                if aliyun and command == 'retry' and not alias_retry and (
                    item['status'] == 'completed'
                    or item['phase'] in {'done', 'submitting', 'uncertain', 'aliyun-failed'}
                ):
                    raise ValueError('此图片需要重新付费生成，请明确确认付费')
                retrieves_existing = alias_retry or (aliyun and item.get('aliyun_result')) or (
                    item['status'] != 'needs-review' and item['phase'] in {'saving', 'pending', 'aliyun-downloading'})
                if command == 'redo' or not retrieves_existing:
                    self._require_new_work(force_refresh=True, manual=True)
                if alias_retry:
                    item['phase'] = 'alias'
                elif aliyun and command == 'retry' and item.get('aliyun_result'):
                    item['phase'] = ('saving' if item.get('cached_path')
                        and Path(item['cached_path']).is_file() else 'aliyun-downloading')
                elif command == 'redo' or item['status'] == 'needs-review' or item['phase'] not in {'saving', 'pending', 'aliyun-downloading'}:
                    item['revision'] = item.get('revision', 0) + 1
                    item['phase'] = ('aliyun-ready' if aliyun else 'ready') if item.get('input_path') and Path(item['input_path']).is_file() else 'downloading'
                    item['result'] = None
                    item.pop('upload_result',None)
                    item.pop('cached_path', None)
                    item.pop('download_recovery', None)
                    item.pop('aliyun_result', None)
                    if aliyun and command == 'redo':
                        self.job['estimated_cost_upper'] = round(self.job.get('estimated_cost_upper', 0)+PRICE_PER_IMAGE,2)
                    for ref in item.get('refs', []): ref['output_path'] = None
                    for dependent in self.job['items']:
                        if dependent.get('alias_of') == item['index']:
                            dependent.update(phase='alias', status='queued', message='', result=None)
                            dependent['revision'] = dependent.get('revision', 0) + 1
                            for ref in dependent['refs']: ref['output_path'] = None
                item['status'] = 'queued'; item['message'] = ''; item.pop('started', None)
                self.job['status'] = 'running'; self.job['message'] = ''
            else: raise ValueError('未知操作')
            self._persist(); self.cv.notify_all()

    def _pause(self, item, message):
        self._check_storage()
        item['status'] = 'paused'; item['message'] = message
        self.job['status'] = 'paused'; self.job['message'] = message; self._persist()

    def _publisher(self, job):
        if not job.get('upload_enabled'):return None
        if self.oss_factory is None:raise OSSError('configuration')
        publisher=self.oss_factory()
        if publisher.target_id!=job.get('oss_target_id'):raise OSSError('configuration')
        return publisher

    def _publish_refs(self, item, published, revision):
        item['upload_result']=copy.deepcopy(published)
        if self.job.get('cloud_only'):item['result']['public_url']=published['url']
        for ref in item['refs']:
            ref.update(published_url=published['url'],published_revision=revision)
        item.update(status='completed',phase='done',message='转换图已保存到 OSS，可用于商品 Excel。' if self.job.get('cloud_only') else '转换图已保存本地并上传 OSS，可用于商品 Excel。')

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
                    waiting = [i for i in self.job['items'] if i['status'] not in {'completed', 'failed'}]
                    # Retrieval and upload retries must not sit behind blocked new work.
                    waiting.sort(key=lambda i: not self._existing_result(i))
                    item = next((i for i in waiting if i['phase'] != 'alias'
                        or self.job['items'][i['alias_of']]['status'] in {'completed','failed'}), None)
                    if item is None and waiting:
                        self._pause(waiting[0], '请先继续或重试相同图片的原任务'); continue
                    if item is None:
                        status = self.license_status()
                        if not status.allowed or self._license_blocked is not None:
                            self.job.update(status='paused', message=(self._license_blocked or status).message)
                            self._persist(); continue
                        self.job['status'] = 'completed'; self.job['message'] = '圖片已生成並儲存；請人工確認繁體字和文案。'; self._persist(); continue
                    if item['status'] == 'needs-review':
                        self._pause(item, '請檢查 Chrome 後明確重試'); item['status'] = 'needs-review'; self._persist(); continue
                    phase = item['phase']
                    revision = item.get('revision', 0)
                    active_job = self.job
                try:
                    if phase in {'ready', 'aliyun-ready', 'downloading'}:
                        self._require_new_work()
                    if phase in {'ready','aliyun-ready'}:self._publisher(active_job)
                    if phase == 'downloading':
                        data, extension = download_image(item['url'])
                        digest = hashlib.sha256(data).hexdigest()
                        with self.cv:
                            self._check_storage()
                            if self.closed or self.job['status'] != 'running' or item.get('revision', 0) != revision: continue
                            source = self.state_dir / self.job['id'] / f"{item['index']}{extension}"
                            source.write_bytes(data)
                            item.update(input_path=str(source), sha256=digest, phase='aliyun-ready' if self.job.get('provider')=='aliyun' else 'ready')
                            previous = next((other for other in self.job['items'] if other is not item
                                and other.get('sha256') == digest and 'alias_of' not in other), None)
                            if previous is not None: item.update(alias_of=previous['index'], phase='alias')
                            self._persist()
                    elif phase == 'alias':
                        with self.cv:
                            original = self.job['items'][item['alias_of']]
                            if active_job.get('cloud_only') and original.get('result') and original['status'] in {'completed','failed'}:
                                item['result']=copy.deepcopy(original['result'])
                                if original.get('upload_result'):
                                    self._publish_refs(item,original['upload_result'],original.get('revision',0))
                                else:item.update(status='failed',phase='upload-failed',message='相同图片的 OSS 上传失败，请重试上传。')
                                self._persist()
                                if item.get('upload_result'):clean_cached_images(active_job,item,self.state_dir)
                                continue
                            if original['status']=='failed' and not original.get('result'):
                                item.update(status='failed',phase='aliyun-failed' if active_job.get('provider')=='aliyun' else 'download-failed',message='相同图片的原任务失败，请检查原任务。')
                                self._persist();continue
                            if original['status'] not in {'completed','failed'}:
                                self._pause(item, '请先继续或重试相同图片的原任务'); continue
                            refs = copy.deepcopy(item['refs'])
                            data = Path(original['result']['output_path']).read_bytes()
                        result = save_positions(active_job, refs, data)
                        with self.cv:
                            self._check_storage()
                            if self.closed or self.job is not active_job or item.get('revision', 0) != revision: continue
                            item.update(refs=refs, result=result,status='completed',phase='done',message='已复用转换结果，请人工检查。')
                            if active_job.get('upload_enabled'):
                                if original.get('upload_result'):
                                    self._publish_refs(item,original['upload_result'],original.get('revision',0))
                                else:
                                    item.update(status='failed',phase='upload-failed',message='相同图片的 OSS 上传失败，请重试上传。')
                            self._persist()
                    elif phase in {'aliyun-ready', 'ready'} and active_job.get('provider') == 'aliyun':
                        validate_aliyun_image(Path(item['input_path']).read_bytes(),item['name'])
                        try: translator = self.aliyun_factory()
                        except CredentialError: raise AliyunError('auth') from None
                        with self.cv:
                            self._check_storage()
                            if self.closed or self.job is not active_job or self.job['status'] != 'running' or item.get('revision',0) != revision: continue
                            self._publisher(active_job)
                            self._require_new_work()
                            item.update(phase='submitting',status='running')
                            self.job['paid_calls'] += 1
                            self._persist()
                        # The committed attempt includes timeouts and uncertain responses.
                        result = translator.translate(Path(item['input_path']))
                        with self.cv:
                            self._check_storage()
                            if self.job is not active_job or item.get('revision',0) != revision: continue
                            # Stop does not discard the paid result. Clear waits for this worker.
                            item.update(aliyun_result=result,phase='aliyun-downloading',status='queued')
                            self._persist()
                    elif phase == 'aliyun-downloading':
                        data, extension = download_aliyun_result(item['aliyun_result']['final_image_url'])
                        validate_inputs([('result'+extension,data)])
                        with self.cv:
                            self._check_storage()
                            if self.closed or self.job is not active_job or self.job['status'] != 'running' or item.get('revision',0) != revision: continue
                            cached = Path(item['input_path']).with_suffix('.result');cached.write_bytes(data)
                            item.update(cached_path=str(cached),phase='saving');self._persist()
                    elif phase == 'ready':
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
                                self._publisher(active_job)
                                self._require_new_work()
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
                        if self.browser is None:
                            recovery = item.get('download_recovery')
                            if not recovery: raise SubmissionUncertain('重新啟動後請檢查並明確重試')
                            self._open()
                            self.browser.resume_from(recovery)
                        elif item.get('download_recovery') and callable(getattr(self.browser,'recovery_state',None)) and not self.browser.recovery_state():
                            self.browser.resume_from(item['download_recovery'])
                        try:
                            data = self.browser.poll()
                        finally:
                            get_recovery = getattr(self.browser,'recovery_state',None)
                            if callable(get_recovery):
                                recovery = get_recovery()
                                with self.cv:
                                    if item.get('revision',0)==revision and recovery and recovery!=item.get('download_recovery'):
                                        item['download_recovery'] = recovery
                                        self._persist()
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
                        refs = copy.deepcopy(item.get('refs', []))
                        if self.job.get('kind') == 'collector':
                            result = save_cached_result(active_job,item,Path(item['cached_path']).read_bytes()) if active_job.get('cloud_only') else save_positions(self.job, refs, Path(item['cached_path']).read_bytes())
                        else:
                            result = save_result(self.job['output_dir'], item['name'], Path(item['cached_path']).read_bytes(), self.job['prompt'])
                        with self.cv:
                            self._check_storage()
                            if item.get('revision', 0) != revision:
                                continue
                            item['result'] = result
                            if refs: item['refs'] = refs
                            item['status'] = 'queued' if active_job.get('upload_enabled') else 'completed'
                            item['phase'] = 'uploading' if active_job.get('upload_enabled') else 'done'
                            item['message'] = '已儲存，請人工檢查。'
                            self._persist()
                    elif phase == 'uploading':
                        publisher=self._publisher(active_job)
                        with self.cv:
                            if self.closed or self.job is not active_job or self.job['status']!='running' or item.get('revision',0)!=revision:continue
                        published=publisher.publish(Path(item['result']['output_path']))
                        with self.cv:
                            self._check_storage()
                            if self.closed or self.job is not active_job or item.get('revision',0)!=revision:continue
                            self._publish_refs(item,published,revision)
                            for dependent in active_job['items']:
                                if dependent.get('alias_of')==item['index'] and dependent.get('result'):
                                    self._publish_refs(dependent,published,revision)
                            self._persist()
                            clean_cached_images(active_job,item,self.state_dir)
                            for dependent in active_job['items']:
                                if dependent.get('alias_of')==item['index'] and dependent.get('upload_result'):clean_cached_images(active_job,dependent,self.state_dir)
                    else:
                        with self.cv: self._pause(item, '提交狀態不確定；請明確重試。')
                except LicenseRequiredError as exc:
                    with self.cv:
                        self._check_storage()
                        if self.job is not active_job or item.get('revision', 0) != revision: continue
                        if item['phase'] == 'submitting':
                            item['phase'] = phase
                            if active_job.get('provider') == 'aliyun':
                                self.job['paid_calls'] -= 1
                        self._license_blocked = exc.status
                        self._pause(item, exc.status.message)
                except SubmissionCancelled:
                    with self.cv:
                        self._check_storage()
                        if item.get('revision', 0) == revision:
                            item['phase'] = 'ready'; item['status'] = 'queued'
                            self._persist()
                except StorageFailure:
                    raise
                except OSSError as exc:
                    with self.cv:
                        if self.closed or self.job is not active_job or item.get('revision',0)!=revision:continue
                        if phase=='uploading':item['phase']='upload-failed'
                        elif item['phase']=='submitting':item['phase']=phase
                        item['message']=str(exc)
                        if exc.kind=='configuration' and self.job['status']=='running':self._pause(item,str(exc))
                        else:
                            item['status']='paused' if exc.kind=='configuration' else 'failed'
                            self._persist()
                except AliyunError as exc:
                    with self.cv:
                        self._check_storage()
                        if self.job is not active_job or item.get('revision',0) != revision: continue
                        if exc.kind == 'image':
                            item.update(status='failed',phase='aliyun-failed',message=str(exc));self._persist()
                        else:
                            item['phase'] = 'uncertain' if exc.kind=='uncertain' else 'aliyun-ready'
                            if self.job['status']=='running' and not self.closed:self._pause(item,str(exc))
                            else:
                                item.update(status='paused',message=str(exc));self._persist()
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
                        if active_job.get('provider') == 'aliyun':
                            if phase == 'downloading':
                                item.update(status='failed',phase='download-failed',message='原图下载失败或图片内容无效，已跳过。')
                                self._persist();continue
                            if phase in {'aliyun-ready','ready'} and item['phase'] != 'submitting' and isinstance(exc,ValueError):
                                item.update(status='failed',phase='aliyun-failed',message='图片不符合阿里云要求，已跳过；静态 JPG/PNG/WebP、10MB、双边15–8192像素、长宽比小于10:1。')
                                self._persist();continue
                            if item['phase']=='submitting':item['phase']='uncertain'
                            self._pause(item,'阿里云结果下载或处理失败，继续获取将复用已有结果。' if item.get('aliyun_result') else str(AliyunError()))
                            continue
                        if phase == 'downloading':
                            item.update(status='failed', phase='download-failed', message=str(exc))
                            self._persist(); continue
                        if item['phase'] == 'submitting': item['phase'] = 'uncertain'
                        self._pause(item, f'{item["phase"]}：{exc}')
        except StorageFailure:
            # _persist already records terminal failure in memory; never persist it again.
            pass
        finally:
            if self.browser is not None: self.browser.close()

    def request_close(self, clear_state=False):
        """Cancel synchronously without joining or touching worker-owned browser objects."""
        with self.cv:
            self.clear_on_close = self.clear_on_close or clear_state
            self.closed = True; self.cv.notify_all()

    def close(self, clear_state=False, *, close_license=True):
        self.request_close(clear_state=clear_state)
        self._license_stop.set()
        self.license_worker.join()
        self.worker.join(timeout=55)
        if self.worker.is_alive(): raise RuntimeError('瀏覽器操作尚未結束')
        if close_license: self.license.close()
        with self.cv:
            if self.clear_on_close:
                clear_task_state(self.state_dir)
                self.job = None
                self.browser_message = ''; self.browser_busy = False
