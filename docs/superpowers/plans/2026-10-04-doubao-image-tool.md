# Doubao Traditional Image Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a shareable Windows tool that converts Simplified text in product images to Traditional using the user's Doubao web account, saving images in their selected folder.

**Architecture:** Separate local queue/storage, standard visible Chrome DOM adapter, and loopback UI. Browser objects belong to one worker thread. Production browser adapter uses Playwright; controller verifies external website only via CUA and reports separate-window end-to-end validation honestly.

**Tech Stack:** Python 3.12, Flask, Pillow, Playwright, pytest, PyInstaller, HTML/CSS/JavaScript, installed Chrome.

## Global Constraints

- Windows 10/11 64 bit. Batch 1–20 static JPG/PNG/WebP, total <=80MB, image <=16M pixels and max side <=16000.
- Primary goal is Simplified-to-Traditional conversion; background and typography redesign are secondary, optional and default OFF. Preserve document wording, numbers, units, product identity. Editable prompt.
- Original files never overwritten. Exclusive unique `name_繁體.png` output plus JSON with prompt/time/status, no credentials/signed links. Output chosen folder on running PC.
- Dedicated visible installed Chrome profile in local user app data; login manually once, no reuse/copy of Codex or regular Chrome cookies. No stealth, bypass, undocumented Doubao API, or unlimited-free claim.
- Serial queue; stopping prevents subsequent sends, already submitted request is kept pending. Continue never sends it again. 8-minute generation timeout pauses. Only explicit retry can submit again after uncertain submission; download retry should first reuse existing result.
- Auth, verification, quota, upload, missing controls, timeout and download failure pause with stage-specific message. User can inspect Chrome. Single-item redo, result/original preview, progress.
- Loopback random port/token, Host/Origin guard, no arbitrary file preview routes. Local state metadata preserved; on restart unfinished submissions require user inspection and explicit retry, no silent resend.
- Existing extension and local OCR tool untouched. Login/cache/build outputs never committed/distributed. Bundled application source, dependencies, Chinese instructions/licenses; package excludes profiles and user images.

## Task 1: Local queue, prompts and output storage

**Files:** Create doubao-image-tool/core.py, storage.py, prompts.py, tests/test_core.py, tests/test_storage.py, tests/test_prompts.py, requirements.txt.
**Interfaces:** `build_prompt(background=False, typography=False, extra='')->str`; `validate_inputs(files:list[tuple[str,bytes]])->list[tuple[str,bytes]]`; `save_result(output_dir,name,data,prompt)->dict` returns output and record absolute paths. `QueueService(browser_factory, state_dir)` with `start(files,output_dir,prompt)->str`, `snapshot(job_id=None)->dict`, `action(command,index=None)->None`, `close()->None`. Browser contract: `open()->None`, `submit(path:Path,prompt:str)->None`, `poll()->bytes|None`, `close()->None`. Adapter may raise `NeedsUser(message)` before or during a pending request, or `SubmissionUncertain(message)` when send outcome unknown. A resumed pending request polls, never re-submits; pre-send readiness failures can retry submit on Continue if adapter proves not sent. Introduce phase metadata to enforce this contract.

- [ ] Write failing behavior tests: stopped pending request survives continue and no second submission; failed output write can retry save without new generation; timeout cannot silently resend; corrupt input rejected; conflicting names produce different PNG files; default prompt requests Traditional and no redesign, enabling background never removes primary conversion instruction. Use literal expected behavior and an external browser fake only for slow cloud operations.
- [ ] Run Python pytest tests/test_core.py tests/test_storage.py tests/test_prompts.py -q and record RED output.
- [ ] Implement queue with worker-owned browser and condition/event controls; immutable uploaded copies in state folder, thread-safe snapshots; validated output paths and exclusive writes. Persist job.json after transitions using atomic replacement. On restart restore finished results; pending entries become needs-review, require explicit retry. Close cleans browser on owning worker. Complete outputs retained; failures do not advance unseen sends. Define statuses and phase in public snapshots for UI.
- [ ] Run focused tests then full new-tool suite; record output; self-review and commit only task files.

## Task 2: Doubao DOM browser adapter

