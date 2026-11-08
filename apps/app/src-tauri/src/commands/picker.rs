//! System file picker, driven from Rust so its outcome goes through the request
//! store (`take_result` can recover it if the reply is lost; see
//! docs/adr/0005-ipc-reliability.md).

use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PickOutcome {
    Picked { source: String },
    Cancelled,
}

/// How many granted sources are remembered (the oldest go first).
const MAX_GRANTED: usize = 256;

/// The sources Rust handed to the UI: a pick the user made (PDF, document, photos, pack), or a
/// document another app sent ("Open with"). Commands that open a source from the UI open only
/// these (see [`granted_source`]), never a path or URI the UI made up (security audit run-1,
/// lead 7).
#[derive(Default)]
pub struct GrantedSources(Mutex<VecDeque<String>>);

impl GrantedSources {
    pub fn grant(&self, source: &str) {
        let mut list = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if list.iter().any(|s| s == source) {
            return;
        }
        if list.len() >= MAX_GRANTED {
            list.pop_front();
        }
        list.push_back(source.to_owned());
    }

    pub fn contains(&self, source: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|s| s == source)
    }
}

/// Records `source` as handed to the UI (see [`GrantedSources`]).
pub(crate) fn grant<R: Runtime>(app: &AppHandle<R>, source: &str) {
    if let Some(granted) = app.try_state::<Arc<GrantedSources>>() {
        granted.grant(source);
    }
}

/// The one way a command turns a source string from the UI into something to open: only a
/// source a picker or "Open with" handed out (security audit run-1, lead 7), or, in debug and
/// `measure` builds, a file the host pushed into the app's own `dev-inbox` cache folder (the
/// measurement scripts). Anything else — a path or URI the UI made up — is refused before
/// anything is opened.
pub(crate) fn granted_source<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
) -> CommandResult<FilePath> {
    let source = source.trim();
    let granted = app
        .try_state::<Arc<GrantedSources>>()
        .is_some_and(|g| g.contains(source));
    if granted || dev_inbox(app).is_some_and(|inbox| in_folder(&inbox, source)) {
        return parse_source(source);
    }
    Err(CommandError::new(
        ErrorCode::InvalidArgument,
        "not a picked or shared document",
    ))
}

#[cfg(any(debug_assertions, feature = "measure"))]
fn dev_inbox<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join(DEV_INBOX))
}

#[cfg(not(any(debug_assertions, feature = "measure")))]
fn dev_inbox<R: Runtime>(_app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    None
}

/// The cache folder debug / `measure` builds also read sources from (see [`granted_source`]).
#[cfg_attr(not(any(debug_assertions, feature = "measure")), allow(dead_code))]
pub(crate) const DEV_INBOX: &str = "dev-inbox";

/// Whether `source` is a plain path to a file directly inside `folder` (after resolving `..`
/// and links, so nothing outside it can be named).
fn in_folder(folder: &std::path::Path, source: &str) -> bool {
    if source.contains("://") {
        return false;
    }
    let (Ok(folder), Ok(file)) = (std::fs::canonicalize(folder), std::fs::canonicalize(source))
    else {
        return false;
    };
    file.is_file() && file.parent() == Some(folder.as_path())
}

fn parse_source(source: &str) -> CommandResult<FilePath> {
    if source.contains("://") {
        source
            .parse::<FilePath>()
            .map_err(|e| CommandError::new(ErrorCode::InvalidArgument, format!("bad URI: {e}")))
    } else {
        Ok(FilePath::Path(std::path::PathBuf::from(source)))
    }
}

pub(crate) fn to_source(path: FilePath) -> String {
    match path {
        FilePath::Url(url) => url.to_string(),
        FilePath::Path(path) => path.to_string_lossy().into_owned(),
    }
}

