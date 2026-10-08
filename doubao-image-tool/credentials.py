"""Windows user-bound DPAPI credentials, outside disposable task state."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import threading

class CredentialError(ValueError):
    pass

class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]

def _crypt(data, decrypt=False):
    if os.name != 'nt': raise CredentialError('阿里云凭证保护需要 Windows DPAPI')
    raw=ctypes.create_string_buffer(data)
    source=Blob(len(data),ctypes.cast(raw,ctypes.POINTER(ctypes.c_ubyte)))
    target=Blob()
    crypt=ctypes.WinDLL('crypt32',use_last_error=True)
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.LocalFree.argtypes=[ctypes.c_void_p];kernel.LocalFree.restype=ctypes.c_void_p
    if decrypt:
        fn=crypt.CryptUnprotectData
        fn.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
        ok=fn(ctypes.byref(source),None,None,None,None,1,ctypes.byref(target))
    else:
        fn=crypt.CryptProtectData
        fn.argtypes=[ctypes.POINTER(Blob),wintypes.LPCWSTR,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
        ok=fn(ctypes.byref(source),'Image translation credentials',None,None,None,1,ctypes.byref(target))
    if not ok: raise CredentialError('阿里云凭证保护失败，请重新配置')
    try:return ctypes.string_at(target.data,target.size)
    finally:kernel.LocalFree(target.data)

class CredentialStore:
    def __init__(self,profile_root):
        self.path=Path(profile_root).resolve()/'aliyun-credentials.dpapi'
        self.lock=threading.RLock()

    def save(self,access_key_id,access_key_secret):
        values=(access_key_id,access_key_secret)
        if any(not isinstance(v,str) or not v.strip() or len(v)>512 or any(c.isspace() for c in v) for v in values):
            raise CredentialError('请填写有效的 AccessKey ID 和 Secret')
        with self.lock:
            try:
                data=_crypt(json.dumps({'access_key_id':access_key_id,'access_key_secret':access_key_secret}).encode())
                self.path.parent.mkdir(parents=True,exist_ok=True)
                pending=self.path.with_suffix('.tmp');pending.write_bytes(data);pending.replace(self.path)
            except Exception:
                raise CredentialError('阿里云凭证保存失败，请重新配置') from None

    def load(self):
        with self.lock:
            try:
                value=json.loads(_crypt(self.path.read_bytes(),True))
                if set(value)!={'access_key_id','access_key_secret'} or any(not isinstance(v,str) or not v for v in value.values()):raise ValueError()
                return value
            except Exception:raise CredentialError('阿里云凭证未配置或不可读取，请重新配置') from None

    def configured(self):
        try:self.load();return True
        except CredentialError:return False

    def delete(self):
        with self.lock:
            try:self.path.unlink(missing_ok=True);self.path.with_suffix('.tmp').unlink(missing_ok=True)
            except Exception:raise CredentialError('阿里云凭证删除失败') from None
