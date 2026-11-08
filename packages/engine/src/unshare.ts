/**
 * Copy-on-write for the XObjects an area meets (ADR 0033, ADR 0009 amendment).
 * PDFium changes image data and form content in place when it erases or
 * redacts (measured: a logo drawn on three pages lost its pixels on all three),
 * so before that every image or form XObject drawn over the area gets its own
 * copy under a new name: the `Do` operand is rewritten, the page and the copied
 * forms get resource dictionaries of their own. Other pages and other draws of
 * the same object keep the original.
 *
 * Also the shared plumbing of the content-stream rewrites (erase.ts): reading a
 * page's content, the XObjects it draws and where they land, writing streams.
 */
import { apply, IDENTITY, type Matrix, multiply, operations, splice, walk } from "./content-stream";
import { type Box, boxesMeet } from "./path-clip";
import { bytesToLatin1, decodeStream, deflate, latin1ToBytes, nameOf, type PdfDict, PdfDocumentObjects, type PdfObj, UncheckedContentError } from "./pdf-objects";

/** A content stream that cannot be read or rewritten. */
export class ContentRewriteError extends UncheckedContentError {
  override readonly name = "ContentRewriteError";
}

/** Thrown for a form XObject under the area that cannot be decoded: what it draws there cannot be removed. */
export const UNDECODABLE_FORM = "a form under the area uses an encoding that cannot be rewritten";

/** Keys of an XObject copy that would carry the original's content past the redaction (alternate renditions, private data). */
const RENDITION_KEYS = ["Alternates", "OPI", "PieceInfo", "Thumb"] as const;

export type Stream = Extract<PdfObj, { t: "stream" }>;
/** One rewrite over a parsed document: the area (page space) and the streams written so far. */
export type Ctx = {
  readonly doc: PdfDocumentObjects;
  readonly boxes: readonly Box[];
  readonly changed: Set<Stream>;
  /** The data of every XObject un-shared so far (its unredacted original). */
  readonly originals?: Uint8Array[];
};

export const num = (o: PdfObj | undefined): number | null => (o?.t === "num" ? Number(o.v) : null);

function matrixOf(doc: PdfDocumentObjects, o: PdfObj | undefined): Matrix {
  const arr = doc.array(o)?.map((x) => num(doc.get(x)));
  return arr && arr.length === 6 && arr.every((x) => x !== null) ? (arr as unknown as Matrix) : IDENTITY;
}

