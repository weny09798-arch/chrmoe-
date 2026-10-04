# Pinduoduo Detail and SKU Repair Implementation Plan

> Execute sequentially with executing-plans, regression tests and independent review. User requested the collection changes; no further feature approval gate is needed.

**Goal:** Collect Pinduoduo product attributes as a concise description, actual gallery/detail images and real SKU data, with slower bounded loading and both official mobile hosts supported.

**Architecture:** Prefer current product bootstrap data. Use scoped DOM areas for product gallery, 商品详情 attributes and long images; never classify an arbitrary page image as a product photo. Restore descriptions only for Pinduoduo; Taobao/1688 remain image-only. Read SKU data after an explicitly identified specification entry; never submit a checkout or payment confirmation. Poll Pinduoduo more slowly, keep CAPTCHA/login pause and preserve selected-count/ID deletion/refill.

**Tech stack:** Manifest V3, JavaScript DOM readers, existing browserPorts, XLS/XLSX template exporter, Node test + Linkedom.

## Constraints
- Preserve 22 template columns and existing Taobao/1688 behavior.
- Preserve unrelated main work and tag 1.2; use a managed isolated worktree.
- Live Pinduoduo inspection requires the user to log in; do not request credentials. Do not bypass login, CAPTCHA or site-policy denial.
- A button labelled payment/order is not permission to complete a purchase. Only an unambiguous specification entry can be activated automatically; otherwise explain the missing SKU fields and retain the product.
- Longer waits reduce unnecessary retrying, not a guarantee against detection.

## Tasks
- [x] Baseline tests and root-cause inspection; inspect user-provided goods page if login becomes available.
- [x] RED/GREEN: concise Pinduoduo description survives normalization and export, while other sites stay blank.
- [x] RED/GREEN: scoped galleries/details exclude service icons, avatars, recommendations; support lazy and later images, preserve all real gallery data.
- [x] RED/GREEN: current product SKU readiness, safe specification opening and delayed data, no checkout confirmation clicks; no invented combinations/prices.
- [x] RED/GREEN: mobile.yangkeduo.com links/search redirects and permissions; slower bounded Pinduoduo poll/search cadence and preserved block behavior.
- [ ] Independent review, full suite/check, delivery mirror sync, release package and authorized repository push. Preserve prior tag 1.2 and archive only this worktree.

## Verification evidence
- Baseline: 247 tests pass; final: 264 tests pass, npm run check and git diff --check pass.
- Live product 672673135904: five attribute pairs, sixteen detail images; White/160 option visibly changes price from 0.67 to 0.99. Only the specification dialog was opened; confirmation/payment was never clicked.
- Added sanitized product DOM sample; tests exercise lazy images, recommendation boundaries, sequential/delayed SKU prices, unchanged-price termination and hidden/foreign dialogs.
- Independent review found four initial issues plus foreign-dialog attribution; all have regression coverage and were closed by final review.
- Delivery mirror has the same thirty extension files; ZIP has thirty files plus README. Push and worktree cleanup are the remaining delivery steps.
- Full installed-extension collection has not been run in the user's Chrome. DOM-only fallback is intentionally partial when a price update cannot be verified; it stops rather than reusing an old price. Unavailable SKU IDs/stock remain blank.
