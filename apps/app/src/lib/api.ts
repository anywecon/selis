/**
 * The UI's only door to the backend: typed commands from the generated
 * bindings (`lib/ipc`), sent through the reliability layer (timeouts, lost-reply
 * recovery; docs/adr/0005-ipc-reliability.md), with `Result` unwrapped into
 * exceptions for TanStack Query.
 */
import {
  type CallResult,
  type CommandError,
  commands,
  type ErrorCode,
  type LibraryQuery,
  type LongCallOptions,
  reliableIpc,
  type ShortCallOptions,
  type SignatureKind,
  type ToolRequest,
  type VersionLabel,
} from "./ipc";

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(error: CommandError) {
    super(error.message);
    this.name = "ApiError";
    this.code = error.code;
  }
}

async function unwrap<T>(call: Promise<CallResult<T>>): Promise<T> {
  const result = await call;
  if (result.status === "error") throw new ApiError(result.error);
  return result.data;
}

/** Short read-only (or idempotent) commands: a lost reply is simply asked for again. */
const READ: ShortCallOptions = { timeoutMs: 10_000, retry: true };
/** Short writes: time out, never repeat automatically. */
const WRITE: ShortCallOptions = { timeoutMs: 10_000, retry: false };
/** Rust cancels an import after 30 s; check for a lost reply well before that. */
const IMPORT: LongCallOptions = { checkAfterMs: 5_000, pollMs: 2_000 };
/** The picker may stay open for minutes: check only once the app is back in front. */
const PICK: LongCallOptions = { checkAfterMs: null, pollMs: 2_000 };
/** A chunk of a few MB: give the write time; repeating one is harmless (keyed by offset). */
const UPLOAD: ShortCallOptions = { timeoutMs: 20_000, retry: true };
/** Hashing a large working copy takes a moment; check for a lost reply after 5 s. */
const SAVE: LongCallOptions = { checkAfterMs: 5_000, pollMs: 2_000 };
/** Laying out and printing a long document takes a while; Rust gives up after 2 minutes. */
const CONVERT: LongCallOptions = { checkAfterMs: 10_000, pollMs: 2_000 };
/** Binding the endpoint and finding a relay take a few seconds at most. */
const NETWORK: ShortCallOptions = { timeoutMs: 20_000, retry: true };
/** Importing large files by reference and waiting for a relay address. */
const OFFER: LongCallOptions = { checkAfterMs: 8_000, pollMs: 2_000 };

const ipc = reliableIpc;

