/**
 * State of the Transfer screen (commands/transfer.rs, ADR 0010).
 *
 * The screen opens the endpoint when it mounts and asks to close it when it
 * unmounts or the app goes to the background; Rust keeps it open while a
 * transfer runs. The store outlives the screen so a transfer started here
 * keeps its progress (and its notification) when the user looks elsewhere.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import {
  ApiError,
  api,
  type LibrarySummary,
  type OfferView,
  type PingView,
  type ReceiveView,
  type ResumableView,
  type SendView,
  type TicketSender,
  type TransferErrorCode,
  type TransferInfo,
  type TrustedDevice,
} from "../../lib/api";
import { i18n } from "../../i18n";
import { cleanLink, percent } from "./format";

export type TransferTab = "send" | "receive";
/** Errors the screen explains: the transfer's own, or that the endpoint did not open. */
export type TransferProblem = TransferErrorCode | "openFailed";

export type TransferApi = Pick<
  typeof api,
  | "transferOpen"
  | "transferClose"
  | "transferOffer"
  | "transferSendStatus"
  | "transferDecide"
  | "transferCancelSend"
  | "transferReceive"
  | "transferTicketSender"
  | "transferReceiveStatus"
  | "transferCancelReceive"
  | "transferResumable"
  | "transferResume"
  | "transferPause"
  | "transferForeground"
  | "transferForegroundStop"
  | "transferNotifications"
  | "transferReceiving"
  | "transferIncoming"
  | "transferTrusted"
  | "transferTrust"
  | "transferUntrust"
  | "transferPing"
  | "transferPush"
  | "transferMoveSummary"
  | "transferMoveOffer"
  | "transferMovePush"
>;

/** A send without QR code: to a trusted device. */
export type Push = { sessionId: string; deviceName: string; docCount: number; move: boolean };

export type TransferDeps = {
  api: TransferApi;
  translate: (key: string, vars?: Record<string, unknown>) => string;
  setTimer: (fn: () => void, ms: number) => number;
  now: () => number;
  /** Something arrived in the library (refresh listings). */
  onReceived: (documentIds: string[]) => void;
};

export type TransferState = {
  info: TransferInfo | null;
  opening: boolean;
  openFailed: boolean;
  tab: TransferTab;
  preparing: boolean;
  offer: OfferView | null;
  send: SendView | null;
  sendProblem: TransferProblem | null;
  receiveId: string | null;
  receive: ReceiveView | null;
  receiveProblem: TransferProblem | null;
  resumable: ResumableView[];
  /** A deep link waiting for the endpoint to open. */
  incomingLink: string | null;
  /**
   * A link or code waiting for the user to say yes, with who sends it: nothing connects
   * before (security audit run-1, lead 5; a link can come from any app or web page).
   */
  linkPrompt: { link: string; sender: TicketSender } | null;
  /** The receive whose sender settings were applied or declined (asked once). */
  settingsAnswered: string | null;
  /** The offer on screen is a library move. */
  moving: boolean;
  push: Push | null;
  trusted: TrustedDevice[];
  /** Reachability per trusted device; `null` while checking. */
  pings: Record<string, PingView | null>;
  moveSummary: LibrarySummary | null;
  /** The Receive tab is visible: trusted devices may push. */
  receivingOn: boolean;
  /** Name of the trusted device the current receive comes from. */
  incomingFrom: string | null;
  /** Resumes tried for the current receive (a paused card after one means it failed). */
  resumeAttempts: number;

  open: () => Promise<void>;
  setIncomingLink: (link: string) => void;
  close: () => Promise<void>;
  setTab: (tab: TransferTab) => void;
  offerDocuments: (ids: string[], includeHistory: boolean) => Promise<void>;
  decide: (confirm: boolean) => Promise<void>;
  cancelSend: () => Promise<void>;
  resetSend: () => void;
  /** The code ran out: a fresh one for the same documents (or the same move). */
  renewOffer: () => Promise<void>;
  /** Reads who sends `input` and asks the user (`linkPrompt`); nothing connects yet. */
  receiveLink: (input: string) => Promise<void>;
  /** The user said yes to `linkPrompt`: the receive starts. */
  acceptLink: () => Promise<void>;
  declineLink: () => void;
  /** The sender's settings (a library move) were applied or declined. */
  answerSettings: () => void;
  resume: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  cancelReceive: () => Promise<void>;
  resetReceive: () => void;
  /** Gives up on the current receive and goes back to scanning a new code. */
  newCode: () => Promise<void>;
  /** Android stopped the background transfer job: stop receives, keep them resumable. */
  pauseAll: () => Promise<void>;
  loadTrusted: () => Promise<void>;
  pingTrusted: () => Promise<void>;
  pushTo: (device: TrustedDevice, ids: string[], includeHistory: boolean) => Promise<void>;
  saveDevice: (endpointId: string, name: string) => Promise<boolean>;
  removeDevice: (endpointId: string) => Promise<void>;
  loadMoveSummary: () => Promise<void>;
  moveOffer: () => Promise<void>;
  movePush: (device: TrustedDevice) => Promise<void>;
  setReceiving: (on: boolean) => Promise<void>;
};

