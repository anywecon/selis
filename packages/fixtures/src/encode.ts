/**
 * Stream filter encoders for generated fixtures (PDF 32000-1 §7.4): the inverse of
 * every non-image filter, so tests can build streams in each encoding and chain.
 * Written independently of the engine's decoders; tests check them against qpdf.
 */
import { deflateSync } from "node:zlib";

export type FilterName = "FlateDecode" | "LZWDecode" | "ASCII85Decode" | "ASCIIHexDecode" | "RunLengthDecode";

export function asciiHex(data: Uint8Array): Uint8Array {
  // Lines of 64 digits: white space must be skipped by the reader.
  const hex = Buffer.from(data).toString("hex").toUpperCase();
  return new Uint8Array(Buffer.from(`${hex.replace(/(.{64})/g, "$1\n")}>`, "latin1"));
}

export function ascii85(data: Uint8Array): Uint8Array {
  let out = "";
  for (let i = 0; i < data.length; i += 4) {
    let v = (((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)) >>> 0;
    const count = Math.min(4, data.length - i);
    if (v === 0 && count === 4) {
      out += "z";
      continue;
    }
    const digits: string[] = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode(33 + (v % 85)));
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, count + 1).join("");
    if (out.length % 76 < 5) out += "\n";
  }
  return new Uint8Array(Buffer.from(`${out}~>`, "latin1"));
}

export function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    let run = 1;
    while (i + run < data.length && run < 128 && data[i + run] === data[i]) run++;
    if (run >= 2) {
      out.push(257 - run, data[i] as number);
      i += run;
      continue;
    }
    let lit = 1;
    while (i + lit < data.length && lit < 128 && !(i + lit + 1 < data.length && data[i + lit] === data[i + lit + 1])) lit++;
    out.push(lit - 1, ...data.subarray(i, i + lit));
    i += lit;
  }
  out.push(128);
  return Uint8Array.from(out);
}

/** LZW with /EarlyChange 1 (the default), clearing the table before it fills. */
export function lzw(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number, width: number) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  };
  const widthFor = (size: number) => (size >= 2048 ? 12 : size >= 1024 ? 11 : size >= 512 ? 10 : 9);
  let table = new Map<string, number>();
  let next = 258;
  let width = 9;
  const codeOf = (s: string) => (s.length === 1 ? s.charCodeAt(0) : (table.get(s) as number));
  emit(256, width);
  let w: string | null = null;
  for (const b of data) {
    const c = String.fromCharCode(b);
    if (w === null) {
      w = c;
      continue;
    }
    const wc: string = w + c;
    if (table.has(wc)) {
      w = wc;
      continue;
    }
    emit(codeOf(w), width);
    table.set(wc, next++);
    width = widthFor(next);
    if (next >= 4094) {
      emit(256, width);
      table = new Map();
      next = 258;
      width = 9;
    }
    w = c;
  }
  if (w !== null) {
    emit(codeOf(w), width);
    width = widthFor(next + 1);
  }
  emit(257, width);
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

export function encodeOne(name: FilterName, data: Uint8Array): Uint8Array {
  switch (name) {
    case "FlateDecode":
      return new Uint8Array(deflateSync(data));
    case "LZWDecode":
      return lzw(data);
    case "ASCII85Decode":
      return ascii85(data);
    case "ASCIIHexDecode":
      return asciiHex(data);
    case "RunLengthDecode":
      return runLength(data);
  }
}

/** `data` encoded so that applying `chain` (a /Filter array, first filter first) decodes it. */
export function encodeChain(chain: readonly FilterName[], data: Uint8Array): Uint8Array {
  let out = data;
  for (const name of [...chain].reverse()) out = encodeOne(name, out);
  return out;
}
