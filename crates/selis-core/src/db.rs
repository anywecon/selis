//! Versioned SQL migrations tracked in `PRAGMA user_version`.
//!
//! Before applying migrations to an existing database, a consistent snapshot is
//! written next to it with `VACUUM INTO` (`<db>.bak-v<from>`).

use std::path::Path;

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Ordered migrations; index + 1 is the schema version they produce.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_library.sql"),
    include_str!("../migrations/0003_editing.sql"),
    include_str!("../migrations/0004_signatures.sql"),
    include_str!("../migrations/0005_transfers.sql"),
    include_str!("../migrations/0006_trusted_devices.sql"),
    include_str!("../migrations/0007_english_first.sql"),
    include_str!("../migrations/0008_erase_label.sql"),
    include_str!("../migrations/0009_version_note.sql"),
];

pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn, Some(path))?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&conn, None)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    crate::fold::register(conn)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

fn user_version(conn: &Connection) -> Result<u32> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn migrate(conn: &Connection, db_path: Option<&Path>) -> Result<()> {
    let current = user_version(conn)?;
    if current > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    if current == SCHEMA_VERSION {
        return Ok(());
    }
    if current > 0
        && let Some(path) = db_path
    {
        backup(conn, path, current)?;
    }
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let target = idx as u32 + 1;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()?;
    }
    Ok(())
}

