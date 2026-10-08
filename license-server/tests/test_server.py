import base64
import hashlib
import importlib.util
import json
import logging
import re
import shutil
import sqlite3
import sys
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from Crypto.PublicKey import ECC
from Crypto.Signature import eddsa
from werkzeug.security import generate_password_hash

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DEVICE_A = 'a' * 64
DEVICE_B = 'b' * 64
NOW = 1_800_000_000
MONTH = 2_592_000


def setup_server(tmp_path, **overrides):
    assert importlib.util.find_spec('licensing') is not None, 'Authorization server is not implemented'
    from licensing import create_app
    key = ECC.generate(curve='Ed25519')
    key_path = tmp_path / 'signing.pem'
    key_path.write_text(key.export_key(format='PEM'), encoding='ascii')
    current = [NOW]
    config = dict(TESTING=True, DATABASE=str(tmp_path / 'license.sqlite3'),
                  PRIVATE_KEY_PATH=str(key_path), SECRET_KEY=bytes(range(32)).hex(),
                  ADMIN_PASSWORD_HASH=generate_password_hash('a-long-isolated-test-password'),
                  CLOCK=lambda: current[0], PUBLIC_ORIGIN='https://license.test',
                  ACTIVATION_LIMIT=100, LOGIN_LIMIT=5)
    config.update(overrides)
    app = create_app(config)
    return app, current, key


def create_code(app):
    with app.app_context():
        return app.extensions['licenses'].create('test note')


def call(app, code, device=DEVICE_A, endpoint='activate', nonce='nonce-for-isolated-test-0001'):
    with app.test_client() as client:
        return client.post('/v1/' + endpoint, json=dict(code=code, device_hash=device, nonce=nonce), base_url='https://license.test')


def mutate(app, license_id, action, **kwargs):
    with app.app_context():
        return app.extensions['licenses'].admin_action(license_id, action, **kwargs)


def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def login(client):
    page = client.get('/admin/login', base_url='https://license.test')
    csrf = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
    return client.post('/admin/login', data={'csrf_token': csrf, 'password': 'a-long-isolated-test-password'}, base_url='https://license.test')


def test_first_activation_and_signed_nonce(tmp_path):
    app, clock, key = setup_server(tmp_path)
    license_id, code = create_code(app)
    response = call(app, code)
    assert response.status_code == 200
    body = response.get_json()
    assert body['status'] == 'allowed'
    assert body['server_time'] == NOW
    assert body['expires_at'] == NOW + MONTH
    envelope = body['credential']
    payload_bytes = decode(envelope['payload'])
    eddsa.new(key.public_key(), 'rfc8032').verify(payload_bytes, decode(envelope['signature']))
    payload = json.loads(payload_bytes)
    assert payload == dict(version=1, license_id=license_id, device_hash=DEVICE_A,
                           issued_at=NOW, expires_at=NOW + MONTH, lease_until=NOW + 86400,
                           nonce='nonce-for-isolated-test-0001')
    assert payload_bytes == json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    with pytest.raises(ValueError):
        eddsa.new(key.public_key(), 'rfc8032').verify(payload_bytes + b' ', decode(envelope['signature']))


def test_exact_expiry_and_lease_cap(tmp_path):
    app, clock, _ = setup_server(tmp_path)
    _, code = create_code(app)
    call(app, code)
    clock[0] += MONTH - 1
    body = call(app, code, endpoint='validate').get_json()
    assert json.loads(decode(body['credential']['payload']))['lease_until'] == NOW + MONTH
    clock[0] += 1
    denied = call(app, code, endpoint='validate')
    assert denied.status_code == 403
    assert denied.get_json()['status'] == 'expired'
    assert 'credential' not in denied.get_json()


def test_validate_cannot_start_unused_license(tmp_path):
    app, _, _ = setup_server(tmp_path)
    _, code = create_code(app)
    assert call(app, code, endpoint='validate').get_json()['status'] == 'unbound'
    assert call(app, 'unknown-code-with-enough-entropy').get_json()['status'] == 'unknown_code'


def test_second_device_denied_and_same_device_does_not_extend(tmp_path):
    app, clock, _ = setup_server(tmp_path)
    _, code = create_code(app)
    call(app, code)
    clock[0] += 123
    assert call(app, code).get_json()['expires_at'] == NOW + MONTH
    assert call(app, code, DEVICE_B).get_json()['status'] == 'device_mismatch'


