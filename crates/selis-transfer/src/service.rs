//! The transfer service: one iroh endpoint, a blob store and the sessions of
//! one visit to the Transfer screen (ADR 0010). The app creates it when that
//! screen opens and closes it when the user leaves (an active transfer keeps it
//! alive under the Android foreground service). Nothing else in Selis opens a
//! socket.
//!
//! Sending: `offer` imports the files by reference (no copy) and returns a
//! ticket. A receiver that presents the ticket's token gets the code on both
//! screens; once the user confirms, only that receiver's endpoint may fetch,
//! and only these blobs.
//!
//! Receiving: `receive` connects, shows the code, waits for the sender, then
//! fetches with BLAKE3 verification per chunk into the store (partial data
//! survives an interruption: `resume` continues it) and exports the files.
//! In a trusted device's push, blobs the app already has (same BLAKE3,
//! `ServiceConfig::have`) are not fetched at all; a ticket receive fetches
//! every blob, so a sender cannot learn which ones this device holds.
//!
//! Trusted devices (ADR 0014): `push` sends to a device that trusts this one and
//! has its Receive screen open, without QR code or code. The sender dials it on
//! ALPN `selis/push/1` and hands over an ordinary ticket pointing back to itself;
//! the receiver accepts only from a trusted device, only while receiving, only a
//! ticket for that same device, and then connects back as for any ticket. The
//! sender skips the code only for the device it invited, and only if it trusts it.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{Connection, presets},
    protocol::{AcceptError, ProtocolHandler, Router},
};
use iroh_blobs::{
    BlobFormat, BlobsProtocol, Hash, HashAndFormat,
    api::{
        TempTag,
        blobs::AddPathOptions,
        proto::{BlobStatus, ImportMode},
        remote::GetProgressItem,
    },
    format::collection::Collection,
    provider::events::{
        AbortReason, ConnectMode, EventMask, EventSender, ObserveMode, ProviderMessage, RequestMode,
    },
    store::fs::FsStore,
};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::{sync::oneshot, task::JoinHandle};

use crate::{
    ALPN,
    code::confirmation_code,
    manifest::{LibraryExtras, Manifest, ManifestItem, ManifestSignature, ManifestVersion},
    ticket::{MAX_TICKET_ADDRS, TICKET_LIFETIME_SECS, Token, TransferTicket},
    wire::{self, PushRefusal, PushRequest, PushResponse, RejectReason, ToReceiver, ToSender},
};

/// ALPN of the trusted-device protocol (ping, push invitation).
pub const PUSH_ALPN: &[u8] = b"selis/push/1";
/// How long a ping or a push invitation may take.
const PUSH_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the sender has to confirm the code once it is shown.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(180);
/// How long reaching the other device may take (address lookup, hole punching, relay).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long `offer` waits for a relay address to put in the ticket.
const ONLINE_TIMEOUT: Duration = Duration::from_secs(10);
/// Progress reports to the sender, at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(500);

/// Network paths the endpoint may use (Settings → Transfer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Network {
    /// mDNS on the same Wi-Fi, hole punching, the n0 relays and n0 address lookup.
    Default,
    /// Same network only: mDNS, no relay, no DNS / pkarr lookups.
    LocalOnly,
    /// A self-hosted relay instead of n0's (no n0 address lookup either).
    CustomRelay(RelayUrl),
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub secret_key: SecretKey,
    /// Blob store (app cache): partial downloads live here until finished.
    pub store_dir: PathBuf,
    pub network: Network,
    /// Testing aid: no direct paths, everything through the relay. Dev builds only.
    pub force_relay: bool,
    /// How long a new ticket stays usable (at most [`TICKET_LIFETIME_SECS`]).
    pub ticket_lifetime: Duration,
    /// Testing aid: receive at most this many bytes per second (a long transfer for
    /// background tests). Dev builds only.
    pub receive_rate: Option<u64>,
    /// Blobs the receiving app already has (its library file), never fetched again.
    pub have: Option<Have>,
}

/// Looks up a blob the app already stores: its file, if any.
#[derive(Clone)]
pub struct Have(pub Arc<HaveFn>);

/// `hash` → the app's file with that content, if it has one.
pub type HaveFn = dyn Fn(&Hash) -> Option<PathBuf> + Send + Sync;

impl std::fmt::Debug for Have {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Have(..)")
    }
}

