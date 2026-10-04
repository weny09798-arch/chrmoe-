# Local Traditional Image Tool Verification

Date: 2026-10-04. User selected a free local OCR/OpenCC/replacement tool, with chosen local output folder and a distributable Windows demo.

## Evidence

- Python regression/integration suite: 49 passing tests. Includes real packaged OCR fixture, static-format/dimensions/animation validation, source/alpha preservation, unsafe-region skips, repeated-name exclusive writes, partial batch failure, local access controls, concurrent admission before decoding, preview eviction without deleting output, and shutdown.
- Existing extension: 247 Node tests pass; manifest/assets and all extension JavaScript modules verified. No extension implementation edits in this feature branch.
- Browser UI: selected the user's toast image, entered an explicit output folder, ran conversion, observed progress finish, PNG saved path and paired image previews. No browser warnings/errors. Tested exit closes the local server. Screenshot saved in ignored artifacts.
- Windows onedir executable: built with local ONNX models, OpenCC dictionaries/configs and web assets. Launched from an unrelated temporary directory without development PYTHONPATH/PYTHONHOME/VIRTUAL_ENV; performed actual HTTP upload, OCR conversion “减少细菌滋生” → “減少細菌滋生”, verified PNG dimensions, preview bytes, chosen destination, JSON record, unchanged uploaded original bytes, and graceful shutdown.
- Independent reviewer identified nonuniform-alpha text corruption and concurrent-upload memory admission. Both fixed and regression tested; re-review found no unresolved important issue and independently confirmed 49 tests passing.

## User sample results

Five `Snipaste_2026-10-03_*.jpg` examples completed in one serial local batch; original file hashes unchanged and saved dimensions equal EXIF-oriented original dimensions. These counts refer to OCR lines, not individual characters or complete image translation:

| Sample time | Replaced lines | Skipped lines requiring conversion |
| --- | ---: | ---: |
| 21-35-18 | 3 | 2 |
| 21-35-48 | 3 | 5 |
| 21-36-01 | 6 | 8 |
| 21-36-17 | 2 | 6 |
| 21-36-27 | 1 | 2 |

Clear text on simple backgrounds is suitable. Decorative outlines/photo backgrounds were retained rather than erased after early output inspection showed residue. Small packaging text and OCR errors remain limitations. Replacement uses system fonts and cannot reproduce all artwork. Dictionary conversion can be contextually imperfect; reports allow source/target inspection. No claim of complete image conversion or production-quality fidelity.

The program binds only to loopback. Its application code makes no remote API calls; OCR receives decoded local pixels, models/dictionaries are packaged, and output is PNG plus JSON. Software package excludes the user's sample photos; examples are copied separately for the user's local inspection.

## Delivery

Portable delivery contains345 files, with SHA256 inventory; every archive entry was read and matched its source hash. ZIP is101.4MiB. Copied executable passed the same real HTTP/OCR smoke test from the user-visible delivery folder. Source merged to main and pushed; existing dirty extension files' SHA256 hashes remained unchanged. This task's managed worktree was archived after preserving the software, sample previews and verification logs. The previous pdd-rawdata-fix worktree was left untouched.
