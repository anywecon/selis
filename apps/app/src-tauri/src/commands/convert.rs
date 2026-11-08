//! File conversion (P7c, ADR 0035). The UI turns a document into sanitised HTML; this
//! prints it to a PDF with the platform's own engine and no dialog (Android:
//! `ConvertPlugin.kt`), then imports the PDF once the user saves it. Desktop and iOS
//! report `unsupported` for now and the UI hides conversion there.

use std::sync::Arc;

use selis_core::{ImportOutcome, Library};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

/// Page sizes the print engine accepts, in points (a postcard up to A2).
const MIN_PAGE_PT: f64 = 200.0;
const MAX_PAGE_PT: f64 = 1700.0;

/// Whether this platform can print HTML to PDF without a dialog.
#[tauri::command]
#[specta::specta]
pub async fn convert_available<R: Runtime>(app: AppHandle<R>) -> CommandResult<bool> {
    Ok(platform::available(&app).await)
}

/// Copies a document picked for conversion (a path, or a content:// URI on Android) into the
/// stage, read-only, and returns its path for the asset protocol. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn stage_source<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    source: String,
) -> CommandResult<String> {
    let library = Arc::clone(&library);
    // Only a source a picker or "Open with" handed out: the stage is readable by the UI.
    let source = source.trim().to_owned();
    if !app
        .try_state::<Arc<super::picker::GrantedSources>>()
        .is_some_and(|g| g.contains(&source))
    {
        return Err(CommandError::new(
            ErrorCode::InvalidArgument,
            "not a picked or shared document",
        ));
    }
    results
        .run_once(&request_id, "stage_source", async move {
            let path = super::library::parse_source(&source)?;
            tauri::async_runtime::spawn_blocking(move || {
                let mut opts = OpenOptions::new();
                opts.read(true);
                let file = app.fs().open(path, opts).map_err(|e| {
                    CommandError::new(ErrorCode::Io, format!("cannot open source: {e}"))
                })?;
                let staged = library.stage_document(file)?;
                Ok(staged.to_string_lossy().into_owned())
            })
            .await
            .map_err(|e| {
                CommandError::new(ErrorCode::Internal, format!("stage task failed: {e}"))
            })?
        })
        .await
}

/// Prints a finished upload of sanitised HTML to a staged PDF of `width_pt` × `height_pt`
/// pages and returns the PDF's path (previewed through the asset protocol, then
/// `import_staged` or `unstage`). The HTML is deleted either way. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn convert_html_to_pdf<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    upload_id: String,
    width_pt: f64,
    height_pt: f64,
) -> CommandResult<String> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "convert_html_to_pdf", async move {
            let valid = |v: f64| v.is_finite() && (MIN_PAGE_PT..=MAX_PAGE_PT).contains(&v);
            if !valid(width_pt) || !valid(height_pt) {
                return Err(CommandError::new(
                    ErrorCode::InvalidArgument,
                    "page size out of range",
                ));
            }
            let lib = Arc::clone(&library);
            let (html, pdf) =
                tauri::async_runtime::spawn_blocking(move || lib.stage_conversion(&upload_id))
                    .await
                    .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))??;
            let printed = platform::print(&app, &html, &pdf, width_pt, height_pt).await;
            let _ = std::fs::remove_file(&html);
            let checked =
                printed.and_then(|()| library.check_staged_pdf(&pdf).map_err(CommandError::from));
            if let Err(e) = checked {
                let _ = std::fs::remove_file(&pdf);
                return Err(e);
            }
            Ok(pdf.to_string_lossy().into_owned())
        })
        .await
}

/// Imports a staged PDF (a conversion the user saved) as a new library document under
/// `title`, then removes it from the stage. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn import_staged(
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    path: String,
    title: String,
) -> CommandResult<ImportOutcome> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "import_staged", async move {
            tauri::async_runtime::spawn_blocking(move || library.import_staged(&path, &title))
                .await
                .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?
                .map_err(CommandError::from)
        })
        .await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-convert")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.anywecon.selis", "ConvertPlugin")?;
                app.manage(platform::ConvertHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod platform {
    use std::path::Path;

    use serde::{Deserialize, Serialize};
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    use super::{CommandError, CommandResult, ErrorCode};

    pub struct ConvertHandle<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PrintArgs<'a> {
        html: &'a str,
        pdf: &'a str,
        width_mils: u32,
        height_mils: u32,
    }

    #[derive(Deserialize)]
    struct Available {
        available: bool,
    }

    fn mils(points: f64) -> u32 {
        // Bounded by MIN/MAX_PAGE_PT: at most ~23 600 mils.
        (points / 72.0 * 1000.0).round() as u32
    }

    pub async fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
        let Some(handle) = app.try_state::<ConvertHandle<R>>() else {
            return false;
        };
        handle
            .0
            .run_mobile_plugin_async::<Available>("available", ())
            .await
            .is_ok_and(|a| a.available)
    }

    pub async fn print<R: Runtime>(
        app: &AppHandle<R>,
        html: &Path,
        pdf: &Path,
        width_pt: f64,
        height_pt: f64,
    ) -> CommandResult<()> {
        let handle = app.try_state::<ConvertHandle<R>>().ok_or_else(|| {
            CommandError::new(ErrorCode::Unsupported, "convert plugin not loaded")
        })?;
        handle
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "htmlToPdf",
                PrintArgs {
                    html: &html.to_string_lossy(),
                    pdf: &pdf.to_string_lossy(),
                    width_mils: mils(width_pt),
                    height_mils: mils(height_pt),
                },
            )
            .await
            .map(|_| ())
            .map_err(|e| {
                let message = e.to_string();
                let code = if message.contains("unsupported") {
                    ErrorCode::Unsupported
                } else if message.contains("timed out") {
                    ErrorCode::Timeout
                } else {
                    ErrorCode::Io
                };
                CommandError::new(code, format!("print: {message}"))
            })
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use std::path::Path;

    use tauri::{AppHandle, Runtime};

    use super::{CommandError, CommandResult, ErrorCode};

    pub async fn available<R: Runtime>(_app: &AppHandle<R>) -> bool {
        false
    }

    pub async fn print<R: Runtime>(
        _app: &AppHandle<R>,
        _html: &Path,
        _pdf: &Path,
        _width_pt: f64,
        _height_pt: f64,
    ) -> CommandResult<()> {
        Err(CommandError::new(
            ErrorCode::Unsupported,
            "no print engine without a dialog on this platform",
        ))
    }
}
