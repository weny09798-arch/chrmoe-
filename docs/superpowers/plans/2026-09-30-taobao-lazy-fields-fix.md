# Taobao incomplete card repair plan

**Goal:** Fix premature permanent rejection of cards whose image/price has not loaded. User screenshot: 103 scanned, 0 merges, 102 rejected (77 image, 24 price, 1 title), 1 retained. These counters establish extraction failure, not its exact DOM cause.

**Design:** Before classifying an incomplete Taobao card, its browser port requests scrolling that card into view and rereads it up to 12 times (500ms intervals). Never click/open goods for this operation. Validate original keyword and ID on every reread; honor blocked pages, stop/pause and vanished cards. Ready cards avoid polling. Add explicit public image source variants and currency/amount price layouts through failing samples; do not change similarity thresholds or invent missing fields. After five consecutive post-retry image/price/title failures, stop with an adaptation error and preserve results instead of silently skipping hundreds.

**Verification boundary:** Live Taobao access was safety-blocked earlier; no alternative browser/API access. Local samples cannot prove this exact page is fixed. If extraction still fails, report that limitation plainly.

- [x] TDD: Runner invokes preparation before validating/marking seen; an initially empty image/price becomes available after preparation; pause during preparation saves no processed key.
- [x] TDD: content scrolls the requested ID only, supports current image lazy attributes and srcset, and split price in a labelled price region with sale note/count; excludes badges/coupons and ambiguous ranges/multiple prices.
- [x] TDD: browser preparation retries only incomplete matching cards, validates site/query/ID, preserves captcha and stop/pause, bounds waiting and reports disappearance.
- [x] TDD: five consecutive incomplete post-retry cards stop with explicit adaptation note and collected goods retained. No claim of duplicate removal.
- [x] Independent review and complete suite/module/diff checks; version 1.4.2 and synchronized delivery copies.
- [x] Commit isolated work, merge authorized main preserving local changes, verify merged tree and ZIP hashes, push authorized GitHub and archive only this worktree.

Verification: 216/216 local tests pass; module and diff checks pass. Price review findings were reproduced with failing tests then repaired, including decimal buyer counts and a separate second-price span. Lazy attributes and srcset are supported in this change; background-image support is outside this release scope. Live Taobao has not been verified.

Release verification: main fast-forwarded to 0e78aab, 216/216 tests and module checks passed again. All nine pre-existing locally modified files retained their exact hashes. ZIP contains 30 entries matching source hashes; version 1.4.2. ZIP SHA256: 14D5C859C85B5AB7EC73D306D60B48359BF55D07864FFC453FA0696E3DE94666. Origin main verified at 0e78aab. Archive requested only for taobao-lazy-fields-fix.
