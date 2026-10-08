# 商品采集与本地图片转换 Implementation Plan

**Goal:** Connect the existing three-platform collector to the existing free Doubao tool, save converted images locally by product, and export a separate mapping workbook without altering original product Excel.

**Architecture:** The collector sends an immutable image-position manifest to a token-protected paired localhost tool. The single existing browser-owning worker downloads one image at a time, deduplicates exact URLs and image bytes, edits via Doubao, distributes saved results to product folders, and writes an incremental XLSX manifest. No cloud storage, paid API, old Excel import, or automatic resubmission.

## Global Constraints
- Keep source collection data and 22-column XLSX export byte/behavior compatible.
- Convert only advertising outside products/packaging; keep packaging text, digits, branding and graphics unchanged. Redesign options remain false.
- Keep ordinary 1–20 local-upload flow working; URL collector jobs may exceed 20 because download is serial and metadata-only.
- Normal close/reset clears owned temporary tasks, keeps login profile and output. Abnormal restart pauses, never automatically submits again.
- New job starts only when collection is stopped/finished and local queue is idle/completed. Delete/clear stops matching conversion and rejects stale callbacks.
- Work in this isolated checkout, carrying forward previous uncommitted Doubao fixes. Do not commit unrelated source changes or touch user running processes.

## Task 1: URL-backed serial queue, dedup and output
- [x] Add failing tests before implementation for mixed products/SKUs, >20 URLs, exact URL dedup, byte dedup, download failure continuation, retry, generated-result recovery, normal clear, paths/order and manifest workbook.
- [x] Extend QueueService with `start_urls(entries, output_dir, prompt, source_task_id)` using the existing worker and browser ownership. Entries: `{platform, product_id, title, kind, sku, order, url, product_url}`; kind is main/detail/sku, order positive integer.
- [x] Group exact URLs into one queue item with refs. Download on worker; validate HTTPS PDD/alibaba image hosts and redirects, preserve queries, cap bytes and existing PIL limits. At most two automatic GET attempts, no auto generation retry. Content SHA256 aliases reuse result, including failure/retry dependencies.
- [x] Snapshot keeps existing id/status/items plus `kind:'collector'`, source_task_id, output_dir and counts. Each item includes refs, input_path when downloaded, phase/status/message/result, and generated result recovery. Failed downloads are terminal per-item, other images continue; explicit retry remains available.
- [x] Save unique run directory below chosen output root, product folders and type/order/SKU filenames, no overwrite. Mapping `图片转换清单.xlsx` includes every input position: platform/product ID/title/type/SKU/order/original URL/local converted path/status/reason. Incremental JSON mapping survives normal close with results.
- [x] Add openpyxl dependency/build support if used; do not modify app/manager files owned by other tasks.

## Task 2: Pairing, bridge routes and folder picker
- [x] Test token/origin pairing, CORS preflight, caller/job ownership, inactive queue conflict, picker cancellation and invalid paths, result/manifest access, clear/exit.
- [x] Add `/api/bridge/pair` taking `extension_id` and valid tool token, compare header Origin if supplied; bind one extension origin per process. Expose bridge routes only to paired client with token and use existing lifecycle lock.
- [x] Routes: POST `/api/bridge/folder` -> `{path}` (empty on cancel); POST `/api/bridge/jobs` body `{source_task_id,output_dir,entries}` calls start_urls + protected prompt; GET `/api/bridge/state?job_id=...`; POST `/api/bridge/action` `{job_id,source_task_id,action,index?}` supports stop/continue/retry/redo/open-browser; GET `/api/bridge/manifest?job_id=...` download XLSX; GET `/api/bridge/images/<job>/<index>/<kind>` token header or query after paired access.
- [x] Enforce queue job identity on actions, never stop or overwrite another local user's task. Reset/exit closes queue safely, pairing remains until exit.
- [x] Local UI displays/copies connection code equal to original local URL including #token=..., without leaking token in state or logs; user manually opens local tool once each session.
- [x] Native chooser runs isolated short-lived app subprocess via frozen/source launcher `--choose-folder`; GUI canceled returns empty path. No PowerShell command interpolation or terminal helper windows.

## Task 3: Collector UI, client and immutable image manifest
- [x] Test manifest mixed sites, ID/SKU/order, original data non-mutation, connection code validation, stale callbacks and start gating.
- [x] Add image-conversion module separate from manager to construct snapshot using current selected/valid exported products (same output limit/title filter). Emit galleryImages or image fallback, detailImages, all sku image positions.
- [x] Bridge client validates only loopback random port connection codes, sends X-Tool-Token, pairs extension id, stores credential only session storage; no paid/cloud credentials.
- [x] Panel connects, chooses local folder, opens Doubao login, starts conversion, displays counts/stage/current image, stop/continue, per-image retry/redo with original/result previews, and mapping XLSX download.
- [x] Active collect disables new conversion; item deletion stops matching batch; global clear cancels batch, forgets job, invalidates every pending fetch/poll result. Later added products are excluded until user starts another batch. Existing Excel export untouched.

## Verification and delivery
- [x] Run full Node tests/check, full Python tests, UI smoke, frozen-tool smoke and connection flow against real extension UI using fake cloud backend only in tests.
- [x] Where logged-in dedicated Chrome is available, run a few actual source images through real Doubao; report generated-image correctness limits and login/verification blockers candidly.
- [x] Review full integration, repair bugs, package both extension and frozen local tool into dated customer delivery folder, include Chinese connection/use instructions.

Verification limits and results are documented in 2026-10-07-collector-image-conversion-verification.md. Native folder desktop point/cancel remains unverified because computer use returned access denied; the software picker boundary, frozen assets and backend callback tests passed.
