"""Threadless Windows license authority. New work consumes only public statuses."""
import copy
from dataclasses import dataclass
import math
import re
import secrets
import threading
import time

from license_cache import DpapiLicenseStore
from license_config import LicenseBuildConfig
from license_hardware import windows_device_hash
from license_transport import HttpsLicenseTransport, LicenseTransportOutage
from license_trust import CredentialVerifier


_UNREAD = object()

DENIALS = frozenset({'unknown_code', 'disabled', 'expired', 'unbound', 'device_mismatch'})
MESSAGES = {
    'validation_in_progress': '正在验证授权，请稍候',
    'allowed': '授权有效', 'activation_required': '请输入授权码激活',
    'needs_validation': '需要联网验证授权', 'unconfigured': '授权服务尚未配置',
    'hardware_unavailable': '无法读取 Windows 设备标识',
    'storage_error': '授权数据不可用，请重新验证',
    'clock_rollback': '检测到系统时间异常，请联网验证',
    'invalid_response': '授权响应无效，请联网重新验证',
    'invalid_code': '请输入有效的授权码', 'transport_outage': '暂时无法连接授权服务',
    'unknown_code': '授权码不存在', 'disabled': '授权已停用',
    'expired': '授权已到期，请续费后手动恢复任务',
    'unbound': '授权已解绑，请重新激活', 'device_mismatch': '授权码已绑定其他电脑',
    'lease_expired': '离线授权已到期，请联网验证', 'closed': '授权服务已关闭',
}


@dataclass(frozen=True)
class LicenseStatus:
    allowed: bool
    state: str
    expires_at: int | None = None
    lease_until: int | None = None
    offline: bool = False
    message: str = ''
    remaining_days: int | None = None
    checked_at: int | None = None

    def to_dict(self):
        return {'allowed': self.allowed, 'status': self.state,
                'expires_at': self.expires_at, 'lease_until': self.lease_until,
                'offline': self.offline, 'message': self.message,
                'remaining_days': self.remaining_days, 'checked_at': self.checked_at}


class LicenseRequiredError(PermissionError):
    def __init__(self, status):
        self.status = status
        super().__init__('当前授权不可用，请检查授权状态并手动恢复任务')


