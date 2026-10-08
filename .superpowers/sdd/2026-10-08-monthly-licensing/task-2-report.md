# Task 2 report — Windows license authority

Status: DONE. Only focused client authorization modules/tests and this report were added. No app/core/UI wiring, delivery directory/ZIP, existing user profile/state, real license credentials, production server or paid/network calls were used.

## Implementation

- `license_config.py`: fixed `LICENSE_SERVER_URL` and `LICENSE_PUBLIC_KEY` build constants, both empty in this development source. `LicenseBuildConfig` denies unconfigured/invalid origin/key; no environment or user-setting licensing bypass. Only explicit constructor injection permits loopback HTTP for isolated tests. Production origin is HTTPS, without credentials/path/query/fragment.
- `license_hardware.py`: canonical SHA256 digest of Windows 64-bit-registry MachineGuid plus the Windows system-volume serial, framed as `monthly-license:v1\n{canonical-guid}\n{8-digit-lowercase-hex-serial}`. Registry and kernel calls fail closed; empty/invalid identifiers have no random or host-name fallback. Raw identifiers never enter public status.
- `license_trust.py`: RFC8032 Ed25519 verification with the existing installed `cryptography` dependency. Public key is raw32 unpadded base64url; signature is raw64. Verify original signed bytes before parsing, then require exact canonical compact/sorted UTF-8 JSON and exact protocol-v1 fields/types. Check device, live request nonce, issued time, exclusive expiry, exclusive lease and maximum signed 86,400-second lease. Cached envelopes retain and verify their original nonce without comparing it against a new request nonce.
- `license_transport.py`: fixed-origin POST JSON requests only, bounded response size, TLS certificate verification, no redirects, no environment proxies/CA overrides (`Session.trust_env=False`), connect/read timeouts 5/15 seconds. HTTP errors, malformed JSON/HTTP, TLS failures and protocol failures are untrusted. Only actual connection/timeout outages can be offline eligible. A received HTTP403 stays a denial even if reading its body subsequently times out. Requests' wrapped malformed HTTP status lines/TLS errors are not classified as outages.
- `license_cache.py`: `<profile_root>/license.dpapi`, outside any `state/` ancestor. Reuses the existing Windows user-bound `credentials._crypt` DPAPI primitive without changing unrelated credentials code. JSON code/cache/watermarks are encrypted before writing; temporary encrypted file, flush/fsync and atomic replacement. Load/save errors are redacted and fail closed; failed cleanup cannot expose the underlying filesystem exception. Normal task clearing does not affect this file.
- `license_authority.py`: threadless, serialized state machine, saved-code startup verification, activation, manual refresh and guards. The name deliberately differs from the independent server's `licensing` package so both suites/imports can coexist. Successful live validation anchors time to signed `issued_at`, matching the outer server time; incorrect local calendar time does not prevent valid live authorization. Local wall/monotonic elapsed time advances that anchor, using the larger elapsed value. DPAPI checkpoints persist trusted server progress and wall/monotonic high-water values; wall or monotonic rollback/reset/nonfinite clocks revoke cached permission until a successful online check. Each authorization read checks exact expiry/lease and checkpoints progress, including across normal process restart.
- Before contacting the service, persist the same code with `credential: null`. Only a genuine outage may restore the in-memory prior verified grant after rechecking its remaining signed lease and successfully persisting it. This ordering prevents an explicit denial, malformed response, process crash or post-response storage failure from leaving an older grant available on restart. Failed activation of a replacement code cannot borrow the previous code's lease. Denials keep the code for renewal but remove the positive credential. Online renewal changes authorization status only and never starts any work.
- Automatic refresh is based on the last **attempt**, including outages, at 300 seconds. Frequent status polling cannot flood the server during an outage. Explicit startup/refresh/new-task checks still attempt immediately. No background threads are introduced by the authority.

## Exact Task 3 interfaces

```python
from license_authority import LicenseAuthority, LicenseRequiredError, LicenseStatus
from license_config import LicenseBuildConfig

LicenseAuthority(
    profile_root=None, *,
    config=None, store=None, transport=None,
    hardware_provider=windows_device_hash,
    wall_clock=time.time, monotonic_clock=time.monotonic,
)
```

Production supplies the application's **profile root**, not its disposable `state` directory. A profile root is required unless a store is explicitly injected. Default config is the fixed empty/locked development build config; default hardware, store and transport are Windows identity, DPAPI and HTTPS. Never load URL/key/test flags from UI input, local settings or environment. Injected stores expose `load() -> dict | None` and `save(record)`. Injected transports expose `request(operation, code, device_hash, nonce) -> LicenseResponse(status_code, document)` and only raise `LicenseTransportOutage` for a genuine outage. Injection is for isolated tests, not a shipping bypass.

