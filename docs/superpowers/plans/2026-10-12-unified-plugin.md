# Unified collector plugin implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Customers use one Chrome plugin for collection, credentials, image conversion, OSS previews and Excel export, with an automatically started Windows backend.

**Architecture:** A Native Messaging host starts or locates the existing token-protected Flask queue. Small native messages return ephemeral connection information; the existing HTTP bridge still transports jobs and image previews. A backend lease and drain state preserve in-flight results when Chrome disconnects.

**Tech Stack:** Chrome MV3, Native Messaging, Python/Flask, Windows DPAPI/HKCU registry, current PyInstaller runtime and test suites.

## Global constraints

- Approved spec: docs/superpowers/specs/2026-10-12-unified-plugin-design.md; version 1.6.6.
- No Google/GPT or licensing changes, no actual paid generation, no resets of the user's running state.
- Preserve current extension ID: do not add a manifest key; first install registers the actual ID.
- Fixed delivery folder and ZIP remain 商品采集与图片转换_1.6.1; user settings stay outside delivery.
- Only exact registered extension origins; no arbitrary executable or command forwarded by native messages.
- No credential readback or Chrome storage persistence; retain Windows DPAPI stores.
- Browser disconnect grace 30 seconds, draining bounded at 600 seconds; automatic exit preserves recovery state.

## Shared interfaces

- Native host name: `com.productcollector.images`; protocol 1.
- Request `{id: string, action: 'connect'|'ping'}`. Response connect `{id,ok:true,version:'1.6.6',connection_code:'http://127.0.0.1:PORT/#token=TOKEN'}`; error `{id,ok:false,error: safe Chinese text}`. Native host validates Chrome-supplied origin against installed settings; EOF detaches the lease.
- Installed `backend-settings.json`: `{extension_id: string, state_dir: absolute string}`; no secrets. Native host uses only its own executable and this locally installed configuration, not message-provided paths.
- `AutomaticRuntime(root, token, port, queue, shutdown, extension_id, ...)`: publishes encrypted descriptor, registers protected native lease routes; `attach`, `heartbeat`, `detach`, `close` own lease lifecycle and watchdog. `run.py` instantiates after binding server, before serving; `--automatic` mode never opens the local management UI and preserves state on exit.
- `QueueService.begin_drain()` blocks new submissions while allowing the already submitted current item through receipt/download/save/OSS publish; `drain_complete()` reports safe to exit. User continue explicitly cancels drain only after reconnection. Drain must not restart an uncertain request or send the next image.
- Paired bridge settings routes: `/api/bridge/settings/aliyun` GET/POST/DELETE, `/api/bridge/settings/oss` GET/POST/DELETE, `/api/bridge/settings/oss/check` POST. Backend callback returns redacted status; body validation remains owned by existing credential stores.
- Bridge capabilities adds `unified_plugin:true, automatic_backend:true, settings_in_plugin:true` and version 1.6.6.
- Paired `/api/bridge/current` GET returns existing collector snapshot for auto reattach; conversion controller must match source_task_id to current collection before accepting published links or actions. Foreign task exposes a safe conflict/reset option, never attaches writes.
- Paired `/api/bridge/reset` POST clears queue through existing lifecycle; `/api/bridge/action` retains scoped operations.
- `extension/lib/native-backend.mjs`: native connection broker class, injected runtime/timers for tests; `ensureBackend()` returns connection_code. Background script handles only manager-origin `ensure-backend` messages and owns native port/heartbeat. Manager setup invokes broker via chrome.runtime.sendMessage, then existing controller.connect(code), without saving credentials to persistent storage.

### Task 1: Native startup, automatic lifetime and installer

Files: create doubao-image-tool/native_host.py, native_runtime.py, backend_install.py and tests/test_native_backend.py; modify run.py and build.ps1; create install/uninstall CMD entry points.

- [x] Write failing native framing, registered origin, concurrency/stale descriptor, fake spawn and registry tests. Assert `decode_frame(encode_frame({'action':'connect'})) == {'action':'connect'}` and reject frames over 1MiB.
- [x] Run targeted Python tests and retain expected RED output.
- [x] Implement bounded JSON framing; exact protocol/action/origin whitelist; token never printed except framed response. Host launches same installed exe hidden with --automatic/--no-open, validates encrypted ready descriptor against authenticated service, and attaches a random native session. Ping only renews own lease. No arbitrary message paths.
- [x] Implement installation to current-user fixed directory, transactional copy/rollback, HKCU native manifest exact allowed_origins, settings, repeat install and safe uninstall. Validate all owned removal targets before recursive cleanup. Installation reports actual error and does not reset configurations.
- [x] Add tests for no UI/no generation at startup, native EOF cleanup, last lease disconnect/drain, exit descriptor removal; run GREEN.
- [x] Build script includes entry points in existing portable/source directories. Root performs actual compiled/native Chrome smoke in isolated state.

