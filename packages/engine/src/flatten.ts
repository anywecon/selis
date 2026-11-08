/**
 * Flattening for redaction (ADR 0009 amendment): content that cannot be cut
 * geometrically — a shading (`sh`), a path painted with a pattern, anything
 * painted under an ExtGState soft mask, an image with a soft or stencil mask,
 * an inline image — and that meets a redacted area is replaced by a raster of
 * that object alone, with the redacted area left transparent. Nothing of the
 * object is drawn under the box any more, and the object's own data (the
 * pattern instance, the soft mask, the shading) no longer reaches that area.
 *
 * Each object is rendered on its own: a copy of the document where every
 * other painting operator on the way to it is turned into `n` or dropped
 * (state, clips and transforms kept), the page reduced to the object's page
 * box, on a transparent background. The image goes back where the object was,
 * under a graphics state that clears the soft mask and alpha (the raster
 * already has them).
 */
import { type Matrix, multiply, invert, operations, type OpEvent, pageBounds, type PaintEvent, pathText, splice, walk, fmt } from "./content-stream";
import { type Box, boxesMeet } from "./path-clip";
import { bytesToLatin1, decodeStream, deflate, nameOf, type PdfDict, type PdfObj } from "./pdf-objects";
import { ContentRewriteError, type Ctx, num, setStreamText, type Stream, UNDECODABLE_FORM, xobject } from "./unshare";

/** An RGBA raster (not premultiplied), rows from the top. */
export type Raster = { readonly width: number; readonly height: number; readonly data: Uint8Array };

/**
 * Renders page `index` of `pdf` whole (its MediaBox is the object's box, no
 * /Rotate, no CropBox) at `scale` pixels per point on a transparent
 * background, without annotations.
 */
export type Rasterizer = (pdf: Uint8Array, index: number, scale: number) => Promise<Raster>;

/** Raster resolution: 3 px per point (216 dpi), lowered for large objects. */
const SCALE = 3;
const MAX_PIXELS = 6_000_000;

const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);
const PAINTS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);
const SHOWS = new Set(["sh", "Do", "BI", "Tj", "TJ", "'", '"']);

/** A content stream on the way to an object: the page's (key null) or a form's. */
type Source = { readonly stream: Stream | null; readonly text: string; readonly resources: PdfDict };
/** The `Do` that draws the next source of a chain. */
type Link = { readonly source: Source; readonly start: number; readonly end: number };
type Target = {
  readonly chain: readonly Link[];
  readonly source: Source;
  readonly start: number;
  readonly end: number;
  readonly ctm: Matrix;
  readonly box: Box;
  /** The clip the replaced path also set, to set it again. */
  readonly clip: string | null;
};

const meet = (a: Box, b: Box | null): Box | null => {
  const out = b ? { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) } : a;
  return out.x1 > out.x0 && out.y1 > out.y0 ? out : null;
};

function unitBox(m: Matrix): Box {
  return pageBounds([{ start: { x: 0, y: 0 }, segs: [{ kind: "line", to: { x: 1, y: 0 } }, { kind: "line", to: { x: 1, y: 1 } }, { kind: "line", to: { x: 0, y: 1 } }], closed: true }], m) as Box;
}

function softMaskOf(ctx: Ctx, resources: PdfDict, name: string): boolean | undefined {
  const gs = ctx.doc.dict(ctx.doc.dict(resources.get("ExtGState"))?.get(name));
  const mask = gs?.get("SMask");
  if (mask === undefined) return undefined;
  return nameOf(ctx.doc.get(mask)) !== "None";
}

function lineWidthOf(ctx: Ctx, resources: PdfDict, name: string): number | undefined {
  const gs = ctx.doc.dict(ctx.doc.dict(resources.get("ExtGState"))?.get(name));
  return num(ctx.doc.get(gs?.get("LW"))) ?? undefined;
}

