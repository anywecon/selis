/**
 * `.selispack` (ADR 0012) export and import state. Export: what goes, an
 * optional passphrase, then the share sheet. Import: a picked or "Open with"
 * file; encrypted packs ask for the passphrase (again after a wrong one).
 */
import { create } from "zustand";
import { ApiError, api, type ForeignSettings, type PackKind, type PackProblem, type PackSummary } from "../../lib/api";

export const MIN_PASSPHRASE = 8;

export type PackImportState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "passphrase"; source: string; name: string | null; wrong: boolean }
  | { phase: "importing"; source: string; name: string | null }
  /** `settings`: what the pack's settings would change, until the user applies or declines them. */
  | { phase: "done"; documents: number; duplicates: number; signatures: number; settings: ForeignSettings | null }
  | { phase: "failed"; problem: PackProblem | "io" };

export type PackExportState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "done"; summary: PackSummary }
  | { phase: "failed" };

type PackState = {
  importState: PackImportState;
  exportState: PackExportState;
  /** A pack to open (picked or from "Open with"): reads its kind first. */
  openPack: (source: string, name: string | null) => Promise<void>;
  pickAndOpen: () => Promise<void>;
  submitPassphrase: (passphrase: string) => Promise<void>;
  resetImport: () => void;
  /** The pack's settings were applied or declined (ForeignSettingsSheet): nothing left to ask. */
  settingsHandled: () => void;
  exportPack: (documentIds: string[] | null, includeHistory: boolean, passphrase: string | null) => Promise<void>;
  resetExport: () => void;
  /** Documents arrived (the library listing refreshes). */
  onImported: ((ids: string[]) => void) | null;
};

async function runImport(
  set: (s: Partial<PackState>) => void,
  get: () => PackState,
  source: string,
  name: string | null,
  passphrase: string | null,
): Promise<void> {
  set({ importState: { phase: "importing", source, name } });
  try {
    const result = await api.packImport(source, passphrase);
    if (result.status === "imported") {
      set({
        importState: {
          phase: "done",
          documents: result.documentIds.length - result.duplicates,
          duplicates: result.duplicates,
          signatures: result.signatures,
          settings: result.settings,
        },
      });
      get().onImported?.(result.documentIds);
    } else if (result.problem === "wrongPassphrase" || result.problem === "passphraseNeeded") {
      set({ importState: { phase: "passphrase", source, name, wrong: result.problem === "wrongPassphrase" } });
    } else {
      set({ importState: { phase: "failed", problem: result.problem } });
    }
  } catch {
    set({ importState: { phase: "failed", problem: "io" } });
  }
}

export const usePack = create<PackState>()((set, get) => ({
  importState: { phase: "idle" },
  exportState: { phase: "idle" },
  onImported: null,

  openPack: async (source, name) => {
    set({ importState: { phase: "checking" } });
    let kind: PackKind | null;
    try {
      kind = await api.packKind(source);
    } catch {
      set({ importState: { phase: "failed", problem: "io" } });
      return;
    }
    if (kind === null) {
      set({ importState: { phase: "failed", problem: "notAPack" } });
      return;
    }
    if (kind === "encrypted") {
      set({ importState: { phase: "passphrase", source, name, wrong: false } });
      return;
    }
    await runImport(set, get, source, name, null);
  },

  pickAndOpen: async () => {
    try {
      const picked = await api.pickPack();
      if (picked.status === "picked") await get().openPack(picked.source, null);
    } catch {
      set({ importState: { phase: "failed", problem: "io" } });
    }
  },

  submitPassphrase: async (passphrase) => {
    const state = get().importState;
    if (state.phase !== "passphrase") return;
    await runImport(set, get, state.source, state.name, passphrase);
  },

  resetImport: () => set({ importState: { phase: "idle" } }),

  settingsHandled: () => {
    const state = get().importState;
    if (state.phase === "done") set({ importState: { ...state, settings: null } });
  },

  exportPack: async (documentIds, includeHistory, passphrase) => {
    if (get().exportState.phase === "working") return;
    set({ exportState: { phase: "working" } });
    try {
      const result = await api.packExport(documentIds, includeHistory, passphrase);
      // A cancelled save dialog (desktop) wrote nothing: back to the choices as they were.
      set({ exportState: result.status === "shared" ? { phase: "done", summary: result.summary } : { phase: "idle" } });
    } catch (err) {
      set({ exportState: { phase: "failed" } });
      if (!(err instanceof ApiError)) throw err;
    }
  },

  resetExport: () => set({ exportState: { phase: "idle" } }),
}));
