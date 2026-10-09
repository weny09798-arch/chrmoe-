# Task 3 report — Local application and queue authorization

Status: DONE. Native app, paired bridge, queue submission boundaries, paid helper, and standalone UI are integrated. No extension code, deployment/build configuration, existing delivery directory/ZIP, or current user profile/state was changed. No real license-server, Doubao generation, Aliyun paid request, or OSS upload was performed.

## Implementation and exact interfaces for Task 4

Public endpoints (all return JSON; license code is only accepted in POST JSON, never a query parameter):

| Local UI | Paired bridge | Method / body | Response |
| --- | --- | --- | --- |
| `/api/license/status` | `/api/bridge/license/status` | GET | Public `LicenseStatus.to_dict()` |
| `/api/license/activate` | `/api/bridge/license/activate` | POST `{"code":"..."}` | Public status after activation; does not resume |
| `/api/license/refresh` | `/api/bridge/license/refresh` | POST `{}` | Public status after forced online validation; does not resume |

- `/api/bridge/capabilities` now includes `licensing: true`; existing fields and version remain unchanged for Task 5 packaging/version work.
- All queue snapshots (`/api/state`, `/api/bridge/state`, start/action/reset responses) now include `license`, with exactly the authority's public fields: `allowed`, `status`, `expires_at`, `lease_until`, `offline`, `message`, `remaining_days`, `checked_at`. Dates are Unix seconds or null. No license code, hardware digest, license ID, or signed envelope is exposed.
- Denied activation/status/refresh returns HTTP 200 with `allowed:false` and the safe status reason. A guarded start/new-generation action rejected by `LicenseRequiredError` returns **HTTP 423**, JSON `{"error":"safe generic explanation", "license": <public status>}`. This lets the paired extension read and display the denial through CORS. Existing authentication/pairing failures remain 403, bad inputs 400, and unrelated queue conflicts 409.
- Bridge endpoints use existing token, paired extension ID, allowed loopback Host, exact extension-Origin checks and CORS headers. OPTIONS recognizes GET for license status and POST for activate/refresh. They are inaccessible before pairing. Local endpoints retain local-token and same-origin protections.
- For extension collection start, call paired POST `/api/bridge/license/refresh` and require `allowed === true`. For frequent collection guards, GET `/api/bridge/license/status` enforces exact expiry and lets the authority throttle its 300-second automatic check. Native generation start and manual new-work resume also force validation, so bypassing extension/UI buttons cannot submit.

Constructors and queue methods:

```python
create_app(..., license_authority=None)
QueueService(browser_factory, state_dir, aliyun_factory=None,
             oss_factory=None, license_authority=None)
queue.license                 # shared LicenseAuthority
queue.license_status()        # status plus denial observation/latch
queue.activate_license(code) # activation plus denial observation; no resume
queue.refresh_license()      # forced refresh plus denial observation; no resume
queue.close(clear_state=False, *, close_license=True)
```

Default construction creates the real `LicenseAuthority(state_dir.parent)`. The app's existing `state_dir` argument is its profile root; the queue receives `root / 'state'`, so `license.dpapi` is beside credentials and outside disposable state. `app.extensions['license_authority']` references the same authority as the active queue. Tests explicitly inject `PermittingAuthority`; no default or environment bypass was added.

## Scheduler lifecycle

- Queue initialization calls `authority.startup()` before starting worker/monitor threads or serving work. Restoring a task still requires manual resume under the existing queue rules.
- One queue-owned `license-monitor` daemon thread ticks `license_status()` every second, independently of UI polling or image processing. The authority alone decides when 300 seconds since the last attempt have elapsed; the monitor never calls forced `refresh()` every second.
- Denial observation records a stop-new-work latch under the queue condition lock. It does **not** stop the worker, set an inflight job to paused immediately, close Chrome, cancel submitted work, or clear data.
- Monitor and explicit refresh/activation denials both latch. An allowed renewal does not clear the latch. A successful explicit manual continuation/new-generation action clears it, and an accepted new job starts fresh. Invalid/rejected new-job requests cannot clear an existing inflight latch.
- `close()` requests worker shutdown, signals the monitor event, joins the monitor, joins the browser worker (55-second bound accommodates the paid helper), and then closes the authority. The existing launcher already calls queue close in its finalizer. The monitor may finish its current bounded authority request before joining.
- Reset calls old queue `close(clear_state=True, close_license=False)`, waits for the old monitor, then creates the replacement queue with the same authority. Startup validation runs again. No old monitor is leaked and the shared authority is not prematurely closed. Final app exit closes it. Reset/exit clear only disposable task state and preserve license storage.

