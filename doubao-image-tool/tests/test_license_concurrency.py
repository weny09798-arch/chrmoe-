"""Cross-authority cache coordination regressions; all signatures/services are isolated."""
import copy
import threading
from types import SimpleNamespace
import pytest

from license_authority import LicenseAuthority, LicenseRequiredError
from license_config import LicenseBuildConfig
from license_transport import LicenseResponse, LicenseTransportOutage
from test_license_components import signer, envelope
from test_licensing import Clock, Store

OLD_CODE = 'old-test-license-0123456789'
NEW_CODE = 'replacement-test-license-0123456789'


class SignedService:
    def __init__(self, private, clock):
        self.private, self.clock = private, clock
        self.result = 'allowed'
        self.before_reply = None
        self.calls = []

    def request(self, operation, code, device_hash, nonce):
        self.calls.append((operation, code))
        now = 1800000000 + int(self.clock.mono - 5000)
        if self.result == 'outage':
            response = LicenseTransportOutage('isolated outage')
        elif self.result == 'allowed':
            response = LicenseResponse(200, {'status':'allowed', 'server_time':now,
                'expires_at':1802592000, 'credential':envelope(self.private, nonce=nonce,
                    issued_at=now, expires_at=1802592000, lease_until=now+86400)})
        else:
            response = LicenseResponse(403, {'status':self.result, 'server_time':now,
                'expires_at':1802592000})
        if self.before_reply:
            callback, self.before_reply = self.before_reply, None
            callback()
        if isinstance(response, Exception):raise response
        return response


@pytest.fixture(params=['memory', 'dpapi'])
def shared(request, tmp_path, signer):
    from license_cache import DpapiLicenseStore
    clock=Clock(); memory=Store()
    def store():
        return memory if request.param=='memory' else DpapiLicenseStore(tmp_path/'profile')
    def create(service=None):
        service = service or SignedService(signer[0],clock)
        return LicenseAuthority(config=LicenseBuildConfig('https://license.example',signer[1]),
            store=store(),transport=service,hardware_provider=lambda:'a'*64,
            wall_clock=lambda:clock.wall,monotonic_clock=lambda:clock.mono)
    return SimpleNamespace(clock=clock,store=store,create=create,
        service=lambda:SignedService(signer[0],clock))


@pytest.mark.parametrize('denial', ['disabled', 'unbound', 'device_mismatch'])
def test_helper_denial_invalidates_parent_and_cannot_return_as_offline_grant(shared, denial):
    parent_service=shared.service(); parent=shared.create(parent_service)
    assert parent.activate(OLD_CODE).allowed
    helper_service=shared.service();helper_service.result=denial
    helper=shared.create(helper_service)
    assert not helper.startup().allowed
    assert not parent.status().allowed, 'Parent must reconcile the durable denial before checkpointing'
    assert shared.store().load()['credential'] is None
    parent_service.result='outage'
    with pytest.raises(LicenseRequiredError):parent.require_new_work(force_refresh=True)
    fresh=shared.create(parent_service)
    assert not fresh.startup().allowed
    assert shared.store().load()['credential'] is None


@pytest.mark.parametrize('old_reply', ['allowed', 'outage', 'disabled'])
def test_stale_helper_response_cannot_overwrite_replacement_activation(shared, old_reply):
    parent=shared.create();assert parent.activate(OLD_CODE).allowed
    service=shared.service();service.result=old_reply
    helper=shared.create(service)
    replacement=[]
    def replace():
        assert parent.activate(NEW_CODE).allowed
        replacement.append(copy.deepcopy(shared.store().load()))
    service.before_reply=replace
    assert not helper.startup().allowed, 'A superseded request must not authorize its old-code operation'
    current=shared.store().load()
    assert current['code']==NEW_CODE and current['credential']==replacement[0]['credential']
    assert parent.status().allowed
    assert shared.store().load()['code']==NEW_CODE


def test_pending_validation_denies_new_work_without_reviving_older_checkpoint(shared):
    parent=shared.create();assert parent.activate(OLD_CODE).allowed
    service=shared.service();helper=shared.create(service)
    observed=[]
    def pending():
        status=parent.status()
        observed.append(status)
        assert not status.allowed
        assert shared.store().load()['credential'] is None
    service.before_reply=pending
    assert helper.startup().allowed
    assert observed[0].state=='validation_in_progress'
    assert parent.status().allowed


