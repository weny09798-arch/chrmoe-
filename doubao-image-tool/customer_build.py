"""Customer source allowlist and fixed public build configuration.

Evaluation builds are deliberately unconfigured and locked. Test injection is
never packaged. No environment variable can provide server configuration.
"""
import argparse
import base64
import json
import re
import shutil
from pathlib import Path

from license_config import LicenseBuildConfig

TOOL_FILES = tuple('''aliyun_translation.py app.py bridge_routes.py browser.py cloud_images.py
core.py credentials.py folder_picker.py image_batch.py license_authority.py license_cache.py
license_config.py license_hardware.py license_transport.py license_trust.py oss_storage.py
prompts.py run.py storage.py README.md requirements.txt THIRD_PARTY_NOTICES.md
启动豆包图片转换.cmd'''.split())
WEB_FILES = ('app.js','index.html','style.css')
EXTENSION_FILES = tuple('''background.js content-1688.js content-taobao.js content.js
conversion-ui.mjs detail-1688.js detail-content.js detail-pdd-ui.js detail-taobao.js
manager.css manager.html manager.mjs manifest.json
lib/browser.mjs lib/core.mjs lib/detail.mjs lib/fingerprint.mjs lib/gbk.mjs
lib/image-conversion.mjs lib/licensing.mjs lib/pdd-search-page.mjs lib/products.mjs
lib/refill.mjs lib/runner.mjs lib/sites.mjs lib/taobao-page.mjs lib/template.mjs
lib/xls-biff.mjs lib/xlsx.mjs icons/icon16.png icons/icon48.png icons/icon128.png
vendor/xlsx.full.min.js vendor/LICENSE-SheetJS.txt'''.split())
FORBIDDEN_PARTS = {'license-server','chrome-profile','profile','state','.license.lock',
                   'cookies','login data','config.json','signing.pem','license.dpapi',
                   'aliyun.dpapi','oss.dpapi','instance.lock'}
SECRET_FIELDS = {'admin_password_hash','private_key','secret_key','access_key_secret','password'}


def public_values(path):
    if path is None:
        raise ValueError('Formal build requires an explicit public configuration file')
    values=json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(values,dict) or set(values) != {'server_url','public_key'}:
        raise ValueError('Only server_url and public_key are allowed in public build configuration')
    config=LicenseBuildConfig(**values)
    if not config.configured:
        raise ValueError('Formal build requires a fixed HTTPS origin and Ed25519 public key')
    raw=base64.urlsafe_b64decode(config.public_key+'=')
    if len(raw)!=32 or base64.urlsafe_b64encode(raw).decode().rstrip('=')!=config.public_key:
        raise ValueError('Ed25519 public key must be canonical base64url raw32')
    return values


def _copy(source,target):
    if source.is_symlink() or any(parent.is_symlink() for parent in source.parents):
        raise ValueError('Symlinks are not allowed in customer sources')
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source,target)


def _json_has_secret(value):
    if isinstance(value,dict):
        return any((key.lower() in SECRET_FIELDS and item not in ('',None)) or
                   _json_has_secret(item) for key,item in value.items())
    return isinstance(value,list) and any(_json_has_secret(item) for item in value)


def scan(directory):
    """Reject personal/server artifacts; inspect own text (runtime libraries excluded)."""
    count=0
    for path in Path(directory).rglob('*'):
        relative=path.relative_to(directory)
        if path.is_symlink() or any(part.lower() in FORBIDDEN_PARTS for part in relative.parts):
            raise ValueError('Forbidden customer artifact: '+str(relative))
        if not path.is_file():continue
        count+=1
        if tuple(part.lower() for part in relative.parts[-3:])==('_internal','certifi','cacert.pem'):
            # Requests' public CA trust bundle is required for HTTPS.
            if 'PRIVATE KEY' in path.read_text(encoding='ascii'):
                raise ValueError('Private key in CA bundle')
            continue
        if path.suffix.lower() in {'.dpapi','.sqlite','.sqlite3','.db','.pem','.key'}:
            raise ValueError('Private/runtime artifact: '+str(relative))
        if '_internal' in relative.parts or path.suffix.lower() not in {'.py','.json','.txt','.md','.js','.mjs','.html'}:
            continue
        text=path.read_text(encoding='utf-8')
        if re.search(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----',text):
            raise ValueError('Private key material: '+str(relative))
        if path.suffix=='.json' and _json_has_secret(json.loads(text)):
            raise ValueError('Private configuration: '+str(relative))
    return count


def prepare(repository,destination,*,public_config=None,evaluation_locked=False):
    repository,destination=Path(repository),Path(destination)
    if evaluation_locked and public_config is not None:
        raise ValueError('Locked evaluation must not include an authorization configuration')
    values={'server_url':'','public_key':''} if evaluation_locked else public_values(public_config)
    # Validate before creating anything, and never reuse a stale/customer folder.
    destination.mkdir(parents=True,exist_ok=False)
    for name in TOOL_FILES:_copy(repository/'doubao-image-tool'/name,destination/'tool'/name)
    for name in WEB_FILES:_copy(repository/'doubao-image-tool'/'web'/name,destination/'tool'/'web'/name)
    _copy(repository/'docs'/'月度授权客户激活说明.md',destination/'tool'/'docs'/'月度授权客户激活说明.md')
    readme=destination/'tool'/'README.md'
    readme.write_text(readme.read_text(encoding='utf-8').replace(
        '../docs/月度授权客户激活说明.md','docs/月度授权客户激活说明.md').replace(
        '[月度授权部署与验收](../docs/月度授权部署与验收.md)','源码仓库中的月度授权部署与验收文档'),encoding='utf-8')
    for name in EXTENSION_FILES:_copy(repository/'extension'/name,destination/'extension'/name)
    _copy(repository/'导入产品模板.xls',destination/'导入产品模板.xls')
    config=destination/'tool'/'license_config.py'
    text=config.read_text(encoding='utf-8')
    text=text.replace("LICENSE_SERVER_URL = ''",'LICENSE_SERVER_URL = '+repr(values['server_url']))
    text=text.replace("LICENSE_PUBLIC_KEY = ''",'LICENSE_PUBLIC_KEY = '+repr(values['public_key']))
    config.write_text(text,encoding='utf-8')
    (destination/'BUILD-INFO.json').write_text(json.dumps({
        'version':'1.7.0','mode':'evaluation-locked' if evaluation_locked else 'configured-candidate',
        **values},indent=2),encoding='utf-8')
    if evaluation_locked:
        (destination/'EVALUATION-LOCKED.txt').write_text(
            'ISOLATED EVALUATION ONLY — unconfigured/locked; no customer acceptance.\n'
            'No fake license service or authorization bypass is included.\n',encoding='utf-8')
    scan(destination)
    return destination


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',type=Path)
    parser.add_argument('--public-config',type=Path)
    parser.add_argument('--evaluation-locked',action='store_true')
    parser.add_argument('--scan',type=Path)
    args=parser.parse_args()
    if args.scan:
        print('Customer scan passed:',scan(args.scan),'files')
    elif args.stage:
        print(prepare(Path(__file__).resolve().parents[1],args.stage,
                      public_config=args.public_config,evaluation_locked=args.evaluation_locked))
    else:parser.error('--stage or --scan is required')
