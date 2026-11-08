/**
 * Residue after redaction and erase (security audit run-1, leads 1, 2, 3 and 6):
 * what was under a mark must be nowhere in the saved file, not merely
 * unreferenced by the page. Every fixture is generated here (no user data) or is
 * the corpus `greek` fixture. The oracle is independent of the engine: qpdf
 * rewrites the result with every stream decoded (`--qdf --object-streams=disable`,
 * `--decode-level=specialized`: Flate, LZW, ASCII85, ASCIIHex and RunLength) and the bytes
 * of the content that went must not appear anywhere in it. Each test checks the
 * same needle in its input first (positive control), and that the page still
 * renders the box (pdf.js).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject } from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { FIXTURES } from "@selis/fixtures";
import { pdfjsRender, qpdfCheck, qpdfRewrite } from "@selis/fixtures/oracle";
import { encodeChain, type FilterName } from "@selis/fixtures/encode";
import { n, type PdfDict, PdfWriter, type Ref, Str, Stream } from "@selis/fixtures/pdf-writer";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText, toPdfAnnotation } from "./annotations";
import { eraseArea } from "./erase";
import type { PageRect } from "./geometry";
import { decodeStream, PdfDocumentObjects } from "./pdf-objects";
import { applyRedactions } from "./redact";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
/** Page size of the fixtures built here (points); viewer y = H − user y. */
const W = 600;
const H = 800;
/** pdf.js renders at 2 px per point here. */
const SCALE = 2;
const ERASE_FILL = "#ff00ff";

let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;
let text: EmbeddedText;
let nextId = 0;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
}, 60_000);

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

type Needle = { readonly label: string; readonly bytes: Uint8Array };
const needle = (label: string, bytes: Uint8Array | string): Needle => ({
  label,
  bytes: typeof bytes === "string" ? new Uint8Array(Buffer.from(bytes, "latin1")) : bytes,
});

/** The file with every stream decoded by qpdf, as latin1 text (content streams kept as written). */
function decodedFile(bytes: ArrayBuffer | Uint8Array): string {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = qpdfRewrite(input, ["--qdf", "--object-streams=disable", "--normalize-content=n", "--decode-level=specialized"]);
  return Buffer.from(out).toString("latin1");
}

/**
 * The labels of the needles that survive anywhere in the decoded file: as bytes,
 * or as hex digits (either case). PDFium can drop an /ASCIIHexDecode filter on
 * save and keep the hex digits as the data (measured), so a survivor may be hex.
 */
function residue(bytes: ArrayBuffer | Uint8Array, needles: readonly Needle[]): string[] {
  const hay = decodedFile(bytes);
  const lower = hay.toLowerCase();
  return needles
    .filter((x) => {
      const b = Buffer.from(x.bytes);
      return hay.includes(b.toString("latin1")) || lower.includes(b.toString("hex"));
    })
    .map((x) => x.label);
}

/** Positive control, then the check: every needle is in the input, none in the output. */
function expectGone(input: ArrayBuffer, output: ArrayBuffer, needles: readonly Needle[]): void {
  expect(residue(input, needles), "positive control: the input has every needle").toEqual(needles.map((x) => x.label));
  expect(residue(output, needles)).toEqual([]);
  qpdfCheck(new Uint8Array(output));
}

/** The pdf.js colour at the centre of a viewer rect. */
async function centre(bytes: ArrayBuffer, page: number, r: PageRect): Promise<[number, number, number]> {
  const img = await pdfjsRender(new Uint8Array(bytes), page, SCALE, false);
  const x = Math.round((r.x + r.width / 2) * SCALE);
  const y = Math.round((r.y + r.height / 2) * SCALE);
  const o = (y * img.width + x) * 4;
  return [img.data[o] ?? -1, img.data[o + 1] ?? -1, img.data[o + 2] ?? -1];
}

async function expectBlackBox(bytes: ArrayBuffer, page: number, r: PageRect): Promise<void> {
  const [red, green, blue] = await centre(bytes, page, r);
  expect(Math.max(red, green, blue), "the box is painted black").toBeLessThan(40);
}

async function expectFill(bytes: ArrayBuffer, page: number, r: PageRect): Promise<void> {
  const [red, green, blue] = await centre(bytes, page, r);
  expect([red > 215, green < 40, blue > 215], "the area is painted with the fill").toEqual([true, true, true]);
}

// ---------------------------------------------------------------------------
// Running redaction and erase
// ---------------------------------------------------------------------------

