# ADR 0009 — True redaction: PDFium apply, plus annotations and form values

- Status: accepted
- Date: 2026-10-11

## Context

P2d asks for true redaction: the content under a mark must be gone from the saved file (extracted
text no longer contains it), not merely covered, with a confirm dialog because it cannot be undone
in the saved version. Also whiteout with new text over it.

EmbedPDF 2.15.1 ships PDFium's redaction (`/Redact` annotations, `applyAllRedactions` →
`EPDFPage_ApplyRedactions`). Measured on the fixtures:

- Text under a mark is removed from the page content (no longer extracted), image pixels under it
  are blanked (the rest of the image is kept), and the mark's interior color is painted. ✓
- **Annotations are left alone**: a sticky note over the area keeps its `/Contents`; a text field
  keeps its `/V` and its appearance stream ("Ada Lovelace" survived). A Selis typed-text stamp
  would keep its text too.
- **Removing a widget makes PDFium drop a field value set in the same session**: set `/V` to "",
  remove the widget, save → `/V` is "Ada Lovelace" again. Set without removing → "".
- Overlay text (`/OverlayText`) is drawn by PDFium in a standard-14 font: no Greek (as ADR 0007).

## Decision

- Marks are standard `/Redact` annotations (black or white `/IC`, red border, replacement text in
  `/Contents`) placed with undo / redo in a dedicated mode (⋮ → "Απόκρυψη περιεχομένου"):
  text (follows the selected lines), area (box), whiteout (box + text), eraser.
- Applying (`redact.ts`, worker) runs on a scratch copy in two passes with a save between them:
  1. empty every form field whose widget meets a mark (text "", checkbox / radio off, choice
     unselected);
  2. remove every other annotation that meets a mark (notes, stamps, signatures, links, widgets),
     `applyAllRedactions` per page, then write each whiteout's text as a Selis text stamp in the
     embedded Latin + Greek font, sized to the box.
  The worker swaps the open document for the result (like page operations, ADR 0008); undo reloads
  the bytes from before while the document is open. The confirm dialog says the content leaves the
  new version for good and that earlier versions stay in the history (originals are never
  overwritten, so "share the new one" is the honest advice).
- **Marks never reach a saved version unapplied.** Leaving the mode (Done, ×, system back) with
  marks pending removes them first (one undoable command, a toast says so), then the session
  commits. A black box over content that is still there would look redacted and is not.

## Consequences

- Verified on the produced file with an **independent reader** (`@selis/fixtures/oracle`: pdf.js
  6.4 + its Node canvas, test-only; not an engine, so ADR 0002 stands): pdf.js no longer extracts the
  redacted lines and still extracts the rest; the redacted strings are nowhere in the bytes, raw or
  with every Flate stream inflated, neither as text (UTF-8 / UTF-16BE) nor as the glyph codes the
  content stream drew them with (positive control before applying); only the whiteout's text stamp
  is left as an annotation, within ±2 pt of its mark; pdf.js renders each black box within ±2 pt of
  its mark on the right page, the whiteout's line blank and its neighbours untouched. Marks in the
  tests are placed from the fixture's line geometry (pdf.js), and each is asserted to cover its own
  line and no other. The same oracle reads the version saved through the UI (Playwright: the boxes
  drawn on screen land within ±2 pt in the file) and the version pulled off the device (Maestro
  `redact.sh check` → `redact-check.ts`: each box covers its line and meets neither neighbour).
- 2026-10-12 — the P2d sample `redacted-greek.pdf` was described as removing the "σύννεφο" /
  "ψυχοφθόρα" lines but its generator hard-coded a whiteout box on body line 1 (and no black box on
  page 1); the redaction itself was correct (line 1 left the content stream, 31 → 29 text objects,
  the stamp exactly over it). The tests then derived the "removed" line from the result, so they
  could not catch a mark on the wrong line. Fixed by the geometry-placed marks above; the samples are
  now written by the very tests that check them (`SELIS_SAMPLES=<dir>`).
- A field met by a mark loses its widget and value but keeps its (empty) entry in `/AcroForm
  /Fields`; its name stays (structure), its tooltip goes when it names a redacted word (below).

## Update 2026-10-12 — the rest of the document, and earlier versions

- **Redacted words leave the whole file, not only the page.** While applying, the worker collects
  what goes: the page text under each mark (PDFium `FPDFText_GetBoundedText`), the emptied field
  values and the removed annotations' text. After PDFium's pass, `sanitize.ts` takes those words out
  of everything else: Info entries and XMP metadata (dropped), outline titles ("█████"), named
  destinations, document JavaScript, embedded files (by name, description or content), page-label
  prefixes, JavaScript actions (open, page, field and annotation actions), form field values,
  defaults, tooltips and option labels (with their appearances, `NeedAppearances` set), other
  annotations whose text or drawn appearance names one (removed; author / subject keys dropped), and
  structure-tree `/Alt`, `/ActualText`, `/E`, `/T`; any other text string left that names one
  becomes empty. Identifiers (`/NM`, `/ID`) are not text. The whiteout stamps just written are kept
  as the user typed them.
