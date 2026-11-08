/**
 * A small PDF object reader and writer (worker side), for the one job PDFium
 * has no API for: reading and changing the document-level objects of a
 * redacted file (metadata, outline, name trees, form and structure strings)
 * and writing the result as one fresh file with only the objects still in use
 * (ADR 0009, "full rewrite"). Page content is PDFium's business, except for
 * the erase (ADR 0033), which rewrites the paths and XObject names of one page.
 *
 * Reads classic and stream cross-reference sections (with /Prev chains),
 * object streams and the non-image stream filters (filters.ts). Encrypted files
 * are refused: their strings cannot be read without the key.
 */

import { decodeFilters, type Filter, NO_PREDICTOR } from "./filters";

export type PdfDict = Map<string, PdfObj>;
export type PdfObj =
  | { readonly t: "null" }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "num"; readonly v: string }
  | { readonly t: "str"; v: Uint8Array; hex: boolean }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "arr"; readonly v: PdfObj[] }
  | { readonly t: "dict"; readonly v: PdfDict }
  | { readonly t: "ref"; readonly num: number; readonly gen: number }
  | { readonly t: "stream"; readonly dict: PdfDict; data: Uint8Array };

export class PdfFormatError extends Error {
  override readonly name = "PdfFormatError";
}

/**
 * A redaction or erase met content it cannot read, rewrite or prove clean (a
 * stream in an encoding it does not decode, an object it cannot account for).
 * It fails closed: nothing is saved, and the user is told why.
 */
export class UncheckedContentError extends Error {
  override readonly name: string = "UncheckedContentError";
}

const NULL: PdfObj = { t: "null" };

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number) => !isWhite(c) && !isDelim(c);
const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const ascii = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** Tokenizer + object parser over a byte range; `resolveLength` reads indirect /Length values. */
class Parser {
  pos: number;
  constructor(
    private readonly b: Uint8Array,
    start: number,
    private readonly resolveLength: (ref: PdfObj) => number | null = () => null,
  ) {
    this.pos = start;
  }

