/**
 * Stream filters this engine decodes (PDF 32000-1 §7.4): FlateDecode, LZWDecode,
 * ASCII85Decode, ASCIIHexDecode and RunLengthDecode, alone or chained, with the
 * PNG and TIFF predictors. Image codecs (DCT, JPX, CCITT, JBIG2) and Crypt are not
 * decoded. Every decoder is strict: malformed data gives null, never a guess, so a
 * caller that must read a stream (redaction, erase) fails closed instead of treating
 * it as clean (security audit run-1, lead 3).
 */

/** What a filter's /DecodeParms says about a predictor. */
export type Predictor = {
  readonly predictor: number;
  readonly columns: number;
  readonly colors: number;
  readonly bpc: number;
  /** LZW only: /EarlyChange (default 1). */
  readonly earlyChange: number;
};

export const NO_PREDICTOR: Predictor = { predictor: 1, columns: 1, colors: 1, bpc: 8, earlyChange: 1 };

/** Thrown inside a decoder for malformed data; `decodeFilters` turns it into null. */
class BadData extends Error {}

/**
 * Most bytes one stream may decode to (all filters of a chain together): content, forms,
 * attachments and XMP are far smaller; past this a crafted stream (a Flate or LZW bomb, a
 * chain of them) would only exhaust the worker's memory. Over it, the stream is not decoded
 * and callers fail closed.
 */
export const MAX_DECODED_BYTES = 128 * 1024 * 1024;

const isWhite = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/** ASCIIHexDecode: hex digit pairs, white space ignored, `>` ends; an odd last digit is followed by 0. */
export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let n = 0;
  let high = -1;
  let ended = false;
  for (const c of data) {
    if (c === 0x3e) {
      ended = true;
      break;
    }
    if (isWhite(c)) continue;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v < 0) throw new BadData("not a hex digit");
    if (high < 0) high = v;
    else {
      out[n++] = (high << 4) | v;
      high = -1;
    }
  }
  if (!ended) throw new BadData("no end-of-data marker");
  if (high >= 0) out[n++] = high << 4;
  return out.subarray(0, n);
}

/** ASCII85Decode: base-85 groups of five (`z` for four zero bytes), white space ignored, `~>` ends. */
export function ascii85Decode(data: Uint8Array): Uint8Array {
  // At most 4 bytes per character (`z`): a typed array drops writes past its end silently.
  const out = new Uint8Array(data.length * 4 + 4);
  let n = 0;
  const group: number[] = [];
  let i = 0;
  // An optional "<~" prefix (as PostScript writes it).
  while (i < data.length && isWhite(data[i] as number)) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2;
  let ended = false;
  for (; i < data.length; i++) {
    const c = data[i] as number;
    if (isWhite(c)) continue;
    if (c === 0x7e) {
      let k = i + 1;
      while (k < data.length && isWhite(data[k] as number)) k++;
      if (data[k] !== 0x3e) throw new BadData("~ without >");
      ended = true;
      break;
    }
    if (c === 0x7a) {
      if (group.length !== 0) throw new BadData("z inside a group");
      out.fill(0, n, n + 4);
      n += 4;
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new BadData("not a base-85 digit");
    group.push(c - 0x21);
    if (group.length === 5) {
      n = put85(out, n, group, 4);
      group.length = 0;
    }
  }
  if (!ended) throw new BadData("no end-of-data marker");
  if (group.length === 1) throw new BadData("a final group of one digit");
  if (group.length > 0) {
    const bytes = group.length - 1;
    while (group.length < 5) group.push(84);
    n = put85(out, n, group, bytes);
  }
  return out.subarray(0, n);
}

function put85(out: Uint8Array, n: number, group: readonly number[], bytes: number): number {
  let v = 0;
  for (const d of group) v = v * 85 + d;
  if (v > 0xffffffff) throw new BadData("a group above 2^32");
  for (let k = 0; k < bytes; k++) out[n + k] = (v >>> (24 - 8 * k)) & 0xff;
  return n + bytes;
}

/** RunLengthDecode: a length byte, then 1–128 literal bytes or one byte repeated 2–128 times; 128 ends. */
export function runLengthDecode(data: Uint8Array, limit = MAX_DECODED_BYTES): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let i = 0;
  for (;;) {
    if (i >= data.length) break; // a missing end marker is tolerated (as PDF readers do)
    const len = data[i++] as number;
    if (len === 128) break;
    if (len < 128) {
      if (i + len + 1 > data.length) throw new BadData("a literal run past the end");
      chunks.push(data.subarray(i, i + len + 1));
      size += len + 1;
      i += len + 1;
    } else {
      if (i >= data.length) throw new BadData("a repeat run past the end");
      chunks.push(new Uint8Array(257 - len).fill(data[i++] as number));
      size += 257 - len;
    }
    if (size > limit) throw new BadData("decodes past the size limit");
  }
  return concat(chunks, size);
}

