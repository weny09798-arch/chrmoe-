# Task 5 report: manager detail progress

- Implemented phase-aware task title and current detail text for detail enrichment, including selected-item progress and selected-item error count.
- Kept the existing search progress wording and job-name-based overall percentage.
- Added completed/failed detail counts to terminal result explanations when `job.note` is empty; existing notes retain precedence.
- Kept existing controls and verified export remains enabled for a resumable detail task.
- `extension/manager.html` was not changed because the required task-title, progress-label, current-detail, and results table elements already exist.
- TDD evidence: the new focused detail-progress assertion failed before the rendering change (`正在处理 · 相机` vs `正在补全详情 · 相机`).
- Validation: `node --test tests/manager.test.mjs` passed (11/11); `npm test` passed (95/95); `npm run check` passed; `git diff --check` passed.
