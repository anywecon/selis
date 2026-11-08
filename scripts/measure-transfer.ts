/**
 * Transfer acceptance on a real device or the AVD (ADR 0010, P3a): drives Selis
 * through the WebView DevTools protocol (debug or `measure` builds) and the dev
 * peer (`selis-peer`) on this computer. Commands run with argument arrays
 * (execFile / spawn), never through a shell.
 *
 *   node scripts/measure-transfer.ts --serial <s> --scenario <name> [--relay] [--file <pdf>]
 *
 * Scenarios:
 *   recv     this computer sends `--file`, the device receives (paste link)
 *   send     the device sends the library document named like `--file`, this computer receives
 *   resume   like recv, but the app is force-stopped at ~40 % and resumed after a restart
 *   expired  a ticket that lived 3 s is refused by the device (local expiry check)
 *   reuse    --serial receives, then --serial2 tries the same link: refused (single use)
 *   cold     the link arrives as a `selis://` intent on a cold start (camera-app path)
 *   seed     this computer sends every PDF in `--dir` to the device, then tags, favorites,
 *            a signature, a setting and extra versions are added there (library move input)
 *   move     --serial moves its whole library to --serial2 (QR flow), then moves it again:
 *            the second move must add nothing; libraries are compared document by document
 *   trusted  after a move, both devices save each other, then --serial sends a document to
 *            --serial2 with one tap while its Receive tab is open
 *   packseed fills the device from a pack of every PDF in `--dir` made on this computer, then adds
 *            tags, favorites, a signature, a setting and versions (as `seed`, without the network)
 *   pack     --serial exports its whole library as a .selispack (plain, then with a passphrase);
 *            --serial2 imports each (wrong passphrase first), again (no-op) and a tampered copy
 *            (refused); libraries are compared as for `move` (`--clear2` empties --serial2 per pack)
 * `--relay`: this computer has no direct paths (relay only), so the traffic goes through the relay.
 * `--clear`: wipe Selis' data on the device first (library, transfer store, device key).
 *
 * Prints one JSON line per run: route seen, seconds, MB/s, app RSS (baseline, peak, delta),
 * hashes. Needs: adb, a built `target/release/examples/selis-peer`, the app installed.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PKG = "com.anywecon.selis";
const CDP_PORT = 9334;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".tmp", "measure-transfer");
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

type Options = {
  serial: string;
  serial2: string | null;
  scenario: string;
  relay: boolean;
  clear: boolean;
  /** Wipe --serial2 first (move: an empty receiving library). */
  clear2: boolean;
  file: string;
  dir: string | null;
};

function parseArgs(argv: readonly string[]): Options {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const serial = get("--serial");
  const scenario = get("--scenario");
  if (!serial || !scenario) throw new Error("usage: --serial <s> --scenario recv|send|resume|expired|reuse|cold [--relay] [--file f]");
  return {
    serial,
    serial2: get("--serial2"),
    scenario,
    relay: argv.includes("--relay"),
    clear: argv.includes("--clear"),
    clear2: argv.includes("--clear2"),
    dir: get("--dir"),
    file: resolve(get("--file") ?? join(root, ".tmp", "p3", "big-200mb.pdf")),
  };
}

function adb(serial: string, args: readonly string[]): string {
  return execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
}

function log(message: string): void {
  console.error(`[transfer] ${new Date().toISOString().slice(11, 23)} ${message}`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** App process RSS in MB (`dumpsys meminfo` App Summary "TOTAL RSS"). */
async function rssMb(serial: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", "dumpsys", "meminfo", PKG], { env, maxBuffer: 8 << 20 });
    const kb = /TOTAL RSS:\s+(\d+)/.exec(stdout)?.[1];
    return kb ? Math.round(Number(kb) / 1024) : null;
  } catch {
    return null;
  }
}

/** Every sampler started, stopped when the run ends (also on errors). */
const samplers: Array<{ stop: () => Promise<number> }> = [];

class RssSampler {
  private samples: number[] = [];
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly serial: string;

  constructor(serial: string) {
    this.serial = serial;
  }

  start(): void {
    samplers.push(this);
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const mb = await rssMb(this.serial);
        if (mb !== null) this.samples.push(mb);
        await sleep(700);
      }
    })();
  }

  async stop(): Promise<number> {
    this.running = false;
    await this.loop;
    return Math.max(0, ...this.samples);
  }
}

type Cdp = { evaluate: <T>(expression: string) => Promise<T | undefined>; close: () => void };

