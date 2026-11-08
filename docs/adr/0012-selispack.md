# ADR 0012 — `.selispack`: offline move with an optional passphrase (P3c)

- Status: accepted
- Date: 2026-10-12
- Builds on: ADR 0014 (what a library move carries)

## Context

Without any network (or when the user prefers a file), documents and the whole library must
travel as one file through USB, e-mail or any cloud the user picks, optionally encrypted with a
passphrase, and come back through "Open with" or the picker. The file comes from outside, so
reading it must be strict, bounded and fail closed.

## Decision

### Format (version 1)

```text
file    = "SELISPK\0" (8) | version u8 = 1 | mode u8 | body
mode 0  = body is a ZIP
mode 1  = Argon2id m_kib u32 BE | t u32 BE | p u32 BE | salt [16] | nonce [19] | STREAM
STREAM  = XChaCha20-Poly1305, STREAM-BE32 (Rogaway et al.; RustCrypto aead-stream)
          key = Argon2id(passphrase, salt, m, t, p) → 32 bytes
          segment 0: "SELISPK-KEYCHECK" (16 bytes) — a wrong passphrase is told apart from damage
          segments 1..n: the ZIP in 64 KiB pieces; the final one carries STREAM's "last" flag
          associated data of every segment: the whole header (any header change fails)
ZIP     = manifest.json | docs/<blake3>.pdf … | signatures/<id>.png …   (stored, no compression)
```

`manifest.json` (`format: "selispack"`, `version: 1`, `createdAt`): documents with title, file
(BLAKE3, size), history (older versions, oldest first), tags and favorite; for a whole-library
pack also signatures (id, kind, BLAKE3, size) and settings (the stored map; never the device key).

### Passphrase

Argon2id **m = 64 MiB, t = 3, p = 1** for new packs (about a second on a mid-range phone; above
OWASP's minimum of 19 MiB / t = 2). The parameters are in the header; opening accepts at most
256 MiB, t ≤ 10, p ≤ 4 (a hostile header cannot exhaust a phone). Passphrases have at least 8
characters; they are never stored. No passphrase recovery exists — the UI says so.

### Reading (fail closed)

- Only the three name forms above, each exactly once, all named by the manifest (no `..`, no
  absolute paths — zip-slip impossible); entries must be **stored** (no decompression: no zip
  bomb); counts and sizes capped (20 000 entries, 10 000 documents, 4 MiB manifest).
- Every file is streamed to a staging folder while its BLAKE3 and size are checked.
- Encrypted: the key check fails → "wrong passphrase"; any later segment failing, a missing
  final segment (truncation) or a changed header → "damaged".
- Nothing is added to the library until the whole pack has checked out; then documents are
  imported as received (dedupe by BLAKE3, history, tags, favorites), signatures by id, settings
  through the normal validation. Importing the same pack twice adds nothing.

### Writing

The ZIP is written to a temporary file next to the pack, encrypted (or copied after the plain
header) into `<name>.part`, fsynced and renamed: an interrupted export never leaves a pack that
looks complete. Files are streamed, never held in memory.

### Platforms

- Android: share sheet (`SharePlugin`, MIME `application/vnd.anywecon.selispack`, file in the
  FileProvider share folder, deleted at the next app start and before every export — see the
  amendment below); "Open with" intent filters for that MIME (VIEW,
  SEND) and for `application/octet-stream` (VIEW only: file managers label an unknown extension
  that way); the picker for any file. In every case the magic bytes decide — a non-pack from
  the octet-stream filter goes to the PDF import and fails there as "not a PDF".
- Desktop: the save dialog instead of a share sheet; the cache copy is removed after saving.
- Import reads a private copy in the app cache (a content URI cannot seek), removed afterwards
  with the staging folder, whatever the outcome.
- iOS: `UTExportedTypeDeclarations` `com.anywecon.selis.selispack` (extension `selispack`,
  conforms to `public.data`) and a document type, so Files / Mail offer "Open in Selis".

## Consequences

- Crates: `zip` (stored only, no default features), `argon2`, `chacha20poly1305`, `aead-stream`
  (MIT / Apache-2.0).
- Losing the passphrase loses the pack's contents (by design).
- Fuzzing (`crates/selis-core/fuzz`, CI) covers the header, the KDF parameters, the manifest
  and a full plain import; tests cover round trips, wrong passphrase, truncation, a flipped
  byte in the body and in the header, zip-slip names and compressed entries.
- An import needs free space for about twice the pack (private copy + staging) on top of what
  it adds; a failure for lack of space adds nothing.

## Amendment (2026-10-14): packs do not linger in the Android cache

The share folder used to be swept of files older than a day, so an unencrypted pack (the
library in clear text) could sit in the app cache for a day. Now every `.selispack` there is
deleted when the app starts (private import copies included: nothing is in flight) and before
every export (an import running meanwhile keeps its copy). The receiving app still has until
then to read the file; one that held it open keeps reading after the delete. PRIVACY.md says so.

## Amendment (2026-11-04): local headers must match the central directory

A ZIP names and sizes every entry twice, in its local header and in the central directory, and
readers can trust different ones (GHSA-m665-v7pm-7grj). Import reads through the central
directory only, so a pack whose local headers say something else would have imported while
reading differently in any other tool. Import now calls zip 9.0.5's
`ZipArchive::validate_header_consistency` right after opening the archive: any disagreement,
a duplicate name or overlapping entries is the ordinary "damaged pack" error and nothing is
added. The check is opt-in in the crate, so the version bump alone did not do this.
Packs written by earlier versions pass: their writer gave both headers the same values.

## Update 2026-11-08 (settings need the user's yes)

- **Problem (security audit run-1, lead 4).** A plain pack opened with "Open with" (or picked)
  imported at once and applied its settings through the user's own `apply_patch`, retention
  included: a pack from anyone could set 2 versions per document and prune every document's
  history, or point later transfers at another relay, before the user saw anything.
- **Decision.** `pack_import` no longer applies settings. It returns `ForeignSettings`: only the
  valid values that differ from this device's, and how many versions applying them would delete
  now (`Library::preview_retention`, a dry run of `apply_retention`). The pack result shows a
  sheet listing every change (`ForeignSettingsSheet`); "Apply" sends the patch to
  `update_settings`, "Don't apply" changes nothing. When retention would delete versions, a
  second sheet says how many and needs "Delete N versions and apply".