  skipSpace(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos] as number;
      if (isWhite(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next regular token (keyword or number) without consuming it, or null. */
  peekWord(): string | null {
    this.skipSpace();
    let end = this.pos;
    while (end < this.b.length && isRegular(this.b[end] as number)) end++;
    return end > this.pos ? latin1(this.b.subarray(this.pos, end)) : null;
  }

  word(): string {
    const w = this.peekWord();
    if (w === null) throw new PdfFormatError(`expected a token at ${this.pos}`);
    this.pos += w.length;
    return w;
  }

  value(): PdfObj {
    this.skipSpace();
    const b = this.b;
    const c = b[this.pos];
    if (c === undefined) throw new PdfFormatError("unexpected end of file");
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) return this.dictOrStream();
      return this.hexString();
    }
    if (c === 0x5b) {
      this.pos++;
      const items: PdfObj[] = [];
      for (;;) {
        this.skipSpace();
        if (b[this.pos] === 0x5d) {
          this.pos++;
          return { t: "arr", v: items };
        }
        if (this.pos >= b.length) throw new PdfFormatError("unterminated array");
        items.push(this.value());
      }
    }
    const w = this.word();
    if (w === "true" || w === "false") return { t: "bool", v: w === "true" };
    if (w === "null") return NULL;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) throw new PdfFormatError(`unexpected token "${w}" at ${this.pos}`);
    // "N G R" is a reference.
    if (/^\d+$/.test(w)) {
      const save = this.pos;
      const gen = this.peekWord();
      if (gen !== null && /^\d+$/.test(gen)) {
        this.pos += gen.length;
        if (this.peekWord() === "R") {
          this.pos += 1;
          return { t: "ref", num: Number(w), gen: Number(gen) };
        }
      }
      this.pos = save;
    }
    return { t: "num", v: w };
  }

  private name(): PdfObj {
    const b = this.b;
    this.pos++;
    let s = "";
    while (this.pos < b.length && isRegular(b[this.pos] as number)) {
      const c = b[this.pos] as number;
      if (c === 0x23 && this.pos + 2 < b.length) {
        const hex = latin1(b.subarray(this.pos + 1, this.pos + 3));
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          s += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return { t: "name", v: s };
  }

  private literal(): PdfObj {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++] as number;
      if (c === 0x5c) {
        const n = b[this.pos++];
        if (n === undefined) break;
        const esc: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        const escaped = esc[n];
        if (escaped !== undefined) out.push(escaped);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = b[this.pos];
            if (d === undefined || d < 0x30 || d > 0x37) break;
            v = v * 8 + (d - 0x30);
            this.pos++;
          }
          out.push(v & 0xff);
        } else if (n === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (n !== 10) out.push(n);
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) return { t: "str", v: Uint8Array.from(out), hex: false };
      if (c === 13) {
        if (b[this.pos] === 10) this.pos++;
        out.push(10);
        continue;
      }
      out.push(c);
    }
    throw new PdfFormatError("unterminated string");
  }

  private hexString(): PdfObj {
    const b = this.b;
    this.pos++;
    let digits = "";
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++] as number;
      if (!isWhite(c)) digits += String.fromCharCode(c);
    }
    this.pos++;
    if (digits.length % 2 === 1) digits += "0";
    if (!/^[0-9a-fA-F]*$/.test(digits)) throw new PdfFormatError("bad hex string");
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    return { t: "str", v: out, hex: true };
  }

  private dictOrStream(): PdfObj {
    const b = this.b;
    this.pos += 2;
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipSpace();
      if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.pos >= b.length) throw new PdfFormatError("unterminated dictionary");
      const key = this.value();
      if (key.t !== "name") throw new PdfFormatError(`dictionary key is not a name at ${this.pos}`);
      dict.set(key.v, this.value());
    }
    const save = this.pos;
    if (this.peekWord() !== "stream") {
      this.pos = save;
      return { t: "dict", v: dict };
    }
    this.pos += 6;
    if (b[this.pos] === 13) this.pos++;
    if (b[this.pos] === 10) this.pos++;
    const start = this.pos;
    const lenObj = dict.get("Length") ?? NULL;
    let length = lenObj.t === "num" ? Number(lenObj.v) : this.resolveLength(lenObj);
    const endsWell = (len: number) => {
      const p = new Parser(b, start + len);
      return p.peekWord() === "endstream";
    };
    if (length === null || !Number.isInteger(length) || length < 0 || start + length > b.length || !endsWell(length)) {
      const end = indexOf(b, ascii("endstream"), start);
      if (end < 0) throw new PdfFormatError("stream without endstream");
      length = end - start;
      // The EOL before "endstream" is not data.
      if (b[start + length - 1] === 10) length--;
      if (b[start + length - 1] === 13) length--;
    }
    this.pos = start + length;
    this.word(); // endstream
    return { t: "stream", dict, data: b.slice(start, start + length) };
  }
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** FlateDecode (zlib) data for a stream. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const num = (o: PdfObj | undefined, fallback = 0): number => (o?.t === "num" ? Number(o.v) : fallback);
export const nameOf = (o: PdfObj | undefined): string | null => (o?.t === "name" ? o.v : null);

/** The /Filter chain of a stream with each filter's /DecodeParms; null when malformed. */
function filtersOf(dict: PdfDict): Filter[] | null {
  const filter = dict.get("Filter");
  const names = filter === undefined ? [] : filter.t === "arr" ? filter.v.map(nameOf) : [nameOf(filter)];
  if (names.some((x) => x === null)) return null;
  const parms = dict.get("DecodeParms") ?? dict.get("DP");
  const list = parms === undefined || parms.t === "null" ? [] : parms.t === "arr" ? parms.v : names.length === 1 ? [parms] : null;
  if (list === null) return null; // one parameter dictionary for several filters: ambiguous
  const out: Filter[] = [];
  for (const [i, name] of names.entries()) {
    const p = list[i];
    if (p !== undefined && p.t !== "null" && p.t !== "dict") return null;
    const v = p?.t === "dict" ? p.v : null;
    out.push({
      name: name as string,
      parms:
        v === null
          ? NO_PREDICTOR
          : { predictor: num(v.get("Predictor"), 1), columns: num(v.get("Columns"), 1), colors: num(v.get("Colors"), 1), bpc: num(v.get("BitsPerComponent"), 8), earlyChange: num(v.get("EarlyChange"), 1) },
    });
  }
  return out;
}

/**
 * Decoded stream data: no filter, or a chain of FlateDecode, LZWDecode, ASCII85Decode,
 * ASCIIHexDecode and RunLengthDecode (with predictors; see filters.ts). Image codecs and
 * malformed data give null: a caller that must read the stream fails closed.
 */
export async function decodeStream(s: Extract<PdfObj, { t: "stream" }>): Promise<Uint8Array | null> {
  const filters = filtersOf(s.dict);
  if (filters === null) return null;
  if (filters.length === 0) return s.data;
  return decodeFilters(s.data, filters, inflate);
}

