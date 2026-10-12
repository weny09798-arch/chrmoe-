"""Small Chrome Native Messaging protocol. Never send logs to stdout."""
import io
import json
import os
import secrets
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from native_runtime import FileLock, PROTOCOL, VERSION, read_descriptor, validate_extension_id

MAX_FRAME = 1024 * 1024


def _read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part: raise ValueError('原生消息不完整')
        chunks.extend(part)
    return bytes(chunks)


def read_frame(stream):
    first = stream.read(1)
    if not first: return None
    size = struct.unpack('<I', first + _read_exact(stream, 3))[0]
    if not 0 < size <= MAX_FRAME: raise ValueError('原生消息超过大小限制')
    try: value = json.loads(_read_exact(stream, size).decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError): raise ValueError('原生消息格式无效') from None
    if not isinstance(value, dict): raise ValueError('原生消息格式无效')
    return value


def encode_frame(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > MAX_FRAME: raise ValueError('原生消息超过大小限制')
    return struct.pack('<I', len(raw)) + raw


def decode_frame(raw):
    stream = io.BytesIO(raw); result = read_frame(stream)
    if result is None or stream.read(1): raise ValueError('原生消息格式无效')
    return result


def installed_executable():
    return Path(sys.executable if getattr(sys, 'frozen', False) else __file__).resolve()


def load_settings(executable=None):
    path = (Path(executable) if executable else installed_executable()).parent / 'backend-settings.json'
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if set(value) != {'extension_id', 'state_dir'}: raise ValueError()
        validate_extension_id(value['extension_id'])
        if not isinstance(value['state_dir'], str) or not Path(value['state_dir']).is_absolute(): raise ValueError()
        return value
    except (OSError, ValueError, TypeError): raise ValueError('后台组件未正确安装，请重新运行安装后台组件') from None


def spawn_backend(executable):
    if Path(executable).suffix.lower() != '.exe': raise ValueError('请安装已打包的 Windows 后台组件')
    return subprocess.Popen([str(executable), '--automatic', '--no-open'], stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), close_fds=True)


def http_request(descriptor, action, session=None):
    base = f"http://127.0.0.1:{descriptor['port']}/api/native/"
    headers = {'X-Tool-Token': descriptor['token'], 'Content-Type': 'application/json'}
    data = None if action == 'status' else json.dumps({'extension_id': descriptor['extension_id'], 'session': session}).encode()
    req = urllib.request.Request(base + action, data=data, headers=headers)
    # Disable environment proxies; discovery credentials must stay on loopback.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as response:
        raw = response.read(16385)
    if len(raw) > 16384: raise ValueError('后台响应无效')
    result = json.loads(raw)
    if not isinstance(result, dict) or result.get('ok') is not True: raise ValueError('后台连接失败')
    return result


class BackendBroker:
    def __init__(self, root, executable, extension_id, *, spawn=spawn_backend, request=http_request,
                 decrypt=None, timeout=20, clock=time.monotonic, sleep=time.sleep):
        self.root, self.executable = Path(root), Path(executable)
        self.extension_id = validate_extension_id(extension_id)
        self.spawn, self.request, self.decrypt = spawn, request, decrypt
        self.timeout, self.clock, self.sleep = timeout, clock, sleep

    def _ready(self):
        try:
            descriptor = read_descriptor(self.root, self.decrypt)
            if descriptor['extension_id'] != self.extension_id: return None
            status = self.request(descriptor, 'status', None)
            if any(status.get(k) != descriptor[k] for k in ('instance', 'protocol', 'version', 'extension_id')): return None
            return descriptor
        except (OSError, ValueError): return None

    def connect(self, session):
        deadline = self.clock() + self.timeout
        lock = FileLock(self.root / 'native-start.lock')
        try:
            while True:
                try: lock.acquire(); break
                except OSError:
                    if self.clock() >= deadline: raise ValueError('后台启动等待超时，请关闭旧后台后重试') from None
                    self.sleep(0.1)
            descriptor = self._ready()
            if descriptor is None:
                self.spawn(self.executable)
                while self.clock() < deadline:
                    descriptor = self._ready()
                    if descriptor is not None: break
                    self.sleep(0.1)
            if descriptor is None: raise ValueError('后台启动失败或版本不兼容，请更新后台组件后重试')
            attached = self.request(descriptor, 'attach', session)
            if attached.get('instance') != descriptor['instance']: raise ValueError('后台已重启，请重新连接')
            return descriptor
        finally: lock.close()


def serve(input_stream, output_stream, origin, extension_id, broker):
    validate_extension_id(extension_id)
    if origin != f'chrome-extension://{extension_id}/': raise ValueError('插件来源未登记')
    session = secrets.token_urlsafe(32); descriptor = None
    try:
        while True:
            try: message = read_frame(input_stream)
            except ValueError: break
            if message is None: break
            ident = message.get('id')
            if not isinstance(ident, str) or not 1 <= len(ident) <= 128: ident = ''
            try:
                if not ident or set(message) != {'id', 'action'} or message['action'] not in {'connect', 'ping'}:
                    raise ValueError('原生连接请求无效')
                if message['action'] == 'connect':
                    descriptor = broker.connect(session)
                    result = dict(id=ident, ok=True, version=VERSION,
                                  connection_code=f"http://127.0.0.1:{descriptor['port']}/#token={descriptor['token']}")
                else:
                    if descriptor is None: raise ValueError('请先连接后台')
                    broker.request(descriptor, 'heartbeat', session)
                    result = dict(id=ident, ok=True, version=VERSION)
            except Exception:
                result = dict(id=ident, ok=False, error='后台连接失败，请确认后台组件已安装且插件编号正确，然后重试')
            output_stream.write(encode_frame(result)); output_stream.flush()
            # Release the installed executable when its backend goes away, so a
            # maintenance update can safely replace it. Chrome reconnects later.
            if set(message) == {'id', 'action'} and message.get('action') in {'connect', 'ping'} and not result['ok']: break
    finally:
        if descriptor is not None:
            try: broker.request(descriptor, 'detach', session)
            except Exception: pass


def native_main(origin):
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY); msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        settings = load_settings()
        broker = BackendBroker(settings['state_dir'], installed_executable(), settings['extension_id'])
        serve(sys.stdin.buffer, sys.stdout.buffer, origin, settings['extension_id'], broker)
        return 0
    except Exception: return 1
