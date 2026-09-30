# Taobao Collection Implementation Plan

> **For agentic workers:** Use executing-plans inline, with test and independent review checkpoints.

**Goal:** Add Taobao source selection and full available product details to the current import template.

**Architecture:** Site routing selects isolated Taobao search/detail readers. The browser reads bounded page-owned initialization data and feeds the detail reader; existing Runner, exclusion and spreadsheet flows stay shared.

**Tech Stack:** Chrome MV3 JavaScript, node:test, linkedom.

## Global constraints

Preserve user data and unrelated work. HTTPS official hosts only; no login bypass. Target/price/group/removal behavior unchanged. SKU values come from actual matching rows, never guessed. Development cannot access the live Taobao page; document that validation boundary.

## Task 1 — Routing and search

Files: lib/sites.mjs, lib/core.mjs, content-taobao.js, manifest.json, manager.html/mjs, tests/taobao.test.mjs.

- [ ] Test `resolveSite('https://www.taobao.com/').id === 'taobao'`, encoded q/isSearch validation, official Taobao/Tmall item ID matching, enqueue/retry retaining site.
- [ ] Test cards with current title/image and split price; reject misleading labels, foreign hrefs, duplicate ID and sold counts; next page clicked only once per snapshot; hidden/login controls do not produce goods.
- [ ] Run failing tests; implement route via `siteById(site).id`, search URL `https://s.taobao.com/search?q=...`, official product canonical URLs and standalone content reader exposing PDD_SNAPSHOT/PDD_SCROLL/PDD_OPEN_CARD.
- [ ] Run focused tests and current content/core/manager suite.

## Task 2 — Details and export

Files: detail-taobao.js, lib/taobao-page.mjs, lib/browser.mjs, tests/detail-taobao.test.mjs, tests/browser-taobao.test.mjs.

- [ ] Test exact product ID root, nested initialization/apiStack JSON, skuBase propPath plus skuCore sku2info mappings, multiple prices/images/stocks and absent fields; recommendation data must never supply the current product.
- [ ] Test DOM sections, lazy detail images, description document URLs, missing/blocked details; export normalized two-SKU product and verify template rows/specs/prices/platform.
- [ ] Run failing tests. Implement serialized `readLiveTaobao()` returning page roots without unrelated globals, and detail reader projecting safe fields. Browser preserves official Tmall item links, waits for pending SKU/detail data, requests only page-provided allowed description URLs.
- [ ] Run focused tests and full suite.

## Task 3 — Review and delivery

- [ ] Update README with Taobao URL use and partial-field behavior; version 1.4.0.
- [ ] Independent code review, fix substantive issues with red/green regression tests.
- [ ] Run `npm test`, `npm run check`, `git diff --check`; synchronize changed delivery files, verify hashes and all ZIP entries.
- [ ] Commit isolated work, fast-forward main preserving existing changes, verify merged tree, push authorized GitHub repository, archive this worktree only.
