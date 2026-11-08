/**
 * Settings from a pack or another device (security audit run-1, leads 4 and 5): nothing is
 * applied before the user confirms the list; history-deleting retention needs a second,
 * explicit confirmation.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "../../lib/api";
import type { ForeignSettings, Settings, SettingsPatch } from "../../lib/api";

const updateSettings = vi.fn<(patch: SettingsPatch) => Promise<Settings>>();

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, updateSettings } };
});

const { initI18n } = await import("../../i18n");
const { ForeignSettingsSheet } = await import("./ForeignSettingsSheet");

const NONE: SettingsPatch = {
  locale: null,
  theme: null,
  librarySort: null,
  libraryView: null,
  nightMode: null,
  localOnly: null,
  relayUrl: null,
  versionsPerDocument: null,
  historyLimitMb: null,
  appLock: null,
  scanAuto: null,
};

const SAVED: Settings = {
  locale: "en",
  theme: "sepia",
  librarySort: "recent",
  libraryView: "grid",
  nightMode: false,
  localOnly: false,
  relayUrl: "https://relay.example/",
  versionsPerDocument: 2,
  historyLimitMb: 200,
  appLock: false,
  scanAuto: true,
};

beforeAll(async () => {
  await initI18n("en");
});

beforeEach(() => {
  updateSettings.mockReset();
  updateSettings.mockResolvedValue(SAVED);
});

describe("ForeignSettingsSheet", () => {
  it("lists every change and applies nothing when declined", () => {
    const settings: ForeignSettings = { patch: { ...NONE, theme: "sepia", relayUrl: "https://relay.example/" }, prunesVersions: 0 };
    const onDone = vi.fn();
    render(<ForeignSettingsSheet settings={settings} from="pack" onDone={onDone} />);
    const list = screen.getByTestId("foreign-settings-list");
    expect(list.querySelector("[data-setting='theme']")?.textContent).toContain("Sepia");
    expect(list.querySelector("[data-setting='relayUrl']")?.textContent).toContain("https://relay.example/");
    expect(list.querySelectorAll("[data-setting]")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("foreign-settings-decline"));
    expect(onDone).toHaveBeenCalledWith(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("applies the patch as shown once confirmed", async () => {
    const settings: ForeignSettings = { patch: { ...NONE, theme: "sepia" }, prunesVersions: 0 };
    const onDone = vi.fn();
    render(<ForeignSettingsSheet settings={settings} from="device" onDone={onDone} />);
    fireEvent.click(screen.getByTestId("foreign-settings-apply"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(updateSettings).toHaveBeenCalledWith(settings.patch);
  });

  it("asks a second time, with the count, before retention deletes versions", async () => {
    const settings: ForeignSettings = { patch: { ...NONE, versionsPerDocument: 2 }, prunesVersions: 4 };
    const onDone = vi.fn();
    render(<ForeignSettingsSheet settings={settings} from="pack" onDone={onDone} />);
    expect(screen.getByTestId("foreign-settings-prune-warning").textContent).toContain("4 older versions");
    fireEvent.click(screen.getByTestId("foreign-settings-apply"));
    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("foreign-settings-prune-body").textContent).toContain("4 older versions");
    // Back: still nothing applied.
    fireEvent.click(screen.getByTestId("foreign-settings-prune-back"));
    expect(screen.getByTestId("foreign-settings-list")).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("foreign-settings-apply"));
    fireEvent.click(screen.getByTestId("foreign-settings-prune-confirm"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(settings.patch);
  });
});
