/**
 * The stream filters redaction and erase decode (security audit run-1, lead 3 follow-up):
 * each one alone and chained, against known vectors, against an encoder written
 * separately (@selis/fixtures/encode) and against qpdf's own decoding (`--decode-level=specialized`:
 * `generalized` leaves RunLength alone). Malformed data and
 * filters still not decoded give null, so callers fail closed.
 */
import { deflateSync } from "node:zlib";
import { asciiHex, encodeChain, type FilterName, lzw } from "@selis/fixtures/encode";
import { qpdfRewrite } from "@selis/fixtures/oracle";
import { n, PdfWriter, Stream } from "@selis/fixtures/pdf-writer";
import { describe, expect, it } from "vitest";
import { ascii85Decode, asciiHexDecode, lzwDecode, runLengthDecode } from "./filters";
import { decodeStream, type PdfObj } from "./pdf-objects";

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "latin1"));

/** Deterministic, varied bytes: long enough for every LZW code width and a table clear. */
function varied(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x2545f491;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    // Mostly text-like with runs, so every filter has something to do.
    out[i] = i % 97 < 20 ? 0x41 : 0x20 + ((x >>> 0) % 90);
  }
  return out;
}

const stream = (dict: Record<string, unknown>, data: Uint8Array): Extract<PdfObj, { t: "stream" }> => {
  const map = new Map<string, PdfObj>();
  for (const [k, v] of Object.entries(dict)) map.set(k, toObj(v));
  return { t: "stream", dict: map, data };
};

function toObj(v: unknown): PdfObj {
  if (typeof v === "number") return { t: "num", v: String(v) };
  if (typeof v === "string") return { t: "name", v };
  if (v === null) return { t: "null" };
  if (Array.isArray(v)) return { t: "arr", v: v.map(toObj) };
  const m = new Map<string, PdfObj>();
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) m.set(k, toObj(x));
  return { t: "dict", v: m };
}

describe("known vectors", () => {
  it("LZW: the PDF 32000-1 example (EarlyChange 1)", () => {
    expect(Buffer.from(lzwDecode(Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]), 1)).toString("latin1")).toBe("-----A---B");
    expect(Buffer.from(lzw(bytes("-----A---B"))).toString("hex")).toBe("800b6050220c0c8501");
  });

  it("ASCII85: 'Man ' is 9jqo^, z is four zeros, a short final group", () => {
    expect(Buffer.from(ascii85Decode(bytes("9jqo^~>"))).toString("latin1")).toBe("Man ");
    expect([...ascii85Decode(bytes("z~>"))]).toEqual([0, 0, 0, 0]);
    expect(Buffer.from(ascii85Decode(bytes("<~9jqo^BlbD-~>"))).toString("latin1")).toBe("Man is d");
  });

  it("ASCIIHex: white space, either case, an odd final digit", () => {
    expect([...asciiHexDecode(bytes("4 1\n6a f>"))]).toEqual([0x41, 0x6a, 0xf0]);
  });

  it("RunLength: a literal run, a repeat run, the end marker", () => {
    expect(Buffer.from(runLengthDecode(Uint8Array.from([2, 0x61, 0x62, 0x63, 254, 0x7a, 128, 0x99]))).toString("latin1")).toBe("abczzz");
  });
});

const CHAINS: readonly (readonly FilterName[])[] = [
  ["FlateDecode"],
  ["LZWDecode"],
  ["ASCII85Decode"],
  ["ASCIIHexDecode"],
  ["RunLengthDecode"],
  ["ASCII85Decode", "FlateDecode"],
  ["ASCIIHexDecode", "FlateDecode"],
  ["ASCIIHexDecode", "LZWDecode"],
  ["ASCII85Decode", "RunLengthDecode"],
  ["ASCII85Decode", "LZWDecode"],
];