/** The page-space bounding box of a unit square or form BBox drawn with `m`. */
function drawnBox(corners: readonly [number, number, number, number], m: Matrix): Box {
  const [x0, y0, x1, y1] = corners;
  const pts = [apply(m, { x: x0, y: y0 }), apply(m, { x: x1, y: y0 }), apply(m, { x: x0, y: y1 }), apply(m, { x: x1, y: y1 })];
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

export type XObject = { readonly stream: Stream; readonly form: boolean; readonly box: Box; readonly matrix: Matrix };

/** The image or form XObject `name` and where it lands in page space, or null. */
export function xobject(ctx: Ctx, resources: PdfDict, name: string, ctm: Matrix): XObject | null {
  const target = ctx.doc.get(ctx.doc.dict(resources.get("XObject"))?.get(name));
  if (target.t !== "stream") return null;
  const subtype = nameOf(target.dict.get("Subtype"));
  if (subtype === "Image") return { stream: target, form: false, box: drawnBox([0, 0, 1, 1], ctm), matrix: ctm };
  if (subtype !== "Form") return null;
  const bbox = ctx.doc.array(target.dict.get("BBox"))?.map((x) => num(ctx.doc.get(x)) ?? 0);
  const matrix = multiply(matrixOf(ctx.doc, target.dict.get("Matrix")), ctm);
  const corners: [number, number, number, number] =
    bbox && bbox.length === 4 ? [bbox[0] ?? 0, bbox[1] ?? 0, bbox[2] ?? 0, bbox[3] ?? 0] : [-1e9, -1e9, 1e9, 1e9];
  return { stream: target, form: true, box: drawnBox(corners, matrix), matrix };
}

/** A resource dictionary of one's own: the dict copied, its XObject subdictionary too. */
export function ownResources(doc: PdfDocumentObjects, resources: PdfDict | null): PdfDict {
  const copy: PdfDict = new Map(resources ?? []);
  const xobjects = doc.dict(copy.get("XObject"));
  copy.set("XObject", { t: "dict", v: new Map(xobjects ?? []) });
  return copy;
}

/** A page's content streams, decoded and joined. */
export async function contentOf(doc: PdfDocumentObjects, contents: PdfObj | undefined): Promise<string> {
  const target = doc.get(contents);
  const parts = target.t === "arr" ? target.v.map((x) => doc.get(x)) : [target];
  const out: string[] = [];
  for (const part of parts) {
    if (part.t !== "stream") continue;
    const data = await decodeStream(part);
    if (!data) throw new ContentRewriteError("a content stream uses an encoding that cannot be rewritten");
    out.push(bytesToLatin1(data));
  }
  return out.join("\n");
}

export function setStreamText(ctx: Ctx, stream: Stream, text: string): void {
  stream.data = latin1ToBytes(text);
  stream.dict.delete("Filter");
  stream.dict.delete("DecodeParms");
  stream.dict.delete("DP");
  stream.dict.delete("DL");
  ctx.changed.add(stream);
}

export function writeContents(ctx: Ctx, page: PdfDict, text: string): void {
  const stream: Stream = { t: "stream", dict: new Map(), data: new Uint8Array() };
  setStreamText(ctx, stream, text);
  page.set("Contents", ctx.doc.add(stream));
}

/** Compresses every stream written in this pass and writes the file anew. */
export async function finish(ctx: Ctx): Promise<Uint8Array> {
  for (const s of ctx.changed) {
    s.data = await deflate(s.data);
    s.dict.set("Filter", { t: "name", v: "FlateDecode" });
  }
  return ctx.doc.write();
}

/** A name not yet in `dict`: SelisE1, SelisE2, … (an earlier erase may have used some). */
function freshName(dict: PdfDict): string {
  for (let i = 1; ; i++) if (!dict.has(`SelisE${i}`)) return `SelisE${i}`;
}

/**
 * Gives every XObject drawn in `text` that meets the area a copy of its own
 * under a new name (recursively inside forms). Returns the new content, or
 * null when nothing was renamed.
 */
async function unshareContent(ctx: Ctx, text: string, resources: PdfDict, base: Matrix): Promise<string | null> {
  const draws: { name: string; ctm: Matrix; start: number; end: number }[] = [];
  walk(operations(text), base, { onDo: (e) => draws.push({ name: e.name, ctm: e.ctm, start: e.nameStart, end: e.nameEnd }) });
  const xobjects = ctx.doc.dict(resources.get("XObject"));
  const edits: { start: number; end: number; text: string }[] = [];
  for (const draw of draws) {
    const x = xobject(ctx, resources, draw.name, draw.ctm);
    if (!x || !xobjects || !ctx.boxes.some((b) => boxesMeet(x.box, b))) continue;
    const copy: Stream = { t: "stream", dict: new Map(x.stream.dict), data: x.stream.data };
    for (const k of RENDITION_KEYS) copy.dict.delete(k);
    if (x.form) {
      const own = ownResources(ctx.doc, ctx.doc.dict(x.stream.dict.get("Resources")) ?? resources);
      copy.dict.set("Resources", { t: "dict", v: own });
      // Fail closed: what an undecodable form draws under the area could not be cut (ADR 0009 / 0033).
      const inner = await decodeStream(x.stream);
      if (!inner) throw new ContentRewriteError(UNDECODABLE_FORM);
      const renamed = await unshareContent(ctx, bytesToLatin1(inner), own, x.matrix);
      if (renamed !== null) setStreamText(ctx, copy, renamed);
    }
    ctx.originals?.push(x.stream.data);
    const name = freshName(xobjects);
    xobjects.set(name, ctx.doc.add(copy));
    edits.push({ start: draw.start, end: draw.end, text: `/${name}` });
  }
  return edits.length > 0 ? splice(text, edits) : null;
}

/** Un-shares what page `index` draws over `boxes` (page space) in a parsed document. */
export async function unsharePage(ctx: Ctx, index: number): Promise<void> {
  const page = ctx.doc.pages()[index];
  if (!page) throw new ContentRewriteError(`no page ${index + 1}`);
  const resources = ownResources(ctx.doc, page.resources);
  page.dict.set("Resources", { t: "dict", v: resources });
  const renamed = await unshareContent(ctx, await contentOf(ctx.doc, page.dict.get("Contents")), resources, IDENTITY);
  if (renamed !== null) writeContents(ctx, page.dict, renamed);
}

/**
 * Un-shares, page by page, what each page draws over its area (page space
 * boxes) and returns the file written anew (the bytes unchanged when no area
 * meets an XObject), with the data of each original that got a copy: the
 * final rewrite checks that none of them is left where nothing draws it.
 */
export async function unsharePages(bytes: Uint8Array, areas: ReadonlyMap<number, readonly Box[]>): Promise<{ bytes: Uint8Array; originals: Uint8Array[] }> {
  const doc = await PdfDocumentObjects.parse(bytes);
  let touched = false;
  const changed = new Set<Stream>();
  const originals: Uint8Array[] = [];
  for (const [index, boxes] of areas) {
    if (boxes.length === 0) continue;
    const ctx: Ctx = { doc, boxes, changed, originals };
    const page = doc.pages()[index];
    if (!page) throw new ContentRewriteError(`no page ${index + 1}`);
    const resources = ownResources(doc, page.resources);
    const renamed = await unshareContent(ctx, await contentOf(doc, page.dict.get("Contents")), resources, IDENTITY);
    if (renamed === null) continue;
    page.dict.set("Resources", { t: "dict", v: resources });
    writeContents(ctx, page.dict, renamed);
    touched = true;
  }
  return { bytes: touched ? await finish({ doc, boxes: [], changed }) : bytes, originals };
}
