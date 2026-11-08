//! Saving edits (docs/SPEC.md "Data model", storage rules).
//!
//! The PDF engine runs in the WebView, so an edited document reaches Rust as
//! bytes, in chunks (`write_upload_chunk`) so that neither side holds a second
//! copy of a large file in one IPC message. A finished upload becomes either:
//!
//! - the document's **working copy** (`commit_working_copy`): the autosave
//!   target, written a few seconds after the last edit. It is not a version; it
//!   exists so that edits survive a crash and can be recovered on the next open.
//! - a **version** (`save_version`): the working copy is hashed (BLAKE3), moved
//!   into the library under its hash and recorded as the next version. The
//!   document then points at it, and retention prunes old versions.
//!
//! Every file lands with temp → fsync → rename. The original (v1, and any
//! file outside the library) is never written to.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::fsutil::{HashedTempFile, rename_durable};
use crate::hash::Blake3Hash;
use crate::library::{Document, FILES_DIR, ImportOutcome, Library, looks_like_pdf, now_ms};
use crate::retention::RetentionPolicy;

/// Working copies and uploads in progress (relative to the library root).
pub(crate) const WORK_DIR: &str = "work";
const UPLOADS_DIR: &str = "work/uploads";
/// PDFs picked to be inserted into a document (read by the WebView, never indexed).
pub(crate) const STAGE_DIR: &str = "work/stage";
/// Largest chunk accepted by `write_upload_chunk`.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// Largest document accepted for saving (offsets travel over IPC as `u32`).
pub const MAX_UPLOAD_BYTES: u64 = u32::MAX as u64;
const MAX_UPLOAD_ID_LEN: usize = 64;
/// Longest note on a version (characters; the database allows 200).
pub const MAX_VERSION_NOTE_LEN: usize = 200;
/// Largest picked image accepted for images → PDF.
pub const MAX_STAGED_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Largest document accepted for conversion to PDF.
pub const MAX_STAGED_SOURCE_BYTES: u64 = 50 * 1024 * 1024;

/// JPEG, PNG, WebP, GIF, HEIF/HEIC/AVIF (ISO BMFF `ftyp`), BMP.
pub(crate) fn looks_like_image(head: &[u8]) -> bool {
    head.starts_with(&[0xff, 0xd8, 0xff])
        || head.starts_with(b"\x89PNG\r\n\x1a\n")
        || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.len() >= 12 && &head[4..8] == b"ftyp")
        || head.starts_with(b"BM")
}

/// How a version came to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum VersionLabel {
    /// Saved by the user (leaving the editor, "Done").
    Manual,
    /// Saved without the user asking (a recovered working copy).
    Auto,
    /// Page content erased with the Erase tool (ADR 0033).
    Erase,
}

impl VersionLabel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
            Self::Erase => "erase",
        }
    }
}

/// Autosaved edits that are not a version yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopy {
    pub document_id: String,
    /// BLAKE3 of the version the edits started from.
    pub base_blake3: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub size_bytes: u64,
    /// Unix epoch milliseconds.
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub saved_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SavedVersion {
    pub document: Document,
    /// Sequence number of the document's current version.
    pub seq: u32,
    /// False when the content was identical to the current version (nothing new stored).
    pub created: bool,
}

impl Library {
    pub(crate) fn prepare_work_dir(&self) -> Result<()> {
        // Uploads and staged files never survive a restart: the WebView that used them is gone.
        for dir in [UPLOADS_DIR, STAGE_DIR] {
            let path = self.root.join(dir);
            if path.exists() {
                std::fs::remove_dir_all(&path).map_err(|e| Error::io(&path, e))?;
            }
            std::fs::create_dir_all(&path).map_err(|e| Error::io(&path, e))?;
        }
        Ok(())
    }

    /// Imports a finished upload (e.g. pages extracted in the UI) as a new
    /// library document, then drops the upload.
    pub fn import_upload(&self, upload_id: &str, title: &str) -> Result<ImportOutcome> {
        let path = self.upload_path(upload_id)?;
        let file = File::open(&path).map_err(|e| Error::io(&path, e))?;
        let outcome = self.import_reader(file, title);
        let _ = std::fs::remove_file(&path);
        outcome
    }

    /// Copies a picked PDF into the stage (to be inserted into a document) and
    /// returns its absolute path (served to the WebView by the asset protocol).
    pub fn stage_reader(&self, reader: impl Read) -> Result<PathBuf> {
        let dir = self.root.join(STAGE_DIR);
        let tmp = HashedTempFile::from_reader(&dir, reader)?;
        if tmp.size_bytes == 0 {
            return Err(Error::EmptyFile);
        }
        if !looks_like_pdf(&tmp.head) {
            return Err(Error::NotPdf);
        }
        let dest = dir.join(format!("{}.pdf", Uuid::now_v7()));
        tmp.persist(&dest)?;
        Ok(dest)
    }