/// Opens the system picker for one PDF. Cancel (or a picker failure) yields
/// `Cancelled`. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn pick_pdf<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<PickOutcome> {
    results
        .run_once(&request_id, "pick_pdf", async move {
            tauri::async_runtime::spawn_blocking(move || {
                match app
                    .dialog()
                    .file()
                    .add_filter("PDF", &["pdf"])
                    .blocking_pick_file()
                {
                    Some(path) => {
                        let source = to_source(path);
                        grant(&app, &source);
                        PickOutcome::Picked { source }
                    }
                    None => PickOutcome::Cancelled,
                }
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}")))
        })
        .await
}

/// File types "Convert to PDF" reads (ADR 0035).
const CONVERTIBLE: &[&str] = &[
    "docx", "xlsx", "csv", "txt", "md", "markdown", "html", "htm",
];

/// Opens the system picker for one document to convert to PDF (Word, Excel, CSV, text,
/// Markdown, HTML). Cancel yields `Cancelled`. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn pick_document<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<PickOutcome> {
    results
        .run_once(&request_id, "pick_document", async move {
            tauri::async_runtime::spawn_blocking(move || {
                match app
                    .dialog()
                    .file()
                    .add_filter("Documents", CONVERTIBLE)
                    .blocking_pick_file()
                {
                    Some(path) => {
                        let source = to_source(path);
                        grant(&app, &source);
                        PickOutcome::Picked { source }
                    }
                    None => PickOutcome::Cancelled,
                }
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}")))
        })
        .await
}

/// Largest picture accepted for a signature (phone photos are 2–8 MB).
const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PickedImage {
    Picked {
        mime: String,
        /// Base64 of the file (the Android IPC carries JSON only).
        data: String,
    },
    Cancelled,
}

/// PNG, JPEG or WebP by their magic bytes (what every WebView decodes).
fn image_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Opens the system picker for one picture (a signature photographed on paper)
/// and returns its bytes. The file is opened read-only and never kept. Runs
/// once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn pick_image<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<PickedImage> {
    results
        .run_once(&request_id, "pick_image", async move {
            tauri::async_runtime::spawn_blocking(move || {
                let Some(path) = app
                    .dialog()
                    .file()
                    .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
                    .blocking_pick_file()
                else {
                    return Ok(PickedImage::Cancelled);
                };
                let mut opts = OpenOptions::new();
                opts.read(true);
                let file = app.fs().open(path, opts).map_err(|e| {
                    CommandError::new(ErrorCode::Io, format!("cannot open image: {e}"))
                })?;
                let mut bytes = Vec::new();
                file.take(MAX_IMAGE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| {
                        CommandError::new(ErrorCode::Io, format!("cannot read image: {e}"))
                    })?;
                if bytes.len() as u64 > MAX_IMAGE_BYTES {
                    return Err(CommandError::new(
                        ErrorCode::InvalidArgument,
                        "image too large",
                    ));
                }
                let mime = image_mime(&bytes).ok_or_else(|| {
                    CommandError::new(ErrorCode::Unsupported, "not a PNG, JPEG or WebP image")
                })?;
                Ok(PickedImage::Picked {
                    mime: mime.to_owned(),
                    data: STANDARD.encode(&bytes),
                })
            })
            .await
            .map_err(|e| {
                CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}"))
            })?
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{GrantedSources, MAX_GRANTED, image_mime};

    /// Security audit run-1, lead 7: only sources handed out are staged.
    #[test]
    fn only_granted_sources_are_known_and_the_oldest_go_first() {
        let granted = GrantedSources::default();
        assert!(!granted.contains("/data/data/com.anywecon.selis/selis.db"));
        granted.grant("content://picked/1");
        granted.grant("content://picked/1");
        assert!(granted.contains("content://picked/1"));
        for i in 0..MAX_GRANTED {
            granted.grant(&format!("content://picked/{}", i + 2));
        }
        assert!(!granted.contains("content://picked/1"));
        assert!(granted.contains(&format!("content://picked/{}", MAX_GRANTED + 1)));
    }

    #[test]
    fn recognises_png_jpeg_webp_only() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_mime(b"GIF89a"), None);
        assert_eq!(image_mime(b"%PDF-1.7"), None);
    }
}
