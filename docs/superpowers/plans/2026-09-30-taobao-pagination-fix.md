# Taobao Pagination Fix Implementation Plan

> Execute inline using executing-plans and TDD, with independent review before integration.

**Goal:** Continue Taobao collection across actual pagination controls without falsely failing during page loading.

**Architecture:** The Taobao content reader recognizes scoped pagination and reports a bounded transition. Runner waits without consuming stale cards, then applies existing count/deduplication/detail rules.

**Tech Stack:** Chrome MV3, JavaScript, node:test, linkedom.

## Global constraints

Official HTTPS links only; no account/login bypass or live-site safety-policy workaround. No fabricated goods. Preserve existing local work and selected goods. Pagination timeout 25 seconds; Runner fallback wait at most 20 snapshots. Keep count, price, image grouping, deletion/refill and template behavior.

## Task 1 — Scoped controls and page transition

Files: `extension/content-taobao.js`, `tests/taobao.test.mjs`, new `tests/helpers/taobao-page.mjs`.

- [ ] Extract existing VM page helper into tests only, with mutable location, scroll dimensions and clock.
- [ ] Reproduce div/role/span next controls, disabled parents, unrelated next buttons and foreign href rejection.
- [ ] Run failing tests before replacing nextPage/lastPage with shared scoped control identification.
- [ ] Reproduce empty/old-card loading after click, changed page and result signature, timeout and manual retry. Implement pending/error snapshot fields; do not click twice or scan stale cards.
- [ ] Run focused content suite.

## Task 2 — Runner transition

Files: `extension/lib/runner.mjs`, `tests/taobao-runner.test.mjs`, `tests/runner.test.mjs`.

- [ ] Add real-reader + Runner integration for multiple pages, slow transition (over eight reads), target reached without another click, disabled last page.
- [ ] Add bounded pending timeout and selected-results error-message regression. Run red, then implement skipping pending cards and bounded waiting. Include page URL in stall snapshot.
- [ ] Run focused Runner/content and full suite.

## Task 3 — Review and release

Files: manifest, README, synchronized delivery copies, this plan.

- [ ] Independent review; fix substantive issues with failing-to-passing regressions.
- [ ] Version 1.4.1; sync changed extension files and README; full tests, asset/module check and diff check.
- [ ] Commit in isolated worktree, fast-forward main, recheck merged tree and preserve preexisting edits. Package ZIP and verify entry hashes; push authorized repo and archive only this worktree.
