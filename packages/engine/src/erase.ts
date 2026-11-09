/**
 * Erasing page content (P7b, ADR 0033), worker side. Everything drawn inside
 * the area leaves the file, through the redaction path of ADR 0009, and the
 * area is painted with a fill colour (no box, no annotation):
 *
 * 1. Un-share: every image or form XObject drawn on the page that meets the
 *    area gets its own copy under a new name. PDFium blanks image pixels and
 *    rewrites forms in place (measured: a shared image lost its pixels on the
 *    other page too), so the copies keep the rest of the document as it was.
 * 2. PDFium (`EPDFText_RedactInQuads`, forms included): the glyphs under the
 *    area leave the text objects and the image pixels under it are blanked in
 *    the image data itself.
 * 3. Paths: PDFium leaves vector paths whole, so each path that meets the area
 *    is cut geometrically (path-clip.ts) in the content stream, page and forms.
 *    The fill is painted last, over the area.
 * 4. The file is written anew with only the objects still reachable (pdf-objects.ts),
 *    so the old content streams and image data do not survive.
 *
 * Runs on scratch copies and returns new bytes; the worker swaps the open
 * document for them. A document with an owner password is written without it,
 * as for redaction (its streams must be readable to be rewritten).
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import type { EmbeddedText } from "./annotations";
import { type AnnotationChanges, clearAnnotations } from "./area-annotations";
import {
  ContentSyntaxError,
  fmt,
  IDENTITY,
  invert,
  mapSubpaths,
  type Matrix,
  maxScale,
  operations,
  type PaintEvent,
  pathText,
  splice,
  walk,
} from "./content-stream";
import type { PageRect } from "./geometry";
import { type Box, boxesMeet, clipFill, clipStroke, pathMeets, shrinkBoxes, type Subpath } from "./path-clip";
import { flattenPage, type Rasterizer } from "./flatten";
import { bytesToLatin1, decodeStream, type PdfDict, PdfDocumentObjects } from "./pdf-objects";
import { detachRemovedAnnotations, pruneUnusedXObjects } from "./residue";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { documentPointer, removePageObject, toUserSpace } from "./pdfium-objects";
import type { EraseArea, PageObjectInfo } from "./types";
import { pruneOrphanFields } from "./sanitize";
import {
  ContentRewriteError,
  contentOf,
  type Ctx,
  finish,
  num,
  ownResources,
  setStreamText,
  type Stream,
  UNDECODABLE_FORM,
  unsharePages,
  writeContents,
  type XObject,
  xobject,
} from "./unshare";

export class EraseError extends Error {
  override readonly name = "EraseError";
}

let scratchId = 0;

async function withScratch<T>(engine: PdfiumNative, bytes: ArrayBuffer, use: (doc: PdfDocumentObject) => Promise<T>): Promise<T> {
  const doc = await engine.openDocumentBuffer({ id: `erase-${scratchId++}`, content: bytes.slice(0) }).toPromise();
  try {
    return await use(doc);
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);
const CLOSES = new Set(["s", "b", "b*"]);

/** The operators that replace one painted path, or null to keep it as it is. */
function cutPath(e: PaintEvent, boxes: readonly Box[]): string | null {
  const fills = FILLS.has(e.op);
  const strokes = STROKES.has(e.op);
  if (!fills && !strokes) return null;
  const inverse = invert(e.ctm);
  if (!inverse) return null;
  const user: Subpath[] = CLOSES.has(e.op) ? e.subpaths.map((sp) => ({ ...sp, closed: true })) : [...e.subpaths];
  const page = mapSubpaths(user, e.ctm);
  // A stroke keeps its centre line within half its width of the area's edge, so the
  // outside renders as before; the fill covers that part.
  const strokeBoxes = shrinkBoxes(boxes, (e.lineWidth * maxScale(e.ctm)) / 2);
  const cutFill = fills && pathMeets(page, boxes);
  const cutStroke = strokes && pathMeets(page, strokeBoxes);
  if (!cutFill && !cutStroke) return null;
  const parts: string[] = [];
  if (fills) {
    const kept = cutFill ? mapSubpaths(clipFill(page, boxes), inverse) : user;
    if (kept.length > 0) parts.push(`${pathText(kept)}\n${e.op.endsWith("*") ? "f*" : "f"}`);
  }
  if (strokes) {
    const kept = cutStroke ? mapSubpaths(clipStroke(page, strokeBoxes), inverse) : user;
    if (kept.length > 0) parts.push(`${pathText(kept)}\nS`);
  }
  // A clip set with this path still clips with the whole path (it hides, it draws nothing).
  if (e.clip) parts.push(`${pathText(e.subpaths)}\n${e.clip} n`);
  return parts.join("\n");
}