type XrefEntry = { type: 1; offset: number } | { type: 2; stream: number; index: number };

/** A parsed document: every object by number (the newest definition), and the trailer. */
export class PdfDocumentObjects {
  readonly objects = new Map<number, PdfObj>();
  trailer: PdfDict = new Map();

  private constructor() {}

  get(o: PdfObj | undefined): PdfObj {
    if (o === undefined) return NULL;
    if (o.t !== "ref") return o;
    return this.objects.get(o.num) ?? NULL;
  }

  dict(o: PdfObj | undefined): PdfDict | null {
    const v = this.get(o);
    return v.t === "dict" ? v.v : v.t === "stream" ? v.dict : null;
  }

  array(o: PdfObj | undefined): PdfObj[] | null {
    const v = this.get(o);
    return v.t === "arr" ? v.v : null;
  }

  catalog(): PdfDict | null {
    return this.dict(this.trailer.get("Root"));
  }

  /** Adds an object under a new number; returns a reference to it. */
  add(o: PdfObj): Extract<PdfObj, { t: "ref" }> {
    let num = 1;
    for (const k of this.objects.keys()) if (k >= num) num = k + 1;
    this.objects.set(num, o);
    return { t: "ref", num, gen: 0 };
  }

  /** Page dictionaries in order, with their inherited /Resources. */
  pages(): { dict: PdfDict; resources: PdfDict | null }[] {
    const out: { dict: PdfDict; resources: PdfDict | null }[] = [];
    const seen = new Set<PdfDict>();
    const visit = (node: PdfObj | undefined, inherited: PdfDict | null) => {
      const dict = this.dict(node);
      if (!dict || seen.has(dict)) return;
      seen.add(dict);
      const resources = this.dict(dict.get("Resources")) ?? inherited;
      const kids = this.array(dict.get("Kids"));
      if (nameOf(dict.get("Type")) === "Pages" || (kids && !dict.has("Contents"))) {
        for (const kid of kids ?? []) visit(kid, resources);
      } else out.push({ dict, resources });
    };
    visit(this.catalog()?.get("Pages"), null);
    return out;
  }

  static async parse(bytes: Uint8Array): Promise<PdfDocumentObjects> {
    const doc = new PdfDocumentObjects();
    const startxref = lastIndexOf(bytes, ascii("startxref"));
    if (startxref < 0) throw new PdfFormatError("no startxref");
    const p = new Parser(bytes, startxref + 9);
    const entries = new Map<number, XrefEntry>();
    const seen = new Set<number>();
    let offset: number | null = Number(p.word());
    let first = true;
    while (offset !== null && !seen.has(offset)) {
      seen.add(offset);
      const section = await readXref(bytes, offset, entries);
      if (first) doc.trailer = section.trailer;
      first = false;
      if (section.xrefStm !== null) await readXref(bytes, section.xrefStm, entries);
      offset = section.prev;
    }
    if (doc.trailer.has("Encrypt")) throw new PdfFormatError("encrypted");

    const resolveLength = (ref: PdfObj): number | null => {
      if (ref.t !== "ref") return null;
      const e = entries.get(ref.num);
      if (e?.type !== 1) return null;
      const lp = new Parser(bytes, e.offset);
      lp.word();
      lp.word();
      lp.word();
      const v = lp.value();
      return v.t === "num" ? Number(v.v) : null;
    };
    const objStreams = new Map<number, Promise<Map<number, PdfObj>>>();
    const loadObjStream = (n: number): Promise<Map<number, PdfObj>> => {
      let loaded = objStreams.get(n);
      if (!loaded) {
        loaded = (async () => {
          const e = entries.get(n);
          if (e?.type !== 1) throw new PdfFormatError(`object stream ${n} missing`);
          const s = readObject(bytes, e.offset, resolveLength);
          if (s.t !== "stream") throw new PdfFormatError(`object ${n} is not an object stream`);
          const data = await decodeStream(s);
          if (!data) throw new PdfFormatError(`object stream ${n} has an unsupported filter`);
          const count = num(s.dict.get("N"));
          const firstAt = num(s.dict.get("First"));
          const head = new Parser(data, 0);
          const out = new Map<number, PdfObj>();
          for (let i = 0; i < count; i++) {
            const objNum = Number(head.word());
            const at = Number(head.word());
            out.set(objNum, new Parser(data, firstAt + at, resolveLength).value());
          }
          return out;
        })();
        objStreams.set(n, loaded);
      }
      return loaded;
    };
    for (const [n, e] of entries) {
      if (e.type === 1) doc.objects.set(n, readObject(bytes, e.offset, resolveLength));
      else {
        const v = (await loadObjStream(e.stream)).get(n);
        if (v !== undefined) doc.objects.set(n, v);
      }
    }
    if (!doc.catalog()) throw new PdfFormatError("no catalog");
    return doc;
  }

