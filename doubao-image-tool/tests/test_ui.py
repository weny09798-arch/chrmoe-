import subprocess
from pathlib import Path

def test_preview_identity_blob_cleanup_and_exit_polling():
    tool=Path(__file__).resolve().parents[1]
    import playwright
    node=Path(playwright.__file__).resolve().parent/'driver/node.exe'
    result=subprocess.run([str(node),str(tool/'tests/ui_behavior.cjs'),str(tool/'web/app.js')],capture_output=True,text=True,encoding="utf-8")
    assert result.returncode==0,result.stderr
    assert 'UI behavior passed' in result.stdout
