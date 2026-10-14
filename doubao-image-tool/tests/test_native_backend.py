import io
import json
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

EXT = 'a' * 32


def modules():
    import native_host
    import native_runtime
    import backend_install
    return native_host, native_runtime, backend_install


def test_native_feature_modules_exist():
    root = Path(__file__).resolve().parents[1]
    assert all((root / (name + '.py')).exists() for name in ('native_host', 'native_runtime', 'backend_install'))


def test_frames_roundtrip_and_bounded_reads():
    host, _, _ = modules()
    assert host.decode_frame(host.encode_frame({'action': 'connect'})) == {'action': 'connect'}
    for raw in (struct.pack('<I', 1048577), b'\x02', struct.pack('<I', 5) + b'{}', struct.pack('<I', 2) + b'[]'):
        with pytest.raises(ValueError): host.decode_frame(raw)
    with pytest.raises(ValueError): host.encode_frame({'x': 'a' * 1048576})
    assert host.read_frame(io.BytesIO()) is None


class Queue:
    def __init__(self): self.drains = 0; self.done = False
    def begin_drain(self): self.drains += 1
    def drain_complete(self): return self.done


def runtime(tmp_path, **kwargs):
    _, mod, _ = modules()
    now = [0.0]; queue = Queue(); exits = []
    rt = mod.AutomaticRuntime(tmp_path, 'secret-token', 12345, queue, lambda: exits.append(True), EXT,
                              clock=lambda: now[0], encrypt=lambda b: b'ENC' + b,
                              decrypt=lambda b: b[3:], start_watchdog=False, **kwargs)
    return rt, now, queue, exits


def test_runtime_last_lease_grace_drain_and_bounded_shutdown(tmp_path):
    rt, now, queue, exits = runtime(tmp_path)
    assert rt.path.read_bytes().startswith(b'ENC')
    rt.attach('x' * 32); rt.attach('y' * 32)
    rt.detach('x' * 32); now[0] = 20; rt.heartbeat('y' * 32); rt.tick()
    assert queue.drains == 0
    rt.detach('y' * 32); now[0] = 49; rt.tick(); assert queue.drains == 0
    now[0] = 50; rt.tick(); assert queue.drains == 1 and exits == []
    now[0] = 650; rt.tick(); assert exits == [True]
    rt.close(); assert not rt.path.exists()


def test_runtime_completed_drain_and_dead_host_expiry(tmp_path):
    rt, now, queue, exits = runtime(tmp_path)
    rt.attach('x' * 32)
    now[0] = 61; rt.tick(); assert queue.drains == 0
    now[0] = 91; queue.done = True; rt.tick()
    assert queue.drains == 1 and exits == [True]
    with pytest.raises(ValueError): rt.heartbeat('unknown')
    rt.close()


def test_routes_require_token_exact_extension_and_session(tmp_path):
    from app import create_app
    app = create_app(state_dir=tmp_path, token='secret-token', browser_factory=lambda: pytest.fail('browser started'))
    rt, _, _, _ = runtime(tmp_path)
    rt.register_routes(app)
    client = app.test_client(); body = {'extension_id': EXT, 'session': 'x' * 32}
    assert client.post('/api/native/attach', json=body).status_code == 403
    headers = {'X-Tool-Token': 'secret-token'}
    assert client.post('/api/native/attach', json={**body, 'extension_id': 'b' * 32}, headers=headers).status_code == 403
    assert client.post('/api/native/attach', json=body, headers={**headers, 'Origin': 'https://evil.test'}).status_code == 403
    assert client.post('/api/native/attach', json=body, headers=headers).status_code == 200
    assert client.get('/api/native/status', headers=headers).json['instance'] == rt.instance
    rt.close(); app.extensions['queue'].close(clear_state=False)