/** Adds black /Redact marks (viewer rects) and returns the saved document with them pending. */
async function withMarks(bytes: ArrayBuffer, page: number, rects: readonly PageRect[]): Promise<ArrayBuffer> {
  const doc: PdfDocumentObject = await engine.openDocumentBuffer({ id: `res-${nextId++}`, content: bytes.slice(0) }).toPromise();
  try {
    const p = doc.pages[page];
    if (!p) throw new Error("no page");
    for (const rect of rects) {
      const mark = { id: `selis-redact-${nextId++}`, page, kind: "redact", rect, segments: [rect], fill: "black", text: "", color: "#000000", opacity: 1 } as const;
      await engine.createPageAnnotation(doc, p, toPdfAnnotation(mark)).toPromise();
    }
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

async function redact(bytes: ArrayBuffer, page: number, rects: readonly PageRect[]): Promise<ArrayBuffer> {
  return (await applyRedactions(engine, text, await withMarks(bytes, page, rects))).bytes;
}

async function erase(bytes: ArrayBuffer, page: number, rects: readonly PageRect[]): Promise<ArrayBuffer> {
  return (await eraseArea(engine, text, bytes, { page, rects: [...rects], fill: ERASE_FILL })).bytes;
}

// ---------------------------------------------------------------------------
// Fixtures (generated; A W × H page, Helvetica)
// ---------------------------------------------------------------------------

/** A viewer rect from user-space corners. */
const viewer = (x0: number, y0: number, x1: number, y1: number): PageRect => ({ x: x0, y: H - y1, width: x1 - x0, height: y1 - y0 });

/** The redacted line every fixture has: baseline (60, 700), 14 pt. */
const LINE = "Secret Marigold Tangerine line.";
const LINE_RECT = viewer(55, 694, 330, 716);
const lineOp = `BT /F1 14 Tf 60 700 Td (${LINE}) Tj ET`;

function helvetica(w: PdfWriter): Ref {
  return w.add({ Type: n("Font"), Subtype: n("Type1"), BaseFont: n("Helvetica"), Encoding: n("WinAnsiEncoding") });
}

/** RGB samples `size` × `size` from `px` (deterministic). */
function samples(size: number, px: (x: number, y: number) => readonly [number, number, number]): Uint8Array {
  const data = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data.set(px(x, y), (y * size + x) * 3);
  }
  return data;
}

function image(w: PdfWriter, size: number, data: Uint8Array, extra: PdfDict = {}): Ref {
  return w.addStream({ Type: n("XObject"), Subtype: n("Image"), Width: size, Height: size, ColorSpace: n("DeviceRGB"), BitsPerComponent: 8, ...extra }, data);
}

/** `text` repeated to `length` bytes. */
function repeat(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = text.charCodeAt(i % text.length);
  return out;
}

type PageSpec = { content: string; resources?: PdfDict; extra?: (page: Ref) => PdfDict };

/** One /Pages node; `pagesResources` sits on it (inherited), each page's own dict when given. */
function document(seed: string, pages: readonly PageSpec[], pagesResources: PdfDict | null, catalog: (w: PdfWriter, pages: Ref[]) => PdfDict = () => ({}), w = new PdfWriter(seed)): ArrayBuffer {
  const pagesRef = w.reserve();
  const refs = pages.map(() => w.reserve());
  pages.forEach((spec, i) => {
    const page: Record<string, unknown> = {
      Type: n("Page"),
      Parent: pagesRef,
      MediaBox: [0, 0, W, H],
      Contents: w.addStream({}, spec.content),
      ...(spec.resources ? { Resources: spec.resources } : {}),
      ...(spec.extra ? spec.extra(refs[i] as Ref) : {}),
    };
    w.set(refs[i] as Ref, page as PdfDict);
  });
  w.set(pagesRef, { Type: n("Pages"), Kids: refs, Count: refs.length, ...(pagesResources ? { Resources: pagesResources } : {}) });
  w.setRoot(w.add({ Type: n("Catalog"), Pages: pagesRef, ...catalog(w, refs) }));
  return w.toBytes().slice().buffer;
}

/** The decoded samples of image XObject `name` drawn by page `index` of `bytes`. */
async function imageSamples(bytes: ArrayBuffer, index: number, name: string): Promise<Uint8Array> {
  const doc = await PdfDocumentObjects.parse(new Uint8Array(bytes));
  const res = doc.pages()[index]?.resources ?? null;
  const target = doc.get(doc.dict(res?.get("XObject"))?.get(name));
  if (target.t !== "stream") throw new Error(`no image ${name}`);
  const data = await decodeStream(target);
  if (!data) throw new Error(`cannot decode ${name}`);
  return data;
}

// The image drawn at user (100, 400)–(300, 600): its left half is the marked area.
const IMAGE_DRAW = "q 200 0 0 200 100 400 cm /Im1 Do Q";
const IMAGE_LEFT = viewer(100, 400, 200, 600);
const IMAGE_SIZE = 32;
const imageData = (seed: number) => samples(IMAGE_SIZE, (x, y) => [(x * 7 + seed) & 0xff, (y * 5 + 3 * seed) & 0xff, (x * y + seed * 11) & 0xff]);

/** L1 (b): the page has no /Resources of its own: it inherits them from the /Pages node. */
function inheritedResources(): ArrayBuffer {
  const w = new PdfWriter("residue-inherited");
  const helv = helvetica(w);
  const im = image(w, IMAGE_SIZE, imageData(1));
  return document("", [{ content: `${lineOp}\n${IMAGE_DRAW}` }], { Font: { F1: helv }, XObject: { Im1: im } }, undefined, w);
}

/**
 * A stream filter chain (decoded first to last), or a /Filter the engine does not decode
 * (after /ASCIIHexDecode, so the residue oracle still finds the plain bytes as hex digits).
 */
type Encoding = readonly FilterName[] | { readonly undecodable: string };
const label = (e: Encoding): string => ("undecodable" in e ? e.undecodable : e.join("-"));

function encodedStream(dict: PdfDict, e: Encoding, plain: string): Stream {
  const data = new Uint8Array(Buffer.from(plain, "latin1"));
  if ("undecodable" in e) return new Stream({ ...dict, Filter: [n("ASCIIHexDecode"), n(e.undecodable)] }, new Uint8Array(Buffer.from(`${Buffer.from(data).toString("hex")}>`, "latin1")));
  if (e.length === 0) return new Stream(dict, data);
  return new Stream({ ...dict, Filter: e.map((x) => n(x)) }, encodeChain(e, data));
}

/** L1 (c) / L3: a form XObject drawn once holding only a filled path, in an encoding. */
const FORM_PATH = "0 0 1 rg 0 0 200 100 re f";
const FORM_AREA = viewer(110, 110, 290, 190);
function pathForm(e: Encoding = ["FlateDecode"]): ArrayBuffer {
  const w = new PdfWriter(`residue-form-${label(e)}`);
  const helv = helvetica(w);
  const dict = { Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 200, 100] };
  const form = w.add(encodedStream(dict, e, FORM_PATH));
  return document("", [{ content: `${lineOp}\nq 1 0 0 1 100 100 cm /Fm0 Do Q`, resources: { Font: { F1: helv }, XObject: { Fm0: form } } }], null, undefined, w);
}

