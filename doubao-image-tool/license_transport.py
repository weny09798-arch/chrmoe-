"""Bounded HTTPS JSON transport. Only connection outages permit offline use."""
from dataclasses import dataclass
import http.client
import json
import ssl

import requests


class LicenseTransportOutage(ConnectionError):
    pass


class LicenseResponseError(ValueError):
    pass


@dataclass(frozen=True)
class LicenseResponse:
    status_code: int
    document: dict


def _untrusted_connection_error(error):
    """Requests can wrap malformed HTTP/TLS as a generic ConnectionError."""
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, ssl.SSLError):
            return True
        if isinstance(current, http.client.BadStatusLine) and not isinstance(current, http.client.RemoteDisconnected):
            return True
        pending.extend(arg for arg in current.args if isinstance(arg, BaseException))
        for name in ('__cause__', '__context__', 'reason'):
            child = getattr(current, name, None)
            if isinstance(child, BaseException):
                pending.append(child)
    return False


class HttpsLicenseTransport:
    def __init__(self, config, *, session=None):
        if not config.configured:
            raise LicenseResponseError('授权服务未配置')
        self._origin = config.server_url.rstrip('/')
        self._session = session or requests.Session()
        self._session.trust_env = False

    def request(self, operation, code, device_hash, nonce):
        if operation not in {'activate', 'validate'}:
            raise LicenseResponseError('授权请求无效')
        response = None
        try:
            response = self._session.post(
                f'{self._origin}/v1/{operation}',
                json={'code': code, 'device_hash': device_hash, 'nonce': nonce},
                timeout=(5, 15), allow_redirects=False, stream=True)
            if response.status_code not in (200, 403):
                raise LicenseResponseError('授权服务拒绝请求')
            raw = bytearray()
            for chunk in response.iter_content(chunk_size=8192):
                raw.extend(chunk)
                if len(raw) > 65536:
                    raise LicenseResponseError('授权响应无效')
            document = json.loads(raw)
            if not isinstance(document, dict):
                raise LicenseResponseError('授权响应无效')
            return LicenseResponse(response.status_code, document)
        except requests.exceptions.SSLError:
            raise LicenseResponseError('授权服务证书验证失败') from None
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as error:
            if _untrusted_connection_error(error) or (response is not None and response.status_code == 403):
                raise LicenseResponseError('授权服务拒绝请求') from None
            raise LicenseTransportOutage('暂时无法连接授权服务') from None
        except LicenseResponseError:
            raise
        except Exception:
            raise LicenseResponseError('授权响应无效') from None
        finally:
            if response is not None:
                response.close()

    def close(self):
        self._session.close()