def test_native_connect_ping_and_eof_detach_without_message_commands(tmp_path):
    host, _, _ = modules(); calls = []
    class Broker:
        def connect(self, session): calls.append(('attach', session)); return {'port': 12345, 'token': 'secret'}
        def request(self, descriptor, action, session): calls.append((action, session)); return {'ok': True}
    out = io.BytesIO()
    incoming = b''.join(host.encode_frame(x) for x in [
        {'id': '1', 'action': 'connect', 'path': 'evil.exe'},
        {'id': '2', 'action': 'connect'}, {'id': '3', 'action': 'ping'}])
    host.serve(io.BytesIO(incoming), out, f'chrome-extension://{EXT}/', EXT, Broker())
    out.seek(0); assert host.read_frame(out)['ok'] is False
    result = host.read_frame(out); assert result['connection_code'] == 'http://127.0.0.1:12345/#token=secret'
    assert host.read_frame(out)['ok'] is True
    assert [c[0] for c in calls] == ['attach', 'heartbeat', 'detach']
    assert len({c[1] for c in calls}) == 1
    with pytest.raises(ValueError): host.serve(io.BytesIO(incoming), io.BytesIO(), f'chrome-extension://{"b" * 32}/', EXT, Broker())


def test_broker_serializes_spawn_and_rejects_stale_descriptor(tmp_path):
    host, mod, _ = modules(); spawned = []; calls = []; gate = threading.Lock()
    rt_holder = []
    def spawn(executable):
        spawned.append(executable)
        rt, _, _, _ = runtime(tmp_path); rt_holder.append(rt)
    def request(desc, action, session):
        calls.append(action)
        if desc.get('instance') == 'stale': raise OSError('stale')
        return {'ok': True, 'instance': desc['instance'], 'protocol': 1, 'version': mod.VERSION, 'extension_id': EXT}
    (tmp_path / 'backend-ready.dpapi').write_bytes(b'ENC' + json.dumps({'port': 12345, 'token': 'old', 'instance': 'stale', 'extension_id': EXT, 'protocol': 1, 'version': '1.6.6'}).encode())
    brokers = [host.BackendBroker(tmp_path, tmp_path / 'tool.exe', EXT, spawn=spawn, request=request,
                                 decrypt=lambda b: b[3:], timeout=2) for _ in range(2)]
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda pair: pair[1].connect(str(pair[0]) * 32), enumerate(brokers)))
    assert len(spawned) == 1
    assert results[0]['instance'] == results[1]['instance']
    assert calls.count('attach') == 2
    rt_holder[0].close()


class Registry:
    def __init__(self): self.value = None; self.fail = False
    def read(self): return self.value
    def write(self, value):
        if self.fail: raise OSError('registry test failure')
        self.value = value
    def delete(self): self.value = None


def test_install_update_rollback_exact_origin_and_safe_uninstall(tmp_path):
    _, _, mod = modules(); reg = Registry()
    source = tmp_path / 'source'; source.mkdir(); (source / 'DoubaoImageTool.exe').write_bytes(b'v1')
    local = tmp_path / 'local'; state = tmp_path / 'state'; state.mkdir(); (state / 'keep').write_text('credentials')
    inst = mod.BackendInstaller(local, registry=reg, stop_backend=lambda root: None)
    target = inst.install(source, EXT, state_dir=state)
    manifest = json.loads((target / 'native-host.json').read_text(encoding='utf-8'))
    assert manifest['allowed_origins'] == [f'chrome-extension://{EXT}/']
    assert manifest['path'] == str(target / 'DoubaoImageTool.exe')
    assert reg.value == str(target / 'native-host.json')
    (source / 'DoubaoImageTool.exe').write_bytes(b'v2'); reg.fail = True
    with pytest.raises(OSError, match='registry test failure'): inst.install(source, EXT, state_dir=state)
    assert (target / 'DoubaoImageTool.exe').read_bytes() == b'v1'
    reg.fail = False; inst.install(source, 'b' * 32)
    assert json.loads((target / 'backend-settings.json').read_text(encoding='utf-8'))['state_dir'] == str(state)
    inst.uninstall(); assert not target.exists() and reg.value is None
    assert (state / 'keep').read_text() == 'credentials'
    inst.uninstall()


