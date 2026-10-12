"""Per-user native host installation; no service, elevation or user-state deletion."""
import json
import os
import secrets
import shutil
import sys
import time
from pathlib import Path
from native_runtime import FileLock, HOST_NAME, read_descriptor, validate_extension_id

REGISTRY_KEY = 'Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME
INSTALL_NAME = 'ProductCollectorBackend'
MARKER = '.product-collector-backend'


def _program_running(executable):
    """Inspect exact image paths without terminating any process."""
    if os.name != 'nt': return False
    import ctypes
    from ctypes import wintypes
    class ProcessEntry(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD), ('pid', wintypes.DWORD),
                    ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('parent', wintypes.DWORD), ('priority', wintypes.LONG), ('flags', wintypes.DWORD),
                    ('exe', wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value: raise OSError('无法检查后台组件使用状态')
    try:
        entry = ProcessEntry(); entry.size = ctypes.sizeof(entry)
        valid = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while valid:
            if entry.exe.casefold() == executable.name.casefold():
                handle = kernel.OpenProcess(0x1000, False, entry.pid)
                if handle:
                    try:
                        buffer = ctypes.create_unicode_buffer(32768); size = wintypes.DWORD(len(buffer))
                        if kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                            if Path(buffer.value).resolve() == executable: return True
                    finally: kernel.CloseHandle(handle)
            valid = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        return False
    finally: kernel.CloseHandle(snapshot)


def wait_program_exit(executable, timeout=25):
    executable = Path(executable).resolve(); deadline = time.monotonic() + timeout
    while _program_running(executable):
        if time.monotonic() >= deadline:
            raise ValueError('Chrome 仍在使用后台组件，请关闭插件页面后重试；原组件已保留')
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))


class UserRegistry:
    def read(self):
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as key: return winreg.QueryValueEx(key, '')[0]
        except FileNotFoundError: return None
    def write(self, value):
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, value)
    def delete(self):
        import winreg
        try: winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY)
        except FileNotFoundError: pass


def stop_backend(root, timeout=35):
    """Ask automatic runtime to drain; never kill or clear the running queue."""
    from native_host import http_request
    root = Path(root)
    try:
        descriptor = read_descriptor(root)
        status = http_request(descriptor, 'status')
        if status.get('instance') == descriptor['instance']:
            http_request(descriptor, 'shutdown', secrets.token_urlsafe(32))
    except (OSError, ValueError): pass
    deadline = time.monotonic() + timeout
    lock = FileLock(root / 'instance.lock')
    try:
        while True:
            try: lock.acquire(); return
            except OSError:
                if time.monotonic() >= deadline:
                    raise ValueError('后台仍在安全保存当前图片，请稍后重新安装或卸载；原组件已保留') from None
                time.sleep(0.2)
    finally: lock.close()


