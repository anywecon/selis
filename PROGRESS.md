**Current:** v1.0.0-rc.5 is a draft on GitHub Releases, built and signed by CI; not published and not on Play yet. Play Internal testing runs rc.4, Closed testing rc.1.
**Next step:** owner:
- publish the rc.5 draft and upload `selis-1.0.0-rc.5.aab` to Play Internal testing;
- get 12 opted-in testers into Play Closed testing, then move Closed testing from rc.1 to the current RC;
- on the S23, check text sharpness at fit-width and 100 %, and Convert/Export on the rc.5 build.
Next development: push `fix/redaction-and-transfer-hardening` as a PR after the owner reviews HANDBACK.md and Tier 2 runs on the AVD; then AI features (ADR 0036).
**Last session:** 2026-11-08 — security audit run-1 leads: 1, 2, 3, 4, 5, 7 and 8 confirmed and fixed, 6 rejected (HANDBACK.md, docs/security/), on branch `fix/redaction-and-transfer-hardening` (not pushed). Tier 1 green; Tier 2 (Android build + Maestro, transfer flows now tap the sender prompt) not run.


## v1.0.0-rc.5 (2026-11-04)

Done:
- #100 — GHSA-m665-v7pm-7grj (critical, zip <= 9.0.4; ADR 0012 amendment):
  - zip `=9.0.5` in both locks.
  - The fix is opt-in in the crate, so `import_pack` now calls `validate_header_consistency`.
  - Selis only reads through `ZipArchive` into its own staging names, so the advisory's file overwrite did not apply. The risk was a pack reading differently here and in other tools.
  - async-executor 1.14.1: 1.14.0 was yanked and failed `cargo deny` on every branch.
- #87 — undici 8.12.3. #104 — zod 4.6.7 (plain update, no override). Both dev-only. #99 closed as superseded.
- #102 — translation pass: 37 Greek keys for conversion and export; 3 Greek baselines (`viewer-more`).
- #106 — version 1.0.0-rc.5: versionCode 10000050 (10000051–54 per ABI), CHANGELOG, Play "What's new" en-US and el-GR. Annotated tag `v1.0.0-rc.5` on 91ada52.

Verified:
- Regression test `refuses_local_header_that_disagrees_with_central_directory`: fails without the new call on 9.0.5, passes with it. Packs written by rc.1 code (zip 9.0.3), plain and protected, still import (one-off check).
- `.selispack` fuzz target: 60 s in CI with zip 9.0.5, 193,956 runs, no crash.
- osv-scanner on main's locks: nothing for zip, undici or zod; no finding scored HIGH or CRITICAL. Ten findings have no score in OSV.
- Playwright en + el, strict CI of #102: 293 passed, 4 skipped.
- Maestro, full suite on AVD 36: 27/27 with no retries, including `pack`, `convert-docx` and `upgrade-locale`. The S23 was not used.
- Release run 41901811965:
  - SHA256SUMS, SBOMs, 16 KB LOAD, F-Droid scanner, reproducible build.
  - `selis-1.0.0-rc.5.aab`: 65,757,140 bytes, versionCode 10000050, upload key d7dee4ae…9d0762.
  - APKs signed with the app key 2b9682e1…af1598.

Open:
- Draft: published by the owner.
- No TestFlight build: the App Store Connect secrets are not set, so the iOS job skips signing and upload.
- Local `cargo test` on this host: two `selis-transfer` tests that find peers over mDNS fail, also on an older commit where they had passed the same day. They pass in CI. Cause not confirmed.
- CI's Tier 1 job ran out of disk once (#100, `No space left on device`); the rerun passed. It may recur.
- #103 would move zip to 9.2.1 past the exact pin; the regression test guards the check if it is merged.

## v1.0.0-rc.4 (2026-10-28)

Done:
- #86 — sharp page text at every zoom (ADR 0002 amendment):
  - Pages are drawn at CSS size × devicePixelRatio on whole device pixels.
  - Above the tier's bitmap cap, the page keeps a base image and gets 256 px tiles, drawn into pooled 512 px cells once scrolling pauses.
  - Tiles are rendered pixel-identical to the whole page (`FPDF_RenderPageBitmap` at whole-pixel offsets).
  - The worker yields through a `MessageChannel`.
  - Also in #86: the `small-text` fixture, `scripts/measure-sharpness.ts`, and push-fixtures ordering for the picker's Recent list.
- #85 — ctutils 0.4.4 (RUSTSEC-2026-0385).
- #89 — translation pass: no missing Greek key; 69 Greek baselines redone.
- #91 — version 1.0.0-rc.4: versionCode 10000040 (10000041–44 per ABI), CHANGELOG, Play "What's new" en-US and el-GR. Annotated tag `v1.0.0-rc.4` on d2c9d48.