function lineWidthOf(doc: PdfDocumentObjects, resources: PdfDict, name: string): number | undefined {
  const gs = doc.dict(doc.dict(resources.get("ExtGState"))?.get(name));
  return num(doc.get(gs?.get("LW"))) ?? undefined;
}

/** Pass 3: cuts the paths that meet the area, in the content and the forms it draws. */
async function cutContent(ctx: Ctx, text: string, resources: PdfDict, base: Matrix): Promise<{ text: string | null; paths: number }> {
  const edits: { start: number; end: number; text: string }[] = [];
  const forms: XObject[] = [];
  walk(operations(text), base, {
    lineWidthOf: (name) => lineWidthOf(ctx.doc, resources, name),
    onPaint: (e) => {
      const replacement = cutPath(e, ctx.boxes);
      if (replacement !== null) edits.push({ start: e.start, end: e.end, text: replacement });
    },
    onDo: (e) => {
      const x = xobject(ctx, resources, e.name, e.ctm);
      if (x?.form && ctx.boxes.some((b) => boxesMeet(x.box, b))) forms.push(x);
    },
  });
  let paths = edits.length;
  for (const form of forms) {
    const inner = await decodeStream(form.stream);
    if (!inner) throw new ContentRewriteError(UNDECODABLE_FORM);
    const own = ctx.doc.dict(form.stream.dict.get("Resources")) ?? resources;
    const cut = await cutContent(ctx, bytesToLatin1(inner), own, form.matrix);
    if (cut.text !== null) setStreamText(ctx, form.stream, cut.text);
    paths += cut.paths;
  }
  return { text: edits.length > 0 ? splice(text, edits) : null, paths };
}

/** #rrggbb as PDF RGB components (0–1). */
export function rgbOf(hex: string): [number, number, number] {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new EraseError(`not a colour: ${hex}`);
  return [1, 2, 3].map((k) => Number.parseInt(m[k] as string, 16) / 255) as [number, number, number];
}

/** A page's MediaBox (inherited from the page tree if need be), or US Letter. */
function mediaBox(doc: PdfDocumentObjects, page: PdfDict): Box {
  let node: PdfDict | null = page;
  for (let depth = 0; node && depth < 32; depth++) {
    const box = doc.array(node.get("MediaBox"))?.map((x) => num(doc.get(x)) ?? 0);
    if (box && box.length === 4) {
      const [a, b, c, d] = box as [number, number, number, number];
      return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
    }
    node = doc.dict(node.get("Parent"));
  }
  return { x0: 0, y0: 0, x1: 612, y1: 792 };
}

/** Viewer rects (points, top-left origin, /Rotate applied) as PDF user-space boxes. */
export function userBoxes(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, rects: readonly PageRect[]): Box[] {
  return rects.map((rect) => {
    const a = toUserSpace(engine, doc, page, { x: rect.x, y: rect.y });
    const c = toUserSpace(engine, doc, page, { x: rect.x + rect.width, y: rect.y + rect.height });
    return { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) };
  });
}

/** What one page loses: the boxes (user space) and the colour painted over each. */
export type PageArea = { readonly boxes: readonly Box[]; readonly fills: readonly (readonly [number, number, number])[] };

/** Comment before the boxes painted over the areas (a test takes them away to look under them). */
export const FILL_MARK = "%SelisFill";

