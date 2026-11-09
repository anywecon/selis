use std::sync::Arc;
use std::time::Duration;

use selis_core::{
    CancelToken, CancellableReader, DeleteReport, Document, DocumentFile, ImportOutcome, Library,
    LibraryQuery, title_from_file_name,
};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

/// An import that has not finished by then is cancelled; the UI offers a retry.
pub const IMPORT_TIMEOUT: Duration = Duration::from_secs(30);

/// Imports the file the user picked (a filesystem path on desktop, a
/// `content://` URI from the Storage Access Framework on Android, a file URL on
/// iOS) by copying it into the app library. The source is opened read-only.
///
/// `name` is the sender's file name when known (Android "Open with" / share);
/// otherwise the title is derived from the source.
///
/// Runs once per `request_id`: a repeated call returns the first call's result
/// (see `take_result`).
#[tauri::command]
#[specta::specta]
pub async fn import_document<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    source: String,
    name: Option<String>,
) -> CommandResult<ImportOutcome> {
    let library = Arc::clone(&library);
    results
        .run_once(
            &request_id,
            "import_document",
            import(app, library, source, name),
        )
        .await
}

async fn import<R: Runtime>(
    app: AppHandle<R>,
    library: Arc<Library>,
    source: String,
    name: Option<String>,
) -> CommandResult<ImportOutcome> {
    let source = source.trim().to_owned();
    if source.is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidArgument,
            "empty source",
        ));
    }
    let file_path = super::picker::granted_source(&app, &source)?;
    let title = name
        .as_deref()
        .map(title_from_file_name)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| title_for_source(&source));
    let token = CancelToken::new();
    let worker_token = token.clone();

    // Copy + hash can take seconds for large files: keep it off the async workers.
    let task = tauri::async_runtime::spawn_blocking(move || {
        let mut opts = OpenOptions::new();
        opts.read(true);
        let file = app
            .fs()
            .open(file_path, opts)
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("cannot open source: {e}")))?;
        let reader = CancellableReader::new(file, worker_token);
        Ok(library.import_reader(reader, &title)?)
    });

    match tokio::time::timeout(IMPORT_TIMEOUT, task).await {
        Ok(joined) => joined.map_err(|e| {
            CommandError::new(ErrorCode::Internal, format!("import task failed: {e}"))
        })?,
        Err(_) => {
            // Stops the copy at its next read; the temp file is dropped, never committed.
            token.cancel();
            Err(CommandError::new(
                ErrorCode::Timeout,
                format!(
                    "import did not finish within {} s",
                    IMPORT_TIMEOUT.as_secs()
                ),
            ))
        }
    }
}

/// Library listing: title search, filter (all / favorites / received / opened, tag) and sort.
#[tauri::command]
#[specta::specta]
pub async fn list_documents(
    library: State<'_, Arc<Library>>,
    query: LibraryQuery,
) -> CommandResult<Vec<Document>> {
    Ok(library.list_documents(&query)?)
}

/// The reader's position (zero-based page); restored when the document opens again.
#[tauri::command]
#[specta::specta]
pub async fn set_last_page(
    library: State<'_, Arc<Library>>,
    id: String,
    page: u32,
) -> CommandResult<Document> {
    Ok(library.set_last_page(&id, page)?)
}

/// Idempotent: sets the flag, does not toggle it.
#[tauri::command]
#[specta::specta]
pub async fn set_favorite(
    library: State<'_, Arc<Library>>,
    id: String,
    favorite: bool,
) -> CommandResult<Document> {
    Ok(library.set_favorite(&id, favorite)?)
}

/// Changes the library title only; the stored file keeps its name. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn rename_document(
    library: State<'_, Arc<Library>>,
    id: String,
    title: String,
) -> CommandResult<Document> {
    Ok(library.rename_document(&id, &title)?)
}