/** L3: the redacted line drawn by a form XObject (its only text), in an encoding. */
function textForm(e: Encoding): ArrayBuffer {
  const w = new PdfWriter(`residue-text-form-${label(e)}`);
  const helv = helvetica(w);
  const dict = { Type: n("XObject"), Subtype: n("Form"), BBox: [0, -10, 400, 30], Resources: { Font: { F1: helv } } };
  const form = w.add(encodedStream(dict, e, `BT /F1 14 Tf 0 0 Td (${LINE}) Tj ET`));
  return document("", [{ content: "q 1 0 0 1 60 700 cm /Fm0 Do Q", resources: { XObject: { Fm0: form } } }], null, undefined, w);
}

/** L1 (d): a form XObject wrapping an image (a scanned page as a form), drawn once. */
function nestedImage(): ArrayBuffer {
  const w = new PdfWriter("residue-nested");
  const helv = helvetica(w);
  const im = image(w, IMAGE_SIZE, imageData(2));
  const form = w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 200, 200], Resources: { XObject: { Im0: im } } }, "q 200 0 0 200 0 0 cm /Im0 Do Q");
  return document("", [{ content: `${lineOp}\nq 1 0 0 1 100 400 cm /Fm0 Do Q`, resources: { Font: { F1: helv }, XObject: { Fm0: form } } }], null, undefined, w);
}

/** L2 (a, b): page /Thumb and /PieceInfo, and an image with /Alternates under the mark. */
function renditions(): ArrayBuffer {
  const w = new PdfWriter("residue-renditions");
  const helv = helvetica(w);
  const thumb = image(w, 8, repeat("THUMBMARK", 8 * 8 * 3));
  const piece = w.addStream({}, "PIECEMARK private application data");
  const alt = image(w, 8, repeat("ALTMARK", 8 * 8 * 3));
  const im = image(w, IMAGE_SIZE, imageData(3), { Alternates: [{ Image: alt }] });
  return document(
    "",
    [
      {
        content: `${lineOp}\n${IMAGE_DRAW}`,
        resources: { Font: { F1: helv }, XObject: { Im1: im } },
        extra: () => ({ Thumb: thumb, PieceInfo: { Selis: { LastModified: Str.ascii("D:20261108000000Z"), Private: piece } } }),
      },
    ],
    null,
    undefined,
    w,
  );
}