@pytest.mark.parametrize('value', ['', 'a' * 31, 'a' * 31 + 'z', '*', '../bad'])
def test_installer_rejects_invalid_id_without_writes(tmp_path, value):
    _, _, mod = modules(); reg = Registry()
    with pytest.raises(ValueError): mod.BackendInstaller(tmp_path, registry=reg).install(tmp_path / 'missing', value)
    assert reg.value is None and list(tmp_path.iterdir()) == []


def test_uninstall_refuses_unowned_directory(tmp_path):
    _, _, mod = modules(); inst = mod.BackendInstaller(tmp_path, registry=Registry())
    inst.target.mkdir(); (inst.target / 'keep').write_text('other app')
    with pytest.raises(ValueError): inst.uninstall()
    assert (inst.target / 'keep').exists()


def test_automatic_run_never_opens_ui_and_preserves_state(tmp_path, monkeypatch):
    import run
    from flask import Flask
    app = Flask(__name__); app.config['TOOL_TOKEN'] = 'secret'; queue = Queue(); closed = []
    queue.close = lambda **kwargs: closed.append(kwargs)
    app.extensions['queue'] = queue
    monkeypatch.setattr(run, 'create_app', lambda **kwargs: app)
    monkeypatch.setattr(run.webbrowser, 'open', lambda *args: pytest.fail('opened UI'))
    class Server:
        server_port = 12345
        def serve_forever(self): pass
        def server_close(self): pass
        def shutdown(self): pass
    monkeypatch.setattr(run, 'make_server', lambda *a, **kw: Server())
    monkeypatch.setattr(run.sys, 'argv', ['run.py', '--automatic', '--state-dir', str(tmp_path)])
    monkeypatch.setattr(run, 'load_settings', lambda: {'extension_id': EXT, 'state_dir': str(tmp_path)}, raising=False)
    assert run.main() == 0
    assert closed == [{'clear_state': False}]
    assert not (tmp_path / 'backend-ready.dpapi').exists()


def test_reconnect_cancels_exit_countdown_but_never_resumes_queue(tmp_path):
    rt, now, queue, exits = runtime(tmp_path)
    now[0] = 31; rt.tick(); assert queue.drains == 1
    rt.attach('z' * 32); queue.done = True; now[0] = 40; rt.tick()
    assert exits == [] and queue.drains == 1
    rt.detach('z' * 32); now[0] = 71; rt.tick()
    assert exits == [True] and queue.drains == 2
    rt.close()


def test_descriptor_is_really_dpapi_encrypted_and_owner_close_is_scoped(tmp_path):
    _, mod, _ = modules()
    first = mod.AutomaticRuntime(tmp_path, 'never-plaintext', 12345, Queue(), lambda: None, EXT, start_watchdog=False)
    assert b'never-plaintext' not in first.path.read_bytes()
    assert mod.read_descriptor(tmp_path)['token'] == 'never-plaintext'
    second = mod.AutomaticRuntime(tmp_path, 'other-token', 12346, Queue(), lambda: None, EXT, start_watchdog=False)
    first.close(); assert second.path.exists()
    second.close(); assert not second.path.exists()


def test_broker_failure_is_bounded_and_never_returns_stale_secret(tmp_path):
    host, _, _ = modules(); now = [0]; spawned = []
    def sleep(seconds): now[0] += seconds
    broker = host.BackendBroker(tmp_path, tmp_path / 'app.exe', EXT, spawn=spawned.append,
                               timeout=0.3, clock=lambda: now[0], sleep=sleep)
    with pytest.raises(ValueError, match='后台启动失败'): broker.connect('x' * 32)
    assert len(spawned) == 1 and now[0] < 1


def test_spawn_uses_only_own_executable_hidden_and_fixed_flags(tmp_path, monkeypatch):
    host, _, _ = modules(); calls = []
    monkeypatch.setattr(host.subprocess, 'Popen', lambda *args, **kwargs: calls.append((args, kwargs)))
    host.spawn_backend(tmp_path / 'installed.exe')
    args, kwargs = calls[0]
    assert args[0] == [str(tmp_path / 'installed.exe'), '--automatic', '--no-open']
    assert kwargs['creationflags'] & host.subprocess.CREATE_NO_WINDOW
    assert kwargs['stdin'] == kwargs['stdout'] == kwargs['stderr'] == host.subprocess.DEVNULL


