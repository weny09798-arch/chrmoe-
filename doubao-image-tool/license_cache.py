"""Atomic user-bound DPAPI license storage, outside disposable task state."""
import json
import os
from pathlib import Path
import tempfile
import threading

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
                if not self.path.exists():
                    return None
                if self.path.stat().st_size > 65536:
                    raise ValueError()
                value = json.loads(self._protect(self.path.read_bytes(), True))
                if not isinstance(value, dict):
                    raise ValueError()
                return value
            except Exception:
                raise LicenseStorageError('授权数据不可读取，请重新验证') from None

    def save(self, record):
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