/** L2 (c): an attachment naming the line's words, in /Names /EmbeddedFiles and in the catalog's /AF. */
const ATTACHMENT = "Notes about the Marigold budget, AFMARK.";
function associatedFile(): ArrayBuffer {
  const w = new PdfWriter("residue-af");
  const helv = helvetica(w);
  const ef = w.addStream({ Type: n("EmbeddedFile"), Subtype: n("text#2Fplain") }, ATTACHMENT);
  const spec = w.add({ Type: n("Filespec"), F: Str.ascii("notes.txt"), UF: Str.ascii("notes.txt"), EF: { F: ef }, AFRelationship: n("Supplement") });
  return document("", [{ content: lineOp, resources: { Font: { F1: helv } } }], null, () => ({ Names: { EmbeddedFiles: { Names: [Str.ascii("notes.txt"), spec] } }, AF: [spec] }), w);
}

/** L2 (d): a FreeText note over the line with a popup, a reply (/IRT) and a structure-tree OBJR. */
function noteWithLinks(): ArrayBuffer {
  const w = new PdfWriter("residue-annots");
  const helv = helvetica(w);
  const note = w.reserve();
  const popup = w.add({ Type: n("Annot"), Subtype: n("Popup"), Rect: [400, 500, 560, 600], Parent: note });
  const reply = w.add({ Type: n("Annot"), Subtype: n("Text"), Rect: [450, 300, 470, 320], IRT: note, Contents: Str.ascii("Reply here") });
  const ap = w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 280, 26], Resources: { Font: { F1: helv } } }, "BT /F1 10 Tf 2 8 Td (APMARK Quokka) Tj ET");
  const structRoot = w.reserve();
  const elem = w.reserve();
  let pageRef: Ref | null = null;
  const bytes = document(
    "",
    [
      {
        content: lineOp,
        resources: { Font: { F1: helv } },
        extra: (page) => {
          pageRef = page;
          return { Annots: [note, popup, reply], StructParents: 1 };
        },
      },
    ],
    null,
    () => {
      if (!pageRef) throw new Error("no page");
      w.set(note, {
        Type: n("Annot"),
        Subtype: n("FreeText"),
        Rect: [60, 692, 340, 718],
        Contents: Str.ascii("Note Xylophone Quokka"),
        DA: Str.ascii("/Helv 10 Tf 0 g"),
        AP: { N: ap },
        Popup: popup,
        StructParent: 0,
        P: pageRef,
      });
      w.set(elem, { Type: n("StructElem"), S: n("Annot"), P: structRoot, Pg: pageRef, K: [{ Type: n("OBJR"), Obj: note, Pg: pageRef }] });
      w.set(structRoot, { Type: n("StructTreeRoot"), K: [elem], ParentTree: { Nums: [0, elem] } });
      return { StructTreeRoot: structRoot, MarkInfo: { Marked: true } };
    },
    w,
  );
  return bytes;
}

/** L3: an attachment naming the line's words and one that does not, in an encoding. */
const SECRET_ATTACHMENT = "Budget of project Marigold, ATTMARK.";
const CLEAN_ATTACHMENT = "Minutes of the picnic, KEEPMARK.";
function encodedAttachments(e: Encoding): ArrayBuffer {
  const w = new PdfWriter(`residue-attachment-${label(e)}`);
  const helv = helvetica(w);
  const spec = (name: string, text: string) => {
    const ef = w.add(encodedStream({ Type: n("EmbeddedFile") }, e, text));
    return w.add({ Type: n("Filespec"), F: Str.ascii(name), EF: { F: ef } });
  };
  const names = [Str.ascii("budget.txt"), spec("budget.txt", SECRET_ATTACHMENT), Str.ascii("picnic.txt"), spec("picnic.txt", CLEAN_ATTACHMENT)];
  return document("", [{ content: lineOp, resources: { Font: { F1: helv } } }], null, () => ({ Names: { EmbeddedFiles: { Names: names } } }), w);
}

/** L3: XMP in an encoding, naming the line's words (`secret`) or not. */
const xmp = (title: string) => `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title>${title}</dc:title></x:xmpmeta><?xpacket end="w"?>`;
function encodedXmp(e: Encoding, secret: boolean): ArrayBuffer {
  const w = new PdfWriter(`residue-xmp-${label(e)}-${secret}`);
  const helv = helvetica(w);
  const meta = w.add(encodedStream({ Type: n("Metadata"), Subtype: n("XML") }, e, xmp(secret ? "Marigold XMPMARK" : "Picnic XMPKEEP")));
  return document("", [{ content: lineOp, resources: { Font: { F1: helv } } }], null, () => ({ Metadata: meta }), w);
}

