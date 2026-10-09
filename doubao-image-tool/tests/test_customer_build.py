"""Packaging boundaries: configuration and actual staged customer files."""
import importlib.util
import json
from pathlib import Path

import pytest

from test_license_components import signer

ROOT = Path(__file__).resolve().parents[2]


def builder():
    assert importlib.util.find_spec('customer_build') is not None, 'Customer build boundary is missing'
    import customer_build
    return customer_build


def test_formal_build_requires_explicit_public_configuration(tmp_path, monkeypatch, signer):
    b = builder()
    monkeypatch.setenv('LICENSE_SERVER_URL', 'https://injected.example')
    monkeypatch.setenv('LICENSE_PUBLIC_KEY', signer[1])
    with pytest.raises(ValueError):
        b.prepare(ROOT, tmp_path/'missing')
    assert not (tmp_path/'missing').exists()
    config = tmp_path/'public.json'
    config.write_text(json.dumps({'server_url':'https://licenses.example.com', 'public_key':signer[1]}))
    stage = b.prepare(ROOT, tmp_path/'formal', public_config=config)
    import runpy
    fixed = runpy.run_path(str(stage/'tool'/'license_config.py'))
    assert fixed['LicenseBuildConfig']().configured
    assert fixed['LICENSE_SERVER_URL'] == 'https://licenses.example.com'
    assert fixed['LICENSE_PUBLIC_KEY'] == signer[1]
    assert fixed['LicenseBuildConfig']().allow_loopback_http is False


@pytest.mark.parametrize('change', [
    {'server_url':'http://127.0.0.1:1234'}, {'server_url':'https://u:p@example.com'},
    {'server_url':'https://example.com/path'}, {'server_url':'https://example.com?x=1'},
    {'server_url':'https://example.com:bad'}, {'public_key':'x'*44},
    {'public_key':'_'*43}, {'private_key':'never-ship'}, {'allow_loopback_http':True},
])
def test_rejects_unsafe_or_private_formal_configuration(tmp_path, signer, change):
    b = builder()
    config = tmp_path/'public.json'
    config.write_text(json.dumps({'server_url':'https://licenses.example.com','public_key':signer[1], **change}))
    with pytest.raises(ValueError): b.prepare(ROOT,tmp_path/'stage',public_config=config)
    assert not (tmp_path/'stage').exists()


def test_evaluation_stages_locked_configuration_and_only_customer_allowlist(tmp_path):
    b = builder()
    stage = b.prepare(ROOT,tmp_path/'stage',evaluation_locked=True)
    import runpy
    assert not runpy.run_path(str(stage/'tool'/'license_config.py'))['LicenseBuildConfig']().configured
    assert (stage/'EVALUATION-LOCKED.txt').exists()
    assert (stage/'extension'/'manifest.json').exists()
    assert (stage/'导入产品模板.xls').exists()
    assert (stage/'tool'/'docs'/'月度授权客户激活说明.md').is_file()
    readme=(stage/'tool'/'README.md').read_text(encoding='utf-8')
    assert '../docs/月度授权客户激活说明.md' not in readme
    assert not (stage/'license-server').exists()
    assert not (stage/'tool'/'tests').exists()
    assert not (stage/'tool'/'customer_build.py').exists()
    assert not (stage/'tool'/'build.ps1').exists()
    assert b.scan(stage) > 20
    with pytest.raises(FileExistsError):b.prepare(ROOT,stage,evaluation_locked=True)


@pytest.mark.parametrize('name,content', [
    ('license.dpapi',b'personal'),('license.sqlite3',b'database'),('signing.pem',b'private'),
    ('chrome-profile/Cookies',b'personal'),('.license.lock',b'personal'),
    ('note.txt',b'-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----'),
    ('config.json',b'{"ADMIN_PASSWORD_HASH":"sensitive"}'),
    ('settings.json',b'{"access_key_secret":"sensitive"}'),
])
def test_customer_secret_scan_rejects_runtime_or_server_state(tmp_path, name, content):
    b = builder()
    path=tmp_path/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)
    with pytest.raises(ValueError):b.scan(tmp_path)


def test_allowlist_does_not_copy_accidental_credentials(tmp_path):
    b = builder()
    import shutil
    repo=tmp_path/'repo';repo.mkdir()
    shutil.copytree(ROOT/'doubao-image-tool',repo/'doubao-image-tool',ignore=shutil.ignore_patterns('__pycache__','.pytest_cache','tests'))
    shutil.copytree(ROOT/'extension',repo/'extension')
    shutil.copy2(ROOT/'导入产品模板.xls',repo/'导入产品模板.xls')
    (repo/'docs').mkdir()
    for name in ('月度授权客户激活说明.md','月度授权部署与验收.md'):
        shutil.copy2(ROOT/'docs'/name,repo/'docs'/name)
    (repo/'doubao-image-tool'/'license.dpapi').write_bytes(b'personal-license')
    (repo/'doubao-image-tool'/'signing.pem').write_bytes(b'private-signing-key')
    (repo/'extension'/'config.json').write_text('{"password":"personal"}')
    stage=b.prepare(repo,tmp_path/'stage',evaluation_locked=True)
    assert not (stage/'tool'/'license.dpapi').exists()
    assert not (stage/'tool'/'signing.pem').exists()
    assert not (stage/'extension'/'config.json').exists()


def test_frozen_ca_bundle_is_allowed_but_private_key_is_rejected(tmp_path):
    b=builder()
    path=tmp_path/'_internal'/'certifi'/'cacert.pem';path.parent.mkdir(parents=True)
    path.write_text('-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----')
    assert b.scan(tmp_path)==1
    path.write_text('-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----')
    with pytest.raises(ValueError):b.scan(tmp_path)
