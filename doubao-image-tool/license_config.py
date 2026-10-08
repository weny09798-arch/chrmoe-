"""Fixed build configuration. No environment variables can enable licensing."""
from dataclasses import dataclass
import re
from urllib.parse import urlsplit


# Formal builds replace these two public values after deployment.
LICENSE_SERVER_URL = ''
LICENSE_PUBLIC_KEY = ''


@dataclass(frozen=True)
class LicenseBuildConfig:
    server_url: str = LICENSE_SERVER_URL
    public_key: str = LICENSE_PUBLIC_KEY
    # Constructor injection for isolated tests; never read from user settings/env.
    allow_loopback_http: bool = False

    @property
    def configured(self):
        try:
            origin = urlsplit(self.server_url)
            origin.port  # Reject invalid ports.
            secure = origin.scheme == 'https'
            loopback = (self.allow_loopback_http and origin.scheme == 'http'
                        and origin.hostname in {'127.0.0.1', 'localhost', '::1'})
            return bool((secure or loopback) and origin.hostname
                        and not origin.username and not origin.password
                        and origin.path in {'', '/'} and not origin.query
                        and not origin.fragment and not any(c.isspace() for c in self.server_url)
                        and re.fullmatch(r'[A-Za-z0-9_-]{43}', self.public_key))
        except (TypeError, ValueError):
            return False
