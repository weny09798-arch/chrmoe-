"""Offline administrator initialization. Prompts hide password from process arguments."""
import argparse
import getpass
import json
import os
import secrets
from urllib.parse import urlsplit

from Crypto.PublicKey import ECC
from werkzeug.security import generate_password_hash

from . import outside_repository
from .signer import b64url


def initialize(directory, origin, password, container=False):
    directory = outside_repository(directory)
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('An HTTPS origin without path is required')
    if len(password) < 16 or len(password) > 1024 or len(set(password)) < 8:
        raise ValueError('Use a unique administrator password of 16-1024 characters with at least 8 distinct characters')
    if directory.exists():
        raise FileExistsError('Initialization refuses an existing directory to protect its keys and configuration')
    key = ECC.generate(curve='Ed25519')
    config = dict(PUBLIC_ORIGIN=origin, SECRET_KEY=secrets.token_hex(32),
                  ADMIN_PASSWORD_HASH=generate_password_hash(password, method='scrypt:32768:8:1'),
                  PRIVATE_KEY_PATH='/run/license/signing.pem' if container else str(directory / 'signing.pem'),
                  DATABASE='/var/lib/license/licenses.sqlite3' if container else str(directory / 'data' / 'licenses.sqlite3'),
                  TRUST_PROXY=container)
    # POSIX permissions are restrictive from creation; Windows deployers must set ACLs.
    previous = os.umask(0o077)
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        (directory / 'data').mkdir(mode=0o700)
        with (directory / 'signing.pem').open('x', encoding='ascii') as destination:
            destination.write(key.export_key(format='PEM'))
        with (directory / 'config.json').open('x', encoding='utf-8') as destination:
            json.dump(config, destination, indent=2)
    finally:
        os.umask(previous)
    return b64url(key.public_key().export_key(format='raw'))


def main():
    parser = argparse.ArgumentParser(description='Initialize external authorization-server state, never overwriting existing state')
    parser.add_argument('directory', help='New private directory outside the repository')
    parser.add_argument('--origin', required=True, help='Deployed HTTPS origin, e.g. https://licenses.example.com')
    parser.add_argument('--container', action='store_true', help='Write container paths matching compose.yaml')
    args = parser.parse_args()
    password = getpass.getpass('New administrator password (16+ characters): ')
    if password != getpass.getpass('Confirm administrator password: '):
        parser.error('Passwords did not match')
    try:
        public_key = initialize(args.directory, args.origin, password, container=args.container)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    print('Initialized external private state. Back it up securely.')
    print('Client Ed25519 public key (base64url raw32): ' + public_key)


if __name__ == '__main__':
    main()
