import subprocess, sys, urllib.request, json
from pathlib import Path

def test_launcher_help_and_local_startup(tmp_path):
    run = Path(__file__).resolve().parents[1] / 'run.py'
    help_result = subprocess.run([sys.executable, str(run), '--help'], capture_output=True, text=True)
    assert help_result.returncode == 0
    process = subprocess.Popen([sys.executable, '-u', str(run), '--no-open', '--state-dir', str(tmp_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = process.stdout.readline().strip()
        assert line.startswith('http://127.0.0.1:')
        base, fragment = line.split('#token=')
        req = urllib.request.Request(base + 'api/state', headers={'X-Tool-Token':fragment})
        with urllib.request.urlopen(req) as r: assert json.load(r)['status'] == 'idle'
        req = urllib.request.Request(base + 'api/exit', data=b'{}', headers={'X-Tool-Token':fragment,'Content-Type':'application/json'})
        urllib.request.urlopen(req).close()
        assert process.wait(timeout=10) == 0
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