fn backup(conn: &Connection, db_path: &Path, from_version: u32) -> Result<()> {
    let mut name = db_path
        .file_name()
        .ok_or(Error::InvalidArgument("database path has no file name"))?
        .to_os_string();
    name.push(format!(".bak-v{from_version}"));
    let dest = db_path.with_file_name(name);
    if dest.exists() {
        std::fs::remove_file(&dest).map_err(|e| Error::io(&dest, e))?;
    }
    let dest_str = dest
        .to_str()
        .ok_or(Error::InvalidArgument("backup path is not valid UTF-8"))?;
    conn.execute("VACUUM INTO ?1", [dest_str])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RUSTSEC-2026-0459: the bundled SQLite must be 3.54 or later.
    #[test]
    fn the_bundled_sqlite_is_at_least_3_54() -> Result<()> {
        let conn = open_in_memory()?;
        let version: String = conn.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
        println!("bundled SQLite {version}");
        let parts: Vec<u32> = version.split('.').map(|p| p.parse().unwrap_or(0)).collect();
        assert!(
            parts.as_slice() >= [3, 54].as_slice(),
            "bundled SQLite {version} is older than 3.54"
        );
        Ok(())
    }

    #[test]
    fn fresh_db_reaches_latest_version() -> Result<()> {
        let conn = open_in_memory()?;
        assert_eq!(user_version(&conn)?, SCHEMA_VERSION);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        assert_eq!(
            tables,
            [
                "document_tags",
                "documents",
                "settings",
                "signatures",
                "tags",
                "transfers",
                "trusted_devices",
                "versions",
                "working_copies"
            ]
        );
        Ok(())
    }

    #[test]
    fn reopening_is_idempotent() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        drop(open(&path)?);
        let conn = open(&path)?;
        assert_eq!(user_version(&conn)?, SCHEMA_VERSION);
        Ok(())
    }

    #[test]
    fn newer_schema_is_rejected() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        {
            let conn = Connection::open(&path)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)?;
        }
        assert!(matches!(open(&path), Err(Error::SchemaTooNew { .. })));
        Ok(())
    }

    /// A v1 database (P0) is snapshotted, then upgraded with its rows intact.
    #[test]
    fn upgrade_from_v1_keeps_rows_and_writes_backup() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        {
            let conn = Connection::open(&path)?;
            conn.execute_batch(MIGRATIONS[0])?;
            conn.pragma_update(None, "user_version", 1)?;
            conn.execute(
                "INSERT INTO documents (id, title, kind, location, blake3, size_bytes,
                                        created_at, modified_at, favorite)
                 VALUES ('d1', 'Αναφορά', 'imported', 'library/x.pdf', 'x', 3, 1, 1, 1)",
                [],
            )?;
        }
        let conn = open(&path)?;
        assert_eq!(user_version(&conn)?, SCHEMA_VERSION);
        let (title, origin, favorite): (String, String, i64) = conn.query_row(
            "SELECT title, origin, favorite FROM documents WHERE id = 'd1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(
            (title.as_str(), origin.as_str(), favorite),
            ("Αναφορά", "import", 1)
        );

        let snap = Connection::open(dir.path().join("selis.db.bak-v1"))?;
        assert_eq!(user_version(&snap)?, 1);
        let rows: i64 = snap.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))?;
        assert_eq!(rows, 1);
        Ok(())
    }

    /// A v6 database with the language set to "system" before English became the
    /// default: the upgrade turns it into "en" once; "el" and "en" are kept.
    #[test]
    fn upgrade_to_v7_makes_a_stored_system_locale_english() -> Result<()> {
        for (stored, expected) in [("system", "en"), ("el", "el"), ("en", "en")] {
            let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
            let path = dir.path().join("selis.db");
            {
                let conn = Connection::open(&path)?;
                configure(&conn)?;
                for sql in &MIGRATIONS[..6] {
                    conn.execute_batch(sql)?;
                }
                conn.pragma_update(None, "user_version", 6)?;
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('locale', ?1), ('theme', '\"dark\"')",
                    [format!("\"{stored}\"")],
                )?;
            }
            let conn = open(&path)?;
            let locale: String =
                conn.query_row("SELECT value FROM settings WHERE key = 'locale'", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(locale, format!("\"{expected}\""), "stored {stored}");
            let theme: String =
                conn.query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(theme, "\"dark\"");
        }
        Ok(())
    }

    /// Only once: a "system" chosen after the upgrade is not touched again.
    #[test]
    fn a_system_locale_chosen_after_v7_is_kept() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        open(&path)?.execute(
            "INSERT INTO settings (key, value) VALUES ('locale', '\"system\"')",
            [],
        )?;
        let conn = open(&path)?;
        let locale: String =
            conn.query_row("SELECT value FROM settings WHERE key = 'locale'", [], |r| {
                r.get(0)
            })?;
        assert_eq!(locale, "\"system\"");
        Ok(())
    }

    /// v8 rebuilds `versions` to accept the 'erase' label (ADR 0033): rows, the cascade
    /// from documents and the (document, seq) uniqueness survive.
    #[test]
    fn upgrade_to_v8_keeps_versions_and_accepts_erase() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        {
            let conn = Connection::open(&path)?;
            configure(&conn)?;
            for sql in &MIGRATIONS[..7] {
                conn.execute_batch(sql)?;
            }
            conn.pragma_update(None, "user_version", 7)?;
            conn.execute_batch(
                "INSERT INTO documents (id, title, kind, location, blake3, size_bytes, created_at, modified_at)
                     VALUES ('d1', 'Doc', 'imported', 'library/a.pdf', 'b2', 20, 1, 2);
                 INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                     VALUES ('v1', 'd1', 1, 'b1', 10, 1, 'manual', 'library/a.pdf'),
                            ('v2', 'd1', 2, 'b2', 20, 2, 'received', 'library/b.pdf');",
            )?;
        }
        let conn = open(&path)?;
        assert_eq!(user_version(&conn)?, SCHEMA_VERSION);
        let rows: Vec<(String, i64, String)> = conn
            .prepare("SELECT id, seq, label FROM versions ORDER BY seq")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        assert_eq!(
            rows,
            vec![
                ("v1".to_owned(), 1, "manual".to_owned()),
                ("v2".to_owned(), 2, "received".to_owned())
            ]
        );
        conn.execute(
            "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                 VALUES ('v3', 'd1', 3, 'b3', 30, 3, 'erase', 'library/c.pdf')",
            [],
        )?;
        assert!(
            conn.execute(
                "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                     VALUES ('v4', 'd1', 3, 'b4', 30, 4, 'erase', 'library/d.pdf')",
                [],
            )
            .is_err(),
            "(document, seq) stays unique"
        );
        assert!(
            conn.execute(
                "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                     VALUES ('v5', 'd1', 5, 'b5', 30, 5, 'other', 'library/e.pdf')",
                [],
            )
            .is_err(),
            "unknown labels are still refused"
        );
        conn.execute("DELETE FROM documents WHERE id = 'd1'", [])?;
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM versions", [], |r| r.get(0))?;
        assert_eq!(left, 0, "deleting the document still removes its versions");
        Ok(())
    }

    #[test]
    fn backup_snapshot_is_written() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        let conn = Connection::open(&path)?;
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);")?;
        backup(&conn, &path, 1)?;
        let snap = Connection::open(dir.path().join("selis.db.bak-v1"))?;
        let x: i64 = snap.query_row("SELECT x FROM t", [], |r| r.get(0))?;
        assert_eq!(x, 42);
        Ok(())
    }
}
