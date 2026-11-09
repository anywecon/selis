import { Button, Switch } from "@selis/ui";
import { Check, FileArchive, FolderOpen } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { useNavigation } from "../../state/navigation";
import { ForeignSettingsSheet } from "./ForeignSettingsSheet";
import { Busy, Card } from "./parts";
import { MIN_PASSPHRASE, usePack } from "./packStore";

function PassphraseFields({
  value,
  confirm,
  onChange,
  onConfirm,
}: {
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirm: (v: string) => void;
}) {
  const { t } = useTranslation();
  const first = useId();
  const second = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={first} className="text-[13px] font-medium text-neutral-11">
        {t("transfer.pack.passphrase")}
      </label>
      <input
        id={first}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="selis-focus h-12 w-full rounded-control border border-control-line bg-surface-app px-3 text-md text-neutral-12"
        data-testid="pack-passphrase"
      />
      <label htmlFor={second} className="text-[13px] font-medium text-neutral-11">
        {t("transfer.pack.passphraseAgain")}
      </label>
      <input
        id={second}
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
        className="selis-focus h-12 w-full rounded-control border border-control-line bg-surface-app px-3 text-md text-neutral-12"
        data-testid="pack-passphrase-again"
      />
      <p className="text-[13px] text-warning-11">{t("transfer.pack.noRecovery")}</p>
    </div>
  );
}

/**
 * "Save as file": the chosen documents (or the whole library) as a
 * `.selispack`, optionally protected with a passphrase, then the share sheet.
 */
