# Changelog

All notable changes to Selis are documented here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (ADR 0020: `X.Y.Z` and `X.Y.Z-rc.N`).
The store "What's new" texts (`fastlane/metadata/android/*/changelogs/<versionCode>.txt`) are
short summaries of these sections.

## [Unreleased]

### Changed

- The line under the Transfer screen reads "No account, no cloud storage" instead of "no
  cloud": a transfer between two devices can pass through an encrypted relay. The store and
  website texts say the same ("Your library stays on your phone").

## [1.0.0-rc.6] - 2026-11-08

Sixth release candidate: redaction fixes, and transfers and packs ask before they change
anything. Everyone who redacted documents with rc.1–rc.5 should redact them again with this
version (see Security).

### Changed

- Receiving through a link or QR code first shows which device is sending and starts only after
  "Receive". Settings that come with a library move or a .selispack file are listed and applied
  only after "Apply"; if they would delete older versions of your documents, the app asks a
  second time and says how many. Saved signatures now come along only from one of your saved
  devices.

### Fixed

- Opening a damaged PDF that claims an enormous number of objects no longer keeps the app busy
  for minutes before a compress, optimise or repair.

### Security

Affected: 1.0.0-rc.1 to 1.0.0-rc.5. Fixed in this version.

- Redaction now removes hidden copies of what you redacted, not only what the page shows:
  - images and drawings under the black box that were still stored in the file, for example
    when the same picture was also used on another page;
  - page thumbnails and private data that other apps had saved with the page;
  - attachments and the document's description (metadata) that mention a redacted word,
    including copies stored in less common encodings;
  - notes that were removed but still reachable through their replies or pop-ups.
  Erase page content got the same fixes.
- Redaction and erase now refuse to save when they cannot prove that the result is clean (for
  example a part of the file in an encoding the app cannot read), and say why. Nothing is
  saved in that case; the earlier version stays as it was.
- Transfers and .selispack files no longer change your settings or start a receive without
  asking (see Changed), and a sender can no longer find out which documents you already have.
- The app checks every file name and document id it receives from its own screens before using
  it, so a file outside the library cannot be read or deleted by mistake.
- Updated the built-in SQLite to 3.54 (RUSTSEC-2026-0459).

## [1.0.0-rc.5] - 2026-11-04

Fifth release candidate. Convert Word, Excel, CSV, text and Markdown to PDF; export PDF as Word,
text or images. Security: safer handling of damaged .selispack files.

### Added

- File conversion (ADR 0035). "Convert to PDF" in the library (and "Open with" / "Share" from
  other apps) turns Word (.docx), Excel (.xlsx), CSV, text, Markdown and HTML files into a PDF
  on the device. The file is laid out as HTML that loads and runs nothing, then printed by the
  Android WebView without a print dialog. A preview notes that the layout may differ from
  Word/Excel; Save adds the PDF as a new document, and the original is only read. Android
  only for now.
- Viewer ⋮ → Export:
  - an editable Word file: text, headings, bold and italic, pictures in place, a page break
    per page; scanned pages are read by OCR first;
  - text or Markdown;
  - every page as a PNG or JPEG image in one ZIP.

### Security

- Safer handling of damaged .selispack files: a pack whose ZIP local headers disagree with its
  central directory is refused as damaged, and nothing is added to the library (zip 9.0.5,
  GHSA-m665-v7pm-7grj; ADR 0012 amendment).

## [1.0.0-rc.4] - 2026-10-28

Fourth release candidate: sharper text at every zoom level.

### Fixed

