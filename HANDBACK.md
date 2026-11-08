# Handback — security audit run-1 leads (2026-11-08)

Branch `fix/redaction-and-transfer-hardening` (from `main` at `4cb5bba`), **not pushed**, no PR,
nothing published. Details per lead: `docs/security/2026-11-audit-run-1.md`.

## Leads

| # | Lead | Status | Test | Fix commit |
|---|---|---|---|---|
| 1 | Original XObject reachable after redaction/erase | Confirmed (shared dict, inherited dict, path-only form); nested image-in-form rejected (PDFium regenerates) | `residue.node.test.ts` "L1" + "pruning keeps…" | `cad3a2a`, `472cf05` |
| 2 | /Thumb, /PieceInfo, /Alternates, /AF, removed annotations | Confirmed except /Alternates (rejected: PDFium drops them on the blanked copy) | `residue.node.test.ts` "L2" | `cad3a2a` |
| 3 | Undecodable streams treated as clean | Confirmed (form, attachment; XMP survived hex-encoded) → fail closed (`unchecked`) | `residue.node.test.ts` "L3" | `cad3a2a` |
| 4 | .selispack applies foreign settings | Confirmed (source) → confirmation sheet, second confirm when versions would be deleted | `settings.rs`, `retention.rs`, `ForeignSettingsSheet.test.tsx` | `85a8d99` |
| 5 | Transfer sender move powers, deep-link auto-receive, have-oracle | Confirmed → sender prompt before connecting, settings via confirmation, signatures only from saved devices, dedupe only for trusted push | `selis-transfer/tests/transfer.rs`, `transferStore.test.ts`, `transfer.spec.ts` | `85a8d99` |
| 6 | Erase leaves inline images to PDFium | Rejected (PDFium blanks them; regression test kept) | `residue.node.test.ts` "L6" | — |
| 7 | IPC ids/sources become paths | Confirmed (`../library/<blake3>` deleted a version file) → id format + existence, confined receive dir, granted sources for `stage_source` | `save.rs`, `transfer.rs`, `picker.rs` tests | `79704e5` |
| 8 | qpdf pre-check loops to trailer /Size | Confirmed (> 100 s, killed) → bounded by file size / 3; now < 5 s | `ops.rs` `a_huge_declared_trailer_size_…` | `7c14e1a` |

## Verification (2026-11-08, this machine)

- `npm run verify:tier1`: **exit 0** — typecheck all workspaces; eslint 0 warnings; vitest
  64 files, 535 passed / 1 skipped (incl. the 24 `residue.node.test.ts` cases with real PDFium
  WASM and qpdf); `cargo fmt --check`; `cargo clippy --workspace --all-targets -D warnings`;
  `cargo test --workspace` all ok (selis-app 35, selis-core 94, selis-pdfops 14,
  selis-transfer 29 + 12 integration, …); `cargo deny check`: advisories, bans, licenses,
  sources ok.
- `cargo test -p selis-app export_bindings`: ok; `bindings.ts` committed (new
  `transfer_ticket_sender`, `ForeignSettings`, changed `PackImportView` / `ReceiveView`).
- Playwright (mock IPC): `transfer.spec.ts` 33/33 on Pixel 7 + iPhone 15 (one worker; with
  parallel workers the dev server timed out on cold loads, unrelated to the change).
- Independent review (code-reviewer subagent): no MUST-FIX; SHOULD 1, 2 and 4 fixed in
  `472cf05` with mutation-checked tests; NITs listed in the security note.
- **Not run:** Tier 2 (Android debug build, Maestro on the AVD). The transfer Maestro flows now
  tap the new sender prompt (`transfer-link-accept`) and need a device run before an RC.

## Owner decisions / follow-ups

- Behaviour change (ADR 0014 update): a library move from a device that is not saved no longer
  brings its signatures; settings from a move or a pack are applied only after the user confirms.
- `import_document`, `stage_pdf`, `stage_photo`, `pack_kind`, `pack_import` still take any
  source string from the UI (header-checked, bytes not exposed to script): binding them to
  granted sources is a follow-up.
- Forms/attachments in `[/ASCII85Decode /FlateDecode]` are now refused rather than decoded;
  adding those decoders would avoid refusals on old Distiller files.
- New English strings only (ADR 0030); Greek in the next translation pass.