/** Failed resumes after which the paused card leads with "Get a new code". */
export const RESUME_ATTEMPTS_BEFORE_NEW_CODE = 3;

/** How often a running transfer is looked at. */
export const POLL_MS = 400;
/** How often the Receive tab asks whether a trusted device started a send. */
const INCOMING_EVERY = 3;
/** The notification is updated at most this often. */
const NOTIFY_MS = 1_000;
/** Largest KiB count Android takes (a Java int). */
const KIB_MAX = 2 ** 31 - 1;

export function sendRunning(view: SendView | null): boolean {
  return view !== null && (view.kind === "confirm" || view.kind === "sending" || view.kind === "interrupted");
}

export function receiveRunning(view: ReceiveView | null): boolean {
  return (
    view !== null &&
    (view.kind === "connecting" ||
      view.kind === "confirm" ||
      view.kind === "receiving" ||
      view.kind === "verifying" ||
      view.kind === "saving")
  );
}

function sendFinished(view: SendView | null): boolean {
  return view?.kind === "done" || view?.kind === "failed";
}

function receiveFinished(view: ReceiveView | null): boolean {
  return view?.kind === "done" || view?.kind === "failed" || view?.kind === "paused";
}

/** What a failed `transfer_receive` call means for the user. */
function receiveCallProblem(err: unknown): TransferProblem {
  if (err instanceof ApiError && err.code === "invalidArgument") {
    if (err.message === "expired") return "expired";
    if (err.message === "invalidLink") return "invalidLink";
    // "the transfer screen is not open"
    return "openFailed";
  }
  return "unreachable";
}