function rewriteError(err: unknown): unknown {
  if (err instanceof ContentSyntaxError) return new EraseError(`cannot read the page content: ${err.message}`);
  // UncheckedContentError (ContentRewriteError included) is kept as it is: the UI says the content could not be checked.
  return err;
}

/** Page keys that hold another rendition of the page or private application data (a pre-redaction copy). */
const PAGE_RENDITION_KEYS = ["Thumb", "PieceInfo"] as const;

/**
 * Steps 3–4 on the bytes PDFium wrote: per page, flattens what cannot be cut
 * (redaction only), cuts the paths, paints each box last, drops the page's
 * thumbnail and private data; then drops form fields left without a widget,
 * links to the annotations removed, XObject names nothing draws, and writes
 * the file anew. Refuses when an un-shared original (`originals`) is still
 * reachable without anything drawing it (residue.ts).
 */
export async function rewritePages(
  bytes: Uint8Array,
  areas: ReadonlyMap<number, PageArea>,
  flatten: Rasterizer | null,
  originals: readonly Uint8Array[] = [],
): Promise<{ bytes: Uint8Array; paths: number; flattened: number }> {
  try {
    const doc = await PdfDocumentObjects.parse(bytes);
    const changed = new Set<Stream>();
    const pages = doc.pages();
    let paths = 0;
    let flattened = 0;
    for (const [index, area] of areas) {
      const page = pages[index];
      if (!page) throw new EraseError(`no page ${index + 1}`);
      const ctx: Ctx = { doc, boxes: area.boxes, changed };
      const resources = ownResources(doc, page.resources);
      page.dict.set("Resources", { t: "dict", v: resources });
      let content = await contentOf(doc, page.dict.get("Contents"));
      if (flatten) {
        const flat = await flattenPage(ctx, page.dict, index, content, resources, mediaBox(doc, page.dict), flatten);
        if (flat.text !== null) content = flat.text;
        flattened += flat.flattened;
      }
      const cut = await cutContent(ctx, content, resources, IDENTITY);
      paths += cut.paths;
      const fills = area.boxes.map((box, k) => {
        const [r, g, b] = area.fills[k] ?? [1, 1, 1];
        return `q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(box.x0)} ${fmt(box.y0)} ${fmt(box.x1 - box.x0)} ${fmt(box.y1 - box.y0)} re f Q`;
      });
      writeContents(ctx, page.dict, `q\n${cut.text ?? content}\nQ\n${FILL_MARK}\n${fills.join("\n")}\n`);
      for (const k of PAGE_RENDITION_KEYS) page.dict.delete(k);
    }
    pruneOrphanFields(doc);
    detachRemovedAnnotations(doc);
    await pruneUnusedXObjects(doc, originals);
    return { bytes: await finish({ doc, boxes: [], changed }), paths, flattened };
  } catch (err) {
    throw rewriteError(err);
  }
}

/**
 * Erases `area` from the document `current` and returns the new bytes: the
 * text, image pixels and paths under it are gone, annotations over it are
 * clipped or removed, and the area is filled.
 */