def test_concurrent_first_activation_binds_once(tmp_path):
    app, _, _ = setup_server(tmp_path)
    _, code = create_code(app)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda device: call(app, code, device).get_json(), [DEVICE_A, DEVICE_B]))
    assert sorted(r['status'] for r in responses) == ['allowed', 'device_mismatch']


def test_renew_before_and_after_expiry(tmp_path):
    app, clock, _ = setup_server(tmp_path)
    license_id, code = create_code(app)
    call(app, code)
    mutate(app, license_id, 'renew')
    assert call(app, code).get_json()['expires_at'] == NOW + 2 * MONTH
    clock[0] = NOW + 2 * MONTH + 80
    mutate(app, license_id, 'renew')
    assert call(app, code).get_json()['expires_at'] == NOW + 3 * MONTH + 80


def test_renew_unused_code_cannot_start_countdown(tmp_path):
    app, clock, _ = setup_server(tmp_path)
    license_id, code = create_code(app)
    with pytest.raises(ValueError, match='Activate this license before renewing'):
        mutate(app, license_id, 'renew')
    with app.test_client() as client:
        login(client)
        page = client.get('/admin/', base_url='https://license.test')
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
        response = client.post('/admin/' + license_id + '/renew', data={'csrf_token': csrf}, base_url='https://license.test')
        assert response.status_code == 400
        assert 'Activate this license before renewing' in response.text
    clock[0] += 300
    assert call(app, code).get_json()['expires_at'] == NOW + 300 + MONTH


def test_disable_enable_and_unbind_preserve_expiry(tmp_path):
    app, clock, _ = setup_server(tmp_path)
    license_id, code = create_code(app)
    call(app, code)
    mutate(app, license_id, 'disable')
    assert call(app, code).get_json()['status'] == 'disabled'
    mutate(app, license_id, 'enable')
    assert call(app, code, endpoint='validate').get_json()['status'] == 'allowed'
    clock[0] += 50
    mutate(app, license_id, 'unbind')
    assert call(app, code, endpoint='validate').get_json()['status'] == 'unbound'
    body = call(app, code, DEVICE_B).get_json()
    assert body['status'] == 'allowed'
    assert body['expires_at'] == NOW + MONTH
    assert call(app, code, DEVICE_A).get_json()['status'] == 'device_mismatch'


def test_expired_unbound_license_cannot_get_new_month(tmp_path):
    app, clock, _ = setup_server(tmp_path)
    license_id, code = create_code(app)
    call(app, code)
    mutate(app, license_id, 'unbind')
    clock[0] += MONTH
    assert call(app, code, DEVICE_B).get_json()['status'] == 'expired'


