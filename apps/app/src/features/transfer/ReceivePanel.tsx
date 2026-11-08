import { Button } from "@selis/ui";
import { Camera, Check, ClipboardPaste } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import type { ReceiveView, ResumableView } from "../../lib/api";
import { useNavigation } from "../../state/navigation";
import { formatBytes } from "./format";
import { Busy, Card, CodeBlock, Problem, Progress } from "./parts";
import { type ScanFailure, ScanError, type Scanner, startScanner } from "./qrScanner";
import { RESUME_ATTEMPTS_BEFORE_NEW_CODE, type TransferProblem, useTransfer } from "./transferStore";
import { ForeignSettingsSheet } from "./ForeignSettingsSheet";
import { ImportPack, PackResult, usePackResultShown } from "./PackSheets";
import { SaveDevice } from "./TrustedDevices";

/**
 * Receive tab: scan (or paste) → the same code on both → progress → library.
 * While it is on screen, saved devices may send here without QR code.
 */
export function ReceivePanel() {
  const receive = useTransfer((s) => s.receive);
  const problem = useTransfer((s) => s.receiveProblem);
  const setReceiving = useTransfer((s) => s.setReceiving);
  useEffect(() => {
    void setReceiving(true);
    return () => void setReceiving(false);
  }, [setReceiving]);
  const packShown = usePackResultShown();
  const prompt = useTransfer((s) => s.linkPrompt);
  if (receive) return <ReceiveStatus view={receive} />;
  if (prompt) return <LinkPrompt peer={prompt.sender.peer} trustedName={prompt.sender.trustedName} />;
  if (packShown) return <PackResult />;
  return <ScanOrPaste problem={problem} />;
}