def test_native_chrome_argv_is_dispatched_before_parser(monkeypatch):
    import run
    host, _, _ = modules(); origins = []
    monkeypatch.setattr(host, 'native_main', lambda origin: origins.append(origin) or 0)
    monkeypatch.setattr(run.sys, 'argv', ['tool.exe', f'chrome-extension://{EXT}/', '--parent-window=0'])
    assert run.main() == 0 and origins == [f'chrome-extension://{EXT}/']


def test_runtime_native_routes_reject_remote_peers_and_browser_origins(tmp_path):
    from app import create_app
    app = create_app(state_dir=tmp_path, token='secret-token')
    rt, _, _, _ = runtime(tmp_path); rt.register_routes(app)
    client = app.test_client(); headers = {'X-Tool-Token': 'secret-token'}
    assert client.get('/api/native/status', headers=headers, environ_base={'REMOTE_ADDR': '203.0.113.1'}).status_code == 403
    assert client.get('/api/native/status', headers={**headers, 'Origin': 'http://localhost'}).status_code == 403
    rt.close(); app.extensions['queue'].close(clear_state=False)


def test_maintenance_shutdown_cannot_be_cancelled_by_reconnect(tmp_path):
    from app import create_app
    app = create_app(state_dir=tmp_path, token='secret-token')
    rt, now, queue, exits = runtime(tmp_path); rt.register_routes(app)
    client = app.test_client(); headers = {'X-Tool-Token': 'secret-token'}
    body = {'extension_id': EXT, 'session': 'x' * 32}
    assert client.post('/api/native/attach', json=body, headers=headers).status_code == 200
    assert client.post('/api/native/shutdown', json=body, headers=headers).status_code == 200
    assert client.post('/api/native/attach', json=body, headers=headers).status_code == 400
    assert client.post('/api/native/heartbeat', json=body, headers=headers).status_code == 400
    queue.done = True; rt.tick(); assert exits == [True]
    rt.close(); app.extensions['queue'].close(clear_state=False)


def test_ping_failure_closes_host_and_detaches_lease():
    host, _, _ = modules(); calls = []
    class Broker:
        def connect(self, session): return {'port': 12345, 'token': 'secret'}
        def request(self, descriptor, action, session):
            calls.append(action)
            if action == 'heartbeat': raise OSError('server shut down')
    incoming = b''.join(host.encode_frame({'id': str(i), 'action': action}) for i, action in enumerate(['connect', 'ping', 'connect']))
    out = io.BytesIO(); host.serve(io.BytesIO(incoming), out, f'chrome-extension://{EXT}/', EXT, Broker())
    out.seek(0); assert host.read_frame(out)['ok'] is True
    assert host.read_frame(out)['ok'] is False
    assert host.read_frame(out) is None and calls == ['heartbeat', 'detach']


def test_install_stop_failure_preserves_program_registry_and_configuration(tmp_path):
    _, _, mod = modules(); reg = Registry(); source = tmp_path / 'source'; source.mkdir()
    (source / 'DoubaoImageTool.exe').write_bytes(b'original')
    inst = mod.BackendInstaller(tmp_path / 'local', registry=reg, stop_backend=lambda root: None)
    target = inst.install(source, EXT); before = reg.value
    def busy(root): raise ValueError('still draining')
    inst.stop_backend = busy
    (source / 'DoubaoImageTool.exe').write_bytes(b'update')
    with pytest.raises(ValueError, match='still draining'): inst.install(source, EXT)
    assert (target / 'DoubaoImageTool.exe').read_bytes() == b'original' and reg.value == before


