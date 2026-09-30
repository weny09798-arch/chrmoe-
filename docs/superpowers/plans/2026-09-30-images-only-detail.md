# Images Only Detail Repair Plan

> Execute inline using regression tests; independent review before integration.

**Goal:** Keep 详情描述 blank for all platforms and collect Taobao description pictures without product-page text or premature text-based completion.

**Architecture:** Preserve the 22-column template and all non-description product fields. Clear descriptionText during normalization and leave its export column blank even for old persisted items. Taobao description readiness/signature uses images only. Distinguish real description content from navigation labels and broad ItemDetail page wrappers. Load lazy images including srcset and longer content progressively, with existing poll limits.

**Constraints:** User explicitly requested images only. Preserve main's existing four tracked changes and unrelated folders. No live Taobao/1688 access workaround after site-policy denial. No claim that controlled fixtures prove the current real layout.

## Tasks
- [x] Regression tests: existing descriptive text is removed on normalization and legacy export while SKU/attribute/image fields stay intact; XLS/XLSX import columns unchanged. Observe failures, implement blank-text policy.
- [x] Regression tests: broad item page wrapper and nav label do not produce SKU/gallery detail images; page text without pictures remains pending; lazy srcset pictures and later description blocks are preserved. Remove text collection/readiness, scope roots and progress images.
- [x] Verify missing pictures stay partial with explicit note. Keep login/captcha pause, selected count, ID deletion/refill and all other platform behavior.
- [x] Full tests/check, delivery synchronization, independent review, version 1.5.2; merge, verified package, push authorized main and archive only this worktree.

## Verification before review

- Baseline: 237 tests passed. New regressions for normalization/export, broad wrapper, text-only readiness, srcset, long scroll and browser premature completion were observed failing before their corresponding fixes.
- Full modified suite after review fixes: 247 tests passed, zero failures. `npm run check` passed; extension resources and JavaScript syntax verified.
- Real BIFF8 XLS reader confirms the description column is empty; OOXML export regression confirms legacy persisted text is not exported. All 22 template headers remain unchanged.
- Delivery mirror: all 29 extension files plus README match source SHA256 hashes.
- No real Taobao/1688 page was inspected in this repair. Controlled DOM/VM fixtures establish local behavior, not current live-site compatibility.

## Review fixes

- Reviewer identified early completion on heading-only layouts. Reproduced with the actual reader plus browser polling, then included all safe heading ancestors and document height in scroll bounds. A 12000px unlabelled detail section now retains its image loaded after 9000px, even with a short nested header. The integration fixture models native DOM ordering because Linkedom incorrectly reverses nested-heading/later-sibling order.
- Reviewer identified seller H1 content being rejected inside explicit description roots. Reproduced the missing picture, then confined broad-wrapper exclusion to ambiguous roots. Explicit #description and #J_DivItemDesc keep valid seller markup.
- Both regressions were observed failing before repair and passing afterward. All 33 Taobao reader/browser tests pass.
- Final independent review: no remaining blocking findings; reviewer independently passed the 33 targeted tests and JavaScript/manifest checks, using local fixtures only.

## Release evidence

- Implementation commit 5bb432d merged into main and pushed to origin; remote main matched the full implementation SHA.
- Fresh merged-main suite: 247/247 passed, zero failures; `npm run check` passed.
- Version 1.5.2 package: 拼多多主图选品助手-1.5.2-详情仅图片版.zip, 30 entries individually matched source SHA256. Archive SHA256: C21EEE9EEADD18BE377DBA1E53DC8F27EB30DC555A9727226ECC028ED2DA05AE.
- Installed delivery directory: all 29 source files matched (text line endings normalized). The four pre-existing main modifications retained their original byte hashes; unrelated folders untouched.
- Managed images-only-detail worktree archived through the app and confirmed archived; pdd-rawdata-fix worktree retained.