**Files:** Create doubao-image-tool/browser.py, tests/test_browser.py, tests/fixtures/doubao.html.
**Interfaces:** `DoubaoBrowser(profile_dir:Path, timeout_seconds=480)` implements Task 1 contract; timeout controlled at queue level to preserve pending polling. `select_result(candidates:list[dict], baseline:set[str])->dict|None` and `select_fullsize(images:list[dict], identity:str)->str` are pure DOM-observation selection helpers. Adapter exceptions imported from core. Source should lazy import Playwright so tests of queue/storage do not launch browser.

- [ ] Write failing tests for historical image rejection, original upload rejection, unloaded image rejection, identity matching from thumbnail to actual full-size DOM src without constructing a URL, and ambiguous/multiple generated candidates causing pause rather than wrong image pairing. Test using DOM fixtures + pure extraction boundaries or fake external DOM interactions, not actual network calls.
- [ ] Run pytest tests/test_browser.py -q and record RED.
- [ ] Launch installed Chrome with `launch_persistent_context(profile_dir, channel='chrome', headless=False, accept_downloads=True)` on worker. Navigate to official https://www.doubao.com/chat; wait for user readiness before upload. Use observed testids: upload_file_button; menu 上传文件或图片; filechooser; contenteditable composer; chat_input_send_button. Read DOM to verify uploaded filename/progress removal and exact prompt before single send. On current conversation page, visible main button create_conversation_button opens fresh conversation; sidebar counterpart may not work. New conversation per image avoids virtualization remounting history; never click navigation during pending generation.
- [ ] Before sending capture baseline generated identities; after send only use `[data-testid="message_image_content"][data-finished="true"] [data-testid="mdbox_image"] img[alt="image"]` new generated identity. Keep per-item pending state. Inspect visible auth/verification/quota/error signals with narrowly scoped DOM text. Poll normally, no API requests for model generation. Open generated mdbox_image; read loaded actual full-size img with same rc_gen_image identity in DOM, not guessed signed URL; prefer edit_image_download_button and download event, fallback fetch only exact observed full-size media via browser context if no event, verify decoded image before return. Close canvas_close_btn after saving. Do not persist signed URL. Save diagnostic stage descriptions without cookies.
- [ ] Run tests, import/compile checks; record limits (CUA verifies site selectors and downloadable output; standalone browser-account live run requires user login). Commit adapter files.

## Task 3: Local UI, application launcher and portable package

**Files:** Create doubao-image-tool/app.py, run.py, web/index.html, web/app.js, web/style.css, tests/test_app.py, README.md, build.ps1, 启动豆包图片转换.cmd, THIRD_PARTY_NOTICES.md, collect_licenses.py.
**Interfaces:** `create_app(browser_factory=None,state_dir=None,output_default=None,token=None)` returns Flask with QueueService in extensions; POST /api/jobs multipart files/output_dir/extra/background/typography; GET /api/state; POST /api/action action + index; known original/output preview GET /api/images/<job>/<index>/<kind>; POST /api/exit. Every API needs token except root/static. run.py starts random loopback Werkzeug server, opens local UI, browser starts only when user selects 打开豆包 or submits job.

- [ ] Write failing app tests for unauthorized/origin/host rejection, validated upload start, returned job state, index-specific redo, known preview confinement, missing Chrome handled as visible error, page default options OFF. Inject browser fake to avoid external interactions in tests. Preserve actual validation/storage behavior.
- [ ] Run pytest tests/test_app.py -q and record RED.
- [ ] Implement clean Chinese UI: primary title 豆包图片繁体转换; numbered steps select images/output, login Chrome, process; editable extra requirements, optional default-off background/typography checkboxes; note uploads sent to Doubao/current account quota. File selection and preview, output folder text with example, stage/progress, stop/continue/retry and per-image redo. Disabled states while commands pending, error text rather than alert-only, completion openable file references. UI polls snapshot and reconstructs prior task after refresh; no embedded third-party scripts.
- [ ] Implement app safeguards/launcher/lifecycle. Default state/profile under LOCALAPPDATA/DoubaoImageTool. Single program instance should clearly report profile-in-use instead of silently using another profile. Document first login is separate from Codex sidebar. Build onedir PyInstaller bundling Playwright driver and licenses, using installed Chrome; no bundled browser/model/user state. Exe CLI --help and loopback startup verified without browser launch.
- [ ] Run whole new-tool test suite, syntax checks, package build, file count/exclusions and smoke startup. Controller uses CUA for local UI and external five-image tests, and produces dated original/results HTML report. No direct shell automation of external website during verification. Commit only new-tool source/docs. Report exact residual limitations; do not claim unattended Chrome end-to-end proven until it was.