def test_registry_adapter_only_uses_hkcu_native_host_key(monkeypatch):
    import sys
    from types import SimpleNamespace
    _, _, mod = modules(); events = []; values = {}
    class Key:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def open_key(hive, path):
        events.append((hive, path))
        if '' not in values: raise FileNotFoundError()
        return Key()
    def create_key(hive, path): events.append((hive, path)); return Key()
    fake = SimpleNamespace(HKEY_CURRENT_USER='HKCU', REG_SZ=1, OpenKey=open_key, CreateKey=create_key,
                           QueryValueEx=lambda key, name: (values[name], 1),
                           SetValueEx=lambda key, name, reserved, typ, val: values.__setitem__(name, val),
                           DeleteKey=lambda hive, path: (events.append((hive, path)), values.clear()))
    monkeypatch.setitem(sys.modules, 'winreg', fake)
    reg = mod.UserRegistry(); assert reg.read() is None
    reg.write('C:\\test\\native-host.json'); assert reg.read() == 'C:\\test\\native-host.json'
    reg.delete(); assert reg.read() is None
    assert set(events) == {('HKCU', 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.productcollector.images')}


def test_authenticated_http_discovery_attach_and_detach(tmp_path):
    from app import create_app
    from werkzeug.serving import make_server
    from run import PrivateRequestHandler
    host, mod, _ = modules()
    app = create_app(state_dir=tmp_path, token='http-test-secret', browser_factory=lambda: pytest.fail('unexpected browser startup'))
    server = make_server('127.0.0.1', 0, app, threaded=True, request_handler=PrivateRequestHandler)
    rt = mod.AutomaticRuntime(tmp_path, 'http-test-secret', server.server_port, Queue(), server.shutdown, EXT, start_watchdog=False)
    rt.register_routes(app)
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    try:
        broker = host.BackendBroker(tmp_path, tmp_path / 'tool.exe', EXT, spawn=lambda _: pytest.fail('started duplicate backend'))
        descriptor = broker.connect('x' * 32)
        assert descriptor['instance'] == rt.instance and 'x' * 32 in rt.leases
        host.http_request(descriptor, 'heartbeat', 'x' * 32)
        host.http_request(descriptor, 'detach', 'x' * 32)
        assert rt.leases == {}
        with pytest.raises(OSError): host.http_request({**descriptor, 'token': 'wrong'}, 'status')
    finally:
        server.shutdown(); worker.join(timeout=3); server.server_close(); rt.close()
        app.extensions['queue'].close(clear_state=False)


def test_drain_failure_still_starts_absolute_exit_deadline(tmp_path):
    rt, now, queue, exits = runtime(tmp_path)
    def failure(): raise OSError('disk unavailable')
    queue.begin_drain = failure
    now[0] = 31
    with pytest.raises(OSError): rt.tick()
    now[0] = 632; rt.tick()
    assert exits == [True]
    rt.close()


def test_installer_waits_for_loaded_native_executable_before_replacing(tmp_path, monkeypatch):
    _, _, mod = modules(); source = tmp_path / 'source'; source.mkdir()
    (source / 'DoubaoImageTool.exe').write_bytes(b'v1')
    inst = mod.BackendInstaller(tmp_path / 'local', registry=Registry(), stop_backend=lambda root: None)
    target = inst.install(source, EXT)
    def busy(executable, **kwargs): raise ValueError('native host still running')
    monkeypatch.setattr(mod, 'wait_program_exit', busy, raising=False)
    (source / 'DoubaoImageTool.exe').write_bytes(b'v2')
    with pytest.raises(ValueError, match='native host still running'): inst.install(source, EXT)
    assert (target / 'DoubaoImageTool.exe').read_bytes() == b'v1'
    with pytest.raises(ValueError, match='native host still running'): inst.uninstall()
    assert target.exists()


def test_windows_process_check_identifies_exact_owned_executable(tmp_path):
    import os
    import shutil
    import subprocess
    _, _, mod = modules()
    executable = tmp_path / 'held.exe'
    shutil.copy2(Path(os.environ['SystemRoot']) / 'System32' / 'cmd.exe', executable)
    process = subprocess.Popen([str(executable), '/Q', '/K'], stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        with pytest.raises(ValueError): mod.wait_program_exit(executable, timeout=0.01)
        mod.wait_program_exit(tmp_path / 'different.exe', timeout=0.01)
    finally: process.communicate(b'exit\r\n', timeout=5)
    mod.wait_program_exit(executable, timeout=0.01)
