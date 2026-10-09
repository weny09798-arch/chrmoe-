"""ISOLATED EVALUATION: real HTTP client/server, ephemeral private state only.

No shipped bypass, browser, conversion service, RAM, or OSS network is used.
"""
import threading
from pathlib import Path

import pytest
from Crypto.PublicKey import ECC
from werkzeug.security import generate_password_hash
from werkzeug.serving import make_server, WSGIRequestHandler

from license_authority import LicenseAuthority
from license_config import LicenseBuildConfig
from license_transport import HttpsLicenseTransport
from test_licensing import Clock, Store

MONTH=2592000
NOW=1800000000


class QuietHandler(WSGIRequestHandler):
    def log(self,*args):pass


@pytest.fixture
def http_rig(tmp_path,monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]/'license-server'))
    from licensing import create_app
    key=ECC.generate(curve='Ed25519')
    path=tmp_path/'ephemeral-signing.pem';path.write_text(key.export_key(format='PEM'),encoding='ascii')
    clock=Clock()
    now=lambda:NOW+int(clock.mono-5000)
    app=create_app(dict(TESTING=True,ALLOW_TEST_HTTP=True,DATABASE=str(tmp_path/'ephemeral.sqlite3'),
                        PRIVATE_KEY_PATH=str(path),SECRET_KEY=bytes(range(32)).hex(),
                        ADMIN_PASSWORD_HASH=generate_password_hash('isolated-evaluation-only-password'),
                        CLOCK=now,PUBLIC_ORIGIN='https://evaluation.invalid'))
    store=app.extensions['licenses']
    listener=make_server('127.0.0.1',0,app,threaded=True,request_handler=QuietHandler)
    port=listener.server_port
    worker=threading.Thread(target=listener.serve_forever,daemon=True);worker.start()
    clients=[]
    def client(device='a'*64):
        config=LicenseBuildConfig(f'http://127.0.0.1:{port}',app.extensions['signer'].public_key,allow_loopback_http=True)
        transport=HttpsLicenseTransport(config)
        authority=LicenseAuthority(config=config,store=Store(),transport=transport,hardware_provider=lambda:device,
                                   wall_clock=lambda:clock.wall,monotonic_clock=lambda:clock.mono)
        clients.append((authority,transport))
        return authority
    def offline():
        listener.shutdown();worker.join(timeout=3);listener.server_close()
    yield client,clock,store,offline
    if worker.is_alive():offline()
    for authority,transport in clients:authority.close();transport.close()


def test_http_activation_second_computer_expiry_renewal_and_unbind(http_rig):
    client,clock,store,_=http_rig
    license_id,code=store.create('isolated lifecycle')
    a,b=client(),client('b'*64)
    first=a.activate(code)
    assert first.allowed and first.expires_at==1802592000 and first.lease_until==1800086400
    assert b.activate(code).state=='device_mismatch'
    clock.advance(100)
    assert a.refresh().expires_at==1802592000
    store.admin_action(license_id,'renew')
    assert a.refresh().expires_at==1805184000
    clock.advance(2*MONTH-100)
    assert a.refresh().state=='expired'
    store.admin_action(license_id,'renew')
    assert a.refresh().expires_at==1807776000
    store.admin_action(license_id,'unbind')
    assert a.refresh().state=='unbound'
    assert b.activate(code).expires_at==1807776000
    assert a.activate(code).state=='device_mismatch'


def test_http_offline_lease_has_exact_24_hour_bound(http_rig):
    client,clock,store,offline=http_rig
    _,code=store.create('isolated offline')
    authority=client();assert authority.activate(code).allowed
    offline();clock.advance(86399,wall=False)
    assert authority.refresh().allowed and authority.status().offline
    clock.advance(1,wall=False)
    assert not authority.status().allowed


def test_http_explicit_revocation_prevents_offline_reuse(http_rig):
    client,_,store,offline=http_rig
    license_id,code=store.create('isolated revocation')
    authority=client();assert authority.activate(code).allowed
    store.admin_action(license_id,'disable')
    assert authority.refresh().state=='disabled'
    offline()
    assert not authority.refresh().allowed


def test_http_offline_lease_never_outlives_license_expiry(http_rig):
    client,clock,store,offline=http_rig
    _,code=store.create('isolated expiry')
    authority=client();assert authority.activate(code).allowed
    clock.advance(MONTH-100)
    assert authority.refresh().lease_until==1802592000
    offline();clock.advance(99)
    assert authority.refresh().allowed
    clock.advance(1)
    assert authority.status().state=='expired'
