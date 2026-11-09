# Security audit run-1: lead status

Private-safe summary of the eight leads from the first audit run (quick profile, commit
`48b9d5d`). No exploit steps; every fixture is generated in the tests (no user data). Branch
`fix/redaction-and-transfer-hardening`, not pushed.

Status: **confirmed** = a test failed (or the code demonstrably did the harmful thing) before
the fix; **rejected** = the test passes on the unfixed code, with the reason.

| Lead | Status | Test | Fix |
|---|---|---|---|
| 1 Redaction/erase: unredacted original XObject still reachable | **Confirmed** for a resource dictionary shared with an unmarked page (`greek` fixture), one inherited from /Pages, and a path-only form drawn once (PDFium does not regenerate it). **Rejected** for an image inside a form drawn once: PDFium regenerates the copied form and keeps only the names it draws. | `residue.node.test.ts` › "L1: …" (8 cases + 2 fail-closed cases); "pruning keeps every XObject that is still drawn" | `cad3a2a`, `472cf05` |
| 2 /Thumb, /PieceInfo, /Alternates, /AF, removed annotations | **Confirmed**: page /Thumb and /PieceInfo; an attachment also in catalog /AF; a removed FreeText note kept reachable by its popup, a reply's /IRT and a structure-tree OBJR (redaction and erase). **Rejected**: image /Alternates (PDFium writes the blanked copy without them); copies now drop them anyway. | `residue.node.test.ts` › "L2: …" (5 cases) | `cad3a2a` |
| 3 Undecodable streams treated as clean | **Confirmed**: a form under the area in [/ASCIIHexDecode /FlateDecode] was saved uncut (PDFium keeps the filter chain); an attachment in [/ASCII85Decode /FlateDecode] naming a redacted word was kept. XMP under /ASCIIHexDecode: **confirmed** in another form — PDFium drops the filter and keeps the hex digits, so the words survived hex-encoded. Fixed in two steps: first fail closed (`unchecked`: nothing saved, the toast says why; unreadable XMP dropped), then decoded: Flate, LZW, ASCII85, ASCIIHex and RunLength, alone or chained, with PNG/TIFF predictors and a 128 MiB per-stream limit; malformed data, image codecs and unknown filters still fail closed. | `residue.node.test.ts` › "L3: every non-image filter and chain …" (9 encodings × 4 cases, A85 zero runs) and "L3: what still cannot be decoded fails closed" (5 cases); `filters.node.test.ts` (vectors, qpdf cross-check, 18 malformed / limit cases) | `cad3a2a`, `11a0d45`, `fc7363e` |
| 4 .selispack applies foreign settings (retention prune, relay) | **Confirmed** in source (`pack_import` → `apply_patch` → `apply_retention`, no prompt). Settings are now only described; a sheet lists every change, history-deleting retention needs a second confirmation with the count. | `settings.rs` › `foreign_settings_change_nothing_and_count_what_retention_would_delete`; `retention.rs` › `a_preview_counts_what_would_go_and_removes_nothing`; `ForeignSettingsSheet.test.tsx` | `85a8d99` |
| 5 Transfer sender gets move powers; deep link auto-receive; membership oracle | **Confirmed**: the old move test asserted that a *ticket* receive skipped a blob the receiver had (the oracle); `track_receive` applied sender settings and signatures; a link started a receive without a tap. Now: a prompt with the sender before anything connects; settings via the same confirmation as packs; signatures only from a saved device; dedupe only for a trusted push. | `selis-transfer` › `a_ticket_receive_fetches_every_blob_even_one_the_receiver_has`, `a_trusted_push_skips_what_the_receiver_has`; `transferStore.test.ts` (link asks first, decline, expired); `transfer.spec.ts` (deep link prompt, decline) | `85a8d99` |
| 6 Erase leaves inline images to PDFium | **Rejected**: PDFium turns the inline image into an image XObject with the area blanked and keeps the rest (measured; the right half still renders). Kept as a regression test. | `residue.node.test.ts` › "L6: …" | — (test in `cad3a2a`) |
| 7 IPC ids/sources become paths | **Confirmed** for `discard_working_copy` (`../library/<blake3>` unlinked a version file in the test with the check disabled). `transfer_cancel_receive` joined the id under `in/` unchecked (source). `stage_source` copied any path. Now: plain-id check + existence, receive folder confined to `in/`, and every command that opens a UI source (`import_document`, `stage_pdf`, `stage_photo`, `stage_source`, `pack_kind`, `pack_import`) opens only one a picker or "Open with" handed out (debug / `measure` builds also read files directly in `cache/dev-inbox`). | `save.rs` › `discarding_refuses_an_id_that_is_a_path`; `transfer.rs` › `a_receive_folder_never_leaves_the_transfer_store`; `picker.rs` › `only_granted_sources_are_known_and_the_oldest_go_first`; `source_tests.rs` (each command on Tauri's mock runtime: a foreign path refused, the picked one accepted; dev-inbox escapes refused) | `79704e5`, `8ecf229`, `a68c1b8` |
| 8 qpdf pre-check loops to trailer /Size | **Confirmed**: a 70 KB file with /Size 4294967295 ran > 100 s (killed) before the fix; now < 5 s, and the large stream is still found. | `ops.rs` › `a_huge_declared_trailer_size_does_not_stall_the_stream_check` | `7c14e1a` |

## Notes

- Second review (code-reviewer subagent, decoders and source checks): MUST-FIX — ASCII85 output cut short after many `z` groups (fail open), fixed in `fc7363e` with mutation-checked tests; the pack flow's theme, fixed in `eb7660d`. SHOULD fixed: partial predictor rows and bad /Predictor parameters refused, per-stream decode limit, test directories kept in the temp dir. Open (NIT): `pick_*` granting is covered by Maestro, not by unit tests; dev-inbox has a check-then-open window (debug / `measure` builds only).
- Independent review (code-reviewer subagent): no MUST-FIX. Fixed in `472cf05`: only draws
  reached from a page or an appearance count for the fail-closed check (a form only in
  /AcroForm /DR could otherwise legitimise an original); appearances and forms without their own
  /XObject credit the page dictionary; render-equality tests against over-pruning; pack import
  no longer fails after its documents are in when settings cannot be read. Open (NIT): annotations
  never on a page (popups left out of /Annots) are detached too. (Forms in
  [/ASCII85Decode /FlateDecode] are now decoded, `11a0d45`.)
- Pre-existing, not changed here: when PDFium regenerates a marked page it rebuilds that page's
  resource dictionary with its own names, so a form, appearance or Type 3 glyph on the *marked*
  page that relied on the page's resources renders blank (measured with the pruning switched off).

- PDFium writes a metadata stream without its /Filter and keeps the encoded data (measured), so
  encoded XMP always arrives unreadable and is dropped; plain XMP that names no redacted word
  is kept.
- Oracle for leads 1–3 and 6: `qpdf --qdf --object-streams=disable --decode-level=specialized`
  (`generalized` leaves RunLength encoded)
  on the saved file; the needle (original samples, uncut path, marker text) must not appear as
  bytes or hex digits; positive control on the input first; pdf.js renders the box.
- Lead 5 behaviour change: a library move from a device that is not saved no longer brings its
  signatures (ADR 0014 update). Save the old device first, then move.
- Device tests: see HANDBACK.md (Tier 2 on the AVD `selis-midrange-api36`, debug build of
  1.0.0-rc.6).