/** L6: an inline image at user (100, 300)–(300, 500); its left half (one colour run) is erased. */
const INLINE_LEFT = [0xa5, 0x5a, 0xc3] as const;
const INLINE_RIGHT = [0x3c, 0x96, 0x69] as const;
const INLINE_AREA = viewer(100, 300, 200, 500);
function inlineImage(): ArrayBuffer {
  const w = new PdfWriter("residue-inline");
  const helv = helvetica(w);
  const data = samples(64, (x) => (x < 32 ? INLINE_LEFT : INLINE_RIGHT));
  const content = Buffer.concat([
    Buffer.from(`${lineOp}\nq 200 0 0 200 100 300 cm\nBI /W 64 /H 64 /CS /RGB /BPC 8 ID\n`, "latin1"),
    Buffer.from(data),
    Buffer.from("\nEI\nQ\n", "latin1"),
  ]);
  const pagesRef = w.reserve();
  const page = w.add({ Type: n("Page"), Parent: pagesRef, MediaBox: [0, 0, W, H], Resources: { Font: { F1: helv } }, Contents: w.addStream({}, new Uint8Array(content)) });
  w.set(pagesRef, { Type: n("Pages"), Kids: [page], Count: 1 });
  w.setRoot(w.add({ Type: n("Catalog"), Pages: pagesRef }));
  return w.toBytes().slice().buffer;
}
const inlineLeftRun = () => needle("inline image left half", new Uint8Array(Array.from({ length: 32 }, () => INLINE_LEFT).flat()));

function greek(): ArrayBuffer {
  const f = FIXTURES.find((x) => x.name === "greek");
  if (!f) throw new Error("no greek fixture");
  return f.build().slice().buffer;
}
/** The greek fixture's image on page 2: user 56–296 × 480–630; its left half. */
const GREEK_IMAGE_LEFT: PageRect = { x: 56, y: 212, width: 120, height: 150 };

// ---------------------------------------------------------------------------
// L1 — the original (unredacted) image or form stays reachable
// ---------------------------------------------------------------------------

/** L1, fail closed: the shared resource dictionary is also the form's /DR, so its users cannot all be checked. */
function sharedWithAcroForm(): ArrayBuffer {
  const w = new PdfWriter("residue-dr");
  const helv = helvetica(w);
  const im = image(w, IMAGE_SIZE, imageData(4));
  const res = w.add({ Font: { F1: helv }, XObject: { Im1: im } });
  return document("", [{ content: lineOp, resources: res as unknown as PdfDict }, { content: IMAGE_DRAW, resources: res as unknown as PdfDict }], null, () => ({ AcroForm: { Fields: [], DR: res } }), w);
}

/** L1, fail closed: a form nothing draws (only listed in /AcroForm /DR) names the original image. */
function originalBehindDeadForm(): ArrayBuffer {
  const w = new PdfWriter("residue-dead-form");
  const helv = helvetica(w);
  const im = image(w, IMAGE_SIZE, imageData(5));
  const dead = w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 1, 1], Resources: { XObject: { Im0: im } } }, "/Im0 Do");
  return document(
    "",
    [{ content: `${lineOp}\n${IMAGE_DRAW}`, resources: { Font: { F1: helv }, XObject: { Im1: im } } }],
    null,
    () => ({ AcroForm: { Fields: [], DR: { XObject: { Dead: dead } } } }),
    w,
  );
}

describe("L1: no original XObject survives a redaction or erase", () => {
  it("redaction, shared resource dictionary (greek fixture): page 1 still names the image page 2 redacts", async () => {
    const input = greek();
    const original = needle("original Im1 samples", await imageSamples(input, 1, "Im1"));
    const out = await redact(input, 1, [GREEK_IMAGE_LEFT]);
    expectGone(input, out, [original]);
    await expectBlackBox(out, 1, GREEK_IMAGE_LEFT);
  });

  it("erase, shared resource dictionary (greek fixture)", async () => {
    const input = greek();
    const original = needle("original Im1 samples", await imageSamples(input, 1, "Im1"));
    const out = await erase(input, 1, [GREEK_IMAGE_LEFT]);
    expectGone(input, out, [original]);
    await expectFill(out, 1, GREEK_IMAGE_LEFT);
  });

  it("redaction, resources inherited from the /Pages node", async () => {
    const input = inheritedResources();
    const original = needle("original image samples", await imageSamples(input, 0, "Im1"));
    const out = await redact(input, 0, [IMAGE_LEFT]);
    expectGone(input, out, [original]);
    await expectBlackBox(out, 0, IMAGE_LEFT);
  });

  it("erase, resources inherited from the /Pages node", async () => {
    const input = inheritedResources();
    const original = needle("original image samples", await imageSamples(input, 0, "Im1"));
    const out = await erase(input, 0, [IMAGE_LEFT]);
    expectGone(input, out, [original]);
    await expectFill(out, 0, IMAGE_LEFT);
  });

  it("erase, a form holding only a path, drawn once: the uncut form does not survive", async () => {
    const input = pathForm();
    const out = await erase(input, 0, [FORM_AREA]);
    expectGone(input, out, [needle("uncut form path", FORM_PATH)]);
    await expectFill(out, 0, FORM_AREA);
  });

  it("redaction, a form holding only a path, drawn once", async () => {
    const input = pathForm();
    const out = await redact(input, 0, [FORM_AREA, LINE_RECT]);
    expectGone(input, out, [needle("uncut form path", FORM_PATH), needle("line", "Marigold")]);
    await expectBlackBox(out, 0, FORM_AREA);
  });

  it("redaction, an image inside a form drawn once: the copied form names no original image", async () => {
    const input = nestedImage();
    const original = needle("original nested image samples", imageData(2));
    const out = await redact(input, 0, [IMAGE_LEFT]);
    expectGone(input, out, [original]);
    await expectBlackBox(out, 0, IMAGE_LEFT);
  });

  it("refuses when the original stays in a dictionary whose users cannot all be checked", async () => {
    const input = sharedWithAcroForm();
    await expect(redact(input, 1, [IMAGE_LEFT])).rejects.toThrow(/cannot be checked/);
    await expect(erase(input, 1, [IMAGE_LEFT])).rejects.toThrow(/cannot be checked/);
  });

  it("refuses when only a form that nothing draws still names the original", async () => {
    const input = originalBehindDeadForm();
    await expect(redact(input, 0, [IMAGE_LEFT])).rejects.toThrow(/cannot be checked/);
  });

  it("erase, an image inside a form drawn once", async () => {
    const input = nestedImage();
    const out = await erase(input, 0, [IMAGE_LEFT]);
    expectGone(input, out, [needle("original nested image samples", imageData(2))]);
    await expectFill(out, 0, IMAGE_LEFT);
  });
});

