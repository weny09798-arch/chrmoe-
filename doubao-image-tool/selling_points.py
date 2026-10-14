"""Single independent persistent selling image; workers never mutate collector state."""
import copy
import io
import json
import os
import re
import shutil
import threading
import uuid
from pathlib import Path
from PIL import Image
from bailian import BailianError
from selling_renderer import decode_original, render, text, validate_draft, RenderError

BUSY={'generating','rendering','uploading'}

def private_directory(path):
    """Inherit owner-only cache access to all source/result files on Windows."""
    if path.is_symlink() or path.is_junction():raise ValueError('任務快取路徑異常')
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    if os.name!='nt':path.chmod(0o700);return
    import ctypes
    advapi=ctypes.WinDLL('advapi32',use_last_error=True)
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p]
    advapi.SetFileSecurityW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.c_void_p]
    kernel.LocalFree.argtypes=[ctypes.c_void_p]
    descriptor=ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW('D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)',1,ctypes.byref(descriptor),None):raise ValueError('無法保護賣點圖片快取目錄')
    try:
        if not advapi.SetFileSecurityW(str(path),0x80000004,descriptor):raise ValueError('無法保護賣點圖片快取目錄')
    finally:kernel.LocalFree(descriptor)

def atomic(path,data):
    pending=path.with_suffix(path.suffix+'.tmp')
    for candidate in (path,pending):
        if candidate.is_symlink() or candidate.is_junction() or candidate.resolve().parent!=path.parent.resolve():raise ValueError('任務快取路徑異常')
    with pending.open('wb') as handle:
        handle.write(data);handle.flush();os.fsync(handle.fileno())
    pending.replace(path)

