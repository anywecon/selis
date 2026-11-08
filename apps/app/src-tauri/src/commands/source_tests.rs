//! Every command that opens a source string from the UI opens only a granted one (security
//! audit run-1, lead 7): a path the UI made up is refused before anything is read, the same
//! file handed out by a picker or "Open with" is accepted. Runs the real commands on Tauri's
//! mock runtime.

use std::path::Path;
use std::sync::Arc;

use selis_core::{Library, PackRequest};
use tauri::Manager;
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

use super::picker::GrantedSources;
use super::{CommandError, ErrorCode};
use crate::requests::RequestResults;

struct Fixture {
    app: tauri::App<MockRuntime>,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let app = mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(mock_context(noop_assets()))
            .expect("mock app");
        app.manage(Arc::new(
            Library::open(dir.path().join("app")).expect("library"),
        ));
        app.manage(Arc::new(RequestResults::default()));
        app.manage(Arc::new(GrantedSources::default()));
        Self { app, dir }
    }

    fn handle(&self) -> tauri::AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    fn library(&self) -> tauri::State<'_, Arc<Library>> {
        self.app.state::<Arc<Library>>()
    }

    fn results(&self) -> tauri::State<'_, Arc<RequestResults>> {
        self.app.state::<Arc<RequestResults>>()
    }

    /// A real file outside anything handed out (another app's or our own private file).
    fn foreign(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.dir.path().join(name);
        std::fs::write(&path, bytes).expect("write");
        path.to_string_lossy().into_owned()
    }

    /// The same kind of file, as a picker would hand it out.
    fn picked(&self, name: &str, bytes: &[u8]) -> String {
        let source = self.foreign(name, bytes);
        self.app.state::<Arc<GrantedSources>>().grant(&source);
        source
    }
}

const PDF: &[u8] = b"%PDF-1.7\n% picked\n%%EOF\n";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

