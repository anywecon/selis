# Handback — security audit run-1 leads (2026-11-08/09)

Branch `fix/redaction-and-transfer-hardening` (from `main` at `4cb5bba`), **not pushed**, no PR,
no tag, nothing published or filed. Details per lead: `docs/security/2026-11-audit-run-1.md`.
Version is now **1.0.0-rc.6** (versionCode 10000060).

## Leads

| # | Lead | Status | Test | Fix commit |
|---|---|---|---|---|
| 1 | Original XObject reachable after redaction/erase | Confirmed (shared dict, inherited dict, path-only form); nested image-in-form rejected (PDFium regenerates) | `residue.node.test.ts` "L1" + "pruning keeps…" | `cad3a2a`, `472cf05` |
| 2 | /Thumb, /PieceInfo, /Alternates, /AF, removed annotations | Confirmed except /Alternates (rejected: PDFium drops them on the blanked copy) | `residue.node.test.ts` "L2" | `cad3a2a` |
| 3 | Undecodable streams treated as clean | Confirmed → fail closed, then decoded: Flate, LZW, ASCII85, ASCIIHex, RunLength, chains, predictors, 128 MiB limit; what still cannot be decoded fails closed | `residue.node.test.ts` "L3" (9 encodings × 4 + A85 zero runs + 5 fail-closed); `filters.node.test.ts` (38) | `cad3a2a`, `11a0d45`, `fc7363e` |
| 4 | .selispack applies foreign settings | Confirmed (source) → confirmation sheet, second confirm when versions would be deleted | `settings.rs`, `retention.rs`, `ForeignSettingsSheet.test.tsx`; Maestro `pack.yaml` (decline, then apply) | `85a8d99`, `ce05046` |
| 5 | Transfer sender move powers, deep-link auto-receive, have-oracle | Confirmed → sender prompt before connecting, settings via confirmation, signatures only from saved devices, dedupe only for trusted push | `selis-transfer/tests/transfer.rs`, `transferStore.test.ts`, `transfer.spec.ts`; Maestro `transfer*.yaml` | `85a8d99`, `e1bce38` |
| 6 | Erase leaves inline images to PDFium | Rejected (PDFium blanks them; regression test kept) | `residue.node.test.ts` "L6" | — |
| 7 | IPC ids/sources become paths | Confirmed → id format + existence, confined receive dir; **all six** source commands (`import_document`, `stage_pdf`, `stage_photo`, `stage_source`, `pack_kind`, `pack_import`) open only picker / "Open with" sources (+ `cache/dev-inbox` in debug/measure builds) | `save.rs`, `transfer.rs`, `picker.rs`; `source_tests.rs` (each command on the mock runtime, mutation-checked) | `79704e5`, `8ecf229`, `a68c1b8` |
| 8 | qpdf pre-check loops to trailer /Size | Confirmed (> 100 s) → bounded by file size / 3; now < 5 s | `ops.rs` `a_huge_declared_trailer_size_…` | `7c14e1a` |

## This session (2026-11-08/09)

1. Lead 7 remainder: `picker::granted_source` is the one way a command turns a UI source into
   something to open; `pick_pdf`, `pick_pack`, `pick_photos` (Android) and `pending_opens` grant
   what they hand out. `scripts/measure-transfer.ts` pushes into `cache/dev-inbox`.
2. Decoders (`packages/engine/src/filters.ts`): strict LZW / ASCII85 / ASCIIHex / RunLength and
   TIFF predictor 2 next to Flate and PNG predictors; malformed data, image codecs, unknown
   filters, bad predictor parameters and anything over 128 MiB decoded give null → fail closed.
   Encoders for fixtures in `@selis/fixtures/encode`, cross-checked against qpdf. The residue
   oracle now decodes at qpdf's `specialized` level (`generalized` skips RunLength).
3. Tier 2 (below). Flow fixes only: the prompt's "Receive" is tapped by label (the devtools
   hierarchy drops that button's testid); `pack.yaml` declines then applies the pack's theme.
4. Release prep: `1.0.0-rc.6` via `tools/release/version.ts`, CHANGELOG section with a plain
   Security part (affected rc.1–rc.5), Play "What's new" en-US/el-GR (275 / 331 chars), draft
   advisory `docs/security/GHSA-draft-redaction.md` (**not filed**).

## Verification (this machine)

- `npm run verify:tier1`: **exit 0** — typecheck, eslint 0 warnings, vitest 65 files /
  611 passed / 1 skipped, `cargo fmt --check`, clippy `-D warnings`, `cargo test --workspace`
  (207 passed, 0 failed), `cargo deny check` advisories/bans/licenses/sources ok.
- `cargo test -p selis-app export_bindings`: ok; `bindings.ts` unchanged (no signature changed).
- Playwright `transfer.spec.ts` + `transfer-camera.spec.ts` (mock IPC, one worker): 34 passed,
  1 skipped (the spec's own skip: camera denied on iPhone 15).
- Code review (code-reviewer subagent) of this session's diff: 2 MUST-FIX (ASCII85 output cut
  short after `z` runs — fail open; pack flow without the theme), both fixed (`fc7363e`,
  `eb7660d`); SHOULDs fixed (`fc7363e`, `a68c1b8`).
- **Tier 2**: debug x86_64 APK of 1.0.0-rc.6 (HEAD content) built with NDK 27.3; Maestro on the
  AVD `selis-midrange-api36` (API 36), device lock held. Final APK: `transfer`,
  `transfer-recover`, `transfer-background`, `pack`, `redact`, `erase`, `import-scroll-back`,
  `import-from-intent` (cold + warm), `pages`, `images`, `convert-docx` — **all pass**, each
  with its POST_RUN check. Before the flow fixes the three transfer flows and `pack` failed on
  the prompt tap / the missing theme; `transfer-recover` failed once at its first step (app not
  on screen in 30 s) and passed on the rerun.
- Not run: the rest of the Tier 2 list (annotate, sign-forms, tools, scan*, ocr, export-word,
  upgrade-locale, …) and the S23 — those paths are unchanged on this branch.

## Owner decisions / follow-ups

- Behaviour change (ADR 0014 update): a library move from a device that is not saved no longer
  brings its signatures; settings from a move or a pack are applied only after the user confirms.
- Before release: review and file `docs/security/GHSA-draft-redaction.md`, push the branch as a
  PR, tag `v1.0.0-rc.6` (owner's go). Users who redacted with rc.1–rc.5 should redact again.
- New English strings only (ADR 0030); Greek in the next translation pass.
- NIT left: `pick_*` granting is covered by Maestro, not unit tests; dev-inbox (debug/measure
  only) checks the path and then opens it by name.
