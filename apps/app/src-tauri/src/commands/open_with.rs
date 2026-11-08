//! "Open with" / share target. Documents handed over by other apps wait in
//! [`OpenQueue`] until the UI has imported them through the normal import path
//! (`import_document` with a request id, the import state machine) and
//! dismisses them.
//!
//! - Android: `OpenWithPlugin.kt` collects `content://` URIs from VIEW / SEND /
//!   SEND_MULTIPLE intents; `pending_opens` drains it into the queue.
//! - iOS: `CFBundleDocumentTypes` (Info.plist) makes Selis an "Open in" / "Copy
//!   to" target; the system hands a file URL to `RunEvent::Opened` (lib.rs).
//!
//! Transfer links (`selis://transfer/…`, e.g. a QR code scanned with the camera
//! app) arrive the same ways and wait here, newest only, for the Transfer
//! screen (`pending_transfer_link`), which validates them.
//!
//! The UI asks on startup and whenever the app comes back to the foreground.
//! Reading the queue does not consume it, so a lost reply is simply asked for
//! again (docs/adr/0005-ipc-reliability.md).

use std::sync::Arc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime, State};

use super::CommandResult;

/// A SEND_MULTIPLE beyond this is truncated (the rest is logged and dropped).
#[cfg_attr(
    not(any(target_os = "android", target_os = "ios", target_os = "macos")),
    allow(dead_code)
)]
const MAX_PENDING: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingOpen {
    pub id: String,
    /// `content://` URI (Android) or `file://` URL (iOS), passed to `import_document`.
    pub source: String,
    /// The sender's file name, when it told us.
    pub name: Option<String>,
    /// A `.selispack` (its magic bytes), not a PDF: the pack import takes it.
    pub pack: bool,
}

#[derive(Default)]
pub struct OpenQueue {
    inner: Mutex<QueueState>,
}

#[derive(Default)]
#[cfg_attr(
    not(any(target_os = "android", target_os = "ios", target_os = "macos")),
    allow(dead_code)
)]
struct QueueState {
    items: Vec<PendingOpen>,
    next_id: u64,
    link: Option<String>,
    sniffed: std::collections::HashSet<String>,
}

/// Longest transfer link kept (a real one is a few hundred characters).
const MAX_LINK_CHARS: usize = 4096;

impl OpenQueue {
    /// Adds a document unless the same source is already waiting.
    // Windows/Linux have no "Open with" source yet (desktop file associations: P6).
    #[cfg_attr(
        not(any(target_os = "android", target_os = "ios", target_os = "macos")),
        allow(dead_code)
    )]
    pub fn push(&self, source: String, name: Option<String>) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if state.items.iter().any(|item| item.source == source) {
            return;
        }
        if state.items.len() >= MAX_PENDING {
            eprintln!("selis: open-with queue full, dropping a shared document");
            return;
        }
        state.next_id += 1;
        let id = format!("open-{}", state.next_id);
        let name = name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
        state.items.push(PendingOpen {
            id,
            source,
            name,
            pack: false,
        });
    }

    /// Items whose first bytes have not been looked at yet.
    pub fn unsniffed(&self) -> Vec<PendingOpen> {
        let state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        state
            .items
            .iter()
            .filter(|i| !state.sniffed.contains(&i.id))
            .cloned()
            .collect()
    }

    /// Records what an item's first bytes said (a pack or not).
    pub fn mark_sniffed(&self, id: &str, pack: bool) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        state.sniffed.insert(id.to_owned());
        if let Some(item) = state.items.iter_mut().find(|i| i.id == id) {
            item.pack = pack;
        }
    }

    pub fn list(&self) -> Vec<PendingOpen> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .items
            .clone()
    }

    /// Keeps the newest transfer link (anything else is ignored).
    #[cfg_attr(
        not(any(target_os = "android", target_os = "ios", target_os = "macos")),
        allow(dead_code)
    )]
    pub fn push_link(&self, link: &str) {
        let link = link.trim();
        if link.len() <= MAX_LINK_CHARS && link.starts_with("selis://transfer/") {
            self.inner.lock().unwrap_or_else(|p| p.into_inner()).link = Some(link.to_owned());
        }
    }

    pub fn link(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .link
            .clone()
    }

    /// Forgets `link` once the Transfer screen has it (another, newer one stays).
    pub fn dismiss_link(&self, link: &str) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if state.link.as_deref() == Some(link) {
            state.link = None;
        }
    }

    /// Removes an entry; unknown ids are ignored (dismiss is idempotent).
    pub fn dismiss(&self, id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .items
            .retain(|item| item.id != id);
    }
}

/// Documents waiting to be imported, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn pending_opens<R: Runtime>(
    app: AppHandle<R>,
    queue: State<'_, Arc<OpenQueue>>,
) -> CommandResult<Vec<PendingOpen>> {
    #[cfg(target_os = "android")]
    android::drain(&app, &queue).await?;
    // Packs travel through the same "Open with" as PDFs; the magic bytes tell them apart.
    for item in queue.unsniffed() {
        // The item came from Android, not from the UI: it is granted just below.
        let path = item
            .source
            .parse::<tauri_plugin_fs::FilePath>()
            .unwrap_or_else(|never| match never {});
        let kind = super::pack::sniff_source(app.clone(), path).await;
        queue.mark_sniffed(&item.id, matches!(kind, Ok(Some(_))));
    }
    let items = queue.list();
    for item in &items {
        super::picker::grant(&app, &item.source);
    }
    Ok(items)
}