    /// Copies a picked image into the stage (images → PDF, P4b) and returns its absolute path
    /// (read by the WebView through the asset protocol, then `unstage`d). Only the image
    /// formats the app can use are accepted (JPEG, PNG, WebP, GIF, HEIF/HEIC, BMP), up to
    /// `MAX_STAGED_IMAGE_BYTES`.
    pub fn stage_image(&self, reader: impl Read) -> Result<PathBuf> {
        let dir = self.root.join(STAGE_DIR);
        let tmp = HashedTempFile::from_reader(&dir, reader.take(MAX_STAGED_IMAGE_BYTES + 1))?;
        if tmp.size_bytes == 0 {
            return Err(Error::EmptyFile);
        }
        if tmp.size_bytes > MAX_STAGED_IMAGE_BYTES {
            return Err(Error::InvalidArgument("image too large"));
        }
        if !looks_like_image(&tmp.head) {
            return Err(Error::InvalidArgument("not an image"));
        }
        let dest = dir.join(format!("{}.img", Uuid::now_v7()));
        tmp.persist(&dest)?;
        Ok(dest)
    }

    /// Copies a document picked for conversion (ADR 0035: Word, Excel, CSV, text, Markdown,
    /// HTML) into the stage and returns its path (`.src`, read by the WebView through the
    /// asset protocol, then `unstage`d). The UI decides what it is; up to
    /// `MAX_STAGED_SOURCE_BYTES`.
    pub fn stage_document(&self, reader: impl Read) -> Result<PathBuf> {
        let dir = self.root.join(STAGE_DIR);
        let tmp = HashedTempFile::from_reader(&dir, reader.take(MAX_STAGED_SOURCE_BYTES + 1))?;
        if tmp.size_bytes == 0 {
            return Err(Error::EmptyFile);
        }
        if tmp.size_bytes > MAX_STAGED_SOURCE_BYTES {
            return Err(Error::InvalidArgument("document too large to convert"));
        }
        let dest = dir.join(format!("{}.src", Uuid::now_v7()));
        tmp.persist(&dest)?;
        Ok(dest)
    }

