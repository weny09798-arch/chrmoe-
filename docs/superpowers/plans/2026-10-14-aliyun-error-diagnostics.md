# Aliyun failure diagnosis repair (1.6.7)

> For agentic workers: use subagent-driven-development task by task, with TDD and scoped reviews.

**Goal:** Explain the second image's uncertain submission and make subsequent failures diagnosable without repeating paid requests.

**Architecture:** Keep the approved single-submit Aliyun helper, queue and plugin flow. Carry only safe error category, provider code, HTTP status and request ID from SDK through helper and queue message. Never carry exception text, response dumps, credentials, headers or signed image URLs. Existing uncertain submissions remain paused and require the existing paid redo confirmation.

**Evidence:** Current user job has two distinct content hashes, no aliases, one completed/published item and a second uncertain item without an Aliyun result address. The SDK handler discards every exception's details, helper sends only its category, and parent also collapses helper timeout/protocol errors. Installed Tea UnretryableException wraps its cause in inner_exception. No retroactive cause can be established from the old record; diagnostic repair is not a claim that the original API failure is solved.

**Constraints:** No actual paid translation, SDK automatic retries, arbitrary error-message echo, user task/config mutation, timeout changes without evidence, provider switching or image changes. Keep existing read/connect/process bounds. Preserve first image and paid confirmation, OSS and export behavior. Work in-place on a Git branch per user preference; fixed delivery directory and single ZIP only.

## Task 1: error propagation and regression

- [ ] Reproduce loss of provider code/request ID and wrapped timeout using mock SDK/helper inputs; record RED before production edits.
- [ ] Implement strict allowlisted diagnostic fields and credential filtering, bounded inner-exception inspection, distinct SDK timeout versus helper timeout/malformed reply, and safe Chinese message suffixes. Legacy AliyunError calls and helper replies stay compatible.
- [ ] Preserve safe diagnostics in queue state/snapshot, clear stale diagnostics on explicit retry/redo, retain uncertain phase and no automatic resubmission. Test two distinct items: first remains complete, second uncertain; continue/restart never sends again; only confirmed redo submits the second.
- [ ] Cover malicious/secret-bearing metadata, raw SDK messages/stdout/stderr/signed URLs never leaking; helper errors do not retain sensitive process output.
- [ ] Run focused regression, self-review and commit; scoped review must be clean.

## Task 2: verified release and customer instructions

- [x] Bump plugin/backend version to 1.6.7, update exact current-version test expectations while retaining older compatibility fixtures.
- [x] Run full Python/Node/check and range whitespace checks on final code; rebuild the existing portable runtime. Initial native current-version fake failed; refreshed only that fake and reran full Python successfully.
- [x] Verify compiled helper/native startup in isolated state only; no customer state or live paid calls. Document limits: old failure detail unavailable and old result cannot be recovered without its address.
- [x] Explain update/reinstall backend with existing plugin ID, only second image's explicit redo, existing confirmation and first-image preservation; error-code categories lead to network/account/permission/service checks.
- [x] Replace fixed delivery folder/ZIP in-place, compare source/runtime and all archive member hashes, exclude personal state and keys.
- [x] Final root review clean; locally integrated by fast-forward and release tagged 1.6.7, without an automatic push.