All methods below are synchronous and protected by the authority's reentrant lock:

| Method | Result and use |
| --- | --- |
| `startup()` | `LicenseStatus`; invoke once before allowing work. Always validates a saved code online, with valid cached fallback only for genuine outage. No saved code needs activation. |
| `activate(code)` | `LicenseStatus`; accepts the UI-trimmed code, replaces prior code/permission, uses `/v1/activate`. No automatic task start/resume. |
| `refresh()` | `LicenseStatus`; explicit `/v1/validate`, even within the 300-second interval. Useful for manual revalidation after renewal. |
| `status()` | `LicenseStatus`; always readable when denied. Before startup, a saved credential returns denied `needs_validation`. After startup, checks exact lease/expiry and automatically validates when 300 seconds since last attempt. |
| `require_new_work(*, force_refresh=True)` | Allowed `LicenseStatus`, otherwise raises `LicenseRequiredError` with its safe `.status` object. New collection/generation start and manual resume must pass `True`; actual per-product/per-image guards should pass `False`. |
| `close()` | Marks authority closed and denies future work; closes only an internally-created HTTP session. Injected transport lifecycle belongs to its injector. No thread exists to join. |

`LicenseStatus` is immutable, with attributes `allowed`, `state`, `expires_at`, `lease_until`, `offline`, `message`, `remaining_days`, `checked_at`. `status.to_dict()` is the complete public JSON boundary:

```json
{
  "allowed": true,
  "status": "allowed",
  "expires_at": 1802592000,
  "lease_until": 1800086400,
  "offline": false,
  "message": "授权有效",
  "remaining_days": 30,
  "checked_at": 1800000000
}
```

`expires_at`/`lease_until`/`checked_at` are integer Unix seconds or null. `lease_until` is null when denied. `remaining_days` is `ceil(max(0, expiry - trusted_server_now) / 86400)`, or null before there is a trusted signed time anchor; it uses signed server time plus elapsed time, not the local calendar. `checked_at` means **most recent successful online validation's signed `issued_at`**, retained during outage/denial and reconstructed from a persisted positive credential; it is null if no successful verification is known. No code, hardware digest, license ID, nonce, credential/envelope or exception details are exposed.

Public state values: `allowed`, `activation_required`, `needs_validation`, `unconfigured`, `hardware_unavailable`, `storage_error`, `clock_rollback`, `invalid_response`, `invalid_code`, `transport_outage`, `unknown_code`, `disabled`, `expired`, `unbound`, `device_mismatch`, `lease_expired`, `closed`. Each has a safe Chinese message; offline allowed status adds the offline-lease message.

Task 3 owns the background scheduler and lifecycle: share one authority across app/core, call `startup()` before serving work, tick `status()` regularly in the background (e.g. existing one-second status cadence) so its 300-second **attempt** gate triggers even when no user polls the UI. Do not have a one-second scheduler call explicit `refresh()`; that method intentionally forces a request. On application shutdown, stop/join the app-owned scheduler before `authority.close()`. Calls can wait for the HTTPS timeouts, so schedule them outside the UI thread. Denied checks pause new collection/submission, while submitted-image retrieval/upload/persistence and all result viewing/export remain unguarded. An allowed renewal status must not automatically resume an already paused job.

Persisted file: only `profile_root/license.dpapi` (and transient sibling `.license-*.tmp` encrypted files during atomic save). The encrypted JSON schema is `version:1`, `code`, `credential`, `server_time`, `wall_high_water`, `monotonic_high_water`. Never clear this during ordinary task/cache clearing.

## TDD evidence

All commands below use `D:\Desktop\chrome插件\artifacts\doubao-rule-venv\Scripts\python.exe`, from `C:\Users\yang2\.codex\worktrees\collector-image-conversion\chrome插件`.