async function openSocket(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", rejectOpen, { once: true });
  });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (msg.id === undefined) return;
    pending.get(msg.id)?.(msg.result ?? msg.error);
    pending.delete(msg.id);
  });
  const evaluate = async <T>(expression: string): Promise<T | undefined> => {
    const mid = ++id;
    const reply = new Promise<unknown>((r) => pending.set(mid, r));
    ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const result = (await reply) as { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    if (result?.exceptionDetails) throw new Error(`page error: ${JSON.stringify(result.exceptionDetails)}`);
    return result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && (value as unknown) !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** One local port per device (two devices are driven at once in move / trusted). */
const ports = new Map<string, number>();
function portOf(serial: string): number {
  let port = ports.get(serial);
  if (port === undefined) {
    port = CDP_PORT + ports.size;
    ports.set(serial, port);
  }
  return port;
}

async function connect(serial: string, timeoutMs = 30_000): Promise<Cdp> {
  const deadline = Date.now() + timeoutMs;
  const port = portOf(serial);
  for (;;) {
    try {
      const pid = adb(serial, ["shell", "pidof", PKG]).trim();
      const socket = new RegExp(`@(webview_devtools_remote_${pid})`).exec(adb(serial, ["shell", "cat", "/proc/net/unix"]))?.[1];
      if (pid && socket) {
        adb(serial, ["forward", `tcp:${port}`, `localabstract:${socket}`]);
        const response = await fetch(`http://127.0.0.1:${port}/json`);
        const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((t) => t.type === "page");
        if (page) {
          const cdp = await openSocket(page.webSocketDebuggerUrl);
          await waitFor("IPC", () => cdp.evaluate<boolean>("typeof window.__TAURI_INTERNALS__?.invoke === 'function' || null"), 20_000);
          return cdp;
        }
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("WebView DevTools not reachable (debug or measure build?)");
    await sleep(500);
  }
}

const q = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;

async function click(cdp: Cdp, testId: string): Promise<void> {
  await waitFor(`#${testId}`, () => cdp.evaluate<boolean>(`!!${q(testId)} && !${q(testId)}.disabled`), 30_000);
  await cdp.evaluate(`(${q(testId)}.click(), true)`);
}

async function openTransfer(cdp: Cdp, tab: "send" | "receive"): Promise<void> {
  const tabButton = `[...document.querySelectorAll('nav button')].find((b) => /Transfer|Μεταφορά/.test(b.textContent))`;
  await waitFor("tab bar", () => cdp.evaluate<boolean>(`!!${tabButton}`), 30_000);
  await cdp.evaluate(`(${tabButton}.click(), true)`);
  await waitFor("transfer screen", () => cdp.evaluate<boolean>(`!!${q("transfer-screen")}`), 15_000);
  await cdp.evaluate(`(document.getElementById('transfer-tab-${tab}').click(), true)`);
  await waitFor(`${tab} panel`, () => cdp.evaluate<boolean>(`!!${q(tab === "send" ? "transfer-choose" : "transfer-receive")}`), 30_000);
}

async function pasteLink(cdp: Cdp, link: string): Promise<void> {
  await click(cdp, "transfer-paste");
  await waitFor("paste sheet", () => cdp.evaluate<boolean>(`!!${q("transfer-paste-input")}`), 10_000);
  await cdp.evaluate(`(() => {
    const ta = ${q("transfer-paste-input")};
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(link)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await click(cdp, "transfer-paste-submit");
  // A link only asks first, with the sender (security audit run-1, lead 5).
  await click(cdp, "transfer-link-accept");
}

function launch(serial: string): void {
  adb(serial, ["shell", "am", "force-stop", PKG]);
  adb(serial, ["shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`]);
}

/** Every peer started, stopped when the run ends (also on errors). */
const peers: Array<{ kill: () => void }> = [];

/** The dev peer on this computer. */
class Peer {
  readonly lines: Array<{ t: number; line: string }> = [];
  exited = false;
  private readonly proc: ChildProcess;

  constructor(args: readonly string[]) {
    const exe = join(root, "target", "release", "examples", process.platform === "win32" ? "selis-peer.exe" : "selis-peer");
    if (!existsSync(exe)) throw new Error("build it first: cargo build --release -p selis-transfer --example selis-peer");
    this.proc = spawn(exe, [...args, "--key", join(scratch, "host.key"), "--store", join(scratch, `store-${Date.now()}`)], {
      cwd: scratch,
    });
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        // Skip the terminal QR code.
        if (line && !/^[▀-▟█ ]+$/.test(line)) {
          this.lines.push({ t: Date.now(), line });
          if (!line.startsWith("LINK")) log(`peer: ${line}`);
        }
      }
    };
    this.proc.stdout?.on("data", onData);
    this.proc.stderr?.on("data", onData);
    this.proc.on("exit", () => {
      this.exited = true;
    });
    peers.push(this);
  }

  async waitLine(pattern: RegExp, timeoutMs: number): Promise<{ t: number; line: string }> {
    return waitFor(`peer ${String(pattern)}`, () => Promise.resolve(this.lines.find((l) => pattern.test(l.line)) ?? null), timeoutMs);
  }

  /** Answers the peer's "Same code on the phone? Send" prompt. */
  confirm(yes: boolean): void {
    this.proc.stdin?.write(yes ? "y\n" : "n\n");
  }

  kill(): void {
    this.proc.kill();
  }
}

type Result = Record<string, unknown>;

/** BLAKE3 of a file, as the library names it (`selis-peer hash`). */
function blake3Of(path: string): string {
  const exe = join(root, "target", "release", "examples", process.platform === "win32" ? "selis-peer.exe" : "selis-peer");
  return execFileSync(exe, ["hash", path], { encoding: "utf8" }).split(/\s+/)[0] ?? "";
}

/** Whether the library lists a document with this BLAKE3 (asked through the app's IPC). */
async function libraryHas(cdp: Cdp, blake3: string): Promise<boolean> {
  const docs = await cdp.evaluate<Array<{ blake3: string }>>(
    `window.__TAURI_INTERNALS__.invoke('list_documents', { query: { search: '', filter: 'all', tagId: null, sort: 'recent' } })`,
  );
  return (docs ?? []).some((d) => d.blake3 === blake3);
}

const digits = (code: string) => code.replace(/\s/g, "");

/** The device receives `file` from this computer, through the Receive tab's paste field. */
async function receive(o: Options, cdp: Cdp, stopAt?: number): Promise<{ result: Result; sender: Peer }> {
  const sender = new Peer(["send", o.file, ...(o.relay ? ["--relay-only"] : [])]);
  const link = (await sender.waitLine(/^LINK /, 60_000)).line.slice(5);
  const baseline = (await rssMb(o.serial)) ?? 0;
  const sampler = new RssSampler(o.serial);
  sampler.start();
  const t0 = Date.now();
  await pasteLink(cdp, link);
  // Both screens show the code; the sender (this computer) confirms only if they match.
  const code = await waitFor("code", () => cdp.evaluate<string>(`${q("transfer-receive-code")}?.textContent || null`), 60_000);
  const peerCode = (await sender.waitLine(/^code /, 30_000)).line.slice(5);
  if (digits(code) !== digits(peerCode)) {
    sender.confirm(false);
    throw new Error(`codes differ: device ${code}, sender ${peerCode}`);
  }
  sender.confirm(true);
  const routes = new Set<string>();
  let tData = 0;
  let stoppedAt = 0;
  await waitFor(
    "receive end",
    async () => {
      const state = await cdp.evaluate<{ done: boolean; failed: string | null; route: string | null; pct: number }>(`({
        done: !!${q("transfer-receive-done")},
        failed: ${q("transfer-receive-problem")}?.dataset.problem ?? null,
        route: ${q("transfer-route")}?.dataset.route ?? null,
        pct: Number(${q("transfer-receive-progress")}?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? 0),
      })`);
      if (!state) return null;
      if (state.route) routes.add(state.route);
      if (!tData && state.pct > 0) tData = Date.now();
      if (stopAt !== undefined && state.pct >= stopAt) {
        stoppedAt = state.pct;
        return true;
      }
      if (state.failed) throw new Error(`receive failed: ${state.failed}`);
      return state.done || null;
    },
    30 * 60_000,
  );
  const t1 = Date.now();
  const peak = await sampler.stop();
  const mb = statSync(o.file).size / 1e6;
  const result: Result = {
    codeMatch: digits(code) === digits(peerCode),
    routes: [...routes],
    seconds: (t1 - t0) / 1000,
    rssBaselineMb: baseline,
    rssPeakMb: peak,
    rssDeltaMb: peak - baseline,
  };
  if (stopAt !== undefined) result.stoppedAtPct = stoppedAt;
  else result.mbPerSecond = Math.round((mb / ((t1 - (tData || t0)) / 1000)) * 10) / 10;
  return { result, sender };
}

async function scenarioSend(o: Options, cdp: Cdp): Promise<Result> {
  await openTransfer(cdp, "send");
  const name = basename(o.file).replace(/\.pdf$/i, "");
  const picked = await cdp.evaluate<boolean>(`(() => {
    const row = [...document.querySelectorAll('[data-testid="transfer-doc"]')].find((r) => r.textContent.includes(${JSON.stringify(name)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!picked) throw new Error(`no library document named like ${name} (run the recv scenario first)`);
  const baseline = (await rssMb(o.serial)) ?? 0;
  await click(cdp, "transfer-send-start");
  const link = await waitFor("link", () => cdp.evaluate<string>(`${q("transfer-qr")}?.dataset.link || null`), 120_000);
  const out = join(scratch, `out-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const sampler = new RssSampler(o.serial);
  sampler.start();
  const t0 = Date.now();
  const receiver = new Peer(["receive", link, "--out", out, ...(o.relay ? ["--relay-only"] : [])]);
  const peerCode = (await receiver.waitLine(/^code /, 60_000)).line.slice(5, 12);
  const code = await waitFor("code", () => cdp.evaluate<string>(`${q("transfer-send-code")}?.textContent || null`), 60_000);
  const codeMatch = digits(code) === digits(peerCode);
  if (!codeMatch) throw new Error(`codes differ: device ${code}, peer ${peerCode}`);
  await click(cdp, "transfer-confirm");
  const routes = new Set<string>();
  let tData = 0;
  await waitFor(
    "send end",
    async () => {
      const route = await cdp.evaluate<string | null>(`${q("transfer-route")}?.dataset.route ?? null`);
      if (route) routes.add(route);
      if (!tData && receiver.lines.some((l) => /^[1-9]\d* \/ \d+ MB/.test(l.line))) tData = Date.now();
      if (receiver.lines.some((l) => l.line.startsWith("Error")) || (receiver.exited && !receiver.lines.some((l) => l.line.startsWith("done in")))) {
        throw new Error("peer failed or stopped");
      }
      return receiver.lines.some((l) => l.line.startsWith("done in")) || null;
    },
    30 * 60_000,
  );
  const t1 = Date.now();
  const peak = await sampler.stop();
  await waitFor("device done", () => cdp.evaluate<boolean>(`!!${q("transfer-send-done")}`), 30_000);
  receiver.kill();
  const received = receiver.lines.find((l) => l.line.startsWith("received "))?.line ?? "";
  const path = /-> (.+)$/.exec(received)?.[1]?.trim() ?? "";
  const same = path !== "" && (await sha256(path)) === (await sha256(o.file));
  rmSync(out, { recursive: true, force: true });
  const mb = statSync(o.file).size / 1e6;
  return {
    codeMatch,
    routes: [...routes],
    seconds: (t1 - t0) / 1000,
    mbPerSecond: Math.round((mb / ((t1 - (tData || t0)) / 1000)) * 10) / 10,
    rssBaselineMb: baseline,
    rssPeakMb: peak,
    rssDeltaMb: peak - baseline,
    sha256Match: same,
  };
}

/** Calls an app command through the WebView (the IPC the UI uses). */
async function invoke<T>(cdp: Cdp, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const value = await cdp.evaluate<T>(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return value as T;
}

type Doc = { id: string; title: string; blake3: string; favorite: boolean; tagIds: string[] };
type Tag = { id: string; name: string };
type Summary = { documents: number; versions: number; tags: number; signatures: number; bytes: number };

/** Everything a move must carry, comparable across devices. */
async function snapshot(cdp: Cdp): Promise<{ summary: Summary; docs: string[]; signatures: string[]; theme: string }> {
  const docs = await invoke<Doc[]>(cdp, "list_documents", { query: { search: "", filter: "all", tagId: null, sort: "name" } });
  const tags = await invoke<Tag[]>(cdp, "list_tags");
  const name = new Map(tags.map((t) => [t.id, t.name]));
  const summary = await invoke<Summary>(cdp, "transfer_move_summary");
  const signatures = (await invoke<Array<{ id: string }>>(cdp, "list_signatures")).map((s) => s.id).sort();
  const settings = await invoke<{ theme: string }>(cdp, "get_settings");
  return {
    summary,
    docs: docs
      .map((d) => `${d.blake3} ${d.favorite ? "★" : "-"} ${d.tagIds.map((t) => name.get(t)).sort().join(",")}`)
      .sort(),
    signatures,
    theme: settings.theme,
  };
}

/** A 1×1 PNG (a stand-in signature image). */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/** What a library holds besides files: tags, favorites, a signature, a setting, versions. */
async function decorate(cdp: Cdp): Promise<void> {
  const docs = await invoke<Doc[]>(cdp, "list_documents", { query: { search: "", filter: "all", tagId: null, sort: "name" } });
  const work = await invoke<Tag>(cdp, "create_tag", { name: "Work" });
  const home = await invoke<Tag>(cdp, "create_tag", { name: "Σπίτι" });
  for (const [i, d] of docs.entries()) {
    const tagIds = [...(i < 10 ? [work.id] : []), ...(i >= 5 && i < 15 ? [home.id] : [])];
    if (tagIds.length) await invoke(cdp, "set_document_tags", { documentId: d.id, tagIds });
    if (i % 17 === 0) await invoke(cdp, "set_favorite", { id: d.id, favorite: true });
  }
  await invoke(cdp, "save_signature", { id: "0190aaaa-seed-sign", kind: "drawn", png: PNG_B64 });
  await invoke(cdp, "update_settings", {
    patch: {
      locale: null,
      theme: "sepia",
      librarySort: null,
      libraryView: null,
      nightMode: null,
      localOnly: null,
      relayUrl: null,
      versionsPerDocument: null,
      historyLimitMb: null,
      appLock: null,
    },
  });
  // Two documents get a second version (a small edited copy).
  for (const d of docs.slice(0, 2)) {
    const pdf = `%PDF-1.7\n% edited ${d.id}\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n%%EOF\n`;
    const data = Buffer.from(pdf).toString("base64");
    const uploadId = `seed-${d.id}`;
    await invoke(cdp, "upload_chunk", { uploadId, offset: 0, data });
    await invoke(cdp, "commit_working_copy", {
      uploadId,
      documentId: d.id,
      baseBlake3: d.blake3,
      sizeBytes: Buffer.from(data, "base64").length,
    });
    await invoke(cdp, "save_version", { requestId: `seed-v-${d.id}`, documentId: d.id, label: "manual" });
  }
}

async function seed(o: Options, cdp: Cdp): Promise<Result> {
  if (!o.dir) throw new Error("--dir needed");
  const dir = resolve(o.dir);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => join(dir, f));
  await openTransfer(cdp, "receive");
  const sender = new Peer(["send", ...files]);
  const link = (await sender.waitLine(/^LINK /, 120_000)).line.slice(5);
  const t0 = Date.now();
  await pasteLink(cdp, link);
  const code = await waitFor("code", () => cdp.evaluate<string>(`${q("transfer-receive-code")}?.textContent || null`), 120_000);
  const peerCode = (await sender.waitLine(/^code /, 60_000)).line.slice(5);
  if (digits(code) !== digits(peerCode)) throw new Error("codes differ");
  sender.confirm(true);
  await waitFor("seed received", () => cdp.evaluate<boolean>(`!!${q("transfer-receive-done")}`), 30 * 60_000);
  const seconds = (Date.now() - t0) / 1000;
  sender.kill();
  await decorate(cdp);
  const after = await snapshot(cdp);
  return { files: files.length, seconds, summary: after.summary };
}

/** --serial moves its library to --serial2 through the QR flow; returns the receiver's done view. */
async function moveOnce(a: Cdp, b: Cdp, serialB: string): Promise<{ seconds: number; done: unknown; rssDeltaMb: number }> {
  await openTransfer(a, "send");
  await click(a, "transfer-move-open");
  await waitFor("move summary", () => a.evaluate<boolean>(`!!${q("transfer-move-summary")}`), 30_000);
  await click(a, "transfer-move-qr");
  const link = await waitFor("move link", () => a.evaluate<string>(`${q("transfer-qr")}?.dataset.link || null`), 300_000);
  await openTransfer(b, "receive");
  const baseline = (await rssMb(serialB)) ?? 0;
  const sampler = new RssSampler(serialB);
  sampler.start();
  const t0 = Date.now();
  await pasteLink(b, link);
  const codeB = await waitFor("code on receiver", () => b.evaluate<string>(`${q("transfer-receive-code")}?.textContent || null`), 120_000);
  const codeA = await waitFor("code on sender", () => a.evaluate<string>(`${q("transfer-send-code")}?.textContent || null`), 120_000);
  if (digits(codeA) !== digits(codeB)) throw new Error(`codes differ: ${codeA} / ${codeB}`);
  await click(a, "transfer-confirm");
  await waitFor(
    "move received",
    async () => {
      const failed = await b.evaluate<string | null>(`${q("transfer-receive-problem")}?.dataset.problem ?? null`);
      if (failed) throw new Error(`move failed: ${failed}`);
      return b.evaluate<boolean>(`!!${q("transfer-receive-done")}`);
    },
    60 * 60_000,
  );
  const seconds = (Date.now() - t0) / 1000;
  const peak = await sampler.stop();
  const done = await b.evaluate<unknown>(`({
    count: ${q("transfer-receive-count")}?.textContent ?? null,
    duplicates: ${q("transfer-receive-duplicates")}?.textContent ?? null,
    moved: !!${q("transfer-receive-moved")},
  })`);
  return { seconds, done, rssDeltaMb: peak - baseline };
}

type PackImportView =
  | { status: "imported"; documentIds: string[]; duplicates: number; signatures: number; settings: boolean }
  | { status: "refused"; problem: string };

function topActivity(serial: string): string {
  const out = adb(serial, ["shell", "dumpsys", "activity", "activities"]);
  return /topResumedActivity=(.*)/.exec(out)?.[1] ?? "";
}

/** Waits for the share sheet, closes it with Back, and waits until Selis is in front again
 *  (a backgrounded WebView does not deliver IPC replies). */
async function dismissShareSheet(serial: string): Promise<void> {
  await waitFor("share sheet", () => Promise.resolve(topActivity(serial).includes(PKG) ? null : true), 15_000);
  adb(serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitFor("Selis in front", () => Promise.resolve(topActivity(serial).includes(PKG) ? true : null), 15_000);
}

/** The newest pack in the app's share folder, pulled to the host (debug build: run-as). */
function pullPack(serial: string, to: string): string {
  const name = adb(serial, ["shell", "run-as", PKG, "sh", "-c", "'ls -t cache/share/*.selispack | head -1'"]).trim();
  if (!name.endsWith(".selispack")) throw new Error(`no pack in the share folder: ${name}`);
  const bytes = execFileSync("adb", ["-s", serial, "exec-out", "run-as", PKG, "cat", name], { env, maxBuffer: 2 ** 31 });
  writeFileSync(to, bytes);
  return name;
}

/** Copies a host file into the app's cache; returns the absolute path the app reads. */
function pushPrivate(serial: string, from: string, name: string): string {
  // One argument: adb on Windows mangles a quoted shell snippet split over several.
  // cache/dev-inbox: the one app folder debug and `measure` builds accept as a source besides
  // what a picker or "Open with" handed out (security audit run-1, lead 7).
  execFileSync("adb", ["-s", serial, "exec-in", `run-as ${PKG} sh -c 'mkdir -p cache/dev-inbox && cat > cache/dev-inbox/${name}'`], {
    env,
    input: readFileSync(from),
    maxBuffer: 2 ** 31,
  });
  return `/data/user/0/${PKG}/cache/dev-inbox/${name}`;
}

/** Fills the device from a pack made on this computer (`selispack make` of `--dir`), then decorates it. */
async function packSeed(o: Options, cdp: Cdp): Promise<Result> {
  if (!o.dir) throw new Error("--dir needed");
  const dir = resolve(o.dir);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => join(dir, f));
  const out = join(scratch, "seed-pack");
  rmSync(out, { recursive: true, force: true });
  execFileSync("cargo", ["run", "-q", "--release", "-p", "selis-core", "--example", "selispack", "--", "make", out, "unused passphrase", ...files], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const source = pushPrivate(o.serial, join(out, "plain.selispack"), "seed.selispack");
  const t0 = Date.now();
  const imported = await invoke<PackImportView>(cdp, "pack_import", { requestId: `seed-${t0}`, source, passphrase: null });
  const seconds = (Date.now() - t0) / 1000;
  adb(o.serial, ["shell", "run-as", PKG, "rm", "-f", "cache/dev-inbox/seed.selispack"]);
  if (imported.status !== "imported") throw new Error(`seed pack refused: ${imported.problem}`);
  await decorate(cdp);
  const after = await snapshot(cdp);
  return { files: files.length, packMb: statSync(join(out, "plain.selispack")).size / 1e6, importSeconds: seconds, summary: after.summary };
}

/** --serial exports its whole library as a pack (plain, then protected); --serial2 imports each. */
async function packRoundTrip(o: Options, a: Cdp, b: Cdp): Promise<Record<string, unknown>> {
  const before = await snapshot(a);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const out: Record<string, unknown> = { sender: before.summary };
  for (const passphrase of [null, "correct horse battery"] as const) {
    const label = passphrase ? "protected" : "plain";
    if (o.clear2) {
      adb(o.serial2 ?? "", ["shell", "pm", "clear", PKG]);
      adb(o.serial2 ?? "", ["shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS"]);
      launch(o.serial2 ?? "");
      b.close();
      b = await connect(o.serial2 ?? "", 60_000);
    }
    let t0 = Date.now();
    const summary = await invoke<{ documents: number; bytes: number; encrypted: boolean }>(a, "pack_export", {
      requestId: `pack-${label}-${t0}`,
      documentIds: null,
      includeHistory: true,
      passphrase,
    });
    const exportSeconds = (Date.now() - t0) / 1000;
    await dismissShareSheet(o.serial);
    const local = join(scratch, `${label}.selispack`);
    const remoteName = pullPack(o.serial, local);
    const size = statSync(local).size;
    const source = pushPrivate(o.serial2 ?? "", local, "in.selispack");
    const baseline = (await rssMb(o.serial2 ?? "")) ?? 0;
    const sampler = new RssSampler(o.serial2 ?? "");
    sampler.start();
    let wrong: PackImportView | null = null;
    if (passphrase) {
      wrong = await invoke<PackImportView>(b, "pack_import", { requestId: `w-${t0}`, source, passphrase: "wrong horse battery" });
    }
    t0 = Date.now();
    const first = await invoke<PackImportView>(b, "pack_import", { requestId: `i-${t0}`, source, passphrase });
    const importSeconds = (Date.now() - t0) / 1000;
    const peak = await sampler.stop();
    const afterFirst = await snapshot(b);
    const second = await invoke<PackImportView>(b, "pack_import", { requestId: `r-${Date.now()}`, source, passphrase });
    const afterSecond = await snapshot(b);
    // One flipped byte in the middle: refused, nothing changes.
    const bytes = readFileSync(local);
    const mid = Math.floor(bytes.length / 2);
    bytes.writeUInt8((bytes.readUInt8(mid) ^ 1) & 0xff, mid);
    const tamperedLocal = join(scratch, `${label}-tampered.selispack`);
    writeFileSync(tamperedLocal, bytes);
    const tamperedSource = pushPrivate(o.serial2 ?? "", tamperedLocal, "tampered.selispack");
    const tampered = await invoke<PackImportView>(b, "pack_import", { requestId: `t-${Date.now()}`, source: tamperedSource, passphrase });
    const afterTamper = await snapshot(b);
    const leftovers = adb(o.serial2 ?? "", ["shell", "run-as", PKG, "sh", "-c", "'ls cache/share 2>/dev/null; ls files/pack-in 2>/dev/null; ls pack-in 2>/dev/null'"]).trim();
    out[label] = {
      packMb: size / 1e6,
      remoteName,
      exportSeconds,
      exported: summary,
      importSeconds,
      rssDeltaMb: peak - baseline,
      wrongPassphrase: wrong && wrong.status === "refused" ? wrong.problem : wrong,
      first: first.status === "imported" ? { added: first.documentIds.length - first.duplicates, duplicates: first.duplicates, signatures: first.signatures, settings: first.settings } : first,
      docsMatch: same(before.docs, afterFirst.docs),
      signaturesMatch: same(before.signatures, afterFirst.signatures),
      settingsMatch: before.theme === afterFirst.theme,
      summariesMatch: same(before.summary, afterFirst.summary),
      rerunNoOp: same(afterFirst, afterSecond) && second.status === "imported" && second.duplicates === second.documentIds.length,
      tampered: tampered.status === "refused" ? tampered.problem : "IMPORTED",
      tamperNoChange: same(afterSecond, afterTamper),
      leftovers,
    };
    adb(o.serial2 ?? "", ["shell", "run-as", PKG, "rm", "-f", "cache/dev-inbox/in.selispack", "cache/dev-inbox/tampered.selispack"]);
  }
  // A reconnect above replaced the caller's socket: close ours too, or node never exits.
  b.close();
  return out;
}

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(scratch, { recursive: true });
  const want = blake3Of(o.file);
  const base = { serial: o.serial, scenario: o.scenario, relay: o.relay, file: basename(o.file), sizeMb: statSync(o.file).size / 1e6 };
  if (o.clear) {
    adb(o.serial, ["shell", "pm", "clear", PKG]);
    // The progress notification's permission dialog would cover the screen.
    adb(o.serial, ["shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS"]);
  }
  launch(o.serial);
  let cdp = await connect(o.serial);
  try {
    let result: Result;
    switch (o.scenario) {
      case "recv": {
        await openTransfer(cdp, "receive");
        await sleep(3_000);
        const { result: r, sender } = await receive(o, cdp);
        sender.kill();
        result = { ...r, blake3InLibrary: await libraryHas(cdp, want) };
        break;
      }
      case "send":
        result = await scenarioSend(o, cdp);
        break;
      case "resume": {
        await openTransfer(cdp, "receive");
        await sleep(3_000);
        const { result: first, sender } = await receive(o, cdp, 40);
        log(`force-stopping at ${String(first.stoppedAtPct)} %`);
        adb(o.serial, ["shell", "am", "force-stop", PKG]);
        await sleep(2_000);
        cdp.close();
        launch(o.serial);
        cdp = await connect(o.serial);
        await openTransfer(cdp, "receive");
        const t0 = Date.now();
        await click(cdp, "transfer-resume");
        const resumedAt = await waitFor(
          "progress after resume",
          () =>
            cdp.evaluate<number>(
              `Number(${q("transfer-receive-progress")}?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? 0) || null`,
            ),
          120_000,
        );
        await waitFor("resumed receive done", () => cdp.evaluate<boolean>(`!!${q("transfer-receive-done")}`), 30 * 60_000);
        sender.kill();
        result = {
          ...first,
          resumedAtPct: resumedAt,
          secondsAfterResume: (Date.now() - t0) / 1000,
          blake3InLibrary: await libraryHas(cdp, want),
        };
        break;
      }
      case "expired": {
        await openTransfer(cdp, "receive");
        const sender = new Peer(["send", o.file, "--yes", "--lifetime", "3"]);
        const link = (await sender.waitLine(/^LINK /, 60_000)).line.slice(5);
        await sleep(5_000);
        await pasteLink(cdp, link);
        const problem = await waitFor("problem", () => cdp.evaluate<string>(`${q("transfer-receive-problem")}?.dataset.problem || null`), 30_000);
        sender.kill();
        result = { refused: problem === "expired", problem };
        break;
      }
      case "reuse": {
        if (!o.serial2) throw new Error("--serial2 needed");
        await openTransfer(cdp, "receive");
        const sender = new Peer(["send", o.file, "--yes", "--keep"]);
        const link = (await sender.waitLine(/^LINK /, 60_000)).line.slice(5);
        await pasteLink(cdp, link);
        await waitFor("first receive done", () => cdp.evaluate<boolean>(`!!${q("transfer-receive-done")}`), 10 * 60_000);
        launch(o.serial2);
        const other = await connect(o.serial2);
        await openTransfer(other, "receive");
        await pasteLink(other, link);
        const problem = await waitFor("problem", () => other.evaluate<string>(`${q("transfer-receive-problem")}?.dataset.problem || null`), 60_000);
        other.close();
        adb(o.serial2, ["forward", "--remove-all"]);
        sender.kill();
        result = { refused: problem === "alreadyUsed", problem };
        break;
      }
      case "seed":
        result = await seed(o, cdp);
        break;
      case "move": {
        if (!o.serial2) throw new Error("--serial2 needed");
        if (o.clear2) {
          adb(o.serial2, ["shell", "pm", "clear", PKG]);
          adb(o.serial2, ["shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS"]);
        }
        launch(o.serial2);
        const b = await connect(o.serial2, 60_000);
        const before = await snapshot(cdp);
        const first = await moveOnce(cdp, b, o.serial2);
        const afterFirst = await snapshot(b);
        // A second move: everything is already there.
        await click(cdp, "transfer-send-again");
        await click(b, "transfer-receive-again");
        const second = await moveOnce(cdp, b, o.serial2);
        const afterSecond = await snapshot(b);
        b.close();
        const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
        result = {
          documents: before.summary.documents,
          sender: before.summary,
          receiver: afterFirst.summary,
          first,
          second,
          docsMatch: same(before.docs, afterFirst.docs),
          signaturesMatch: same(before.signatures, afterFirst.signatures),
          settingsMatch: before.theme === afterFirst.theme,
          summariesMatch: same(before.summary, afterFirst.summary),
          rerunNoOp: same(afterFirst, afterSecond),
        };
        break;
      }
      case "trusted": {
        if (!o.serial2) throw new Error("--serial2 needed");
        // Both devices still show the done cards of the last move.
        launch(o.serial2);
        const b = await connect(o.serial2, 60_000);
        const devA = await invoke<{ deviceId: string }>(cdp, "transfer_open");
        const devB = await invoke<{ deviceId: string }>(b, "transfer_open");
        await invoke(cdp, "transfer_trust", { endpointId: devB.deviceId, name: "AVD" });
        await invoke(b, "transfer_trust", { endpointId: devA.deviceId, name: "S23" });
        await openTransfer(b, "receive");
        await openTransfer(cdp, "send");
        await waitFor("trusted row ready", () => cdp.evaluate<boolean>(`document.querySelector('[data-testid="trusted-device"][data-status="ready"]') !== null`), 90_000);
        await cdp.evaluate(`(document.querySelector('[data-testid="transfer-doc"]').click(), true)`);
        const t0 = Date.now();
        await click(cdp, "trusted-send");
        const from = await waitFor("push arrives", () => b.evaluate<string>(`${q("transfer-from")}?.textContent || (${q("transfer-receive-done")} ? "done" : null)`), 120_000);
        await waitFor("push received", () => b.evaluate<boolean>(`!!${q("transfer-receive-done")}`), 10 * 60_000);
        await waitFor("sender done", () => cdp.evaluate<boolean>(`!!${q("transfer-send-done")}`), 60_000);
        const codeShown = await cdp.evaluate<boolean>(`!!${q("transfer-send-code")}`);
        result = { seconds: (Date.now() - t0) / 1000, from, codeAsked: codeShown };
        b.close();
        break;
      }
      case "packseed":
        result = await packSeed(o, cdp);
        break;
      case "pack": {
        if (!o.serial2) throw new Error("--serial2 needed");
        launch(o.serial2);
        const b = await connect(o.serial2, 60_000);
        result = await packRoundTrip(o, cdp, b);
        b.close();
        break;
      }
      case "cold": {
        const sender = new Peer(["send", o.file, "--yes"]);
        const link = (await sender.waitLine(/^LINK /, 60_000)).line.slice(5);
        cdp.close();
        adb(o.serial, ["shell", "am", "force-stop", PKG]);
        const t0 = Date.now();
        adb(o.serial, ["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, PKG]);
        cdp = await connect(o.serial);
        await waitFor("received", () => cdp.evaluate<boolean>(`!!${q("transfer-receive-done")}`), 30 * 60_000);
        sender.kill();
        result = { seconds: (Date.now() - t0) / 1000, blake3InLibrary: await libraryHas(cdp, want) };
        break;
      }
      default:
        throw new Error(`unknown scenario ${o.scenario}`);
    }
    console.log(JSON.stringify({ ...base, ...result }));
    return 0;
  } finally {
    for (const peer of peers) peer.kill();
    await Promise.all(samplers.map((sampler) => sampler.stop()));
    cdp.close();
    try {
      adb(o.serial, ["forward", "--remove-all"]);
    } catch {
      // Device gone.
    }
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`[transfer] error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 2;
}
