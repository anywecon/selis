use std::sync::Arc;

use selis_core::{Library, LibrarySort, RetentionPolicy};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{CommandError, CommandResult, ErrorCode};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
/// UI language. English unless the user picks another one, whatever the device
/// language ("English first", docs/SPEC.md); `System` follows the device.
pub enum LocalePref {
    System,
    El,
    #[default]
    En,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePref {
    #[default]
    System,
    Light,
    Dark,
    Sepia,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LibraryView {
    #[default]
    Grid,
    List,
}

/// Allowed values (the pickers offer a subset).
/// At least 2: v1 (the original) and the current version are always kept.
pub const VERSIONS_PER_DOCUMENT: std::ops::RangeInclusive<u32> = 2..=100;
pub const HISTORY_LIMIT_MB: std::ops::RangeInclusive<u32> = 10..=10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub locale: LocalePref,
    pub theme: ThemePref,
    pub library_sort: LibrarySort,
    pub library_view: LibraryView,
    /// Reader night mode for pages (lightness inverted, images kept).
    pub night_mode: bool,
    /// Transfer without the relay, same Wi-Fi only (used from P3).
    pub local_only: bool,
    /// A self-hosted relay (`https://…`) instead of the public n0 relays.
    pub relay_url: Option<String>,
    /// Versions kept per document, the current one included.
    pub versions_per_document: u32,
    /// History kept per document (versions other than v1 and the current one), in MB.
    pub history_limit_mb: u32,
    /// App lock (biometric gate lands later; the choice is stored now).
    pub app_lock: bool,
    /// Scan: capture automatically when the page is steady and sharp (ADR 0032).
    pub scan_auto: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let retention = RetentionPolicy::default();
        Self {
            locale: LocalePref::default(),
            theme: ThemePref::default(),
            library_sort: LibrarySort::default(),
            library_view: LibraryView::default(),
            night_mode: false,
            local_only: false,
            relay_url: None,
            versions_per_document: retention.versions_per_document,
            history_limit_mb: u32::try_from(retention.history_limit_bytes / (1024 * 1024))
                .unwrap_or(200),
            app_lock: false,
            scan_auto: true,
        }
    }
}

impl Settings {
    pub fn retention(&self) -> RetentionPolicy {
        RetentionPolicy {
            versions_per_document: self.versions_per_document,
            history_limit_bytes: u64::from(self.history_limit_mb) * 1024 * 1024,
        }
    }
}

/// Partial update; `None` fields are left unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub locale: Option<LocalePref>,
    pub theme: Option<ThemePref>,
    pub library_sort: Option<LibrarySort>,
    pub library_view: Option<LibraryView>,
    pub night_mode: Option<bool>,
    pub local_only: Option<bool>,
    /// `""` goes back to the public relays.
    pub relay_url: Option<String>,
    pub versions_per_document: Option<u32>,
    pub history_limit_mb: Option<u32>,
    pub app_lock: Option<bool>,
    pub scan_auto: Option<bool>,
}

const KEY_LOCALE: &str = "locale";
const KEY_THEME: &str = "theme";
const KEY_LIBRARY_SORT: &str = "librarySort";
const KEY_LIBRARY_VIEW: &str = "libraryView";
const KEY_NIGHT_MODE: &str = "nightMode";
const KEY_LOCAL_ONLY: &str = "localOnly";
const KEY_RELAY_URL: &str = "relayUrl";
const KEY_VERSIONS_PER_DOCUMENT: &str = "versionsPerDocument";
const KEY_HISTORY_LIMIT_MB: &str = "historyLimitMb";
const KEY_APP_LOCK: &str = "appLock";
const KEY_SCAN_AUTO: &str = "scanAuto";

