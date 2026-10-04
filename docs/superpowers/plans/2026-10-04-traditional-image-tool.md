# Traditional Image Tool Implementation Plan

> Execute inline with test-first steps and independent review before merging. Existing permission to save repository work persists.

**Goal:** Free local Windows image input → Traditional Chinese replacement → preview and unique PNG output at a chosen absolute path.

**Architecture:** Local Flask service/UI, serial worker, RapidOCR local ONNX engine, OpenCC, constrained Pillow/OpenCV text replacement. PyInstaller onedir bundle for Windows sharing; no remote API or image tool calls in the app.

**Tech Stack:** Python 3.12, rapidocr-onnxruntime1.4.4, OpenCC0.1.7, Flask3.1, Pillow/OpenCV, vanilla HTML/CSS/JS, PyInstaller6.

## Constraints
- User chose free local OCR conversion, wants specify output directory; source images untouched.
- No public-site publishing or arbitrary remote access. No old plugin behavior changes, no retag of1.2.
- Preserve input dimensions/alpha and pixels outside local text masks; inspect complex fonts/backgrounds.
- Same-origin token-gated loopback API; bounded uploads, no source-name path traversal, no overwrite.
- Keep unrelated current main changes/folders untouched. Worktree codex/traditional-image-tool.

## Task1 · Text conversion and local image rendering
Files: `image-translator/engine.py`, `image-translator/storage.py`, `image-translator/requirements.txt`, `image-translator/tests/test_engine.py`, `image-translator/tests/test_storage.py`.
Interfaces: `Region(box,text,score)`, `translate_regions(image,regions,mode,font_path) -> (image,report)`, `Translator.convert(image_bytes, mode) -> (png_bytes,report)`, `save_result(output_dir,source_name,png,report) -> paths`.
- [x] RED: hand-checked white background with red “减少细菌滋生”; assert report target“減少細菌滋生”, unchanged digits, unchanged outside text rect, exact size and alpha. Confidence0.3 leaves image unmodified. Invalid coordinates never patch outside image.
- [x] GREEN: dictionary conversion, bounded masks, foreground/background estimate, local inpaint and font fitting; no generative redraw. Preserve unrelated pixels. Real OCR adapted behind Translator.
- [x] RED/GREEN: same stem twice creates distinct files with PNG content; original never overwritten; relative/file output path rejected. PNG/report names derived safely from basename; exclusive writes.
- [x] Run engine/storage tests and one real OCR sample. Pin installed versions and document font/model requirements.

## Task2 · Local upload / queue / preview application
Files: `image-translator/app.py`, `image-translator/web/index.html`, `image-translator/web/app.js`, `image-translator/web/style.css`, `image-translator/tests/test_app.py`, `image-translator/run.py`.
Interfaces: factory `create_app(translator, output_default, token)`, multipart POST `/api/jobs`, GET `/api/jobs/<id>`, GET `/api/jobs/<id>/image/<index>/<kind>`; all API endpoints token-gated. Worker serializes Translator usage, progress exposes processed/total and reports, result includes generated paths.
- [x] RED: missing token/cross-origin rejected before file writes; invalid format, huge pixels, animated image and relative output rejected; no result for unknown job; filenames containing separators do not escape chosen folder.
- [x] GREEN: bounded upload validation, serial ThreadPoolExecutor, per-image failures and state synchronization, known-job previews only. User-selected output directory honored, no broad file-serving route.
- [x] UI: image picker/drag drop, path field, conversion mode, start button, progress, original/result preview, changed and skipped text table, output folder/file display and download. Avoid innerHTML for OCR/filename text.
- [x] Run HTTP integration with real image pipeline and a temporary output directory; check saved PNG is the preview content and all source files remain intact.

## Task3 · Real samples, portable distribution, independent review
Files: `image-translator/README.md`, `image-translator/build.ps1`, packaging notices and build recipe. Ignored artifacts for samples/build/venv.
- [x] Run5user images with real OCR, inspect outputs, record missed/lowconfidence/smalltext, save sample comparison. Confirm network not used by runtime.
- [x] Build Windows x64 onedir executable including RapidOCR models/configs and OpenCC dictionary/data; test clean package subprocess upload/output path workflow.
- [x] Independent review fixes red/green; full new Python suite and existing247Node checks. Preserve dirty-main file hashes.
- [x] Commit, fast-forward main, push authorized repository. Copy portable folder to user-visible workspace; ZIP verify entries/hashes; archive only this worktree after preserving build artifacts.

Self-review: no placeholder dependencies, no remote-key gate, no unapproved public deployment. Batch app is separate from the existing Chrome extension.
