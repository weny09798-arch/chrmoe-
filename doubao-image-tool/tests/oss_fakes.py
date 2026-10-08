"""Offline publisher for tests that exercise the integrated collector bridge."""
import hashlib
from pathlib import Path


class FakePublisher:
    target_id = 'offline-test-bucket'

    def publish(self, path):
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        key = 'converted-images/' + digest + '.png'
        return {'url': 'https://collector-test.oss-cn-hangzhou.aliyuncs.com/' + key,
                'object_key': key, 'sha256': digest}
