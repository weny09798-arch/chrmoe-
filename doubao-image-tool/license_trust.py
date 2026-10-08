"""Protocol v1 canonical Ed25519 envelope verification, without private keys."""
import base64
from dataclasses import dataclass
import json
import math
import re

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


class LicenseTrustError(ValueError):
    pass


def decode_base64url(value, length=None):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError()
    raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    if base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
        raise ValueError()
    if length is not None and len(raw) != length:
        raise ValueError()
    return raw


@dataclass(frozen=True)
class VerifiedCredential:
    license_id: str
    device_hash: str
    issued_at: int
    expires_at: int
    lease_until: int
    nonce: str


class CredentialVerifier:
    def __init__(self, public_key):
        try:
            self._key = Ed25519PublicKey.from_public_bytes(decode_base64url(public_key, 32))
        except Exception:
            raise LicenseTrustError('授权验证配置无效') from None

    def verify(self, envelope, device_hash, now, nonce=None):
        try:
            if not isinstance(envelope, dict) or set(envelope) != {'payload', 'signature'}:
                raise ValueError()
            if not isinstance(envelope['payload'], str) or len(envelope['payload']) > 8192:
                raise ValueError()
            raw = decode_base64url(envelope['payload'])
            self._key.verify(decode_base64url(envelope['signature'], 64), raw)
            value = json.loads(raw)
            fields = {'version', 'license_id', 'device_hash', 'issued_at',
                      'expires_at', 'lease_until', 'nonce'}
            if not isinstance(value, dict) or set(value) != fields:
                raise ValueError()
            canonical = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
            if raw != canonical or type(value['version']) is not int or value['version'] != 1:
                raise ValueError()
            if not isinstance(value['license_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', value['license_id']):
                raise ValueError()
            if not isinstance(value['device_hash'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['device_hash']):
                raise ValueError()
            if value['device_hash'] != device_hash:
                raise ValueError()
            if not isinstance(value['nonce'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', value['nonce']):
                raise ValueError()
            if nonce is not None and value['nonce'] != nonce:
                raise ValueError()
            for name in ('issued_at', 'expires_at', 'lease_until'):
                if type(value[name]) is not int or not 0 <= value[name] <= 2**63 - 1:
                    raise ValueError()
            if type(now) not in (int, float) or not math.isfinite(now):
                raise ValueError()
            if not (value['issued_at'] <= now < value['expires_at']
                    and now < value['lease_until'] <= min(value['issued_at'] + 86400, value['expires_at'])):
                raise ValueError()
            return VerifiedCredential(**{name: value[name] for name in fields - {'version'}})
        except Exception:
            raise LicenseTrustError('授权响应无效，请联网重新验证') from None
