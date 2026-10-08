"""License boundary tests use temporary files, generated keys and injected I/O only."""
import base64
import hashlib
import http.client
import json
import ssl

import pytest
import requests
from urllib3.exceptions import ProtocolError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


@pytest.fixture
def signer():
    private = Ed25519PrivateKey.generate()
    return private, b64(private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))


def envelope(private, **changes):
    value = dict(version=1, license_id='b' * 32, device_hash='a' * 64,
                 issued_at=1800000000, expires_at=1802592000,
                 lease_until=1800086400, nonce='n' * 43)
    value.update(changes)
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return {'payload': b64(raw), 'signature': b64(private.sign(raw))}


def test_hardware_digest_is_stable_and_requires_both_windows_identifiers():
    from license_hardware import HardwareIdentityError, windows_device_hash
    guid = '550E8400-E29B-41D4-A716-446655440000'
    expected = hashlib.sha256(b'monthly-license:v1\n550e8400-e29b-41d4-a716-446655440000\n1234abcd').hexdigest()
    assert windows_device_hash(lambda: guid, lambda: 0x1234ABCD) == expected
    for reader1, reader2 in [(lambda: '', lambda: 1), (lambda: guid, lambda: None),
                             (lambda: 'broken', lambda: 1)]:
        with pytest.raises(HardwareIdentityError):
            windows_device_hash(reader1, reader2)


def test_trust_accepts_server_clock_and_exact_canonical_signed_envelope(signer):
    from license_trust import CredentialVerifier
    private, public = signer
    verified = CredentialVerifier(public).verify(envelope(private), 'a' * 64, 1800000000, 'n' * 43)
    assert verified.expires_at == 1802592000
    assert verified.lease_until == 1800086400


@pytest.mark.parametrize('changes,now,nonce', [
    ({'version': 2}, 1800000000, 'n' * 43),
    ({'device_hash': 'c' * 64}, 1800000000, 'n' * 43),
    ({'issued_at': 1800000001}, 1800000000, 'n' * 43),
    ({'issued_at': True}, 1800000000, 'n' * 43),
    ({'expires_at': 1800000000}, 1800000000, 'n' * 43),
    ({'lease_until': 1800086401}, 1800000000, 'n' * 43),
    ({}, 1800086400, 'n' * 43),
    ({}, 1800000000, 'wrong_nonce_123456'),
    ({'extra': 'field'}, 1800000000, 'n' * 43),
])
def test_trust_rejects_invalid_signed_claims(signer, changes, now, nonce):
    from license_trust import CredentialVerifier, LicenseTrustError
    private, public = signer
    with pytest.raises(LicenseTrustError):
        CredentialVerifier(public).verify(envelope(private, **changes), 'a' * 64, now, nonce)


def test_trust_rejects_tamper_and_accepts_cached_original_nonce(signer):
    from license_trust import CredentialVerifier, LicenseTrustError
    private, public = signer
    verifier = CredentialVerifier(public)
    valid = envelope(private)
    assert verifier.verify(valid, 'a' * 64, 1800000001).issued_at == 1800000000
    damaged = dict(valid, payload=b64(base64.urlsafe_b64decode(valid['payload'] + '==').replace(b'1802592000', b'1802592001')))
    with pytest.raises(LicenseTrustError):
        verifier.verify(damaged, 'a' * 64, 1800000000)
    with pytest.raises(LicenseTrustError):
        verifier.verify(dict(valid, signature='!'), 'a' * 64, 1800000000)


def test_production_config_cannot_be_enabled_by_environment(monkeypatch):
    from license_config import LicenseBuildConfig
    monkeypatch.setenv('LICENSE_SERVER_URL', 'http://127.0.0.1:9999')
    monkeypatch.setenv('LICENSE_BYPASS', '1')
    assert not LicenseBuildConfig().configured
    assert not LicenseBuildConfig('http://example.com', 'a' * 43).configured
    assert not LicenseBuildConfig('https://user:secret@example.com', 'a' * 43).configured
    assert not LicenseBuildConfig('https://example.com/path', 'a' * 43).configured


def test_dpapi_roundtrip_hides_code_and_task_clearing_does_not_remove_it(tmp_path):
    from license_cache import DpapiLicenseStore, LicenseStorageError
    from storage import clear_task_state
    store = DpapiLicenseStore(tmp_path)
    assert store.load() is None
    store.save({'code': 'test-only-license-code-0123456789', 'credential': None})
    assert b'test-only-license-code' not in store.path.read_bytes()
    (tmp_path / 'state').mkdir()
    clear_task_state(tmp_path / 'state')
    assert store.load()['code'] == 'test-only-license-code-0123456789'
    store.path.write_bytes(b'corrupt ciphertext')
    with pytest.raises(LicenseStorageError):
        store.load()
    with pytest.raises(LicenseStorageError):
        DpapiLicenseStore(tmp_path / 'state')