pub(crate) fn load(library: &Library) -> CommandResult<Settings> {
    let mut settings = Settings::default();
    for (key, value) in library.settings()? {
        // Unknown or malformed values fall back to defaults instead of failing startup.
        match key.as_str() {
            KEY_LOCALE => settings.locale = serde_json::from_value(value).unwrap_or_default(),
            KEY_THEME => settings.theme = serde_json::from_value(value).unwrap_or_default(),
            KEY_LIBRARY_SORT => {
                settings.library_sort = serde_json::from_value(value).unwrap_or_default();
            }
            KEY_LIBRARY_VIEW => {
                settings.library_view = serde_json::from_value(value).unwrap_or_default();
            }
            KEY_NIGHT_MODE => settings.night_mode = value.as_bool().unwrap_or_default(),
            KEY_LOCAL_ONLY => settings.local_only = value.as_bool().unwrap_or_default(),
            KEY_RELAY_URL => {
                settings.relay_url = value
                    .as_str()
                    .and_then(selis_transfer::parse_relay_url)
                    .map(|u| u.to_string());
            }
            KEY_APP_LOCK => settings.app_lock = value.as_bool().unwrap_or_default(),
            KEY_SCAN_AUTO => settings.scan_auto = value.as_bool().unwrap_or(true),
            KEY_VERSIONS_PER_DOCUMENT => {
                if let Some(v) = in_range(&value, &VERSIONS_PER_DOCUMENT) {
                    settings.versions_per_document = v;
                }
            }
            KEY_HISTORY_LIMIT_MB => {
                if let Some(v) = in_range(&value, &HISTORY_LIMIT_MB) {
                    settings.history_limit_mb = v;
                }
            }
            _ => {}
        }
    }
    Ok(settings)
}

#[tauri::command]
#[specta::specta]
pub async fn get_settings(library: State<'_, Arc<Library>>) -> CommandResult<Settings> {
    load(&library)
}

#[tauri::command]
#[specta::specta]
pub async fn update_settings(
    library: State<'_, Arc<Library>>,
    patch: SettingsPatch,
) -> CommandResult<Settings> {
    apply_patch(&library, patch)
}

/// Validates and stores a partial update; tightened retention limits apply at once.
pub(crate) fn apply_patch(library: &Library, patch: SettingsPatch) -> CommandResult<Settings> {
    if let Some(v) = patch.versions_per_document {
        check_range("versionsPerDocument", v, &VERSIONS_PER_DOCUMENT)?;
    }
    if let Some(v) = patch.history_limit_mb {
        check_range("historyLimitMb", v, &HISTORY_LIMIT_MB)?;
    }
    store(library, KEY_LOCALE, patch.locale)?;
    store(library, KEY_THEME, patch.theme)?;
    store(library, KEY_LIBRARY_SORT, patch.library_sort)?;
    store(library, KEY_LIBRARY_VIEW, patch.library_view)?;
    store(library, KEY_NIGHT_MODE, patch.night_mode)?;
    store(library, KEY_LOCAL_ONLY, patch.local_only)?;
    if let Some(url) = patch.relay_url.as_deref() {
        let url = url.trim();
        if url.is_empty() {
            library.set_setting(KEY_RELAY_URL, &serde_json::Value::Null)?;
        } else {
            let parsed = selis_transfer::parse_relay_url(url).ok_or_else(|| {
                CommandError::new(
                    ErrorCode::InvalidArgument,
                    "relayUrl must be an https:// URL",
                )
            })?;
            store(library, KEY_RELAY_URL, Some(parsed.to_string()))?;
        }
    }
    store(library, KEY_APP_LOCK, patch.app_lock)?;
    store(library, KEY_SCAN_AUTO, patch.scan_auto)?;
    let retention_changed =
        patch.versions_per_document.is_some() || patch.history_limit_mb.is_some();
    store(
        library,
        KEY_VERSIONS_PER_DOCUMENT,
        patch.versions_per_document,
    )?;
    store(library, KEY_HISTORY_LIMIT_MB, patch.history_limit_mb)?;
    let settings = load(library)?;
    if retention_changed {
        // Tightened limits take effect at once (P2 saves apply them too).
        library.apply_retention(&settings.retention())?;
    }
    Ok(settings)
}

/// Settings that came from outside this device (a `.selispack`, another device's library
/// move): what they would change here. Nothing is applied until the user confirms them
/// (security audit run-1, leads 4 and 5); the confirmed `patch` then goes to `update_settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignSettings {
    /// Only the valid values that differ from this device's.
    pub patch: SettingsPatch,
    /// Versions that applying `patch` deletes at once (tightened retention), 0 otherwise: the
    /// second, destructive confirmation says how many.
    pub prunes_versions: u32,
}