/// Called once a pending document has been imported (or failed for good).
#[tauri::command]
#[specta::specta]
pub async fn dismiss_open(queue: State<'_, Arc<OpenQueue>>, id: String) -> CommandResult<()> {
    queue.dismiss(&id);
    Ok(())
}

/// The transfer link waiting for the Transfer screen, if any. Not consumed:
/// the screen dismisses it once it has it (a lost reply is asked for again).
#[tauri::command]
#[specta::specta]
pub async fn pending_transfer_link<R: Runtime>(
    app: AppHandle<R>,
    queue: State<'_, Arc<OpenQueue>>,
) -> CommandResult<Option<String>> {
    #[cfg(target_os = "android")]
    android::drain(&app, &queue).await?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(queue.link())
}

#[tauri::command]
#[specta::specta]
pub async fn dismiss_transfer_link(
    queue: State<'_, Arc<OpenQueue>>,
    link: String,
) -> CommandResult<()> {
    queue.dismiss_link(&link);
    Ok(())
}

/// Registers the Android side (`OpenWithPlugin.kt`). No JS-facing commands:
/// only Rust talks to it, so it needs no capability.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-open-with")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.anywecon.selis", "OpenWithPlugin")?;
                app.manage(android::OpenWithHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod android {
    use std::time::Duration;

    use serde::Deserialize;
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    use super::OpenQueue;
    use crate::commands::{CommandError, CommandResult, ErrorCode};

    pub struct OpenWithHandle<R: Runtime>(pub PluginHandle<R>);

    /// How long a command waits for plugin setup on a cold start.
    const HANDLE_WAIT: Duration = Duration::from_secs(10);
    const HANDLE_STEP: Duration = Duration::from_millis(50);

    #[derive(Deserialize)]
    struct Taken {
        items: Vec<TakenItem>,
        link: Option<String>,
    }

    #[derive(Deserialize)]
    struct TakenItem {
        uri: String,
        name: Option<String>,
    }

    /// Moves what the Kotlin plugin collected into the queue (a JNI call, not
    /// WebView IPC, so nothing can get lost on the way).
    pub async fn drain<R: Runtime>(app: &AppHandle<R>, queue: &OpenQueue) -> CommandResult<()> {
        // On a slow cold start the UI asks before plugin setup has registered the
        // handle; answering "nothing" then lost the launch intent's link or PDF
        // until the app came back to the foreground. Wait for it instead.
        let mut waited = Duration::ZERO;
        let handle = loop {
            if let Some(handle) = app.try_state::<OpenWithHandle<R>>() {
                break handle;
            }
            if waited >= HANDLE_WAIT {
                return Err(CommandError::new(
                    ErrorCode::Internal,
                    "open-with: plugin not registered",
                ));
            }
            tokio::time::sleep(HANDLE_STEP).await;
            waited += HANDLE_STEP;
        };
        let taken: Taken = handle
            .0
            .run_mobile_plugin_async("takePending", ())
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("open-with: {e}")))?;
        for item in taken.items {
            queue.push(item.uri, item.name);
        }
        if let Some(link) = taken.link {
            queue.push_link(&link);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_transfer_link_only() {
        let q = OpenQueue::default();
        q.push_link("https://example.com");
        q.push_link(&format!("selis://transfer/{}", "a".repeat(5000)));
        assert_eq!(q.link(), None);
        q.push_link(" selis://transfer/one ");
        q.push_link("selis://transfer/two");
        assert_eq!(q.link().as_deref(), Some("selis://transfer/two"));
        q.dismiss_link("selis://transfer/one");
        assert!(q.link().is_some());
        q.dismiss_link("selis://transfer/two");
        assert_eq!(q.link(), None);
        assert!(q.list().is_empty());
    }

    #[test]
    fn dedupes_by_source_and_dismisses() {
        let q = OpenQueue::default();
        q.push("content://a".into(), Some(" A.pdf ".into()));
        q.push("content://a".into(), None);
        q.push("content://b".into(), Some("  ".into()));
        let items = q.list();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name.as_deref(), Some("A.pdf"));
        assert_eq!(items[1].name, None);
        assert_ne!(items[0].id, items[1].id);
        q.dismiss(&items[0].id);
        q.dismiss(&items[0].id);
        assert_eq!(q.list(), [items[1].clone()]);
        // A dismissed source can arrive again later (a new "Open with").
        q.push("content://a".into(), None);
        assert_eq!(q.list().len(), 2);
    }

    #[test]
    fn caps_the_queue() {
        let q = OpenQueue::default();
        for i in 0..(MAX_PENDING + 5) {
            q.push(format!("content://{i}"), None);
        }
        assert_eq!(q.list().len(), MAX_PENDING);
    }
}