### Task 2: Paired settings, queue drain and recovery

Files: modify doubao-image-tool/app.py, bridge_routes.py, core.py; create tests/test_unified_bridge.py and tests/test_queue_drain.py.

- [x] Write tests that nonpaired requests cannot mutate credentials, successful status does not contain Secret, OSS reuse mode needs no repeated keys, clear/current reject foreign sources, old statuses resume without submissions.
- [x] Run RED before adding routes.
- [x] Extend register_bridge through explicit settings callbacks from app; reuse existing credential stores and OSS check. Preflight GET/POST/DELETE methods must match settings endpoints and keep all origin/token checks. Add current/reset and capabilities described above.
- [x] Write drain tests with one submitted fake image and a second distinct image: `queue.begin_drain(); release_result(); assert first.public_url; assert submits == 1; assert queue.drain_complete()`. Include Aliyun timeout, already cached result, duplicate aliases, close and late return isolation.
- [x] Implement queue drain state: no new POST/prepare-send while draining; allow already submitted item and its aliases to publish then pause. Preserve stopped/uncertain/failed entries and old job compatibility. Reconnection alone doesn't continue jobs; explicit user continue clears drain.
- [x] Run targeted GREEN + previous bridge/core/Aliyun/OSS tests and report safe shutdown bound.

### Task 3: Single plugin UI and automatic controller

Files: create extension/lib/native-backend.mjs, extension/settings-ui.mjs and tests/native-backend.test.mjs/tests/settings-ui.test.mjs; modify background.js, manifest.json, manager.html/manager.mjs, conversion-ui.mjs/lib/image-conversion.mjs and relevant tests.

- [x] Write RED broker tests for connect/ping, malformed reply, missing host, concurrent ensures, reconnect, wrong page sender; UI tests for automatic connection/no manual code, installation ID copy and provider credentials guards.
- [x] Add nativeMessaging permission, preserve extension identity, version1.6.6. Use service-worker native broker with one connection, small request IDs and timeout; dropped port rejects waiters and can reconnect, no automatic paid submission.
- [x] Replace customer-facing local tool/code fields with automatic backend status and reconnect/help controls. Existing collection rendering and export remain independent when backend missing.
- [x] Add plugin settings for Aliyun key/secret and OSS bucket/region/source/independent keys, password inputs, save/delete/check and redacted state. Clear secret fields after save and never storage.set secrets.
- [x] Restore same-source recovered job and published links after connecting; source mismatch keeps existing collection intact and offers explicit clear conversion task. Refresh/close manager does not clear backend state. Existing ownership and overlay guards remain.
- [x] Add explicit reset conversion task and open Doubao controls; return safe model/error/progress labels and preserve type limits/packaging/paid confirmation. Mock all external calls.
- [x] Run targeted Node and local behavior tests GREEN. Root regression checks all tests and compiled plugin.

### Task 4: Review, compiled proof, delivery and Git

Files: update README.md, doubao-image-tool/README.md, docs/商品采集与本地图片转换使用说明.md; existing fixed delivery folder/ZIP; plan checkboxes and verification report.

- [x] Read delivery/documentation diff and run fresh full Python (451)/Node (423) tests and npm run check. Git diff --check is required before each delivery commit; logs retained as artifacts/unified-final-*.log.
- [x] Root-owned: finish task-scoped delivery review and whole-branch review; fix any findings with regressions when behavior changes.
- [x] Root-built and root-verified compiled runtime at backend 8a2a62f; later edits are plugin UI only. Isolated protocol and real Chromium checks passed with temporary state/registration cleanup, real DPAPI and zero paid_calls; delivery reuses the unchanged verified EXE.
- [x] Partial XLS/XLSX mocks, result drain/recovery and stale-source isolation covered by full tests; root additionally downloaded and inspected a partial XLSX from real Chromium with preseeded results. Actual paid tests remain disabled.
- [x] Update customer instructions for one-time install-ID, automatic connection, plugin credentials, safe uninstall, upgrade and precise validation boundaries.
- [x] Copy verified plugin/runtime/source/docs into the existing fixed delivery folder; replace the single ZIP, verify all 2,677 member hashes and reject customer-state/key/profile/cache/test files. EXE unchanged; plugin/runtime/source matched verified inputs. Exact ZIP hash retained in delivery report and artifacts/unified-final-package.json.
- [ ] Root-owned: commit final review fixes if needed, fast-forward integration and tag1.6.6 after all checks; no automatic GitHub push.
