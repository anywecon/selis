/**
 * `.selispack` in the mock backend: a pack is a registered file that starts
 * with the real magic bytes followed by JSON (documents as base64). Tests use
 * `window.__selisTest.pack`:
 *
 * - `nextPick(token | null)`: what the next "Open a .selispack file" picks;
 * - `make({ docs, passphrase, damaged })`: registers a pack, returns its token;
 * - `lastExport()`: the token of the last exported pack (round trips);
 * - `cancelNextSave()`: the next export's save dialog is cancelled (desktop).
 */
import type { CommandError, ImportOutcome, PackExportView, PackImportView, PackKind, PackSummary } from "./ipc";

const MAGIC = "SELISPK\u0000";

type MockPack = {
  passphrase: string | null;
  damaged?: boolean;
  docs: Array<{ name: string; bytes: string }>;
};

type Deps = {
  fail: (code: CommandError["code"], message: string) => never;
  runOnce: <T>(command: string, requestId: string, work: () => Promise<T>) => Promise<T>;
  register: (file: File) => string;
  file: (token: string) => File | undefined;
  documentBytes: (id: string) => Promise<Uint8Array>;
  allDocumentIds: () => string[];
  title: (id: string) => string;
  importBytes: (name: string, bytes: Uint8Array) => Promise<ImportOutcome>;
};

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const PACK_COMMANDS = new Set(["pack_kind", "pack_export", "pack_import", "pick_pack"]);

export function createMockPack(deps: Deps) {
  let nextPick: string | null = null;
  let lastExport: string | null = null;
  let cancelSave = false;

  const encode = (pack: MockPack) => new File([MAGIC + JSON.stringify(pack)], "pack.selispack");

  const read = async (token: string): Promise<MockPack | null> => {
    const file = deps.file(token) ?? deps.fail("io", "unknown mock source");
    const text = await file.text();
    if (!text.startsWith(MAGIC)) return null;
    return JSON.parse(text.slice(MAGIC.length)) as MockPack;
  };

  const hooks = {
    nextPick: (token: string | null) => {
      nextPick = token;
    },
    make: (pack: { docs: Array<{ name: string; bytes: number[] }>; passphrase?: string | null; damaged?: boolean }) =>
      deps.register(
        encode({
          passphrase: pack.passphrase ?? null,
          damaged: pack.damaged ?? false,
          docs: pack.docs.map((d) => ({ name: d.name, bytes: toBase64(new Uint8Array(d.bytes)) })),
        }),
      ),
    lastExport: () => lastExport,
    cancelNextSave: () => {
      cancelSave = true;
    },
  };

  const handle = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case "pick_pack":
        return deps.runOnce(cmd, String(args.requestId), () =>
          Promise.resolve(nextPick ? { status: "picked", source: nextPick } : { status: "cancelled" }),
        );
      case "pack_kind": {
        const pack = await read(String(args.source));
        const kind: PackKind | null = pack ? (pack.passphrase ? "encrypted" : "plain") : null;
        return kind;
      }
      case "pack_export":
        return deps.runOnce(cmd, String(args.requestId), async (): Promise<PackExportView> => {
          const ids = (args.documentIds as string[] | null) ?? deps.allDocumentIds();
          if (ids.length === 0) deps.fail("invalidArgument", "nothing to pack");
          const passphrase = (args.passphrase as string | null) ?? null;
          if (passphrase !== null && passphrase.length < 8) deps.fail("invalidArgument", "passphrase too short");
          const docs = await Promise.all(
            ids.map(async (id) => ({ name: `${deps.title(id)}.pdf`, bytes: toBase64(await deps.documentBytes(id)) })),
          );
          if (cancelSave) {
            cancelSave = false;
            return { status: "cancelled" };
          }
          lastExport = deps.register(encode({ passphrase, docs }));
          const summary: PackSummary = {
            documents: ids.length,
            files: ids.length,
            bytes: docs.reduce((n, d) => n + d.bytes.length, 0),
            encrypted: passphrase !== null,
          };
          return { status: "shared", summary };
        });
      case "pack_import":
        return deps.runOnce(cmd, String(args.requestId), async (): Promise<PackImportView> => {
          const pack = await read(String(args.source));
          if (!pack) return { status: "refused", problem: "notAPack" };
          const given = (args.passphrase as string | null) ?? null;
          if (pack.passphrase && !given) return { status: "refused", problem: "passphraseNeeded" };
          if (pack.passphrase && given !== pack.passphrase) return { status: "refused", problem: "wrongPassphrase" };
          if (pack.damaged) return { status: "refused", problem: "damaged" };
          const ids: string[] = [];
          let duplicates = 0;
          for (const d of pack.docs) {
            const out = await deps.importBytes(d.name, fromBase64(d.bytes));
            ids.push(out.document.id);
            if (out.duplicate) duplicates += 1;
          }
          return { status: "imported", documentIds: ids, duplicates, signatures: 0, settings: null };
        });
      default:
        return deps.fail("invalidArgument", `unknown command ${cmd}`);
    }
  };

  return { handle, hooks };
}