    /// Moves a finished upload of converted HTML into the stage and returns it with the
    /// path its PDF should be printed to (both in the stage).
    pub fn stage_conversion(&self, upload_id: &str) -> Result<(PathBuf, PathBuf)> {
        let dir = self.root.join(STAGE_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
        let id = Uuid::now_v7();
        let html = dir.join(format!("{id}.html"));
        self.move_upload(upload_id, &html)?;
        Ok((html, dir.join(format!("{id}.pdf"))))
    }

    /// Whether a printed PDF in the stage is a non-empty PDF.
    pub fn check_staged_pdf(&self, path: &Path) -> Result<()> {
        let mut head = [0u8; 1024];
        let mut file = File::open(path).map_err(|e| Error::io(path, e))?;
        let read = file.read(&mut head).map_err(|e| Error::io(path, e))?;
        if read == 0 {
            return Err(Error::EmptyFile);
        }
        if !looks_like_pdf(&head[..read]) {
            return Err(Error::NotPdf);
        }
        Ok(())
    }

    /// Imports a staged PDF (a saved conversion) as a new document, then removes it.
    pub fn import_staged(&self, path: &str, title: &str) -> Result<ImportOutcome> {
        let staged = self.staged(path, &["pdf"])?;
        let file = File::open(&staged).map_err(|e| Error::io(&staged, e))?;
        let outcome = self.import_reader(file, title);
        let _ = std::fs::remove_file(&staged);
        outcome
    }

    /// `path` if it names a file directly in the stage with one of `extensions`.
    fn staged(&self, path: &str, extensions: &[&str]) -> Result<PathBuf> {
        let path = Path::new(path);
        let dir = self.root.join(STAGE_DIR);
        let inside = path.parent().is_some_and(|p| p == dir)
            && path
                .extension()
                .is_some_and(|e| extensions.iter().any(|x| e == *x));
        if inside {
            Ok(path.to_path_buf())
        } else {
            Err(Error::InvalidArgument("not a staged file"))
        }
    }

    /// Removes a staged file once it has been read. Only files in the stage go. Idempotent.
    pub fn unstage(&self, path: &str) -> Result<()> {
        let path = Path::new(path);
        let dir = self.root.join(STAGE_DIR);
        let inside = path.parent().is_some_and(|p| p == dir)
            && path
                .extension()
                .is_some_and(|e| e == "pdf" || e == "img" || e == "src" || e == "html");
        if !inside {
            return Err(Error::InvalidArgument("not a staged file"));
        }
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::io(path, e)),
        }
    }

    fn upload_path(&self, upload_id: &str) -> Result<PathBuf> {
        if !plain_id(upload_id) {
            return Err(Error::InvalidArgument(
                "upload id must be 1..=64 of [A-Za-z0-9-]",
            ));
        }
        Ok(self
            .root
            .join(UPLOADS_DIR)
            .join(format!("{upload_id}.part")))
    }

    /// The working copy's path. The id comes from the UI: it must be a plain id (UUIDs are made
    /// here), so it names a file in `work/` and nowhere else (no `..`, no absolute path).
    pub(crate) fn working_path(&self, document_id: &str) -> Result<PathBuf> {
        if !plain_id(document_id) {
            return Err(Error::InvalidArgument(
                "document id must be 1..=64 of [A-Za-z0-9-]",
            ));
        }
        Ok(self.root.join(WORK_DIR).join(format!("{document_id}.pdf")))
    }

    /// Writes `bytes` at `offset` of an upload and returns the upload's length.
    ///
    /// Safe to repeat: a chunk that is already there (a retry after a lost
    /// reply) is not written twice. Chunks must arrive in order.
    pub fn write_upload_chunk(&self, upload_id: &str, offset: u64, bytes: &[u8]) -> Result<u64> {
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(Error::InvalidArgument("upload chunk too large"));
        }
        let end = offset
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= MAX_UPLOAD_BYTES)
            .ok_or(Error::InvalidArgument("upload too large"))?;
        let path = self.upload_path(upload_id)?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| Error::io(&path, e))?;
        let len = file.metadata().map_err(|e| Error::io(&path, e))?.len();
        if end <= len {
            return Ok(len);
        }
        if offset > len {
            return Err(Error::Conflict("upload chunk out of order"));
        }
        // offset ≤ len < end: append, overwriting a partly written repeat.
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.write_all(bytes))
            .and_then(|_| file.set_len(end))
            .map_err(|e| Error::io(&path, e))?;
        Ok(end)
    }

    /// Moves a finished upload (e.g. an exported page image) to `dest` (fsync, rename) and
    /// returns its size. The upload is gone afterwards.
    pub fn move_upload(&self, upload_id: &str, dest: &Path) -> Result<u64> {
        let path = self.upload_path(upload_id)?;
        let size = std::fs::metadata(&path)
            .map_err(|e| Error::io(&path, e))?
            .len();
        if size == 0 {
            return Err(Error::EmptyFile);
        }
        rename_durable(&path, dest)?;
        Ok(size)
    }

    /// Drops an upload that will not be committed.
    pub fn abort_upload(&self, upload_id: &str) -> Result<()> {
        let path = self.upload_path(upload_id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::io(&path, e)),
        }
    }

    /// Makes a finished upload the document's working copy (replacing the
    /// previous one). `base_blake3` is the version the edits started from; it
    /// must still be the document's current version.
    pub fn commit_working_copy(
        &self,
        upload_id: &str,
        document_id: &str,
        base_blake3: &str,
        size_bytes: u64,
    ) -> Result<WorkingCopy> {
        let document = self.get_document(document_id)?;
        if document.blake3 != base_blake3 {
            return Err(Error::Conflict("document changed since the edit started"));
        }
        let upload = self.upload_path(upload_id)?;
        let Ok(meta) = std::fs::metadata(&upload) else {
            // Already committed (a retry after a lost reply) or never uploaded.
            return match self.working_copy(document_id)? {
                Some(copy) if copy.size_bytes == size_bytes && copy.base_blake3 == base_blake3 => {
                    Ok(copy)
                }
                _ => Err(Error::NotFound(upload_id.to_owned())),
            };
        };
        if meta.len() != size_bytes {
            return Err(Error::Conflict("upload is incomplete"));
        }
        if !starts_like_pdf(&upload)? {
            return Err(Error::NotPdf);
        }
        let dest = self.working_path(document_id)?;
        rename_durable(&upload, &dest)?;
        let copy = WorkingCopy {
            document_id: document_id.to_owned(),
            base_blake3: base_blake3.to_owned(),
            size_bytes,
            saved_at: now_ms(),
        };
        let size =
            i64::try_from(size_bytes).map_err(|_| Error::InvalidArgument("file too large"))?;
        self.conn().execute(
            "INSERT INTO working_copies (document_id, base_blake3, size_bytes, saved_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (document_id) DO UPDATE
                SET base_blake3 = excluded.base_blake3,
                    size_bytes = excluded.size_bytes,
                    saved_at = excluded.saved_at",
            params![copy.document_id, copy.base_blake3, size, copy.saved_at],
        )?;
        Ok(copy)
    }

    /// The document's unsaved working copy, if one is on disk.
    pub fn working_copy(&self, document_id: &str) -> Result<Option<WorkingCopy>> {
        let row = self
            .conn()
            .query_row(
                "SELECT base_blake3, size_bytes, saved_at FROM working_copies WHERE document_id = ?1",
                [document_id],
                |r| {
                    Ok(WorkingCopy {
                        document_id: document_id.to_owned(),
                        base_blake3: r.get(0)?,
                        size_bytes: u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                        saved_at: r.get(2)?,
                    })
                },
            )
            .optional()?;
        let Some(copy) = row else { return Ok(None) };
        let on_disk = std::fs::metadata(self.working_path(document_id)?)
            .map(|m| m.len() == copy.size_bytes)
            .unwrap_or(false);
        if on_disk {
            return Ok(Some(copy));
        }
        // A row without its file is useless (the file is written before the row).
        self.discard_working_copy(document_id)?;
        Ok(None)
    }

    /// Throws away unsaved edits. Idempotent.
    pub fn discard_working_copy(&self, document_id: &str) -> Result<()> {
        let path = self.working_path(document_id)?;
        self.conn().execute(
            "DELETE FROM working_copies WHERE document_id = ?1",
            [document_id],
        )?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::io(&path, e)),
        }
    }

    /// Turns the working copy into the document's next version, then applies
    /// `retention`. Content identical to the current version is not stored again.
    pub fn save_version(
        &self,
        document_id: &str,
        label: VersionLabel,
        retention: &RetentionPolicy,
    ) -> Result<SavedVersion> {
        self.save_version_with_note(document_id, label, None, retention)
    }

    /// `save_version` with a short note on the new version (at most
    /// [`MAX_VERSION_NOTE_LEN`] characters, no control characters).
    pub fn save_version_with_note(
        &self,
        document_id: &str,
        label: VersionLabel,
        note: Option<&str>,
        retention: &RetentionPolicy,
    ) -> Result<SavedVersion> {
        if let Some(note) = note
            && (note.chars().count() > MAX_VERSION_NOTE_LEN || note.chars().any(char::is_control))
        {
            return Err(Error::InvalidArgument(
                "version note too long or not plain text",
            ));
        }
        let copy = self
            .working_copy(document_id)?
            .ok_or_else(|| Error::NotFound(format!("working copy of {document_id}")))?;
        let working = self.working_path(document_id)?;
        let file = File::open(&working).map_err(|e| Error::io(&working, e))?;
        let hash = Blake3Hash::of_reader(file)
            .map_err(|e| Error::io(&working, e))?
            .to_hex();

        let current = self.get_document(document_id)?;
        if current.blake3 != copy.base_blake3 {
            return Err(Error::Conflict("document changed since the edit started"));
        }
        if hash == current.blake3 {
            self.discard_working_copy(document_id)?;
            let seq = self.current_seq(document_id)?;
            return Ok(SavedVersion {
                document: current,
                seq,
                created: false,
            });
        }

        let location = format!("{FILES_DIR}/{hash}.pdf");
        let dest = self.resolve_location(&location)?;
        if dest.is_file() {
            // Same content already stored (e.g. back to an earlier version): reuse it.
            std::fs::remove_file(&working).map_err(|e| Error::io(&working, e))?;
        } else {
            rename_durable(&working, &dest)?;
        }

        let size =
            i64::try_from(copy.size_bytes).map_err(|_| Error::InvalidArgument("file too large"))?;
        let now = now_ms();
        let seq = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let seq: u32 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM versions WHERE document_id = ?1",
                [document_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path, note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    Uuid::now_v7().to_string(),
                    document_id,
                    seq,
                    hash,
                    size,
                    now,
                    label.as_str(),
                    location,
                    note
                ],
            )?;
            // A linked document keeps pointing at its external original; its
            // current content is the newest version (see `document_file`).
            tx.execute(
                "UPDATE documents
                    SET blake3 = ?2, size_bytes = ?3, modified_at = ?4,
                        location = CASE WHEN kind = 'imported' THEN ?5 ELSE location END
                  WHERE id = ?1",
                params![document_id, hash, size, now, location],
            )?;
            tx.execute(
                "DELETE FROM working_copies WHERE document_id = ?1",
                [document_id],
            )?;
            tx.commit()?;
            seq
        };
        self.apply_retention(retention)?;
        Ok(SavedVersion {
            document: self.get_document(document_id)?,
            seq,
            created: true,
        })
    }

    fn current_seq(&self, document_id: &str) -> Result<u32> {
        Ok(self.conn().query_row(
            "SELECT COALESCE(MAX(seq), 1) FROM versions WHERE document_id = ?1",
            [document_id],
            |r| r.get(0),
        )?)
    }
}