// ---------------------------------------------------------------------------
// L2 — renditions and references the rewrite never clears
// ---------------------------------------------------------------------------

describe("L2: thumbnails, private data, alternates, associated files and removed annotations", () => {
  const renditionNeedles = [needle("/Thumb raster", "THUMBMARK"), needle("/PieceInfo data", "PIECEMARK"), needle("image /Alternates", "ALTMARK")];

  it("redaction drops the page's /Thumb and /PieceInfo and the image copy's /Alternates", async () => {
    const input = renditions();
    const out = await redact(input, 0, [LINE_RECT, IMAGE_LEFT]);
    expectGone(input, out, renditionNeedles);
    await expectBlackBox(out, 0, IMAGE_LEFT);
  });

  it("erase drops them too", async () => {
    const input = renditions();
    const out = await erase(input, 0, [LINE_RECT, IMAGE_LEFT]);
    expectGone(input, out, renditionNeedles);
    await expectFill(out, 0, IMAGE_LEFT);
  });

  it("redaction removes an attachment that names a redacted word from /AF as well as /EmbeddedFiles", async () => {
    const input = associatedFile();
    const out = await redact(input, 0, [LINE_RECT]);
    expectGone(input, out, [needle("attachment content", "AFMARK"), needle("line", "Marigold")]);
    await expectBlackBox(out, 0, LINE_RECT);
  });

  it("redaction leaves no removed note reachable through its popup, a reply or the structure tree", async () => {
    const input = noteWithLinks();
    const out = await redact(input, 0, [LINE_RECT]);
    expectGone(input, out, [needle("note appearance", "APMARK"), needle("note subtype", "/FreeText")]);
    await expectBlackBox(out, 0, LINE_RECT);
  });

  it("erase leaves no removed note reachable either", async () => {
    const input = noteWithLinks();
    const out = await erase(input, 0, [LINE_RECT]);
    expectGone(input, out, [needle("note appearance", "APMARK"), needle("note text", "Xylophone"), needle("note subtype", "/FreeText")]);
    await expectFill(out, 0, LINE_RECT);
  });
});

// ---------------------------------------------------------------------------
// L3 — encoded streams are decoded and checked; what cannot be decoded fails closed
// ---------------------------------------------------------------------------

const ENCODINGS: readonly (readonly FilterName[])[] = [
  ["FlateDecode"],
  ["LZWDecode"],
  ["ASCII85Decode"],
  ["ASCIIHexDecode"],
  ["RunLengthDecode"],
  ["ASCII85Decode", "FlateDecode"],
  ["ASCIIHexDecode", "FlateDecode"],
  ["ASCIIHexDecode", "LZWDecode"],
  ["ASCII85Decode", "RunLengthDecode"],
];