def test_code_digest_storage_and_logs_never_contain_code(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    app, _, key = setup_server(tmp_path)
    license_id, code = create_code(app)
    assert len(code) >= 40
    call(app, code)
    with sqlite3.connect(app.config['DATABASE']) as db:
        rows = db.execute('SELECT * FROM licenses').fetchall()
    assert code not in str(rows)
    assert hashlib.sha256(code.encode()).hexdigest() in str(rows)
    assert code not in caplog.text
    assert key.export_key(format='PEM') not in caplog.text


def test_shared_rate_limit_across_app_workers(tmp_path):
    app, clock, _ = setup_server(tmp_path, ACTIVATION_LIMIT=2)
    _, code = create_code(app)
    call(app, code)
    from licensing import create_app
    second = create_app(app.config)
    call(second, code, endpoint='validate')
    denied = call(app, code)
    assert denied.status_code == 429
    assert denied.get_json()['status'] == 'rate_limited'
    clock[0] += 61
    assert call(second, code).status_code == 200


@pytest.mark.parametrize('bad', [dict(code='x', device_hash=DEVICE_A, nonce='short'),
                                       dict(code='x' * 300, device_hash=DEVICE_A, nonce='n' * 24),
                                       dict(code='x' * 40, device_hash='bad', nonce='n' * 24)])
def test_malformed_requests_fail_closed(tmp_path, bad):
    app, _, _ = setup_server(tmp_path)
    with app.test_client() as client:
        response = client.post('/v1/activate', json=bad, base_url='https://license.test')
    assert response.status_code == 400
    assert 'credential' not in response.get_json()


def test_admin_login_csrf_and_secure_cookie(tmp_path):
    app, _, _ = setup_server(tmp_path)
    with app.test_client() as client:
        assert client.get('/admin/', base_url='https://license.test').status_code == 302
        assert client.post('/admin/login', data={'password': 'a-long-isolated-test-password'}, base_url='https://license.test').status_code == 400
        response = login(client)
        assert response.status_code == 302
        cookie = response.headers['Set-Cookie']
        assert 'Secure;' in cookie and 'HttpOnly;' in cookie and 'SameSite=Strict' in cookie
        assert client.post('/admin/create', data={'note': 'x'}, base_url='https://license.test').status_code == 400


def test_admin_create_once_note_renew_disable_enable_unbind(tmp_path):
    app, _, _ = setup_server(tmp_path)
    with app.test_client() as client:
        login(client)
        page = client.get('/admin/', base_url='https://license.test')
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
        created = client.post('/admin/create', data={'csrf_token': csrf, 'note': '<script>test</script>'}, base_url='https://license.test')
        code = re.search(r'id="new-code">([^<]+)', created.text).group(1)
        with client.session_transaction() as active_session:
            assert code not in str(dict(active_session))
        assert code not in client.get('/admin/', base_url='https://license.test').text
        assert '<script>test</script>' not in created.text
        with sqlite3.connect(app.config['DATABASE']) as db:
            license_id = db.execute('SELECT id FROM licenses').fetchone()[0]
        call(app, code)
        for action in ['note', 'renew', 'disable', 'enable', 'unbind']:
            result = client.post('/admin/' + license_id + '/' + action, data={'csrf_token': csrf, 'note': 'updated'}, base_url='https://license.test')
            assert result.status_code == 302
        listing = client.get('/admin/', base_url='https://license.test').text
        assert 'updated' in listing
        assert code not in listing
        assert call(app, code, endpoint='validate').get_json()['status'] == 'unbound'


def test_login_limit_shared_and_bad_password_does_not_authenticate(tmp_path):
    app, clock, _ = setup_server(tmp_path, LOGIN_LIMIT=2)
    from licensing import create_app
    second = create_app(app.config)
    for application in [app, second]:
        with application.test_client() as client:
            page = client.get('/admin/login', base_url='https://license.test')
            csrf = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
            response = client.post('/admin/login', data={'csrf_token': csrf, 'password': 'wrong'}, base_url='https://license.test')
            assert response.status_code == 401
            assert client.get('/admin/', base_url='https://license.test').status_code == 302
    with app.test_client() as client:
        assert login(client).status_code == 429
        clock[0] += 901
        assert login(client).status_code == 302


@pytest.mark.parametrize('overrides', [{'SECRET_KEY': 'weak'}, {'ADMIN_PASSWORD_HASH': ''}, {'PUBLIC_ORIGIN': 'http://license.test'}, {'PRIVATE_KEY_PATH': 'missing.pem'}])
def test_weak_configuration_refused(tmp_path, overrides):
    assert importlib.util.find_spec('licensing') is not None, 'Authorization server is not implemented'
    with pytest.raises((ValueError, FileNotFoundError)):
        setup_server(tmp_path, **overrides)


def test_plain_http_refused_and_no_cors(tmp_path):
    app, _, _ = setup_server(tmp_path)
    with app.test_client() as client:
        response = client.post('/v1/activate', json={}, base_url='http://license.test')
        assert response.status_code == 400
        assert 'Access-Control-Allow-Origin' not in response.headers


def test_initializer_creates_external_private_files_and_no_secrets_in_output(tmp_path):
    assert importlib.util.find_spec('licensing.cli') is not None, 'Private initialization CLI is not implemented'
    from licensing.cli import initialize
    target = tmp_path / 'private'
    public_key = initialize(target, 'https://license.test', 'isolated-long-admin-password', container=True)
    config = json.loads((target / 'config.json').read_text())
    assert config['PRIVATE_KEY_PATH'] == '/run/license/signing.pem'
    assert config['DATABASE'] == '/var/lib/license/licenses.sqlite3'
    assert config['TRUST_PROXY'] is True
    assert 'isolated-long-admin-password' not in (target / 'config.json').read_text()
    assert len(decode(public_key)) == 32
    private_key = ECC.import_key((target / 'signing.pem').read_text())
    assert decode(public_key) == private_key.public_key().export_key(format='raw')
    with pytest.raises((ValueError, FileExistsError)):
        initialize(target, 'https://license.test', 'isolated-long-admin-password')


def test_initializer_refuses_repository_and_weak_password(tmp_path):
    assert importlib.util.find_spec('licensing.cli') is not None, 'Private initialization CLI is not implemented'
    from licensing.cli import initialize
    with pytest.raises(ValueError):
        initialize(ROOT / 'private', 'https://license.test', 'isolated-long-admin-password')
    with pytest.raises(ValueError):
        initialize(tmp_path / 'weak', 'https://license.test', 'password')
    assert not (tmp_path / 'weak').exists()


def test_external_state_and_low_entropy_session_secret_required(tmp_path):
    with pytest.raises(ValueError):
        setup_server(tmp_path, DATABASE=str(ROOT / 'state.sqlite3'))
    with pytest.raises(ValueError):
        setup_server(tmp_path, SECRET_KEY='0' * 64)


def test_public_key_cannot_be_used_as_private_signing_key(tmp_path):
    app, _, key = setup_server(tmp_path)
    public = tmp_path / 'public.pem'
    public.write_text(key.public_key().export_key(format='PEM'))
    from licensing import create_app
    with pytest.raises(ValueError):
        create_app(dict(app.config, PRIVATE_KEY_PATH=str(public)))


def test_admin_cross_origin_and_logout_protected(tmp_path):
    app, _, _ = setup_server(tmp_path)
    with app.test_client() as client:
        login(client)
        page = client.get('/admin/', base_url='https://license.test')
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
        assert client.post('/admin/create', data={'csrf_token': csrf}, headers={'Origin': 'https://evil.test'}, base_url='https://license.test').status_code == 400
        assert client.get('/admin/', base_url='https://evil.test').status_code == 400
        assert client.post('/admin/logout', base_url='https://license.test').status_code == 400
        assert client.post('/admin/logout', data={'csrf_token': csrf}, base_url='https://license.test').status_code == 302
        assert client.get('/admin/', base_url='https://license.test').status_code == 302


def test_file_configuration_cannot_enable_test_http_or_weaken_cookies(tmp_path, monkeypatch):
    app, _, _ = setup_server(tmp_path)
    from licensing import create_app
    settings = {name: app.config[name] for name in ['DATABASE', 'PRIVATE_KEY_PATH', 'SECRET_KEY', 'ADMIN_PASSWORD_HASH', 'PUBLIC_ORIGIN']}
    path = tmp_path / 'config.json'
    for overrides in [{'TESTING': True, 'ALLOW_TEST_HTTP': True}, {'SESSION_COOKIE_SECURE': False}, {'DEBUG': True}]:
        path.write_text(json.dumps(dict(settings, **overrides)))
        monkeypatch.setenv('LICENSE_CONFIG', str(path))
        with pytest.raises(ValueError):
            create_app()


def test_no_default_configuration_or_repository_secret_config(tmp_path, monkeypatch):
    from licensing import create_app
    monkeypatch.delenv('LICENSE_CONFIG', raising=False)
    with pytest.raises(ValueError):
        create_app()
    monkeypatch.setenv('LICENSE_CONFIG', str(ROOT / 'config.json'))
    with pytest.raises(ValueError):
        create_app()


def test_git_excludes_private_artifacts_but_keeps_server_source():
    private = ['license-server/.env', 'license-server/private/config.json', 'license-server/data/licenses.sqlite3',
               'license-server/signing.pem', 'license-server/admin-init.json', 'license-server/data/licenses.sqlite3-journal']
    result = subprocess.run(['git', 'check-ignore', '--no-index', *private], cwd=ROOT.parent, capture_output=True, text=True, check=False)
    assert result.returncode == 0
    assert set(result.stdout.splitlines()) == set(private)
    source = subprocess.run(['git', 'check-ignore', '--no-index', 'license-server/licensing/routes.py'], cwd=ROOT.parent, capture_output=True, check=False)
    assert source.returncode == 1


def test_deployed_layout_without_git_accepts_external_private_state(tmp_path):
    app, _, _ = setup_server(tmp_path)
    deployment = tmp_path / 'deployed-app'
    shutil.copytree(ROOT / 'licensing', deployment / 'licensing', ignore=shutil.ignore_patterns('__pycache__'))
    settings = {name: app.config[name] for name in ['DATABASE', 'PRIVATE_KEY_PATH', 'SECRET_KEY', 'ADMIN_PASSWORD_HASH', 'PUBLIC_ORIGIN']}
    config = tmp_path / 'config.json'
    config.write_text(json.dumps(settings))
    # Same layout as /app/licensing in Docker; secrets are a sibling mount.
    import os
    environment = dict(os.environ, LICENSE_CONFIG=str(config))
    result = subprocess.run([sys.executable, '-c', 'from licensing import create_app; create_app(); print("configured")'],
                            cwd=deployment, env=environment, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'configured'