## Submission, retrieval, and resume policy

- `start()` and `start_urls()` force validation before creating a task. Manual continue/retry/redo that can start new work is guarded server-side. Opening Chrome, configuration, state, previews and existing result access stay available without authorization.
- Worker guards source-image download/preparation and each actual new submission with `force_refresh=False`. Doubao's `send_gate` guards again after browser preparation and immediately before the DOM send commit. Expiry here leaves the item safely `ready`, without an uncertain-send classification.
- Already submitted pending/Doubao retrieval, Aliyun result download, local save, OSS upload, and alias result reuse are unguarded by licensing. These finish before the next new-work boundary pauses the job. The last completed item also leaves the job paused when invalidated, while preserving its completed item/results.
- Retrieval/upload phases are considered before waiting new-generation phases, so an earlier blocked new image cannot prevent a later explicit upload retry. The stored item/ref order and mapping remain unchanged.
- If a forced refresh during continue newly returns a denial, existing pending retrieval still proceeds; any subsequent new image pauses. `retry-upload` never regenerates. Unknown actual submissions retain the previous explicit-review/no-repeat policy.

## Paid helper boundary and timing

```python
AliyunTranslator(credentials, *, profile_root=None)
sdk_translate(credentials, path, client_factory=None, *,
              license_authority=None, profile_root=None)
```

The production app explicitly passes its own profile root into `AliyunTranslator`. The subprocess receives credentials, image path and profile root through stdin, not command-line arguments. `translate_helper_main()` accepts no caller-provided allow flag. `sdk_translate()` creates a real authority from that root, calls `startup()`, prepares the SDK request/client, and calls `require_new_work(force_refresh=False)` immediately before `translate_image_with_options`. Explicit injected authorities are limited to tests. The owned helper authority closes in `finally`.

The parent paid-process hard deadline is now **48 seconds**: authorization connect/read budget 5+15 seconds, existing SDK connect/read budget 4+18 seconds, plus 6 seconds process/import overhead. No automatic SDK or helper retry was introduced. Result-only download remains its existing 18-second helper and does not require authorization. A true process timeout/malformed SDK response still follows existing uncertain-paid semantics.

A pre-SDK licensing denial is emitted as helper JSON `{"error":"license","license_status":"expired|disabled|..."}`, exit 1. The parent reconstructs a safe denied `LicenseStatus` (unknown/allowed values become `invalid_response`) and raises `LicenseRequiredError`, not `AliyunError('uncertain')`. Queue handling restores the prior safe ready phase and removes the committed `paid_calls` attempt because the helper explicitly proved no SDK request was sent. Actual submitted requests/errors retain existing attempt accounting and uncertain policy.

## Standalone UI

Added a clearly labeled 30-day software license section with password-style code input, activate, refresh, safe status, expiration timestamp and remaining days. Text distinguishes the license from the plugin pairing code and Aliyun AccessKeys, explains manual continuation after renewal, and says completed results remain accessible. Submitted code input is cleared after success/failure. New start/redo controls are disabled when denied, and their handlers also refuse bypassed clicks. Existing result retry/upload controls remain available. Server-side guards remain authoritative.

## TDD evidence

All commands used `D:\Desktop\chrome插件\artifacts\doubao-rule-venv\Scripts\python.exe` from `C:\Users\yang2\.codex\worktrees\collector-image-conversion\chrome插件`.