export function createTransferStore(deps: TransferDeps): StoreApi<TransferState> {
  let timer: number | null = null;
  let lastNotify = 0;
  let notifying = false;
  let askedNotifications = false;
  let ticks = 0;
  /** What the current QR code offers, so an expired one can be renewed. */
  let lastOffer: { ids: string[]; includeHistory: boolean } | null = null;

  const store = createStore<TransferState>()((set, get) => {
    const schedule = () => {
      if (timer !== null) return;
      const { offer, push, send, receiveId, receive, receivingOn } = get();
      const sending = (offer !== null || push !== null) && !sendFinished(send);
      const listening = receivingOn && !receiveRunning(receive);
      const active = sending || (receiveId !== null && !receiveFinished(receive)) || listening;
      if (!active) return;
      timer = deps.setTimer(() => {
        timer = null;
        void tick();
      }, POLL_MS);
    };

    const notify = async () => {
      const { send, receive } = get();
      const sending = send?.kind === "sending" ? send : null;
      const receiving = receive?.kind === "receiving" ? receive : null;
      const running = sending ?? receiving;
      if (!running) {
        if (notifying && !sendRunning(send) && !receiveRunning(receive)) {
          notifying = false;
          await deps.api.transferForegroundStop().catch(() => undefined);
        }
        return;
      }
      if (deps.now() - lastNotify < NOTIFY_MS) return;
      lastNotify = deps.now();
      notifying = true;
      if (!askedNotifications) {
        askedNotifications = true;
        // Not awaited: the system dialog waits for the user, progress must not.
        void deps.api.transferNotifications().catch(() => false);
      }
      const pct = percent(running.bytes, running.total);
      // KiB: the notification's bar and the bytes Android's transfer job reports (ADR 0027).
      const kib = (bytes: number) => Math.min(KIB_MAX, Math.max(0, Math.floor(bytes / 1024)));
      await deps.api
        .transferForeground(
          deps.translate("transfer.notify.channel"),
          deps.translate(sending ? "transfer.notify.sending" : "transfer.notify.receiving"),
          deps.translate("transfer.notify.progress", { percent: pct }),
          kib(running.bytes),
          kib(running.total),
          sending !== null,
        )
        .catch(() => undefined);
    };

    const sessionOf = () => get().offer?.sessionId ?? get().push?.sessionId ?? null;

    const tick = async () => {
      ticks += 1;
      const { send, receiveId, receive, receivingOn } = get();
      const session = sessionOf();
      if (session && !sendFinished(send)) {
        try {
          const view = await deps.api.transferSendStatus(session);
          if (sessionOf() === session) {
            set({ send: view });
            if (view.kind === "done") void get().loadTrusted();
          }
        } catch {
          // The endpoint went away (screen closed for good): the offer is over.
          if (sessionOf() === session) set({ send: { kind: "failed", error: "cancelled" } });
        }
      }
      if (receivingOn && !receiveRunning(receive) && ticks % INCOMING_EVERY === 0) {
        try {
          const [first] = await deps.api.transferIncoming();
          if (first && !receiveRunning(get().receive)) {
            set({
              tab: "receive",
              receiveId: first.id,
              receive: { kind: "connecting" },
              receiveProblem: null,
              incomingFrom: first.deviceName,
            });
          }
        } catch {
          // Asked again on the next round.
        }
      }
      if (receiveId && !receiveFinished(receive)) {
        try {
          const view = await deps.api.transferReceiveStatus(receiveId);
          if (get().receiveId === receiveId) {
            set({ receive: view });
            if (view.kind === "done") deps.onReceived(view.documentIds);
            if (receiveFinished(view)) void loadResumable();
          }
        } catch {
          // Keep the last view; the next tick asks again.
        }
      }
      await notify();
      schedule();
    };

    const loadResumable = async () => {
      try {
        set({ resumable: await deps.api.transferResumable() });
      } catch {
        // Not essential: the list stays as it was.
      }
    };

    return {
      info: null,
      opening: false,
      openFailed: false,
      tab: "send",
      preparing: false,
      offer: null,
      send: null,
      sendProblem: null,
      receiveId: null,
      receive: null,
      receiveProblem: null,
      resumable: [],
      incomingLink: null,
      linkPrompt: null,
      settingsAnswered: null,
      moving: false,
      push: null,
      trusted: [],
      pings: {},
      moveSummary: null,
      receivingOn: false,
      incomingFrom: null,
      resumeAttempts: 0,

      open: async () => {
        if (get().opening) return;
        set({ opening: true, openFailed: false });
        try {
          const info = await deps.api.transferOpen();
          set({ info, opening: false });
          await loadResumable();
          await get().loadTrusted();
          if (get().receivingOn) await deps.api.transferReceiving(true).catch(() => undefined);
        } catch {
          set({ opening: false, openFailed: true });
          return;
        }
        const link = get().incomingLink;
        if (link) {
          set({ incomingLink: null });
          await get().receiveLink(link);
        }
      },

      setIncomingLink: (link) => {
        set({ tab: "receive" });
        if (get().info && !get().opening) {
          void get().receiveLink(link);
        } else {
          set({ incomingLink: link });
        }
      },

      close: async () => {
        try {
          const closed = await deps.api.transferClose(false);
          if (closed) {
            const { send } = get();
            // An offer dies with the endpoint.
            set({ info: null, ...(sendFinished(send) || sendRunning(send) ? {} : { offer: null, send: null }) });
          }
        } catch {
          // Closing again later is harmless.
        }
      },

      setTab: (tab) => set({ tab }),

      offerDocuments: async (ids, includeHistory) => {
        if (get().preparing || ids.length === 0) return;
        set({ preparing: true, sendProblem: null });
        try {
          const offer = await deps.api.transferOffer(ids, includeHistory);
          lastOffer = { ids, includeHistory };
          set({ offer, push: null, moving: false, send: { kind: "waitingForReceiver" }, preparing: false });
          schedule();
        } catch (err) {
          set({
            preparing: false,
            sendProblem: err instanceof ApiError && err.code === "invalidArgument" ? "openFailed" : "storage",
          });
        }
      },

      decide: async (confirm) => {
        const offer = get().offer;
        if (!offer) return;
        try {
          await deps.api.transferDecide(offer.sessionId, confirm);
        } catch {
          // Already decided (a repeated tap): the status shows what happened.
        }
        schedule();
      },

      cancelSend: async () => {
        const session = sessionOf();
        set({ offer: null, push: null, moving: false, send: null, sendProblem: null });
        if (session) await deps.api.transferCancelSend(session).catch(() => undefined);
        await notify();
      },

      resetSend: () => set({ offer: null, push: null, moving: false, send: null, sendProblem: null }),

      renewOffer: async () => {
        const { offer, moving } = get();
        const again = lastOffer;
        if (offer) await deps.api.transferCancelSend(offer.sessionId).catch(() => undefined);
        set({ offer: null, send: null, sendProblem: null });
        if (moving) {
          await get().moveOffer();
        } else if (again) {
          await get().offerDocuments(again.ids, again.includeHistory);
        }
      },

      receiveLink: async (input) => {
        set({ tab: "receive", receiveProblem: null });
        const link = cleanLink(input);
        if (!link) {
          set({ receiveProblem: "invalidLink" });
          return;
        }
        if (receiveRunning(get().receive)) return;
        try {
          const sender = await deps.api.transferTicketSender(link);
          set({ linkPrompt: { link, sender } });
        } catch (err) {
          set({ linkPrompt: null, receiveProblem: receiveCallProblem(err) });
        }
      },

      declineLink: () => set({ linkPrompt: null }),

      answerSettings: () => set({ settingsAnswered: get().receiveId }),

      acceptLink: async () => {
        const prompt = get().linkPrompt;
        set({ linkPrompt: null });
        if (!prompt || receiveRunning(get().receive)) return;
        const { link } = prompt;
        set({ receive: { kind: "connecting" }, receiveId: null, resumeAttempts: 0 });
        try {
          const id = await deps.api.transferReceive(link);
          set({ receiveId: id });
          schedule();
        } catch (err) {
          set({ receive: null, receiveProblem: receiveCallProblem(err) });
        }
      },

      resume: async (id) => {
        const attempts = get().receiveId === id ? get().resumeAttempts + 1 : 1;
        set({ tab: "receive", receiveProblem: null, receiveId: id, receive: { kind: "connecting" }, resumeAttempts: attempts });
        try {
          await deps.api.transferResume(id);
          schedule();
        } catch {
          set({ receive: null, receiveId: null, receiveProblem: "unknown" });
          await loadResumable();
        }
      },

      discard: async (id) => {
        await deps.api.transferCancelReceive(id).catch(() => undefined);
        if (get().receiveId === id) set({ receiveId: null, receive: null, resumeAttempts: 0 });
        await loadResumable();
      },

      cancelReceive: async () => {
        const id = get().receiveId;
        set({ receiveId: null, receive: null, receiveProblem: null, resumeAttempts: 0 });
        if (id) await deps.api.transferCancelReceive(id).catch(() => undefined);
        await notify();
        await loadResumable();
      },

      newCode: async () => {
        await get().cancelReceive();
        set({ tab: "receive", incomingFrom: null });
      },

      resetReceive: () => {
        set({ receiveId: null, receive: null, receiveProblem: null, incomingFrom: null, resumeAttempts: 0, settingsAnswered: null });
        schedule();
      },

      pauseAll: async () => {
        await deps.api.transferPause().catch(() => undefined);
        schedule();
      },

      loadTrusted: async () => {
        try {
          set({ trusted: await deps.api.transferTrusted() });
        } catch {
          // The list stays as it was.
        }
      },

      pingTrusted: async () => {
        const devices = get().trusted;
        set({ pings: Object.fromEntries(devices.map((d) => [d.endpointId, null])) });
        await Promise.all(
          devices.map(async (d) => {
            const ping = await deps.api.transferPing(d.endpointId).catch(() => ({ online: false, ready: false }));
            set({ pings: { ...get().pings, [d.endpointId]: ping } });
          }),
        );
      },

      pushTo: async (device, ids, includeHistory) => {
        if (get().preparing || ids.length === 0) return;
        set({ preparing: true, sendProblem: null });
        try {
          const sessionId = await deps.api.transferPush(device.endpointId, ids, includeHistory);
          set({
            push: { sessionId, deviceName: device.name, docCount: ids.length, move: false },
            offer: null,
            moving: false,
            send: { kind: "waitingForReceiver" },
            preparing: false,
          });
          schedule();
        } catch {
          set({ preparing: false, sendProblem: "notReady" });
        }
      },

      saveDevice: async (endpointId, name) => {
        try {
          await deps.api.transferTrust(endpointId, name);
          await get().loadTrusted();
          const { send, receive } = get();
          // The done cards stop offering to save it.
          if (send?.kind === "done") set({ send: { ...send, trusted: true } });
          if (receive?.kind === "done") set({ receive: { ...receive, trusted: true } });
          return true;
        } catch {
          return false;
        }
      },

      removeDevice: async (endpointId) => {
        await deps.api.transferUntrust(endpointId).catch(() => undefined);
        set({ pings: Object.fromEntries(Object.entries(get().pings).filter(([id]) => id !== endpointId)) });
        await get().loadTrusted();
      },

      loadMoveSummary: async () => {
        try {
          set({ moveSummary: await deps.api.transferMoveSummary() });
        } catch {
          set({ moveSummary: null });
        }
      },

      moveOffer: async () => {
        if (get().preparing) return;
        set({ preparing: true, sendProblem: null });
        try {
          const offer = await deps.api.transferMoveOffer();
          set({ offer, push: null, moving: true, send: { kind: "waitingForReceiver" }, preparing: false });
          schedule();
        } catch {
          set({ preparing: false, sendProblem: "storage" });
        }
      },

      movePush: async (device) => {
        if (get().preparing) return;
        set({ preparing: true, sendProblem: null });
        try {
          const sessionId = await deps.api.transferMovePush(device.endpointId);
          set({
            push: { sessionId, deviceName: device.name, docCount: get().moveSummary?.documents ?? 0, move: true },
            offer: null,
            moving: true,
            send: { kind: "waitingForReceiver" },
            preparing: false,
          });
          schedule();
        } catch {
          set({ preparing: false, sendProblem: "notReady" });
        }
      },

      setReceiving: async (on) => {
        if (get().receivingOn === on) return;
        set({ receivingOn: on });
        if (get().info) await deps.api.transferReceiving(on).catch(() => undefined);
        schedule();
      },
    };
  });
  return store;
}

let instance: StoreApi<TransferState> | null = null;
const receivedListeners = new Set<(ids: string[]) => void>();

/** Library listings refresh when documents arrive (TransferScreen subscribes). */
export function onDocumentsReceived(listener: (ids: string[]) => void): () => void {
  receivedListeners.add(listener);
  return () => receivedListeners.delete(listener);
}

export function transferStore(): StoreApi<TransferState> {
  instance ??= createTransferStore({
    api,
    translate: (key, vars) => (vars ? i18n.t(key, vars) : i18n.t(key)),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    now: () => Date.now(),
    onReceived: (ids) => {
      for (const listener of receivedListeners) listener(ids);
    },
  });
  return instance;
}

export function useTransfer<T>(selector: (state: TransferState) => T): T {
  return useStore(transferStore(), selector);
}
