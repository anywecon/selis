//! File operations that turn the current version into the next one outside the PDF engine
//! (P4a: qpdf in `selis-pdfops`, ADR 0015).
//!
//! `begin_tool_run` hands out the current version's file (read only) and a path in the work
//! folder for the result; the tool writes there; `finish_tool_run` makes the result the next
//! version through the working-copy path of `save_version` (fsync, rename, one transaction),
//! or `abandon_tool_run` drops it. A document with unsaved edits is refused: the tool would
//! not see them.

use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::fsutil::rename_durable;
use crate::library::{Library, now_ms};
use crate::retention::RetentionPolicy;
use crate::save::{SavedVersion, VersionLabel, WORK_DIR};

/// One tool run on a document.
#[derive(Debug)]
pub struct ToolRun {
    pub document_id: String,
    /// The current version (never written to).
    pub input: PathBuf,
    /// Where the tool writes its result.
    pub output: PathBuf,
    base_blake3: String,
}

impl Library {
    pub fn begin_tool_run(&self, document_id: &str) -> Result<ToolRun> {
        let file = self.document_file(document_id)?;
        if self.working_copy(document_id)?.is_some() {
            return Err(Error::Conflict("the document has unsaved edits"));
        }
        let dir = self.root.join(WORK_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
        let output = dir.join(format!("{document_id}.tool.pdf"));
        let _ = std::fs::remove_file(&output);
        Ok(ToolRun {
            document_id: document_id.to_owned(),
            input: PathBuf::from(file.path),
            output,
            base_blake3: file.document.blake3,
        })
    }

    /// The tool's output becomes the document's next version.
    pub fn finish_tool_run(
        &self,
        run: ToolRun,
        retention: &RetentionPolicy,
    ) -> Result<SavedVersion> {
        let result = self.finish_inner(&run, retention);
        let _ = std::fs::remove_file(&run.output);
        result
    }

    fn finish_inner(&self, run: &ToolRun, retention: &RetentionPolicy) -> Result<SavedVersion> {
        let document = self.get_document(&run.document_id)?;
        if document.blake3 != run.base_blake3 {
            return Err(Error::Conflict("document changed while the tool ran"));
        }
        if self.working_copy(&run.document_id)?.is_some() {
            return Err(Error::Conflict("the document has unsaved edits"));
        }
        let size_bytes = std::fs::metadata(&run.output)
            .map_err(|e| Error::io(&run.output, e))?
            .len();
        let size =
            i64::try_from(size_bytes).map_err(|_| Error::InvalidArgument("file too large"))?;
        rename_durable(&run.output, &self.working_path(&run.document_id)?)?;
        self.conn().execute(
            "INSERT INTO working_copies (document_id, base_blake3, size_bytes, saved_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (document_id) DO UPDATE
                SET base_blake3 = excluded.base_blake3,
                    size_bytes = excluded.size_bytes,
                    saved_at = excluded.saved_at",
            rusqlite::params![run.document_id, run.base_blake3, size, now_ms()],
        )?;
        self.save_version(&run.document_id, VersionLabel::Manual, retention)
    }

    /// Drops the tool's output, if any.
    pub fn abandon_tool_run(&self, run: ToolRun) {
        let _ = std::fs::remove_file(&run.output);
    }
}

#[cfg(test)]
mod tests {
    use crate::library::Library;
    use crate::retention::RetentionPolicy;
    use crate::{Error, LibraryQuery};

    fn pdf(marker: &str) -> Vec<u8> {
        format!("%PDF-1.7\n% {marker}\n1 0 obj << >> endobj\n%%EOF\n").into_bytes()
    }

    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = Library::open(dir.path().join("lib")).expect("open");
        (dir, lib)
    }

    fn import(dir: &tempfile::TempDir, lib: &Library, marker: &str) -> String {
        let src = dir.path().join(format!("{marker}.pdf"));
        std::fs::write(&src, pdf(marker)).expect("write");
        lib.import_path(&src).expect("import").document.id
    }

    fn retention() -> RetentionPolicy {
        RetentionPolicy::default()
    }

    #[test]
    fn a_tool_result_becomes_the_next_version() {
        let (dir, lib) = library();
        let id = import(&dir, &lib, "original");
        let run = lib.begin_tool_run(&id).expect("begin");
        assert_eq!(std::fs::read(&run.input).expect("input"), pdf("original"));
        std::fs::write(&run.output, pdf("compressed")).expect("tool output");
        let output = run.output.clone();
        let saved = lib.finish_tool_run(run, &retention()).expect("finish");
        assert!(saved.created);
        assert_eq!(saved.seq, 2);
        let file = lib.document_file(&id).expect("file");
        assert_eq!(
            std::fs::read(file.path).expect("current"),
            pdf("compressed")
        );
        assert!(!output.exists());
        assert!(lib.working_copy(&id).expect("copy").is_none());
        assert_eq!(
            lib.list_documents(&LibraryQuery::default())
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    fn an_abandoned_run_leaves_the_document_as_it_was() {
        let (dir, lib) = library();
        let id = import(&dir, &lib, "original");
        let before = lib.get_document(&id).expect("doc");
        let run = lib.begin_tool_run(&id).expect("begin");
        std::fs::write(&run.output, pdf("half written")).expect("tool output");
        let output = run.output.clone();
        lib.abandon_tool_run(run);
        assert!(!output.exists());
        assert_eq!(lib.get_document(&id).expect("doc").blake3, before.blake3);
    }

    #[test]
    fn unsaved_edits_refuse_a_tool_run() {
        let (dir, lib) = library();
        let id = import(&dir, &lib, "original");
        let doc = lib.get_document(&id).expect("doc");
        let edited = pdf("edited");
        lib.write_upload_chunk("up1", 0, &edited).expect("chunk");
        lib.commit_working_copy("up1", &id, &doc.blake3, edited.len() as u64)
            .expect("working copy");
        assert!(matches!(lib.begin_tool_run(&id), Err(Error::Conflict(_))));
    }

    #[test]
    fn a_document_changed_meanwhile_is_not_overwritten() {
        let (dir, lib) = library();
        let id = import(&dir, &lib, "original");
        let run = lib.begin_tool_run(&id).expect("begin");
        std::fs::write(&run.output, pdf("tool")).expect("tool output");
        // Someone saved a version while the tool ran.
        let doc = lib.get_document(&id).expect("doc");
        let edited = pdf("edited");
        lib.write_upload_chunk("up1", 0, &edited).expect("chunk");
        lib.commit_working_copy("up1", &id, &doc.blake3, edited.len() as u64)
            .expect("working copy");
        lib.save_version(&id, crate::VersionLabel::Manual, &retention())
            .expect("save");
        let output = run.output.clone();
        assert!(matches!(
            lib.finish_tool_run(run, &retention()),
            Err(Error::Conflict(_))
        ));
        assert!(!output.exists());
        let file = lib.document_file(&id).expect("file");
        assert_eq!(std::fs::read(file.path).expect("current"), pdf("edited"));
    }
}
