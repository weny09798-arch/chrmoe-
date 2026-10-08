# Monthly license protocol v1

This server is a separate deployment component, never part of the customer package.
There is no deployed server/domain in this repository. All examples describe future
deployment or isolated tests. Production clients contain only the fixed HTTPS origin
and the Ed25519 public key. Unconfigured clients must deny new work.

## Requests and responses

`POST /v1/activate` and `POST /v1/validate` require HTTPS, JSON content type,
and exactly these string fields:

```json
{"code":"high-entropy-code-shown-once-by-admin","device_hash":"64-lowercase-hex-characters","nonce":"fresh-random-base64url-at-least-16-characters"}
```

Codes have 20–128 characters (generated codes are 43 unpadded base64url
characters from 32 cryptographically random bytes). Do not trim or transform
the stored code on the server; client UI may trim surrounding whitespace before
submission. The device hash is exactly 64 lowercase hexadecimal characters,
derived by the client from Windows MachineGuid and system volume identity.
No server hardware fallback exists. Nonce accepts only ASCII letters, digits,
`_` and `-`, length 16–128. Generate a fresh nonce for each online request;
32 random bytes encoded base64url is recommended. Maximum request size is 8192 bytes.
Credentials and codes belong in POST bodies only, never URLs or logs.

Successful responses are HTTP 200:

```json
{
  "status": "allowed",
  "server_time": 1800000000,
  "expires_at": 1802592000,
  "credential": {"payload": "base64url-canonical-json", "signature": "base64url-ed25519-signature"}
}
```

All timestamps are integer UTC Unix seconds. `expires_at` is exclusive:
permission ends when `now >= expires_at`. First activation starts precisely
2,592,000 seconds (30 days). Validation never starts or binds an unused license.
Activating an already-bound license does not extend its expiry. Transactions use
SQLite `BEGIN IMMEDIATE`, so concurrent first activation has a single winner.

An allowed payload has exactly the following keys (ordering below illustrates
the canonical JSON used by signatures):

```json
{"device_hash":"64-lowercase-hex-characters","expires_at":1802592000,"issued_at":1800000000,"lease_until":1800086400,"license_id":"32-hex-character-id","nonce":"request-nonce","version":1}
```

Signing bytes are UTF-8 `json.dumps(payload, sort_keys=True, separators=(',', ':'),
ensure_ascii=False)`. The envelope `payload` encodes these original bytes using
URL-safe base64 without `=` padding. `signature` is the unpadded base64url
encoding of the 64-byte RFC 8032 Ed25519 signature over those bytes. Public keys
export as unpadded base64url of the raw 32 bytes; PEM/private keys are server-only.
Decode and verify the original bytes; do not trust an unsigned parsed payload.

Clients require version 1, expected hardware digest, requested nonce for live
responses, valid Ed25519 signature, finite integer timestamps, `issued_at <= now`,
`now < expires_at`, and `now < lease_until <= min(issued_at + 86400, expires_at)`.
Nonce matching is for live responses; a persisted verified response retains its
original nonce and is rechecked for device/lease/expiry during offline use.
The client also detects wall-clock rollback/high-water violations and requires
online revalidation. Never extend offline permission by editing local time.

## Denials and failures

Explicit denials are HTTP 403 and have `status`, `server_time` and `expires_at`
(null for an unknown/unactivated code), with **no credential**:

| Status | Meaning |
| --- | --- |
| `unknown_code` | Code digest is absent |
| `disabled` | Administrator disabled this license |
| `expired` | Server time is at or beyond expiry |
| `unbound` | Validation found no bound device; activation is required |
| `device_mismatch` | Another device owns the binding |

Checks prioritize unknown code, disabled, expired, unbound/bind, device mismatch.
Unbind clears only device identity; it keeps expiry. An expired unbound code
cannot receive a new month by activation. Administrator renewal adds precisely
2,592,000 seconds from `max(now, existing_expiry)` and never auto-resumes work.
Renewal before first activation is rejected with a clear administrator message;
an unused code never starts counting down until activation. Owner codes have the same rules.

Malformed JSON/fields return HTTP 400 `bad_request`. HTTPS/host rejection or
oversized bodies can return standard HTML HTTP 400/413; clients must fail closed
on any malformed or untrusted response. A shared SQLite per-client-IP limit
combines activation and validation: default 60 attempts per 60 seconds.
HTTP 429 returns `rate_limited`, `server_time`, `expires_at: null`, and
`Retry-After: 60`. Administrator login defaults to 5 attempts per 900 seconds;
both successful and unsuccessful login attempts consume the limit. Identity
values are SHA256 digests in rate-limit storage. Limits survive worker changes.

Explicit denial invalidates cached permission immediately. Invalid signature,
nonce, malformed response, protocol rejection, HTTP 400/403/429 or HTTP 5xx
must not silently turn into offline success. Only a genuine transport outage
may use a previously verified signed lease, never beyond lease/expiry and never
after a known denial. Existing results remain viewable/exportable independently.
Already submitted image results may finish retrieval/persistence/upload before
pausing; new collection/generation must stop. Online checks happen at startup,
before new work, and every five minutes. A renewed code requires manual resume.

## Administration

`GET /admin/login` supplies a session-bound CSRF token. Login POST requires
`csrf_token` and `password`. Success rotates the session and token. All mutation
routes require authentication and a constant-time checked CSRF token; POST
Origin, when supplied, must match configured HTTPS origin. Cookies are Secure,
HttpOnly, SameSite=Strict, with an absolute 30-minute session lifetime.

`GET /admin/` lists ID, SHA256 code digest, note, device digest, expiry, state.
`POST /admin/create` accepts `note`; its no-store response displays the raw
code exactly once. The raw code never enters SQLite, cookie session, flash or
logging. Reloading the list cannot recover it; re-submitting the POST creates
a separate new code. Save the displayed code securely before leaving the page.
`POST /admin/<license_id>/<action>` accepts `note`, `renew`, `disable`, `enable`,
or `unbind`; note changes take a `note` form field (max 2000 characters).
`POST /admin/logout` invalidates the session. Every POST requires `csrf_token`.
All responses prohibit caching; admin HTML escapes notes and has a restrictive
CSP, frame denial and no-referrer policy. No CORS access is provided.
