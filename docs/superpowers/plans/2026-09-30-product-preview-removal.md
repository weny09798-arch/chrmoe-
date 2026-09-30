# Product previews and removal refill implementation plan

> **For agentic workers:** Use executing-plans inline, with test and review checkpoints.

**Goal:** Display first product photos, delete unwanted image groups, and automatically refill their saved targets.

**Architecture:** Core functions own persistent group exclusions and refill state. A small scheduler serializes debounced refill after the existing runner finishes. The manager owns accessible preview rendering and pause/stop controls.

**Tech Stack:** Chrome MV3, JavaScript modules, node:test, linkedom.

## Global constraints

- Preserve unrelated working-tree changes and current multi-source collection.
- Keep task limit, price settings, selected details, and historical seen keys.
- Reject deleted IDs and similar images; explicit keyword retry preserves exclusions.
- Debounce 1000 ms; never run two collectors; manual pause/stop cancels automatic restart.
- At most 200 new scanned candidates per refill; stop at result end or target.

## Task 1: Selection and exclusion data

Files: extension/lib/core.mjs, extension/lib/products.mjs, tests/products.test.mjs.

- [x] Write failing tests importing `removeProduct(job,id)`, `prepareRefill(job)`, `productImage(item)`, `candidateExcluded(job,candidate)` from products.mjs. Verify first safe main image, removed group IDs/images/fingerprints, surviving details, refill reset with seen preserved, exclusion on cheaper candidates and explicit retry.
- [x] Run `node --test tests/products.test.mjs` and confirm feature absence.
- [x] Implement those functions; use existing fingerprint similarity, filter HTTPS previews, retain exclusions during retry, reject exclusions in addCandidate.
- [x] Rerun focused core/products tests.

## Task 2: Serialized refill scheduling

Files: extension/lib/refill.mjs, tests/refill.test.mjs, extension/manager.mjs.

- [x] Write failing tests for `createRefillScheduler({settle,flush,setTimer,clearTimer})`. Returned API is `{schedule(),cancel(),idle()}`. Two deletes coalesce; pending active run completes before flush; cancel during waiting prevents flush; later deletion starts a new request.
- [x] Implement generation cancellation with a single serialized operation and debounce timer. Run focused tests.
- [x] Manager removes synchronously, pauses active runner, saves immediately, schedules safe refill and automatic restart only when permitted. Manual pause/stop and clear cancel scheduler. Recovery prepares persisted requests without auto-running paused work.

## Task 3: UI and integration

Files: extension/manager.html, extension/manager.css, tests/manager.test.mjs, README.md.

- [x] Add manager integration tests for thumbnail selection, accessible deletion, immediate result removal and persisted exclusion, delayed auto-start, paused/blocked behavior, and clear cancellation.
- [x] Add product image/operation columns. Image uses lazy loading/referrerPolicy=no-referrer and text placeholder on load error; delete uses accessible × button.
- [x] Verify runner refill preserves other selected products and reaches saved limit without reopening deleted IDs or images.
- [x] Run `npm test`, `npm run check`, and `git diff --check`; inspect rendered page with representative data.
- [x] Sync only changed feature files to delivery copy, verify hashes, package versioned ZIP, commit only these files and push to authorized repository.