1. Initial RED: `python -m pytest doubao-image-tool/tests/test_license_integration.py -q --tb=short` — **12 failed in 0.88s**. Production default start did not raise, and native app/queue/SDK did not accept the required authority dependency. Implemented boundaries; initial intermediate run had 10 passing plus two Flask endpoint-name collisions, which were fixed with explicit bridge endpoint names.
2. UI RED: `python -m pytest doubao-image-tool/tests/test_ui.py -q --tb=short` — **1 failed in 0.14s**, activation callback missing. Implemented UI activation/status/denied action behavior. GREEN: `python -m pytest doubao-image-tool/tests/test_ui.py doubao-image-tool/tests/test_license_integration.py doubao-image-tool/tests/test_aliyun.py -q --tb=short` — **80 passed in 4.57s**. Legacy capability and helper-timeout expectations were updated to the new intentional contracts.
3. Recovery edge RED: integration command — **2 failed, 16 passed in 2.64s**. A forced-refresh denial blocked pending retrieval; an earlier new image blocked a later upload retry. Fixed continued retrieval and phase selection. GREEN same command — **18 passed in 2.54s**.
4. Renewal race RED: integration command — **2 failed, 18 passed in 3.15s**. Explicit denial followed by immediate activation could miss the monitor latch; an invalid new-job request prematurely cleared the latch. Fixed explicit result observation and latch clearing only on accepted start. GREEN — **20 passed in 2.65s**.
5. Denied-start observation RED: `python -m pytest doubao-image-tool/tests/test_license_integration.py -q -k denied_start_attempt --tb=short` — **1 failed, 20 deselected in 0.59s**. A failed start's denial also needed to latch the inflight job before immediate reactivation. Added common safe denial observation to guards. GREEN full integration — **21 passed in 2.78s**.

The 21 integration tests cover locked default app/queue, expired/disabled/unbound URL starts, exact send gate expiry, first-image save plus next-image pause, final-image pause, manual renewal, continued Aliyun result/OSS handling, zero-paid-call helper denial, periodic scheduler and reset/close lifecycle, token/origin/pairing/CORS protection, SDK preparation-time expiry, forced-refresh denial during retrieval, later-item upload retry, inflight renewal latch, real signed-authority 300-second/outage throttling, actual isolated helper-process denial, license-file retention and the three latch races above.

## Verification

- Preliminary full combined regression: `python -m pytest doubao-image-tool/tests license-server/tests -q --tb=short` — **470 passed in 33.78s**, exit 0.
- Final full combined regression after the last reproduced latch issue: same command — **471 passed in 33.20s**, exit 0, pristine output. This is 433 native client tests and 38 server tests.
- `python -m py_compile doubao-image-tool/core.py doubao-image-tool/app.py doubao-image-tool/bridge_routes.py doubao-image-tool/aliyun_translation.py` — exit 0, no output.
- `git diff --check` — exit 0, no whitespace errors.
- Existing launcher test starts a real localhost app only with pytest's `--state-dir` temporary root. Actual helper denial test explicitly supplies its temporary profile. SDK successes, slow/uncertain helpers, cloud generation and OSS publishers are all isolated simulations.

## Changed files and self-review

Production: `doubao-image-tool/core.py`, `app.py`, `bridge_routes.py`, `aliyun_translation.py`, `web/index.html`, `web/app.js`.

New test utilities and coverage: `tests/license_fakes.py`, `tests/test_license_integration.py`. UI harness: `tests/ui_behavior.cjs`. Existing tests explicitly receiving the permitting authority: `test_aliyun.py`, `test_aliyun_retry.py`, `test_app.py`, `test_bridge.py`, `test_bridge_pipeline.py`, `test_cloud_only.py`, `test_core.py`, `test_download_deadline.py`, `test_image_batch.py`, `test_image_limits.py`, `test_oss_queue.py`, `test_oss_routes.py`.

Self-review verified helper exceptions are not swallowed into uncertain-paid results; expired inflight jobs are not put to sleep before persistence/OSS; explicit API denials and rejected starts retain the manual-resume latch; reset preserves the shared authority and storage; live polling cannot force remote checks per image/card; no caller-controlled authorization boolean or production permissive fallback exists. Existing `core.py` is large and intertwined; changes were kept at its existing start/action/phase/send boundaries without unrelated restructuring.

No blocking concerns. Default source build intentionally remains unconfigured/locked. Formal deployed service, real hardware/two-computer acceptance and customer executable/package validation remain deferred to Tasks 4/5 and deployment. This report does not claim real cloud or paid-service acceptance.
