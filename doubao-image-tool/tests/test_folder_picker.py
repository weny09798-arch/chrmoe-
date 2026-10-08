import json
from pathlib import Path
from types import SimpleNamespace

def test_source_picker_subprocess_uses_argument_list_and_cancel(monkeypatch):
    import folder_picker
    calls=[]
    def execute(command, **kwargs):
        calls.append((command,kwargs))
        return SimpleNamespace(returncode=0,stdout='{"path":""}')
    monkeypatch.setattr(folder_picker.subprocess,'run',execute)
    assert folder_picker.choose_folder()==''
    command,kwargs=calls[0]
    assert command[-1]=='--choose-folder' and Path(command[-2]).name=='run.py'
    assert 'shell' not in kwargs
    if folder_picker.os.name=='nt': assert kwargs['creationflags']==folder_picker.subprocess.CREATE_NO_WINDOW

def test_frozen_picker_uses_same_executable(monkeypatch):
    import folder_picker
    monkeypatch.setattr(folder_picker.sys,'frozen',True,raising=False)
    def execute(command,**kwargs):
        assert command==[folder_picker.sys.executable,'--choose-folder']
        return SimpleNamespace(returncode=0,stdout='{"path":"D:\\\\输出"}')
    monkeypatch.setattr(folder_picker.subprocess,'run',execute)
    assert folder_picker.choose_folder()=='D:\\输出'

def test_choose_folder_mode_returns_json_before_instance_or_server(monkeypatch,capsys):
    import run,folder_picker
    monkeypatch.setattr(run.sys,'argv',['run.py','--choose-folder'])
    monkeypatch.setattr(folder_picker,'native_folder',lambda:'')
    monkeypatch.setattr(run,'InstanceLock',lambda *_: (_ for _ in ()).throw(AssertionError('must not lock')))
    assert run.main()==0
    assert json.loads(capsys.readouterr().out)=={'path':''}
