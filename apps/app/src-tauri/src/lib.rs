//! Tauri builder, plugins and state. Commands live in `commands/` and only
//! delegate to `selis-core`. Nothing here opens a network connection: the
//! transfer endpoint (`selis-transfer`) exists only while the Transfer screen
//! is open (`commands/transfer.rs`).

mod commands;
#[cfg(debug_assertions)]
mod debug_log;
mod device_key;
mod requests;

use std::sync::Arc;

use selis_core::Library;
use tauri::Manager;
use tauri_specta::{Builder, collect_commands};

/// Kept in the binary of `--features measure` builds only (see `setup`).
#[cfg(feature = "measure")]
const MEASURE_BUILD_MARKER: &str = "SELIS_MEASURE_BUILD: WebView debugging enabled";

/// Single source of truth for the IPC surface. `ipc.ts` is generated from it
/// (see the `export_bindings` test).
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::library::import_document::<tauri::Wry>,
        commands::library::list_documents,
        commands::library::read_document,
        commands::library::record_document_info,
        commands::library::set_favorite,
        commands::library::set_last_page,
        commands::library::rename_document,
        commands::library::delete_document,
        commands::library::delete_earlier_versions,
        commands::library::document_file,
        commands::library::save_thumbnail,
        commands::save::upload_chunk,
        commands::save::abort_upload,
        commands::save::commit_working_copy,
        commands::save::working_copy,
        commands::save::discard_working_copy,
        commands::save::save_version,
        commands::save::import_upload,
        commands::save::stage_pdf::<tauri::Wry>,
        commands::save::unstage,
        commands::signatures::list_signatures,
        commands::signatures::save_signature,
        commands::signatures::delete_signature,
        commands::tags::list_tags,
        commands::tags::create_tag,
        commands::tags::rename_tag,
        commands::tags::delete_tag,
        commands::tags::set_document_tags,
        commands::open_with::pending_opens::<tauri::Wry>,
        commands::open_with::dismiss_open,
        commands::open_with::pending_transfer_link::<tauri::Wry>,
        commands::open_with::dismiss_transfer_link,
        commands::share::share_document::<tauri::Wry>,
        commands::settings::get_settings,
        commands::settings::update_settings,
        commands::device::device_memory::<tauri::Wry>,
        commands::picker::pick_pdf::<tauri::Wry>,
        commands::picker::pick_image::<tauri::Wry>,
        commands::transfer::transfer_open::<tauri::Wry>,
        commands::transfer::transfer_close::<tauri::Wry>,
        commands::transfer::transfer_offer,
        commands::transfer::transfer_send_status,
        commands::transfer::transfer_decide,
        commands::transfer::transfer_cancel_send,
        commands::transfer::transfer_receive::<tauri::Wry>,
        commands::transfer::transfer_receive_status,
        commands::transfer::transfer_cancel_receive::<tauri::Wry>,
        commands::transfer::transfer_resumable,
        commands::transfer::transfer_resume::<tauri::Wry>,
        commands::transfer::transfer_pause,
        commands::transfer::transfer_foreground::<tauri::Wry>,
        commands::transfer::transfer_foreground_stop::<tauri::Wry>,
        commands::transfer::transfer_notifications::<tauri::Wry>,
        commands::transfer::transfer_receiving::<tauri::Wry>,
        commands::transfer::transfer_incoming::<tauri::Wry>,
        commands::transfer::transfer_trusted,
        commands::transfer::transfer_trust,
        commands::transfer::transfer_untrust,
        commands::transfer::transfer_ping,
        commands::transfer::transfer_push,
        commands::transfer::transfer_move_summary,
        commands::transfer::transfer_move_offer,
        commands::transfer::transfer_move_push,
        commands::transfer::transfer_debug_force_relay,
        commands::pack::pack_kind::<tauri::Wry>,
        commands::pack::pack_export::<tauri::Wry>,
        commands::pack::pack_import::<tauri::Wry>,
        commands::pack::pick_pack::<tauri::Wry>,
        commands::tools::document_protection,
        commands::tools::run_tool,
        commands::photos::pick_photos::<tauri::Wry>,
        commands::photos::stage_photo::<tauri::Wry>,
        commands::photos::share_export::<tauri::Wry>,
        commands::convert::convert_available::<tauri::Wry>,
        commands::picker::pick_document::<tauri::Wry>,
        commands::convert::stage_source::<tauri::Wry>,
        commands::convert::convert_html_to_pdf::<tauri::Wry>,
        commands::convert::import_staged,
        commands::camera::open_app_settings::<tauri::Wry>,
        commands::camera::scan_haptic::<tauri::Wry>,
        commands::requests::take_result,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(commands::open_with::init())
        .plugin(commands::share::init())
        .plugin(commands::photos::init())
        .plugin(commands::convert::init())
        .plugin(commands::camera::init())
        .plugin(commands::transfer::init())
        .plugin(device_key::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            // `scripts/check-release-apk.sh` fails a store APK that contains this marker.
            #[cfg(feature = "measure")]
            std::hint::black_box(MEASURE_BUILD_MARKER);
            builder.mount_events(app);
            #[cfg(debug_assertions)]
            debug_log::init(&app.path().app_cache_dir()?);
            // A pack shared before (perhaps unencrypted) never outlives the run (PRIVACY.md).
            commands::pack::sweep_packs_at_start(app.handle());
            let root = app.path().app_data_dir()?;
            let library = Library::open(root)?;
            // A transfer "active" in the database belonged to a process that died.
            let _ = library.transfers_mark_interrupted();
            app.manage(Arc::new(library));
            // Empty: no endpoint, no socket until the Transfer screen opens.
            app.manage(Arc::new(commands::transfer::TransferState::default()));
            app.manage(Arc::new(requests::RequestResults::default()));
            app.manage(Arc::new(commands::open_with::OpenQueue::default()));
            app.manage(Arc::new(commands::picker::GrantedSources::default()));
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(on_run_event),
        Err(err) => {
            // Nothing sensible to recover to; surface the reason in platform logs.
            eprintln!("selis: fatal error while running the application: {err}");
            std::process::exit(1);
        }
    }
}

/// iOS (and macOS) deliver "Open in Selis" documents as file URLs here. Android
/// uses OpenWithPlugin.kt instead (tao's own intent parsing is ignored).
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    if let tauri::RunEvent::Opened { urls } = &event
        && let Some(queue) = app.try_state::<Arc<commands::open_with::OpenQueue>>()
    {
        for url in urls.iter().filter(|u| u.scheme() == "file") {
            queue.push(url.to_string(), None);
        }
        for url in urls.iter().filter(|u| u.scheme() == "selis") {
            queue.push_link(url.as_str());
        }
    }
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    let _ = (app, event);
}

#[cfg(test)]
mod tests {
    use specta_typescript::Typescript;

    /// Regenerates `apps/app/src/lib/ipc/bindings.ts`. CI fails if the committed file differs.
    #[test]
    fn export_bindings() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/ipc/bindings.ts");
        super::specta_builder()
            .export(
                Typescript::default()
                    .header("// @generated by tauri-specta from apps/app/src-tauri. Do not edit.\n/* eslint-disable */"),
                &path,
            )
            .expect("failed to export TypeScript bindings");
    }
}