def test_queue_observes_helper_denial_and_manual_offline_resume_never_pays(shared, tmp_path, monkeypatch):
    import core
    from core import QueueService
    from test_aliyun import image, never_browser
    from test_core import wait
    parent_service=shared.service();parent=shared.create(parent_service)
    assert parent.activate(OLD_CODE).allowed
    paid=[]
    class Helper:
        def translate(self,path):
            service=shared.service();service.result='disabled'
            helper=shared.create(service)
            helper.startup();helper.require_new_work(force_refresh=False)
            paid.append(path)
            raise AssertionError('revoked work reached paid call')
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=Helper,license_authority=parent)
    try:
        q.start([('a.png',image())],tmp_path/'out','convert',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status']=='paused')
        assert not s['license']['allowed'] and s['paid_calls']==0
        assert s['items'][0]['phase']=='aliyun-ready'
        assert shared.store().load()['credential'] is None
        parent_service.result='outage'
        with pytest.raises(LicenseRequiredError):q.action('continue')
        assert not paid and q.snapshot()['paid_calls']==0
    finally:q.close()


def test_queue_transient_helper_validation_does_not_latch_but_guard_is_denied(shared, tmp_path, monkeypatch):
    import core
    from core import QueueService
    from test_aliyun import image, never_browser
    from test_core import wait
    parent=shared.create();assert parent.activate(OLD_CODE).allowed
    paid=[];observed=[]
    class Helper:
        def translate(self,path):
            service=shared.service()
            def pending():
                observed.append(q.license_status())
                with pytest.raises(LicenseRequiredError):parent.require_new_work(force_refresh=False)
            service.before_reply=pending
            helper=shared.create(service)
            assert helper.startup().allowed
            helper.require_new_work(force_refresh=False)
            paid.append(path)
            return {'request_id':'isolated','final_image_url':'https://example.test/result.png'}
    monkeypatch.setattr(core,'download_aliyun_result',lambda url:(image(),'.png'))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=Helper,license_authority=parent)
    try:
        q.start([('a.png',image()),('b.png',image())],tmp_path/'out','convert',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status'] in {'completed','paused'})
        assert s['status']=='completed' and len(paid)==2, (s['message'], s['license'], [(i['phase'], i['message']) for i in s['items']], len(paid))
        assert all(not status.allowed and status.state=='validation_in_progress' for status in observed)
    finally:q.close()


def test_legacy_positive_record_still_requires_startup_and_migrates(shared):
    parent=shared.create();assert parent.activate(OLD_CODE).allowed
    record=shared.store().load()
    legacy={key:record[key] for key in ('code','credential','server_time','wall_high_water','monotonic_high_water')}
    legacy['version']=1
    shared.store().save(legacy)
    restarted=shared.create()
    assert not restarted.status().allowed
    assert restarted.startup().allowed
    assert shared.store().load()['version']==2


def test_cross_process_cache_cas_has_one_winner(tmp_path):
    import json
    import subprocess
    import sys
    import time
    from pathlib import Path
    from license_cache import DpapiLicenseStore
    root=tmp_path/'profile';store=DpapiLicenseStore(root)
    store.save({'version':1,'value':'initial'})
    script=tmp_path/'writer.py'
    module_root=Path(__file__).resolve().parents[1]
    script.write_text("import sys,time,json\nfrom pathlib import Path\nsys.path.insert(0,"+repr(str(module_root))+ ")\nfrom license_cache import DpapiLicenseStore\ns=DpapiLicenseStore(sys.argv[1]); old=s.load()\nPath(sys.argv[2]).write_text('ready')\nwhile not Path(sys.argv[3]).exists(): time.sleep(.01)\nprint(json.dumps(s.compare_and_save(old,{'version':1,'value':sys.argv[4]})),flush=True)\n",encoding='utf-8')
    gate=tmp_path/'go';processes=[]
    try:
        for n in range(2):
            processes.append(subprocess.Popen([sys.executable,str(script),str(root),str(tmp_path/f'ready-{n}'),str(gate),str(n)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True))
        end=time.monotonic()+5
        while not all((tmp_path/f'ready-{n}').exists() for n in range(2)):
            assert time.monotonic()<end
            time.sleep(.01)
        gate.write_text('go')
        results=[p.communicate(timeout=5) for p in processes]
        assert all(p.returncode==0 for p in processes),results
        assert sorted(json.loads(out) for out,err in results)==[False,True]
        assert store.load()['value'] in {'0','1'}
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()


def test_same_grant_checkpoint_race_merges_progress_without_false_revocation(shared, monkeypatch):
    parent=shared.create();assert parent.activate(OLD_CODE).allowed
    other=shared.create();assert other.startup().allowed
    parent.status()
    shared.clock.advance(5)
    store=parent._store
    original=store.compare_and_save
    raced=[]
    def interleave(expected, record):
        if not raced:
            raced.append(True)
            assert other.status().allowed
        return original(expected,record)
    monkeypatch.setattr(store,'compare_and_save',interleave)
    assert parent.status().allowed
    assert shared.store().load()['server_time']==1800000005


def test_shared_offline_grant_preserves_public_offline_status(shared):
    parent=shared.create();assert parent.activate(OLD_CODE).allowed
    service=shared.service();service.result='outage'
    helper=shared.create(service)
    assert helper.startup().offline
    status=parent.status()
    assert status.allowed and status.offline


def test_contended_cache_lock_fails_within_helper_overhead_budget(tmp_path):
    import subprocess
    import sys
    import time
    from pathlib import Path
    from license_cache import DpapiLicenseStore, LicenseStorageError
    root=tmp_path/'profile';store=DpapiLicenseStore(root)
    store.save({'value':'original'})
    ready=tmp_path/'ready';gate=tmp_path/'go';script=tmp_path/'locker.py'
    module_root=Path(__file__).resolve().parents[1]
    script.write_text("import sys,time\nfrom pathlib import Path\nsys.path.insert(0,"+repr(str(module_root))+")\nfrom license_cache import DpapiLicenseStore\ns=DpapiLicenseStore(sys.argv[1])\nwith s._exclusive():\n Path(sys.argv[2]).write_text('ready')\n while not Path(sys.argv[3]).exists(): time.sleep(.01)\n",encoding='utf-8')
    process=subprocess.Popen([sys.executable,str(script),str(root),str(ready),str(gate)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        end=time.monotonic()+5
        while not ready.exists():
            assert time.monotonic()<end
            time.sleep(.01)
        started=time.monotonic()
        with pytest.raises(LicenseStorageError):store.compare_and_save({'value':'original'},{'value':'bad'})
        assert time.monotonic()-started<1, 'Local coordination must fit the existing paid-helper overhead budget'
        started=time.monotonic()
        with pytest.raises(LicenseStorageError):store.load()
        assert time.monotonic()-started<1
    finally:
        gate.write_text('go')
        process.communicate(timeout=5)
        assert process.returncode==0
    assert store.load()=={'value':'original'}


def overlap_real_reader(store, operation, monkeypatch):
    """Hold an actual Windows non-delete-sharing read handle from another store.

    Release inside the .25s lock budget; a pre-fix replace actually fails while
    this handle is open. No replace/DPAPI result is mocked.
    """
    from concurrent.futures import ThreadPoolExecutor
    from pathlib import Path
    from license_cache import DpapiLicenseStore
    opened=threading.Event();release=threading.Event();finished=threading.Event()
    original=Path.read_bytes
    def read(path):
        if path==store.path and threading.current_thread().name.startswith('held-license-reader'):
            with path.open('rb') as handle:
                opened.set()
                assert release.wait(5)
                return handle.read()
        return original(path)
    monkeypatch.setattr(Path,'read_bytes',read)
    reader=DpapiLicenseStore(store.path.parent)
    with ThreadPoolExecutor(1,thread_name_prefix='held-license-reader') as reads, ThreadPoolExecutor(1) as writes:
        reading=reads.submit(reader.load);assert opened.wait(5)
        def write():
            try:return operation()
            finally:finished.set()
        writing=writes.submit(write)
        try:
            # Event wait is the reader's bounded hold, not a race against release.
            finished.wait(.1)
        finally:release.set()
        assert reading.result(timeout=5) is not None
        return writing.result(timeout=5)


def test_independent_dpapi_read_handle_does_not_break_atomic_cas(tmp_path, monkeypatch):
    from license_cache import DpapiLicenseStore
    store=DpapiLicenseStore(tmp_path/'profile');old={'value':'old'};store.save(old)
    assert overlap_real_reader(store,lambda:store.compare_and_save(old,{'value':'new'}),monkeypatch)
    assert store.load()=={'value':'new'}


def test_dpapi_authority_checkpoint_under_read_overlap_stays_allowed(tmp_path, signer, monkeypatch):
    from license_cache import DpapiLicenseStore
    clock=Clock();store=DpapiLicenseStore(tmp_path/'profile')
    authority=LicenseAuthority(config=LicenseBuildConfig('https://license.example',signer[1]),store=store,
        transport=SignedService(signer[0],clock),hardware_provider=lambda:'a'*64,
        wall_clock=lambda:clock.wall,monotonic_clock=lambda:clock.mono)
    assert authority.activate(OLD_CODE).allowed
    status=overlap_real_reader(store,authority.status,monkeypatch)
    assert status.allowed and status.state=='allowed'
    assert authority.status().allowed and store.load()['state']=='allowed'


def test_queue_parent_helper_read_overlap_does_not_latch_storage_denial(tmp_path, signer, monkeypatch):
    import core
    from core import QueueService
    from license_cache import DpapiLicenseStore
    from test_aliyun import image, never_browser
    from test_core import wait
    clock=Clock();store=DpapiLicenseStore(tmp_path/'profile')
    def authority(storage):
        return LicenseAuthority(config=LicenseBuildConfig('https://license.example',signer[1]),store=storage,
            transport=SignedService(signer[0],clock),hardware_provider=lambda:'a'*64,
            wall_clock=lambda:clock.wall,monotonic_clock=lambda:clock.mono)
    parent=authority(store);assert parent.activate(OLD_CODE).allowed
    paid=[];observed=[]
    class Helper:
        def translate(self,path):
            # Independent helper has reconciled and validated the same protected record.
            helper=authority(DpapiLicenseStore(store.path.parent));assert helper.startup().allowed
            observed.append(overlap_real_reader(store,q.license_status,monkeypatch))
            helper.require_new_work(force_refresh=False)
            paid.append(path)
            return {'request_id':'isolated','final_image_url':'https://example.test/result.png'}
    monkeypatch.setattr(core,'download_aliyun_result',lambda url:(image(),'.png'))
    q=QueueService(never_browser,tmp_path/'state',aliyun_factory=Helper,license_authority=parent)
    try:
        q.start([('a.png',image()),('b.png',image())],tmp_path/'out','convert',provider='aliyun',paid_confirmed=True)
        s=wait(q,lambda s:s['status'] in {'completed','paused'})
        assert s['status']=='completed' and len(paid)==2, (s['message'],[(i['phase'],i['message']) for i in s['items']])
        assert len(observed)==2 and all(status.allowed for status in observed)
        assert parent.status().allowed and store.load()['state']=='allowed'
    finally:q.close()


def test_process_dpapi_reader_coordinates_with_writer(tmp_path):
    import subprocess
    import sys
    import time
    from pathlib import Path
    from concurrent.futures import ThreadPoolExecutor
    from license_cache import DpapiLicenseStore
    store=DpapiLicenseStore(tmp_path/'profile');old={'value':'old'};store.save(old)
    ready=tmp_path/'reader-ready';release=tmp_path/'reader-release';script=tmp_path/'reader.py'
    module_root=Path(__file__).resolve().parents[1]
    script.write_text("import sys,time\nfrom pathlib import Path\nsys.path.insert(0,"+repr(str(module_root))+")\nfrom license_cache import DpapiLicenseStore\ns=DpapiLicenseStore(sys.argv[1]); original=Path.read_bytes\ndef held(path):\n if path==s.path:\n  with path.open('rb') as handle:\n   Path(sys.argv[2]).write_text('ready')\n   while not Path(sys.argv[3]).exists(): time.sleep(.005)\n   return handle.read()\n return original(path)\nPath.read_bytes=held\nassert s.load()=={'value':'old'}\n",encoding='utf-8')
    p=subprocess.Popen([sys.executable,'-B',str(script),str(store.path.parent),str(ready),str(release)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        end=time.monotonic()+5
        while not ready.exists():
            assert time.monotonic()<end
            time.sleep(.005)
        finished=threading.Event()
        def write():
            try:return store.compare_and_save(old,{'value':'new'})
            finally:finished.set()
        with ThreadPoolExecutor(1) as pool:
            future=pool.submit(write)
            try:finished.wait(.1)
            finally:release.write_text('go')
            assert future.result(timeout=5)
        out,err=p.communicate(timeout=5);assert p.returncode==0,(out,err)
        assert store.load()=={'value':'new'}
    finally:
        release.write_text('go')
        if p.poll() is None:p.kill();p.wait()