describe("L3: every non-image filter and chain is decoded and checked", () => {
  for (const e of ENCODINGS) {
    describe(e.join(" + "), () => {
      it("erase cuts a form under the area", async () => {
        const input = pathForm(e);
        const out = await erase(input, 0, [FORM_AREA]);
        expectGone(input, out, [needle("uncut form path", FORM_PATH)]);
        await expectFill(out, 0, FORM_AREA);
      });

      it("redaction removes the line drawn by a form", async () => {
        const input = textForm(e);
        const out = await redact(input, 0, [LINE_RECT]);
        expectGone(input, out, [needle("line", "Marigold Tangerine")]);
        await expectBlackBox(out, 0, LINE_RECT);
      });

      it("redaction drops the attachment that names a redacted word and keeps the other", async () => {
        const input = encodedAttachments(e);
        const out = await redact(input, 0, [LINE_RECT]);
        expectGone(input, out, [needle("secret attachment", "ATTMARK"), needle("line", "Marigold")]);
        expect(residue(out, [needle("clean attachment", "KEEPMARK")])).toEqual(["clean attachment"]);
      });

      it("redaction drops XMP that names a redacted word", async () => {
        const input = encodedXmp(e, true);
        const out = await redact(input, 0, [LINE_RECT]);
        expectGone(input, out, [needle("XMP", "XMPMARK")]);
      });
    });
  }

  it("control: XMP that names no redacted word is kept", async () => {
    // Unencoded: PDFium writes a metadata stream without its /Filter (the data stays encoded,
    // measured), so encoded XMP reaches the check unreadable and is dropped as such.
    const input = encodedXmp([], false);
    const out = await redact(input, 0, [LINE_RECT]);
    expect(residue(out, [needle("XMP", "XMPKEEP")])).toEqual(["XMP"]);
  });
});

describe("L3: what still cannot be decoded fails closed", () => {
  const undecodable = { undecodable: "SelisUnknownDecode" } as const;

  it("erase refuses a form under the area in an encoding it cannot read", async () => {
    const input = pathForm(undecodable);
    expect(residue(input, [needle("form path", FORM_PATH)])).toEqual(["form path"]);
    await expect(erase(input, 0, [FORM_AREA])).rejects.toThrow(/cannot be rewritten/);
  });

  it("redaction refuses it too", async () => {
    const input = pathForm(undecodable);
    await expect(redact(input, 0, [FORM_AREA, LINE_RECT])).rejects.toThrow(/cannot be rewritten/);
  });

  it("redaction refuses an attachment it cannot read (it may name a redacted word)", async () => {
    const input = encodedAttachments(undecodable);
    expect(residue(input, [needle("attachment", "ATTMARK")])).toEqual(["attachment"]);
    await expect(redact(input, 0, [LINE_RECT])).rejects.toThrow(/cannot be read/);
  });

  it("redaction refuses an attachment whose data is malformed for its filter", async () => {
    const w = new PdfWriter("residue-attachment-bad-a85");
    const helv = helvetica(w);
    // "{" is outside base 85: nothing can say what this attachment holds.
    const ef = w.add(new Stream({ Type: n("EmbeddedFile"), Filter: n("ASCII85Decode") }, new Uint8Array(Buffer.from("Marigold{ATTMARK~>", "latin1"))));
    const spec = w.add({ Type: n("Filespec"), F: Str.ascii("x.txt"), EF: { F: ef } });
    const input = document("", [{ content: lineOp, resources: { Font: { F1: helv } } }], null, () => ({ Names: { EmbeddedFiles: { Names: [Str.ascii("x.txt"), spec] } } }), w);
    await expect(redact(input, 0, [LINE_RECT])).rejects.toThrow(/cannot be read/);
  });

  it("redaction drops XMP metadata it cannot read", async () => {
    const input = encodedXmp(undecodable, true);
    const out = await redact(input, 0, [LINE_RECT]);
    expectGone(input, out, [needle("XMP", "XMPMARK")]);
  });
});

// ---------------------------------------------------------------------------
// L6 — inline images under an erased area
// ---------------------------------------------------------------------------

describe("L6: inline images", () => {
  it("erase leaves none of an inline image's samples under the area", async () => {
    const input = inlineImage();
    const out = await erase(input, 0, [INLINE_AREA]);
    expectGone(input, out, [inlineLeftRun()]);
    await expectFill(out, 0, INLINE_AREA);
    // Not a residue (measured): PDFium turns the inline image into an image XObject with the
    // area blanked; the right half still shows.
    const [r, g, b] = await centre(out, 0, viewer(200, 300, 300, 500));
    expect([r, g, b].map((v, i) => Math.abs(v - (INLINE_RIGHT[i] ?? 0)) < 12)).toEqual([true, true, true]);
  });

  it("control: redaction flattens it (ADR 0009)", async () => {
    const input = inlineImage();
    const out = await redact(input, 0, [INLINE_AREA]);
    expectGone(input, out, [inlineLeftRun()]);
    await expectBlackBox(out, 0, INLINE_AREA);
  });
});

// ---------------------------------------------------------------------------
// Over-pruning guard: what is still drawn stays (code review of the fix)
// ---------------------------------------------------------------------------