class LicenseAuthority:
    """Versioned profile authority. Call startup before work; caller owns scheduler.

    The app and short-lived helpers synchronize via the store's compare_and_save.
    Network operations never hold its process lock.

    Injected clocks/storage/transport/hardware are for isolated testing. Production
    uses fixed build config, Windows identity, DPAPI and HTTPS by default.
    """
    def __init__(self, profile_root=None, *, config=None, store=None, transport=None,
                 hardware_provider=windows_device_hash, wall_clock=time.time,
                 monotonic_clock=time.monotonic):
        self._lock = threading.RLock()
        self._config = config if config is not None else LicenseBuildConfig()
        if store is None and profile_root is None:
            raise ValueError('授权存储需要应用配置目录')
        self._store = store if store is not None else DpapiLicenseStore(profile_root)
        self._transport = transport
        self._owns_transport = transport is None
        self._wall_clock, self._monotonic_clock = wall_clock, monotonic_clock
        self._record = None
        self._write_conflict = False
        self._code = None
        self._envelope = self._claims = None
        self._public_expiry = None
        self._checked_at = None
        self._state = 'activation_required'
        self._offline = False
        self._started = False
        self._closed = False
        self._last_attempt = None
        self._server_anchor = None
        self._wall_anchor = self._mono_anchor = 0.0
        self._wall_high = self._mono_high = 0.0
        self._configuration_error = None
        self._device = None
        self._verifier = None
        if not self._config.configured:
            self._configuration_error = self._state = 'unconfigured'
            return
        try:
            self._verifier = CredentialVerifier(self._config.public_key)
        except Exception:
            self._configuration_error = self._state = 'unconfigured'
            return
        try:
            self._device = hardware_provider()
            if not isinstance(self._device, str) or not re.fullmatch(r'[0-9a-f]{64}', self._device):
                raise ValueError()
        except Exception:
            self._configuration_error = self._state = 'hardware_unavailable'
            return
        self._load()

    @staticmethod
    def _number(value):
        return type(value) in (int, float) and math.isfinite(value) and value >= 0

    @staticmethod
    def _valid_code(code):
        return isinstance(code, str) and 20 <= len(code) <= 128 and not any(c.isspace() for c in code)

    def _clocks(self):
        wall, mono = self._wall_clock(), self._monotonic_clock()
        if not self._number(wall) or not self._number(mono):
            raise ValueError()
        return wall, mono

    def _load(self, record=_UNREAD):
        try:
            record = self._store.load() if record is _UNREAD else record
            self._record = copy.deepcopy(record)
            previous_code = self._code
            self._code = None
            self._envelope = self._claims = None
            self._offline = False
            if record is None:
                wall, mono = self._clocks()
                self._wall_anchor = self._wall_high = wall
                self._mono_anchor = self._mono_high = mono
                self._server_anchor = self._public_expiry = self._checked_at = None
                self._state = 'activation_required'
                self._last_attempt = None
                return True
            fields = {'version', 'code', 'credential', 'server_time',
                      'wall_high_water', 'monotonic_high_water'}
            if not isinstance(record, dict) or type(record.get('version')) is not int:
                raise ValueError()
            version = record['version']
            if version == 2:
                fields |= {'revision', 'state', 'last_attempt', 'offline'}
                if (not isinstance(record.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{32}', record['revision'])
                        or record.get('state') not in MESSAGES or type(record.get('offline')) is not bool
                        or (record.get('last_attempt') is not None and not self._number(record['last_attempt']))):
                    raise ValueError()
                if (record.get('credential') is not None) != (record['state'] == 'allowed'):
                    raise ValueError()
            if version not in (1, 2) or set(record) != fields:
                raise ValueError()
            if not self._valid_code(record['code']):
                raise ValueError()
            for name in ('wall_high_water', 'monotonic_high_water'):
                if not self._number(record[name]):
                    raise ValueError()
            if record['server_time'] is not None and not self._number(record['server_time']):
                raise ValueError()
            self._code = record['code']
            if previous_code != self._code:
                self._public_expiry = self._checked_at = None
            self._last_attempt = record.get('last_attempt')
            self._offline = record.get('offline', False)
            self._wall_anchor = self._wall_high = record['wall_high_water']
            self._mono_anchor = self._mono_high = record['monotonic_high_water']
            self._server_anchor = record['server_time']
            if record['credential'] is not None:
                self._claims = self._verifier.verify(record['credential'], self._device, self._server_anchor)
                self._envelope = record['credential']
                self._public_expiry = self._claims.expires_at
                self._checked_at = self._claims.issued_at
            saved_state = record.get('state', 'needs_validation')
            self._state = saved_state if self._started or self._envelope is None else 'needs_validation'
            return True
        except Exception:
            self._envelope = self._claims = None
            self._state = 'storage_error'
            return False

    def _sync(self):
        """Observe newer denial/replacement before any grant evaluation or write."""
        try:
            record = self._store.load()
        except Exception:
            self._drop('storage_error')
            return False
        if record != self._record:
            return self._load(record)
        return True

    def _public(self):
        allowed = self._state == 'allowed' and self._claims is not None
        remaining = None
        if self._public_expiry is not None and self._server_anchor is not None:
            try:
                wall, mono = self._clocks()
                now = self._server_anchor + max(0, wall - self._wall_anchor, mono - self._mono_anchor)
                remaining = max(0, math.ceil((self._public_expiry - now) / 86400))
            except Exception:
                pass
        message = '授权有效（离线租约）' if allowed and self._offline else MESSAGES[self._state]
        return LicenseStatus(allowed, self._state, self._public_expiry,
                             self._claims.lease_until if allowed else None,
                             self._offline if allowed else False,
                             message, remaining, self._checked_at)

    def _drop(self, state):
        self._envelope = self._claims = None
        self._offline = False
        self._state = state
        return self._public()

    def _persist(self, envelope, server_time, wall, mono, *, reset_clock=False, state=None, checkpoint=False, begin_request=False):
        wall_high = wall if reset_clock else max(self._wall_high, wall)
        mono_high = mono if reset_clock else max(self._mono_high, mono)
        try:
            revision = self._record.get('revision') if checkpoint and self._record else None
            record = {'version': 2, 'revision': revision or secrets.token_hex(16),
                      'state': state or ('allowed' if envelope is not None else self._state),
                      'last_attempt': self._last_attempt,
                      'offline': self._offline if envelope is not None else False,
                      'code': self._code, 'credential': envelope,
                      'server_time': server_time, 'wall_high_water': wall_high,
                      'monotonic_high_water': mono_high}
            expected = self._record
            for attempt in range(3):
                if self._store.compare_and_save(expected, record):
                    break
                latest = self._store.load()
                # Merge only competing elapsed-time checkpoints within the SAME
                # generation, including just before beginning a fresh online request.
                # Never retry a network response, denial, or offline restore over
                # another generation. Clock progress is monotonic in every field.
                identity = ('revision', 'code', 'credential', 'state', 'last_attempt', 'offline')
                if (not (checkpoint or begin_request) or not expected or not expected.get('revision')
                        or not isinstance(latest, dict)
                        or any(latest.get(key) != expected.get(key) for key in identity)):
                    self._write_conflict = True
                    self._load(latest)
                    if not checkpoint: self._drop('needs_validation')
                    return False
                for key in ('server_time', 'wall_high_water', 'monotonic_high_water'):
                    record[key] = max(record[key], latest[key])
                expected = latest
            else:
                self._write_conflict = True
                self._drop('needs_validation')
                return False
            self._record = copy.deepcopy(record)
            self._write_conflict = False
        except Exception:
            self._write_conflict = True
            self._drop('storage_error')
            return False
        self._wall_high, self._mono_high = record['wall_high_water'], record['monotonic_high_water']
        return True

    def _revoke(self, state, wall, mono):
        self._drop(state)
        if self._code:
            self._persist(None, self._server_anchor, wall, mono)
        return self._public()

    def _evaluate(self, *, reconcile=True, restore=False):
        """Check exact lease/expiry and persist elapsed time before exposing grant."""
        try:
            wall, mono = self._clocks()
        except Exception:
            return self._revoke('clock_rollback', self._wall_high, self._mono_high)
        if wall < self._wall_high or mono < self._mono_high:
            return self._revoke('clock_rollback', wall, mono)
        if self._envelope is None:
            return self._public()
        now = self._server_anchor + max(wall - self._wall_anchor, mono - self._mono_anchor)
        if now >= self._claims.expires_at:
            return self._revoke('expired', wall, mono)
        if now >= self._claims.lease_until:
            return self._revoke('lease_expired', wall, mono)
        try:
            claims = self._verifier.verify(self._envelope, self._device, now)
        except Exception:
            return self._revoke('invalid_response', wall, mono)
        if not self._persist(self._envelope, now, wall, mono, checkpoint=not restore):
            if self._claims is not None:
                if reconcile: return self._evaluate(reconcile=False)
                return self._drop('needs_validation')
            return self._public()
        self._claims = claims
        self._server_anchor = self._record['server_time']
        self._wall_anchor, self._mono_anchor = self._wall_high, self._mono_high
        self._state = 'allowed'
        return self._public()

    def startup(self):
        """Always attempt online validation for a saved code, including restarts."""
        with self._lock:
            self._started = True
            if not self._configuration_error and not self._sync(): return self._public()
            return self._refresh('validate')

    def activate(self, code):
        """Replace saved code and activate; no previous code's lease can be used."""
        with self._lock:
            self._started = True
            if self._closed:
                return self._drop('closed')
            if self._configuration_error:
                return self._drop(self._configuration_error)
            if not self._sync(): return self._public()
            self._drop('activation_required')
            if not self._valid_code(code):
                try:
                    wall, mono = self._clocks()
                    return self._revoke('invalid_code', wall, mono)
                except Exception:
                    return self._drop('invalid_code')
            self._code = code
            self._public_expiry = None
            self._checked_at = None
            return self._refresh('activate')

    def refresh(self):
        """Explicit online attempt; renewal permits work but never resumes a job."""
        with self._lock:
            self._started = True
            if not self._configuration_error and not self._sync(): return self._public()
            return self._refresh('validate')

    def _refresh(self, operation):
        if self._closed:
            return self._drop('closed')
        if self._configuration_error:
            return self._drop(self._configuration_error)
        if self._code is None:
            return self._public()
        self._write_conflict = False
        self._evaluate()
        if self._write_conflict: return self._public()
        try:
            wall, mono = self._clocks()
        except Exception:
            return self._drop('clock_rollback')
        fallback, fallback_claims = self._envelope, self._claims
        previous_state = self._state
        # Revoke on disk BEFORE contacting the server. A crash or a failed write
        # after explicit denial cannot bring the prior offline grant back.
        self._last_attempt = mono
        if not self._persist(None, self._server_anchor, wall, mono, state='validation_in_progress', begin_request=True):
            return self._public()
        self._drop('validation_in_progress')
        nonce = secrets.token_urlsafe(32)
        try:
            if self._transport is None:
                self._transport = HttpsLicenseTransport(self._config)
            response = self._transport.request(operation, self._code, self._device, nonce)
        except LicenseTransportOutage:
            if fallback is None:
                return self._revoke(previous_state if previous_state in {'clock_rollback', 'expired', 'lease_expired'} else 'transport_outage', wall, mono)
            self._envelope, self._claims = fallback, fallback_claims
            self._offline = True
            return self._evaluate(restore=True)
        except Exception:
            return self._revoke('invalid_response', wall, mono)
        try:
            body = response.document
            if not isinstance(body, dict):
                raise ValueError()
            server_time, expiry = body['server_time'], body['expires_at']
            if type(server_time) is not int or not 0 <= server_time <= 2**63 - 1:
                raise ValueError()
            if response.status_code == 403:
                if set(body) != {'status', 'server_time', 'expires_at'} or body['status'] not in DENIALS:
                    raise ValueError()
                if expiry is not None and (type(expiry) is not int or not 0 <= expiry <= 2**63 - 1):
                    raise ValueError()
                self._public_expiry = expiry
                return self._revoke(body['status'], wall, mono)
            if (response.status_code != 200 or set(body) != {'status', 'server_time', 'expires_at', 'credential'}
                    or body['status'] != 'allowed' or type(expiry) is not int):
                raise ValueError()
            claims = self._verifier.verify(body['credential'], self._device, server_time, nonce)
            if claims.issued_at != server_time or claims.expires_at != expiry:
                raise ValueError()
            end_wall, end_mono = self._clocks()
            # Charging the entire request time is conservative. Unsigned outer
            # server_time cannot shift the anchor away from signed issued_at.
            if end_wall < wall or end_mono < mono:
                return self._revoke('clock_rollback', end_wall, end_mono)
            now = server_time + max(end_wall - wall, end_mono - mono)
            self._verifier.verify(body['credential'], self._device, now, nonce)
            if not self._persist(body['credential'], now, end_wall, end_mono, reset_clock=True):
                return self._public()
            self._envelope, self._claims = body['credential'], claims
            self._server_anchor = now
            self._wall_anchor, self._mono_anchor = end_wall, end_mono
            self._public_expiry = claims.expires_at
            self._checked_at = claims.issued_at
            self._state, self._offline = 'allowed', False
            return self._public()
        except Exception:
            return self._revoke('invalid_response', wall, mono)

    def status(self):
        """Public status; once started, refresh at 300s since the last attempt."""
        with self._lock:
            if self._closed:
                return self._drop('closed')
            if not self._started or self._configuration_error:
                return self._public()
            if not self._sync(): return self._public()
            result = self._evaluate()
            try:
                _, mono = self._clocks()
            except Exception:
                return self._drop('clock_rollback')
            if self._code and (self._last_attempt is None or mono - self._last_attempt >= 300):
                return self._refresh('validate')
            return result

    def require_new_work(self, *, force_refresh=True):
        """New task starts force refresh; per-card/image guards may pass False."""
        with self._lock:
            result = self.refresh() if force_refresh else self.status()
            if not result.allowed:
                raise LicenseRequiredError(result)
            return result

    def close(self):
        """No threads are owned. Close only a transport constructed internally."""
        with self._lock:
            self._closed = True
            self._drop('closed')
            if self._owns_transport and self._transport is not None:
                self._transport.close()
