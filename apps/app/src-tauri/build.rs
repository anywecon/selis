const APP_COMMANDS: &[&str] = &[
    "import_document",
    "list_documents",
    "read_document",
    "record_document_info",
    "set_favorite",
    "set_last_page",
    "rename_document",
    "delete_document",
    "delete_earlier_versions",
    "document_file",
    "save_thumbnail",
    "upload_chunk",
    "abort_upload",
    "commit_working_copy",
    "working_copy",
    "discard_working_copy",
    "save_version",
    "import_upload",
    "stage_pdf",
    "unstage",
    "list_signatures",
    "save_signature",
    "delete_signature",
    "list_tags",
    "create_tag",
    "rename_tag",
    "delete_tag",
    "set_document_tags",
    "pending_opens",
    "dismiss_open",
    "share_document",
    "get_settings",
    "update_settings",
    "device_memory",
    "pick_pdf",
    "pick_image",
    "pending_transfer_link",
    "dismiss_transfer_link",
    "transfer_open",
    "transfer_close",
    "transfer_offer",
    "transfer_send_status",
    "transfer_decide",
    "transfer_cancel_send",
    "transfer_receive",
    "transfer_receive_status",
    "transfer_cancel_receive",
    "transfer_ticket_sender",
    "transfer_resumable",
    "transfer_resume",
    "transfer_pause",
    "transfer_foreground",
    "transfer_foreground_stop",
    "transfer_notifications",
    "transfer_receiving",
    "transfer_incoming",
    "transfer_trusted",
    "transfer_trust",
    "transfer_untrust",
    "transfer_ping",
    "transfer_push",
    "transfer_move_summary",
    "transfer_move_offer",
    "transfer_move_push",
    "transfer_debug_force_relay",
    "pack_kind",
    "pack_export",
    "pack_import",
    "pick_pack",
    "document_protection",
    "run_tool",
    "pick_photos",
    "stage_photo",
    "share_export",
    "convert_available",
    "pick_document",
    "stage_source",
    "convert_html_to_pdf",
    "import_staged",
    "open_app_settings",
    "scan_haptic",
    "take_result",
];

fn main() {
    // Declaring the app commands makes them deny-by-default: each one must be
    // granted explicitly in `capabilities/*.json`.
    let mut attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));

    // On Windows the Common-Controls v6 manifest is embedded through the linker
    // instead of the resource file, so it also reaches the test binaries
    // (otherwise they abort with STATUS_ENTRYPOINT_NOT_FOUND).
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attrs =
            attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        println!("cargo:rustc-link-arg=/WX");
    }

    if let Err(err) = tauri_build::try_build(attrs) {
        panic!("tauri build script failed: {err:#}");
    }
}