/** LZWDecode: 9–12-bit codes, 256 clears, 257 ends; `earlyChange` 1 (the default) or 0. */
export function lzwDecode(data: Uint8Array, earlyChange: number, limit = MAX_DECODED_BYTES): Uint8Array {
  if (earlyChange !== 0 && earlyChange !== 1) throw new BadData("bad /EarlyChange");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let table: Uint8Array[] = [];
  const reset = () => {
    table = [];
    for (let c = 0; c < 256; c++) table.push(Uint8Array.of(c));
    table.push(new Uint8Array(), new Uint8Array()); // 256 clear, 257 end
  };
  reset();
  let width = 9;
  let prev: Uint8Array | null = null;
  let bits = 0;
  let acc = 0;
  let i = 0;
  for (;;) {
    while (bits < width && i < data.length) {
      acc = ((acc << 8) | (data[i++] as number)) >>> 0;
      bits += 8;
    }
    if (bits < width) break; // out of data without an end code: tolerated
    const code = (acc >>> (bits - width)) & ((1 << width) - 1);
    bits -= width;
    acc &= (1 << bits) - 1;
    if (code === 256) {
      reset();
      width = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry: Uint8Array;
    if (code < table.length) entry = table[code] as Uint8Array;
    else if (code === table.length && prev !== null) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0] as number;
    } else throw new BadData("an LZW code not in the table");
    chunks.push(entry);
    size += entry.length;
    if (size > limit) throw new BadData("decodes past the size limit");
    if (prev !== null && table.length < 4096) {
      const next = new Uint8Array(prev.length + 1);
      next.set(prev);
      next[prev.length] = entry[0] as number;
      table.push(next);
    }
    prev = entry;
    const next = table.length + earlyChange;
    width = next >= 2048 ? 12 : next >= 1024 ? 11 : next >= 512 ? 10 : 9;
  }
  return concat(chunks, size);
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** PNG row predictors (10–15): each row starts with its own predictor byte. */
export function unpredictPng(data: Uint8Array, columns: number, colors: number, bpc: number): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  // A partial last row would be decoded by PDFium but not here: refuse rather than guess.
  if (data.length % (rowLen + 1) !== 0) throw new BadData("a partial predictor row");
  const rows = data.length / (rowLen + 1);
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)] as number;
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const raw = row[i] as number;
      const left = i >= bpp ? (cur[i - bpp] as number) : 0;
      const up = prev[i] as number;
      const upLeft = i >= bpp ? (prev[i - bpp] as number) : 0;
      let v: number;
      switch (type) {
        case 0:
          v = raw;
          break;
        case 1:
          v = raw + left;
          break;
        case 2:
          v = raw + up;
          break;
        case 3:
          v = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new BadData(`unknown PNG predictor ${type}`);
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

/** TIFF predictor 2 (horizontal differencing), 8 bits per component only. */
function unpredictTiff(data: Uint8Array, columns: number, colors: number, bpc: number): Uint8Array {
  if (bpc !== 8) throw new BadData("TIFF predictor below 8 bits per component");
  const rowLen = columns * colors;
  if (data.length % rowLen !== 0) throw new BadData("a partial predictor row");
  const out = data.slice();
  for (let r = 0; r + rowLen <= out.length; r += rowLen) {
    for (let i = colors; i < rowLen; i++) out[r + i] = ((out[r + i] as number) + (out[r + i - colors] as number)) & 0xff;
  }
  return out;
}

/** Predictor parameters PDF readers accept (PDF 32000-1 Table 8); anything else is refused. */
function validPredictor(p: Predictor): boolean {
  const int = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
  return int(p.columns, 1, 1 << 20) && int(p.colors, 1, 32) && [1, 2, 4, 8, 16].includes(p.bpc);
}

function unpredict(data: Uint8Array, p: Predictor): Uint8Array {
  if (p.predictor === 1) return data;
  if (!validPredictor(p)) throw new BadData("bad predictor parameters");
  if (p.predictor === 2) return unpredictTiff(data, p.columns, p.colors, p.bpc);
  if (p.predictor >= 10 && p.predictor <= 15) return unpredictPng(data, p.columns, p.colors, p.bpc);
  throw new BadData(`unknown predictor ${p.predictor}`);
}

export type Filter = { readonly name: string; readonly parms: Predictor };

/**
 * Applies `filters` in order (the /Filter array). Null when a filter is not one of the
 * five above, the data is malformed, or it decodes past `limit` bytes. `inflate` is passed
 * in (the platform's zlib) and gives null past its limit.
 */
export async function decodeFilters(
  data: Uint8Array,
  filters: readonly Filter[],
  inflate: (d: Uint8Array, limit: number) => Promise<Uint8Array | null>,
  limit = MAX_DECODED_BYTES,
): Promise<Uint8Array | null> {
  let out = data;
  try {
    for (const f of filters) {
      switch (f.name) {
        case "FlateDecode":
        case "Fl": {
          const inflated = await inflate(out, limit);
          if (inflated === null) return null;
          out = unpredict(inflated, f.parms);
          break;
        }
        case "LZWDecode":
        case "LZW":
          out = unpredict(lzwDecode(out, f.parms.earlyChange, limit), f.parms);
          break;
        case "ASCII85Decode":
        case "A85":
          out = ascii85Decode(out);
          break;
        case "ASCIIHexDecode":
        case "AHx":
          out = asciiHexDecode(out);
          break;
        case "RunLengthDecode":
        case "RL":
          out = runLengthDecode(out, limit);
          break;
        default:
          return null;
      }
      if (out.length > limit) return null;
    }
  } catch (e) {
    if (e instanceof BadData) return null;
    throw e;
  }
  return out;
}
