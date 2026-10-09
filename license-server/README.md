# Authorization server (deployment pending)

This is the standalone monthly licensing backend for version 1.7.0. It has no
production URL or credentials. Do not place this directory or private state in
customer packages. Protocol and client verification rules are in [PROTOCOL.md](PROTOCOL.md).

Owner deployment, backup/restore, lost credential/key procedures and the exact
remaining acceptance checklist are in [月度授权部署与验收](../docs/月度授权部署与验收.md).
Client licensing is independent of RAM, translation and OSS accounts. Local
evaluation uses ephemeral injected loopback configuration only; the frozen
evaluation executable stays unconfigured/locked. No production deployment or
two-physical-computer acceptance has been performed.

## Initialize private state

Use a separate virtual environment and install `requirements.txt`. From this
directory, run the following locally on the future server. Substitute an actual
HTTPS origin and an external private directory; example names are placeholders:

```sh
python -m licensing.cli /srv/monthly-license-private --origin https://licenses.example.com --container
```

The hidden prompt asks for a unique administrator password of at least 16
characters and confirmation; it never takes passwords as command arguments.
Initialization refuses existing directories and repository paths. It generates
an Ed25519 private key, random session secret, scrypt administrator password
hash and private JSON configuration. Only the public verification key is printed.
There are no fallback passwords or signing keys. Save this public key for the
fixed client build. Keep config, signing key and the data directory together in
an encrypted offline backup. The administrator hash can be replaced with a new
strong scrypt hash if necessary; changing the session secret logs out sessions.
Losing the signing key requires client trust-key update and invalidates existing
signed cached credentials. Losing the database loses binding/expiry history;
restore a consistent backup instead of recreating licenses with reset dates.

On POSIX, files/directories are initialized with private permissions (umask 077).
For Docker, set ownership of this external directory to UID/GID 10001 so the app
can read mounted config/key and write the data directory. On Windows, restrict
the external directory ACL to the service account and administrators; POSIX modes
are not a Windows ACL substitute. Never commit or email private state.

## Future Docker deployment

Point a real domain to the server, open ports 80/443, and set environment values:

```sh
export LICENSE_PRIVATE_DIR=/srv/monthly-license-private
export LICENSE_HOST=licenses.example.com
docker compose up -d --build
```

`--container` initialization writes paths matching the compose mounts.
`PUBLIC_ORIGIN` must exactly match `https://` plus `LICENSE_HOST`. Caddy obtains
and renews HTTPS certificates. Gunicorn runs two workers under an unprivileged
UID, with a read-only root filesystem and no published application port. Only
Caddy can reach the internal app network; it overwrites forwarding headers.
Never publish port 8000 or enable `TRUST_PROXY` on an app reachable directly by
untrusted clients. Access `/admin/login` through HTTPS. Container logs record
status only; there is no request-body or access-log logging configuration.

To run without Docker, omit `--container` at initialization, set
`LICENSE_CONFIG` to the external generated `config.json`, and run Gunicorn
behind an equivalent HTTPS reverse proxy. Change `TRUST_PROXY` to true only when
that proxy is the sole reachable caller and overwrites forwarding headers.
Production JSON accepts only PUBLIC_ORIGIN, SECRET_KEY, ADMIN_PASSWORD_HASH,
PRIVATE_KEY_PATH, DATABASE, TRUST_PROXY, ACTIVATION_LIMIT and LOGIN_LIMIT. Test,
debug and cookie-security switches cannot be loaded from production JSON.
Source-tree key/database/config paths and incomplete/weak configuration fail
startup. Production supports HTTPS only.

## Backup and local verification

Stop the app (or use SQLite's consistent backup API) before backing up the
database; copying a live database/journal independently can corrupt history.
Back up the external config/signing key/data, and Caddy data for certificate
continuity. Restore with original restrictive permissions and ownership, then
validate that existing expiry, disabled state and device binding are intact.
The private key must remain the same to preserve client verification trust.

```sh
python -m pip install -r requirements-test.txt
python -m pytest tests -q
```

Tests create ephemeral keys, password hashes, databases and clocks in isolated
temporary directories. They do not deploy, contact paid services, use production
credentials or touch delivery/profile directories. HTTP allowance exists only
through explicit `create_app({...TESTING: True, ALLOW_TEST_HTTP: True...})`
injection, never an environment/shipping bypass. The Linux Docker/HTTPS setup
still requires real domain deployment and operational acceptance.
