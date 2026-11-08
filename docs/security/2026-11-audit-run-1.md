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
| 3 Undecodable streams treated as clean | **Confirmed**: a form under the area in [/ASCIIHexDecode /FlateDecode] was saved uncut (PDFium keeps the filter chain); an attachment in [/ASCII85Decode /FlateDecode] naming a redacted word was kept. XMP under /ASCIIHexDecode: **confirmed** in another form — PDFium drops the filter and keeps the hex digits, so the words survived hex-encoded. Now fail closed (`unchecked`: nothing saved, the toast says why); unreadable XMP is dropped. | `residue.node.test.ts` › "L3: …" (5 cases) | `cad3a2a` |
| 4 .selispack applies foreign settings (retention prune, relay) | **Confirmed** in source (`pack_import` → `apply_patch` → `apply_retention`, no prompt). Settings are now only described; a sheet lists every change, history-deleting retention needs a second confirmation with the count. | `settings.rs` › `foreign_settings_change_nothing_and_count_what_retention_would_delete`; `retention.rs` › `a_preview_counts_what_would_go_and_removes_nothing`; `ForeignSettingsSheet.test.tsx` | `85a8d99` |
| 5 Transfer sender gets move powers; deep link auto-receive; membership oracle | **Confirmed**: the old move test asserted that a *ticket* receive skipped a blob the receiver had (the oracle); `track_receive` applied sender settings and signatures; a link started a receive without a tap. Now: a prompt with the sender before anything connects; settings via the same confirmation as packs; signatures only from a saved device; dedupe only for a trusted push. | `selis-transfer` › `a_ticket_receive_fetches_every_blob_even_one_the_receiver_has`, `a_trusted_push_skips_what_the_receiver_has`; `transferStore.test.ts` (link asks first, decline, expired); `transfer.spec.ts` (deep link prompt, decline) | `85a8d99` |
| 6 Erase leaves inline images to PDFium | **Rejected**: PDFium turns the inline image into an image XObject with the area blanked and keeps the rest (measured; the right half still renders). Kept as a regression test. | `residue.node.test.ts` › "L6: …" | — (test in `cad3a2a`) |
| 7 IPC ids/sources become paths | **Confirmed** for `discard_working_copy` (`../library/<blake3>` unlinked a version file in the test with the check disabled). `transfer_cancel_receive` joined the id under `in/` unchecked (source). `stage_source` copied any path. Now: plain-id check + existence, receive folder confined to `in/`, `stage_source` only for sources a picker or "Open with" handed out. | `save.rs` › `discarding_refuses_an_id_that_is_a_path`; `transfer.rs` › `a_receive_folder_never_leaves_the_transfer_store`; `picker.rs` › `only_granted_sources_are_known_and_the_oldest_go_first` | `79704e5` |
| 8 qpdf pre-check loops to trailer /Size | **Confirmed**: a 70 KB file with /Size 4294967295 ran > 100 s (killed) before the fix; now < 5 s, and the large stream is still found. | `ops.rs` › `a_huge_declared_trailer_size_does_not_stall_the_stream_check` | `7c14e1a` |

## Notes

- Independent review (code-reviewer subagent): no MUST-FIX. Fixed in `472cf05`: only draws
  reached from a page or an appearance count for the fail-closed check (a form only in
  /AcroForm /DR could otherwise legitimise an original); appearances and forms without their own
  /XObject credit the page dictionary; render-equality tests against over-pruning; pack import
  no longer fails after its documents are in when settings cannot be read. Open (NIT): forms
  in [/ASCII85Decode /FlateDecode] are refused rather than decoded; annotations never on a page
  (popups left out of /Annots) are detached too.
- Pre-existing, not changed here: when PDFium regenerates a marked page it rebuilds that page's
  resource dictionary with its own names, so a form, appearance or Type 3 glyph on the *marked*
  page that relied on the page's resources renders blank (measured with the pruning switched off).

- Oracle for leads 1–3 and 6: `qpdf --qdf --object-streams=disable --decode-level=generalized`
  on the saved file; the needle (original samples, uncut path, marker text) must not appear as
  bytes or hex digits; positive control on the input first; pdf.js renders the box.
- Lead 5 behaviour change: a library move from a device that is not saved no longer brings its
  signatures (ADR 0014 update). Save the old device first, then move.
- Lead 7 scope: `import_document`, `stage_pdf`, `stage_photo`, `pack_kind` and `pack_import`
  still accept any source from the UI (they need a PDF/image/pack header and do not expose the
  bytes to script); binding them to granted sources is a follow-up.
- Device tests (Maestro `transfer*.yaml`, now with the prompt tap) were not run in this session.