/** Finds, in `source` and the forms it draws over the area, what must be flattened. */
async function findTargets(ctx: Ctx, source: Source, base: Matrix, chain: readonly Link[], pageBox: Box, out: Target[]): Promise<void> {
  const forms: { link: Link; stream: Stream; matrix: Matrix }[] = [];
  const hits = (box: Box | null) => box !== null && ctx.boxes.some((b) => boxesMeet(box, b));
  const add = (start: number, end: number, ctm: Matrix, box: Box | null, clip: string | null = null) => {
    if (box && hits(box)) out.push({ chain, source, start, end, ctm, box, clip });
  };
  walk(operations(source.text), base, {
    lineWidthOf: (name) => lineWidthOf(ctx, source.resources, name),
    softMaskOf: (name) => softMaskOf(ctx, source.resources, name),
    onPaint: (e: PaintEvent) => {
      const fills = FILLS.has(e.op);
      const strokes = STROKES.has(e.op);
      if (!((fills && e.fillPattern) || (strokes && e.strokePattern) || (e.softMask && (fills || strokes)))) return;
      const bounds = pageBounds(e.subpaths, e.ctm);
      if (!bounds) return;
      const pad = strokes ? (e.lineWidth * Math.max(Math.hypot(e.ctm[0], e.ctm[1]), Math.hypot(e.ctm[2], e.ctm[3]))) / 2 + 1 : 0;
      const grown = { x0: bounds.x0 - pad, y0: bounds.y0 - pad, x1: bounds.x1 + pad, y1: bounds.y1 + pad };
      add(e.start, e.end, e.ctm, meet(grown, e.clipBox), e.clip ? `${pathText(e.subpaths)}\n${e.clip} n` : null);
    },
    onShading: (e: OpEvent) => add(e.start, e.end, e.ctm, meet(pageBox, e.clipBox)),
    onInlineImage: (e: OpEvent) => add(e.start, e.end, e.ctm, meet(unitBox(e.ctm), e.clipBox)),
    onDo: (e) => {
      const x = xobject(ctx, source.resources, e.name, e.ctm);
      if (!x) return;
      const box = meet(x.box, e.clipBox);
      if (!x.form) {
        const masked = x.stream.dict.has("SMask") || ctx.doc.get(x.stream.dict.get("Mask")).t === "stream";
        if (e.softMask || masked) add(e.start, e.end, e.ctm, box);
        return;
      }
      if (e.softMask) add(e.start, e.end, e.ctm, box);
      else if (hits(box)) forms.push({ link: { source, start: e.start, end: e.end }, stream: x.stream, matrix: x.matrix });
    },
  });
  for (const form of forms) {
    const inner = await decodeStream(form.stream);
    if (!inner) throw new ContentRewriteError(UNDECODABLE_FORM);
    const resources = ctx.doc.dict(form.stream.dict.get("Resources")) ?? source.resources;
    await findTargets(ctx, { stream: form.stream, text: bytesToLatin1(inner), resources }, form.matrix, [...chain, form.link], pageBox, out);
  }
}

/** `text` with every painting operator outside `keep` neutralised: paths end in `n`, the rest goes. */
function isolate(text: string, keep: { start: number; end: number }): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const op of operations(text)) {
    if (op.start >= keep.start && op.end <= keep.end) continue;
    if (PAINTS.has(op.op)) edits.push({ start: op.end - op.op.length, end: op.end, text: "n" });
    else if (SHOWS.has(op.op)) edits.push({ start: op.start, end: op.end, text: "" });
  }
  return splice(text, edits);
}

/** The bytes of the document with only `t` painted, on a page reduced to its box. */
function isolated(ctx: Ctx, page: PdfDict, t: Target): Uint8Array {
  const saved = new Map<Stream, { data: Uint8Array; dict: PdfDict }>();
  const pageKeys = new Map<string, PdfObj | undefined>(["Contents", "MediaBox", "CropBox", "Rotate", "Annots"].map((k) => [k, page.get(k)]));
  const set = (source: Source, text: string) => {
    if (source.stream === null) {
      const stream: Stream = { t: "stream", dict: new Map(), data: new Uint8Array() };
      setStreamText({ ...ctx, changed: new Set() }, stream, text);
      page.set("Contents", ctx.doc.add(stream));
      return;
    }
    if (!saved.has(source.stream)) saved.set(source.stream, { data: source.stream.data, dict: new Map(source.stream.dict) });
    setStreamText({ ...ctx, changed: new Set() }, source.stream, text);
  };
  try {
    t.chain.forEach((link) => set(link.source, isolate(link.source.text, link)));
    set(t.source, isolate(t.source.text, t));
    page.set("MediaBox", { t: "arr", v: [t.box.x0, t.box.y0, t.box.x1, t.box.y1].map((v): PdfObj => ({ t: "num", v: fmt(v) })) });
    page.delete("CropBox");
    page.delete("Annots");
    page.set("Rotate", { t: "num", v: "0" });
    return ctx.doc.write();
  } finally {
    for (const [stream, was] of saved) {
      stream.data = was.data;
      stream.dict.clear();
      for (const [k, v] of was.dict) stream.dict.set(k, v);
    }
    for (const [k, v] of pageKeys) {
      if (v === undefined) page.delete(k);
      else page.set(k, v);
    }
  }
}

/** A graphics state that undoes soft mask, alpha and blend mode (the raster has them already). */
const RESET = (): PdfDict =>
  new Map<string, PdfObj>([
    ["Type", { t: "name", v: "ExtGState" }],
    ["SMask", { t: "name", v: "None" }],
    ["ca", { t: "num", v: "1" }],
    ["CA", { t: "num", v: "1" }],
    ["BM", { t: "name", v: "Normal" }],
  ]);

