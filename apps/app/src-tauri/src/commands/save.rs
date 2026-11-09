//! Saving edits: chunked upload of the engine's bytes → working copy
//! (autosave) → version. Logic lives in `selis_core::save`.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use selis_core::{
    ImportOutcome, Library, SavedVersion, VersionLabel, WorkingCopy, save::MAX_CHUNK_BYTES,
};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

/// Runs blocking file work off the async workers.
async fn blocking<T: Send + 'static>(
    what: &'static str,
    work: impl FnOnce() -> selis_core::Result<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CommandError::new(ErrorCode::Internal, format!("{what} task failed: {e}")))?
        .map_err(CommandError::from)
}

/// Appends one base64 chunk at `offset` and returns the upload's length.
/// Base64 because the Android IPC carries JSON only (bytes would travel as a
/// number array, ~4× larger). Safe to repeat.
#[tauri::command]
#[specta::specta]
pub async fn upload_chunk(
    library: State<'_, Arc<Library>>,
    upload_id: String,
    offset: u32,
    data: String,
) -> CommandResult<u32> {
    if data.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(CommandError::new(
            ErrorCode::InvalidArgument,
            "upload chunk too large",
        ));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|e| CommandError::new(ErrorCode::InvalidArgument, format!("bad base64: {e}")))?;
    let library = Arc::clone(&library);
    let len = blocking("upload", move || {
        library.write_upload_chunk(&upload_id, u64::from(offset), &bytes)
    })
    .await?;
    u32::try_from(len)
        .map_err(|_| CommandError::new(ErrorCode::InvalidArgument, "upload too large"))
}

/// Drops an upload that will not be committed. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn abort_upload(
    library: State<'_, Arc<Library>>,
    upload_id: String,
) -> CommandResult<()> {
    Ok(library.abort_upload(&upload_id)?)
}

/// Makes a finished upload the document's working copy (autosave). Safe to repeat.
#[tauri::command]
#[specta::specta]
pub async fn commit_working_copy(
    library: State<'_, Arc<Library>>,
    upload_id: String,
    document_id: String,
    base_blake3: String,
    size_bytes: u32,
) -> CommandResult<WorkingCopy> {
    let library = Arc::clone(&library);
    blocking("autosave", move || {
        library.commit_working_copy(
            &upload_id,
            &document_id,
            &base_blake3,
            u64::from(size_bytes),
        )
    })
    .await
}

/// Unsaved edits from an earlier session (crash recovery), if any.
#[tauri::command]
#[specta::specta]
pub async fn working_copy(
    library: State<'_, Arc<Library>>,
    document_id: String,
) -> CommandResult<Option<WorkingCopy>> {
    Ok(library.working_copy(&document_id)?)
}

/// Throws the working copy away. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn discard_working_copy(
    library: State<'_, Arc<Library>>,
    document_id: String,
) -> CommandResult<()> {
    let library = Arc::clone(&library);
    blocking("discard", move || {
        // Only a document the library has (the id is checked again where it becomes a path).
        library.get_document(&document_id)?;
        library.discard_working_copy(&document_id)
    })
    .await
}

/// Turns the working copy into the next version (hashing can take a moment
/// for large files), then applies the retention settings. Runs once per
/// `request_id` (see `take_result`).
#[tauri::command]
#[specta::specta]
pub async fn save_version(
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    document_id: String,
    label: VersionLabel,
    note: Option<String>,
) -> CommandResult<SavedVersion> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "save_version", async move {
            let retention = super::settings::load(&library)?.retention();
            blocking("save", move || {
                library.save_version_with_note(&document_id, label, note.as_deref(), &retention)
            })
            .await
        })
        .await
}

/// Imports a finished upload (pages extracted or split off in the UI) as a new
/// library document. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn import_upload(
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    upload_id: String,
    title: String,
) -> CommandResult<ImportOutcome> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "import_upload", async move {
            blocking("import", move || library.import_upload(&upload_id, &title)).await
        })
        .await
}

/// Copies a picked PDF (a path, or a content:// URI on Android) into the stage
/// and returns its path for the asset protocol: the UI reads it and inserts its
/// pages. The source is opened read-only. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn stage_pdf<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    source: String,
) -> CommandResult<String> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "stage_pdf", async move {
            let path = super::picker::granted_source(&app, &source)?;
            tauri::async_runtime::spawn_blocking(move || {
                let mut opts = OpenOptions::new();
                opts.read(true);
                let file = app.fs().open(path, opts).map_err(|e| {
                    CommandError::new(ErrorCode::Io, format!("cannot open source: {e}"))
                })?;
                let staged = library.stage_reader(file)?;
                Ok(staged.to_string_lossy().into_owned())
            })
            .await
            .map_err(|e| {
                CommandError::new(ErrorCode::Internal, format!("stage task failed: {e}"))
            })?
        })
        .await
}

/// Removes a staged PDF once its pages are in. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn unstage(library: State<'_, Arc<Library>>, path: String) -> CommandResult<()> {
    Ok(library.unstage(&path)?)
}