1. Component RED: `python -m pytest doubao-image-tool/tests/test_license_components.py -q` — **25 failed in 0.40s**, expected missing hardware/config/trust/cache/transport modules. GREEN after implementation: same command — **25 passed in 0.21s**.
2. Authority RED: `python -m pytest doubao-image-tool/tests/test_licensing.py -q --tb=short` — **27 failed in 0.53s**, explicit `AssertionError: LicenseAuthority module is not implemented` before implementation (after removing an initial fixture-level missing-import error). GREEN: same command — **27 passed in 0.20s**. Module later renamed to `license_authority.py` to avoid server namespace collision.
3. Nonfinite-clock persistence RED: `python -m pytest doubao-image-tool/tests/test_licensing.py -q -k 'nonfinite or unreadable_clock or monotonic_reset or close' --tb=short` — **2 failed, 5 passed, 24 deselected in 0.28s**. A clock failure could leave an old encrypted grant for the next process. Fixed loading/checkpoint ordering and durable clock revocation. GREEN: **7 passed, 24 deselected in 0.17s**.
4. HTTP403/body-timeout RED: `python -m pytest doubao-image-tool/tests/test_license_components.py -q -k timeout_after_http_denial --tb=short` — **1 failed, 25 deselected in 0.24s**, expected `LicenseResponseError` but got offline-eligible `LicenseTransportOutage`. Fixed denial classification. GREEN: **1 passed, 25 deselected in 0.14s**.
5. DPAPI atomic-replace/cleanup RED: `python -m pytest doubao-image-tool/tests/test_license_components.py -q -k failed_atomic_replace --tb=short` — **1 failed, 26 deselected in 0.58s**, raw cleanup OSError masked redacted storage failure. Fixed cleanup isolation. GREEN: **1 passed, 26 deselected in 0.16s**.
6. Malformed HTTP status RED: `python -m pytest doubao-image-tool/tests/test_license_components.py -q -k malformed_http_status --tb=short` — **1 failed, 27 deselected in 0.25s**, malformed HTTP wrapped by Requests as ConnectionError was incorrectly offline-eligible. Added wrapped-error classification. Covered by subsequent full focused GREEN below.
7. Public trusted-time fields RED: `python -m pytest doubao-image-tool/tests/test_licensing.py -q -k 'public_status or remaining_days' --tb=short` — **2 failed, 30 deselected in 0.28s**, missing `message`, `remaining_days`, `checked_at`. Added safe public fields and trusted-time calculations. Focused GREEN: `python -m pytest doubao-image-tool/tests/test_license_components.py doubao-image-tool/tests/test_licensing.py doubao-image-tool/tests/test_license_protocol.py -q --tb=short` — **61 passed in 0.79s**, pristine output.

The tests exercise signed claim tamper/signature/version/type/device/nonce errors, exact expiry and 24-hour boundaries, signed server-clock skew, frozen wall time, wall/monotonic rollback, normal process restart and monotonic reset, explicit denial persistence, replacement-code activation failure, 300-second last-attempt limiting, storage failures, redaction, unconfigured defaults and environment-bypass rejection. They also verify a real server-generated envelope (PyCryptodome) with the client's independent cryptography verifier, plus DPAPI restart/disable/renew lifecycle.

## Verification and self-review

- Preliminary full client regression: `python -m pytest doubao-image-tool/tests -q` — **407 passed in 17.55s** before the final boundary/public-field additions.
- Preliminary combined regression: `python -m pytest doubao-image-tool/tests license-server/tests -q` — **447 passed in 30.83s**, then **448 passed in 31.43s** after storage-cleanup hardening, before final malformed-HTTP/public-field additions.
- Final combined regression: `python -m pytest doubao-image-tool/tests license-server/tests -q` — **450 passed in 30.63s**, exit0, no warnings/errors (412 client tests including 61 focused authorization tests; 38 server tests).
- `python -m py_compile doubao-image-tool/license_authority.py doubao-image-tool/license_cache.py doubao-image-tool/license_config.py doubao-image-tool/license_hardware.py doubao-image-tool/license_transport.py doubao-image-tool/license_trust.py` — exit0, no output.
- `git diff --check` — exit0; only Git's configured LF→CRLF notices, no whitespace errors.
- Self-review addressed durable nonfinite-clock revocation, known HTTP denial during body timeout, malformed HTTP wrapped as connection error, and temporary-file cleanup exception redaction. Scope remains the focused authority; no unrelated implementation changed.

## What was and was not exercised

- Source-isolated cryptographic/state tests use generated temporary Ed25519 keys, fake clocks, injected hardware readers and fake transport/storage; no actual server/domain/request/payment is used.
- **Actual Windows DPAPI was exercised**, using the existing native primitive on pytest temporary files: encrypted code roundtrip, plaintext absence, corruption rejection, task-state clearing independence, and real-server protocol restart lifecycle.
- **Actual MachineGuid/system-volume reads and physical two-computer behavior were not exercised.** Hardware tests inject readers to avoid depending on or exposing this computer's identifiers. Formal live hardware binding, deployed TLS/domain and real two-computer acceptance remain deferred until deployment as required.
- No existing profile/state or usable 1.6.4 delivery was opened for write. No production private material was generated in the repository or included in client modules.

No blocking concerns. There is deliberately no deployed configuration, so this source build denies new work until a formal HTTPS/public-key build configuration is provided. Task 3 must implement pause/resume placement and its own scheduler using the interfaces above.
