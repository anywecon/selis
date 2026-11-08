//! Images → PDF and page export (P4b, ADR 0017).
//!
//! - Android: the system photo picker (`PhotoPickerPlugin.kt`: several images, no storage
//!   permission). iOS and desktop pick with an `<input type="file">` in the WebView (WKWebView
//!   shows PHPicker), so `pick_photos` reports `unsupported` there.
//! - Each picked photo is copied into the stage (`stage_photo`), read by the UI through the
//!   asset protocol and `unstage`d; the PDF is built in the engine worker.
//! - An exported page image arrives as an upload and goes to the share sheet / save dialog
//!   under its name (`share_export`).

use std::sync::Arc;

use selis_core::Library;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

/// Most photos one pick may return.
const MAX_PHOTOS: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PhotoPick {
    Picked { sources: Vec<String> },
    Cancelled,
}

/// Opens the photo picker (Android) for at most `max` photos (1: a single-photo picker, as
/// Scan uses). Elsewhere: `unsupported` (the UI uses a file input).
#[tauri::command]
#[specta::specta]
pub async fn pick_photos<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    max: u32,
) -> CommandResult<PhotoPick> {
    results
        .run_once(&request_id, "pick_photos", async move {
            let pick = platform::pick(&app, max.clamp(1, MAX_PHOTOS)).await?;
            if let PhotoPick::Picked { sources } = &pick {
                for source in sources {
                    super::picker::grant(&app, source);
                }
            }
            Ok(pick)
        })
        .await
}

/// Copies one picked photo (a path or content:// URI, opened read-only) into the stage and
/// returns its path for the asset protocol. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn stage_photo<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    source: String,
) -> CommandResult<String> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "stage_photo", async move {
            let path = super::picker::granted_source(&app, &source)?;
            tauri::async_runtime::spawn_blocking(move || {
                let mut opts = OpenOptions::new();
                opts.read(true);
                let file = app.fs().open(path, opts).map_err(|e| {
                    CommandError::new(ErrorCode::Io, format!("cannot open photo: {e}"))
                })?;
                let staged = library.stage_image(file)?;
                Ok(staged.to_string_lossy().into_owned())
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?
        })
        .await
}

/// Shares (Android) or saves (desktop: save dialog) a finished upload — an exported page image,
/// or a Word / text / Markdown / ZIP export (ADR 0035) — under `name`. `false` when the save
/// dialog was cancelled. The upload is consumed.
#[tauri::command]
#[specta::specta]
pub async fn share_export<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    upload_id: String,
    name: String,
    mime: String,
) -> CommandResult<bool> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "share_export", async move {
            // Page images (P4b) and the exports of P7c (ADR 0035): Word, text, Markdown, a ZIP of pages.
            let mime = match mime.as_str() {
                "image/png"
                | "image/jpeg"
                | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                | "text/plain"
                | "text/markdown"
                | "application/zip" => mime,
                _ => {
                    return Err(CommandError::new(
                        ErrorCode::InvalidArgument,
                        "not an export type",
                    ));
                }
            };
            let name = safe_name(&name);
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?
                .join("share");
            std::fs::create_dir_all(&dir)
                .map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?;
            let dest = dir.join(&name);
            let moved = dest.clone();
            let lib = Arc::clone(&library);
            tauri::async_runtime::spawn_blocking(move || lib.move_upload(&upload_id, &moved))
                .await
                .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))??;
            let shared = super::share::share_file(&app, &dest, &name, &mime).await;
            // Desktop saved a copy through the dialog; Android: the receiving app reads it later
            // (the share folder is swept, see SharePlugin.kt).
            #[cfg(not(target_os = "android"))]
            let _ = std::fs::remove_file(&dest);
            shared
        })
        .await
}

/// A file name for the share sheet: no path separators or control characters, ≤ 120 chars.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "page".into()
    } else {
        cleaned
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-photos")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.anywecon.selis", "PhotoPickerPlugin")?;
                app.manage(platform::PhotoHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod platform {
    use serde::{Deserialize, Serialize};
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    use super::{CommandError, CommandResult, ErrorCode, PhotoPick};

    pub struct PhotoHandle<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    struct PickArgs {
        max: u32,
    }

    #[derive(Deserialize)]
    struct Picked {
        uris: Vec<String>,
    }

    pub async fn pick<R: Runtime>(app: &AppHandle<R>, max: u32) -> CommandResult<PhotoPick> {
        let handle = app
            .try_state::<PhotoHandle<R>>()
            .ok_or_else(|| CommandError::new(ErrorCode::Unsupported, "photo picker not loaded"))?;
        let picked: Picked = handle
            .0
            .run_mobile_plugin_async("pick", PickArgs { max })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("photo picker: {e}")))?;
        Ok(if picked.uris.is_empty() {
            PhotoPick::Cancelled
        } else {
            PhotoPick::Picked {
                sources: picked.uris,
            }
        })
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use tauri::{AppHandle, Runtime};

    use super::{CommandError, CommandResult, ErrorCode, PhotoPick};

    pub async fn pick<R: Runtime>(_app: &AppHandle<R>, _max: u32) -> CommandResult<PhotoPick> {
        Err(CommandError::new(
            ErrorCode::Unsupported,
            "no native photo picker here: use a file input",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn share_names_are_plain_file_names() {
        assert_eq!(safe_name("Report p3.png"), "Report p3.png");
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name("a\u{0}b/c.jpg"), "a_b_c.jpg");
        assert_eq!(safe_name("   "), "page");
        assert_eq!(safe_name(".hidden.png"), "hidden.png");
        assert_eq!(safe_name(&"x".repeat(300)).chars().count(), 120);
    }
}
