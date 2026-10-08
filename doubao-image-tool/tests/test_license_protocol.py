"""Cross-component wire test uses Flask in process, with no real network."""
from pathlib import Path

from Crypto.PublicKey import ECC
from werkzeug.security import generate_password_hash

from license_authority import LicenseAuthority
from license_cache import DpapiLicenseStore
from license_config import LicenseBuildConfig
from license_transport import LicenseResponse, LicenseTransportOutage


def test_real_server_envelope_dpapi_restart_denial_and_manual_revalidation(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'license-server'))
    from licensing import create_app
    key = ECC.generate(curve='Ed25519')
    key_path = tmp_path / 'server-signing.pem'
    key_path.write_text(key.export_key(format='PEM'), encoding='ascii')
    now = [1800000000]
    app = create_app({'TESTING': True, 'DATABASE': str(tmp_path / 'license.sqlite3'),
                      'PRIVATE_KEY_PATH': str(key_path), 'SECRET_KEY': bytes(range(32)).hex(),
                      'ADMIN_PASSWORD_HASH': generate_password_hash('isolated-long-password'),
                      'CLOCK': lambda: now[0], 'PUBLIC_ORIGIN': 'https://license.test'})
    with app.app_context():
        license_id, code = app.extensions['licenses'].create('isolated test')
    class InProcessTransport:
        outage = False
        def request(self, operation, code, device_hash, nonce):
            if self.outage:
                raise LicenseTransportOutage()
            with app.test_client() as client:
                response = client.post('/v1/' + operation, base_url='https://license.test',
                                       json={'code': code, 'device_hash': device_hash, 'nonce': nonce})
                return LicenseResponse(response.status_code, response.get_json())
    transport = InProcessTransport()
    config = LicenseBuildConfig('https://license.test', app.extensions['signer'].public_key)
    profile = tmp_path / 'client-profile'
    def client():
        return LicenseAuthority(profile, config=config, transport=transport,
                                hardware_provider=lambda: 'a' * 64,
                                wall_clock=lambda: now[0] - 1799999000,
                                monotonic_clock=lambda: now[0] - 1799995000)
    assert client().activate(code).allowed
    persisted = DpapiLicenseStore(profile)
    assert code.encode() not in persisted.path.read_bytes()
    now[0] += 10
    transport.outage = True
    restarted = client()
    assert restarted.startup().offline
    transport.outage = False
    with app.app_context():
        app.extensions['licenses'].admin_action(license_id, 'disable')
    assert restarted.refresh().state == 'disabled'
    transport.outage = True
    assert not client().startup().allowed
    with app.app_context():
        app.extensions['licenses'].admin_action(license_id, 'enable')
        app.extensions['licenses'].admin_action(license_id, 'renew')
    transport.outage = False
    renewed = restarted.refresh()
    assert renewed.allowed and renewed.expires_at == 1805184000
