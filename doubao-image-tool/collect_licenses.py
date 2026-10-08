"""Collect installed runtime distribution licenses for the portable package."""
import argparse
import importlib.metadata
import json
from pathlib import Path

PACKAGES = ['flask','werkzeug','jinja2','markupsafe','itsdangerous','click','blinker','pillow','playwright','pyee','greenlet','typing_extensions','colorama','openpyxl','et-xmlfile']
PACKAGES += ['alibabacloud-oss-v2','crcmod-plus','pycryptodome']
PACKAGES += ['alibabacloud-alimt20181012','alibabacloud-tea-openapi','alibabacloud-tea-util',
    'alibabacloud-credentials','alibabacloud-credentials-api','alibabacloud-endpoint-util',
    'alibabacloud-openapi-util','alibabacloud-gateway-spi','alibabacloud-tea','alibabacloud-tea-fileform',
    'alibabacloud-tea-xml','darabonba-core','cryptography','cffi','pycparser','requests','urllib3',
    'certifi','charset-normalizer','idna','websocket-client','aiofiles','aiohttp','aiohappyeyeballs',
    'aiosignal','attrs','frozenlist','multidict','propcache','yarl','APScheduler','tzlocal','tzdata']
def collect(destination):
    destination = Path(destination); destination.mkdir(parents=True, exist_ok=True)
    records=[]
    for name in PACKAGES:
        dist=importlib.metadata.distribution(name)
        records.append({'name':dist.metadata['Name'],'version':dist.version,'license':dist.metadata.get('License-Expression') or dist.metadata.get('License','See license files')})
        folder=destination/name; folder.mkdir(exist_ok=True)
        for file in dist.files or []:
            if any(part.lower() in {'licenses','license','copying'} or part.lower().startswith(('license.','copying.','notice')) for part in file.parts):
                source=Path(dist.locate_file(file))
                if source.is_file():
                    import shutil
                    shutil.copy2(source,folder/source.name)
    (destination/'dependencies.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    import sys, shutil
    python_license=Path(sys.base_prefix)/'LICENSE.txt'
    if python_license.exists(): shutil.copy2(python_license,destination/'Python-LICENSE.txt')
    pyinstaller=importlib.metadata.distribution('pyinstaller')
    for file in pyinstaller.files or []:
        if file.name.lower().startswith(('copying','license')):
            source=Path(pyinstaller.locate_file(file))
            if source.is_file(): shutil.copy2(source,destination/('PyInstaller-'+source.name))
    playwright=Path(importlib.metadata.distribution('playwright').locate_file('playwright'))/'driver'
    for source in playwright.rglob('*'):
        if source.is_file() and source.name.lower().startswith(('license','notice','thirdpartynotice')):
            target=destination/'playwright-driver'/source.relative_to(playwright);target.parent.mkdir(parents=True,exist_ok=True)
            import shutil
            shutil.copy2(source,target)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('destination');collect(parser.parse_args().destination)