/** Group of 4 hex digits: how a device id is shown (the start is enough to tell devices apart). */
function shortId(peer: string): string {
  return (peer.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * Who a link or code comes from, before anything connects (security audit run-1, lead 5): a
 * `selis://transfer` link can be opened by any app or web page.
 */
function LinkPrompt({ peer, trustedName }: { peer: string; trustedName: string | null }) {
  const { t } = useTranslation();
  const acceptLink = useTransfer((s) => s.acceptLink);
  const declineLink = useTransfer((s) => s.declineLink);
  return (
    <Card testId="transfer-link-prompt">
      <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.prompt.title")}</h2>
      {trustedName ? (
        <p className="text-center text-md text-neutral-11" data-testid="transfer-link-sender">
          {t("transfer.prompt.trusted", { name: trustedName })}
        </p>
      ) : (
        <>
          <p className="text-center text-md text-neutral-11" data-testid="transfer-link-sender">
            {t("transfer.prompt.device", { id: shortId(peer) })}
          </p>
          <p className="text-center text-[13px] text-neutral-11">{t("transfer.prompt.unknownHelp")}</p>
        </>
      )}
      <div className="flex w-full flex-col gap-2">
        <Button onClick={() => void acceptLink()} data-testid="transfer-link-accept">
          {t("transfer.prompt.accept")}
        </Button>
        <Button variant="secondary" onClick={declineLink} data-testid="transfer-link-decline">
          {t("transfer.prompt.decline")}
        </Button>
      </div>
    </Card>
  );
}

function ScanOrPaste({ problem }: { problem: TransferProblem | null }) {
  const { t } = useTranslation();
  const receiveLink = useTransfer((s) => s.receiveLink);
  const [pasting, setPasting] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="transfer-receive">
      <Viewfinder onCode={(text) => void receiveLink(text)} />
      <Button
        variant="secondary"
        className="h-12 bg-transparent"
        icon={<ClipboardPaste size={20} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => setPasting(true)}
        data-testid="transfer-paste"
      >
        {t("transfer.receive.paste")}
      </Button>
      <p className="text-center text-[13px] text-neutral-11">{t("transfer.receive.help")}</p>
      <TrustedHint />
      <ImportPack />
      {problem ? <Problem problem={problem} testId="transfer-receive-problem" /> : null}
      <PausedList />
      <PasteSheet open={pasting} onClose={() => setPasting(false)} />
    </div>
  );
}

type CameraState = "idle" | "starting" | "scanning" | ScanFailure;

/** Dark 320 px viewfinder with four white corner brackets (brief §5). */
function Viewfinder({ onCode }: { onCode: (text: string) => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const [state, setState] = useState<CameraState>("idle");

  useEffect(
    () => () => {
      scanner.current?.stop();
      scanner.current = null;
    },
    [],
  );
  // The camera goes off with the app (and back to "Scan" when it returns).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") return;
      scanner.current?.stop();
      scanner.current = null;
      setState((s) => (s === "scanning" || s === "starting" ? "idle" : s));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const start = async () => {
    if (!video.current || state === "starting" || state === "scanning") return;
    setState("starting");
    try {
      scanner.current = await startScanner(video.current, (text) => {
        scanner.current = null;
        setState("idle");
        onCode(text);
      });
      setState("scanning");
    } catch (err) {
      setState(err instanceof ScanError ? err.failure : "unavailable");
    }
  };
  const stop = () => {
    scanner.current?.stop();
    scanner.current = null;
    setState("idle");
  };

  const live = state === "scanning" || state === "starting";
  return (
    <div
      className="relative flex h-[320px] w-full flex-col items-center justify-center overflow-hidden rounded-[16px] bg-[#0c0c0f]"
      data-testid="transfer-viewfinder"
      data-camera={state}
    >
      <video
        ref={video}
        className={`absolute inset-0 size-full object-cover ${live ? "" : "hidden"}`}
        aria-label={t("transfer.receive.viewfinder")}
        muted
        playsInline
      />
      <Corners />
      <div className="relative z-10 flex max-w-[260px] flex-col items-center gap-3 text-center">
        {state === "scanning" ? (
          <>
            <span className="rounded-full bg-[#000000]/60 px-3 py-1 text-[13px] text-[#ffffff]">{t("transfer.receive.scanning")}</span>
            <Button variant="secondary" onClick={stop} data-testid="transfer-scan-stop">
              {t("transfer.receive.stopScan")}
            </Button>
          </>
        ) : state === "denied" || state === "unavailable" ? (
          <p className="px-2 text-md text-[#e8e8ec]" role="alert" data-testid="transfer-camera-problem">
            {state === "denied" ? t("transfer.receive.cameraDenied") : t("transfer.receive.cameraUnavailable")}
          </p>
        ) : (
          <Button
            icon={<Camera size={20} strokeWidth={1.75} aria-hidden="true" />}
            disabled={state === "starting"}
            onClick={() => void start()}
            data-testid="transfer-scan"
          >
            {t("transfer.receive.scan")}
          </Button>
        )}
      </div>
    </div>
  );
}

function Corners() {
  const corner = "absolute size-9 border-[#ffffff]";
  return (
    <div className="pointer-events-none absolute inset-[44px]" aria-hidden="true">
      <span className={`${corner} top-0 left-0 rounded-tl-[10px] border-t-[3px] border-l-[3px]`} />
      <span className={`${corner} top-0 right-0 rounded-tr-[10px] border-t-[3px] border-r-[3px]`} />
      <span className={`${corner} bottom-0 left-0 rounded-bl-[10px] border-b-[3px] border-l-[3px]`} />
      <span className={`${corner} right-0 bottom-0 rounded-br-[10px] border-r-[3px] border-b-[3px]`} />
    </div>
  );
}

function PasteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const receiveLink = useTransfer((s) => s.receiveLink);
  const [value, setValue] = useState("");
  const inputId = useId();
  const submit = () => {
    const link = value.trim();
    if (!link) return;
    onClose();
    setValue("");
    void receiveLink(link);
  };
  return (
    <Sheet open={open} onClose={onClose} title={t("transfer.receive.pasteTitle")} testId="transfer-paste-sheet">
      <form
        className="flex flex-col gap-3 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId} className="text-[13px] font-medium text-neutral-11">
          {t("transfer.receive.pasteLabel")}
        </label>
        <textarea
          id={inputId}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("transfer.receive.pastePlaceholder")}
          rows={3}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="selis-focus min-h-24 w-full resize-none rounded-control border border-control-line bg-surface-app p-3 font-mono text-[13px] break-all text-neutral-12"
          data-testid="transfer-paste-input"
        />
        <Button type="submit" disabled={value.trim().length === 0} data-testid="transfer-paste-submit">
          {t("transfer.receive.start")}
        </Button>
      </form>
    </Sheet>
  );
}

