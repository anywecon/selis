//! Transfer screen (P3a, ADR 0010). The iroh endpoint exists only between
//! `transfer_open` (the screen opens) and `transfer_close` (it closes, or the
//! app goes to the background with nothing running): Selis opens no socket at
//! start or anywhere else. A running transfer keeps the endpoint alive (on
//! Android under a user-initiated data transfer job, `TransferPlugin.kt`, ADR 0027).
//!
//! Sending: `transfer_offer` → ticket (QR + link); the receiver connects, both
//! screens show the code, `transfer_decide` lets it fetch.
//! Receiving: `transfer_receive(link)` → code → progress → the documents are
//! verified, imported into the library (origin "received") and the transfer
//! store is emptied. A receive that stops mid-way keeps a resume token in the
//! `transfers` table and continues with `transfer_resume`, also after the app
//! was killed.
//!
//! Trusted devices (P3b, ADR 0014): after a transfer the user may save the
//! other device; then it can send here without QR code while the Receive tab is
//! open (`transfer_receiving`, `transfer_incoming`), and sends to it skip the
//! code (`transfer_push`). A library move (`transfer_move_*`) sends every
//! document with its versions, tags and favorite flag, the saved signatures and
//! the settings — never the device key — deduplicated by BLAKE3 on arrival.
//!
//! Long-running commands take a request id (ADR 0005).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use selis_core::{
    Library, LibraryQuery, LibrarySummary, ReceivedDocument, ReceivedFile, TransferDirection,
    TransferRowState, TransferUpdate, TrustedDevice,
};
use selis_transfer::{
    EndpointId, Have, Network, OfferItem, OfferLibrary, OfferSignature, OfferVersion, ReceiveState,
    ResumeInfo, Route, SecretKey, SendState, ServiceConfig, TransferError, TransferService,
    TransferTicket, qr,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};

use super::{CommandError, CommandResult, ErrorCode, settings};
use crate::device_key;
use crate::requests::RequestResults;

/// How often trackers look at a running transfer.
const POLL: Duration = Duration::from_millis(250);
/// How often a receive's progress is written to the `transfers` table.
const PERSIST_EVERY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TransferErrorCode {
    Expired,
    AlreadyUsed,
    Unknown,
    Declined,
    Unreachable,
    Interrupted,
    Mismatch,
    Protocol,
    Storage,
    Cancelled,
    /// Not a Selis transfer link.
    InvalidLink,
    /// A trusted device that does not trust this one, or whose Receive tab is closed.
    NotReady,
}