/** A solid 8 × 8 RGB image. */
const solid = (rgb: readonly [number, number, number]) => samples(8, () => rgb);
const KEEP = {
  formNoResources: [200, 30, 30],
  formNoXObject: [30, 160, 30],
  appearance: [30, 30, 200],
  type3: [200, 160, 30],
  softMask: [255, 255, 255],
  sharedPage2: [120, 30, 160],
} as const;

/**
 * Page 1: the redacted line. Page 2 (no mark, so PDFium leaves it alone and only the pruning
 * touches its dictionaries) draws images only through what has no resources of its own: a form
 * without /Resources, a form whose /Resources has no /XObject, a stamp appearance without
 * /Resources, a Type 3 glyph without /Resources, a soft-mask group without /Resources; and one
 * image directly. Both pages share one /XObject subdictionary.
 */
function drawnThroughInheritors(): ArrayBuffer {
  const w = new PdfWriter("residue-keep");
  const helv = helvetica(w);
  const im = Object.fromEntries(Object.entries(KEEP).map(([k, rgb]) => [k, image(w, 8, solid(rgb))])) as Record<keyof typeof KEEP, Ref>;
  const draw = (name: string) => `q 100 0 0 100 0 0 cm /${name} Do Q`;
  const formA = w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 100, 100] }, draw("ImA"));
  const formB = w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 100, 100], Resources: { Font: { F1: helv } } }, draw("ImB"));
  const ap = w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 100, 100] }, draw("ImC"));
  const glyph = w.addStream({}, `100 0 d0 ${draw("ImD")}`);
  const t3 = w.add({
    Type: n("Font"),
    Subtype: n("Type3"),
    FontBBox: [0, 0, 100, 100],
    FontMatrix: [0.01, 0, 0, 0.01, 0, 0],
    CharProcs: { g: glyph },
    Encoding: { Type: n("Encoding"), Differences: [65, n("g")] },
    FirstChar: 65,
    LastChar: 65,
    Widths: [100],
  });
  const group = w.addStream(
    { Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, W, H], Group: { S: n("Transparency"), CS: n("DeviceRGB") } },
    "q 100 0 0 100 450 400 cm /ImF Do Q",
  );
  const xobjects = w.add({ ImA: im.formNoResources, ImB: im.formNoXObject, ImC: im.appearance, ImD: im.type3, ImF: im.softMask, ImE: im.sharedPage2, FmA: formA, FmB: formB });
  const stamp = w.add({ Type: n("Annot"), Subtype: n("Stamp"), Rect: [450, 100, 550, 200], AP: { N: ap }, F: 4 });
  const page2 = [
    "q 1 0 0 1 50 400 cm /FmA Do Q",
    "q 1 0 0 1 200 400 cm /FmB Do Q",
    "BT /T3 100 Tf 320 400 Td (A) Tj ET",
    "q /GS1 gs 0 0 1 rg 450 400 100 100 re f Q",
    "q 100 0 0 100 50 200 cm /ImE Do Q",
  ].join("\n");
  return document(
    "",
    [
      { content: lineOp, resources: { Font: { F1: helv }, XObject: xobjects } },
      {
        content: page2,
        resources: { Font: { T3: t3 }, XObject: xobjects, ExtGState: { GS1: { SMask: { S: n("Luminosity"), G: group } } } },
        extra: () => ({ Annots: [stamp] }),
      },
    ],
    null,
    undefined,
    w,
  );
}

async function colourAt(bytes: ArrayBuffer, page: number, x: number, y: number): Promise<number[]> {
  const img = await pdfjsRender(new Uint8Array(bytes), page, SCALE, true);
  const o = (Math.round((H - y) * SCALE) * img.width + Math.round(x * SCALE)) * 4;
  return [img.data[o] ?? -1, img.data[o + 1] ?? -1, img.data[o + 2] ?? -1];
}

describe("pruning keeps every XObject that is still drawn", () => {
  for (const run of ["redaction", "erase"] as const) {
    it(`${run} on page 1 keeps page 2's images drawn through forms, an appearance, a Type 3 glyph, a soft mask and a shared dictionary`, async () => {
      const input = drawnThroughInheritors();
      const needles = Object.entries(KEEP).map(([k, rgb]) => needle(k, solid(rgb)));
      expect(residue(input, needles), "positive control").toEqual(needles.map((x) => x.label));
      const out = run === "redaction" ? await redact(input, 0, [LINE_RECT]) : await erase(input, 0, [LINE_RECT]);
      expect(residue(out, needles)).toEqual(needles.map((x) => x.label));
      // Page 2 renders as before where each image shows (forms, stamp, Type 3 glyph, direct draw).
      for (const [x, y] of [
        [100, 450],
        [250, 450],
        [500, 150],
        [370, 450],
        [100, 250],
      ] as const) {
        expect(await colourAt(out, 1, x, y), `page 2 at ${x},${y}`).toEqual(await colourAt(input, 1, x, y));
      }
      qpdfCheck(new Uint8Array(out));
    });
  }
});