/// What a foreign settings map would change on this device; `None` when nothing (unknown keys,
/// invalid values and values equal to this device's are left out).
pub(crate) fn foreign_settings(
    library: &Library,
    map: serde_json::Map<String, serde_json::Value>,
) -> CommandResult<Option<ForeignSettings>> {
    let Ok(patch) = serde_json::from_value::<SettingsPatch>(serde_json::Value::Object(map)) else {
        return Ok(None);
    };
    let current = load(library)?;
    fn differs<T: PartialEq>(next: Option<T>, now: T) -> Option<T> {
        next.filter(|v| *v != now)
    }
    let relay_url = patch.relay_url.and_then(|url| {
        let url = url.trim();
        let next = if url.is_empty() {
            None
        } else {
            Some(selis_transfer::parse_relay_url(url)?.to_string())
        };
        (next != current.relay_url).then(|| next.unwrap_or_default())
    });
    let out = SettingsPatch {
        locale: differs(patch.locale, current.locale),
        theme: differs(patch.theme, current.theme),
        library_sort: differs(patch.library_sort, current.library_sort),
        library_view: differs(patch.library_view, current.library_view),
        night_mode: differs(patch.night_mode, current.night_mode),
        local_only: differs(patch.local_only, current.local_only),
        relay_url,
        versions_per_document: differs(
            patch
                .versions_per_document
                .filter(|v| VERSIONS_PER_DOCUMENT.contains(v)),
            current.versions_per_document,
        ),
        history_limit_mb: differs(
            patch
                .history_limit_mb
                .filter(|v| HISTORY_LIMIT_MB.contains(v)),
            current.history_limit_mb,
        ),
        app_lock: differs(patch.app_lock, current.app_lock),
        scan_auto: differs(patch.scan_auto, current.scan_auto),
    };
    if out == SettingsPatch::default() {
        return Ok(None);
    }
    let mut next = current.clone();
    if let Some(v) = out.versions_per_document {
        next.versions_per_document = v;
    }
    if let Some(v) = out.history_limit_mb {
        next.history_limit_mb = v;
    }
    let prunes_versions = if next.retention() == current.retention() {
        0
    } else {
        library
            .preview_retention(&next.retention())?
            .removed_versions
    };
    Ok(Some(ForeignSettings {
        patch: out,
        prunes_versions,
    }))
}

fn in_range(value: &serde_json::Value, range: &std::ops::RangeInclusive<u32>) -> Option<u32> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| range.contains(v))
}

fn check_range(name: &str, value: u32, range: &std::ops::RangeInclusive<u32>) -> CommandResult<()> {
    if range.contains(&value) {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::InvalidArgument,
            format!("{name} must be in {}..={}", range.start(), range.end()),
        ))
    }
}

