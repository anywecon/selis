//! `.selispack` export and import (P3c, ADR 0012). No network: the file goes
//! wherever the user sends it (share sheet) and comes back through "Open with"
//! or the picker. Packs are written to the share folder in the app cache and
//! read from a copy there, so a content URI never needs to be seekable.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use selis_core::{Library, PackKind, PackRequest, PackSummary, pack};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::library::parse_source;
use super::{CommandError, CommandResult, ErrorCode, settings};
use crate::requests::RequestResults;

/// Why a pack could not be used (the UI explains each).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PackProblem {
    NotAPack,
    Unsupported,
    PassphraseNeeded,
    WrongPassphrase,
    Damaged,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PackImportView {
    #[serde(rename_all = "camelCase")]
    Imported {
        document_ids: Vec<String>,
        duplicates: u32,
        signatures: u32,
        /// What the pack's settings would change here. Not applied: the user confirms them
        /// first (and again when they delete history), then the UI calls `update_settings`.
        settings: Option<settings::ForeignSettings>,
    },
    #[serde(rename_all = "camelCase")]
    Refused { problem: PackProblem },
}

/// What became of an export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PackExportView {
    /// Handed to the share sheet (Android) or saved where the user chose.
    Shared { summary: PackSummary },
    /// The save dialog was cancelled: the pack was deleted, nothing was written.
    Cancelled,
}

fn problem(e: &selis_core::Error) -> Option<PackProblem> {
    match e {
        selis_core::Error::Pack(p) => Some(match p {
            pack::PackError::NotAPack => PackProblem::NotAPack,
            pack::PackError::Unsupported => PackProblem::Unsupported,
            pack::PackError::PassphraseNeeded => PackProblem::PassphraseNeeded,
            pack::PackError::WrongPassphrase => PackProblem::WrongPassphrase,
            pack::PackError::Damaged => PackProblem::Damaged,
            pack::PackError::TooLarge => PackProblem::TooLarge,
        }),
        _ => None,
    }
}

fn share_dir<R: Runtime>(app: &AppHandle<R>) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?
        .join("share");
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?;
    Ok(dir)
}

/// When the share folder is swept of packs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sweep {
    /// App start: nothing is in flight, so the private copies of imports go too.
    Startup,
    /// Before an export: an import running meanwhile keeps its copy.
    BeforeExport,
}

/// Deletes the `.selispack` files left in the share folder and returns how many.
/// A pack without a passphrase is the library in clear text: on Android it stays
/// there after the share sheet (the receiving app reads it later), so it must
/// not outlive the next start or export (PRIVACY.md). Errors are ignored: a file
/// that cannot be deleted now goes at the next sweep.
pub(crate) fn sweep_packs(dir: &Path, sweep: Sweep) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let ext = format!(".{}", pack::EXTENSION);
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.ends_with(&ext) && (sweep == Sweep::Startup || !name.starts_with('.'))
        })
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
}

/// App start: no pack from an earlier run stays in the cache.
pub(crate) fn sweep_packs_at_start<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(cache) = app.path().app_cache_dir() {
        sweep_packs(&cache.join("share"), Sweep::Startup);
    }
}

/// The first bytes of a picked or shared file: a pack (plain or encrypted), or not.
#[tauri::command]
#[specta::specta]
pub async fn pack_kind<R: Runtime>(
    app: AppHandle<R>,
    source: String,
) -> CommandResult<Option<PackKind>> {
    let path = parse_source(source.trim())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut opts = OpenOptions::new();
        opts.read(true);
        let mut file = app
            .fs()
            .open(path, opts)
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("cannot open source: {e}")))?;
        let mut head = [0u8; 16];
        let mut n = 0;
        while n < head.len() {
            match file.read(&mut head[n..]) {
                Ok(0) => break,
                Ok(k) => n += k,
                Err(e) => return Err(CommandError::new(ErrorCode::Io, e.to_string())),
            }
        }
        Ok(pack::sniff(&head[..n]).and_then(Result::ok))
    })
    .await
    .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?
}