/// Removes a document from the library: rows in one transaction, then the
/// library's own files (copy, versions, thumbnail). A linked document's
/// external file is never touched.
#[tauri::command]
#[specta::specta]
pub async fn delete_document(
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<DeleteReport> {
    let library = Arc::clone(&library);
    tauri::async_runtime::spawn_blocking(move || library.delete_document(&id))
        .await
        .map_err(|e| CommandError::new(ErrorCode::Internal, format!("delete task failed: {e}")))?
        .map_err(CommandError::from)
}

/// Deletes every version of a document but the current one (v1 included):
/// the explicit choice offered after a redaction (ADR 0009). Returns how many
/// versions went. Idempotent (a repeat removes nothing).
#[tauri::command]
#[specta::specta]
pub async fn delete_earlier_versions(
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<u32> {
    let library = Arc::clone(&library);
    tauri::async_runtime::spawn_blocking(move || library.delete_earlier_versions(&id))
        .await
        .map_err(|e| CommandError::new(ErrorCode::Internal, format!("delete task failed: {e}")))?
        .map(|report| report.removed_versions)
        .map_err(CommandError::from)
}

/// Resolves the stored copy without marking the document as opened
/// (used to render its thumbnail in the background).
#[tauri::command]
#[specta::specta]
pub async fn document_file(
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<DocumentFile> {
    Ok(library.document_file(&id)?)
}

/// Stores the page-1 thumbnail (WebP, or PNG/JPEG where the WebView cannot
/// encode WebP) rendered by the engine worker. Idempotent per document.
#[tauri::command]
#[specta::specta]
pub async fn save_thumbnail(
    library: State<'_, Arc<Library>>,
    id: String,
    image: Vec<u8>,
) -> CommandResult<Document> {
    let library = Arc::clone(&library);
    tauri::async_runtime::spawn_blocking(move || library.save_thumbnail(&id, &image))
        .await
        .map_err(|e| CommandError::new(ErrorCode::Internal, format!("thumbnail task failed: {e}")))?
        .map_err(CommandError::from)
}

/// Resolves a library document to its stored copy for the viewer.
/// The returned path is readable through the asset protocol (library dir only).
#[tauri::command]
#[specta::specta]
pub async fn read_document(
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<DocumentFile> {
    Ok(library.read_document(&id)?)
}

/// Saves page count (and the PDF's own title when the file name was unusable)
/// once the engine has opened the document.
#[tauri::command]
#[specta::specta]
pub async fn record_document_info(
    library: State<'_, Arc<Library>>,
    id: String,
    page_count: u32,
    pdf_title: Option<String>,
) -> CommandResult<Document> {
    Ok(library.record_document_info(&id, page_count, pdf_title.as_deref())?)
}

/// Best-effort display name. SAF URIs often encode the file name in the last
/// segment (`.../document/primary%3ADownload%2FReport.pdf`); opaque ones
/// (`msf:123`) yield an empty title and the PDF metadata title is used later.
fn title_for_source(source: &str) -> String {
    let decoded = percent_decode(source);
    let last = decoded
        .rsplit(['/', '\\', ':'])
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    if source.contains("://") && !last.to_ascii_lowercase().ends_with(".pdf") {
        return String::new();
    }
    title_from_file_name(last)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push(h << 4 | l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_from_sources() {
        assert_eq!(
            title_for_source(
                "content://com.android.externalstorage.documents/document/primary%3ADownload%2FSelis%20Report.pdf"
            ),
            "Selis Report"
        );
        assert_eq!(
            title_for_source(
                "content://com.android.providers.downloads.documents/document/msf%3A1000000033"
            ),
            ""
        );
        assert_eq!(
            title_for_source(r"C:\Users\me\Docs\Συμβόλαιο.pdf"),
            "Συμβόλαιο"
        );
        assert_eq!(title_for_source("/home/me/notes.PDF"), "notes");
        assert_eq!(
            title_for_source("file:///private/var/mobile/Inbox/%CE%B1%CE%B2.pdf"),
            "αβ"
        );
    }

    #[test]
    fn percent_decode_handles_truncated_escapes() {
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%41%42"), "AB");
    }
}
