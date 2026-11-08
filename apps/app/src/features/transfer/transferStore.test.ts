import { describe, expect, it, vi } from "vitest";
import { ApiError, type ReceiveView, type SendView } from "../../lib/api";
import { cleanLink, formatCode, formatCountdown, percent } from "./format";
import { RESUME_ATTEMPTS_BEFORE_NEW_CODE, createTransferStore, type TransferApi, type TransferDeps } from "./transferStore";

const LINK = "selis://transfer/selisabc";
const PEER = "a".repeat(64);

function fakeApi(overrides: Partial<TransferApi> = {}): TransferApi {
  return {
    transferOpen: vi.fn(() => Promise.resolve({ deviceId: "d", network: "default" as const, debug: false })),
    transferClose: vi.fn(() => Promise.resolve(true)),
    transferOffer: vi.fn(() =>
      Promise.resolve({ sessionId: "s1", link: LINK, qrSvg: "<svg/>", docCount: 2, totalBytes: 10, expiresAt: 1e10 }),
    ),
    transferSendStatus: vi.fn((): Promise<SendView> => Promise.resolve({ kind: "waitingForReceiver" })),
    transferDecide: vi.fn(() => Promise.resolve(null)),
    transferCancelSend: vi.fn(() => Promise.resolve(null)),
    transferReceive: vi.fn(() => Promise.resolve("r1")),
    transferTicketSender: vi.fn(() => Promise.resolve({ peer: PEER, trustedName: null })),
    transferReceiveStatus: vi.fn((): Promise<ReceiveView> => Promise.resolve({ kind: "connecting" })),
    transferCancelReceive: vi.fn(() => Promise.resolve(null)),
    transferResumable: vi.fn(() => Promise.resolve([])),
    transferResume: vi.fn(() => Promise.resolve(null)),
    transferPause: vi.fn(() => Promise.resolve(null)),
    transferForeground: vi.fn(() => Promise.resolve(null)),
    transferForegroundStop: vi.fn(() => Promise.resolve(null)),
    transferNotifications: vi.fn(() => Promise.resolve(true)),
    transferReceiving: vi.fn(() => Promise.resolve(null)),
    transferIncoming: vi.fn(() => Promise.resolve([])),
    transferTrusted: vi.fn(() => Promise.resolve([])),
    transferTrust: vi.fn((endpointId: string, name: string) => Promise.resolve({ endpointId, name, addedAt: 1, lastSeenAt: null })),
    transferUntrust: vi.fn(() => Promise.resolve(null)),
    transferPing: vi.fn(() => Promise.resolve({ online: true, ready: true })),
    transferPush: vi.fn(() => Promise.resolve("p1")),
    transferMoveSummary: vi.fn(() => Promise.resolve({ documents: 2, versions: 1, tags: 1, signatures: 0, bytes: 10 })),
    transferMoveOffer: vi.fn(() =>
      Promise.resolve({ sessionId: "m1", link: LINK, qrSvg: "<svg/>", docCount: 2, totalBytes: 10, expiresAt: 1e10 }),
    ),
    transferMovePush: vi.fn(() => Promise.resolve("mp1")),
    ...overrides,
  };
}