function TrustedHint() {
  const { t } = useTranslation();
  const count = useTransfer((s) => s.trusted.length);
  if (count === 0) return null;
  return (
    <p className="text-center text-[13px] text-neutral-11" data-testid="transfer-trusted-hint">
      {t("transfer.trust.receiveHint")}
    </p>
  );
}

function PausedList() {
  const { t, i18n } = useTranslation();
  const resumable = useTransfer((s) => s.resumable);
  const resume = useTransfer((s) => s.resume);
  const discard = useTransfer((s) => s.discard);
  if (resumable.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 pt-2" data-testid="transfer-paused-list">
      <h2 className="text-[13px] font-semibold text-neutral-11">{t("transfer.receive.pausedList")}</h2>
      <ul className="flex flex-col overflow-hidden rounded-[14px] border border-neutral-5 bg-surface-raised">
        {resumable.map((r: ResumableView, i) => (
          <li key={r.id} className={`flex items-center gap-2 py-2 pr-2 pl-4 ${i > 0 ? "border-t border-neutral-5" : ""}`}>
            <span className="min-w-0 flex-1 text-md text-neutral-12 tabular-nums">
              {t("transfer.receive.pausedItem", {
                count: r.docCount,
                done: formatBytes(r.doneBytes, i18n.language),
                total: formatBytes(r.totalBytes, i18n.language),
              })}
            </span>
            <Button variant="ghost" className="px-3" onClick={() => void discard(r.id)} data-testid="transfer-discard">
              {t("transfer.receive.discard")}
            </Button>
            <Button className="px-4" onClick={() => void resume(r.id)} data-testid="transfer-resume">
              {t("transfer.receive.resume")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReceiveStatus({ view }: { view: ReceiveView }) {
  const { t } = useTranslation();
  const cancelReceive = useTransfer((s) => s.cancelReceive);
  const resetReceive = useTransfer((s) => s.resetReceive);
  const receiveId = useTransfer((s) => s.receiveId);
  const resume = useTransfer((s) => s.resume);
  const newCode = useTransfer((s) => s.newCode);
  const attempts = useTransfer((s) => s.resumeAttempts);
  const from = useTransfer((s) => s.incomingFrom);
  const settingsAnswered = useTransfer((s) => s.settingsAnswered);
  const answerSettings = useTransfer((s) => s.answerSettings);
  const selectTab = useNavigation((s) => s.selectTab);
  const fromLine = from ? (
    <p className="text-center text-[13px] font-medium text-neutral-11" data-testid="transfer-from">
      {t("transfer.trust.from", { name: from })}
    </p>
  ) : null;
  const cancel = (
    <Button variant="secondary" className="w-full" onClick={() => void cancelReceive()} data-testid="transfer-receive-cancel">
      {t("transfer.cancel")}
    </Button>
  );
  switch (view.kind) {
    case "connecting":
      return (
        <Card testId="transfer-receive-status">
          <Busy label={t("transfer.receive.connecting")} testId="transfer-connecting" />
          {cancel}
        </Card>
      );
    case "confirm":
      return (
        <Card testId="transfer-receive-confirm">
          <CodeBlock code={view.code} testId="transfer-receive-code" />
          <p className="text-center text-md text-neutral-11">{t("transfer.receive.confirmHelp")}</p>
          {cancel}
        </Card>
      );
    case "receiving":
      return (
        <Card testId="transfer-receiving">
          {fromLine}
          <Progress
            label={t("transfer.receive.receiving")}
            bytes={view.bytes}
            total={view.total}
            route={view.route}
            testId="transfer-receive-progress"
          />
          {cancel}
        </Card>
      );
    case "verifying":
    case "saving":
      return (
        <Card testId="transfer-receive-status">
          <Busy
            label={view.kind === "verifying" ? t("transfer.receive.verifying") : t("transfer.receive.saving")}
            testId="transfer-saving"
          />
        </Card>
      );
    case "done":
      return (
        <Card testId="transfer-receive-done">
          <span className="flex size-12 items-center justify-center rounded-full bg-success-3 text-success-11" aria-hidden="true">
            <Check size={26} strokeWidth={2.5} />
          </span>
          <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.receive.doneTitle")}</h2>
          <p className="text-center text-md text-neutral-11" data-testid="transfer-receive-count">
            {t("transfer.receive.doneBody", { count: view.documentIds.length - view.duplicates })}
          </p>
          {view.duplicates > 0 ? (
            <p className="text-center text-[13px] text-neutral-11" data-testid="transfer-receive-duplicates">
              {t("transfer.receive.duplicates", { count: view.duplicates })}
            </p>
          ) : null}
          {view.signatures > 0 ? (
            <p className="text-center text-[13px] text-neutral-11" data-testid="transfer-receive-moved">
              {t("transfer.move.signaturesAdded", { count: view.signatures })}
            </p>
          ) : null}
          {view.signaturesSkipped > 0 ? (
            <p className="text-center text-[13px] text-neutral-11" data-testid="transfer-receive-signatures-skipped">
              {t("transfer.move.signaturesSkipped", { count: view.signaturesSkipped })}
            </p>
          ) : null}
          {view.settings && settingsAnswered !== receiveId ? (
            <ForeignSettingsSheet settings={view.settings} from="device" onDone={answerSettings} />
          ) : null}
          <div className="flex w-full flex-col gap-2">
            {view.peer && !view.trusted ? <SaveDevice peer={view.peer} /> : null}
            <Button
              onClick={() => {
                resetReceive();
                selectTab("library");
              }}
              data-testid="transfer-open-library"
            >
              {t("transfer.receive.openLibrary")}
            </Button>
            <Button variant="secondary" onClick={resetReceive} data-testid="transfer-receive-again">
              {t("transfer.receive.again")}
            </Button>
          </div>
        </Card>
      );
    case "paused": {
      // After a few failed resumes the way forward is a fresh code from the sender.
      const giveUp = attempts >= RESUME_ATTEMPTS_BEFORE_NEW_CODE;
      const resumeButton = (
        <Button
          variant={giveUp ? "secondary" : "primary"}
          onClick={() => receiveId && void resume(receiveId)}
          data-testid="transfer-resume"
        >
          {t("transfer.receive.resume")}
        </Button>
      );
      return (
        <Card testId="transfer-receive-paused">
          <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.receive.pausedTitle")}</h2>
          {view.total > 0 ? (
            <Progress label={t("transfer.receive.pausedBody")} bytes={view.bytes} total={view.total} testId="transfer-paused-progress" />
          ) : null}
          {view.reason ? (
            <p role="alert" className="text-center text-md text-danger-11" data-testid="transfer-paused-reason" data-reason={view.reason}>
              {t(view.reason === "unreachable" ? "transfer.receive.pausedUnreachable" : "transfer.receive.pausedInterrupted")}
            </p>
          ) : null}
          {attempts > 0 ? (
            <p className="text-center text-[13px] text-neutral-11 tabular-nums" data-testid="transfer-resume-attempts">
              {t("transfer.receive.attempts", { count: attempts })}
            </p>
          ) : null}
          <div className="flex w-full flex-col gap-2">
            {giveUp ? (
              <Button onClick={() => void newCode()} data-testid="transfer-new-code">
                {t("transfer.receive.newCode")}
              </Button>
            ) : null}
            {resumeButton}
            {cancel}
          </div>
        </Card>
      );
    }
    case "failed":
      return (
        <Card testId="transfer-receive-failed">
          <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.receive.failedTitle")}</h2>
          <Problem problem={view.error} testId="transfer-receive-problem" />
          <Button className="w-full" onClick={resetReceive} data-testid="transfer-receive-again">
            {t("transfer.retry")}
          </Button>
        </Card>
      );
  }
}