class SellingPointService:
    def __init__(self,root,bailian_factory,oss_factory):
        self.root=Path(root).resolve()/'selling-points'
        private_directory(self.root)
        self.lock=threading.RLock();self.bailian_factory=bailian_factory;self.oss_factory=oss_factory
        self.current=None;self.workers={};self.retired=set();self.closed=False
        try:
            value=json.loads((self.root/'current.json').read_text('utf-8'))
            if isinstance(value,dict) and re.fullmatch('[a-f0-9]{32}',value.get('id','')) and self.directory(value['id']).is_dir():
                self.current=value
                if value.get('status') in BUSY:
                    value.update(status='paused',phase='request-uncertain' if value['status']=='generating' else 'interrupted',message='上次操作被中斷。生成結果不確定；再次生成可能再次計費。' if value['status']=='generating' else '上次操作被中斷，本機草稿及可用圖片已保留。',error_code='interrupted')
                    self.persist()
        except (OSError,ValueError,TypeError):pass

    def directory(self,identifier):
        if not isinstance(identifier,str) or not re.fullmatch('[a-f0-9]{32}',identifier):raise RuntimeError('賣點任務已變更，請重新載入')
        path=self.root/identifier
        if path.is_symlink() or path.is_junction() or path.resolve().parent!=self.root:raise ValueError('任務快取路徑異常')
        return path

    def file(self,identifier,name):
        path=self.directory(identifier)/name
        if path.is_symlink() or path.is_junction() or path.resolve().parent!=self.directory(identifier):raise ValueError('任務快取路徑異常')
        return path

    def persist(self):
        atomic(self.root/'current.json',json.dumps(self.current,ensure_ascii=False).encode('utf-8'))

    def snapshot(self):
        with self.lock:
            if not self.current:return {'id':None,'status':'idle'}
            value=copy.deepcopy(self.current)
            value['result_available']=value['result_revision']==value['draft_revision'] and self.file(value['id'],'result.png').is_file()
            if not value['result_available']:value['public_url']=''
            return value

    def owned(self,identifier,busy=False):
        if self.closed or not self.current or self.current['id']!=identifier:raise RuntimeError('賣點任務已變更，請重新載入')
        if not busy and self.current['status'] in BUSY:raise RuntimeError('賣點任務正在處理，請等待完成')
        return self.current

    def cleanup(self,identifier):
        path=self.directory(identifier)
        if not path.exists():return
        # Validate every entry, including nested links, before any removal.
        for base,dirs,files in os.walk(path,followlinks=False):
            for name in dirs+files:
                entry=Path(base)/name
                if entry.is_symlink() or entry.is_junction() or path not in entry.resolve().parents:raise ValueError('任務快取路徑異常，未清理')
        shutil.rmtree(path)

    def retire(self,identifier):
        if identifier in self.workers:self.retired.add(identifier)
        else:self.cleanup(identifier)

    def create(self,filename,data,product_name,facts):
        decode_original(data)
        product_name=text(product_name,100,'商品名稱');facts=text(facts,2000,'商品事實',empty=True)
        with Image.open(io.BytesIO(data)) as image:mime=Image.MIME[image.format]
        source_name=re.sub(r'[\x00-\x1f\x7f]', '',str(filename).replace('\\','/').split('/')[-1])[:200] or 'image'
        with self.lock:
            if self.closed:raise RuntimeError('服務已關閉')
            identifier=uuid.uuid4().hex;folder=self.directory(identifier);folder.mkdir(mode=0o700)
            atomic(self.file(identifier,'original'),data)
            old=self.current
            self.current={'id':identifier,'status':'uploaded','phase':'uploaded','source_filename':source_name,'product_name':product_name,'facts':facts,'headline':'','points':[],'draft_revision':0,'result_revision':None,'public_url':'','paid_calls':0,'message':'原圖已上傳，生成前請確認付費。','error_code':'','request_id':'','usage':{},'original_mime':mime,'result_available':False}
            self.persist()
            if old:self.retire(old['id'])
            return self.snapshot()

    def phase(self,value,status,phase,message):
        value.update(status=status,phase=phase,message=message,error_code='')
        self.persist()

    def launch(self,identifier,operation):
        def worker():
            try:operation()
            except Exception as exc:
                with self.lock:
                    if self.current and self.current['id']==identifier:
                        self.current.update(status='paused',phase='request-uncertain' if isinstance(exc,BailianError) and exc.code=='request-uncertain' else 'render-failed' if isinstance(exc,RenderError) else 'failed',message=str(exc) if isinstance(exc,(BailianError,RenderError)) else '處理未完成，請檢查設定或圖片；本機草稿保留。',error_code=exc.code if isinstance(exc,BailianError) else 'render-failed' if isinstance(exc,RenderError) else 'operation-failed',request_id=exc.request_id if isinstance(exc,BailianError) else '')
                        self.persist()
            finally:
                with self.lock:
                    self.workers.pop(identifier,None)
                    if identifier in self.retired:
                        self.retired.discard(identifier)
                        try:self.cleanup(identifier)
                        except (OSError,ValueError):pass
        thread=threading.Thread(target=worker,daemon=True,name='selling-points')
        self.workers[identifier]=thread;thread.start()

    def generate(self,identifier,paid_confirmed):
        if paid_confirmed is not True:raise ValueError('請明確確認付費後再生成；每次生成可能計費')
        with self.lock:
            value=self.owned(identifier)
            # Configuration must be valid before recording a paid call.
            client=self.bailian_factory()
            data=self.file(identifier,'original').read_bytes();mime=value['original_mime'];name=value['product_name'];facts=value['facts']
            value['paid_calls']+=1;value.update(public_url='',request_id='',usage={})
            self.phase(value,'generating','request-started','百煉生成中，請等待；中斷後不會自動重試。')
            def operation():
                reply=client.generate(data,mime,name,facts)
                with self.lock:
                    if not self.current or self.current['id']!=identifier:return
                    needs=text(reply.get('needs_information',''),500,'補充資料',empty=True)
                    headline,points=('',[]) if needs else validate_draft(reply.get('headline'),reply.get('points'))
                    value.update(headline=headline,points=points,draft_revision=value['draft_revision']+1,public_url='',request_id=reply.get('request_id',''),usage=reply.get('usage',{}))
                    self.phase(value,'draft','needs-information' if needs else 'draft',needs or '草稿已儲存，請核對並編輯後製作圖片。')
            self.launch(identifier,operation);return self.snapshot()

    def revision(self,value,revision):
        if not isinstance(revision,int) or isinstance(revision,bool) or revision!=value['draft_revision']:raise RuntimeError('草稿已更新，請重新載入後再操作')

    def draft(self,identifier,headline,points,revision):
        headline,points=validate_draft(headline,points)
        with self.lock:
            value=self.owned(identifier);self.revision(value,revision)
            value.update(headline=headline,points=points,draft_revision=revision+1,public_url='')
            self.phase(value,'draft','draft','繁體草稿已儲存，請核對內容。');return self.snapshot()

    def upload(self,identifier,revision):
        with self.lock:
            if not self.current or self.current['id']!=identifier or self.current['draft_revision']!=revision:return
            self.phase(self.current,'uploading','uploading','正在上傳已製作的圖片。')
        try:
            reply=self.oss_factory().publish(self.file(identifier,'result.png'))
            url=reply['url']
            if not isinstance(url,str) or not url.startswith('https://') or len(url)>2048:raise ValueError()
        except Exception:
            with self.lock:
                if self.current and self.current['id']==identifier and self.current['draft_revision']==revision:
                    self.current.update(status='paused',phase='upload-failed',public_url='',message='OSS 上傳失敗；本機圖片保留，可預覽、下載或重試上傳，無需再次生成。',error_code='upload-failed');self.persist()
            return
        with self.lock:
            if not self.current or self.current['id']!=identifier or self.current['draft_revision']!=revision:return
            self.current['public_url']=url;self.phase(self.current,'completed','completed','賣點圖已上傳，請核對圖片內容。')

    def render(self,identifier,revision):
        with self.lock:
            value=self.owned(identifier);self.revision(value,revision)
            headline,points=validate_draft(value['headline'],value['points'])
            original=decode_original(self.file(identifier,'original').read_bytes())
            value['public_url']='';self.phase(value,'rendering','rendering','正在製作圖片，原圖商品像素保持不變。')
            def operation():
                data=render(original,headline,points)
                with self.lock:
                    if not self.current or self.current['id']!=identifier or self.current['draft_revision']!=revision:return
                    atomic(self.file(identifier,'result.png'),data);value['result_revision']=revision;self.persist()
                self.upload(identifier,revision)
            self.launch(identifier,operation);return self.snapshot()

    def retry_upload(self,identifier):
        with self.lock:
            value=self.owned(identifier)
            if not self.snapshot()['result_available']:raise ValueError('沒有符合目前草稿的本機結果，請先製作圖片')
            revision=value['draft_revision'];self.phase(value,'uploading','uploading','正在重試上傳本機圖片。')
            self.launch(identifier,lambda:self.upload(identifier,revision));return self.snapshot()

    def clear(self,identifier):
        with self.lock:
            self.owned(identifier,busy=True);self.current=None;self.persist();self.retire(identifier);return self.snapshot()

    def image(self,identifier,kind):
        with self.lock:
            value=self.owned(identifier,busy=True)
            if kind=='original':return self.file(identifier,'original').read_bytes(),value['original_mime']
            if kind=='result' and self.snapshot()['result_available']:return self.file(identifier,'result.png').read_bytes(),'image/png'
            raise ValueError('圖片尚不可用')

    def close(self):
        with self.lock:self.closed=True