/** Timers run when `flush` is called (one poll step each). */
function harness(api: TransferApi) {
  const timers: Array<() => void> = [];
  let now = 0;
  const received: string[][] = [];
  const deps: TransferDeps = {
    api,
    translate: (key) => key,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    now: () => now,
    onReceived: (ids) => received.push(ids),
  };
  const store = createTransferStore(deps);
  const flush = async () => {
    now += 1_000;
    const pending = timers.splice(0);
    for (const fn of pending) fn();
    // Let the polled promises settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return { store, flush, received, timers };
}

describe("transfer store", () => {
  it("opens, then starts a pending deep link once the endpoint is there", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    store.getState().setIncomingLink(LINK);
    expect(api.transferReceive).not.toHaveBeenCalled();
    await store.getState().open();
    // Security audit run-1, lead 5: a link (from any app or web page) only asks first.
    expect(api.transferReceive).not.toHaveBeenCalled();
    expect(store.getState().linkPrompt).toEqual({ link: LINK, sender: { peer: PEER, trustedName: null } });
    expect(store.getState().tab).toBe("receive");
    await store.getState().acceptLink();
    expect(api.transferReceive).toHaveBeenCalledWith(LINK);
    expect(store.getState().receiveId).toBe("r1");
  });

  it("declining a link connects to nothing", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    store.getState().setIncomingLink(LINK);
    await vi.waitFor(() => expect(store.getState().linkPrompt).not.toBeNull());
    store.getState().declineLink();
    expect(store.getState().linkPrompt).toBeNull();
    await store.getState().acceptLink();
    expect(api.transferReceive).not.toHaveBeenCalled();
    expect(store.getState().receive).toBeNull();
  });

  it("counts failed resumes, then a new code drops the paused receive", async () => {
    const paused: ReceiveView = { kind: "paused", bytes: 0, total: 0, reason: "unreachable" };
    const api = fakeApi({ transferReceiveStatus: vi.fn((): Promise<ReceiveView> => Promise.resolve(paused)) });
    const { store, flush } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink(LINK);
    await store.getState().acceptLink();
    await flush();
    expect(store.getState().receive).toEqual(paused);
    expect(store.getState().resumeAttempts).toBe(0);
    for (let i = 1; i <= RESUME_ATTEMPTS_BEFORE_NEW_CODE; i += 1) {
      await store.getState().resume("r1");
      // Feedback at once: connecting, then the reason again.
      expect(store.getState().receive?.kind).toBe("connecting");
      await flush();
      expect(store.getState().receive).toEqual(paused);
      expect(store.getState().resumeAttempts).toBe(i);
    }
    await store.getState().newCode();
    expect(api.transferCancelReceive).toHaveBeenCalledWith("r1");
    expect(store.getState()).toMatchObject({ receiveId: null, receive: null, resumeAttempts: 0, tab: "receive" });
  });

  it("a resume of another paused transfer starts its own count", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().resume("a");
    await store.getState().resume("a");
    expect(store.getState().resumeAttempts).toBe(2);
    await store.getState().resume("b");
    expect(store.getState().resumeAttempts).toBe(1);
  });

  it("renews an expired offer for the same documents and drops the old ticket", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().offerDocuments(["d1", "d2"], true);
    await store.getState().renewOffer();
    expect(api.transferCancelSend).toHaveBeenCalledWith("s1");
    expect(api.transferOffer).toHaveBeenCalledTimes(2);
    expect(api.transferOffer).toHaveBeenLastCalledWith(["d1", "d2"], true);
    expect(store.getState().send).toEqual({ kind: "waitingForReceiver" });
  });

  it("renews an expired library move as a move", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().moveOffer();
    await store.getState().renewOffer();
    expect(api.transferMoveOffer).toHaveBeenCalledTimes(2);
    expect(api.transferOffer).not.toHaveBeenCalled();
    expect(store.getState().moving).toBe(true);
  });

  it("refuses a link that is not one without calling Rust", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink("https://example.com");
    expect(api.transferReceive).not.toHaveBeenCalled();
    expect(store.getState().receiveProblem).toBe("invalidLink");
  });

  it("an expired link is refused before the user is asked", async () => {
    const api = fakeApi({
      transferTicketSender: vi.fn(() => Promise.reject(new ApiError({ code: "invalidArgument", message: "expired" }))),
    });
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink(LINK);
    expect(store.getState().receiveProblem).toBe("expired");
    expect(store.getState().linkPrompt).toBeNull();
    expect(api.transferReceive).not.toHaveBeenCalled();
  });

  it("maps an expired ticket from Rust to the expired message", async () => {
    const api = fakeApi({
      transferReceive: vi.fn(() => Promise.reject(new ApiError({ code: "invalidArgument", message: "expired" }))),
    });
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink(LINK);
    await store.getState().acceptLink();
    expect(store.getState().receiveProblem).toBe("expired");
    expect(store.getState().receive).toBeNull();
  });

  it("polls a send through the code to done and stops the notification", async () => {
    const views: SendView[] = [
      { kind: "confirm", code: "482913" },
      { kind: "sending", bytes: 5 * 1024 * 1024, total: 10 * 1024 * 1024, route: "lan" },
      { kind: "done", peer: PEER, trusted: false },
    ];
    const api = fakeApi({
      transferSendStatus: vi.fn((): Promise<SendView> => Promise.resolve(views.shift() ?? { kind: "done", peer: PEER, trusted: false })),
    });
    const { store, flush, timers } = harness(api);
    await store.getState().open();
    await store.getState().offerDocuments(["a", "b"], true);
    expect(api.transferOffer).toHaveBeenCalledWith(["a", "b"], true);
    await flush();
    expect(store.getState().send).toEqual({ kind: "confirm", code: "482913" });
    await store.getState().decide(true);
    expect(api.transferDecide).toHaveBeenCalledWith("s1", true);
    await flush();
    await flush();
    expect(store.getState().send).toEqual({ kind: "done", peer: PEER, trusted: false });
    // "Save this device" marks it trusted on the done card.
    expect(await store.getState().saveDevice(PEER, "Laptop")).toBe(true);
    expect(api.transferTrust).toHaveBeenCalledWith(PEER, "Laptop");
    expect(store.getState().send).toEqual({ kind: "done", peer: PEER, trusted: true });
    // Progress in KiB, marked as an upload (Android's transfer job reports the bytes, ADR 0027).
    expect(api.transferForeground).toHaveBeenCalledWith(
      "transfer.notify.channel",
      "transfer.notify.sending",
      "transfer.notify.progress",
      5 * 1024,
      10 * 1024,
      true,
    );
    expect(api.transferForegroundStop).toHaveBeenCalled();
    // Finished: no more polling.
    expect(timers).toHaveLength(0);
  });

  it("reports received documents once and refreshes the paused list", async () => {
    const views: ReceiveView[] = [
      { kind: "confirm", code: "111222" },
      { kind: "receiving", bytes: 1, total: 2, route: "relay" },
      {
        kind: "done",
        documentIds: ["x"],
        duplicates: 0,
        signatures: 0,
        signaturesSkipped: 0,
        moved: false,
        settings: null,
        peer: PEER,
        trusted: true,
      },
    ];
    const api = fakeApi({ transferReceiveStatus: vi.fn((): Promise<ReceiveView> => Promise.resolve(views.shift() ?? { kind: "connecting" })) });
    const { store, flush, received } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink(LINK);
    await store.getState().acceptLink();
    await flush();
    await flush();
    await flush();
    await flush();
    expect(store.getState().receive).toEqual({
      kind: "done",
      documentIds: ["x"],
      duplicates: 0,
      signatures: 0,
      signaturesSkipped: 0,
      moved: false,
      settings: null,
      peer: PEER,
      trusted: true,
    });
    expect(received).toEqual([["x"]]);
    expect(api.transferResumable).toHaveBeenCalledTimes(2);
  });

  it("pushes to a trusted device and picks up a push while the Receive tab is open", async () => {
    let incoming = [{ id: "r9", deviceName: "Laptop" }];
    const api = fakeApi({
      transferTrusted: vi.fn(() => Promise.resolve([{ endpointId: PEER, name: "Laptop", addedAt: 1, lastSeenAt: null }])),
      transferIncoming: vi.fn(() => {
        const out = incoming;
        incoming = [];
        return Promise.resolve(out);
      }),
    });
    const { store, flush } = harness(api);
    await store.getState().open();
    expect(store.getState().trusted).toHaveLength(1);
    await store.getState().pingTrusted();
    expect(store.getState().pings[PEER]).toEqual({ online: true, ready: true });
    const device = store.getState().trusted[0];
    if (!device) throw new Error("no device");
    await store.getState().pushTo(device, ["a"], false);
    expect(api.transferPush).toHaveBeenCalledWith(PEER, ["a"], false);
    expect(store.getState().push?.deviceName).toBe("Laptop");

    store.getState().resetSend();
    await store.getState().setReceiving(true);
    expect(api.transferReceiving).toHaveBeenCalledWith(true);
    for (let i = 0; i < 4; i += 1) await flush();
    expect(store.getState().receiveId).toBe("r9");
    expect(store.getState().incomingFrom).toBe("Laptop");
  });

  it("previews and offers a library move", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().loadMoveSummary();
    expect(store.getState().moveSummary?.documents).toBe(2);
    await store.getState().moveOffer();
    expect(store.getState().moving).toBe(true);
    expect(store.getState().offer?.sessionId).toBe("m1");
  });

  it("asks Rust to close but keeps a running send visible", async () => {
    const api = fakeApi({ transferClose: vi.fn(() => Promise.resolve(false)) });
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().offerDocuments(["a"], false);
    await store.getState().close();
    expect(store.getState().info).not.toBeNull();
    expect(store.getState().offer).not.toBeNull();
  });
});

describe("transfer formatting", () => {
  it("formats codes, percentages and countdowns", () => {
    expect(formatCode("482913")).toBe("482 913");
    expect(percent(5, 10)).toBe(50);
    expect(percent(5, 0)).toBe(0);
    expect(percent(20, 10)).toBe(100);
    expect(formatCountdown(581)).toBe("9:41");
    expect(formatCountdown(-3)).toBe("0:00");
  });

  it("accepts links and bare tickets, nothing else", () => {
    expect(cleanLink(`  ${LINK}\n`)).toBe(LINK);
    expect(cleanLink("selisabc123")).toBe("selisabc123");
    expect(cleanLink("https://example.com")).toBeNull();
    expect(cleanLink("")).toBeNull();
    expect(cleanLink(`selis://transfer/${"a".repeat(5000)}`)).toBeNull();
  });
});