export const api = {
  /** `name`: the sender's file name ("Open with" / share), used as the title. */
  importDocument: (source: string, name: string | null = null) =>
    unwrap(ipc().long("import_document", (requestId) => commands.importDocument(requestId, source, name), IMPORT)),
  pickPdf: () => unwrap(ipc().long("pick_pdf", (requestId) => commands.pickPdf(requestId), PICK)),
  listDocuments: (query: LibraryQuery) =>
    unwrap(ipc().short("list_documents", () => commands.listDocuments(query), READ)),
  // Sets (never toggles) the flag, so a retry is harmless.
  setFavorite: (id: string, favorite: boolean) =>
    unwrap(ipc().short("set_favorite", () => commands.setFavorite(id, favorite), READ)),
  // Sets the title (never appends): safe to repeat.
  renameDocument: (id: string, title: string) =>
    unwrap(ipc().short("rename_document", () => commands.renameDocument(id, title), READ)),
  // A repeat after a lost reply answers notFound, which callers treat as done.
  deleteDocument: (id: string) => unwrap(ipc().short("delete_document", () => commands.deleteDocument(id), READ)),
  // Removes what is there to remove: a repeat removes nothing.
  deleteEarlierVersions: (id: string) =>
    unwrap(ipc().short("delete_earlier_versions", () => commands.deleteEarlierVersions(id), READ)),
  // Sets the position (never increments): safe to repeat.
  setLastPage: (id: string, page: number) =>
    unwrap(ipc().short("set_last_page", () => commands.setLastPage(id, page), READ)),
  documentFile: (id: string) => unwrap(ipc().short("document_file", () => commands.documentFile(id), READ)),
  // Idempotent per document (same bytes, same file).
  saveThumbnail: (id: string, image: Uint8Array) =>
    unwrap(ipc().short("save_thumbnail", () => commands.saveThumbnail(id, Array.from(image)), READ)),
  listTags: () => unwrap(ipc().short("list_tags", () => commands.listTags(), READ)),
  // Returns the existing tag for the same name: safe to repeat.
  createTag: (name: string) => unwrap(ipc().short("create_tag", () => commands.createTag(name), READ)),
  renameTag: (id: string, name: string) => unwrap(ipc().short("rename_tag", () => commands.renameTag(id, name), WRITE)),
  deleteTag: (id: string) => unwrap(ipc().short("delete_tag", () => commands.deleteTag(id), READ)),
  // Replaces the whole set: safe to repeat.
  setDocumentTags: (documentId: string, tagIds: string[]) =>
    unwrap(ipc().short("set_document_tags", () => commands.setDocumentTags(documentId, tagIds), READ)),
  // Opens a share sheet: never repeated automatically (it would open twice).
  shareDocument: (id: string) => unwrap(ipc().short("share_document", () => commands.shareDocument(id), WRITE)),
  pendingOpens: () => unwrap(ipc().short("pending_opens", () => commands.pendingOpens(), READ)),
  dismissOpen: (id: string) => unwrap(ipc().short("dismiss_open", () => commands.dismissOpen(id), READ)),
  // Also stamps "last opened", which is safe to repeat.
  readDocument: (id: string) => unwrap(ipc().short("read_document", () => commands.readDocument(id), READ)),
  recordDocumentInfo: (id: string, pageCount: number, pdfTitle: string | null) =>
    unwrap(
      ipc().short("record_document_info", () => commands.recordDocumentInfo(id, pageCount, pdfTitle), WRITE),
    ),
  getSettings: () => unwrap(ipc().short("get_settings", () => commands.getSettings(), READ)),
  updateSettings: (patch: Parameters<typeof commands.updateSettings>[0]) =>
    unwrap(ipc().short("update_settings", () => commands.updateSettings(patch), WRITE)),
  deviceMemory: () => unwrap(ipc().short("device_memory", () => commands.deviceMemory(), READ)),
  // Writes at an offset; a chunk already there is not written again.
  uploadChunk: (uploadId: string, offset: number, data: string) =>
    unwrap(ipc().short("upload_chunk", () => commands.uploadChunk(uploadId, offset, data), UPLOAD)),
  abortUpload: (uploadId: string) => unwrap(ipc().short("abort_upload", () => commands.abortUpload(uploadId), READ)),
  // A repeat after a lost reply answers with the same working copy.
  commitWorkingCopy: (uploadId: string, documentId: string, baseBlake3: string, sizeBytes: number) =>
    unwrap(
      ipc().short(
        "commit_working_copy",
        () => commands.commitWorkingCopy(uploadId, documentId, baseBlake3, sizeBytes),
        READ,
      ),
    ),
  workingCopy: (documentId: string) => unwrap(ipc().short("working_copy", () => commands.workingCopy(documentId), READ)),
  discardWorkingCopy: (documentId: string) =>
    unwrap(ipc().short("discard_working_copy", () => commands.discardWorkingCopy(documentId), READ)),
  /** `note`: what an erase or a redaction did besides the page content (ADR 0033 amendment). */
  saveVersion: (documentId: string, label: VersionLabel, note: string | null = null) =>
    unwrap(ipc().long("save_version", (requestId) => commands.saveVersion(requestId, documentId, label, note), SAVE)),
  importUpload: (uploadId: string, title: string) =>
    unwrap(ipc().long("import_upload", (requestId) => commands.importUpload(requestId, uploadId, title), IMPORT)),
  stagePdf: (source: string) => unwrap(ipc().long("stage_pdf", (requestId) => commands.stagePdf(requestId, source), IMPORT)),
  unstage: (path: string) => unwrap(ipc().short("unstage", () => commands.unstage(path), READ)),
  // Images → PDF and page export (P4b, ADR 0017).
  pickPhotos: (max = 50) => unwrap(ipc().long("pick_photos", (requestId) => commands.pickPhotos(requestId, max), PICK)),
  stagePhoto: (source: string) => unwrap(ipc().long("stage_photo", (requestId) => commands.stagePhoto(requestId, source), IMPORT)),
  shareExport: (uploadId: string, name: string, mime: string) =>
    unwrap(ipc().long("share_export", (requestId) => commands.shareExport(requestId, uploadId, name, mime), PICK)),
  // File conversion (P7c, ADR 0035): printing HTML to PDF is Android-only for now.
  convertAvailable: () => unwrap(ipc().short("convert_available", () => commands.convertAvailable(), READ)),
  pickDocument: () => unwrap(ipc().long("pick_document", (requestId) => commands.pickDocument(requestId), PICK)),
  stageSource: (source: string) => unwrap(ipc().long("stage_source", (requestId) => commands.stageSource(requestId, source), IMPORT)),
  convertHtmlToPdf: (uploadId: string, widthPt: number, heightPt: number) =>
    unwrap(ipc().long("convert_html_to_pdf", (requestId) => commands.convertHtmlToPdf(requestId, uploadId, widthPt, heightPt), CONVERT)),
  importStaged: (path: string, title: string) =>
    unwrap(ipc().long("import_staged", (requestId) => commands.importStaged(requestId, path, title), IMPORT)),
  // Document scan (P4c, ADR 0016): Android only; the UI offers it there.
  openAppSettings: () => unwrap(ipc().short("open_app_settings", () => commands.openAppSettings(), READ)),
  scanHaptic: () => unwrap(ipc().short("scan_haptic", () => commands.scanHaptic(), READ)),
  listSignatures: () => unwrap(ipc().short("list_signatures", () => commands.listSignatures(), READ)),
  // Keyed by the UI-chosen id: a repeat returns the stored signature.
  saveSignature: (id: string, kind: SignatureKind, pngBase64: string) =>
    unwrap(ipc().short("save_signature", () => commands.saveSignature(id, kind, pngBase64), READ)),
  deleteSignature: (id: string) => unwrap(ipc().short("delete_signature", () => commands.deleteSignature(id), READ)),
  pickImage: () => unwrap(ipc().long("pick_image", (requestId) => commands.pickImage(requestId), PICK)),

  // Transfer (commands/transfer.rs). Opening is idempotent (the open endpoint is returned).
  transferOpen: () => unwrap(ipc().short("transfer_open", () => commands.transferOpen(), NETWORK)),
  // Closing twice is harmless; `false`: something still runs, it closes when that ends.
  transferClose: (force = false) => unwrap(ipc().short("transfer_close", () => commands.transferClose(force), READ)),
  transferOffer: (documentIds: string[], includeHistory: boolean) =>
    unwrap(
      ipc().long(
        "transfer_offer",
        (requestId) => commands.transferOffer(requestId, documentIds, includeHistory),
        OFFER,
      ),
    ),
  transferSendStatus: (sessionId: string) =>
    unwrap(ipc().short("transfer_send_status", () => commands.transferSendStatus(sessionId), READ)),
  // The answer is taken once; a repeat finds nothing to confirm (invalidArgument).
  transferDecide: (sessionId: string, confirm: boolean) =>
    unwrap(ipc().short("transfer_decide", () => commands.transferDecide(sessionId, confirm), WRITE)),
  transferCancelSend: (sessionId: string) =>
    unwrap(ipc().short("transfer_cancel_send", () => commands.transferCancelSend(sessionId), READ)),
  // The same link again joins the same receive.
  transferReceive: (link: string) =>
    unwrap(ipc().long("transfer_receive", (requestId) => commands.transferReceive(requestId, link), IMPORT)),
  transferReceiveStatus: (id: string) =>
    unwrap(ipc().short("transfer_receive_status", () => commands.transferReceiveStatus(id), READ)),
  transferCancelReceive: (id: string) =>
    unwrap(ipc().short("transfer_cancel_receive", () => commands.transferCancelReceive(id), READ)),
  /** Who a transfer link comes from (shown before a receive starts). */
  transferTicketSender: (link: string) =>
    unwrap(ipc().short("transfer_ticket_sender", () => commands.transferTicketSender(link), READ)),
  transferResumable: () => unwrap(ipc().short("transfer_resumable", () => commands.transferResumable(), READ)),
  // A running receive is left alone: safe to repeat.
  transferResume: (id: string) => unwrap(ipc().short("transfer_resume", () => commands.transferResume(id), READ)),
  transferPause: () => unwrap(ipc().short("transfer_pause", () => commands.transferPause(), READ)),
  transferForeground: (channel: string, title: string, text: string, progressKib: number, maxKib: number, upload: boolean) =>
    unwrap(
      ipc().short(
        "transfer_foreground",
        () => commands.transferForeground(channel, title, text, progressKib, maxKib, upload),
        READ,
      ),
    ),
  transferForegroundStop: () =>
    unwrap(ipc().short("transfer_foreground_stop", () => commands.transferForegroundStop(), READ)),
  transferNotifications: () =>
    unwrap(ipc().short("transfer_notifications", () => commands.transferNotifications(), { timeoutMs: 120_000, retry: false })),
  transferDebugForceRelay: (on: boolean) =>
    unwrap(ipc().short("transfer_debug_force_relay", () => commands.transferDebugForceRelay(on), READ)),
  // Trusted devices and library move (P3b).
  transferReceiving: (on: boolean) =>
    unwrap(ipc().short("transfer_receiving", () => commands.transferReceiving(on), READ)),
  transferIncoming: () => unwrap(ipc().short("transfer_incoming", () => commands.transferIncoming(), WRITE)),
  transferTrusted: () => unwrap(ipc().short("transfer_trusted", () => commands.transferTrusted(), READ)),
  // Saving again renames: safe to repeat.
  transferTrust: (endpointId: string, name: string) =>
    unwrap(ipc().short("transfer_trust", () => commands.transferTrust(endpointId, name), READ)),
  transferUntrust: (endpointId: string) =>
    unwrap(ipc().short("transfer_untrust", () => commands.transferUntrust(endpointId), READ)),
  transferPing: (endpointId: string) =>
    unwrap(ipc().short("transfer_ping", () => commands.transferPing(endpointId), NETWORK)),
  transferPush: (endpointId: string, documentIds: string[], includeHistory: boolean) =>
    unwrap(
      ipc().long(
        "transfer_push",
        (requestId) => commands.transferPush(requestId, endpointId, documentIds, includeHistory),
        OFFER,
      ),
    ),
  transferMoveSummary: () =>
    unwrap(ipc().short("transfer_move_summary", () => commands.transferMoveSummary(), READ)),
  transferMoveOffer: () =>
    unwrap(ipc().long("transfer_move_offer", (requestId) => commands.transferMoveOffer(requestId), OFFER)),
  transferMovePush: (endpointId: string) =>
    unwrap(
      ipc().long("transfer_move_push", (requestId) => commands.transferMovePush(requestId, endpointId), OFFER),
    ),
  // .selispack (P3c). Export and import may take a while (Argon2id, large libraries).
  packKind: (source: string) => unwrap(ipc().short("pack_kind", () => commands.packKind(source), READ)),
  packExport: (documentIds: string[] | null, includeHistory: boolean, passphrase: string | null) =>
    unwrap(
      ipc().long(
        "pack_export",
        (requestId) => commands.packExport(requestId, documentIds, includeHistory, passphrase),
        SAVE,
      ),
    ),
  packImport: (source: string, passphrase: string | null) =>
    unwrap(ipc().long("pack_import", (requestId) => commands.packImport(requestId, source, passphrase), SAVE)),
  pickPack: () => unwrap(ipc().long("pick_pack", (requestId) => commands.pickPack(requestId), PICK)),
  // Tools (P4a, ADR 0015): qpdf on the current version; a result becomes the next version.
  documentProtection: (id: string) =>
    unwrap(ipc().short("document_protection", () => commands.documentProtection(id), READ)),
  runTool: (id: string, request: ToolRequest) =>
    unwrap(ipc().long("run_tool", (requestId) => commands.runTool(requestId, id, request), SAVE)),
  pendingTransferLink: () => unwrap(ipc().short("pending_transfer_link", () => commands.pendingTransferLink(), READ)),
  dismissTransferLink: (link: string) =>
    unwrap(ipc().short("dismiss_transfer_link", () => commands.dismissTransferLink(link), READ)),
};

