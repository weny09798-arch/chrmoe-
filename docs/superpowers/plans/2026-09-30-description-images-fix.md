# Description Images Repair Plan

> Execute inline with regression tests and independent review before integration.

**Goal:** Collect Taobao/Tmall 图文详情 after opening/loading it; keep 1688 descriptions free of review, UI and telemetry images.

**Architecture:** Retain search, ID grouping, SKU and Excel contracts. Add bounded detail-section activation and progress in the Taobao reader. Scope 1688 DOM/frame extraction to descriptions, and validate CDN description images at the document boundary. Never infer image content solely from reuse across products.

**Constraints:** Preserve existing main changes; isolated branch from f3fb733. Direct 1688 page inspection was denied; prior Taobao access was also denied. No alternate access workaround. Workbook is read-only evidence. User approval to fix existing behavior is already provided.

## Evidence
- Taobao reader never opens or scrolls description; detailPending is false if neither document URL nor image exists, allowing early return with SKU.
- 1688 starts scanning after the first 商品详情 label including a navigation label and scans every readable iframe. User workbook contains 27 review image URLs and telemetry URL arms-retcode.aliyuncs.com/r.png.
- User confirmed the cow image address: https://cbu01.alicdn.com/img/ibank/2020/428/378/22185873824_536529798.jpg; exclude that exact image identity.

## Tasks
- [x] Add failing real-reader tests for 图文详情 activation, heading-delimited content, lazy images and frame isolation; repair Taobao selector/load readiness. Browser polling must honor pending nonempty descriptions and preserve fields.
- [x] Add failing 1688 tests for review widgets before content heading, unrelated iframe images, description-frame lazy images; restrict sources. Add document parser test excluding scripts/telemetry/review images while preserving explicit description images and URL-only JSON descriptions.
- [x] Filter identified cow placeholder only after exact evidence; missing descriptions remain partial, not invented.
- [x] Run full suite/check; synchronize delivery copy; independent review; version 1.5.1. Preserve pre-existing files, merge, verify ZIP entries, push authorized repository and archive only this worktree.

Verification: nine added tests exercise activation, lazy frames, bounded scrolling/stability, document filtering and single-SKU deep descriptions; original cases were observed failing before fixes. Full suite 237/237 passes; manifest/module and whitespace checks pass; tracked delivery copies match. Independent reviewer reported two reproduced issues (deep SKU ancestors and data-lazy-src selection), both repaired with failing-then-passing tests; final review ran 58 relevant tests and found no remaining concrete defect. Live-site verification remains unavailable under the browser site-safety restrictions.

Release verification: feature commit 67000c6 fast-forwarded to main and GitHub origin/main matched. Merged 237/237 tests and module check pass. Four unrelated pre-existing files remain byte-identical to backups; all six originals preserved in artifacts/description-premerge-20260930-191341. Version 1.5.1 ZIP contains 30 source-matching entries; SHA-256 5A419F5E8696E3287C96348FDCB621410C08022664D56E94AC7D58E7CC684904. Delivery source matches after newline normalization. Native archive requested for description-images-fix only.