- A string "names" a redacted term when one of the term's words (3+ letters or digits, not a short
  common word, Greek or English) appears in it as a whole word, ignoring case and accents. This
  over-matches on purpose (a note elsewhere that shares a redacted word goes too): removing too much
  from a new version beats leaving a trace.
- **Full rewrite only.** `pdf-objects.ts` (a small object reader / writer: classic and stream
  cross-references, object streams, Flate + PNG predictors) writes the result as one fresh file:
  one body, one cross-reference table, no `/Prev`, only the objects still reachable from the
  catalog and Info. Older revisions and unused objects (which may hold removed content) do not
  survive. pdf-lib and qpdf stay out of the app (ADR 0002 / CLAUDE.md); qpdf checks the result in
  tests.
- A document with a security handler (an owner password; one with a user password does not open
  in Selis yet) is written without it when redacted: its strings must be readable to be checked.
  The new version keeps the content readable to anyone, as before; only the owner's permission
  flags are gone.
- **Earlier versions.** The new version is clean, but the history (the imported original
  included) still holds the removed content. After a redacted version is saved, a sheet says so and
  offers "Delete earlier versions" (`delete_earlier_versions`: every version but the current one,
  v1 included, and their files once unreferenced; a linked document's external file never) or
  "Keep them". The confirm dialog says this is coming.
- Verified (sanitize.node.test.ts): a document that names the redacted line's words in every one of
  those places, with an unrelated neighbour next to each, is checked with pdf.js (metadata, XMP,
  outline, destinations, attachments, scripts, labels, widgets, notes), a raw + inflated byte search
  (no trace, positive control first) and `qpdf --check`; the neighbours stay. Every P2 sample
  (annotations, forms, pages, redaction) passes `qpdf --check` and renders in pdf.js in the unit
  tests; CI installs qpdf.
- Partial glyph overlap: PDFium removes whole text objects / glyphs that meet the quads, so a mark
  that clips a line removes those glyphs entirely (safer than keeping them).

## Update 2026-10-12 (P2 follow-ups)

- **The confirm dialog lists the side effects before anything happens.** The worker runs the whole
  redaction on a scratch copy (`redactionPreview`) and reports:
  - the notes elsewhere that go because they share a redacted word (quoted, up to three);
  - whether an owner password and its permissions will be dropped.

  For a linked document, the dialog also says that the original outside Selis still contains the
  text. The list is what applying will do, because it is computed by the same code.
- **Fields left without a widget leave `/AcroForm /Fields`.** A field whose only widget was under a
  mark was kept with its name and tooltip; now it goes (and so do widget kids that are on no page).
- **Deleting earlier versions** asks for an explicit destructive confirm first. Rows go in one
  transaction, and files are removed only after the commit. Only library-owned files are removed:
  a linked document's external file never is (unit test). When the library opens, a sweep removes
  any file in the library-owned folders that no row refers to: what a crash between the commit and
  the file removals would leave behind.

## Update 2026-10-20 (shared images and forms: copy-on-write)

- **Problem (data loss, found in P7b, ADR 0033).** PDFium's `EPDFPage_ApplyRedactions` blanks
  image pixels in the image data and rewrites form XObject content in place. An image or form
  drawn on several pages (a logo, a letterhead) or several times on one page lost its content
  everywhere it was drawn, not only under the mark.
- **Decision.** Between the two passes, every image or form XObject drawn over a mark gets its own
  copy under a fresh name (`/SelisE<n>`, a name the resource dictionary does not use yet), with
  the `Do` operand rewritten and the page (and each copied form) given resource dictionaries of
  its own (`unshare.ts`, the same step as the Erase tool's). PDFium then changes only the copies;
  the full rewrite keeps the original wherever it is still drawn. A content stream that cannot be
  rewritten (an encoding other than Flate or none) makes the redaction fail with an error rather
  than change other pages.
- **Verified** (`redact.node.test.ts`, fixture `shared-xobjects`: a logo image and a form on three
  pages, the logo twice on page 2): redacting the logo on page 2 leaves pages 1 and 3
  byte-identical when rendered (PDFium raster and pdf.js raster) and the second logo on page 2
  unchanged; the same for the form, whose text pdf.js still extracts on pages 1 and 3 and no
  longer on page 2. Without the step both tests fail.

## Update 2026-10-20 (redaction on the content-erase path; flattening)

- **Measured.** `EPDFPage_ApplyRedactions` keeps four kinds of content whole under its box. On
  the `redact-flatten` fixture these were:
  - a plain filled path;
  - an axial shading (`sh`);
  - a rect filled with a tiling pattern whose cell holds text;
  - a rect painted under an ExtGState soft mask.

  It only blanks the pixels of a soft-masked image, so the image's soft mask keeps its shape.
  "Removes the paths" above was wrong for this PDFium build: a vector drawing under a black box
  stayed in the file.
- **Decision.** Redaction now runs on the Erase tool's path (ADR 0033), step by step:
  1. Fields under the marks are emptied, as before.
  2. Shared XObjects are copied (copy-on-write, above).
  3. PDFium removes the covered annotations and the marks themselves.
     `EPDFText_RedactInQuads` (`recurseForms`) removes the glyphs and blanks the image pixels.
     The whiteout stamps are written.
  4. The content stream is rewritten:
     - **Paths** are cut geometrically.
     - **Everything that cannot be cut and meets a mark** is flattened (`flatten.ts`): a
       shading, a path painted with a pattern, anything painted under a soft mask, an image with
       a soft or stencil mask, an inline image. Each object is rendered on its own (every other
       painting operator turned into `n` or dropped, so clips, transforms and state are kept) to
       a transparent raster of its page box, at up to 3 px/pt. The redacted area is cleared to
       transparent black in the raster. The raster goes back where the object was, as an image
       with a soft mask, under a graphics state that resets the soft mask, alpha and blend mode.
     - **The boxes** are painted last, black or white as each mark says (after a
       `%SelisFill` comment).
  5. Sanitising and the full rewrite run as before.
- **Not touched.** A pattern cell, shading function or soft-mask group that other content still
  uses stays in the file. Only what was drawn under the box is gone, and that object's drawing
  elsewhere is now a raster. An ExtGState soft mask is no longer applied to the flattened object,
  because the raster already has it.
- **Version note.** The version saved after a redaction carries a note in `versions.note`
  (schema 9): `{"annotationsRemoved":n,"annotationsClipped":0}` when annotations over the marks
  were removed. A redaction removes them whole; it does not clip them.
- **Verified** (`redact.node.test.ts`):
  - The four objects are flattened.
  - With the boxes taken out of the result (everything after `%SelisFill`), every pixel of the
    area (1 pt inset) is white in pdf.js and in PDFium. Control: the fixture draws > 10 000 pixels
    there, and without flattening 23 716 remain.
  - pdf.js and PDFium find no text there.
  - Each object still shows outside the area (≤ 24/255 per channel at a sample point).
  - Every earlier redaction test passes unchanged: black boxes ±2 pt, whiteout text, form values,
    glyph codes gone from the bytes, qpdf.

## Update 2026-11-08 (residue: what the full rewrite still reached)

- **Problem (security audit run-1, leads 1–3).** The full rewrite keeps every object still
  reachable, and un-sharing only renamed the draw: the unredacted original stayed listed in a
  resource dictionary nothing drew from any more (one shared with an unmarked page, one
  inherited from the /Pages node, the page's own copy when PDFium did not regenerate the page).
  A page's /Thumb and /PieceInfo, an attachment also listed in an /AF array, and a removed
  annotation still pointed at by its popup, a reply's /IRT or a structure-tree OBJR survived the
  same way. A form XObject in an encoding the reader cannot decode was copied but never cut, and
  an attachment, script or annotation stream it could not decode counted as "names no redacted
  word".
- **Decision** (`residue.ts`, the last step of `rewritePages`, and `sanitize.ts`):
  - XObject names that no content stream draws leave every resource dictionary whose users can
    all be checked (pages, /Pages nodes, forms, tiling patterns, Type 3 fonts; forms, soft-mask
    groups and patterns without resources of their own count for the dictionary they draw from).
  - **Fail closed:** an un-shared original that is still reachable and that nothing checked draws
    stops the redaction (`UncheckedContentError`, engine error code `unchecked`; the toast says
    nothing was saved and why). So does a form under a mark that cannot be decoded, and an
    attachment, script or annotation stream that cannot be decoded while there are words to look
    for. XMP that cannot be read as XML is dropped (PDFium can drop an /ASCIIHexDecode filter and
    keep the hex digits as the data, measured).
  - Pages under a mark lose /Thumb and /PieceInfo; XObject copies lose /Alternates, /OPI,
    /PieceInfo and /Thumb; an attachment that names a redacted word leaves every /AF array too;
    annotations on no page lose every reference to them (popups with a removed parent go).
- **Verified** (`residue.node.test.ts`, generated fixtures and the `greek` fixture): qpdf decodes
  the whole result (`--qdf --object-streams=disable`, generalized filters) and none of the
  original image samples, uncut form paths, thumbnail, private data, attachment, appearance
  stream or note text is anywhere in it, as bytes or hex digits (positive control on the input
  first); the page renders the box. The same holds for erase (ADR 0033).
