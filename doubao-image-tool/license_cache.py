"""Atomic user-bound DPAPI license storage, outside disposable task state."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from credentials import _crypt


class LicenseStorageError(ValueError):
    pass


class DpapiLicenseStore:
    def __init__(self, profile_root, *, protector=_crypt):
        self.path = Path(profile_root).resolve() / 'license.dpapi'
        if any(part.casefold() == 'state' for part in self.path.parent.parts):
            raise LicenseStorageError('授权数据必须保存在任务缓存目录之外')
        self._protect = protector
        self._lock = threading.RLock()

    def load(self):
        with self._lock:
            try:
                with self._exclusive():
                    return self._read_locked()
            except Exception:
                raise LicenseStorageError('授权数据不可读取，请重新验证') from None

    def _read_locked(self):
        """Caller holds the OS lock, including CAS's comparison read."""
        if not self.path.exists():
            return None
        if self.path.stat().st_size > 65536:
            raise ValueError()
        value = json.loads(self._protect(self.path.read_bytes(), True))
        if not isinstance(value, dict):
            raise ValueError()
        return value

    @contextmanager
    def _exclusive(self):
        """Bounded OS lock shared by helper and app; never held over network I/O."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.parent / '.license.lock'
        with lock_path.open('a+b') as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b'0'); handle.flush()
            # Keep contention within the existing helper process overhead budget.
            deadline = time.monotonic() + .25
            while True:
                try:
                    handle.seek(0)
                    if os.name == 'nt':
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise LicenseStorageError('授权数据忙，请重新验证') from None
                    time.sleep(.01)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle, fcntl.LOCK_UN)

    def compare_and_save(self, expected, record):
        """Only the reader of the current revision may replace its record."""
        with self._lock:
            try:
                with self._exclusive():
                    if self._read_locked() != expected:
                        return False
                    self._write(record)
                    return True
            except Exception:
                raise LicenseStorageError('授权数据保存失败，请重新验证') from None

    def save(self, record):
        # Administrative/test storage primitive. Authorities always use CAS.
        with self._lock:
            try:
                with self._exclusive():
                    self._write(record)
            except Exception:
                raise LicenseStorageError('授权数据保存失败，请重新验证') from None

    def _write(self, record):
        pending = None
        with self._lock:
            try:
                raw = json.dumps(record, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
                protected = self._protect(raw)
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.license-', suffix='.tmp', delete=False) as output:
                    pending = Path(output.name)
                    output.write(protected)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(pending, self.path)
            except Exception:
                raise LicenseStorageError('授权数据保存失败，请重新验证') from None
            finally:
                if pending is not None:
                    try:
                        pending.unlink(missing_ok=True)
                    except OSError:
                        # Any leftover temporary file contains DPAPI ciphertext.
                        # Cleanup must not replace the safe storage error above.
                        pass