/** i18n key for a user-facing error message. */
export function errorMessageKey(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "notPdf":
        return "errors.notPdf";
      case "emptyFile":
        return "errors.emptyFile";
      case "io":
        return "errors.io";
      case "notFound":
        return "errors.notFound";
      case "timeout":
        return "errors.importTimeout";
      case "conflict":
        return "errors.conflict";
      case "unsupported":
        return "errors.unsupported";
      case "invalidArgument":
      case "internal":
        return "errors.generic";
    }
  }
  return "errors.generic";
}

export { IpcTimeoutError, LostResponseError } from "./ipc";
export type {
  DeleteReport,
  Document,
  DocumentFile,
  ForeignSettings,
  ImportOutcome,
  LibraryFilter,
  LibraryQuery,
  LibrarySort,
  LibraryView,
  LocalePref,
  IncomingView,
  LibrarySummary,
  OfferView,
  PackExportView,
  ProtectionView,
  ToolOutcome,
  ToolProblem,
  ToolRequest,
  ToolUnchanged,
  PackImportView,
  PackKind,
  PackProblem,
  PackSummary,
  PendingOpen,
  PhotoPick,
  PingView,
  ReceiveView,
  ResumableView,
  RouteView,
  SendView,
  TicketSender,
  TransferErrorCode,
  TransferInfo,
  TrustedDevice,
  PickedImage,
  SavedVersion,
  Settings,
  SettingsPatch,
  Signature,
  SignatureKind,
  Tag,
  ThemePref,
  VersionLabel,
  WorkingCopy,
} from "./ipc";