fn starts_like_pdf(path: &std::path::Path) -> Result<bool> {
    let mut head = Vec::with_capacity(1024);
    File::open(path)
        .and_then(|f| f.take(1024).read_to_end(&mut head))
        .map_err(|e| Error::io(path, e))?;
    Ok(looks_like_pdf(&head))
}

/// 1..=64 of `[A-Za-z0-9-]`: an id that can only name a file directly in its folder.
fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_UPLOAD_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Security audit run-1, lead 7: an id from the UI must not reach outside `work/`.
    #[test]
    fn discarding_refuses_an_id_that_is_a_path() -> Result<()> {
        let (dir, lib) = lib()?;
        let doc = lib.import_reader(pdf("original").as_slice(), "a")?.document;
        let version = std::path::PathBuf::from(lib.document_file(&doc.id)?.path);
        assert!(version.exists(), "{}", version.display());
        let outside = dir.path().join("outside.pdf");
        std::fs::write(&outside, pdf("outside")).map_err(|e| Error::io(&outside, e))?;
        let stem = version
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or(Error::InvalidArgument("stem"))?;
        let outside_stem = dir.path().join("outside");
        let traversal = format!("../library/{stem}");
        for bad in [
            traversal.as_str(),
            outside_stem
                .to_str()
                .ok_or(Error::InvalidArgument("path"))?,
            "",
            "a/b",
            "a.b",
        ] {
            assert!(
                matches!(
                    lib.discard_working_copy(bad),
                    Err(Error::InvalidArgument(_))
                ),
                "{bad}"
            );
        }
        assert!(version.exists());
        assert!(outside.exists());
        Ok(())
    }

    fn pdf(marker: &str) -> Vec<u8> {
        format!("%PDF-1.7\n% {marker}\n%%EOF\n").into_bytes()
    }

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    /// Uploads `bytes` in `chunk`-sized pieces and makes them the working copy.
    fn autosave(lib: &Library, doc: &Document, bytes: &[u8], chunk: usize) -> Result<WorkingCopy> {
        let upload = Uuid::now_v7().to_string();
        let mut offset = 0u64;
        for piece in bytes.chunks(chunk) {
            offset = lib.write_upload_chunk(&upload, offset, piece)?;
        }
        lib.commit_working_copy(&upload, &doc.id, &doc.blake3, bytes.len() as u64)
    }

    fn versions(lib: &Library, id: &str) -> Result<Vec<(u32, String, String)>> {
        let conn = lib.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, label, file_path FROM versions WHERE document_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    #[test]
    fn a_version_keeps_its_note_and_a_bad_note_is_refused() -> Result<()> {
        let (_dir, lib) = lib()?;
        let doc = lib.import_reader(pdf("original").as_slice(), "a")?.document;
        autosave(&lib, &doc, &pdf("erased"), 7)?;
        let too_long = "x".repeat(MAX_VERSION_NOTE_LEN + 1);
        for bad in [
            too_long.as_str(),
            "line
break",
        ] {
            assert!(matches!(
                lib.save_version_with_note(
                    &doc.id,
                    VersionLabel::Erase,
                    Some(bad),
                    &RetentionPolicy::default()
                ),
                Err(Error::InvalidArgument(_))
            ));
        }
        let note = r#"{"annotationsRemoved":1,"annotationsClipped":2}"#;
        let saved = lib.save_version_with_note(
            &doc.id,
            VersionLabel::Erase,
            Some(note),
            &RetentionPolicy::default(),
        )?;
        assert_eq!(saved.seq, 2);
        let notes: Vec<(String, Option<String>)> = lib
            .conn()
            .prepare("SELECT label, note FROM versions WHERE document_id = ?1 ORDER BY seq")?
            .query_map([&doc.id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        assert_eq!(
            notes,
            vec![
                ("auto".to_owned(), None),
                ("erase".to_owned(), Some(note.to_owned()))
            ]
        );
        Ok(())
    }

    #[test]
    fn save_creates_the_next_version_and_keeps_the_original() -> Result<()> {
        let (_dir, lib) = lib()?;
        let original = pdf("original");
        let doc = lib.import_reader(original.as_slice(), "a")?.document;
        let v1 = lib.document_file(&doc.id)?.path;

        let edited = pdf("edited with an annotation");
        autosave(&lib, &doc, &edited, 7)?;
        let saved = lib.save_version(&doc.id, VersionLabel::Manual, &RetentionPolicy::default())?;

        assert!(saved.created);
        assert_eq!(saved.seq, 2);
        assert_eq!(
            saved.document.blake3,
            Blake3Hash::of_bytes(&edited).to_hex()
        );
        assert_eq!(saved.document.size_bytes, edited.len() as u64);
        let current = lib.document_file(&doc.id)?.path;
        assert_ne!(current, v1);
        assert_eq!(
            std::fs::read(&current).map_err(|e| Error::io(&current, e))?,
            edited
        );
        // v1 is byte-identical to the import.
        assert_eq!(std::fs::read(&v1).map_err(|e| Error::io(&v1, e))?, original);
        let rows = versions(&lib, &doc.id)?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].1, "manual");
        assert!(lib.working_copy(&doc.id)?.is_none());
        Ok(())
    }

    #[test]
    fn repeated_chunks_are_written_once() -> Result<()> {
        let (_dir, lib) = lib()?;
        let doc = lib.import_reader(pdf("a").as_slice(), "a")?.document;
        let bytes = pdf("0123456789");
        let upload = "retry-1";
        assert_eq!(lib.write_upload_chunk(upload, 0, &bytes[..10])?, 10);
        // Lost reply: the same chunk again.
        assert_eq!(lib.write_upload_chunk(upload, 0, &bytes[..10])?, 10);
        assert_eq!(
            lib.write_upload_chunk(upload, 10, &bytes[10..])?,
            bytes.len() as u64
        );
        assert!(matches!(
            lib.write_upload_chunk(upload, bytes.len() as u64 + 5, b"x"),
            Err(Error::Conflict(_))
        ));
        let copy = lib.commit_working_copy(upload, &doc.id, &doc.blake3, bytes.len() as u64)?;
        // Committing again (lost reply) answers with the same working copy.
        assert_eq!(
            lib.commit_working_copy(upload, &doc.id, &doc.blake3, bytes.len() as u64)?,
            copy
        );
        let path = lib.working_path(&doc.id)?;
        assert_eq!(
            std::fs::read(&path).map_err(|e| Error::io(&path, e))?,
            bytes
        );
        Ok(())
    }

    #[test]
    fn incomplete_or_non_pdf_uploads_are_refused() -> Result<()> {
        let (_dir, lib) = lib()?;
        let doc = lib.import_reader(pdf("a").as_slice(), "a")?.document;
        lib.write_upload_chunk("short", 0, b"%PDF-1.7")?;
        assert!(matches!(
            lib.commit_working_copy("short", &doc.id, &doc.blake3, 100),
            Err(Error::Conflict(_))
        ));
        lib.write_upload_chunk("html", 0, b"<html></html>")?;
        assert!(matches!(
            lib.commit_working_copy("html", &doc.id, &doc.blake3, 13),
            Err(Error::NotPdf)
        ));
        assert!(matches!(
            lib.write_upload_chunk("../escape", 0, b"x"),
            Err(Error::InvalidArgument(_))
        ));
        assert!(lib.working_copy(&doc.id)?.is_none());
        Ok(())
    }

    #[test]
    fn edits_on_an_outdated_version_are_refused() -> Result<()> {
        let (_dir, lib) = lib()?;
        let doc = lib.import_reader(pdf("a").as_slice(), "a")?.document;
        autosave(&lib, &doc, &pdf("first edit"), 64)?;
        lib.save_version(&doc.id, VersionLabel::Manual, &RetentionPolicy::default())?;
        // `doc` still names v1.
        assert!(matches!(
            autosave(&lib, &doc, &pdf("stale"), 64),
            Err(Error::Conflict(_))
        ));
        Ok(())
    }

    #[test]
    fn working_copy_survives_a_restart_and_can_be_recovered() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let edited = pdf("autosaved before the crash");
        let id = {
            let lib = Library::open(dir.path())?;
            let doc = lib.import_reader(pdf("a").as_slice(), "a")?.document;
            autosave(&lib, &doc, &edited, 5)?;
            // An upload in flight when the app died.
            lib.write_upload_chunk("in-flight", 0, b"%PDF-1.7 partial")?;
            doc.id
        };
        let lib = Library::open(dir.path())?;
        let copy = lib.working_copy(&id)?.ok_or(Error::NotFound(id.clone()))?;
        assert_eq!(copy.size_bytes, edited.len() as u64);
        assert!(!dir.path().join(UPLOADS_DIR).join("in-flight.part").exists());

        let saved = lib.save_version(&id, VersionLabel::Auto, &RetentionPolicy::default())?;
        assert_eq!(saved.seq, 2);
        assert_eq!(versions(&lib, &id)?[1].1, "auto");
        Ok(())
    }

    #[test]
    fn discarding_removes_the_working_copy_only() -> Result<()> {
        let (_dir, lib) = lib()?;
        let original = pdf("a");
        let doc = lib.import_reader(original.as_slice(), "a")?.document;
        autosave(&lib, &doc, &pdf("unwanted"), 64)?;
        lib.discard_working_copy(&doc.id)?;
        lib.discard_working_copy(&doc.id)?;
        assert!(lib.working_copy(&doc.id)?.is_none());
        assert!(!lib.working_path(&doc.id)?.exists());
        let path = lib.document_file(&doc.id)?.path;
        assert_eq!(
            std::fs::read(&path).map_err(|e| Error::io(&path, e))?,
            original
        );
        assert!(matches!(
            lib.save_version(&doc.id, VersionLabel::Manual, &RetentionPolicy::default()),
            Err(Error::NotFound(_))
        ));
        Ok(())
    }

    #[test]
    fn unchanged_content_is_not_a_new_version() -> Result<()> {
        let (_dir, lib) = lib()?;
        let original = pdf("a");
        let doc = lib.import_reader(original.as_slice(), "a")?.document;
        autosave(&lib, &doc, &original, 64)?;
        let saved = lib.save_version(&doc.id, VersionLabel::Manual, &RetentionPolicy::default())?;
        assert!(!saved.created);
        assert_eq!(saved.seq, 1);
        assert_eq!(versions(&lib, &doc.id)?.len(), 1);
        Ok(())
    }

    #[test]
    fn saving_applies_retention_but_keeps_v1() -> Result<()> {
        let (_dir, lib) = lib()?;
        let original = pdf("a");
        let doc = lib.import_reader(original.as_slice(), "a")?.document;
        let policy = RetentionPolicy {
            versions_per_document: 3,
            history_limit_bytes: u64::MAX,
        };
        for i in 0..5 {
            let current = lib.get_document(&doc.id)?;
            autosave(&lib, &current, &pdf(&format!("edit {i}")), 64)?;
            lib.save_version(&doc.id, VersionLabel::Manual, &policy)?;
        }
        let rows = versions(&lib, &doc.id)?;
        let seqs: Vec<u32> = rows.iter().map(|r| r.0).collect();
        assert_eq!(seqs, vec![1, 5, 6]);
        let v1 = lib.resolve_location(&rows[0].2)?;
        assert_eq!(std::fs::read(&v1).map_err(|e| Error::io(&v1, e))?, original);
        // Pruned versions' files are gone from the library directory: v1 + 2 kept.
        let files = std::fs::read_dir(lib.files_dir())
            .map_err(|e| Error::io(lib.files_dir(), e))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "pdf"))
            .count();
        assert_eq!(files, 3);
        Ok(())
    }

    #[test]
    fn an_upload_becomes_a_new_document() -> Result<()> {
        let (_dir, lib) = lib()?;
        let bytes = pdf("extracted pages");
        lib.write_upload_chunk("extract-1", 0, &bytes)?;
        let outcome = lib.import_upload("extract-1", "Report (pages 2-3)")?;
        assert_eq!(outcome.document.title, "Report (pages 2-3)");
        let path = lib.document_file(&outcome.document.id)?.path;
        assert_eq!(
            std::fs::read(&path).map_err(|e| Error::io(&path, e))?,
            bytes
        );
        assert!(!lib.root.join(UPLOADS_DIR).join("extract-1.part").exists());
        Ok(())
    }

    #[test]
    fn staged_pdfs_are_readable_then_removed_and_cleared_on_restart() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let staged = {
            let lib = Library::open(dir.path())?;
            let a = lib.stage_reader(pdf("to insert").as_slice())?;
            let b = lib.stage_reader(pdf("left behind").as_slice())?;
            assert!(matches!(
                lib.stage_reader(&b"<html>"[..]),
                Err(Error::NotPdf)
            ));
            lib.unstage(&a.to_string_lossy())?;
            lib.unstage(&a.to_string_lossy())?;
            assert!(!a.exists());
            assert!(matches!(
                lib.unstage(&lib.files_dir().join("x.pdf").to_string_lossy()),
                Err(Error::InvalidArgument(_))
            ));
            b
        };
        assert!(staged.exists());
        let _lib = Library::open(dir.path())?;
        assert!(!staged.exists());
        Ok(())
    }

    #[test]
    fn two_documents_may_end_with_the_same_content() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = lib.import_reader(pdf("a").as_slice(), "a")?.document;
        let b = lib.import_reader(pdf("b").as_slice(), "b")?.document;
        autosave(&lib, &a, &pdf("b"), 64)?;
        let saved = lib.save_version(&a.id, VersionLabel::Manual, &RetentionPolicy::default())?;
        assert_eq!(saved.document.blake3, b.blake3);
        // Deleting one keeps the shared file for the other.
        lib.delete_document(&a.id)?;
        let path = lib.document_file(&b.id)?.path;
        assert_eq!(
            std::fs::read(&path).map_err(|e| Error::io(&path, e))?,
            pdf("b")
        );
        Ok(())
    }

    #[test]
    fn images_are_staged_and_unstaged_other_files_refused() -> Result<()> {
        let (_dir, lib) = lib()?;
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 16, b'J', b'F', b'I', b'F', 0];
        let staged = lib.stage_image(&jpeg[..])?;
        assert_eq!(staged.extension().and_then(|e| e.to_str()), Some("img"));
        assert_eq!(
            std::fs::read(&staged).map_err(|e| Error::io(&staged, e))?,
            jpeg
        );
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        lib.stage_image(&png[..])?;
        assert!(matches!(
            lib.stage_image(&b"%PDF-1.7\n"[..]),
            Err(Error::InvalidArgument(_))
        ));
        assert!(matches!(lib.stage_image(&b""[..]), Err(Error::EmptyFile)));
        lib.unstage(&staged.to_string_lossy())?;
        assert!(!staged.exists());
        // Only stage files go.
        assert!(lib.unstage("/etc/passwd").is_err());
        Ok(())
    }

    #[test]
    fn a_conversion_stages_its_source_prints_into_the_stage_and_imports_on_save() -> Result<()> {
        let (_dir, lib) = lib()?;
        // The source: any file (the UI decides what it is), up to the size limit.
        let source = lib.stage_document(&b"PK a docx"[..])?;
        assert_eq!(source.extension().and_then(|e| e.to_str()), Some("src"));
        assert!(matches!(
            lib.stage_document(&b""[..]),
            Err(Error::EmptyFile)
        ));
        lib.unstage(&source.to_string_lossy())?;
        assert!(!source.exists());

        // The HTML arrives as an upload and moves into the stage next to its PDF's path.
        let upload = Uuid::now_v7().to_string();
        lib.write_upload_chunk(&upload, 0, b"<!doctype html><p>Hello</p>")?;
        let (html, pdf_path) = lib.stage_conversion(&upload)?;
        assert_eq!(html.parent(), pdf_path.parent());
        assert_eq!(html.extension().and_then(|e| e.to_str()), Some("html"));
        assert_eq!(pdf_path.extension().and_then(|e| e.to_str()), Some("pdf"));
        assert!(html.exists());
        lib.unstage(&html.to_string_lossy())?;

        // The printer's output is checked, then imported under the title the user saw.
        std::fs::write(&pdf_path, b"").map_err(|e| Error::io(&pdf_path, e))?;
        assert!(matches!(
            lib.check_staged_pdf(&pdf_path),
            Err(Error::EmptyFile)
        ));
        std::fs::write(&pdf_path, b"<html>").map_err(|e| Error::io(&pdf_path, e))?;
        assert!(matches!(
            lib.check_staged_pdf(&pdf_path),
            Err(Error::NotPdf)
        ));
        std::fs::write(&pdf_path, pdf("converted")).map_err(|e| Error::io(&pdf_path, e))?;
        lib.check_staged_pdf(&pdf_path)?;
        let outcome = lib.import_staged(&pdf_path.to_string_lossy(), "Quarterly report")?;
        assert_eq!(outcome.document.title, "Quarterly report");
        assert!(!pdf_path.exists());

        // Only PDFs directly in the stage are imported.
        assert!(matches!(
            lib.import_staged(&lib.files_dir().join("x.pdf").to_string_lossy(), "x"),
            Err(Error::InvalidArgument(_))
        ));
        assert!(matches!(
            lib.import_staged(&html.with_extension("src").to_string_lossy(), "x"),
            Err(Error::InvalidArgument(_))
        ));
        Ok(())
    }
}