- Sharper text at every zoom level. Pages were drawn at a per-device scale cap (as low as 1.25
  pixels per CSS pixel on 3 GB phones, so 42–48 % of the screen's resolution) and upscaled.
  They are now drawn at CSS size × devicePixelRatio on whole device pixels; a page too large
  for one bitmap keeps a quick base image and gets full-resolution tiles over what is on
  screen, replacing the base within 300 ms of a zoom or scroll ending (ADR 0002 amendment).

### Security

- ctutils 0.4.4 (RUSTSEC-2026-0385): constant-time masks and `u128` comparisons in the crypto
  utilities could compile to branches on secret values.

## [1.0.0-rc.3] - 2026-10-21

Third release candidate: Erase page content, and redaction fixes.

### Added

- Erase page content (ADR 0033): a new "Erase" tool in the annotate dock, separate from the
  annotation eraser. Brush (three sizes) or rectangle over anything on the page, preview and
  undo per stroke, then Apply: the text, the image pixels and the parts of drawings under the
  area are removed from the file, and the area is filled white, with the background colour
  around it, or with a colour picked from the page. "Object" mode deletes one image, text run
  or drawing (a long press steps through overlapping ones). Every apply is a new version
  labelled "erase"; the earlier versions are kept. A signed document warns once that erasing
  invalidates the signature.

### Fixed

- Redaction no longer changes other pages: an image or form drawn on several pages (a logo, a
  letterhead), or twice on one page, is copied before the redaction changes it, so only the
  redacted area loses it (ADR 0009 amendment). A second erase on a page could reuse the name an
  earlier one gave a copied image or form and draw the wrong one; names are now always new.
- Rotated pages (/Rotate 90, 180, 270): text selection, "copy text" and the accessibility layer
  sat beside the words; the engine now reads text and glyph boxes itself and maps them as the
  page is shown, for every feature (ADR 0034). Night mode no longer inverts images on rotated or
  cropped pages.
- Redaction removes everything under the box, not only text and image pixels. Vector drawings
  are cut. Shadings, pattern fills, soft-masked content and masked images are replaced by a
  raster of themselves with the redacted area left empty. PDFium's own redaction had left them
  whole under the black box (ADR 0009 update).
- Erase also clears the annotations over the area: ink and highlights are cut to fit, notes,
  stamps, shapes and form fields there are removed. The toast says how many, and the version
  keeps a note of it (ADR 0033 update).

### Changed

- English first for new strings (ADR 0030 amendment): Greek is completed in a translation pass
  before each release candidate; until then a string not translated yet shows in English.
- Translation pass for 1.0.0-rc.3: the Erase tool is in Greek.

### Security

- rustls-webpki 0.103.16 and webpki-roots 1.0.10 (RUSTSEC-2026-0382, RUSTSEC-2026-0381:
  certificate verification could accept distrusted intermediates). Used by Transfer's relay
  connections.

## [1.0.0-rc.2] - 2026-10-19

Second release candidate: Scan 2.0.

### Added

- Scan 2.0 (ADR 0032): automatic capture when the page is steady and sharp (progress ring,
  haptic, "Auto" switch, on by default; the shutter always works), hints "Hold steady",
  "Move closer", "More light needed" (turns the flash on); an Enhance filter, the new default,
  that removes shadows and uneven light in colour; batch review — open a page to change its
  corners or filter, rotate it, touch up a mark, retake or delete it, drag pages to reorder;
  ID card mode: front and back on one A4 page at 85.6 × 54 mm. In a batch, a confident automatic
  capture is kept straight away ("Page N added"), without the Adjust step.

### Changed

- The scan camera's header keeps its text clear of the screen edges on narrow phones (360 dp)
  in English and Greek; the page count appears with the first page.

## [1.0.0-rc.1] - 2026-10-16

First release candidate of the mobile 1.0 (Android, iOS). Desktop builds come with 1.0 of the
desktop shell (P6).

### Added

- Library: import from the file picker, "Open with" and share; grid and list, sort, title
  search, favorites, tags, recents, thumbnails; rename and delete. Imports are copies — the
  original file is never written.
- Viewer: virtualised scroll for documents of 1000+ pages, pinch and double-tap zoom,
  thumbnails, outline, full-text search, text selection and copy, rotate view, night mode.
- Annotate: highlight, underline, strike-through, pen, shapes, text, sticky notes, eraser,
  undo/redo. Every save is a new version; autosave and crash recovery of the working copy.
- Forms and signatures: fill AcroForm fields, flatten; visual signatures (draw, type, picture),
  saved for reuse.
- Pages: reorder by drag, rotate, duplicate, delete, insert blank or from another PDF (form
  fields stay fillable), extract, split.
- Redaction: content under a box is removed from the file, not covered; whiteout with new text;
  delete earlier versions that still hold the redacted text.
- Transfer between devices without an account (iroh): QR code or link, 6-digit confirmation
  code, end-to-end encrypted, resumes after a drop; trusted devices; move the whole library;
  "Local network only" and a custom relay in Settings.
- `.selispack` files: export documents or the whole library to one file, optionally protected
  with a passphrase (Argon2id + XChaCha20-Poly1305), and import them.
- Tools (qpdf): protect with a password, remove a password, compress, optimise for the web,
  repair.
- Images to PDF (system photo picker, photo metadata removed) and save a page as PNG or JPEG.
- Document scan with the camera: page edge detection, perspective correction, filters, several
  pages into one PDF.
- Text recognition (OCR, Greek and English, on the device) makes scanned pages searchable.
- Settings: theme (light, dark, sepia), language (English, Greek), app lock, version retention.

### Security

- No network at startup; the network is used only while the Transfer screen is open (or a
  transfer you started is running).
- No analytics, crash reporting, advertising or account; nothing is collected
  ([PRIVACY.md](docs/PRIVACY.md)).

[Unreleased]: https://github.com/Fiouri/selis/compare/v1.0.0-rc.6...HEAD
[1.0.0-rc.6]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.6
[1.0.0-rc.5]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.1