/// Writes a pack (selected documents, or the whole library when `document_ids`
/// is `None`) and opens the share sheet for it. The passphrase, if any, never
/// leaves this call.
#[tauri::command]
#[specta::specta]
pub async fn pack_export<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    document_ids: Option<Vec<String>>,
    include_history: bool,
    passphrase: Option<String>,
) -> CommandResult<PackExportView> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "pack_export", async move {
            let dir = share_dir(&app)?;
            // The pack shared last time (perhaps unencrypted) goes before a new one is made.
            sweep_packs(&dir, Sweep::BeforeExport);
            let date = chrono_free_date();
            let name = format!("Selis {date}.selispack");
            let dest = dir.join(&name);
            // The whole library always travels with its versions.
            let include_history = include_history || document_ids.is_none();
            let request = PackRequest {
                document_ids,
                include_history,
                passphrase: passphrase.filter(|p| !p.is_empty()),
            };
            let lib = Arc::clone(&library);
            let target = dest.clone();
            let summary =
                tauri::async_runtime::spawn_blocking(move || lib.export_pack(&target, &request))
                    .await
                    .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))??;
            let shared = super::share::share_file(&app, &dest, &name, pack::MIME).await;
            // Desktop/iOS saved a copy through the dialog: no plain copy stays in the cache.
            // (Android: the receiving app reads it later; it goes at the next start or export.)
            #[cfg(not(target_os = "android"))]
            let _ = std::fs::remove_file(&dest);
            Ok(if shared? {
                PackExportView::Shared { summary }
            } else {
                PackExportView::Cancelled
            })
        })
        .await
}

/// `YYYY-MM-DD` (UTC) for the file name, without a date crate.
fn chrono_free_date() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Imports a pack from a picked or shared file: checks everything first, then
/// adds what is new (documents by BLAKE3). The pack's settings are only described
/// (security audit run-1, lead 4): nothing changes until the user confirms them.
#[tauri::command]
#[specta::specta]
pub async fn pack_import<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    source: String,
    passphrase: Option<String>,
) -> CommandResult<PackImportView> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "pack_import", async move {
            let path = parse_source(source.trim())?;
            let local = share_dir(&app)?.join(format!(".import-{}.selispack", uuid_like()));
            let copy_to = local.clone();
            let app2 = app.clone();
            // A local copy: the ZIP reader needs to seek, a content URI cannot.
            tauri::async_runtime::spawn_blocking(move || {
                let mut opts = OpenOptions::new();
                opts.read(true);
                let mut src = app2.fs().open(path, opts).map_err(|e| {
                    CommandError::new(ErrorCode::Io, format!("cannot open source: {e}"))
                })?;
                let mut dst = std::fs::File::create(&copy_to)
                    .map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?;
                std::io::copy(&mut src, &mut dst)
                    .map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?;
                Ok::<_, CommandError>(())
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))??;
            let lib = Arc::clone(&library);
            let read = local.clone();
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                lib.import_pack(&read, passphrase.as_deref().filter(|p| !p.is_empty()))
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()));
            let _ = std::fs::remove_file(&local);
            match outcome? {
                Ok(imported) => {
                    // The documents are in: a settings read error only drops the offer.
                    let settings = imported.settings.and_then(|map| {
                        settings::foreign_settings(&library, map).unwrap_or_else(|e| {
                            eprintln!("selis: pack settings not read: {}", e.message);
                            None
                        })
                    });
                    Ok(PackImportView::Imported {
                        document_ids: imported.document_ids,
                        duplicates: imported.duplicates,
                        signatures: imported.signatures,
                        settings,
                    })
                }
                Err(e) => match problem(&e) {
                    Some(problem) => Ok(PackImportView::Refused { problem }),
                    None => Err(e.into()),
                },
            }
        })
        .await
}

fn uuid_like() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

/// The picker for a pack (any file type: other apps label packs as binary data).
#[tauri::command]
#[specta::specta]
pub async fn pick_pack<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<super::picker::PickOutcome> {
    results
        .run_once(&request_id, "pick_pack", async move {
            tauri::async_runtime::spawn_blocking(move || {
                match app.dialog().file().blocking_pick_file() {
                    Some(path) => super::picker::PickOutcome::Picked {
                        source: super::picker::to_source(path),
                    },
                    None => super::picker::PickOutcome::Cancelled,
                }
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}")))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{Sweep, sweep_packs};

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .expect("read the folder")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in [
            "Selis 2026-10-13.selispack",
            "Selis 2026-10-14.selispack",
            ".import-1a2b.selispack",
            "Report.pdf",
        ] {
            std::fs::write(dir.path().join(name), b"x").expect("write");
        }
        std::fs::create_dir(dir.path().join("nested.selispack")).expect("mkdir");
        dir
    }

    #[test]
    fn an_export_removes_earlier_packs_but_not_an_import_in_flight() {
        let dir = folder();
        assert_eq!(sweep_packs(dir.path(), Sweep::BeforeExport), 2);
        assert_eq!(
            names(dir.path()),
            [".import-1a2b.selispack", "Report.pdf", "nested.selispack"]
        );
    }

    #[test]
    fn app_start_removes_every_pack_file() {
        let dir = folder();
        assert_eq!(sweep_packs(dir.path(), Sweep::Startup), 3);
        assert_eq!(names(dir.path()), ["Report.pdf", "nested.selispack"]);
    }

    #[test]
    fn a_missing_share_folder_is_nothing_to_sweep() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(sweep_packs(&dir.path().join("share"), Sweep::Startup), 0);
    }
}