impl From<TransferError> for TransferErrorCode {
    fn from(e: TransferError) -> Self {
        match e {
            TransferError::Expired => Self::Expired,
            TransferError::AlreadyUsed => Self::AlreadyUsed,
            TransferError::Unknown => Self::Unknown,
            TransferError::Declined => Self::Declined,
            TransferError::Unreachable => Self::Unreachable,
            TransferError::Interrupted => Self::Interrupted,
            TransferError::Mismatch => Self::Mismatch,
            TransferError::Protocol => Self::Protocol,
            TransferError::Storage => Self::Storage,
            TransferError::Cancelled => Self::Cancelled,
            TransferError::NotReady => Self::NotReady,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RouteView {
    Lan,
    Direct,
    Relay,
    Unknown,
}

impl From<Route> for RouteView {
    fn from(r: Route) -> Self {
        match r {
            Route::Lan => Self::Lan,
            Route::Direct => Self::Direct,
            Route::Relay => Self::Relay,
            Route::Unknown => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SendView {
    WaitingForReceiver,
    #[serde(rename_all = "camelCase")]
    Confirm {
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Sending {
        #[specta(type = specta_typescript::Number)]
        bytes: u64,
        #[specta(type = specta_typescript::Number)]
        total: u64,
        route: RouteView,
    },
    /// The receiver dropped; it can come back while this screen stays open.
    #[serde(rename_all = "camelCase")]
    Interrupted {
        #[specta(type = specta_typescript::Number)]
        bytes: u64,
        #[specta(type = specta_typescript::Number)]
        total: u64,
    },
    /// `peer`: the device that received (hex id); `trusted`: already saved.
    #[serde(rename_all = "camelCase")]
    Done {
        peer: Option<String>,
        trusted: bool,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error: TransferErrorCode,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReceiveView {
    Connecting,
    #[serde(rename_all = "camelCase")]
    Confirm {
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Receiving {
        #[specta(type = specta_typescript::Number)]
        bytes: u64,
        #[specta(type = specta_typescript::Number)]
        total: u64,
        route: RouteView,
    },
    Verifying,
    /// Adding the documents to the library.
    Saving,
    #[serde(rename_all = "camelCase")]
    Done {
        document_ids: Vec<String>,
        duplicates: u32,
        /// Signatures added (library move).
        signatures: u32,
        /// A library move (settings applied too).
        moved: bool,
        /// The sending device (hex id) and whether it is already trusted.
        peer: Option<String>,
        trusted: bool,
    },
    /// Stopped mid-way (connection lost, app stopped, Android's daily limit):
    /// `transfer_resume` continues without fetching again what arrived.
    #[serde(rename_all = "camelCase")]
    Paused {
        #[specta(type = specta_typescript::Number)]
        bytes: u64,
        #[specta(type = specta_typescript::Number)]
        total: u64,
        /// Why it stopped (`unreachable`, `interrupted`); `None` when paused on purpose.
        reason: Option<TransferErrorCode>,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error: TransferErrorCode,
    },
}

impl ReceiveView {
    fn running(&self) -> bool {
        matches!(
            self,
            Self::Connecting
                | Self::Confirm { .. }
                | Self::Receiving { .. }
                | Self::Verifying
                | Self::Saving
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NetworkView {
    Default,
    LocalOnly,
    CustomRelay,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    /// This device's id as other devices see it (hex).
    pub device_id: String,
    pub network: NetworkView,
    /// A debug build (the "force relay" testing aid is available).
    pub debug: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    pub session_id: String,
    /// `selis://transfer/…` (the QR code's content, also for copying).
    pub link: String,
    /// The QR code, black on white (any theme).
    pub qr_svg: String,
    pub doc_count: u32,
    #[specta(type = specta_typescript::Number)]
    pub total_bytes: u64,
    /// Unix seconds after which the code is refused.
    #[specta(type = specta_typescript::Number)]
    pub expires_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PingView {
    pub online: bool,
    /// Its Receive tab is open and it trusts this device: a send can start.
    pub ready: bool,
}

/// A receive a trusted device started (its Receive tab shows it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IncomingView {
    pub id: String,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumableView {
    pub id: String,
    pub doc_count: u32,
    #[specta(type = specta_typescript::Number)]
    pub total_bytes: u64,
    #[specta(type = specta_typescript::Number)]
    pub done_bytes: u64,
    #[specta(type = specta_typescript::Number)]
    pub updated_at: i64,
}

/// Android plugin handle (`TransferPlugin.kt`). One Android plugin per Tauri
/// plugin: a second `register_android_plugin` in the same setup replaces the
/// first (the device key has its own, `device_key::init`).
#[cfg(target_os = "android")]
pub struct TransferPlugins<R: Runtime> {
    pub transfer: tauri::plugin::PluginHandle<R>,
}

/// Lives for the app; holds a service only while the Transfer screen is open.
#[derive(Default)]
pub struct TransferState {
    open: tokio::sync::Mutex<Option<Open>>,
    receives: Mutex<HashMap<String, ReceiveView>>,
    sends: Mutex<HashMap<String, SendView>>,
    /// The screen asked to close while something was running: close when it ends.
    close_requested: Mutex<bool>,
    #[cfg(debug_assertions)]
    force_relay: Mutex<bool>,
}

struct Open {
    service: Arc<TransferService>,
    network: NetworkView,
    /// Receive row id → its tracker.
    trackers: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    /// Ticket link → receive row id (a repeated scan joins the same receive).
    links: HashMap<String, String>,
    /// Receive row id → the service's session.
    sessions: HashMap<String, String>,
    /// Send session → its tracker and `transfers` row.
    send_tasks: HashMap<String, (tauri::async_runtime::JoinHandle<()>, String)>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn err(code: ErrorCode, msg: impl Into<String>) -> CommandError {
    CommandError::new(code, msg)
}

fn not_open() -> CommandError {
    err(
        ErrorCode::InvalidArgument,
        "the transfer screen is not open",
    )
}

impl TransferState {
    /// Whether the endpoint exists (tests: nothing listens before the screen opens).
    #[cfg(test)]
    async fn is_open(&self) -> bool {
        self.open.lock().await.is_some()
    }

    fn running(&self) -> bool {
        lock(&self.receives).values().any(ReceiveView::running)
            || lock(&self.sends)
                .values()
                .any(|s| matches!(s, SendView::Confirm { .. } | SendView::Sending { .. }))
    }

    async fn service(&self) -> CommandResult<Arc<TransferService>> {
        self.open
            .lock()
            .await
            .as_ref()
            .map(|o| Arc::clone(&o.service))
            .ok_or_else(not_open)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-transfer")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let transfer =
                    api.register_android_plugin("com.anywecon.selis", "TransferPlugin")?;
                app.manage(TransferPlugins { transfer });
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
async fn android_call<R: Runtime>(app: &AppHandle<R>, cmd: &str, args: serde_json::Value) {
    if let Some(p) = app.try_state::<TransferPlugins<R>>()
        && let Err(e) = p
            .transfer
            .run_mobile_plugin_async::<serde_json::Value>(cmd, args)
            .await
    {
        eprintln!("selis: transfer plugin {cmd}: {e}");
    }
}

/// Where a receive keeps its partial data: `<store>/in/<id>`. The id must be a plain id (1..=64
/// of `[A-Za-z0-9-]`; transfer ids are UUIDs made here), so the folder is always directly in
/// `in/` and a recursive delete of it never reaches anything else.
fn incoming_dir(store: &std::path::Path, id: &str) -> CommandResult<PathBuf> {
    let plain = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !plain {
        return Err(err(ErrorCode::InvalidArgument, "not a transfer id"));
    }
    Ok(store.join("in").join(id))
}

fn store_dir<R: Runtime>(app: &AppHandle<R>) -> CommandResult<PathBuf> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
    Ok(cache.join("transfer"))
}

/// Opens the endpoint (idempotent). Called when the Transfer screen opens.
#[tauri::command]
#[specta::specta]
pub async fn transfer_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
) -> CommandResult<TransferInfo> {
    let settings = settings::load(&library)?;
    let (network, view) = if settings.local_only {
        (Network::LocalOnly, NetworkView::LocalOnly)
    } else if let Some(url) = settings
        .relay_url
        .as_deref()
        .and_then(selis_transfer::parse_relay_url)
    {
        (Network::CustomRelay(url), NetworkView::CustomRelay)
    } else {
        (Network::Default, NetworkView::Default)
    };
    let base = store_dir(&app)?;
    let key = async {
        let (key, _source) = device_key::load_or_create(&app).await;
        key
    };
    #[cfg(target_os = "android")]
    let opened = android_call(&app, "open", serde_json::json!({}));
    #[cfg(not(target_os = "android"))]
    let opened = async {};
    state
        .open_at(&library, &base, (network, view), key, opened)
        .await
}

/// Closes the endpoint when the Transfer screen closes or the app goes to the
/// background. With something running and no `force`, it stays open until
/// that ends (the background job or service keeps it going) and `false` is returned.
#[tauri::command]
#[specta::specta]
pub async fn transfer_close<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    force: bool,
) -> CommandResult<bool> {
    if !force && state.running() {
        *lock(&state.close_requested) = true;
        return Ok(false);
    }
    close_now(&app, &state, &library).await;
    Ok(true)
}

async fn close_now<R: Runtime>(app: &AppHandle<R>, state: &TransferState, library: &Library) {
    let base = store_dir(app).ok();
    #[cfg(target_os = "android")]
    let closed = android_call(app, "close", serde_json::json!({}));
    #[cfg(not(target_os = "android"))]
    let closed = async {
        let _ = app;
    };
    state.close_at(library, base, closed).await;
}

impl TransferState {
    /// Opens the endpoint over `base` (its store), unless one is open. `key` is
    /// only awaited for a new endpoint; `opened` runs just before it starts.
    async fn open_at(
        &self,
        library: &Arc<Library>,
        base: &Path,
        (network, view): (Network, NetworkView),
        key: impl Future<Output = SecretKey>,
        opened: impl Future<Output = ()>,
    ) -> CommandResult<TransferInfo> {
        let mut open = self.open.lock().await;
        *lock(&self.close_requested) = false;
        if let Some(o) = open.as_ref() {
            return Ok(TransferInfo {
                device_id: o.service.endpoint_id().to_string(),
                network: o.network,
                debug: cfg!(debug_assertions),
            });
        }
        // A previous run that ended without closing (killed, crashed) may have left
        // blobs behind; with nothing to resume they are garbage.
        if library.resumable_transfers()?.is_empty() {
            let _ = std::fs::remove_dir_all(base);
        }
        // Testing aid, compiled out of release builds (scripts/check-release-apk.sh).
        #[cfg(debug_assertions)]
        let force_relay = {
            std::hint::black_box("SELIS_DEBUG_FORCE_RELAY");
            *lock(&self.force_relay) && view != NetworkView::LocalOnly
        };
        #[cfg(not(debug_assertions))]
        let force_relay = false;
        // Files the library already has (same BLAKE3) are never fetched again.
        let lib = Arc::clone(library);
        let have = Have(Arc::new(move |hash: &selis_transfer::Hash| {
            lib.file_with_hash(&hash.to_hex())
        }));
        #[allow(unused_mut)]
        let mut config = ServiceConfig {
            force_relay,
            have: Some(have),
            ..ServiceConfig::new(key.await, base.join("store"), network)
        };
        // Testing aid (Maestro: an expiring QR code without waiting 10 minutes).
        #[cfg(debug_assertions)]
        if let Some(secs) = crate::debug_log::property("debug.selis.ticket_lifetime")
            .and_then(|v| v.parse::<u64>().ok())
        {
            config.ticket_lifetime = Duration::from_secs(secs);
        }
        // Testing aid (Maestro: a receive long enough to background the app for 60 s).
        #[cfg(debug_assertions)]
        if let Some(kbps) = crate::debug_log::property("debug.selis.receive_kbps")
            .and_then(|v| v.parse::<u64>().ok())
        {
            config.receive_rate = Some(kbps * 1024);
        }
        opened.await;
        let service = TransferService::start(config)
            .await
            .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
        service.set_trusted(trusted_ids(library));
        let info = TransferInfo {
            device_id: service.endpoint_id().to_string(),
            network: view,
            debug: cfg!(debug_assertions),
        };
        *open = Some(Open {
            service: Arc::new(service),
            network: view,
            trackers: HashMap::new(),
            links: HashMap::new(),
            sessions: HashMap::new(),
            send_tasks: HashMap::new(),
        });
        Ok(info)
    }

    /// Closes the endpoint; with nothing left to resume, `base` (the store) goes.
    /// `closed` runs once the endpoint is closed, before the store is deleted.
    /// The lock is held to the end: an open that comes in meanwhile (the screen
    /// returning) waits, then starts on a fresh store instead of one about to
    /// be deleted under it.
    async fn close_at(
        &self,
        library: &Library,
        base: Option<PathBuf>,
        closed: impl Future<Output = ()>,
    ) {
        let state = self;
        let mut slot = state.open.lock().await;
        let Some(open) = slot.take() else {
            return;
        };
        for (id, task) in open.trackers {
            task.abort();
            pause_row(library, state, &id);
        }
        for session in open.sessions.values() {
            open.service.cancel_receive(session);
        }
        for (session, (task, row)) in open.send_tasks {
            task.abort();
            let finished = matches!(
                lock(&state.sends).get(&session),
                Some(SendView::Done { .. } | SendView::Failed { .. })
            );
            if !finished {
                let _ = library.transfer_update(
                    &row,
                    &TransferUpdate {
                        state: Some(TransferRowState::Cancelled),
                        ..Default::default()
                    },
                );
            }
        }
        lock(&state.sends).clear();
        *lock(&state.close_requested) = false;
        // Partial downloads stay for resuming; with none left the store goes.
        let wipe = library
            .resumable_transfers()
            .map(|r| r.is_empty())
            .unwrap_or(false);
        open.service.close(wipe).await;
        closed.await;
        if wipe && let Some(dir) = base {
            let _ = std::fs::remove_dir_all(dir);
        }
        drop(slot);
    }
}

/// A receive stopped by us (closing, pausing): resumable if it got that far.
fn pause_row(library: &Library, state: &TransferState, id: &str) {
    let mut receives = lock(&state.receives);
    let Some(view) = receives.get_mut(id) else {
        return;
    };
    if !view.running() {
        return;
    }
    let resumable = library
        .transfer(id)
        .ok()
        .flatten()
        .is_some_and(|r| r.resume.is_some());
    let (bytes, total) = match view {
        ReceiveView::Receiving { bytes, total, .. } => (*bytes, *total),
        _ => (0, 0),
    };
    *view = if resumable {
        ReceiveView::Paused {
            bytes,
            total,
            reason: None,
        }
    } else {
        ReceiveView::Failed {
            error: TransferErrorCode::Cancelled,
        }
    };
    let update = TransferUpdate {
        state: Some(if resumable {
            TransferRowState::Interrupted
        } else {
            TransferRowState::Cancelled
        }),
        ..Default::default()
    };
    let _ = library.transfer_update(id, &update);
}

/// Pauses every receive (Android stopped the background job, `timeout` event).
#[tauri::command]
#[specta::specta]
pub async fn transfer_pause(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
) -> CommandResult<()> {
    let mut open = state.open.lock().await;
    if let Some(o) = open.as_mut() {
        for (id, task) in o.trackers.drain() {
            task.abort();
            pause_row(&library, &state, &id);
            if let Some(session) = o.sessions.remove(&id) {
                o.service.cancel_receive(&session);
            }
        }
    }
    Ok(())
}

/// Offers documents: returns the QR code and link (valid 10 minutes, once).
#[tauri::command]
#[specta::specta]
pub async fn transfer_offer(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    document_ids: Vec<String>,
    include_history: bool,
) -> CommandResult<OfferView> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_offer", async move {
            offer(state, library, document_ids, include_history).await
        })
        .await
}

async fn offer(
    state: Arc<TransferState>,
    library: Arc<Library>,
    document_ids: Vec<String>,
    include_history: bool,
) -> CommandResult<OfferView> {
    if document_ids.is_empty() || document_ids.len() > 10_000 {
        return Err(err(ErrorCode::InvalidArgument, "choose documents to send"));
    }
    let service = state.service().await?;
    let (items, total) = offer_items(&library, &document_ids, include_history, false)?;
    let doc_count = u32::try_from(items.len()).unwrap_or(u32::MAX);
    let (session_id, ticket) = service
        .offer(items)
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
    let link = ticket.to_link();
    let qr_svg = qr::svg(&link).ok_or_else(|| err(ErrorCode::Internal, "QR code"))?;
    let row = library.transfer_start(TransferDirection::Send)?;
    library.transfer_update(
        &row,
        &TransferUpdate {
            doc_count: Some(doc_count),
            total_bytes: Some(total),
            ..Default::default()
        },
    )?;
    lock(&state.sends).insert(session_id.clone(), SendView::WaitingForReceiver);
    let task = tauri::async_runtime::spawn(track_send(
        Arc::clone(&state),
        library,
        service,
        session_id.clone(),
        row.clone(),
    ));
    if let Some(o) = state.open.lock().await.as_mut() {
        o.send_tasks.insert(session_id.clone(), (task, row));
    }
    Ok(OfferView {
        session_id,
        link,
        qr_svg,
        doc_count,
        total_bytes: total,
        expires_at: ticket.expires_at,
    })
}

/// The documents as offered: current file, optionally history, and for a
/// library move their tags and favorite flag. Returns them with the bytes to send.
fn offer_items(
    library: &Library,
    document_ids: &[String],
    include_history: bool,
    with_metadata: bool,
) -> CommandResult<(Vec<OfferItem>, u64)> {
    let mut items = Vec::new();
    let mut total: u64 = 0;
    for id in document_ids {
        let out = library.outgoing(id, include_history)?;
        let title = out.title.trim().to_owned();
        let name = format!("{}.pdf", if title.is_empty() { "document" } else { &title });
        for path in std::iter::once(&out.current).chain(out.history.iter().map(|(p, _)| p)) {
            total += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }
        let (tags, favorite) = if with_metadata {
            (
                library.document_tag_names(id)?,
                library.get_document(id)?.favorite,
            )
        } else {
            (vec![], false)
        };
        items.push(OfferItem {
            title,
            name: sanitize_name(&name),
            path: out.current,
            history: out
                .history
                .into_iter()
                .map(|(path, created_at)| OfferVersion { path, created_at })
                .collect(),
            tags,
            favorite,
        });
    }
    Ok((items, total))
}

/// Everything a library move carries besides the documents.
fn library_extras(library: &Library) -> CommandResult<OfferLibrary> {
    let signatures = library
        .list_signatures()?
        .into_iter()
        .map(|s| OfferSignature {
            id: s.id,
            kind: s.kind.as_str().to_owned(),
            path: PathBuf::from(s.path),
            created_at: s.created_at,
        })
        .collect();
    let settings = library.settings()?.into_iter().collect();
    Ok(OfferLibrary {
        signatures,
        settings,
    })
}

fn all_document_ids(library: &Library) -> CommandResult<Vec<String>> {
    Ok(library
        .list_documents(&LibraryQuery::default())?
        .into_iter()
        .map(|d| d.id)
        .collect())
}

fn trusted_ids(library: &Library) -> Vec<EndpointId> {
    library
        .trusted_devices()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|d| d.endpoint_id.parse().ok())
        .collect()
}

/// File names in the manifest: no path separators or control characters.
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned: String = cleaned.chars().take(200).collect();
    if cleaned.trim().is_empty() || cleaned == "." || cleaned == ".." {
        "document.pdf".into()
    } else {
        cleaned
    }
}

fn send_view(s: SendState) -> SendView {
    match s {
        SendState::WaitingForReceiver => SendView::WaitingForReceiver,
        SendState::Confirm { code } => SendView::Confirm { code },
        SendState::Sending {
            bytes,
            total,
            route,
        } => SendView::Sending {
            bytes,
            total,
            route: route.into(),
        },
        SendState::Interrupted { bytes, total } => SendView::Interrupted { bytes, total },
        SendState::Done => SendView::Done {
            peer: None,
            trusted: false,
        },
        SendState::Failed { error } => SendView::Failed {
            error: error.into(),
        },
    }
}

async fn track_send(
    state: Arc<TransferState>,
    library: Arc<Library>,
    service: Arc<TransferService>,
    session: String,
    row: String,
) {
    loop {
        tokio::time::sleep(POLL).await;
        let Some(s) = service.send_state(&session) else {
            // Cancelled (or the screen closed).
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    state: Some(TransferRowState::Cancelled),
                    ..Default::default()
                },
            );
            lock(&state.sends).remove(&session);
            return;
        };
        let mut view = send_view(s);
        if let SendView::Done { peer, trusted } = &mut view
            && let Some(id) = service.send_peer(&session)
        {
            let hex = id.to_string();
            *trusted = library.trusted_device(&hex).ok().flatten().is_some();
            let _ = library.touch_trusted_device(&hex);
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    peer: Some(hex.clone()),
                    ..Default::default()
                },
            );
            *peer = Some(hex);
        }
        let finished = match &view {
            SendView::Done { .. } => Some((TransferRowState::Done, None)),
            SendView::Failed { error } => Some((
                if *error == TransferErrorCode::Cancelled {
                    TransferRowState::Cancelled
                } else {
                    TransferRowState::Failed
                },
                Some(error_name(*error)),
            )),
            _ => None,
        };
        if let SendView::Sending { bytes, .. } = &view {
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    done_bytes: Some(*bytes),
                    ..Default::default()
                },
            );
        }
        lock(&state.sends).insert(session.clone(), view);
        if let Some((st, error)) = finished {
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    state: Some(st),
                    error,
                    ..Default::default()
                },
            );
            return;
        }
    }
}

fn error_from_name(name: &str) -> Option<TransferErrorCode> {
    serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()
}

fn error_name(e: TransferErrorCode) -> String {
    serde_json::to_value(e)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_send_status(
    state: State<'_, Arc<TransferState>>,
    session_id: String,
) -> CommandResult<SendView> {
    if let Some(v) = lock(&state.sends).get(&session_id) {
        return Ok(v.clone());
    }
    let service = state.service().await?;
    service
        .send_state(&session_id)
        .map(send_view)
        .ok_or_else(|| err(ErrorCode::NotFound, "no such transfer"))
}

/// The sender's answer to the code both screens show.
#[tauri::command]
#[specta::specta]
pub async fn transfer_decide(
    state: State<'_, Arc<TransferState>>,
    session_id: String,
    confirm: bool,
) -> CommandResult<()> {
    let service = state.service().await?;
    service
        .decide(&session_id, confirm)
        .map_err(|e| err(ErrorCode::InvalidArgument, e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_cancel_send(
    state: State<'_, Arc<TransferState>>,
    session_id: String,
) -> CommandResult<()> {
    if let Ok(service) = state.service().await {
        service.cancel_send(&session_id);
    }
    lock(&state.sends).insert(
        session_id,
        SendView::Failed {
            error: TransferErrorCode::Cancelled,
        },
    );
    Ok(())
}

/// Starts receiving from a scanned or pasted link; returns the receive id.
/// The same link again returns the same receive (a double scan, a lost reply).
#[tauri::command]
#[specta::specta]
pub async fn transfer_receive<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    link: String,
) -> CommandResult<String> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_receive", async move {
            receive(app, state, library, link).await
        })
        .await
}

async fn receive<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<TransferState>,
    library: Arc<Library>,
    link: String,
) -> CommandResult<String> {
    let ticket =
        TransferTicket::parse(&link).map_err(|_| err(ErrorCode::InvalidArgument, "invalidLink"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if !ticket.is_valid_at(now) {
        return Err(err(ErrorCode::InvalidArgument, "expired"));
    }
    let key = ticket.to_link();
    let mut open = state.open.lock().await;
    let o = open.as_mut().ok_or_else(not_open)?;
    if let Some(id) = o.links.get(&key) {
        return Ok(id.clone());
    }
    let id = library.transfer_start(TransferDirection::Receive)?;
    library.transfer_update(
        &id,
        &TransferUpdate {
            peer: Some(ticket.addr.id.to_string()),
            ..Default::default()
        },
    )?;
    let dest = store_dir(&app)?.join("in").join(&id);
    let session_id = o
        .service
        .receive(ticket, dest.clone())
        .map_err(|_| err(ErrorCode::InvalidArgument, "expired"))?;
    lock(&state.receives).insert(id.clone(), ReceiveView::Connecting);
    let task = tauri::async_runtime::spawn(track_receive(
        app.clone(),
        Arc::clone(&state),
        Arc::clone(&library),
        Arc::clone(&o.service),
        session_id.clone(),
        id.clone(),
        dest,
    ));
    o.links.insert(key, id.clone());
    o.trackers.insert(id.clone(), task);
    o.sessions.insert(id.clone(), session_id);
    Ok(id)
}

/// Continues a receive that stopped (see `transfer_resumable`).
#[tauri::command]
#[specta::specta]
pub async fn transfer_resume<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    let row = library
        .transfer(&id)?
        .ok_or_else(|| err(ErrorCode::NotFound, "no such transfer"))?;
    let info = row
        .resume
        .as_deref()
        .and_then(ResumeInfo::decode)
        .ok_or_else(|| err(ErrorCode::InvalidArgument, "not resumable"))?;
    let mut open = state.open.lock().await;
    let o = open.as_mut().ok_or_else(not_open)?;
    if o.trackers
        .get(&id)
        .is_some_and(|t| !t.inner().is_finished())
    {
        return Ok(());
    }
    library.transfer_update(
        &id,
        &TransferUpdate {
            state: Some(TransferRowState::Active),
            ..Default::default()
        },
    )?;
    let dest = incoming_dir(&store_dir(&app)?, &id)?;
    let session = o.service.resume(info, dest.clone());
    lock(&state.receives).insert(id.clone(), ReceiveView::Connecting);
    let task = tauri::async_runtime::spawn(track_receive(
        app.clone(),
        Arc::clone(&state),
        Arc::clone(&library),
        Arc::clone(&o.service),
        session.clone(),
        id.clone(),
        dest,
    ));
    o.trackers.insert(id.clone(), task);
    o.sessions.insert(id, session);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_resumable(
    library: State<'_, Arc<Library>>,
) -> CommandResult<Vec<ResumableView>> {
    Ok(library
        .resumable_transfers()?
        .into_iter()
        .map(|r| ResumableView {
            id: r.id,
            doc_count: r.doc_count,
            total_bytes: r.total_bytes,
            done_bytes: r.done_bytes,
            updated_at: r.updated_at,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_receive_status(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<ReceiveView> {
    if let Some(v) = lock(&state.receives).get(&id) {
        return Ok(v.clone());
    }
    // Not tracked in this run (the app restarted): what the table says.
    let row = library
        .transfer(&id)?
        .ok_or_else(|| err(ErrorCode::NotFound, "no such transfer"))?;
    Ok(match row.state {
        TransferRowState::Done => ReceiveView::Done {
            document_ids: vec![],
            duplicates: 0,
            signatures: 0,
            moved: false,
            trusted: row
                .peer
                .as_deref()
                .is_some_and(|p| library.trusted_device(p).ok().flatten().is_some()),
            peer: row.peer.clone(),
        },
        TransferRowState::Active | TransferRowState::Interrupted if row.resume.is_some() => {
            ReceiveView::Paused {
                bytes: row.done_bytes,
                total: row.total_bytes,
                reason: row.error.as_deref().and_then(error_from_name),
            }
        }
        TransferRowState::Cancelled => ReceiveView::Failed {
            error: TransferErrorCode::Cancelled,
        },
        _ => ReceiveView::Failed {
            error: TransferErrorCode::Interrupted,
        },
    })
}

/// Stops a receive for good: nothing is added, partial data is dropped.
#[tauri::command]
#[specta::specta]
pub async fn transfer_cancel_receive<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    // The id comes from the UI: a plain id (it names a folder below) that this app knows.
    let store = store_dir(&app).ok();
    let dir = match &store {
        Some(store) => Some(incoming_dir(store, &id)?),
        None => None,
    };
    let row = library.transfer(&id)?.is_some();
    let mut running = false;
    if let Some(o) = state.open.lock().await.as_mut() {
        if let Some(task) = o.trackers.remove(&id) {
            task.abort();
            running = true;
        }
        if let Some(session) = o.sessions.remove(&id) {
            o.service.cancel_receive(&session);
            running = true;
        }
    }
    if !row && !running && !lock(&state.receives).contains_key(&id) {
        return Err(err(ErrorCode::NotFound, "no such transfer"));
    }
    lock(&state.receives).insert(
        id.clone(),
        ReceiveView::Failed {
            error: TransferErrorCode::Cancelled,
        },
    );
    if row {
        library.transfer_update(
            &id,
            &TransferUpdate {
                state: Some(TransferRowState::Cancelled),
                ..Default::default()
            },
        )?;
    }
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    maybe_close(&app, &state, &library).await;
    Ok(())
}

fn receive_view(s: &ReceiveState) -> ReceiveView {
    match s {
        ReceiveState::Connecting => ReceiveView::Connecting,
        ReceiveState::Confirm { code } => ReceiveView::Confirm { code: code.clone() },
        ReceiveState::Receiving {
            bytes,
            total,
            route,
        } => ReceiveView::Receiving {
            bytes: *bytes,
            total: *total,
            route: (*route).into(),
        },
        ReceiveState::Verifying => ReceiveView::Verifying,
        ReceiveState::Done { .. } => ReceiveView::Saving,
        ReceiveState::Failed { error } => ReceiveView::Failed {
            error: (*error).into(),
        },
    }
}

/// Whether the receive `id` already has a saved point to continue from (a resume):
/// failing to reach the sender again then pauses it, instead of dropping what arrived.
fn has_resume_point(library: &Library, id: &str) -> bool {
    library
        .transfer(id)
        .ok()
        .flatten()
        .is_some_and(|r| r.resume.is_some())
}

#[allow(clippy::too_many_arguments)]
async fn track_receive<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<TransferState>,
    library: Arc<Library>,
    service: Arc<TransferService>,
    session: String,
    id: String,
    dest: PathBuf,
) {
    let mut resume_saved = has_resume_point(&library, &id);
    let mut last_persist = Instant::now();
    loop {
        tokio::time::sleep(POLL).await;
        let Some(s) = service.receive_state(&session) else {
            return;
        };
        if !resume_saved && let Some(info) = service.resume_info(&session) {
            resume_saved = true;
            let _ = library.transfer_update(
                &id,
                &TransferUpdate {
                    resume: Some(Some(info.encode())),
                    ..Default::default()
                },
            );
        }
        match s {
            ReceiveState::Done {
                items,
                library: extras,
            } => {
                lock(&state.receives).insert(id.clone(), ReceiveView::Saving);
                let total: u64 = items.iter().map(|i| i.size).sum();
                let lib = Arc::clone(&library);
                let imported = tauri::async_runtime::spawn_blocking(move || {
                    let mut ids = Vec::new();
                    let mut duplicates = 0u32;
                    let count = items.len();
                    for i in items {
                        let doc = ReceivedDocument {
                            title: i.title,
                            current: ReceivedFile {
                                path: i.path,
                                blake3: i.blake3,
                                created_at: None,
                            },
                            history: i
                                .history
                                .into_iter()
                                .map(|v| ReceivedFile {
                                    path: v.path,
                                    blake3: v.blake3,
                                    created_at: Some(v.created_at),
                                })
                                .collect(),
                        };
                        let out = lib.import_received(&doc)?;
                        if out.duplicate {
                            duplicates += 1;
                        }
                        lib.apply_received_metadata(&out.document.id, &i.tags, i.favorite)?;
                        ids.push(out.document.id);
                    }
                    // A library move: signatures (by id) and settings.
                    let mut signatures = 0u32;
                    let moved = extras.is_some();
                    if let Some(extras) = extras {
                        for s in &extras.signatures {
                            if lib.import_received_signature(&s.id, &s.kind, &s.path)? {
                                signatures += 1;
                            }
                        }
                        if let Ok(patch) = serde_json::from_value::<settings::SettingsPatch>(
                            serde_json::Value::Object(extras.settings),
                        ) && let Err(e) = settings::apply_patch(&lib, patch)
                        {
                            eprintln!("selis: moved settings not applied: {}", e.message);
                        }
                    }
                    Ok::<_, selis_core::Error>((ids, duplicates, count, signatures, moved))
                })
                .await;
                let _ = std::fs::remove_dir_all(&dest);
                let peer = service
                    .pushed_by(&session)
                    .map(|p| p.to_string())
                    .or_else(|| library.transfer(&id).ok().flatten().and_then(|r| r.peer));
                let trusted = peer
                    .as_deref()
                    .is_some_and(|p| library.trusted_device(p).ok().flatten().is_some());
                if let Some(p) = &peer {
                    let _ = library.touch_trusted_device(p);
                }
                let (view, update) = match imported {
                    Ok(Ok((document_ids, duplicates, count, signatures, moved))) => (
                        ReceiveView::Done {
                            document_ids,
                            duplicates,
                            signatures,
                            moved,
                            peer: peer.clone(),
                            trusted,
                        },
                        TransferUpdate {
                            state: Some(TransferRowState::Done),
                            doc_count: Some(u32::try_from(count).unwrap_or(u32::MAX)),
                            done_bytes: Some(total),
                            total_bytes: Some(total),
                            peer,
                            ..Default::default()
                        },
                    ),
                    _ => (
                        ReceiveView::Failed {
                            error: TransferErrorCode::Storage,
                        },
                        TransferUpdate {
                            state: Some(TransferRowState::Failed),
                            error: Some(error_name(TransferErrorCode::Storage)),
                            ..Default::default()
                        },
                    ),
                };
                let _ = library.transfer_update(&id, &update);
                lock(&state.receives).insert(id.clone(), view);
                break;
            }
            ReceiveState::Failed { error } => {
                let code = TransferErrorCode::from(error);
                // A broken connection after the sender confirmed can continue later.
                let resumable = resume_saved
                    && matches!(
                        code,
                        TransferErrorCode::Interrupted | TransferErrorCode::Unreachable
                    );
                let row = library.transfer(&id).ok().flatten();
                let (view, st) = if resumable {
                    let (bytes, total) = row
                        .as_ref()
                        .map(|r| (r.done_bytes, r.total_bytes))
                        .unwrap_or((0, 0));
                    (
                        ReceiveView::Paused {
                            bytes,
                            total,
                            reason: Some(code),
                        },
                        TransferRowState::Interrupted,
                    )
                } else {
                    let _ = std::fs::remove_dir_all(&dest);
                    (
                        ReceiveView::Failed { error: code },
                        if code == TransferErrorCode::Cancelled {
                            TransferRowState::Cancelled
                        } else {
                            TransferRowState::Failed
                        },
                    )
                };
                let _ = library.transfer_update(
                    &id,
                    &TransferUpdate {
                        state: Some(st),
                        error: Some(error_name(code)),
                        ..Default::default()
                    },
                );
                lock(&state.receives).insert(id.clone(), view);
                break;
            }
            ref other => {
                let view = receive_view(other);
                if let ReceiveView::Receiving { bytes, total, .. } = &view
                    && last_persist.elapsed() >= PERSIST_EVERY
                {
                    last_persist = Instant::now();
                    let _ = library.transfer_update(
                        &id,
                        &TransferUpdate {
                            done_bytes: Some(*bytes),
                            total_bytes: Some(*total),
                            ..Default::default()
                        },
                    );
                }
                lock(&state.receives).insert(id.clone(), view);
            }
        }
    }
    maybe_close(&app, &state, &library).await;
}

/// Closes the endpoint if the screen asked for it and nothing runs any more.
async fn maybe_close<R: Runtime>(app: &AppHandle<R>, state: &TransferState, library: &Library) {
    if *lock(&state.close_requested) && !state.running() {
        close_now(app, state, library).await;
    }
}

/// Shows or updates the transfer notification and keeps the transfer alive in
/// the background (Android: a user-initiated data transfer job on 14+, a
/// foreground service below, ADR 0027; a no-op elsewhere). Texts come
/// translated from the UI; `progress` / `max` are KiB, `upload` is a send.
#[tauri::command]
#[specta::specta]
pub async fn transfer_foreground<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
    title: String,
    text: String,
    progress: u32,
    max: u32,
    upload: bool,
) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    android_call(
        &app,
        "foreground",
        serde_json::json!({ "channel": channel, "title": title, "text": text, "progress": progress, "max": max, "upload": upload }),
    )
    .await;
    #[cfg(not(target_os = "android"))]
    let _ = (app, channel, title, text, progress, max, upload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_foreground_stop<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    android_call(&app, "stopForeground", serde_json::json!({})).await;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

/// Folder for pushed receives (each gets a subfolder named by its session).
fn push_dir<R: Runtime>(app: &AppHandle<R>) -> CommandResult<PathBuf> {
    Ok(store_dir(app)?.join("in").join("pushed"))
}

/// The Receive tab is open (`true`) or not: trusted devices may push only while it is.
#[tauri::command]
#[specta::specta]
pub async fn transfer_receiving<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    on: bool,
) -> CommandResult<()> {
    let service = state.service().await?;
    service.set_receiving(if on { Some(push_dir(&app)?) } else { None });
    Ok(())
}

/// Receives started by trusted devices since the last call; each is tracked
/// like a scanned one (`transfer_receive_status`).
#[tauri::command]
#[specta::specta]
pub async fn transfer_incoming<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
) -> CommandResult<Vec<IncomingView>> {
    let mut open = state.open.lock().await;
    let o = open.as_mut().ok_or_else(not_open)?;
    let mut out = Vec::new();
    for (session, peer) in o.service.take_incoming() {
        let hex = peer.to_string();
        let id = library.transfer_start(TransferDirection::Receive)?;
        library.transfer_update(
            &id,
            &TransferUpdate {
                peer: Some(hex.clone()),
                ..Default::default()
            },
        )?;
        lock(&state.receives).insert(id.clone(), ReceiveView::Connecting);
        let dest = push_dir(&app)?.join(&session);
        let task = tauri::async_runtime::spawn(track_receive(
            app.clone(),
            Arc::clone(&state),
            Arc::clone(&library),
            Arc::clone(&o.service),
            session.clone(),
            id.clone(),
            dest,
        ));
        o.trackers.insert(id.clone(), task);
        o.sessions.insert(id.clone(), session);
        out.push(IncomingView {
            id,
            device_name: library.trusted_device(&hex)?.map(|d| d.name),
        });
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_trusted(
    library: State<'_, Arc<Library>>,
) -> CommandResult<Vec<TrustedDevice>> {
    Ok(library.trusted_devices()?)
}

/// Saves the device of a finished transfer (or renames a saved one).
#[tauri::command]
#[specta::specta]
pub async fn transfer_trust(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    endpoint_id: String,
    name: String,
) -> CommandResult<TrustedDevice> {
    let device = library.trust_device(&endpoint_id, &name)?;
    if let Ok(service) = state.service().await {
        service.set_trusted(trusted_ids(&library));
    }
    Ok(device)
}

/// Removes trust at once: no more pushes from it, sends to it need a code again.
#[tauri::command]
#[specta::specta]
pub async fn transfer_untrust(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    endpoint_id: String,
) -> CommandResult<()> {
    library.untrust_device(&endpoint_id)?;
    if let Ok(service) = state.service().await {
        service.set_trusted(trusted_ids(&library));
    }
    Ok(())
}

fn parse_device(endpoint_id: &str) -> CommandResult<EndpointId> {
    endpoint_id
        .parse()
        .map_err(|_| err(ErrorCode::InvalidArgument, "device id"))
}

/// Whether a trusted device is reachable and ready (Receive tab open, trusts us).
#[tauri::command]
#[specta::specta]
pub async fn transfer_ping(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    endpoint_id: String,
) -> CommandResult<PingView> {
    let target = parse_device(&endpoint_id)?;
    if library.trusted_device(&endpoint_id)?.is_none() {
        return Err(err(ErrorCode::NotFound, "not a trusted device"));
    }
    let service = state.service().await?;
    Ok(match service.ping(target).await {
        Ok(receiving) => PingView {
            online: true,
            ready: receiving,
        },
        Err(TransferError::NotReady) => PingView {
            online: true,
            ready: false,
        },
        Err(_) => PingView {
            online: false,
            ready: false,
        },
    })
}

/// Sends documents to a trusted device with its Receive tab open: no QR code, no code.
#[tauri::command]
#[specta::specta]
pub async fn transfer_push(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    endpoint_id: String,
    document_ids: Vec<String>,
    include_history: bool,
) -> CommandResult<String> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_push", async move {
            if document_ids.is_empty() {
                return Err(err(ErrorCode::InvalidArgument, "choose documents to send"));
            }
            let (items, total) = offer_items(&library, &document_ids, include_history, false)?;
            push(state, library, endpoint_id, items, None, total).await
        })
        .await
}

async fn push(
    state: Arc<TransferState>,
    library: Arc<Library>,
    endpoint_id: String,
    items: Vec<OfferItem>,
    extras: Option<OfferLibrary>,
    total: u64,
) -> CommandResult<String> {
    let target = parse_device(&endpoint_id)?;
    if library.trusted_device(&endpoint_id)?.is_none() {
        return Err(err(ErrorCode::NotFound, "not a trusted device"));
    }
    let service = state.service().await?;
    let doc_count = u32::try_from(items.len()).unwrap_or(u32::MAX);
    let session_id = service
        .push(target, items, extras)
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
    let row = library.transfer_start(TransferDirection::Send)?;
    library.transfer_update(
        &row,
        &TransferUpdate {
            doc_count: Some(doc_count),
            total_bytes: Some(total),
            peer: Some(endpoint_id),
            ..Default::default()
        },
    )?;
    lock(&state.sends).insert(session_id.clone(), SendView::WaitingForReceiver);
    let task = tauri::async_runtime::spawn(track_send(
        Arc::clone(&state),
        library,
        service,
        session_id.clone(),
        row.clone(),
    ));
    if let Some(o) = state.open.lock().await.as_mut() {
        o.send_tasks.insert(session_id.clone(), (task, row));
    }
    Ok(session_id)
}

/// What a library move would send (the dry run shown before it starts).
#[tauri::command]
#[specta::specta]
pub async fn transfer_move_summary(
    library: State<'_, Arc<Library>>,
) -> CommandResult<LibrarySummary> {
    Ok(library.library_summary()?)
}

/// Offers the whole library (QR code + link), for a new phone.
#[tauri::command]
#[specta::specta]
pub async fn transfer_move_offer(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<OfferView> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_move_offer", async move {
            let ids = all_document_ids(&library)?;
            if ids.is_empty() {
                return Err(err(ErrorCode::InvalidArgument, "the library is empty"));
            }
            let service = state.service().await?;
            let (items, total) = offer_items(&library, &ids, true, true)?;
            let extras = library_extras(&library)?;
            let doc_count = u32::try_from(items.len()).unwrap_or(u32::MAX);
            let (session_id, ticket) = service
                .offer_with(items, Some(extras), None)
                .await
                .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
            let link = ticket.to_link();
            let qr_svg = qr::svg(&link).ok_or_else(|| err(ErrorCode::Internal, "QR code"))?;
            let row = library.transfer_start(TransferDirection::Send)?;
            library.transfer_update(
                &row,
                &TransferUpdate {
                    doc_count: Some(doc_count),
                    total_bytes: Some(total),
                    ..Default::default()
                },
            )?;
            lock(&state.sends).insert(session_id.clone(), SendView::WaitingForReceiver);
            let task = tauri::async_runtime::spawn(track_send(
                Arc::clone(&state),
                library,
                service,
                session_id.clone(),
                row.clone(),
            ));
            if let Some(o) = state.open.lock().await.as_mut() {
                o.send_tasks.insert(session_id.clone(), (task, row));
            }
            Ok(OfferView {
                session_id,
                link,
                qr_svg,
                doc_count,
                total_bytes: total,
                expires_at: ticket.expires_at,
            })
        })
        .await
}

