# DRAFT: GitHub Security Advisory (not filed)

> Draft only. Not submitted, not published. The owner reviews it and files it in the
> repository's Security tab when 1.0.0-rc.6 is released.

**Title:** Redaction could leave the redacted content in the saved PDF

**Package / ecosystem:** Selis (Android app; GitHub releases and store test tracks)

**Affected versions:** `<= 1.0.0-rc.5` (1.0.0-rc.1 through 1.0.0-rc.5)

**Patched versions:** `1.0.0-rc.6`

**Severity (proposed):** High. Confidentiality: information the user meant to remove can be
recovered from a file they believe is safe to share. No remote trigger, no code execution.

**CWE (proposed):** CWE-212 (Improper Removal of Sensitive Information Before Storage or
Transfer).

## Summary

Selis' redaction blacked out the marked area on the page and removed the text under it, but in
some documents a copy of the redacted content stayed in the saved file where the page no longer
showed it. Anyone with the redacted file and a PDF inspection tool could recover it. Erase page
content (rc.3 onwards) had the same gaps.

## Impact

A redacted PDF from an affected version could still contain:

- the original, unredacted image or drawing under the box, when the page shared its resources
  with another page, inherited them from the page tree, or drew a form whose copy was not
  rewritten;
- the page thumbnail and private application data (`/Thumb`, `/PieceInfo`) showing the page
  before redaction;
- an attachment that names a redacted word, when it was also listed in the document's
  associated files (`/AF`), or when it was stored in an encoding the redaction did not read;
- the document description (XMP metadata) naming a redacted word when stored hex-encoded;
- a removed note, still reachable through its pop-up, a reply or the structure tree.

Files redacted with an affected version and already shared cannot be fixed by the update.

The same release also hardens related areas found in the same internal audit (no known
exploitation): a transfer link started a receive without asking and the sender's settings and
signatures were applied without confirmation; a .selispack file applied its settings
(including version retention, which can delete older versions) without confirmation; a
transfer sender could learn which documents the receiver already had; some app commands
accepted file names and ids from the app's own screens without checking them; a damaged PDF
could keep the app busy for minutes.

## Patches

1.0.0-rc.6 removes every object the redacted area used that no page still draws, rewrites
shared and inherited resources, drops thumbnails, private data and image alternates, filters
associated files, detaches removed notes, and decodes Flate, LZW, ASCII85, ASCIIHex and
RunLength streams (alone or chained) to check them. When the app cannot decode part of the
file or cannot prove the result clean, it refuses to save and tells the user why; nothing is
written. Every fix has a regression test that checks the saved file with qpdf, decoding every
stream, for the redacted bytes.

## Workarounds

- Update to 1.0.0-rc.6 and **redact the original document again**; share the new file and
  delete copies made with an earlier version.
- Until then, do not share PDFs redacted with Selis rc.1 to rc.5 when the redacted content is
  sensitive, or check them with an independent tool before sharing.

## Credits

Found by an internal security audit of the project (run 1, November 2026).

## References

- CHANGELOG.md, section 1.0.0-rc.6 (Security).
- docs/security/2026-11-audit-run-1.md (status of each finding; private-safe, no exploit steps).
