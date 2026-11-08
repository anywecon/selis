//! Version history retention (docs/SPEC.md "Data model": "the last 10 or up to
//! 200 MB per document, configurable; v1 is never deleted automatically").
//!
//! Per document, versions are pruned oldest first until both limits hold. Two
//! versions are never removed: v1 (the imported original) and the newest one
//! (the current content). A stored file is deleted only once no version and no
//! document refers to it any more (see `delete.rs`). Originals outside the library are never touched.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::library::Library;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    /// Versions kept per document, v1 and the current one included (at least 2).
    pub versions_per_document: u32,
    /// Bytes of history per document: versions other than v1 and the current one.
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub history_limit_bytes: u64,
}

impl Default for RetentionPolicy {
    /// 10 versions, 200 MB (docs/SPEC.md; docs/design/p1-ui-brief.md §6).
    fn default() -> Self {
        Self {
            versions_per_document: 10,
            history_limit_bytes: 200 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetentionReport {
    pub removed_versions: u32,
    pub freed_bytes: u64,
}

#[derive(Clone)]
struct Candidate {
    id: String,
    document_id: String,
    file_path: String,
    size: i64,
}

/// The versions `policy` removes, oldest first per document.
fn plan(conn: &rusqlite::Connection, policy: &RetentionPolicy) -> Result<Vec<Candidate>> {
    let keep = usize::try_from(policy.versions_per_document.max(2)).unwrap_or(usize::MAX);
    let limit = i64::try_from(policy.history_limit_bytes).unwrap_or(i64::MAX);
    // Prunable versions: not v1, not the newest of their document; oldest first.
    let candidates: Vec<Candidate> = {
        let mut stmt = conn.prepare(
            "SELECT v.id, v.document_id, v.file_path, v.size_bytes FROM versions v
              WHERE v.seq > 1
                AND v.seq < (SELECT MAX(w.seq) FROM versions w WHERE w.document_id = v.document_id)
              ORDER BY v.document_id, v.seq",
        )?;
        stmt.query_map([], |r| {
            Ok(Candidate {
                id: r.get(0)?,
                document_id: r.get(1)?,
                file_path: r.get(2)?,
                size: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut removed = Vec::new();
    for group in candidates.chunk_by(|a, b| a.document_id == b.document_id) {
        // v1 + the current version are always there on top of the group.
        let mut count = group.len() + 2;
        let mut bytes: i64 = group.iter().map(|c| c.size).sum();
        for c in group {
            if count <= keep && bytes <= limit {
                break;
            }
            count -= 1;
            bytes -= c.size;
            removed.push(c.clone());
        }
    }
    Ok(removed)
}

impl Library {
    /// What [`Library::apply_retention`] would remove with `policy`, without removing anything
    /// (the confirmation before settings from a pack or another device apply).
    pub fn preview_retention(&self, policy: &RetentionPolicy) -> Result<RetentionReport> {
        let removed = plan(&self.conn(), policy)?;
        Ok(RetentionReport {
            removed_versions: u32::try_from(removed.len()).unwrap_or(u32::MAX),
            freed_bytes: removed
                .iter()
                .map(|c| u64::try_from(c.size).unwrap_or(0))
                .sum(),
        })
    }

    /// Prunes the version history of every document to `policy`. Idempotent.
    pub fn apply_retention(&self, policy: &RetentionPolicy) -> Result<RetentionReport> {
        let removed: Vec<Candidate>;
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            removed = plan(&tx, policy)?;
            for c in &removed {
                tx.execute("DELETE FROM versions WHERE id = ?1", [&c.id])?;
            }
            tx.commit()?;
        }

        let mut report = RetentionReport::default();
        for v in &removed {
            report.removed_versions += 1;
            report.freed_bytes += u64::try_from(v.size).unwrap_or(0);
            self.remove_if_unreferenced(&v.file_path)?;
        }
        Ok(report)
    }
}

impl Library {
    /// Deletes every version of a document except the newest (the current
    /// content), v1 included: the explicit "Delete earlier versions" offered
    /// after a redaction, so no older version keeps what was removed (ADR 0009).
    /// Files no version or document uses any more are removed; a linked
    /// document's external file never is. Idempotent.
    pub fn delete_earlier_versions(&self, document_id: &str) -> Result<RetentionReport> {
        let mut removed: Vec<Candidate> = Vec::new();
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
                [document_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::NotFound(document_id.to_owned()));
            }
            {
                let mut stmt = tx.prepare(
                    "SELECT id, document_id, file_path, size_bytes FROM versions
                      WHERE document_id = ?1
                        AND seq < (SELECT MAX(seq) FROM versions WHERE document_id = ?1)",
                )?;
                for c in stmt.query_map([document_id], |r| {
                    Ok(Candidate {
                        id: r.get(0)?,
                        document_id: r.get(1)?,
                        file_path: r.get(2)?,
                        size: r.get(3)?,
                    })
                })? {
                    removed.push(c?);
                }
            }
            for c in &removed {
                tx.execute("DELETE FROM versions WHERE id = ?1", [&c.id])?;
            }
            tx.commit()?;
        }
        let mut report = RetentionReport::default();
        for v in &removed {
            report.removed_versions += 1;
            report.freed_bytes += u64::try_from(v.size).unwrap_or(0);
            self.remove_if_unreferenced(&v.file_path)?;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// A document with `count` versions (v1 = the import, then 1 KB files); the
    /// document points at the newest one, as after a save in P2.
    fn doc_with_versions(lib: &Library, marker: &str, count: i64) -> Result<String> {
        let bytes = format!("%PDF-1.7\n% {marker}\n%%EOF\n");
        let id = lib.import_reader(bytes.as_bytes(), marker)?.document.id;
        let conn = lib.conn();
        for seq in 2..=count {
            let rel = format!("library/{marker}-v{seq}.pdf");
            let path = lib.resolve_location(&rel)?;
            std::fs::write(&path, vec![b'x'; 1024]).map_err(|e| Error::io(&path, e))?;
            conn.execute(
                "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                 VALUES (?1, ?2, ?3, ?4, 1024, ?3, 'auto', ?5)",
                params![format!("{marker}-{seq}"), id, seq, format!("h{seq}"), rel],
            )?;
            conn.execute(
                "UPDATE documents SET location = ?2 WHERE id = ?1",
                params![id, rel],
            )?;
        }
        Ok(id)
    }

    fn seqs(lib: &Library, id: &str) -> Result<Vec<i64>> {
        let conn = lib.conn();
        let mut stmt =
            conn.prepare("SELECT seq FROM versions WHERE document_id = ?1 ORDER BY seq")?;
        Ok(stmt
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    #[test]
    fn a_preview_counts_what_would_go_and_removes_nothing() -> Result<()> {
        let (_dir, lib) = lib()?;
        let id = doc_with_versions(&lib, "a", 6)?;
        let policy = RetentionPolicy {
            versions_per_document: 2,
            history_limit_bytes: u64::MAX,
        };
        let preview = lib.preview_retention(&policy)?;
        assert_eq!(seqs(&lib, &id)?, [1, 2, 3, 4, 5, 6]);
        assert!(lib.resolve_location("library/a-v2.pdf")?.exists());
        assert_eq!(preview, lib.apply_retention(&policy)?);
        assert_eq!(preview.removed_versions, 4);
        Ok(())
    }

    #[test]
    fn keeps_v1_and_the_newest_versions() -> Result<()> {
        let (_dir, lib) = lib()?;
        let id = doc_with_versions(&lib, "a", 15)?;
        let policy = RetentionPolicy {
            versions_per_document: 10,
            history_limit_bytes: u64::MAX,
        };
        let report = lib.apply_retention(&policy)?;
        assert_eq!(report.removed_versions, 5);
        assert_eq!(seqs(&lib, &id)?, [1, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        // Removed version files are gone; kept ones and the current file stay.
        assert!(!lib.resolve_location("library/a-v2.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v7.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v15.pdf")?.exists());
        assert_eq!(
            lib.apply_retention(&policy)?,
            RetentionReport::default(),
            "idempotent"
        );
        Ok(())
    }

    #[test]
    fn history_limit_is_per_document_and_spares_v1_and_current() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = doc_with_versions(&lib, "a", 6)?; // history: v2..v5 = 4 KB
        let b = doc_with_versions(&lib, "b", 3)?; // history: v2 = 1 KB
        let report = lib.apply_retention(&RetentionPolicy {
            versions_per_document: 50,
            history_limit_bytes: 2048,
        })?;
        assert_eq!(report.removed_versions, 2);
        assert_eq!(seqs(&lib, &a)?, [1, 4, 5, 6]);
        assert_eq!(seqs(&lib, &b)?, [1, 2, 3], "b is under its own limit");

        // Even a zero budget keeps v1 and the current version of every document.
        lib.apply_retention(&RetentionPolicy {
            versions_per_document: 2,
            history_limit_bytes: 0,
        })?;
        assert_eq!(seqs(&lib, &a)?, [1, 6]);
        assert_eq!(seqs(&lib, &b)?, [1, 3]);
        let v1: String = lib.conn().query_row(
            "SELECT file_path FROM versions WHERE document_id = ?1 AND seq = 1",
            [&a],
            |r| r.get(0),
        )?;
        assert!(lib.resolve_location(&v1)?.exists());
        assert!(lib.resolve_location("library/a-v6.pdf")?.exists());
        Ok(())
    }

    #[test]
    fn a_single_version_document_is_never_touched() -> Result<()> {
        let (_dir, lib) = lib()?;
        let bytes = b"%PDF-1.7\n% only\n%%EOF\n";
        let doc = lib.import_reader(bytes.as_slice(), "only")?.document;
        let report = lib.apply_retention(&RetentionPolicy {
            versions_per_document: 2,
            history_limit_bytes: 0,
        })?;
        assert_eq!(report, RetentionReport::default());
        assert!(std::path::Path::new(&lib.document_file(&doc.id)?.path).is_file());
        Ok(())
    }
    #[test]
    fn deleting_earlier_versions_keeps_only_the_current_one() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = doc_with_versions(&lib, "a", 4)?;
        let b = doc_with_versions(&lib, "b", 3)?;
        let v1: String = lib.conn().query_row(
            "SELECT file_path FROM versions WHERE document_id = ?1 AND seq = 1",
            [&a],
            |r| r.get(0),
        )?;
        let report = lib.delete_earlier_versions(&a)?;
        assert_eq!(report.removed_versions, 3);
        assert_eq!(seqs(&lib, &a)?, [4]);
        assert_eq!(seqs(&lib, &b)?, [1, 2, 3], "other documents are untouched");
        // The removed versions' files are gone, the original import's copy too.
        assert!(!lib.resolve_location(&v1)?.exists());
        assert!(!lib.resolve_location("library/a-v2.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v4.pdf")?.exists());
        assert_eq!(
            lib.delete_earlier_versions(&a)?,
            RetentionReport::default(),
            "idempotent"
        );
        assert!(matches!(
            lib.delete_earlier_versions("missing"),
            Err(Error::NotFound(_))
        ));
        Ok(())
    }
}
