# ID Dedup and Detail Images Implementation Plan

> **For agentic workers:** Use executing-plans inline, with requesting-code-review before integration.

**Goal:** Keep requested distinct product IDs without requiring search images; retrieve preview/export images during automatic detail enrichment.

**Architecture:** Retain jobs/groups persistence shape but group by best.id only. Remove image hashing from the browser and runner; make deletion/exclusion ID-only. Existing detail tabs provide galleryImages; normalize first image into image and fallback SKU, retain links on detail errors.

**Tech Stack:** Chrome MV3, JavaScript ES modules, node:test, linkedom, existing Excel writer.

## Global Constraints
- Three sources use ID dedup; no same-art cheapest promise. Keep template columns, filters, pagination, count stop, pause/captcha, and accumulated export.
- Preserve nine pre-existing local modifications; isolated branch based on main 1ae4eeb. No live-site workaround after prior safety denial.

### Task 1: ID grouping and deletion
- [x] Replace old image-group tests with expectations: IDs 1,2,3 retained even with identical images; duplicate ID 1 still one result; missing image/fingerprint accepted. Run `node --test tests/core.test.mjs tests/products.test.mjs`, observe expected failures.
- [x] In core.mjs remove similar import/fingerprint requirement and use `job.groups.find(g=>g.best.id===candidate.id)`. In products.mjs exclude only IDs and store only removed best.id; legacy group members do not merge future products. Recovery keeps previous winners, discards image-based exclusion behavior.
- [x] Verify deletion/refill retains prior details, ignores old image exclusions, and reaches target with different IDs of identical art; commit tested behavior.

### Task 2: Search and automatic detail images
- [x] Write integrated tests for all sources: missing image cards reach requested count without hash calls; details supply first gallery image to preview/export; ordinary detail failure retains link; blocked detail remains resumable. Run `node --test tests/id-collection.test.mjs` red.
- [x] Runner removes image requirement/hash, browser removes hash implementation/cache and prepareCard completeness excludes images. normalizeDetail sets primary image and fallback SKU image from gallery first. Enrich marks missing primary image as partial with explicit note, preserves collected item on error.
- [x] Update Taobao reader/runner tests to preserve 50 distinct IDs despite repeated art, stop on count, and prepare only missing name/price. Run targeted tests green.

### Task 3: UI, review, release
- [x] Update manager text/manifest to ID dedup, detail images and ID-only deletion; no same-image merge claim. Version 1.5.0; README explains behavior change and old task retry.
- [x] Full `npm test`, `npm run check`, `git diff --check`; synchronize tracked delivery copies and verify hashes. Request independent reviewer; repair substantive issues with failing tests.
- [x] Commit, fast-forward main, reverify merged tests/local-file preservation, create verified 30-entry ZIP, push authorized GitHub main, archive only this managed worktree.

Review scope extension: real PDD and 1688 content adapters also gated on images. Added failing DOM samples before removal of those gates; PDD now finds independent ID/link cards and never turns empty src into /null. No-image nested result scrolling uses the first card rather than a first image. Real adapters -> Runner -> detail normalization -> template export retains 13 IDs for each source in a controlled fixture. Opening errors racing with manual Stop preserve stopped job state.

Verification before integration: 228/228 full tests pass; module/manifest check and whitespace check pass; source/delivery hashes match. Independent read-only reviewer rechecked the repaired adapters and ran 70 relevant tests, with no remaining concrete finding. Actual live-site layout is unverified; no bypass of prior site-access denial was attempted.

Release evidence: main fast-forwarded to 6ebbdff; merged suite 228/228 and module checks pass. Six unrelated pre-existing files remain byte-identical; original nine tracked files were backed up before integration. 1.5.0 ZIP has 30 entries, every entry SHA-256 matches its source, all delivery files match after newline normalization. ZIP SHA-256: 907142F933CA1A2BE399C13C291E5074FE002269A8F826D692686B1D57A99A03. GitHub origin/main verified at the feature commit. Native archive request queued only for id-dedup-detail-images; pdd-rawdata-fix remains untouched.
