/**
 * Settings that came from a `.selispack` or another device's library move
 * (security audit run-1, leads 4 and 5). Nothing is applied until the user
 * confirms the list of changes; settings that delete version history now
 * need a second, explicit confirmation that says how many versions go.
 */
import { Button } from "@selis/ui";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import type { ForeignSettings, SettingsPatch } from "../../lib/api";
import { useSettings } from "../../state/settings";

export type SettingRow = { readonly key: string; readonly label: string; readonly value: string };

const SORT_KEYS = { recent: "library.sortRecent", name: "library.sortName", size: "library.sortSize", lastOpened: "transfer.foreign.sortLastOpened" } as const;
const LOCALE_KEYS = { system: "settings.languageSystem", el: "settings.languageEl", en: "settings.languageEn" } as const;
const THEME_KEYS = { system: "settings.themeSystem", light: "settings.themeLight", dark: "settings.themeDark", sepia: "settings.themeSepia" } as const;

/** Every setting the patch changes, as label and new value. */
export function settingRows(patch: SettingsPatch, t: TFunction): SettingRow[] {
  const onOff = (v: boolean) => t(v ? "transfer.foreign.on" : "transfer.foreign.off");
  const rows: SettingRow[] = [];
  const add = (key: string, label: string, value: string) => rows.push({ key, label: t(label), value });
  if (patch.locale !== null) add("locale", "settings.language", t(LOCALE_KEYS[patch.locale]));
  if (patch.theme !== null) add("theme", "settings.theme", t(THEME_KEYS[patch.theme]));
  if (patch.librarySort !== null) add("librarySort", "library.sortTitle", t(SORT_KEYS[patch.librarySort]));
  if (patch.libraryView !== null) add("libraryView", "library.view", t(patch.libraryView === "grid" ? "library.viewGrid" : "library.viewList"));
  if (patch.nightMode !== null) add("nightMode", "transfer.foreign.nightMode", onOff(patch.nightMode));
  if (patch.localOnly !== null) add("localOnly", "settings.localOnly", onOff(patch.localOnly));
  if (patch.relayUrl !== null) add("relayUrl", "settings.relay", patch.relayUrl === "" ? t("settings.relayPublic") : patch.relayUrl);
  if (patch.versionsPerDocument !== null) add("versionsPerDocument", "settings.versionsPerDocument", String(patch.versionsPerDocument));
  if (patch.historyLimitMb !== null) add("historyLimitMb", "settings.historyLimit", t("settings.megabytes", { mb: patch.historyLimitMb }));
  if (patch.appLock !== null) add("appLock", "settings.appLock", onOff(patch.appLock));
  if (patch.scanAuto !== null) add("scanAuto", "transfer.foreign.scanAuto", onOff(patch.scanAuto));
  return rows;
}

export function ForeignSettingsSheet({
  settings,
  from,
  onDone,
}: {
  settings: ForeignSettings;
  /** Where they came from: the intro says so. */
  from: "pack" | "device";
  /** After applying or declining (the sheet closes). */
  onDone: (applied: boolean) => void;
}) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const applyPatch = useSettings((s) => s.applyPatch);
  const [step, setStep] = useState<"review" | "destructive">("review");
  const [busy, setBusy] = useState(false);
  const rows = settingRows(settings.patch, t);

  const apply = async () => {
    setBusy(true);
    try {
      await applyPatch(settings.patch);
      showToast(t("transfer.foreign.applied"));
      onDone(true);
    } catch {
      showToast(t("transfer.foreign.failed"), "error");
      onDone(false);
    } finally {
      setBusy(false);
    }
  };
  const decline = () => onDone(false);

  if (step === "destructive") {
    return (
      <Sheet open onClose={() => setStep("review")} title={t("transfer.foreign.pruneTitle")} testId="foreign-settings-prune">
        <div className="flex flex-col gap-3 px-5 pb-5">
          <p className="text-md text-neutral-11" data-testid="foreign-settings-prune-body">
            {t("transfer.foreign.pruneBody", { count: settings.prunesVersions })}
          </p>
          <Button variant="danger" disabled={busy} onClick={() => void apply()} data-testid="foreign-settings-prune-confirm">
            {t("transfer.foreign.pruneConfirm", { count: settings.prunesVersions })}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setStep("review")} data-testid="foreign-settings-prune-back">
            {t("transfer.foreign.back")}
          </Button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet open onClose={decline} title={t("transfer.foreign.title")} testId="foreign-settings">
      <div className="flex flex-col gap-3 px-5 pb-5">
        <p className="text-[13px] text-neutral-11">{t(from === "pack" ? "transfer.foreign.fromPack" : "transfer.foreign.fromDevice")}</p>
        <dl className="flex flex-col overflow-hidden rounded-[14px] border border-neutral-5" data-testid="foreign-settings-list">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-3 border-b border-neutral-5 px-4 py-3 last:border-b-0" data-setting={row.key}>
              <dt className="text-md text-neutral-12">{row.label}</dt>
              <dd className="min-w-0 truncate text-md text-neutral-11">{row.value}</dd>
            </div>
          ))}
        </dl>
        {settings.prunesVersions > 0 ? (
          <p className="text-[13px] text-danger-11" data-testid="foreign-settings-prune-warning">
            {t("transfer.foreign.pruneWarning", { count: settings.prunesVersions })}
          </p>
        ) : null}
        <Button disabled={busy} onClick={() => (settings.prunesVersions > 0 ? setStep("destructive") : void apply())} data-testid="foreign-settings-apply">
          {t("transfer.foreign.apply")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={decline} data-testid="foreign-settings-decline">
          {t("transfer.foreign.decline")}
        </Button>
      </div>
    </Sheet>
  );
}