export async function eraseArea(
  engine: PdfiumNative,
  text: EmbeddedText,
  current: ArrayBuffer,
  area: EraseArea,
): Promise<{ bytes: ArrayBuffer; paths: number; ownerPassword: boolean; annotations: AnnotationChanges }> {
  const rects = area.rects.filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) throw new EraseError("nothing to erase");
  const fill = rgbOf(area.fill);
  let ownerPassword = false;
  let boxes: Box[] = [];
  const plain = await withScratch(engine, current, async (doc) => {
    const page = doc.pages[area.page];
    if (!page) throw new EraseError(`no page ${area.page + 1}`);
    boxes = userBoxes(engine, doc, page, rects);
    ownerPassword = text.isEncrypted(doc);
    if (ownerPassword) text.removeEncryption(doc);
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });

  // 1. Un-share what the page draws over the area.
  let unshared: Uint8Array;
  let originals: Uint8Array[];
  try {
    ({ bytes: unshared, originals } = await unsharePages(new Uint8Array(plain), new Map([[area.page, boxes]])));
  } catch (err) {
    throw rewriteError(err);
  }

  // 2. PDFium: annotations over the area, glyphs and image pixels.
  let annotations: AnnotationChanges = { removed: 0, clipped: 0 };
  const redacted = await withScratch(engine, unshared.slice().buffer, async (doc) => {
    const page = doc.pages[area.page];
    if (!page) throw new EraseError(`no page ${area.page + 1}`);
    annotations = await clearAnnotations(engine, doc, page, rects);
    const quads = rects.map((rect) => ({ origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }));
    // False when there was nothing to remove: the paths and the fill still apply.
    await engine.redactTextInRects(doc, page, quads, { recurseForms: true, drawBlackBoxes: false }).toPromise();
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });

  // 3. Paths, then the fill on top; 4. a fresh file.
  const out = await rewritePages(new Uint8Array(redacted), new Map([[area.page, { boxes, fills: boxes.map(() => fill) }]]), null, originals);
  return { bytes: out.bytes.slice().buffer, paths: out.paths, ownerPassword, annotations };
}

/**
 * Removes one top-level object (text, path, image, shading or form) from page
 * `pageIndex` and writes the file anew, so the old content stream (and an
 * image or form nothing else draws) do not survive. Throws when the page no
 * longer has the object where the user picked it.
 */
export async function deletePageObject(
  engine: PdfiumNative,
  pdf: WrappedPdfiumModule,
  text: EmbeddedText,
  current: ArrayBuffer,
  pageIndex: number,
  object: PageObjectInfo,
): Promise<ArrayBuffer> {
  const removed = await withScratch(engine, current, async (doc) => {
    const page = doc.pages[pageIndex];
    const ptr = documentPointer(engine, doc.id);
    if (!page || ptr === null) throw new EraseError(`no page ${pageIndex + 1}`);
    if (text.isEncrypted(doc)) text.removeEncryption(doc);
    if (!removePageObject(engine, pdf, ptr, doc, page, object)) throw new EraseError("the object is no longer on the page");
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });
  return (await PdfDocumentObjects.parse(new Uint8Array(removed))).write().slice().buffer;
}

/**
 * The median colour (per channel) of the pixels within `ring` points around the
 * rects but outside them, from an RGBA raster of the page at `scale`; white when
 * there are none. Zero-size rects sample the spot itself (the eyedropper).
 */
export function ringColor(data: Uint8Array | Uint8ClampedArray, width: number, height: number, scale: number, rects: readonly PageRect[], ring = 4): string {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
  let count = 0;
  const grown = rects.map((r) => ({ x0: r.x - ring, y0: r.y - ring, x1: r.x + r.width + ring, y1: r.y + r.height + ring }));
  const x0 = Math.max(0, Math.floor(Math.min(...grown.map((g) => g.x0)) * scale));
  const y0 = Math.max(0, Math.floor(Math.min(...grown.map((g) => g.y0)) * scale));
  const x1 = Math.min(width, Math.ceil(Math.max(...grown.map((g) => g.x1)) * scale));
  const y1 = Math.min(height, Math.ceil(Math.max(...grown.map((g) => g.y1)) * scale));
  for (let py = y0; py < y1; py++) {
    const y = (py + 0.5) / scale;
    for (let px = x0; px < x1; px++) {
      const x = (px + 0.5) / scale;
      if (!grown.some((g) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1)) continue;
      if (rects.some((r) => x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height)) continue;
      const o = (py * width + px) * 4;
      hist.forEach((h, c) => {
        const v = data[o + c] as number;
        h[v] = (h[v] as number) + 1;
      });
      count++;
    }
  }
  if (count === 0) return "#ffffff";
  const median = (h: Uint32Array) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v] as number;
      if (seen * 2 >= count) return v;
    }
    return 255;
  };
  return `#${hist.map((h) => median(h).toString(16).padStart(2, "0")).join("")}`;
}