Verified:
- AVD `selis-midrange-api36`, cold boot, rc.3 and #86 interleaved (docs/spike-p0.md):
  - Bitmap vs CSS × DPR, before → after: 0.48 → 1.00 on the Pixel 7 profile (DPR 2.625); 0.42 → 1.00 on the S23 profile (DPR 3).
  - SSIM against PDFium (9 pt), before → after: 0.62–0.85 → 0.998–1.000.
  - Full resolution 70–209 ms after a zoom, ≤ 123 ms after a scroll.
  - Fit-width fps unchanged. At 100 %, 1–4 fps lower.
  - Memory peak 440–470 MB against 371–425 MB before; the gate is < 600 MB.
- Tier 1 local and CI. Playwright en 155 + visual baselines; 70 en and 69 el baselines reviewed.
- Maestro, full suite on AVD 36: 25/25. The 7 picker flows passed after #86's fixture-order fix.
- Release run 40640409688:
  - SHA256SUMS, SBOMs. No TestFlight upload (corrected 2026-11-04): the iOS job skipped it, the App Store Connect secrets are not set.
  - APKs signed with the app key 2b9682e1…af1598; the AAB with the upload key d7dee4ae…9d0762.
  - 16 KB LOAD, reproducible build. The S23 was not used.

Open:
- Published by the owner on GitHub and in Play Internal testing; Closed testing stays on rc.1 until it has 12 opted-in testers.
- Scroll fps at 100 % zoom is 1–4 fps below rc.3 on the AVD.
- Fit-width memory is +50–70 MB.

## P7c file conversion (2026-10-28, on main after rc.4)

