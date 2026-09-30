# Taobao Pagination Fix Implementation Plan

> Execute inline using executing-plans and TDD, with independent review before integration.

**Goal:** Continue Taobao collection across actual pagination controls without falsely failing during page loading.

**Architecture:** The Taobao content reader recognizes scoped pagination and reports a bounded transition. Runner waits without consuming stale cards, then applies existing count/deduplication/detail rules.

**Tech Stack:** Chrome MV3, JavaScript, node:test, linkedom.

## Global constraints

Official HTTPS links only; no account/login bypass or live-site safety-policy workaround. No fabricated goods. Preserve existing local work and selected goods. Pagination timeout 25 seconds; Runner fallback wait at most 20 snapshots. Keep count, price, image grouping, deletion/refill and template behavior.

## Task 1 — Scoped controls and page transition

Files: `extension/content-taobao.js`, `tests/taobao.test.mjs`, new `tests/helpers/taobao-page.mjs`.

- [x] Extract existing VM page helper into tests only, with mutable location, scroll dimensions and clock.
- [x] Reproduce div/role/span next controls, disabled parents, unrelated next buttons and foreign href rejection.
- [x] Run failing tests before replacing nextPage/lastPage with shared scoped control identification.
- [x] Reproduce empty/old-card loading after click, changed page and result signature, timeout and manual retry. Implement pending/error snapshot fields; do not click twice or scan stale cards.
- [x] Run focused content suite.

## Task 2 — Runner transition

Files: `extension/lib/runner.mjs`, `tests/taobao-runner.test.mjs`, `tests/runner.test.mjs`.

- [x] Add real-reader + Runner integration for multiple pages, slow transition (over eight reads), target reached without another click, disabled last page.
- [x] Add bounded pending timeout and selected-results error-message regression. Run red, then implement skipping pending cards and bounded waiting. Include page URL in stall snapshot.
- [x] Run focused Runner/content and full suite.

## Task 2b — Main-image and skip accounting (user correction)

Files: content reader, Runner, manager, products refill; their existing tests.

- [x] Reproduce unlabelled small campaign image selected before actual main image and integer price with promotion suffix. Fix displayed-size/ranking and explicit sale-region parsing; keep current shared similarity thresholds.
- [x] Run 50-listing/8-repeat fixture through actual content reader, Runner and perceptual fingerprint; expect 50 scanned, 42 groups, 8 merges, zero rejects.
- [x] Record and show separate merge/reject/exclusion counts and rejection categories. Reset the round statistics on refill, leave unknown old statistics unreported. Verify manager rendering with a saved task.

## Task 3 — Review and release

Files: manifest, README, synchronized delivery copies, this plan.

- [x] Independent review; fix substantive issues with failing-to-passing regressions.
- [x] Version 1.4.1; sync changed extension files and README; full tests, asset/module check and diff check.
- [ ] Commit in isolated worktree, fast-forward main, recheck merged tree and preserve preexisting edits. Package ZIP and verify entry hashes; push authorized repo and archive only this worktree.

## Verification

2026-09-30: 206 tests passed, zero failures; module/manifest and diff checks passed. Independent review found and verified fixes for nested foreign links, partial old-list removal, full-document page loading including the last page, coupon fallback, missing-image accounting and legacy unknown statistics. Real-reader + Runner + perceptual hash fixture with 50 listings and 8 repeated main images retained 42 groups. No live Taobao access was attempted. Changed delivery files matched source by SHA-256.
