"""Encrypted discovery and bounded lifetime for the automatically started backend."""
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from credentials import _crypt

HOST_NAME = 'com.productcollector.images'
VERSION = '1.6.9'
PROTOCOL = 1


def validate_extension_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-p]{32}', value):
        raise ValueError('插件编号无效，请复制 Chrome 扩展程序页面中的 32 位编号')
    return value


class FileLock:
    """An OS-owned lock; a crashed process cannot leave a stale held lock."""
    def __init__(self, path):
        path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
        self.file = path.open('a+b')
    def acquire(self):
        self.file.seek(0); self.file.write(b'0'); self.file.flush(); self.file.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def close(self): self.file.close()


def read_descriptor(root, decrypt=None):
    path = Path(root) / 'backend-ready.dpapi'
    if path.stat().st_size > 16384: raise ValueError('后台连接信息无效')
    value = json.loads((decrypt or (lambda b: _crypt(b, True)))(path.read_bytes()))
    if (not isinstance(value, dict) or value.get('protocol') != PROTOCOL or value.get('version') != VERSION
            or type(value.get('port')) is not int or not 1 <= value['port'] <= 65535
            or not isinstance(value.get('token'), str) or not 1 <= len(value['token']) <= 256
            or not isinstance(value.get('instance'), str) or not value['instance']):
        raise ValueError('后台版本或连接信息无效，请更新后台组件')
    validate_extension_id(value.get('extension_id'))
    return value


class AutomaticRuntime:
    def __init__(self, root, token, port, queue, shutdown, extension_id, *, clock=time.monotonic,
                 encrypt=None, decrypt=None, start_watchdog=True, grace=30, drain_timeout=600, lease_timeout=60):
        self.root = Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'backend-ready.dpapi'
        self.extension_id = validate_extension_id(extension_id)
        self.instance = secrets.token_hex(24)
        self.clock, self.queue, self.shutdown = clock, queue, shutdown
        self.grace, self.drain_timeout, self.lease_timeout = grace, drain_timeout, lease_timeout
        self.leases = {}; self.disconnected = clock(); self.draining = None
        self.stopping = False; self.maintenance = False
        self.closed = threading.Event(); self.lock = threading.RLock()
        self.decrypt = decrypt
        descriptor = dict(protocol=PROTOCOL, version=VERSION, port=port, token=token,
                          instance=self.instance, extension_id=self.extension_id)
        pending = self.path.with_suffix('.tmp')
        pending.write_bytes((encrypt or _crypt)(json.dumps(descriptor).encode()))
        pending.replace(self.path)
        self.thread = None
        if start_watchdog:
            self.thread = threading.Thread(target=self._watch, daemon=True, name='native-lifetime')
            self.thread.start()

    def _queue(self): return self.queue() if callable(self.queue) else self.queue

    def _session(self, session):
        if not isinstance(session, str) or not re.fullmatch('[a-zA-Z0-9_-]{32,128}', session):
            raise ValueError('原生连接会话无效')

    def attach(self, session):
        self._session(session)
        with self.lock:
            if self.stopping or self.maintenance: raise ValueError('后台正在关闭，请稍后重试')
            self.leases[session] = self.clock(); self.disconnected = None
            # Reconnection preserves the paused queue; only an explicit user
            # continue action is allowed to cancel the queue's drain state.
            self.draining = None

    def heartbeat(self, session):
        with self.lock:
            if self.stopping or self.maintenance: raise ValueError('后台正在关闭，请稍后重试')
            if session not in self.leases: raise ValueError('原生连接已过期，请重新连接')
            self.leases[session] = self.clock()

    def detach(self, session):
        with self.lock:
            self.leases.pop(session, None)
            if not self.leases and self.disconnected is None: self.disconnected = self.clock()

    def begin_shutdown(self, maintenance=False):
        with self.lock:
            self.maintenance = self.maintenance or maintenance
            if self.draining is None:
                self.draining = self.clock()
                self._queue().begin_drain()

    def tick(self):
        with self.lock:
            now = self.clock()
            for session, seen in list(self.leases.items()):
                if now - seen >= self.lease_timeout: self.detach(session)
            if self.draining is None and self.disconnected is not None and now - self.disconnected >= self.grace:
                self.begin_shutdown()
            if self.draining is not None and not self.stopping:
                if now - self.draining >= self.drain_timeout or self._queue().drain_complete():
                    self.stopping = True
                    self.shutdown()

    def _watch(self):
        while not self.closed.wait(0.5):
            try: self.tick()
            except Exception:
                # A failed queue inspection must not clear recovery state or expose secrets.
                # The absolute drain deadline remains effective on the next watchdog pass.
                with self.lock:
                    if self.draining is not None and self.clock() - self.draining >= self.drain_timeout and not self.stopping:
                        self.stopping = True; self.shutdown()

    def register_routes(self, app):
        from flask import jsonify, request
        @app.before_request
        def native_guard():
            if request.path.startswith('/api/native/'):
                if request.remote_addr not in {'127.0.0.1', '::1'} or request.headers.get('Origin'):
                    return jsonify(ok=False, error='拒绝外部原生连接请求'), 403
        @app.get('/api/native/status')
        def native_status():
            return jsonify(ok=True, instance=self.instance, protocol=PROTOCOL, version=VERSION, extension_id=self.extension_id)
        @app.post('/api/native/<action>')
        def native_lease(action):
            body = request.get_json(silent=True)
            if not isinstance(body, dict) or body.get('extension_id') != self.extension_id:
                return jsonify(ok=False, error='插件来源未登记'), 403
            if set(body) != {'extension_id', 'session'} or action not in {'attach', 'heartbeat', 'detach', 'shutdown'}:
                return jsonify(ok=False, error='原生连接请求无效'), 400
            self._session(body['session'])
            if action == 'shutdown': self.begin_shutdown(maintenance=True)
            else: getattr(self, action)(body['session'])
            return jsonify(ok=True, instance=self.instance)

    def close(self):
        self.closed.set()
        if self.thread and self.thread is not threading.current_thread(): self.thread.join(timeout=2)
        try:
            if read_descriptor(self.root, self.decrypt)['instance'] == self.instance: self.path.unlink(missing_ok=True)
        except (OSError, ValueError): pass