fn refused<T: std::fmt::Debug>(result: Result<T, CommandError>) {
    match result {
        Err(e) => assert!(
            matches!(e.code, ErrorCode::InvalidArgument),
            "refused for the wrong reason: {e:?}"
        ),
        Ok(v) => panic!("a source the UI made up was opened: {v:?}"),
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

#[test]
fn import_document_opens_only_a_granted_source() {
    let fx = Fixture::new();
    let foreign = fx.foreign("private.pdf", PDF);
    refused(block_on(super::library::import_document(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r1".into(),
        foreign,
        None,
    )));
    assert!(
        fx.library()
            .list_documents(&Default::default())
            .expect("list")
            .is_empty()
    );
    let picked = fx.picked("picked.pdf", PDF);
    let outcome = block_on(super::library::import_document(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r2".into(),
        picked,
        None,
    ))
    .expect("a picked PDF imports");
    assert!(!outcome.duplicate, "{outcome:?}");
    assert_eq!(
        fx.library()
            .list_documents(&Default::default())
            .expect("list")
            .len(),
        1
    );
}

#[test]
fn stage_pdf_opens_only_a_granted_source() {
    let fx = Fixture::new();
    let foreign = fx.foreign("private.pdf", PDF);
    refused(block_on(super::save::stage_pdf(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r1".into(),
        foreign,
    )));
    let picked = fx.picked("picked.pdf", PDF);
    let staged = block_on(super::save::stage_pdf(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r2".into(),
        picked,
    ))
    .expect("a picked PDF is staged");
    assert_eq!(std::fs::read(staged).expect("staged"), PDF);
}

#[test]
fn stage_photo_opens_only_a_granted_source() {
    let fx = Fixture::new();
    let foreign = fx.foreign("private.png", PNG);
    refused(block_on(super::photos::stage_photo(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r1".into(),
        foreign,
    )));
    let picked = fx.picked("picked.png", PNG);
    let staged = block_on(super::photos::stage_photo(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r2".into(),
        picked,
    ))
    .expect("a picked photo is staged");
    assert_eq!(std::fs::read(staged).expect("staged"), PNG);
}

#[test]
fn stage_source_opens_only_a_granted_source() {
    let fx = Fixture::new();
    let foreign = fx.foreign("private.txt", b"secret");
    refused(block_on(super::convert::stage_source(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r1".into(),
        foreign,
    )));
    let picked = fx.picked("picked.txt", b"hello");
    let staged = block_on(super::convert::stage_source(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r2".into(),
        picked,
    ))
    .expect("a picked document is staged");
    assert_eq!(std::fs::read(staged).expect("staged"), b"hello");
}

/// A plain pack of one document, written by another library.
fn pack_bytes(dir: &Path) -> Vec<u8> {
    let other = Library::open(dir.join("other")).expect("library");
    other
        .import_reader(PDF, "packed")
        .expect("import into the other library");
    let out = dir.join("out.selispack");
    other
        .export_pack(
            &out,
            &PackRequest {
                document_ids: None,
                include_history: false,
                passphrase: None,
            },
        )
        .expect("export");
    std::fs::read(out).expect("pack")
}

#[test]
fn pack_kind_opens_only_a_granted_source() {
    let fx = Fixture::new();
    let bytes = pack_bytes(fx.dir.path());
    let foreign = fx.foreign("private.selispack", &bytes);
    refused(block_on(super::pack::pack_kind(fx.handle(), foreign)));
    let picked = fx.picked("picked.selispack", &bytes);
    let kind = block_on(super::pack::pack_kind(fx.handle(), picked)).expect("sniffed");
    assert!(kind.is_some(), "a picked pack is recognised");
}

#[test]
fn pack_import_opens_only_a_granted_source() {
    let fx = Fixture::new();
    let bytes = pack_bytes(fx.dir.path());
    let foreign = fx.foreign("private.selispack", &bytes);
    refused(block_on(super::pack::pack_import(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r1".into(),
        foreign,
        None,
    )));
    assert!(
        fx.library()
            .list_documents(&Default::default())
            .expect("list")
            .is_empty()
    );
    let picked = fx.picked("picked.selispack", &bytes);
    let view = block_on(super::pack::pack_import(
        fx.handle(),
        fx.library(),
        fx.results(),
        "r2".into(),
        picked,
        None,
    ))
    .expect("a picked pack imports");
    assert!(
        matches!(&view, super::pack::PackImportView::Imported { document_ids, .. } if document_ids.len() == 1),
        "{view:?}"
    );
    cleanup_share_dir(&fx);
}

/// The dev inbox (debug and `measure` builds) admits only files directly inside it.
#[test]
fn the_dev_inbox_admits_no_path_out_of_it() {
    let fx = Fixture::new();
    let cache = fx.app.path().app_cache_dir().expect("cache dir");
    let inbox = cache.join(super::picker::DEV_INBOX);
    std::fs::create_dir_all(&inbox).expect("inbox");
    let inside = inbox.join("source-test.pdf");
    std::fs::write(&inside, PDF).expect("write");
    // A file next to the inbox, named through it.
    let outside = cache.join("source-test-outside.pdf");
    std::fs::write(&outside, PDF).expect("write");
    let escape = inbox.join("..").join("source-test-outside.pdf");
    let escape = escape.to_string_lossy().into_owned();
    assert!(super::picker::granted_source(&fx.handle(), &inside.to_string_lossy()).is_ok());
    refused(super::picker::granted_source(&fx.handle(), &escape));
    refused(super::picker::granted_source(
        &fx.handle(),
        &format!("file://{}", inside.display()),
    ));
    let _ = std::fs::remove_file(&inside);
    let _ = std::fs::remove_file(&outside);
    let _ = std::fs::remove_dir(&inbox);
    let _ = std::fs::remove_dir(&cache);
}

fn cleanup_share_dir(fx: &Fixture) {
    if let Ok(cache) = fx.app.path().app_cache_dir() {
        let _ = std::fs::remove_dir(cache.join("share"));
        let _ = std::fs::remove_dir(&cache);
    }
}