/// Moves the whole library to a trusted device with its Receive tab open.
#[tauri::command]
#[specta::specta]
pub async fn transfer_move_push(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    endpoint_id: String,
) -> CommandResult<String> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_move_push", async move {
            let ids = all_document_ids(&library)?;
            if ids.is_empty() {
                return Err(err(ErrorCode::InvalidArgument, "the library is empty"));
            }
            let (items, total) = offer_items(&library, &ids, true, true)?;
            let extras = library_extras(&library)?;
            push(state, library, endpoint_id, items, Some(extras), total).await
        })
        .await
}

/// Asks for the notification permission (Android 13+) before the first
/// transfer notification; `true` when notifications can be shown.
#[tauri::command]
#[specta::specta]
pub async fn transfer_notifications<R: Runtime>(app: AppHandle<R>) -> CommandResult<bool> {
    #[cfg(target_os = "android")]
    {
        let Some(p) = app.try_state::<TransferPlugins<R>>() else {
            return Ok(false);
        };
        let out: serde_json::Value = p
            .transfer
            .run_mobile_plugin_async(
                "requestPermissions",
                serde_json::json!({ "permissions": ["notifications"] }),
            )
            .await
            .map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
        Ok(out.get("notifications").and_then(|v| v.as_str()) == Some("granted"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(true)
    }
}

/// Debug builds only: all traffic through the relay (applies at the next open).
#[tauri::command]
#[specta::specta]
pub async fn transfer_debug_force_relay(
    state: State<'_, Arc<TransferState>>,
    on: bool,
) -> CommandResult<()> {
    #[cfg(debug_assertions)]
    {
        *lock(&state.force_relay) = on;
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (state, on);
        Err(err(ErrorCode::Unsupported, "debug builds only"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Security audit run-1, lead 7: a cancelled receive deletes `in/<id>` recursively, so the
    /// id must not be able to name anything else.
    #[test]
    fn a_receive_folder_never_leaves_the_transfer_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = dir.path().join("cache").join("transfer");
        let victim = dir.path().join("victim");
        std::fs::create_dir_all(&victim).expect("victim");
        std::fs::write(victim.join("keep.txt"), b"keep").expect("file");
        let absolute = victim.to_string_lossy().into_owned();
        for bad in [
            "../../../victim",
            "..",
            "",
            "a/b",
            r"a\b",
            absolute.as_str(),
        ] {
            assert!(incoming_dir(&store, bad).is_err(), "{bad}");
        }
        let id = "0192f0c4-7d2e-7a10-8b3c-2f4e5a6b7c8d";
        assert_eq!(
            incoming_dir(&store, id).expect("id"),
            store.join("in").join(id)
        );
        assert!(victim.join("keep.txt").exists());
    }

    #[tokio::test]
    async fn nothing_is_open_until_the_transfer_screen_opens_it() {
        let state = TransferState::default();
        assert!(!state.is_open().await);
        assert!(!state.running());
        assert!(state.service().await.is_err());
    }

    /// The Transfer screen closes and reopens on every visibility change. A close
    /// still shutting down must not delete the store of the endpoint opened
    /// meanwhile: every fetch into it then failed at byte 0 ("paused", forever).
    #[tokio::test(flavor = "multi_thread")]
    async fn an_open_during_a_close_keeps_its_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let library = Arc::new(Library::open(dir.path().join("app")).expect("library"));
        let base = dir.path().join("transfer");
        let state = Arc::new(TransferState::default());
        let local = (Network::LocalOnly, NetworkView::LocalOnly);
        state
            .open_at(
                &library,
                &base,
                local.clone(),
                async { SecretKey::generate() },
                async {},
            )
            .await
            .expect("first open");

        // The close stops right after the endpoint is closed, before its cleanup.
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let closing = tokio::spawn({
            let (state, library, base) = (Arc::clone(&state), Arc::clone(&library), base.clone());
            async move {
                state
                    .close_at(&library, Some(base), async {
                        let _ = held.await;
                    })
                    .await;
            }
        });
        // Until the close has taken the endpoint (it holds the lock, or the slot is empty).
        for _ in 0..500 {
            if state.open.try_lock().map(|o| o.is_none()).unwrap_or(true) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // The screen comes back meanwhile.
        let reopening = tokio::spawn({
            let (state, library, base, local) = (
                Arc::clone(&state),
                Arc::clone(&library),
                base.clone(),
                local.clone(),
            );
            async move {
                state
                    .open_at(
                        &library,
                        &base,
                        local,
                        async { SecretKey::generate() },
                        async {},
                    )
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = release.send(());
        closing.await.expect("close");
        reopening.await.expect("reopen task").expect("reopen");

        let service = state.service().await.expect("an open endpoint");
        assert!(
            service.store_dir().join("blobs.db").exists(),
            "the open endpoint's store was deleted by the close before it"
        );
        state.close_at(&library, Some(base), async {}).await;
    }

    /// A resume that cannot reach the sender stays resumable (it was turned into
    /// "Nothing was received" and its data deleted: a dead end, seen on the AVD).
    #[test]
    fn a_resumed_receive_starts_from_its_saved_point() {
        let dir = tempfile::tempdir().expect("tempdir");
        let library = Library::open(dir.path().to_path_buf()).expect("library");
        let id = library
            .transfer_start(TransferDirection::Receive)
            .expect("row");
        assert!(
            !has_resume_point(&library, &id),
            "a new receive has nothing to resume"
        );
        library
            .transfer_update(
                &id,
                &TransferUpdate {
                    resume: Some(Some("saved".to_owned())),
                    ..Default::default()
                },
            )
            .expect("update");
        assert!(has_resume_point(&library, &id));
        assert!(!has_resume_point(&library, "no-such-row"));
    }

    #[test]
    fn manifest_names_are_safe() {
        assert_eq!(sanitize_name("a/b\\c:d.pdf"), "a_b_c_d.pdf");
        assert_eq!(sanitize_name(".."), "document.pdf");
        assert_eq!(sanitize_name("  "), "document.pdf");
        assert_eq!(sanitize_name(&"x".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn error_names_are_camel_case() {
        assert_eq!(error_name(TransferErrorCode::AlreadyUsed), "alreadyUsed");
        assert_eq!(error_name(TransferErrorCode::InvalidLink), "invalidLink");
        assert_eq!(
            error_from_name("unreachable"),
            Some(TransferErrorCode::Unreachable)
        );
        assert_eq!(error_from_name("nonsense"), None);
    }
}
