import subprocess, sys, urllib.request, json, re
from urllib.error import HTTPError
from pathlib import Path
from html.parser import HTMLParser

def test_launcher_help_and_local_startup(tmp_path):
    run = Path(__file__).resolve().parents[1] / 'run.py'
    help_result = subprocess.run([sys.executable, str(run), '--help'], capture_output=True, text=True)
    assert help_result.returncode == 0
    process = subprocess.Popen([sys.executable, '-u', str(run), '--no-open', '--state-dir', str(tmp_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = process.stdout.readline().strip()
        base = re.search(r'http://127\.0\.0\.1:\d+/',line).group(0)
        assert '#token=' not in line
        class Code(HTMLParser):
            code=None
            def handle_starttag(self,tag,attrs):
                values=dict(attrs)
                if values.get('id')=='connection-code':self.code=values['value']
        with urllib.request.urlopen(base) as r: html=r.read().decode('utf-8')
        parser=Code();parser.feed(html)
        fragment=parser.code.split('#token=')[1]
        req = urllib.request.Request(base + 'api/state', headers={'X-Tool-Token':fragment})
        with urllib.request.urlopen(req) as r: assert json.load(r)['status'] == 'idle'
        try: urllib.request.urlopen(base+'api/images/missing/0/original?token='+fragment).close()
        except HTTPError as exc: assert exc.code==404
        req = urllib.request.Request(base + 'api/exit', data=b'{}', headers={'X-Tool-Token':fragment,'Content-Type':'application/json'})
        urllib.request.urlopen(req).close()
        assert process.wait(timeout=10) == 0
        assert fragment not in process.stderr.read(), 'Preview query credentials must never appear in server logs'
    finally:
        if process.poll() is None: process.terminate(); process.wait(timeout=10)

def test_second_instance_rejected_without_new_profile(tmp_path):
    from run import InstanceLock
    first=InstanceLock(tmp_path); second=InstanceLock(tmp_path)
    first.acquire()
    try:
        import pytest
        with pytest.raises(OSError): second.acquire()
    finally: second.close(); first.close()
