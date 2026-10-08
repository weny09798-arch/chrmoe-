"""Application factory. Production settings are provided by an external secret file."""
import json
import os
import re
import time
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from .database import LicenseStore
from .signer import Signer

SOURCE_DIRECTORY = Path(__file__).resolve().parents[1]
REPOSITORY = next((parent for parent in SOURCE_DIRECTORY.parents if (parent / '.git').exists()), SOURCE_DIRECTORY)


def outside_repository(path):
    resolved = Path(path).resolve()
    if resolved == REPOSITORY or REPOSITORY in resolved.parents:
        raise ValueError('Private state must be outside the source repository')
    return resolved


def create_app(config=None):
    app = Flask(__name__)
    app.config.update(CLOCK=time.time, ACTIVATION_LIMIT=60, LOGIN_LIMIT=5,
                      MAX_CONTENT_LENGTH=8192, SESSION_COOKIE_SECURE=True,
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Strict',
                      PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
                      SESSION_REFRESH_EACH_REQUEST=False, TRUST_PROXY=False,
                      ALLOW_TEST_HTTP=False)
    if config is None:
        source = os.environ.get('LICENSE_CONFIG')
        if not source:
            raise ValueError('LICENSE_CONFIG must identify an external private JSON configuration')
        with outside_repository(source).open(encoding='utf-8') as stream:
            config = json.load(stream)
        allowed = {'PUBLIC_ORIGIN', 'SECRET_KEY', 'ADMIN_PASSWORD_HASH', 'PRIVATE_KEY_PATH',
                   'DATABASE', 'TRUST_PROXY', 'ACTIVATION_LIMIT', 'LOGIN_LIMIT'}
        if not isinstance(config, dict) or set(config) - allowed:
            raise ValueError('Production configuration cannot override application security or test settings')
    app.config.update(config)
    if not re.fullmatch(r'[0-9a-fA-F]{64,}', str(app.config.get('SECRET_KEY', ''))):
        raise ValueError('SECRET_KEY must contain at least 32 random bytes encoded as hex')
    if len(set(bytes.fromhex(app.config['SECRET_KEY']))) < 8:
        raise ValueError('SECRET_KEY cannot be repeated or low-entropy bytes; initialize it with the CLI')
    password_hash = app.config.get('ADMIN_PASSWORD_HASH', '')
    if not re.fullmatch(r'scrypt:32768:8:1\$[A-Za-z0-9]{16,}\$[0-9a-f]{128}', password_hash):
        raise ValueError('Administrator password requires an initialized strong scrypt hash')
    origin = urlsplit(app.config.get('PUBLIC_ORIGIN', ''))
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise ValueError('PUBLIC_ORIGIN must be an HTTPS origin without credentials/path')
    if app.config['ALLOW_TEST_HTTP'] and not app.config.get('TESTING'):
        raise ValueError('HTTP is only available in explicitly injected test configurations')
    for setting in ('ACTIVATION_LIMIT', 'LOGIN_LIMIT'):
        if not isinstance(app.config[setting], int) or not 1 <= app.config[setting] <= 1000:
            raise ValueError('Rate limits must be integers between 1 and 1000')
    key_path = outside_repository(app.config['PRIVATE_KEY_PATH'])
    database_path = outside_repository(app.config['DATABASE'])
    database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    app.extensions['signer'] = Signer(key_path)
    app.extensions['licenses'] = LicenseStore(str(database_path), app.config['CLOCK'])
    if app.config['TRUST_PROXY']:
        # Only enable behind the private Caddy -> Gunicorn network in compose.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
    from .routes import routes
    app.register_blueprint(routes)
    return app