fn store<T: Serialize>(library: &Library, key: &str, value: Option<T>) -> CommandResult<()> {
    if let Some(value) = value {
        library.set_setting(
            key,
            &serde_json::to_value(value).map_err(selis_core::Error::from)?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = Library::open(dir.path()).expect("library");
        (dir, lib)
    }

    /// Security audit run-1, lead 4: foreign settings are only described, never applied, and
    /// the history they would delete is counted first.
    #[test]
    fn foreign_settings_change_nothing_and_count_what_retention_would_delete() {
        let (_dir, lib) = library();
        let doc = lib
            .import_reader(b"%PDF-1.7\n% a\n%%EOF\n".as_slice(), "a")
            .expect("import")
            .document;
        let keep_all = RetentionPolicy {
            versions_per_document: 100,
            history_limit_bytes: u64::MAX,
        };
        for i in 0..5 {
            let upload = format!("u{i}");
            let bytes = format!("%PDF-1.7\n% v{i}\n%%EOF\n").into_bytes();
            lib.write_upload_chunk(&upload, 0, &bytes).expect("chunk");
            let current = lib.get_document(&doc.id).expect("doc");
            lib.commit_working_copy(&upload, &doc.id, &current.blake3, bytes.len() as u64)
                .expect("working copy");
            lib.save_version(&doc.id, selis_core::VersionLabel::Auto, &keep_all)
                .expect("version");
        }
        let before = load(&lib).expect("load");
        let map = serde_json::json!({
            "versionsPerDocument": 2,
            "historyLimitMb": 10,
            "relayUrl": "https://relay.invalid",
            "localOnly": false,
            "theme": "sepia",
            "unknown": 1,
            "scanAuto": "not a bool",
        });
        let serde_json::Value::Object(map) = map else {
            unreachable!()
        };
        let foreign = foreign_settings(&lib, map.clone()).expect("foreign");
        assert!(
            foreign.is_none(),
            "an invalid field makes the map unreadable: nothing offered"
        );
        let mut map = map;
        map.remove("scanAuto");
        let foreign = foreign_settings(&lib, map)
            .expect("foreign")
            .expect("changes");
        assert_eq!(load(&lib).expect("load"), before, "nothing applied");
        assert_eq!(foreign.patch.versions_per_document, Some(2));
        assert_eq!(foreign.patch.history_limit_mb, Some(10));
        assert_eq!(
            foreign.patch.relay_url.as_deref(),
            Some("https://relay.invalid/")
        );
        assert_eq!(foreign.patch.local_only, None, "same as this device");
        assert_eq!(foreign.patch.theme, Some(ThemePref::Sepia));
        assert_eq!(foreign.prunes_versions, 4);
        let two = RetentionPolicy {
            versions_per_document: 2,
            history_limit_bytes: u64::MAX,
        };
        assert_eq!(
            lib.preview_retention(&two)
                .expect("preview")
                .removed_versions,
            4,
            "no version deleted"
        );
    }

    #[test]
    fn defaults_match_the_brief() {
        let (_dir, lib) = library();
        let s = load(&lib).expect("load");
        assert_eq!((s.versions_per_document, s.history_limit_mb), (10, 200));
        assert!(!s.local_only && !s.app_lock && !s.night_mode);
        assert!(s.scan_auto);
        assert_eq!(s.theme, ThemePref::System);
        // English first, whatever the device language; Greek is a choice in Settings.
        assert_eq!(s.locale, LocalePref::En);
    }

    #[test]
    fn stores_validates_and_clears_a_custom_relay() {
        let (_dir, lib) = library();
        let bad = apply_patch(
            &lib,
            SettingsPatch {
                relay_url: Some("http://relay.example.org".into()),
                ..SettingsPatch::default()
            },
        );
        assert!(bad.is_err());
        let saved = apply_patch(
            &lib,
            SettingsPatch {
                relay_url: Some("https://relay.example.org".into()),
                ..SettingsPatch::default()
            },
        )
        .expect("patch");
        assert_eq!(
            saved.relay_url.as_deref(),
            Some("https://relay.example.org/")
        );
        let cleared = apply_patch(
            &lib,
            SettingsPatch {
                relay_url: Some(String::new()),
                ..SettingsPatch::default()
            },
        )
        .expect("patch");
        assert_eq!(cleared.relay_url, None);
    }

    #[test]
    fn stores_and_validates_a_patch() {
        let (_dir, lib) = library();
        let saved = apply_patch(
            &lib,
            SettingsPatch {
                local_only: Some(true),
                versions_per_document: Some(20),
                history_limit_mb: Some(500),
                theme: Some(ThemePref::Sepia),
                ..SettingsPatch::default()
            },
        )
        .expect("patch");
        assert!(saved.local_only);
        let manual = apply_patch(
            &lib,
            SettingsPatch {
                scan_auto: Some(false),
                ..SettingsPatch::default()
            },
        )
        .expect("patch");
        assert!(!manual.scan_auto && manual.local_only);
        assert_eq!(
            (saved.versions_per_document, saved.history_limit_mb),
            (20, 500)
        );
        assert_eq!(load(&lib).expect("reload").theme, ThemePref::Sepia);

        let refused = apply_patch(
            &lib,
            SettingsPatch {
                versions_per_document: Some(0),
                local_only: Some(false),
                ..SettingsPatch::default()
            },
        );
        assert!(refused.is_err());
        // Nothing of a refused patch is stored.
        assert!(load(&lib).expect("reload").local_only);
    }
}
