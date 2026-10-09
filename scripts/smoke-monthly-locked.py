"""Smoke a frozen LOCKED evaluation with a fresh profile below worktree artifacts.

No browser or conversion service is opened. Never uses the real default profile.
"""
import argparse
import html
import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import requests


def smoke(package):
    package=Path(package).resolve()
    artifacts=Path(__file__).resolve().parents[1]/'artifacts'
    artifacts=artifacts.resolve()
    if artifacts not in package.parents or not (package/'EVALUATION-LOCKED.txt').is_file():
        raise ValueError('Only an isolated locked evaluation package under this worktree artifacts is allowed')
    info=json.loads((package/'BUILD-INFO.json').read_text(encoding='utf-8'))
    assert info['mode']=='evaluation-locked' and not info['server_url'] and not info['public_key']
    profile=Path(tempfile.mkdtemp(prefix='monthly-smoke-profile-',dir=artifacts))
    executable=package/'DoubaoImageTool'/'DoubaoImageTool.exe'
    process=subprocess.Popen([str(executable),'--no-open','--state-dir',str(profile)],
                             stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    lines=queue.Queue()
    def collect():
        for line in iter(process.stdout.readline,b''):lines.put(line.decode('utf-8',errors='replace'))
    threading.Thread(target=collect,daemon=True).start()
    session=requests.Session();session.trust_env=False
    try:
        origin=None;deadline=time.monotonic()+45
        while time.monotonic()<deadline and origin is None:
            if process.poll() is not None:raise RuntimeError('Frozen process exited before serving the UI')
            try:line=lines.get(timeout=.2)
            except queue.Empty:continue
            match=re.search(r'http://127\.0\.0\.1:\d+',line)
            if match:origin=match.group(0)
        assert origin,'Frozen UI startup timed out'
        page=session.get(origin,timeout=5);page.raise_for_status()
        assert '30 天软件授权' in page.text
        token=re.search(r'id="connection-code"[^>]+value="([^"]+)"',page.text)
        assert token
        headers={'X-Tool-Token':html.unescape(token.group(1)).split('#token=',1)[1]}
        status=session.get(origin+'/api/license/status',headers=headers,timeout=5).json()
        assert status['allowed'] is False and status['status']=='unconfigured'
        assert session.get(origin+'/api/license/status',timeout=5).status_code==403
        extension='a'*32
        bridge_headers={**headers,'X-Extension-Id':extension,'Origin':'chrome-extension://'+extension}
        session.post(origin+'/api/bridge/pair',headers=bridge_headers,json={'extension_id':extension},timeout=5).raise_for_status()
        capabilities=session.get(origin+'/api/bridge/capabilities',headers=bridge_headers,timeout=5).json()
        assert capabilities['version']=='1.7.0' and capabilities['licensing'] is True
        denied=session.post(origin+'/api/jobs',headers=headers,
                            data={'output_dir':str(profile/'out')},timeout=5)
        assert denied.status_code==423 and denied.json()['license']['allowed'] is False
        assert not (profile/'chrome-profile').exists()
        assert not (profile/'out').exists()
        session.post(origin+'/api/exit',headers=headers,json={},timeout=5).raise_for_status()
        process.wait(timeout=15)
        assert process.returncode==0
        result={'passed':True,'checks':['frozen imports','license UI served','unconfigured locked','1.7.0 paired bridge',
                'token guard','new work denied','no browser/profile opened','clean isolated shutdown'],
                'package':str(package),'isolated_profile':str(profile)}
        (artifacts/'monthly-licensing-frozen-smoke-task5.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=True))
    finally:
        session.close()
        if process.poll() is None:process.terminate();process.wait(timeout=10)
        process.stdout.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--package',required=True)
    smoke(parser.parse_args().package)