/** A name not yet in `dict`, with `prefix`. */
function freshName(dict: PdfDict, prefix: string): string {
  for (let i = 1; ; i++) if (!dict.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** The subdictionary `key` of `resources`, made its own (a copy) so other users are unaffected. */
function ownSub(ctx: Ctx, resources: PdfDict, key: string): PdfDict {
  const copy: PdfDict = new Map(ctx.doc.dict(resources.get(key)) ?? []);
  resources.set(key, { t: "dict", v: copy });
  return copy;
}

/** The raster as an image XObject (RGB + soft mask); null when nothing of it is left. */
async function imageOf(ctx: Ctx, r: Raster): Promise<PdfObj | null> {
  const n = r.width * r.height;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  let opaque = true;
  let visible = false;
  for (let i = 0; i < n; i++) {
    const a = r.data[i * 4 + 3] as number;
    alpha[i] = a;
    if (a !== 255) opaque = false;
    if (a === 0) continue;
    visible = true;
    rgb[i * 3] = r.data[i * 4] as number;
    rgb[i * 3 + 1] = r.data[i * 4 + 1] as number;
    rgb[i * 3 + 2] = r.data[i * 4 + 2] as number;
  }
  if (!visible) return null;
  const image = (cs: string, data: Uint8Array, extra: [string, PdfObj][] = []): PdfDict =>
    new Map<string, PdfObj>([
      ["Type", { t: "name", v: "XObject" }],
      ["Subtype", { t: "name", v: "Image" }],
      ["Width", { t: "num", v: String(r.width) }],
      ["Height", { t: "num", v: String(r.height) }],
      ["ColorSpace", { t: "name", v: cs }],
      ["BitsPerComponent", { t: "num", v: "8" }],
      ["Filter", { t: "name", v: "FlateDecode" }],
      ["Length", { t: "num", v: String(data.length) }],
      ...extra,
    ] as [string, PdfObj][]);
  const extra: [string, PdfObj][] = [];
  if (!opaque) {
    const mask = await deflate(alpha);
    extra.push(["SMask", ctx.doc.add({ t: "stream", dict: image("DeviceGray", mask), data: mask })]);
  }
  const data = await deflate(rgb);
  return ctx.doc.add({ t: "stream", dict: image("DeviceRGB", data, extra), data });
}

/** Clears the redacted area in the raster (transparent, no colour left). */
function clearArea(r: Raster, box: Box, areas: readonly Box[]): void {
  const sx = r.width / (box.x1 - box.x0);
  const sy = r.height / (box.y1 - box.y0);
  for (let py = 0; py < r.height; py++) {
    const y = box.y1 - (py + 0.5) / sy;
    for (let px = 0; px < r.width; px++) {
      const x = box.x0 + (px + 0.5) / sx;
      if (areas.some((a) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1)) r.data.fill(0, (py * r.width + px) * 4, (py * r.width + px) * 4 + 4);
    }
  }
}

/**
 * Flattens what cannot be cut on page `pageIndex` (content `text`, its own
 * resources): returns the new page content (null when nothing changed) and
 * how many objects were flattened; forms are rewritten in place.
 */
export async function flattenPage(
  ctx: Ctx,
  page: PdfDict,
  pageIndex: number,
  text: string,
  resources: PdfDict,
  pageBox: Box,
  rasterize: Rasterizer,
): Promise<{ text: string | null; flattened: number }> {
  const targets: Target[] = [];
  const pageSource: Source = { stream: null, text, resources };
  await findTargets(ctx, pageSource, [1, 0, 0, 1, 0, 0], [], pageBox, targets);
  if (targets.length === 0) return { text: null, flattened: 0 };
  // All rasters first, from the content as it was; then every edit at once.
  const edits = new Map<Source, { start: number; end: number; text: string }[]>();
  // Per resource dictionary: its own XObject / ExtGState subdictionaries and the reset state.
  const own = new Map<PdfDict, { xobjects: PdfDict; gs: string }>();
  const ownOf = (res: PdfDict) => {
    let o = own.get(res);
    if (!o) {
      const states = ownSub(ctx, res, "ExtGState");
      const gs = freshName(states, "SelisR");
      states.set(gs, ctx.doc.add({ t: "dict", v: RESET() }));
      o = { xobjects: ownSub(ctx, res, "XObject"), gs };
      own.set(res, o);
    }
    return o;
  };
  for (const t of targets) {
    const box = t.box;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    const raster = await rasterize(isolated(ctx, page, t), pageIndex, scale);
    clearArea(raster, box, ctx.boxes);
    const image = await imageOf(ctx, raster);
    let replacement = "";
    const inverse = invert(t.ctm);
    if (image && inverse) {
      const { xobjects, gs } = ownOf(t.source.resources);
      const name = freshName(xobjects, "SelisR");
      xobjects.set(name, image);
      const m = multiply([w, 0, 0, h, box.x0, box.y0], inverse);
      replacement = `q /${gs} gs ${m.map(fmt).join(" ")} cm /${name} Do Q`;
    }
    if (t.clip) replacement = `${replacement}\n${t.clip}`;
    const list = edits.get(t.source) ?? [];
    list.push({ start: t.start, end: t.end, text: replacement });
    edits.set(t.source, list);
  }
  let pageText: string | null = null;
  for (const [source, list] of edits) {
    const next = splice(source.text, list);
    if (source.stream === null) pageText = next;
    else setStreamText(ctx, source.stream, next);
  }
  return { text: pageText, flattened: targets.length };
}
