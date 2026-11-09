/**
 * Language, theme and library view preferences. Persisted in SQLite (via IPC);
 * mirrored to localStorage only to paint the right theme/language/layout on the
 * very first frame.
 */
import type { ThemeName } from "@selis/ui";
import { create } from "zustand";
import { api, type LibrarySort, type LibraryView, type LocalePref, type Settings, type SettingsPatch, type ThemePref } from "../lib/api";
import { setDarkSystemBars } from "../lib/platform";
import { type AppLocale, changeLocale, resolveLocale } from "../i18n";

const BOOT_KEY = "selis.boot-settings";
/**
 * Version of the boot mirror. A mirror without it predates English first (#31, ADR 0030): its
 * "system" locale is read as "en", like the database's migration 0007 does once.
 */
const BOOT_VERSION = 2;

type SettingsState = Settings & {
  loaded: boolean;
  setLocale: (locale: LocalePref) => Promise<void>;
  setTheme: (theme: ThemePref) => Promise<void>;
  setLibrarySort: (sort: LibrarySort) => Promise<void>;
  setLibraryView: (view: LibraryView) => Promise<void>;
  setNightMode: (on: boolean) => Promise<void>;
  /** Any other stored preference (Settings screen rows). */
  setPreference: <K extends "localOnly" | "appLock" | "versionsPerDocument" | "historyLimitMb" | "scanAuto">(
    key: K,
    value: Settings[K],
  ) => Promise<void>;
  /** A custom relay (`""` = the public relays). Rejects when Rust refuses the address. */
  setRelayUrl: (url: string) => Promise<void>;
  /**
   * Settings from a pack or another device, once the user confirmed them (ForeignSettingsSheet).
   * Rejects when Rust refuses a value; nothing changes then.
   */
  applyPatch: (patch: SettingsPatch) => Promise<void>;
};

const DEFAULTS: Settings = {
  // English on first launch, whatever the device language (docs/SPEC.md).
  locale: "en",
  theme: "system",
  librarySort: "recent",
  libraryView: "grid",
  nightMode: false,
  localOnly: false,
  relayUrl: null,
  versionsPerDocument: 10,
  historyLimitMb: 200,
  appLock: false,
  scanAuto: true,
};

const SORTS: readonly LibrarySort[] = ["recent", "name", "size", "lastOpened"];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Only the persisted fields (the store also holds actions and `loaded`). */
function snapshot(s: Settings): Settings {
  return {
    locale: s.locale,
    theme: s.theme,
    librarySort: s.librarySort,
    libraryView: s.libraryView,
    nightMode: s.nightMode,
    localOnly: s.localOnly,
    relayUrl: s.relayUrl,
    versionsPerDocument: s.versionsPerDocument,
    historyLimitMb: s.historyLimitMb,
    appLock: s.appLock,
    scanAuto: s.scanAuto,
  };
}

/** The boot mirror as stored; anything unreadable falls back to the defaults. */
export function parseBootSettings(raw: string | null): Settings {
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & { v?: unknown };
    const locale = pick(parsed.locale, ["system", "el", "en"], DEFAULTS.locale);
    return {
      locale: locale === "system" && parsed.v !== BOOT_VERSION ? "en" : locale,
      theme: pick(parsed.theme, ["system", "light", "dark", "sepia"], DEFAULTS.theme),
      librarySort: pick(parsed.librarySort, SORTS, DEFAULTS.librarySort),
      libraryView: pick(parsed.libraryView, ["grid", "list"], DEFAULTS.libraryView),
      nightMode: parsed.nightMode === true,
      localOnly: parsed.localOnly === true,
      relayUrl: typeof parsed.relayUrl === "string" ? parsed.relayUrl : null,
      versionsPerDocument:
        typeof parsed.versionsPerDocument === "number" ? parsed.versionsPerDocument : DEFAULTS.versionsPerDocument,
      historyLimitMb: typeof parsed.historyLimitMb === "number" ? parsed.historyLimitMb : DEFAULTS.historyLimitMb,
      appLock: parsed.appLock === true,
      scanAuto: parsed.scanAuto !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

function readBootSettings(): Settings {
  try {
    return parseBootSettings(localStorage.getItem(BOOT_KEY));
  } catch {
    return DEFAULTS;
  }
}

function writeBootSettings(settings: Settings): void {
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify({ v: BOOT_VERSION, ...snapshot(settings) }));
  } catch {
    // Private mode / quota: the DB copy is authoritative anyway.
  }
}

const darkQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function resolveTheme(pref: ThemePref, systemDark: boolean): ThemeName {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref, darkQuery?.matches ?? false);
  document.documentElement.dataset.theme = theme;
  setDarkSystemBars(theme === "dark");
}

function applyLocale(pref: LocalePref): AppLocale {
  const locale = resolveLocale(pref, navigator.languages);
  void changeLocale(locale);
  return locale;
}

export const useSettings = create<SettingsState>()((set, get) => {
  const persist = async (patch: Partial<Settings>) => {
    const previous = snapshot(get());
    const next = { ...previous, ...patch };
    // Optimistic: apply immediately, roll back if the backend refuses.
    set(next);
    writeBootSettings(next);
    try {
      const saved = await api.updateSettings({
        locale: patch.locale ?? null,
        theme: patch.theme ?? null,
        librarySort: patch.librarySort ?? null,
        libraryView: patch.libraryView ?? null,
        nightMode: patch.nightMode ?? null,
        localOnly: patch.localOnly ?? null,
        // null = unchanged (the relay is set through setRelayUrl).
        relayUrl: null,
        versionsPerDocument: patch.versionsPerDocument ?? null,
        historyLimitMb: patch.historyLimitMb ?? null,
        appLock: patch.appLock ?? null,
        scanAuto: patch.scanAuto ?? null,
      });
      set(saved);
      writeBootSettings(saved);
    } catch {
      set(previous);
      writeBootSettings(previous);
      applyTheme(previous.theme);
      applyLocale(previous.locale);
    }
  };

  return {
    ...readBootSettings(),
    loaded: false,
    setLocale: async (locale) => {
      applyLocale(locale);
      await persist({ locale });
    },
    setTheme: async (theme) => {
      applyTheme(theme);
      await persist({ theme });
    },
    setLibrarySort: async (librarySort) => {
      await persist({ librarySort });
    },
    setLibraryView: async (libraryView) => {
      await persist({ libraryView });
    },
    setNightMode: async (nightMode) => {
      await persist({ nightMode });
    },
    setRelayUrl: async (url) => {
      const saved = await api.updateSettings({
        locale: null,
        theme: null,
        librarySort: null,
        libraryView: null,
        nightMode: null,
        localOnly: null,
        relayUrl: url.trim(),
        versionsPerDocument: null,
        historyLimitMb: null,
        appLock: null,
        scanAuto: null,
      });
      set(saved);
      writeBootSettings(saved);
    },
    setPreference: async (key, value) => {
      await persist({ [key]: value });
    },
    applyPatch: async (patch) => {
      const saved = await api.updateSettings(patch);
      set(saved);
      writeBootSettings(saved);
      applyTheme(saved.theme);
      applyLocale(saved.locale);
    },
  };
});

/** Applies boot settings synchronously, then reconciles with the database. */
export function installSettings(): () => void {
  const boot = useSettings.getState();
  applyTheme(boot.theme);
  applyLocale(boot.locale);

  void (async () => {
    try {
      const stored = await api.getSettings();
      useSettings.setState({ ...stored, loaded: true });
      writeBootSettings(stored);
      applyTheme(stored.theme);
      applyLocale(stored.locale);
    } catch {
      useSettings.setState({ loaded: true });
    }
  })();

  const onSystemTheme = () => {
    if (useSettings.getState().theme === "system") applyTheme("system");
  };
  darkQuery?.addEventListener("change", onSystemTheme);
  return () => darkQuery?.removeEventListener("change", onSystemTheme);
}