def test_atomic_store_failure_keeps_previous_protected_record(tmp_path):
    from license_cache import DpapiLicenseStore, LicenseStorageError
    broken = False
    def protect(data, decrypt=False):
        if broken:
            raise OSError('secret internal error')
        return data[::-1]
    store = DpapiLicenseStore(tmp_path, protector=protect)
    store.save({'code': 'old'})
    broken = True
    with pytest.raises(LicenseStorageError, match='授权数据') as caught:
        store.save({'code': 'new'})
    assert 'secret' not in str(caught.value)
    broken = False
    assert store.load() == {'code': 'old'}
    assert list(tmp_path.iterdir()) == [store.path]


class Response:
    def __init__(self, status=200, body=b'{"status":"allowed"}'):
        self.status_code, self.body = status, body
    def iter_content(self, chunk_size):
        yield self.body
    def close(self):
        pass


class Session:
    def __init__(self, result):
        self.result = result
        self.trust_env = True
        self.sent = None
    def post(self, url, **kwargs):
        self.sent = (url, kwargs)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def test_transport_posts_body_and_never_follows_redirects(signer):
    from license_config import LicenseBuildConfig
    from license_transport import HttpsLicenseTransport
    session = Session(Response())
    config = LicenseBuildConfig('https://license.example', signer[1])
    response = HttpsLicenseTransport(config, session=session).request('validate', 'code-in-body', 'a' * 64, 'n' * 43)
    assert response.status_code == 200
    url, kwargs = session.sent
    assert url == 'https://license.example/v1/validate'
    assert 'code-in-body' not in url
    assert kwargs['json'] == {'code': 'code-in-body', 'device_hash': 'a' * 64, 'nonce': 'n' * 43}
    assert kwargs['allow_redirects'] is False
    assert session.trust_env is False


@pytest.mark.parametrize('failure,kind', [
    (requests.exceptions.Timeout(), 'outage'),
    (requests.exceptions.ConnectionError(), 'outage'),
    (requests.exceptions.SSLError(ssl.SSLError()), 'untrusted'),
    (Response(500), 'untrusted'), (Response(429), 'untrusted'),
    (Response(302), 'untrusted'), (Response(200, b'html'), 'untrusted'),
    (Response(200, b'x' * 65537), 'untrusted'),
])
def test_transport_only_connection_outages_are_offline_eligible(signer, failure, kind):
    from license_config import LicenseBuildConfig
    from license_transport import HttpsLicenseTransport, LicenseTransportOutage, LicenseResponseError
    expected = LicenseTransportOutage if kind == 'outage' else LicenseResponseError
    with pytest.raises(expected):
        HttpsLicenseTransport(LicenseBuildConfig('https://license.example', signer[1]),
                             session=Session(failure)).request('validate', 'x' * 43, 'a' * 64, 'n' * 43)


def test_loopback_http_needs_explicit_injected_test_config(signer):
    from license_config import LicenseBuildConfig
    assert not LicenseBuildConfig('http://127.0.0.1:8000', signer[1]).configured
    assert LicenseBuildConfig('http://127.0.0.1:8000', signer[1], allow_loopback_http=True).configured
    assert not LicenseBuildConfig('http://remote.example', signer[1], allow_loopback_http=True).configured


def test_timeout_after_http_denial_is_never_an_offline_eligible_outage(signer):
    from license_config import LicenseBuildConfig
    from license_transport import HttpsLicenseTransport, LicenseResponseError
    class InterruptedDenial(Response):
        def iter_content(self, chunk_size):
            raise requests.exceptions.Timeout()
    with pytest.raises(LicenseResponseError):
        HttpsLicenseTransport(LicenseBuildConfig('https://license.example', signer[1]),
                             session=Session(InterruptedDenial(403))).request('validate', 'x' * 43, 'a' * 64, 'n' * 43)


def test_failed_atomic_replace_and_cleanup_never_expose_storage_details(tmp_path, monkeypatch):
    import license_cache
    from license_cache import DpapiLicenseStore, LicenseStorageError
    store = DpapiLicenseStore(tmp_path, protector=lambda raw, decrypt=False: raw[::-1])
    store.save({'code': 'old-code'})
    def fail(*args, **kwargs):
        raise OSError('sensitive disk details')
    monkeypatch.setattr(license_cache.os, 'replace', fail)
    monkeypatch.setattr(license_cache.Path, 'unlink', fail)
    with pytest.raises(LicenseStorageError) as caught:
        store.save({'code': 'new-code'})
    assert 'sensitive' not in str(caught.value)
    assert store.load() == {'code': 'old-code'}


def test_malformed_http_status_line_is_not_a_transport_outage(signer):
    from license_config import LicenseBuildConfig
    from license_transport import HttpsLicenseTransport, LicenseResponseError
    broken_http = requests.exceptions.ConnectionError(ProtocolError('invalid status line', http.client.BadStatusLine('garbage')))
    with pytest.raises(LicenseResponseError):
        HttpsLicenseTransport(LicenseBuildConfig('https://license.example', signer[1]),
                             session=Session(broken_http)).request('validate', 'x' * 43, 'a' * 64, 'n' * 43)