Done (#92, ADR 0035):
- "Convert to PDF": DOCX via docx-preview; XLSX/CSV with our own JSZip reader; TXT, Markdown, HTML.
  - Everything passes through one sanitiser and a CSP.
  - Android prints with an off-screen WebView and no dialog (android.print callbacks).
  - Preview, then Save as a new document.
  - Entry points: the library button, VIEW/SEND intents.
- Viewer ⋮ → Export: Word (headings, bold/italic, images, page breaks, OCR for scans), text, Markdown, page images in a ZIP.

Verified:
- Corpus of 20 English files (12 DOCX, 8 XLSX), Linux CI:
  - all within ±1 page of LibreOffice 26.8.1;
  - 98.9–100 % of words kept;
  - 0 network requests while converting.
- AVD:
  - convert-docx: 2 pages (LibreOffice 2), 99.8 % of 920 words.
  - export-word: erase.pdf words in order with 2 pictures; scan via OCR 100 % of 136 words.

Open:
- iOS (`WKWebView.createPDF`) is not built: no iOS plugin infrastructure yet; the entries are hidden there and on desktop.
- The Greek strings come in the next translation pass.
- Startup JS +16.5 kB (+5.5 kB gzip) for the conversion UI; the converters are lazy chunks.

## P7b (2026-10-20)

Done (PRs #72–#74, #71 Dependabot merged — bindgen stays on syn 3):
- English first for new strings (ADR 0030 amendment): en.json only; `tools/i18n/check-el.ts`
  warns in CI between RCs and fails in the `translation-pass` PR and on release tags; runtime
  fallback to English tested; Greek Playwright/visual sets run only in the translation pass.
- Erase (ADR 0033): brush S/M/L, rectangle, object mode (tap = topmost, long press = next);
  white / match background / eyedropper fill; preview + undo per stroke; each apply is a new
  version labelled `erase` (schema 8); signed documents warn once. Engine: un-share XObjects
  over the area, PDFium glyph + image-pixel removal, geometric path cutting in the content
  stream, fill, full rewrite.

Verified: engine tests against pdf.js + bytes (erased words gone, image samples replaced in the
stream, no path point inside the area, page identical outside a 2 px margin except anti-aliasing
on cut curves ≤ 65/255 on ≤ 0.02 % of pixels, shared page untouched, rotated page, delete
object count − 1); Rust v7→v8 migration test; Playwright erase (Pixel 7 + iPhone 15); CI visual
baselines erase-strokes / erase-object; Maestro erase + full suite (25) on selis-midrange-api36.

Open risks:
- Found while measuring: ADR 0009 redaction changes images/forms shared with other pages in place
  (a redacted area over a logo drawn on every page blanks it everywhere). Erase un-shares first;
  the same step should go into `redact.ts` (follow-up PR).
- EmbedPDF's text rects are not turned on /Rotate pages (seen in tests; may affect text
  selection / redaction "text" tool on rotated pages).
- Not cut by Erase: shadings and pattern cells (covered), soft masks of erased images, dash
  phase after a cut; annotations stay (ADR 0033).
- Dependabot alert #1: glib < 0.20 (Linux desktop only, via Tauri/gtk); waits for the Tauri line.

Device testing (owner, S23 after the Play build): Annotate → Erase with each mode and fill; the
signed warning on a signed PDF; undo after Apply; a rotated page; Greek UI shows the Erase tool in
English until the translation pass.

## P5b (2026-10-15)

Done (PRs #49–#53): one app signing key + upload key (docs, checks), iOS export compliance YES
without France (+ French ANSSI draft), IzzyOnDroid submission text, F-Droid estimate, name check;
control borders ≥ 3:1 with an automated contrast test; Android 14+ transfers as user-initiated
data transfer jobs (FGS only below 14); TalkBack fixes from the S23 walkthrough; "Scan a photo";
Android store screenshots with scan review; App Store screenshots from the iOS simulator in CI;
GitHub Pages site live.

Verified: Tier 1 + Playwright (en/el) + visual baselines in CI; Maestro suite (22 flows incl.
transfer-background) on the AVD and the S23; Pages deploy.

Open risks / owner: see docs/release/1.0-rc.md "Open before 1.0" (mid-range device, off-LAN
transfer, TestFlight, human TalkBack pass, FGS path below Android 14).

## P5c (2026-10-16)

Done: English first for upgrades (schema 7: stored "system" → "en" once), README features and
English screenshots, English store defaults, repo description/topics; IzzyOnDroid dropped (AI
policy), v1.0 on Play + GitHub Releases with stable asset names and Obtainium setup, F-Droid AI
position recorded, AI-assistance note on README and website; transfers below Android 14 (foreground
service) verified on an API 33 Play image with an updated Google WebView, WebView minimum 111
documented; first signed CI run fixed (AAB check without jarsigner -strict).

Verified: Tier 1 (377 vitest, Rust, deny), CI; Maestro 20 flows + upgrade-locale on AVD 36 and
S23, transfer flows + upgrade-locale on API 33.

Open: social preview upload (no API); see docs/release/1.0-rc.md "Open before 1.0".

## v1.0.0-rc.1 (2026-10-16)

Done: store images English-only (el-GR/App Store el fall back to en-US; CI guard
`scripts/check-store-images.sh`; ADR 0024 amendment); AAB attached to the GitHub release
(ADR 0023 amendment); `zip` 9.0.3 (9.0.2 yanked, cargo deny red on main); Dependabot #58 merged,
#59 closed (bindgen syn 2/3 lock, serde_json/uuid ignored), #57 closed (gradle-wrapper frozen
until v1.0); annotated tag `v1.0.0-rc.1` on fb4a4f7.

Verified: CI on #61/#58/main green (incl. iOS screenshots en-only on 3 devices); Maestro 18 flows
on AVD 36 with #58, 5 flows (incl. pack) on main; release run: AAB signed with the upload key
(SHA-256 d7dee4ae…9d0762), APKs with the app key = SELIS_APK_CERT_SHA256 (2b9682e1…af1598),
asset names `selis-1.0.0-rc.1-<abi>.apk`, SBOMs (npm 72, Rust 714 components), SHA256SUMS
checked locally, reproducible arm64 APK byte-identical + apksigcopier OK. versionCode 10000010
(AAB/universal), per ABI 10000011–14. No TestFlight (Apple secrets not set).

Open: the release is a draft until the owner publishes it; Play upload manual.

## P7a — Scan 2.0 (2026-10-18)

Done (PRs #64 core, #65 app, #66 device fix + flows; ADR 0032, ADR 0016 amended): automatic
capture (0.6 s steady, < 2 % corner drift, sharpness ≥ 800 calibrated on the scan-sample corpus;
progress ring, haptic, "Auto" switch saved as `scanAuto`, default on; re-arms only after the
page is gone 1 s or moved 25 %), hints Hold steady / Move closer / More light (torch); Enhance
filter (default): background σ −84…−95 % on the generated photos, text contrast up; batch with a
thumbnail strip, review (open a page: corners, filter, rotate, touch-up eraser with undo, retake
in place, delete; long-press drag), memory cap 120/240/480 MB by tier; ID card mode (A4, both
sides 85.6 × 54 mm). WASM: SIMD 179 262 → 212 954 B, base 172 778 → 201 167 B; JS 372 → 380 KB
gzip (budget 1.5 MB).

Verified: Tier 1 (vitest, cargo test incl. corpus replay, clippy -D warnings incl. wasm32,
deny); Playwright en + el, new scan visual baselines from CI reviewed; Maestro on AVD 36:
scan-auto, scan-batch (9-page PDF read back in order 3,x,2,4,5r,6,8,9,x), scan-idcard
(210 × 297 mm, sides 85.60 × 54.00 mm) and the other 21 flows; upgrade-locale. The S23 was not
used (Play build).

Open: device haptic and auto-capture feel on a real phone (S23 via Play Internal); iOS has no
haptic; automatic Keep after an automatic capture is not done (the Adjust step stays).

## v1.0.0-rc.2 (2026-10-19)

Done: #67 — auto-keep in a batch (Auto on, a page kept, live edge support ≥ 85 %, page found in
the still → kept with Enhance, "Page N added" 600 ms + thumbnail fly-in, none with reduced
motion; otherwise Adjust; `find_page` falls back to a bilinear-sampled copy, and a still of the
live frame's shape uses the scaled live outline), camera header fits 360 dp (no count before the
first page, 16 dp text inset, ellipsis; layout test + `scan-header-360-*` baselines); #68 —
version 1.0.0-rc.2 (versionCode 10000020 / 10000021–24 per ABI), CHANGELOG, Play "What's new"
en-US + el-GR; annotated tag `v1.0.0-rc.2` on 08f4eac.

Verified: Tier 1 (vitest 395, Rust, deny); Playwright en + el incl. 360 × 800 header baselines
(CI-written, reviewed); Maestro on AVD 36: all 24 flows (scan-batch: 12-page PDF in order, three
pages kept by themselves; transfer-recover/-background and tools needed a rerun after another
session's Maestro / stale samplers of mine); release run: SHA256SUMS ok, APKs signed with the app
key 2b9682e1…af1598 (= SELIS_APK_CERT_SHA256), AAB with the upload key d7dee4ae…9d0762, AAB and
universal APK versionCode 10000020, reproducible arm64 APK byte-identical + apksigcopier ok,
SBOMs npm 72 / Rust 714 components. No TestFlight (App Store Connect secrets not set).

Open: the release is a draft until the owner publishes it; Play upload manual; S23 test of Scan
2.0 on the Play build.

## v1.0.0-rc.3 (2026-10-21)

Done:
- #75 — redaction copies a shared image or form before changing it (ADR 0009 update). A logo on
  three pages used to lose its pixels on all three.
- #77 — text geometry on /Rotate 90/180/270 pages, read and mapped at the engine boundary
  (ADR 0034, upstream embedpdf/embed-pdf-viewer#892). Night-mode image bounds follow the same
  mapping.
- #78 — redaction runs on the Erase rewrite. PDFium's own redaction had left paths, shadings,
  patterns and soft-masked paint whole under the box. Now paths are cut, the rest is flattened
  to rasters with the area cleared, and the boxes are painted last.
- #78 — Erase clips ink and markup over the area and removes the other annotations there.
  `versions.note` (schema 9) records what was done.
- #76 — rustls-webpki / webpki-roots, RUSTSEC-2026-0382 and -0381 (published 2026-10-20).
- #79 — translation pass: 38 Greek keys, the Greek erase and annotate-note baselines, shorter
  Greek erase hints.
- #80 — version 1.0.0-rc.3: versionCode 10000030 (10000031–34 per ABI), CHANGELOG, Play
  "What's new" en-US and el-GR. Annotated tag `v1.0.0-rc.3` on 3289b36.

Verified:
- Tier 1, local and CI: vitest 470 + 1 skipped, Rust fmt/clippy/test/deny.
- Playwright en + el: 286 passed in the translation-pass run. `pack-export` is a known flaky
  shot that passes on retry.
- Engine tests:
  - Shared logo: pages 1 and 3 byte-identical, PDFium and pdf.js. The test fails without the fix.
  - Rotated pages: text-layer and search IoU ≥ 0.9 on every rotation; redact and erase remove
    exactly the chosen word.
  - redact-flatten, with the boxes hidden: the area is uniform white. Without flattening,
    23 716 pixels remain.
- Maestro, full suite on AVD 36: 25/25. Retries: scan and transfer-recover passed on their 2nd
  attempt; transfer-background passed alone after clearing my leftover samplers.
- Release run: SHA256SUMS OK; APKs signed with the app key 2b9682e1…af1598, AAB with the upload
  key d7dee4ae…9d0762; AAB and universal APK versionCode 10000030; reproducible build and SBOMs
  OK. The S23 was not used.

Open:
- The release is a draft until the owner publishes it. The Play upload is manual.
- S23 screens to check on the Play build: Erase in each mode and fill; the signed warning; undo
  after Apply; a rotated page (selection and search highlights); redaction over a drawing or a
  shaded area (nothing under the box); the Erase strings in Greek.
- Known limits:
  - Erase still covers shadings and patterns (ADR 0033).
  - A redaction removes annotations over the area whole; it does not clip them.