describe("each filter and chain decodes what the encoder wrote, as qpdf does", () => {
  // Not a multiple of 4: the last base-85 group is short.
  const data = varied(20_001);
  for (const chain of CHAINS) {
    it(chain.join(" + "), async () => {
      const encoded = encodeChain(chain, data);
      const dict = { Filter: chain.length === 1 ? chain[0] : [...chain] };
      expect(Buffer.from((await decodeStream(stream(dict, encoded))) ?? []).equals(Buffer.from(data))).toBe(true);
      // Independent oracle: qpdf decodes the same stream to the same bytes.
      const w = new PdfWriter(`filters-${chain.join("-")}`);
      const s = w.add(new Stream({ Filter: chain.map((x) => n(x)) }, encoded));
      const pages = w.reserve();
      w.set(pages, { Type: n("Pages"), Kids: [], Count: 0 });
      w.setRoot(w.add({ Type: n("Catalog"), Pages: pages, Data: s }));
      const decoded = Buffer.from(qpdfRewrite(w.toBytes(), ["--qdf", "--object-streams=disable", "--decode-level=specialized"]));
      expect(decoded.includes(Buffer.from(data)), "qpdf reads the encoder's output as the same bytes").toBe(true);
    });
  }

  it("predictors: Flate with TIFF 2, LZW with PNG Up", async () => {
    const columns = 30;
    const rows = Array.from({ length: 12 }, (_, r) => Uint8Array.from({ length: columns }, (_, c) => (r * 7 + c * 3) & 0xff));
    const plain = Buffer.concat(rows);
    const tiff = Buffer.concat(rows.map((row) => Buffer.from(row.map((v, i) => (i === 0 ? v : (v - (row[i - 1] as number)) & 0xff)))));
    const flate = stream({ Filter: "FlateDecode", DecodeParms: { Predictor: 2, Columns: columns, Colors: 1, BitsPerComponent: 8 } }, new Uint8Array(deflateSync(tiff)));
    expect(Buffer.from((await decodeStream(flate)) ?? []).equals(plain)).toBe(true);
    const png = Buffer.concat(rows.map((row, r) => Buffer.from([2, ...row.map((v, i) => (v - (r === 0 ? 0 : (rows[r - 1]?.[i] as number))) & 0xff)])));
    const lzwPng = stream({ Filter: ["ASCIIHexDecode", "LZWDecode"], DecodeParms: [null, { Predictor: 12, Columns: columns }] }, asciiHex(lzw(new Uint8Array(png))));
    expect(Buffer.from((await decodeStream(lzwPng)) ?? []).equals(plain)).toBe(true);
  });
});

describe("what is still not decoded gives null (the caller fails closed)", () => {
  const cases: [string, Extract<PdfObj, { t: "stream" }>][] = [
    ["a character that is not hex", stream({ Filter: "ASCIIHexDecode" }, bytes("41 4G>"))],
    ["hex without its end marker", stream({ Filter: "ASCIIHexDecode" }, bytes("4142"))],
    ["a character outside base 85", stream({ Filter: "ASCII85Decode" }, bytes("9jqo^{~>"))],
    ["z inside a base-85 group", stream({ Filter: "ASCII85Decode" }, bytes("9jzqo^~>"))],
    ["a base-85 group above 2^32", stream({ Filter: "ASCII85Decode" }, bytes("uuuuu~>"))],
    ["base 85 without its end marker", stream({ Filter: "ASCII85Decode" }, bytes("9jqo^"))],
    ["an LZW code not yet in the table", stream({ Filter: "LZWDecode" }, Uint8Array.from([0x80, 0x7f, 0xf0]))],
    ["a run-length literal past the end", stream({ Filter: "RunLengthDecode" }, Uint8Array.from([5, 0x61]))],
    ["an image codec", stream({ Filter: "DCTDecode" }, Uint8Array.from([0xff, 0xd8, 0xff]))],
    ["an unknown filter", stream({ Filter: "SelisUnknownDecode" }, bytes("plain"))],
    ["a filter chain ending in an image codec", stream({ Filter: ["ASCIIHexDecode", "JBIG2Decode"] }, bytes("41>"))],
    ["one /DecodeParms dictionary for two filters", stream({ Filter: ["ASCIIHexDecode", "FlateDecode"], DecodeParms: { Predictor: 12, Columns: 4 } }, asciiHex(new Uint8Array(deflateSync(bytes("x")))))],
    ["the TIFF predictor below 8 bits", stream({ Filter: "FlateDecode", DecodeParms: { Predictor: 2, Columns: 4, BitsPerComponent: 4 } }, new Uint8Array(deflateSync(bytes("abcd"))))],
    ["an unknown predictor", stream({ Filter: "FlateDecode", DecodeParms: { Predictor: 7 } }, new Uint8Array(deflateSync(bytes("abcd"))))],
  ];
  for (const [what, s] of cases) {
    it(what, async () => {
      expect(await decodeStream(s)).toBeNull();
    });
  }
});
