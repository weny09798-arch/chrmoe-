"""SQLite owns binding and limits across processes, never stores plaintext codes."""
import hashlib
import secrets
import sqlite3
from contextlib import contextmanager

MONTH = 30 * 24 * 60 * 60


class LicenseStore:
    def __init__(self, path, clock):
        self.path = path
        self.clock = clock
        with self.transaction() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS licenses (
                    id TEXT PRIMARY KEY, code_digest TEXT UNIQUE NOT NULL,
                    note TEXT NOT NULL, device_hash TEXT, expires_at INTEGER,
                    disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rate_limits (
                    bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL,
                    attempts INTEGER NOT NULL
                );
            ''')

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def create(self, note):
        code = secrets.token_urlsafe(32)
        license_id = secrets.token_hex(16)
        with self.transaction() as db:
            db.execute('INSERT INTO licenses (id, code_digest, note, created_at) VALUES (?, ?, ?, ?)',
                       (license_id, hashlib.sha256(code.encode()).hexdigest(), note[:2000], int(self.clock())))
        return license_id, code

    def list(self):
        with self.transaction() as db:
            return [dict(row) for row in db.execute('SELECT * FROM licenses ORDER BY created_at DESC, id')]

    def admin_action(self, license_id, action, note=''):
        with self.transaction() as db:
            now = int(self.clock())
            row = db.execute('SELECT * FROM licenses WHERE id = ?', (license_id,)).fetchone()
            if row is None:
                raise KeyError('License not found')
            if action == 'renew':
                if row['expires_at'] is None:
                    raise ValueError('Activate this license before renewing it.')
                db.execute('UPDATE licenses SET expires_at = ? WHERE id = ?',
                           (max(now, row['expires_at']) + MONTH, license_id))
            elif action in ('disable', 'enable'):
                db.execute('UPDATE licenses SET disabled = ? WHERE id = ?', (int(action == 'disable'), license_id))
            elif action == 'unbind':
                db.execute('UPDATE licenses SET device_hash = NULL WHERE id = ?', (license_id,))
            elif action == 'note':
                db.execute('UPDATE licenses SET note = ? WHERE id = ?', (note[:2000], license_id))
            else:
                raise ValueError('Unknown administrator action')

    def check(self, code, device_hash, activate):
        """Return status, row and a decision timestamp sampled under the write lock."""
        digest = hashlib.sha256(code.encode()).hexdigest()
        with self.transaction() as db:
            now = int(self.clock())
            row = db.execute('SELECT * FROM licenses WHERE code_digest = ?', (digest,)).fetchone()
            if row is None:
                return 'unknown_code', None, now
            row = dict(row)
            if row['disabled']:
                return 'disabled', row, now
            if row['expires_at'] is not None and now >= row['expires_at']:
                return 'expired', row, now
            if not row['device_hash']:
                if not activate:
                    return 'unbound', row, now
                row['device_hash'] = device_hash
                if row['expires_at'] is None:
                    row['expires_at'] = now + MONTH
                db.execute('UPDATE licenses SET device_hash = ?, expires_at = ? WHERE id = ?',
                           (device_hash, row['expires_at'], row['id']))
            if row['device_hash'] != device_hash:
                return 'device_mismatch', row, now
            return 'allowed', row, now

    def consume_limit(self, category, identity, limit, seconds):
        bucket = category + ':' + hashlib.sha256(identity.encode()).hexdigest()
        with self.transaction() as db:
            now = int(self.clock())
            # Bound stored identities to the longest active rate window (15 minutes).
            db.execute('DELETE FROM rate_limits WHERE window_start <= ?', (now - 900,))
            row = db.execute('SELECT * FROM rate_limits WHERE bucket = ?', (bucket,)).fetchone()
            if row is None or now >= row['window_start'] + seconds:
                db.execute('INSERT OR REPLACE INTO rate_limits VALUES (?, ?, 1)', (bucket, now))
                return True
            if row['attempts'] >= limit:
                return False
            db.execute('UPDATE rate_limits SET attempts = attempts + 1 WHERE bucket = ?', (bucket,))
            return True