export function ExportPack({ selected }: { selected: string[] }) {
  const { t } = useTranslation();
  const exportState = usePack((s) => s.exportState);
  const exportPack = usePack((s) => s.exportPack);
  const resetExport = usePack((s) => s.resetExport);
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(selected.length === 0);
  const [history, setHistory] = useState(false);
  const [protect, setProtect] = useState(false);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const tooShort = protect && pass.length < MIN_PASSPHRASE;
  const mismatch = protect && pass !== again;
  const working = exportState.phase === "working";

  const close = () => {
    setOpen(false);
    setPass("");
    setAgain("");
    resetExport();
  };
  const create = async () => {
    await exportPack(whole ? null : selected, whole || history, protect ? pass : null);
    const state = usePack.getState().exportState;
    if (state.phase === "done") {
      useToast.getState().show(t("transfer.pack.created", { count: state.summary.documents }));
      close();
    } else if (state.phase === "failed") {
      useToast.getState().show(t("transfer.pack.exportFailed"), "error");
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        icon={<FileArchive size={20} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => {
          setWhole(selected.length === 0);
          setOpen(true);
        }}
        data-testid="pack-export-open"
      >
        {t("transfer.pack.exportOpen")}
      </Button>
      <Sheet open={open} onClose={close} title={t("transfer.pack.exportTitle")} testId="pack-export-sheet">
        <div className="flex flex-col gap-3 px-5 pb-5">
          <p className="text-[13px] text-neutral-11">{t("transfer.pack.exportHelp")}</p>
          <div role="radiogroup" aria-label={t("transfer.pack.exportTitle")} className="flex flex-col overflow-hidden rounded-[14px] border border-neutral-5">
            {[
              { value: false, label: t("transfer.pack.selected", { count: selected.length }), disabled: selected.length === 0 },
              { value: true, label: t("transfer.pack.whole"), disabled: false },
            ].map((option, i) => (
              <button
                key={String(option.value)}
                type="button"
                role="radio"
                aria-checked={whole === option.value}
                disabled={option.disabled}
                onClick={() => setWhole(option.value)}
                className={`selis-focus flex min-h-12 items-center justify-between px-4 text-left text-md text-neutral-12 disabled:opacity-50 ${i > 0 ? "border-t border-neutral-5" : ""}`}
                data-testid={option.value ? "pack-scope-whole" : "pack-scope-selected"}
              >
                {option.label}
                {whole === option.value ? <Check size={20} strokeWidth={2} aria-hidden="true" className="text-accent-11" /> : null}
              </button>
            ))}
          </div>
          {!whole ? (
            <div className="flex items-center gap-3">
              <span className="flex-1 text-md text-neutral-12">
                {t("transfer.send.includeHistory")}
              </span>
              <Switch checked={history} onChange={setHistory} label={t("transfer.send.includeHistory")} testId="pack-history" />
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <span className="flex-1 text-md text-neutral-12">
              {t("transfer.pack.protect")}
            </span>
            <Switch checked={protect} onChange={setProtect} label={t("transfer.pack.protect")} testId="pack-protect" />
          </div>
          {protect ? <PassphraseFields value={pass} confirm={again} onChange={setPass} onConfirm={setAgain} /> : null}
          {protect && pass.length > 0 && tooShort ? (
            <p role="alert" className="text-[13px] text-danger-11" data-testid="pack-too-short">
              {t("transfer.pack.tooShort", { count: MIN_PASSPHRASE })}
            </p>
          ) : null}
          {protect && !tooShort && again.length > 0 && mismatch ? (
            <p role="alert" className="text-[13px] text-danger-11" data-testid="pack-mismatch">
              {t("transfer.pack.mismatch")}
            </p>
          ) : null}
          {working ? <Busy label={t("transfer.pack.working")} testId="pack-working" /> : null}
          <Button disabled={working || tooShort || mismatch} onClick={() => void create()} data-testid="pack-export-create">
            {t("transfer.pack.create")}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/** "Open a .selispack file" (Receive tab) and the passphrase prompt. */
export function ImportPack() {
  const { t } = useTranslation();
  const importState = usePack((s) => s.importState);
  const pickAndOpen = usePack((s) => s.pickAndOpen);
  const submitPassphrase = usePack((s) => s.submitPassphrase);
  const resetImport = usePack((s) => s.resetImport);
  const [pass, setPass] = useState("");
  const inputId = useId();

  return (
    <>
      <Button
        variant="ghost"
        icon={<FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => void pickAndOpen()}
        disabled={importState.phase === "checking" || importState.phase === "importing"}
        data-testid="pack-import-open"
      >
        {t("transfer.pack.importOpen")}
      </Button>
      <Sheet
        open={importState.phase === "passphrase"}
        onClose={() => {
          setPass("");
          resetImport();
        }}
        title={t("transfer.pack.passphraseTitle")}
        testId="pack-passphrase-sheet"
      >
        <form
          className="flex flex-col gap-3 px-5 pb-5"
          onSubmit={(event) => {
            event.preventDefault();
            const value = pass;
            setPass("");
            void submitPassphrase(value);
          }}
        >
          <label htmlFor={inputId} className="text-[13px] font-medium text-neutral-11">
            {t("transfer.pack.passphrase")}
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            className="selis-focus h-12 w-full rounded-control border border-control-line bg-surface-app px-3 text-md text-neutral-12"
            data-testid="pack-unlock-passphrase"
          />
          {importState.phase === "passphrase" && importState.wrong ? (
            <p role="alert" className="text-[13px] text-danger-11" data-testid="pack-wrong">
              {t("transfer.pack.problem.wrongPassphrase")}
            </p>
          ) : null}
          <Button type="submit" disabled={pass.length === 0} data-testid="pack-unlock">
            {t("transfer.pack.unlock")}
          </Button>
        </form>
      </Sheet>
    </>
  );
}

/** Whether a pack import is running or has a result to show (it then replaces the Receive tab). */
export function usePackResultShown(): boolean {
  return usePack((s) => s.importState.phase !== "idle" && s.importState.phase !== "passphrase");
}

/** The running pack import, or its result, in place of the scanner (always in view). */
export function PackResult() {
  const { t } = useTranslation();
  const importState = usePack((s) => s.importState);
  const resetImport = usePack((s) => s.resetImport);
  const settingsHandled = usePack((s) => s.settingsHandled);
  const selectTab = useNavigation((s) => s.selectTab);
  return (
    <div className="flex flex-col gap-3" data-testid="pack-result">
      {importState.phase === "done" && importState.settings ? (
        <ForeignSettingsSheet settings={importState.settings} from="pack" onDone={settingsHandled} />
      ) : null}
      {importState.phase === "checking" || importState.phase === "importing" ? (
        <Card testId="pack-importing">
          <Busy label={t("transfer.pack.importing")} testId="pack-importing-busy" />
        </Card>
      ) : null}
      {importState.phase === "done" ? (
        <Card testId="pack-import-done">
          <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.pack.importedTitle")}</h2>
          <p className="text-center text-md text-neutral-11" data-testid="pack-import-count">
            {t("transfer.receive.doneBody", { count: importState.documents })}
          </p>
          {importState.duplicates > 0 ? (
            <p className="text-center text-[13px] text-neutral-11">
              {t("transfer.receive.duplicates", { count: importState.duplicates })}
            </p>
          ) : null}
          <div className="flex w-full flex-col gap-2">
            <Button
              onClick={() => {
                resetImport();
                selectTab("library");
              }}
              data-testid="pack-open-library"
            >
              {t("transfer.receive.openLibrary")}
            </Button>
            <Button variant="secondary" onClick={resetImport} data-testid="pack-import-close">
              {t("transfer.pack.close")}
            </Button>
          </div>
        </Card>
      ) : null}
      {importState.phase === "failed" ? (
        <Card testId="pack-import-failed">
          <p role="alert" className="text-center text-md text-danger-11" data-testid="pack-problem" data-problem={importState.problem}>
            {t(`transfer.pack.problem.${importState.problem}`)}
          </p>
          <Button variant="secondary" className="w-full" onClick={resetImport} data-testid="pack-import-close">
            {t("transfer.pack.close")}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