impl ServiceConfig {
    pub fn new(secret_key: SecretKey, store_dir: PathBuf, network: Network) -> Self {
        Self {
            secret_key,
            store_dir,
            network,
            force_relay: false,
            ticket_lifetime: Duration::from_secs(TICKET_LIFETIME_SECS),
            receive_rate: None,
            have: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    /// Direct, to a private address: the same Wi-Fi / LAN.
    Lan,
    /// Direct across networks (hole punching).
    Direct,
    /// Through the relay (still end-to-end encrypted).
    Relay,
    Unknown,
}

/// Private, link-local or unique-local: the other device is on this network.
fn is_local(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Why a transfer stopped, in terms the UI can explain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub enum TransferError {
    #[error("the link has expired")]
    Expired,
    #[error("the link was already used")]
    AlreadyUsed,
    #[error("unknown link or session")]
    Unknown,
    #[error("the other device said no")]
    Declined,
    #[error("the other device could not be reached")]
    Unreachable,
    #[error("the connection was interrupted")]
    Interrupted,
    #[error("the received files do not match what was offered")]
    Mismatch,
    #[error("the other device sent something unexpected")]
    Protocol,
    #[error("the files could not be read or written")]
    Storage,
    #[error("cancelled")]
    Cancelled,
    /// A trusted-device send: the other device does not trust this one, or its
    /// Receive screen is not open.
    #[error("the other device is not ready to receive")]
    NotReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SendState {
    WaitingForReceiver,
    /// Both screens show `code`; the user confirms or declines.
    #[serde(rename_all = "camelCase")]
    Confirm {
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Sending {
        bytes: u64,
        total: u64,
        route: Route,
    },
    /// The receiver dropped mid-way; it may come back with its session token.
    #[serde(rename_all = "camelCase")]
    Interrupted {
        bytes: u64,
        total: u64,
    },
    Done,
    #[serde(rename_all = "camelCase")]
    Failed {
        error: TransferError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReceiveState {
    Connecting,
    /// Shown on this screen too; the sender confirms on theirs.
    #[serde(rename_all = "camelCase")]
    Confirm {
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Receiving {
        bytes: u64,
        total: u64,
        route: Route,
    },
    Verifying,
    #[serde(rename_all = "camelCase")]
    Done {
        items: Vec<ReceivedItem>,
        /// A library move: signatures and settings.
        library: Option<ReceivedLibrary>,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error: TransferError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedLibrary {
    pub signatures: Vec<ReceivedSignature>,
    pub settings: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedSignature {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
    pub blake3: String,
    pub created_at: i64,
}

/// A received document: its file (exported from the store, or the app's own
/// copy when it already had it) and its history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedItem {
    pub title: String,
    pub name: String,
    pub path: PathBuf,
    pub blake3: String,
    pub size: u64,
    /// Earlier versions, oldest first.
    pub history: Vec<ReceivedVersion>,
    pub tags: Vec<String>,
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedVersion {
    pub path: PathBuf,
    pub blake3: String,
    pub size: u64,
    pub created_at: i64,
}

/// What the receiver keeps to continue after an interruption (the app stores
/// it, as [`ResumeInfo::to_string`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeInfo {
    pub addr: EndpointAddr,
    pub collection: Hash,
    pub session: Token,
}

impl ResumeInfo {
    /// Compact text form (postcard, base32) for the app's database.
    pub fn encode(&self) -> String {
        let bytes = postcard::to_stdvec(self).unwrap_or_default();
        data_encoding::BASE32_NOPAD
            .encode(&bytes)
            .to_ascii_lowercase()
    }

    /// Reads [`encode`](Self::encode)'s output; anything else is refused (never panics).
    pub fn decode(s: &str) -> Option<Self> {
        if s.len() > 4096 {
            return None;
        }
        let bytes = data_encoding::BASE32_NOPAD
            .decode(s.to_ascii_uppercase().as_bytes())
            .ok()?;
        postcard::from_bytes(&bytes).ok()
    }
}

/// A document on offer: its file and, optionally, its earlier versions.
#[derive(Debug, Clone, Default)]
pub struct OfferItem {
    pub title: String,
    pub name: String,
    pub path: PathBuf,
    pub history: Vec<OfferVersion>,
    /// Library move only.
    pub tags: Vec<String>,
    pub favorite: bool,
}

/// What a library move adds to the documents.
#[derive(Debug, Clone, Default)]
pub struct OfferLibrary {
    pub signatures: Vec<OfferSignature>,
    pub settings: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct OfferSignature {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct OfferVersion {
    pub path: PathBuf,
    pub created_at: i64,
}

pub type SessionId = String;

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("network: {0}")]
    Network(String),
    #[error("storage: {0}")]
    Storage(String),
    #[error("no such session")]
    NoSession,
    #[error("invalid: {0}")]
    Invalid(&'static str),
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_token() -> Token {
    let mut t = [0u8; 16];
    // The OS random source failing leaves no safe way on: abort the attempt.
    if getrandom::fill(&mut t).is_err() {
        t = *SecretKey::generate()
            .public()
            .as_bytes()
            .first_chunk::<16>()
            .unwrap_or(&[0; 16]);
    }
    t
}

fn new_session_id() -> SessionId {
    random_token().iter().map(|b| format!("{b:02x}")).collect()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock leaves plain data; keep going.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Which peer may fetch which blobs (filled when a sender confirms).
#[derive(Debug, Default)]
struct Gate {
    allowed: Mutex<HashMap<EndpointId, HashSet<Hash>>>,
    connections: Mutex<HashMap<u64, EndpointId>>,
}

impl Gate {
    fn allow(&self, peer: EndpointId, hashes: impl IntoIterator<Item = Hash>) {
        lock(&self.allowed).entry(peer).or_default().extend(hashes);
    }

    fn revoke(&self, peer: EndpointId) {
        lock(&self.allowed).remove(&peer);
    }

    /// The blobs protocol's event hook: refuse every peer and every hash not confirmed.
    fn events(self: &Arc<Self>) -> EventSender {
        let mask = EventMask {
            connected: ConnectMode::Intercept,
            get: RequestMode::Intercept,
            get_many: RequestMode::Disabled,
            push: RequestMode::Disabled,
            observe: ObserveMode::None,
            ..EventMask::DEFAULT
        };
        let (tx, mut rx) = EventSender::channel(32, mask);
        let gate = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    ProviderMessage::ClientConnected(msg) => {
                        let ok = msg
                            .endpoint_id
                            .is_some_and(|id| lock(&gate.allowed).contains_key(&id));
                        if ok && let Some(id) = msg.endpoint_id {
                            lock(&gate.connections).insert(msg.connection_id, id);
                        } else {
                            tracing::warn!(peer = ?msg.endpoint_id, "blobs: connection refused");
                        }
                        msg.tx
                            .send(if ok {
                                Ok(())
                            } else {
                                Err(AbortReason::Permission)
                            })
                            .await
                            .ok();
                    }
                    ProviderMessage::ConnectionClosed(msg) => {
                        lock(&gate.connections).remove(&msg.connection_id);
                    }
                    ProviderMessage::GetRequestReceived(msg) => {
                        let peer = lock(&gate.connections).get(&msg.connection_id).copied();
                        let ok = peer.is_some_and(|p| {
                            lock(&gate.allowed)
                                .get(&p)
                                .is_some_and(|h| h.contains(&msg.request.hash))
                        });
                        if !ok {
                            tracing::warn!(?peer, hash = %msg.request.hash, "blobs: request refused");
                        }
                        msg.tx
                            .send(if ok {
                                Ok(())
                            } else {
                                Err(AbortReason::Permission)
                            })
                            .await
                            .ok();
                    }
                    _ => {}
                }
            }
        });
        tx
    }
}

struct SendSession {
    token: Token,
    expires_at: u64,
    used: bool,
    session_token: Token,
    hashes: HashSet<Hash>,
    manifest: Manifest,
    state: SendState,
    peer: Option<EndpointId>,
    decision: Option<oneshot::Sender<bool>>,
    /// A push to this trusted device: it may skip the code.
    trusted_for: Option<EndpointId>,
    _tags: Vec<TempTag>,
}

struct ReceiveSession {
    state: ReceiveState,
    resume: Option<ResumeInfo>,
    task: Option<JoinHandle<()>>,
    /// Started by a trusted device's push (not yet taken by the app).
    pushed_by: Option<EndpointId>,
}

struct Inner {
    endpoint: Endpoint,
    store: FsStore,
    store_dir: PathBuf,
    gate: Arc<Gate>,
    sends: Mutex<HashMap<SessionId, SendSession>>,
    receives: Mutex<HashMap<SessionId, ReceiveSession>>,
    network: Network,
    ticket_lifetime: u64,
    receive_rate: Option<u64>,
    have: Option<Have>,
    trusted: Mutex<HashSet<EndpointId>>,
    /// The Receive screen is open: trusted devices may push.
    accepting: std::sync::atomic::AtomicBool,
    /// Where pushed receives export their files.
    push_dest: Mutex<Option<PathBuf>>,
    /// Pushed receives the app has not taken yet: (session, sender).
    incoming: Mutex<Vec<(SessionId, EndpointId)>>,
}

pub struct TransferService {
    inner: Arc<Inner>,
    router: Router,
    store_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct ControlProtocol(Arc<Inner>);

#[derive(Debug, Clone)]
struct PushProtocol(Arc<Inner>);

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inner")
            .field("endpoint", &self.endpoint.id())
            .finish()
    }
}

impl TransferService {
    /// Binds the endpoint and opens the store. The only place Selis opens sockets.
    pub async fn start(config: ServiceConfig) -> Result<Self, ServiceError> {
        if config.force_relay && config.network == Network::LocalOnly {
            return Err(ServiceError::Invalid("relay-only needs a relay"));
        }
        std::fs::create_dir_all(&config.store_dir)
            .map_err(|e| ServiceError::Storage(e.to_string()))?;
        let store = FsStore::load(&config.store_dir)
            .await
            .map_err(|e| ServiceError::Storage(e.to_string()))?;
        let mut builder = match &config.network {
            Network::Default => Endpoint::builder(presets::N0),
            Network::LocalOnly => {
                Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
            }
            Network::CustomRelay(url) => Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Custom(RelayMap::from_iter([url.clone()]))),
        };
        builder = builder
            .secret_key(config.secret_key)
            .address_lookup(MdnsAddressLookup::builder());
        if config.force_relay {
            builder = builder.clear_ip_transports();
        }
        let endpoint = builder
            .bind()
            .await
            .map_err(|e| ServiceError::Network(e.to_string()))?;
        let gate = Arc::new(Gate::default());
        let inner = Arc::new(Inner {
            endpoint: endpoint.clone(),
            store: store.clone(),
            store_dir: config.store_dir.clone(),
            gate: Arc::clone(&gate),
            sends: Mutex::new(HashMap::new()),
            receives: Mutex::new(HashMap::new()),
            network: config.network,
            ticket_lifetime: config.ticket_lifetime.as_secs().min(TICKET_LIFETIME_SECS),
            receive_rate: config.receive_rate.filter(|r| *r > 0),
            have: config.have,
            trusted: Mutex::new(HashSet::new()),
            accepting: std::sync::atomic::AtomicBool::new(false),
            push_dest: Mutex::new(None),
            incoming: Mutex::new(Vec::new()),
        });
        let blobs = BlobsProtocol::new(&store, Some(gate.events()));
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, blobs)
            .accept(ALPN, ControlProtocol(Arc::clone(&inner)))
            .accept(PUSH_ALPN, PushProtocol(Arc::clone(&inner)))
            .spawn();
        Ok(Self {
            inner,
            router,
            store_dir: config.store_dir,
        })
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.inner.endpoint.id()
    }

    /// Offers files: imports them by reference, builds the collection and returns the ticket.
    pub async fn offer(
        &self,
        items: Vec<OfferItem>,
    ) -> Result<(SessionId, TransferTicket), ServiceError> {
        self.offer_with(items, None, None).await
    }

    /// Offers documents and, for a library move, signatures and settings.
    /// `trusted_for`: a push to that device (it may skip the code).
    pub async fn offer_with(
        &self,
        items: Vec<OfferItem>,
        library: Option<OfferLibrary>,
        trusted_for: Option<EndpointId>,
    ) -> Result<(SessionId, TransferTicket), ServiceError> {
        if items.is_empty() {
            return Err(ServiceError::Invalid("nothing to send"));
        }
        let store = &self.inner.store;
        let mut tags = Vec::new();
        let mut entries: Vec<(String, Hash)> = Vec::new();
        let mut manifest_items = Vec::new();
        let import = |path: PathBuf| async move {
            let size = std::fs::metadata(&path)
                .map_err(|e| ServiceError::Storage(e.to_string()))?
                .len();
            let tag = store
                .blobs()
                .add_path_with_opts(AddPathOptions {
                    path,
                    mode: ImportMode::TryReference,
                    format: BlobFormat::Raw,
                })
                .temp_tag()
                .await
                .map_err(|e| ServiceError::Storage(e.to_string()))?;
            Ok::<_, ServiceError>((tag, size))
        };
        for item in items {
            let mut history = Vec::new();
            for v in item.history {
                let (tag, size) = import(v.path).await?;
                history.push(ManifestVersion {
                    size,
                    blake3: tag.hash(),
                    created_at: v.created_at,
                });
                entries.push((entries.len().to_string(), tag.hash()));
                tags.push(tag);
            }
            let (tag, size) = import(item.path).await?;
            manifest_items.push(ManifestItem {
                title: item.title,
                name: item.name,
                size,
                blake3: tag.hash(),
                history,
                tags: item.tags,
                favorite: item.favorite,
            });
            entries.push((entries.len().to_string(), tag.hash()));
            tags.push(tag);
        }
        let mut manifest = Manifest::new(manifest_items);
        if let Some(library) = library {
            let mut signatures = Vec::new();
            for s in library.signatures {
                let (tag, size) = import(s.path).await?;
                signatures.push(ManifestSignature {
                    id: s.id,
                    kind: s.kind,
                    size,
                    blake3: tag.hash(),
                    created_at: s.created_at,
                });
                entries.push((entries.len().to_string(), tag.hash()));
                tags.push(tag);
            }
            manifest.library = Some(LibraryExtras {
                signatures,
                settings: library.settings,
            });
        }
        manifest
            .validate()
            .map_err(|_| ServiceError::Invalid("documents cannot be offered"))?;
        let collection = Collection::from_iter(entries)
            .store(store)
            .await
            .map_err(|e| ServiceError::Storage(e.to_string()))?;
        let collection_hash = collection.hash();
        tags.push(collection);

        if self.inner.network != Network::LocalOnly {
            let _ = tokio::time::timeout(ONLINE_TIMEOUT, self.inner.endpoint.online()).await;
        }
        let mut addr = self.inner.endpoint.addr();
        if addr.addrs.len() > MAX_TICKET_ADDRS {
            // Keep the relay and the first direct addresses.
            let keep: std::collections::BTreeSet<_> = addr
                .addrs
                .iter()
                .filter(|a| matches!(a, iroh::TransportAddr::Relay(_)))
                .cloned()
                .chain(
                    addr.addrs
                        .iter()
                        .filter(|a| !matches!(a, iroh::TransportAddr::Relay(_)))
                        .cloned(),
                )
                .take(MAX_TICKET_ADDRS)
                .collect();
            addr.addrs = keep;
        }
        let ticket = TransferTicket {
            addr,
            collection: collection_hash,
            token: random_token(),
            expires_at: now_secs() + self.inner.ticket_lifetime,
        };
        let hashes: HashSet<Hash> = manifest.hashes().chain([collection_hash]).collect();
        let id = new_session_id();
        lock(&self.inner.sends).insert(
            id.clone(),
            SendSession {
                token: ticket.token,
                expires_at: ticket.expires_at,
                used: false,
                session_token: random_token(),
                hashes,
                manifest,
                state: SendState::WaitingForReceiver,
                peer: None,
                decision: None,
                trusted_for,
                _tags: tags,
            },
        );
        Ok((id, ticket))
    }

    /// The devices this one trusts (they may push here; pushes to them skip the code).
    pub fn set_trusted(&self, ids: impl IntoIterator<Item = EndpointId>) {
        *lock(&self.inner.trusted) = ids.into_iter().collect();
    }

    /// The Receive screen is open (`Some(dest)`) or closed: trusted devices may
    /// push only while it is open; their files go to `dest`.
    pub fn set_receiving(&self, dest: Option<PathBuf>) {
        let dest = dest.map(|d| std::path::absolute(&d).unwrap_or(d));
        self.inner
            .accepting
            .store(dest.is_some(), std::sync::atomic::Ordering::SeqCst);
        *lock(&self.inner.push_dest) = dest;
    }

    /// Receives started by trusted devices since the last call: (session, sender).
    pub fn take_incoming(&self) -> Vec<(SessionId, EndpointId)> {
        std::mem::take(&mut *lock(&self.inner.incoming))
    }

    /// Whether a trusted device is reachable, and whether its Receive screen is open.
    pub async fn ping(&self, target: EndpointId) -> Result<bool, TransferError> {
        match self.push_request(target, &PushRequest::Ping).await? {
            PushResponse::Pong { receiving } => Ok(receiving),
            PushResponse::Refused { .. } => Err(TransferError::NotReady),
            PushResponse::Accepted => Err(TransferError::Protocol),
        }
    }

    /// Sends to a trusted device whose Receive screen is open: no QR code, no code.
    pub async fn push(
        &self,
        target: EndpointId,
        items: Vec<OfferItem>,
        library: Option<OfferLibrary>,
    ) -> Result<SessionId, ServiceError> {
        let (id, ticket) = self.offer_with(items, library, Some(target)).await?;
        let invite = PushRequest::Invite {
            ticket: ticket.to_link(),
        };
        let answer = self.push_request(target, &invite).await;
        let failed = match answer {
            Ok(PushResponse::Accepted) => None,
            Ok(PushResponse::Refused { .. }) => Some(TransferError::NotReady),
            Ok(PushResponse::Pong { .. }) => Some(TransferError::Protocol),
            Err(e) => Some(e),
        };
        if let Some(error) = failed
            && let Some(s) = lock(&self.inner.sends).get_mut(&id)
        {
            // The ticket is not usable by anyone else.
            s.used = true;
            s.state = SendState::Failed { error };
        }
        Ok(id)
    }

    async fn push_request(
        &self,
        target: EndpointId,
        request: &PushRequest,
    ) -> Result<PushResponse, TransferError> {
        let conn = tokio::time::timeout(
            PUSH_TIMEOUT,
            self.inner
                .endpoint
                .connect(EndpointAddr::new(target), PUSH_ALPN),
        )
        .await
        .map_err(stop(TransferError::Unreachable, "push: connect timed out"))?
        .map_err(stop(TransferError::Unreachable, "push: connect"))?;
        let exchange = async {
            let (mut tx, mut rx) = conn
                .open_bi()
                .await
                .map_err(stop(TransferError::Unreachable, "push: open stream"))?;
            wire::send(&mut tx, request)
                .await
                .map_err(stop(TransferError::Interrupted, "push: send request"))?;
            let answer: PushResponse = wire::recv(&mut rx)
                .await
                .map_err(stop(TransferError::NotReady, "push: read answer"))?;
            let _ = tx.finish();
            Ok::<_, TransferError>(answer)
        };
        let answer = tokio::time::timeout(PUSH_TIMEOUT, exchange)
            .await
            .map_err(stop(TransferError::Unreachable, "push: exchange timed out"))?;
        conn.close(0u32.into(), b"done");
        answer
    }

    pub fn send_state(&self, id: &str) -> Option<SendState> {
        lock(&self.inner.sends).get(id).map(|s| {
            // An unused ticket past its expiry is reported as such.
            if !s.used && s.expires_at <= now_secs() {
                SendState::Failed {
                    error: TransferError::Expired,
                }
            } else {
                s.state.clone()
            }
        })
    }

    /// The sender's answer to the code on screen.
    pub fn decide(&self, id: &str, confirm: bool) -> Result<(), ServiceError> {
        let mut sends = lock(&self.inner.sends);
        let s = sends.get_mut(id).ok_or(ServiceError::NoSession)?;
        let tx = s
            .decision
            .take()
            .ok_or(ServiceError::Invalid("nothing to confirm"))?;
        let _ = tx.send(confirm);
        Ok(())
    }

    /// Stops offering: the ticket and any confirmed peer lose access.
    pub fn cancel_send(&self, id: &str) {
        if let Some(mut s) = lock(&self.inner.sends).remove(id) {
            if let Some(tx) = s.decision.take() {
                let _ = tx.send(false);
            }
            if let Some(peer) = s.peer {
                self.inner.gate.revoke(peer);
            }
        }
    }

    /// Starts receiving the ticket's documents into `dest` (files named by hash).
    pub fn receive(
        &self,
        ticket: TransferTicket,
        dest: PathBuf,
    ) -> Result<SessionId, ServiceError> {
        if !ticket.is_valid_at(now_secs()) {
            return Err(ServiceError::Invalid("expired"));
        }
        Ok(self.spawn_receive(Start::Ticket(ticket), dest))
    }

    /// Continues an interrupted receive (after the app was stopped, the network dropped…).
    pub fn resume(&self, info: ResumeInfo, dest: PathBuf) -> SessionId {
        self.spawn_receive(Start::Resume(info), dest)
    }

    fn spawn_receive(&self, start: Start, dest: PathBuf) -> SessionId {
        spawn_receive(&self.inner, start, dest, None)
    }

    pub fn receive_state(&self, id: &str) -> Option<ReceiveState> {
        lock(&self.inner.receives).get(id).map(|r| r.state.clone())
    }

    /// The device a send went to (known once it connected).
    pub fn send_peer(&self, id: &str) -> Option<EndpointId> {
        lock(&self.inner.sends).get(id).and_then(|s| s.peer)
    }

    /// The trusted device that pushed this receive, if it was a push.
    pub fn pushed_by(&self, id: &str) -> Option<EndpointId> {
        lock(&self.inner.receives).get(id).and_then(|r| r.pushed_by)
    }

    /// What to keep to resume this receive later (known once the sender confirmed).
    pub fn resume_info(&self, id: &str) -> Option<ResumeInfo> {
        lock(&self.inner.receives)
            .get(id)
            .and_then(|r| r.resume.clone())
    }

    pub fn cancel_receive(&self, id: &str) {
        if let Some(r) = lock(&self.inner.receives).get_mut(id) {
            if let Some(task) = r.task.take() {
                task.abort();
            }
            if !matches!(r.state, ReceiveState::Done { .. }) {
                r.state = ReceiveState::Failed {
                    error: TransferError::Cancelled,
                };
            }
        }
    }

    /// Whether any receive could still be resumed (its partial data must stay).
    pub fn has_resumable(&self) -> bool {
        lock(&self.inner.receives)
            .values()
            .any(|r| r.resume.is_some() && !matches!(r.state, ReceiveState::Done { .. }))
    }

    /// Closes the endpoint (no socket left) and the store. With `wipe`, the
    /// store's files go too (nothing left to resume).
    pub async fn close(&self, wipe: bool) {
        for r in lock(&self.inner.receives).values_mut() {
            if let Some(task) = r.task.take() {
                task.abort();
            }
        }
        // Offers end with the endpoint (their tickets stop working).
        let ids: Vec<SessionId> = lock(&self.inner.sends).keys().cloned().collect();
        for id in ids {
            self.cancel_send(&id);
        }
        let _ = self.router.shutdown().await;
        self.inner.endpoint.close().await;
        let _ = self.inner.store.shutdown().await;
        if wipe {
            let _ = std::fs::remove_dir_all(&self.store_dir);
        }
    }

    /// Whether the store holds `hash` completely (tests: "was it fetched?").
    #[doc(hidden)]
    pub async fn blob_status_for_test(&self, hash: Hash) -> Option<bool> {
        match self.inner.store.blobs().status(hash).await {
            Ok(BlobStatus::Complete { .. }) => Some(true),
            Ok(_) => Some(false),
            Err(_) => None,
        }
    }

    /// Where the blob store lives (partial downloads until finished).
    pub fn store_dir(&self) -> &Path {
        &self.store_dir
    }
}

fn spawn_receive(
    inner: &Arc<Inner>,
    start: Start,
    dest: PathBuf,
    pushed_by: Option<EndpointId>,
) -> SessionId {
    // The store exports only to absolute paths.
    let dest = std::path::absolute(&dest).unwrap_or(dest);
    let id = new_session_id();
    // Pushes share the Receive screen's folder: each gets its own.
    let dest = if pushed_by.is_some() {
        dest.join(&id)
    } else {
        dest
    };
    lock(&inner.receives).insert(
        id.clone(),
        ReceiveSession {
            state: ReceiveState::Connecting,
            resume: None,
            task: None,
            pushed_by,
        },
    );
    let task_inner = Arc::clone(inner);
    let sid = id.clone();
    let task = tokio::spawn(async move {
        let result = receive_task(&task_inner, &sid, start, &dest).await;
        let mut receives = lock(&task_inner.receives);
        if let Some(r) = receives.get_mut(&sid) {
            r.state = match result {
                Ok((items, library)) => ReceiveState::Done { items, library },
                Err(error) => ReceiveState::Failed { error },
            };
        }
    });
    if let Some(r) = lock(&inner.receives).get_mut(&id) {
        r.task = Some(task);
    }
    if let Some(peer) = pushed_by {
        lock(&inner.incoming).push((id.clone(), peer));
    }
    id
}

enum Start {
    Ticket(TransferTicket),
    Resume(ResumeInfo),
}

/// Whether the blob store can still write (a probe file in its directory).
async fn store_writable(dir: &Path) -> bool {
    let probe = dir.join(".probe");
    let ok = tokio::fs::write(&probe, b"ok").await.is_ok();
    let _ = tokio::fs::remove_file(&probe).await;
    ok
}

/// Maps a failure to what the UI shows and logs its cause (`tracing`: silent
/// unless a subscriber is installed — the dev peer and debug app builds).
fn stop<E: std::fmt::Debug>(
    error: TransferError,
    step: &'static str,
) -> impl FnOnce(E) -> TransferError {
    move |cause| {
        tracing::warn!(?error, step, ?cause, "transfer stopped");
        error
    }
}

fn route_of(conn: &Connection) -> Route {
    match conn.paths().iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => Route::Relay,
        Some(p) => match p.remote_addr() {
            iroh::TransportAddr::Ip(sock) if is_local(sock.ip()) => Route::Lan,
            _ => Route::Direct,
        },
        None => Route::Unknown,
    }
}

fn set_receive(inner: &Inner, id: &str, state: ReceiveState) {
    if let Some(r) = lock(&inner.receives).get_mut(id) {
        r.state = state;
    }
}

async fn receive_task(
    inner: &Arc<Inner>,
    id: &str,
    start: Start,
    dest: &Path,
) -> Result<(Vec<ReceivedItem>, Option<ReceivedLibrary>), TransferError> {
    let (addr, collection) = match &start {
        Start::Ticket(t) => (t.addr.clone(), t.collection),
        Start::Resume(r) => (r.addr.clone(), r.collection),
    };
    let sender = addr.id;
    let conn = tokio::time::timeout(CONNECT_TIMEOUT, inner.endpoint.connect(addr.clone(), ALPN))
        .await
        .map_err(stop(
            TransferError::Unreachable,
            "receive: connect timed out",
        ))?
        .map_err(stop(TransferError::Unreachable, "receive: connect"))?;
    let (mut tx, mut rx) = conn.open_bi().await.map_err(stop(
        TransferError::Interrupted,
        "receive: open control stream",
    ))?;
    let token = match &start {
        Start::Ticket(t) => {
            wire::send(&mut tx, &ToSender::Hello { token: t.token })
                .await
                .map_err(stop(TransferError::Interrupted, "receive: send hello"))?;
            Some(t.token)
        }
        Start::Resume(r) => {
            wire::send(&mut tx, &ToSender::Resume { session: r.session })
                .await
                .map_err(stop(TransferError::Interrupted, "receive: send resume"))?;
            None
        }
    };
    let first: ToReceiver = wire::recv(&mut rx).await.map_err(stop(
        TransferError::Interrupted,
        "receive: read first answer",
    ))?;
    let accepted = match (first, token) {
        (ToReceiver::CodeShown, Some(token)) => {
            let code = confirmation_code(&conn, &token, sender, inner.endpoint.id());
            set_receive(inner, id, ReceiveState::Confirm { code });
            wire::recv(&mut rx)
                .await
                .map_err(stop(TransferError::Interrupted, "receive: read decision"))?
        }
        (other, _) => other,
    };
    let (session, manifest) = match accepted {
        ToReceiver::Accepted { session, manifest } => (
            session,
            Manifest::parse(&manifest)
                .map_err(stop(TransferError::Protocol, "receive: parse manifest"))?,
        ),
        ToReceiver::Declined => return Err(TransferError::Declined),
        ToReceiver::Rejected { reason } => {
            return Err(match reason {
                RejectReason::Expired => TransferError::Expired,
                RejectReason::AlreadyUsed => TransferError::AlreadyUsed,
                RejectReason::UnknownTicket | RejectReason::UnknownSession => {
                    TransferError::Unknown
                }
            });
        }
        ToReceiver::CodeShown => return Err(TransferError::Protocol),
    };
    if let Some(r) = lock(&inner.receives).get_mut(id) {
        r.resume = Some(ResumeInfo {
            addr: addr.clone(),
            collection,
            session,
        });
    }

    // The payload, blob by blob, each verified per chunk. Blobs the app already
    // has are skipped only for a trusted device's push: which blobs are fetched
    // tells the sender which ones this device holds, so a sender from a ticket
    // (anyone with a code or link) gets every blob asked for (security audit
    // run-1, lead 5). What an earlier attempt stored is not fetched again.
    let total = manifest.total_bytes();
    let mut known: HashMap<Hash, PathBuf> = HashMap::new();
    let trusted_push = lock(&inner.receives)
        .get(id)
        .is_some_and(|r| r.pushed_by.is_some());
    if trusted_push && let Some(have) = &inner.have {
        for (hash, _) in manifest.blobs() {
            if let Some(path) = (have.0)(&hash) {
                known.insert(hash, path);
            }
        }
    }
    let mut done: u64 = 0;
    let mut missing = Vec::new();
    for (hash, size) in manifest.blobs() {
        let complete = matches!(
            inner.store.blobs().status(hash).await,
            Ok(BlobStatus::Complete { size: s }) if s == size
        );
        if known.contains_key(&hash) || complete {
            done = done.saturating_add(size);
        } else {
            missing.push((hash, size));
        }
    }
    let mut route = Route::Unknown;
    if !missing.is_empty() {
        let blobs = tokio::time::timeout(
            CONNECT_TIMEOUT,
            inner.endpoint.connect(addr, iroh_blobs::ALPN),
        )
        .await
        .map_err(stop(
            TransferError::Unreachable,
            "receive: blobs connect timed out",
        ))?
        .map_err(stop(TransferError::Unreachable, "receive: blobs connect"))?;
        let mut last = tokio::time::Instant::now() - PROGRESS_EVERY;
        let paced_from = (tokio::time::Instant::now(), done);
        for (hash, size) in missing {
            let content = HashAndFormat::raw(hash);
            let partial = inner
                .store
                .remote()
                .local(content)
                .await
                .map(|l| l.local_bytes())
                .unwrap_or(0);
            let mut stream = inner.store.remote().fetch(blobs.clone(), content).stream();
            while let Some(item) = stream.next().await {
                match item {
                    GetProgressItem::Progress(n) => {
                        let bytes = done.saturating_add(partial).saturating_add(n).min(total);
                        route = route_of(&blobs);
                        set_receive(
                            inner,
                            id,
                            ReceiveState::Receiving {
                                bytes,
                                total,
                                route,
                            },
                        );
                        if last.elapsed() >= PROGRESS_EVERY {
                            last = tokio::time::Instant::now();
                            let _ = wire::send(&mut tx, &ToSender::Progress { bytes }).await;
                        }
                        if let Some(rate) = inner.receive_rate {
                            // Testing aid: holding the progress stream back holds the fetch.
                            let due = Duration::from_secs_f64(
                                bytes.saturating_sub(paced_from.1) as f64 / rate as f64,
                            );
                            tokio::time::sleep_until(paced_from.0 + due).await;
                        }
                    }
                    GetProgressItem::Done(_) => break,
                    GetProgressItem::Error(e) => {
                        // A store that no longer answers (its directory deleted, the
                        // disk full) fails every retry: not something to resume.
                        let error = if store_writable(&inner.store_dir).await {
                            TransferError::Interrupted
                        } else {
                            TransferError::Storage
                        };
                        return Err(stop(error, "receive: fetch blob")(e));
                    }
                }
            }
            match inner.store.blobs().status(hash).await {
                Ok(BlobStatus::Complete { size: s }) if s == size => {}
                _ => return Err(TransferError::Mismatch),
            }
            done = done.saturating_add(size);
        }
    }
    let _ = route;

    // Every blob is known or complete at its stated size.
    set_receive(inner, id, ReceiveState::Verifying);
    std::fs::create_dir_all(dest)
        .map_err(stop(TransferError::Storage, "receive: create destination"))?;
    let export = |hash: Hash, ext: &'static str| {
        let store = inner.store.clone();
        let known = known.get(&hash).cloned();
        let path = dest.join(format!("{hash}.{ext}"));
        async move {
            if let Some(path) = known {
                return Ok(path);
            }
            if !path.exists() {
                let part = path.with_extension("part");
                store
                    .blobs()
                    .export(hash, &part)
                    .await
                    .map_err(stop(TransferError::Storage, "receive: export blob"))?;
                std::fs::rename(&part, &path)
                    .map_err(stop(TransferError::Storage, "receive: move exported blob"))?;
            }
            Ok::<_, TransferError>(path)
        }
    };
    let mut items = Vec::new();
    for item in &manifest.items {
        let mut history = Vec::new();
        for v in &item.history {
            history.push(ReceivedVersion {
                path: export(v.blake3, "pdf").await?,
                blake3: v.blake3.to_hex().to_string(),
                size: v.size,
                created_at: v.created_at,
            });
        }
        items.push(ReceivedItem {
            title: item.title.clone(),
            name: item.name.clone(),
            path: export(item.blake3, "pdf").await?,
            blake3: item.blake3.to_hex().to_string(),
            size: item.size,
            history,
            tags: item.tags.clone(),
            favorite: item.favorite,
        });
    }
    let library = match &manifest.library {
        None => None,
        Some(extras) => {
            let mut signatures = Vec::new();
            for s in &extras.signatures {
                signatures.push(ReceivedSignature {
                    id: s.id.clone(),
                    kind: s.kind.clone(),
                    path: export(s.blake3, "png").await?,
                    blake3: s.blake3.to_hex().to_string(),
                    created_at: s.created_at,
                });
            }
            Some(ReceivedLibrary {
                signatures,
                settings: extras.settings.clone(),
            })
        }
    };
    let _ = wire::send(&mut tx, &ToSender::Done { ok: true }).await;
    let _ = tx.finish();
    // Give the sender a moment to read Done before the connection goes.
    let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await;
    Ok((items, library))
}

/// Sends the last message of a conversation and lets the peer read it before
/// the connection goes (it closes on its side once it has).
async fn send_final(
    conn: &Connection,
    tx: &mut iroh::endpoint::SendStream,
    msg: &ToReceiver,
) -> Result<(), wire::WireError> {
    wire::send(tx, msg).await?;
    let _ = tx.finish();
    let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
    Ok(())
}

impl ControlProtocol {
    fn find_by_token(&self, token: &Token) -> Option<SessionId> {
        lock(&self.0.sends)
            .iter()
            .find(|(_, s)| &s.token == token)
            .map(|(id, _)| id.clone())
    }

    fn find_by_session(&self, session: &Token, peer: EndpointId) -> Option<SessionId> {
        lock(&self.0.sends)
            .iter()
            .find(|(_, s)| &s.session_token == session && s.peer == Some(peer))
            .map(|(id, _)| id.clone())
    }

    fn set(&self, id: &str, state: SendState) {
        if let Some(s) = lock(&self.0.sends).get_mut(id) {
            s.state = state;
        }
    }

    async fn serve(&self, conn: Connection) -> Result<(), wire::WireError> {
        let peer = conn.remote_id();
        let (mut tx, mut rx) = conn
            .accept_bi()
            .await
            .map_err(|e| wire::WireError::Io(e.to_string()))?;
        let hello: ToSender = wire::recv(&mut rx).await?;
        let id = match hello {
            ToSender::Hello { token } => {
                let Some(id) = self.find_by_token(&token) else {
                    return send_final(
                        &conn,
                        &mut tx,
                        &ToReceiver::Rejected {
                            reason: RejectReason::UnknownTicket,
                        },
                    )
                    .await;
                };
                // Single use, and only before expiry.
                let (expired, used) = {
                    let mut sends = lock(&self.0.sends);
                    let Some(s) = sends.get_mut(&id) else {
                        return Ok(());
                    };
                    let expired = s.expires_at <= now_secs();
                    let used = s.used;
                    if !expired && !used {
                        s.used = true;
                    }
                    (expired, used)
                };
                if used {
                    return send_final(
                        &conn,
                        &mut tx,
                        &ToReceiver::Rejected {
                            reason: RejectReason::AlreadyUsed,
                        },
                    )
                    .await;
                }
                if expired {
                    self.set(
                        &id,
                        SendState::Failed {
                            error: TransferError::Expired,
                        },
                    );
                    return send_final(
                        &conn,
                        &mut tx,
                        &ToReceiver::Rejected {
                            reason: RejectReason::Expired,
                        },
                    )
                    .await;
                }
                // A push to a trusted device: the device it was sent to (and only
                // that one) connects back without the code, if still trusted here.
                let pushed_to = lock(&self.0.sends).get(&id).and_then(|s| s.trusted_for);
                if pushed_to == Some(peer) && lock(&self.0.trusted).contains(&peer) {
                    // Straight to Accepted below.
                } else if pushed_to.is_some() {
                    return send_final(
                        &conn,
                        &mut tx,
                        &ToReceiver::Rejected {
                            reason: RejectReason::UnknownTicket,
                        },
                    )
                    .await;
                } else {
                    let code = confirmation_code(&conn, &token, self.0.endpoint.id(), peer);
                    let (decided, decision) = oneshot::channel();
                    if let Some(s) = lock(&self.0.sends).get_mut(&id) {
                        s.state = SendState::Confirm { code };
                        s.decision = Some(decided);
                    }
                    wire::send(&mut tx, &ToReceiver::CodeShown).await?;
                    let confirmed = matches!(
                        tokio::time::timeout(CONFIRM_TIMEOUT, decision).await,
                        Ok(Ok(true))
                    );
                    if !confirmed {
                        self.set(
                            &id,
                            SendState::Failed {
                                error: TransferError::Declined,
                            },
                        );
                        return send_final(&conn, &mut tx, &ToReceiver::Declined).await;
                    }
                }
                id
            }
            ToSender::Resume { session } => {
                let Some(id) = self.find_by_session(&session, peer) else {
                    return send_final(
                        &conn,
                        &mut tx,
                        &ToReceiver::Rejected {
                            reason: RejectReason::UnknownSession,
                        },
                    )
                    .await;
                };
                id
            }
            _ => return Err(wire::WireError::Malformed),
        };
        let (session, manifest, hashes, total) = {
            let mut sends = lock(&self.0.sends);
            let Some(s) = sends.get_mut(&id) else {
                return Ok(());
            };
            s.peer = Some(peer);
            s.state = SendState::Sending {
                bytes: 0,
                total: s.manifest.total_bytes(),
                route: route_of(&conn),
            };
            (
                s.session_token,
                s.manifest.to_bytes(),
                s.hashes.clone(),
                s.manifest.total_bytes(),
            )
        };
        // From here on, this peer (and only it) may fetch these blobs.
        self.0.gate.allow(peer, hashes);
        wire::send(&mut tx, &ToReceiver::Accepted { session, manifest }).await?;
        let mut bytes = 0;
        loop {
            match wire::recv::<ToSender>(&mut rx).await {
                Ok(ToSender::Progress { bytes: b }) => {
                    bytes = b.min(total);
                    self.set(
                        &id,
                        SendState::Sending {
                            bytes,
                            total,
                            route: route_of(&conn),
                        },
                    );
                }
                Ok(ToSender::Done { ok: true }) => {
                    self.set(&id, SendState::Done);
                    self.0.gate.revoke(peer);
                    return Ok(());
                }
                Ok(ToSender::Done { ok: false }) => {
                    self.set(
                        &id,
                        SendState::Failed {
                            error: TransferError::Mismatch,
                        },
                    );
                    return Ok(());
                }
                Ok(_) => return Err(wire::WireError::Malformed),
                Err(cause) => {
                    // Dropped mid-way: it may come back with the session token.
                    tracing::warn!(?cause, bytes, total, "send: receiver dropped");
                    self.set(&id, SendState::Interrupted { bytes, total });
                    return Ok(());
                }
            }
        }
    }
}

impl PushProtocol {
    async fn serve(&self, conn: Connection) -> Result<(), wire::WireError> {
        let peer = conn.remote_id();
        let (mut tx, mut rx) = conn
            .accept_bi()
            .await
            .map_err(|e| wire::WireError::Io(e.to_string()))?;
        let request: PushRequest = wire::recv(&mut rx).await?;
        let trusted = lock(&self.0.trusted).contains(&peer);
        let receiving = self.0.accepting.load(std::sync::atomic::Ordering::SeqCst);
        let answer = if !trusted {
            // Nothing about this device is revealed to an unknown one.
            PushResponse::Refused {
                reason: PushRefusal::NotTrusted,
            }
        } else {
            match request {
                PushRequest::Ping => PushResponse::Pong { receiving },
                PushRequest::Invite { .. } if !receiving => PushResponse::Refused {
                    reason: PushRefusal::NotReceiving,
                },
                PushRequest::Invite { ticket } => match TransferTicket::parse(&ticket) {
                    // Only a ticket of the inviting device itself, still valid.
                    Ok(t) if t.addr.id == peer && t.is_valid_at(now_secs()) => {
                        match lock(&self.0.push_dest).clone() {
                            Some(dest) => {
                                spawn_receive(&self.0, Start::Ticket(t), dest, Some(peer));
                                PushResponse::Accepted
                            }
                            None => PushResponse::Refused {
                                reason: PushRefusal::NotReceiving,
                            },
                        }
                    }
                    _ => PushResponse::Refused {
                        reason: PushRefusal::Invalid,
                    },
                },
            }
        };
        wire::send(&mut tx, &answer).await?;
        let _ = tx.finish();
        let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
        Ok(())
    }
}

impl ProtocolHandler for PushProtocol {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let result = self.serve(connection.clone()).await;
        if result.is_err() {
            connection.close(1u32.into(), b"protocol error");
        }
        result.map_err(AcceptError::from_err)
    }
}

impl ProtocolHandler for ControlProtocol {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let result = self.serve(connection.clone()).await;
        if result.is_err() {
            connection.close(1u32.into(), b"protocol error");
        }
        result.map_err(AcceptError::from_err)
    }
}