  /**
   * Writes the document anew: one body, one cross-reference table, only the
   * objects reachable from the trailer's /Root and /Info, numbered from 1.
   */
  write(): Uint8Array {
    const order: number[] = [];
    const renumber = new Map<number, number>();
    const visit = (o: PdfObj): void => {
      switch (o.t) {
        case "ref": {
          if (renumber.has(o.num) || !this.objects.has(o.num)) return;
          renumber.set(o.num, order.length + 1);
          order.push(o.num);
          visit(this.objects.get(o.num) as PdfObj);
          return;
        }
        case "arr":
          for (const x of o.v) visit(x);
          return;
        case "dict":
          for (const x of o.v.values()) visit(x);
          return;
        case "stream":
          for (const x of o.dict.values()) visit(x);
          return;
        default:
      }
    };
    const root = this.trailer.get("Root");
    const info = this.trailer.get("Info");
    if (!root) throw new PdfFormatError("no catalog");
    visit(root);
    if (info) visit(info);

    const chunks: Uint8Array[] = [];
    let length = 0;
    const emit = (part: Uint8Array | string) => {
      const bytes = typeof part === "string" ? ascii(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };
    emit("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
    const offsets: number[] = [];
    order.forEach((old, i) => {
      offsets.push(length);
      emit(`${i + 1} 0 obj\n`);
      serialize(this.objects.get(old) as PdfObj, renumber, emit);
      emit("\nendobj\n");
    });
    const xrefAt = length;
    emit(`xref\n0 ${order.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) emit(`${String(off).padStart(10, "0")} 00000 n \n`);
    const trailer: PdfDict = new Map([["Size", { t: "num", v: String(order.length + 1) }]]);
    trailer.set("Root", root);
    if (info && renumber.has(info.t === "ref" ? info.num : -1)) trailer.set("Info", info);
    const id = this.trailer.get("ID");
    if (id) trailer.set("ID", id);
    emit("trailer\n");
    serialize({ t: "dict", v: trailer }, renumber, emit);
    emit(`\nstartxref\n${xrefAt}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

function readObject(bytes: Uint8Array, offset: number, resolveLength: (ref: PdfObj) => number | null): PdfObj {
  const p = new Parser(bytes, offset, resolveLength);
  p.word(); // number
  p.word(); // generation
  if (p.word() !== "obj") throw new PdfFormatError(`no object at ${offset}`);
  return p.value();
}

async function readXref(
  bytes: Uint8Array,
  offset: number,
  entries: Map<number, XrefEntry>,
): Promise<{ trailer: PdfDict; prev: number | null; xrefStm: number | null }> {
  const p = new Parser(bytes, offset);
  if (p.peekWord() === "xref") {
    p.word();
    for (;;) {
      const w = p.peekWord();
      if (w === "trailer") break;
      const start = Number(p.word());
      const count = Number(p.word());
      for (let i = 0; i < count; i++) {
        const off = Number(p.word());
        p.word(); // generation
        const kind = p.word();
        if (kind === "n" && !entries.has(start + i) && off > 0) entries.set(start + i, { type: 1, offset: off });
        else if (!entries.has(start + i)) entries.set(start + i, { type: 1, offset: -1 });
      }
    }
    p.word();
    const trailer = p.value();
    if (trailer.t !== "dict") throw new PdfFormatError("bad trailer");
    const prev = trailer.v.get("Prev");
    const stm = trailer.v.get("XRefStm");
    for (const [n, e] of [...entries]) if (e.type === 1 && e.offset < 0) entries.delete(n);
    return { trailer: trailer.v, prev: prev?.t === "num" ? Number(prev.v) : null, xrefStm: stm?.t === "num" ? Number(stm.v) : null };
  }
  const s = readObject(bytes, offset, () => null);
  if (s.t !== "stream" || nameOf(s.dict.get("Type")) !== "XRef") throw new PdfFormatError("bad cross-reference section");
  const data = await decodeStream(s);
  if (!data) throw new PdfFormatError("unsupported cross-reference stream");
  const w = (s.dict.get("W")?.t === "arr" ? (s.dict.get("W") as { v: PdfObj[] }).v : []).map((x) => num(x));
  const [w0 = 1, w1 = 0, w2 = 0] = w;
  const size = num(s.dict.get("Size"));
  const index = s.dict.get("Index");
  const ranges = index?.t === "arr" ? index.v.map((x) => num(x)) : [0, size];
  const field = (at: number, width: number, fallback: number) => {
    if (width === 0) return fallback;
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + (data[at + k] as number);
    return v;
  };
  let at = 0;
  for (let r = 0; r + 1 < ranges.length; r += 2) {
    const start = ranges[r] as number;
    const count = ranges[r + 1] as number;
    for (let i = 0; i < count; i++) {
      const type = field(at, w0, 1);
      const a = field(at + w0, w1, 0);
      const b = field(at + w0 + w1, w2, 0);
      at += w0 + w1 + w2;
      if (entries.has(start + i)) continue;
      if (type === 1) entries.set(start + i, { type: 1, offset: a });
      else if (type === 2) entries.set(start + i, { type: 2, stream: a, index: b });
    }
  }
  const prev = s.dict.get("Prev");
  return { trailer: s.dict, prev: prev?.t === "num" ? Number(prev.v) : null, xrefStm: null };
}

function nameBytes(name: string): string {
  let out = "/";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += c > 0x20 && c < 0x7f && isRegular(c) && c !== 0x23 ? ch : `#${(c & 0xff).toString(16).padStart(2, "0")}`;
  }
  return out;
}

function serialize(o: PdfObj, renumber: Map<number, number>, emit: (part: Uint8Array | string) => void): void {
  switch (o.t) {
    case "null":
      emit("null");
      return;
    case "bool":
      emit(o.v ? "true" : "false");
      return;
    case "num":
      emit(o.v);
      return;
    case "name":
      emit(nameBytes(o.v));
      return;
    case "str": {
      let hex = "<";
      for (const byte of o.v) hex += byte.toString(16).padStart(2, "0");
      emit(`${hex}>`);
      return;
    }
    case "ref": {
      const n = renumber.get(o.num);
      emit(n === undefined ? "null" : `${n} 0 R`);
      return;
    }
    case "arr":
      emit("[");
      o.v.forEach((x, i) => {
        if (i > 0) emit(" ");
        serialize(x, renumber, emit);
      });
      emit("]");
      return;
    case "dict":
    case "stream": {
      const dict = o.t === "dict" ? o.v : new Map(o.dict);
      if (o.t === "stream") dict.set("Length", { t: "num", v: String(o.data.length) });
      emit("<<");
      for (const [k, v] of dict) {
        emit(nameBytes(k));
        emit(" ");
        serialize(v, renumber, emit);
      }
      emit(">>");
      if (o.t === "stream") {
        emit("\nstream\n");
        emit(o.data);
        emit("\nendstream");
      }
      return;
    }
  }
}

/** PDFDocEncoding bytes 0x18–0x1F and 0x80–0xAD that differ from Latin-1. */
const PDFDOC: Record<number, string> = {
  0x18: "˘", 0x19: "ˇ", 0x1a: "ˆ", 0x1b: "˙", 0x1c: "˝", 0x1d: "˛", 0x1e: "˚", 0x1f: "˜",
  0x80: "•", 0x81: "†", 0x82: "‡", 0x83: "…", 0x84: "—", 0x85: "–", 0x86: "ƒ", 0x87: "⁄",
  0x88: "‹", 0x89: "›", 0x8a: "−", 0x8b: "‰", 0x8c: "„", 0x8d: "“", 0x8e: "”", 0x8f: "‘",
  0x90: "’", 0x91: "‚", 0x92: "™", 0x93: "ﬁ", 0x94: "ﬂ", 0x95: "Ł", 0x96: "Œ", 0x97: "Š",
  0x98: "Ÿ", 0x99: "Ž", 0x9a: "ı", 0x9b: "ł", 0x9c: "œ", 0x9d: "š", 0x9e: "ž", 0xa0: "€",
};

/** A PDF text string as Unicode (UTF-16BE/LE with BOM, UTF-8 with BOM, else PDFDocEncoding). */
export function textOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  let s = "";
  for (const b of bytes) s += PDFDOC[b] ?? String.fromCharCode(b);
  return s;
}

/** A PDF text string for `text` (UTF-16BE with a BOM). */
export function textString(text: string): PdfObj {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    out[2 + i * 2] = text.charCodeAt(i) >> 8;
    out[3 + i * 2] = text.charCodeAt(i) & 0xff;
  }
  return { t: "str", v: out, hex: true };
}

/** Bytes as Latin-1 text (for searching decoded streams), and back. */
export { latin1 as bytesToLatin1, ascii as latin1ToBytes };
