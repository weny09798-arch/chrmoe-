"""Ed25519 signs canonical JSON bytes; private material never enters responses."""
import base64
import json

from Crypto.PublicKey import ECC
from Crypto.Signature import eddsa


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


class Signer:
    def __init__(self, path):
        with open(path, 'rt', encoding='ascii') as source:
            key = ECC.import_key(source.read())
        if key.curve != 'Ed25519' or not key.has_private():
            raise ValueError('A private Ed25519 signing key is required')
        self._key = key

    @property
    def public_key(self):
        return b64url(self._key.public_key().export_key(format='raw'))

    def sign(self, payload):
        data = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        signature = eddsa.new(self._key, 'rfc8032').sign(data)
        return {'payload': b64url(data), 'signature': b64url(signature)}