class BackendInstaller:
    def __init__(self, local_appdata=None, *, registry=None, stop_backend=stop_backend):
        self.base = Path(local_appdata or os.environ.get('LOCALAPPDATA', Path.home())).resolve()
        self.target = self.base / INSTALL_NAME
        self.registry = registry if registry is not None else UserRegistry()
        self.stop_backend = stop_backend

    def _owned(self, path, *, require_marker=True):
        path = Path(path)
        resolved = path.resolve()
        if resolved.parent != self.base or not (path.name == INSTALL_NAME or path.name.startswith(INSTALL_NAME + '.')):
            raise ValueError('拒绝操作后台组件目录以外的文件')
        if path.is_symlink() or (path.exists() and getattr(path, 'is_junction', lambda: False)()):
            raise ValueError('后台组件目录不能使用目录链接')
        if require_marker and path.exists():
            marker = path / MARKER
            if not marker.is_file() or marker.read_text(encoding='utf-8') != HOST_NAME:
                raise ValueError('目录不属于此后台组件，已保留原文件')
        return path

    def _remove(self, path):
        path = self._owned(path)
        if path.exists(): shutil.rmtree(path)

    def _old_settings(self):
        if not self.target.exists(): return None
        self._owned(self.target)
        from native_host import load_settings
        return load_settings(self.target / 'DoubaoImageTool.exe')

    def install(self, source, extension_id, *, state_dir=None):
        validate_extension_id(extension_id)
        source = Path(source).resolve()
        if not (source / 'DoubaoImageTool.exe').is_file(): raise ValueError('未找到完整后台组件，请解压交付包后运行安装')
        old_settings = self._old_settings()
        state = Path(state_dir or (old_settings and old_settings['state_dir']) or self.base / 'DoubaoImageTool').resolve()
        if state == self.target or self.target in state.parents: raise ValueError('用户数据目录必须位于后台程序目录之外')
        self.base.mkdir(parents=True, exist_ok=True)
        lock = FileLock(self.base / (INSTALL_NAME + '.install.lock'))
        try:
            lock.acquire()
            # Shared with native discovery: an existing host cannot launch during replacement.
            launch_lock = FileLock(state / 'native-start.lock')
            try:
                launch_lock.acquire()
                self.stop_backend(Path(old_settings['state_dir']) if old_settings else state)
                if self.target.exists(): wait_program_exit(self.target / 'DoubaoImageTool.exe')
                return self._replace(source, extension_id, state)
            finally: launch_lock.close()
        finally: lock.close()

    def _replace(self, source, extension_id, state):
        stage = self.base / (INSTALL_NAME + '.stage-' + secrets.token_hex(8))
        backup = self.base / (INSTALL_NAME + '.backup-' + secrets.token_hex(8))
        self._owned(stage, require_marker=False); self._owned(backup, require_marker=False)
        old_registry = self.registry.read(); moved = False; installed = False
        stage.mkdir(); (stage / MARKER).write_text(HOST_NAME, encoding='utf-8')
        try:
            # PyInstaller's onedir payload, without delivery source/tests or local configuration.
            shutil.copy2(source / 'DoubaoImageTool.exe', stage / 'DoubaoImageTool.exe')
            if (source / '_internal').is_dir(): shutil.copytree(source / '_internal', stage / '_internal')
            for name in ('licenses', 'THIRD_PARTY_NOTICES.md'):
                item = source / name
                if item.is_dir(): shutil.copytree(item, stage / name)
                elif item.is_file(): shutil.copy2(item, stage / name)
            (stage / 'backend-settings.json').write_text(json.dumps({'extension_id': extension_id, 'state_dir': str(state)}, ensure_ascii=False), encoding='utf-8')
            manifest = {'name': HOST_NAME, 'description': '商品采集与图片转换后台', 'path': str(self.target / 'DoubaoImageTool.exe'),
                        'type': 'stdio', 'allowed_origins': [f'chrome-extension://{extension_id}/']}
            (stage / 'native-host.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
            if self.target.exists():
                self._owned(self.target); self.target.rename(backup); moved = True
            stage.rename(self.target); installed = True
            self.registry.write(str(self.target / 'native-host.json'))
        except Exception:
            if installed: self._remove(self.target)
            if moved: self._owned(backup).rename(self.target)
            # A failed write normally leaves the previous key intact; restore only if it changed.
            if self.registry.read() != old_registry:
                if old_registry is None: self.registry.delete()
                else: self.registry.write(old_registry)
            raise
        finally:
            if stage.exists(): self._remove(stage)
        if backup.exists(): self._remove(backup)
        return self.target

    def uninstall(self):
        self._owned(self.target)
        if not self.target.exists():
            if self.registry.read() == str(self.target / 'native-host.json'): self.registry.delete()
            return
        settings = self._old_settings()
        lock = FileLock(self.base / (INSTALL_NAME + '.install.lock'))
        launch_lock = FileLock(Path(settings['state_dir']) / 'native-start.lock')
        try:
            lock.acquire(); launch_lock.acquire()
            self.stop_backend(Path(settings['state_dir']))
            wait_program_exit(self.target / 'DoubaoImageTool.exe')
            # Rename first: Windows reports a still-open binary before changing the registration.
            backup = self.base / (INSTALL_NAME + '.remove-' + secrets.token_hex(8))
            self._owned(backup, require_marker=False)
            self.target.rename(backup)
            try:
                if self.registry.read() == str(self.target / 'native-host.json'): self.registry.delete()
            except Exception:
                backup.rename(self.target); raise
            self._remove(backup)
        finally:
            launch_lock.close(); lock.close()


def installer_main(args):
    try:
        installer = BackendInstaller(args.install_root)
        if args.uninstall_backend:
            installer.uninstall(); print('后台组件已卸载；用户配置、登录和任务记录已保留。')
        else:
            extension_id = args.extension_id or input('请粘贴插件页面复制的 32 位插件编号：').strip()
            source = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
            installer.install(source, extension_id, state_dir=args.state_dir)
            print('后台组件安装成功。请重新打开 Chrome 插件页面。')
        return 0
    except Exception as exc:
        print(f'操作失败：{exc}', file=sys.stderr)
        return 1
