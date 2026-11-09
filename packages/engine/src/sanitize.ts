/**
 * After PDFium has removed the page content under the redaction marks, the
 * redacted words can still sit in the document's other parts: metadata (Info,
 * XMP), the outline, named destinations, page labels, embedded files,
 * JavaScript, annotation and form strings, the structure tree. This module
 * finds the redacted words there and takes them out, then writes the file anew
 * (pdf-objects.ts: one body, no older revisions, unused objects dropped).
 * ADR 0009.
 *
 * A string "contains" a redacted term when one of the term's words (3+
 * letters or digits, not a common short word) appears in it as a whole word,
 * ignoring case and accents. That over-matches on purpose: removing a title
 * too many beats leaving one that names what was redacted.
 */
import {
  bytesToLatin1,
  decodeStream,
  nameOf,
  type PdfDict,
  PdfDocumentObjects,
  type PdfObj,
  textOf,
  textString,
  UncheckedContentError,
} from "./pdf-objects";
import { detachRemovedAnnotations } from "./residue";

/** What took the place of an outline title or a choice option that named a redacted word. */
export const REDACTED_TEXT = "█████";

/** Short words too common to identify anything (Greek and English). */
const STOPWORDS = new Set(
  [
    "the", "and", "for", "are", "was", "not", "but", "you", "our", "its", "all", "has", "had", "with", "from", "this", "that",
    "και", "του", "της", "την", "των", "τον", "τους", "στο", "στη", "στην", "στον", "στα", "για", "από", "που", "ενα", "μια",
    "ειναι", "δεν", "θα", "να", "με", "σε", "το", "τα", "οι", "η", "ο",
  ].map((w) => fold(w)),
);

/** Lower case, accents and final sigma folded: the form words are compared in. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
}

const words = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

export type TermMatcher = (text: string) => boolean;

function termKeys(terms: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const term of terms) for (const w of words(term)) if (w.length >= 3 && !STOPWORDS.has(w)) keys.add(w);
  return keys;
}

/** Whole-word matcher for the redacted terms; matches nothing when no term has a usable word. */
export function termMatcher(terms: readonly string[]): TermMatcher {
  const keys = termKeys(terms);
  if (keys.size === 0) return () => false;
  return (text) => words(text).some((w) => keys.has(w));
}

export type SanitizeReport = {
  /** One entry per thing removed or rewritten, e.g. "Info /Title", "outline title", "embedded file". */
  readonly removed: string[];
  /** The text of each annotation removed because it names a redacted word (its type when it has none). */
  readonly annotations: string[];
};

type Ctx = {
  doc: PdfDocumentObjects;
  match: TermMatcher;
  /** Whether any term has a usable word (else nothing needs reading). */
  checking: boolean;
  removed: string[];
  /** Text of the annotations removed for naming a redacted word. */
  annotations: string[];
  /** Annotations left exactly as they are (their dictionaries). */
  kept: Set<PdfDict>;
};

const isTextMatch = (ctx: Ctx, o: PdfObj | undefined): boolean => {
  const v = ctx.doc.get(o);
  return v.t === "str" && ctx.match(textOf(v.v));
};

/**
 * The text of a string or stream. Fail closed: a stream in an encoding this
 * reader cannot decode might name a redacted word, so when there are words to
 * look for, the redaction stops (`what` names it for the message).
 */
async function streamText(ctx: Ctx, o: PdfObj | undefined, what: string): Promise<string | null> {
  const v = ctx.doc.get(o);
  if (v.t === "str") return textOf(v.v);
  if (v.t !== "stream") return null;
  const data = await decodeStream(v);
  if (!data) {
    if (!ctx.checking) return null;
    throw new UncheckedContentError(`${what} cannot be read to check it for the redacted words`);
  }
  // Text in streams is Latin-1 / PDFDocEncoding (scripts, AP strings) or UTF-8 (XMP).
  return `${bytesToLatin1(data)}\n${new TextDecoder("utf-8", { fatal: false }).decode(data)}`;
}

/** Drops each key of `dict` whose text string names a redacted word. */
function dropKeys(ctx: Ctx, dict: PdfDict, keys: readonly string[], what: string): void {
  for (const k of keys) {
    if (isTextMatch(ctx, dict.get(k))) {
      dict.delete(k);
      ctx.removed.push(`${what} /${k}`);
    }
  }
}

async function sanitizeMetadata(ctx: Ctx): Promise<void> {
  const info = ctx.doc.dict(ctx.doc.trailer.get("Info"));
  if (info) for (const k of [...info.keys()]) dropKeys(ctx, info, [k], "Info");
  // XMP mirrors Info (and may hold more): drop any metadata stream that names a redacted word,
  // or that cannot be read as XML (an encoding not decoded here; PDFium can drop an
  // /ASCIIHexDecode filter and keep the hex digits as the data, measured).
  for (const obj of ctx.doc.objects.values()) {
    const dict = obj.t === "dict" ? obj.v : obj.t === "stream" ? obj.dict : null;
    const meta = dict?.get("Metadata");
    if (!dict || !meta || !ctx.checking) continue;
    const stream = ctx.doc.get(meta);
    const data = stream.t === "stream" ? await decodeStream(stream) : null;
    const text = data === null ? null : `${bytesToLatin1(data)}\n${new TextDecoder("utf-8", { fatal: false }).decode(data)}`;
    if (text === null || !/<(\?xpacket|x:xmpmeta|rdf:RDF)\b/.test(text) || ctx.match(text)) {
      dict.delete("Metadata");
      ctx.removed.push("XMP metadata");
    }
  }
}

function sanitizeOutline(ctx: Ctx, catalog: PdfDict): void {
  const seen = new Set<PdfDict>();
  const walk = (first: PdfObj | undefined) => {
    let item = ctx.doc.dict(first);
    while (item && !seen.has(item)) {
      seen.add(item);
      if (isTextMatch(ctx, item.get("Title"))) {
        item.set("Title", textString(REDACTED_TEXT));
        ctx.removed.push("outline title");
      }
      walk(item.get("First"));
      item = ctx.doc.dict(item.get("Next"));
    }
  };
  walk(ctx.doc.dict(catalog.get("Outlines"))?.get("First"));
}

/**
 * Walks a name tree, keeping the pairs `keep` accepts; /Limits follow the
 * remaining keys. `what` names a removed pair in the report.
 */
async function filterNameTree(
  ctx: Ctx,
  root: PdfObj | undefined,
  keep: (key: string, value: PdfObj) => Promise<boolean>,
  what: string,
): Promise<void> {
  const seen = new Set<PdfDict>();
  const visit = async (node: PdfDict): Promise<string[]> => {
    if (seen.has(node)) return [];
    seen.add(node);
    const keys: string[] = [];
    const names = ctx.doc.array(node.get("Names"));
    if (names) {
      const kept: PdfObj[] = [];
      for (let i = 0; i + 1 < names.length; i += 2) {
        const k = ctx.doc.get(names[i]);
        const key = k.t === "str" ? textOf(k.v) : "";
        if (await keep(key, names[i + 1] as PdfObj)) {
          kept.push(names[i] as PdfObj, names[i + 1] as PdfObj);
          keys.push(key);
        } else ctx.removed.push(what);
      }
      names.splice(0, names.length, ...kept);
    }
    for (const kid of ctx.doc.array(node.get("Kids")) ?? []) {
      const d = ctx.doc.dict(kid);
      if (d) keys.push(...(await visit(d)));
    }
    if (node.has("Limits")) {
      const sorted = [...keys].sort();
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      if (lo === undefined || hi === undefined) node.delete("Limits");
      else node.set("Limits", { t: "arr", v: [textString(lo), textString(hi)] });
    }
    return keys;
  };
  const d = ctx.doc.dict(root);
  if (d) await visit(d);
}

/** A JavaScript action (or chain) whose script names a redacted word. */
async function scriptMatches(ctx: Ctx, action: PdfObj | undefined): Promise<boolean> {
  const a = ctx.doc.dict(action);
  if (!a) return false;
  const js = a.get("JS");
  if (js) {
    const text = await streamText(ctx, js, "a script");
    if (text !== null && ctx.match(text)) return true;
  }
  return false;
}

/** Removes the JavaScript actions that name a redacted word from /OpenAction and /AA of `dict`. */
async function sanitizeActions(ctx: Ctx, dict: PdfDict): Promise<void> {
  if (await scriptMatches(ctx, dict.get("OpenAction"))) {
    dict.delete("OpenAction");
    ctx.removed.push("JavaScript");
  }
  if (await scriptMatches(ctx, dict.get("A"))) {
    dict.delete("A");
    ctx.removed.push("JavaScript");
  }
  const aa = ctx.doc.dict(dict.get("AA"));
  if (aa) {
    for (const [k, v] of [...aa]) {
      if (await scriptMatches(ctx, v)) {
        aa.delete(k);
        ctx.removed.push("JavaScript");
      }
    }
  }
}

async function sanitizeNames(ctx: Ctx, catalog: PdfDict): Promise<void> {
  const names = ctx.doc.dict(catalog.get("Names"));
  if (names) {
    await filterNameTree(ctx, names.get("Dests"), (key) => Promise.resolve(!ctx.match(key)), "named destination");
    await filterNameTree(
      ctx,
      names.get("JavaScript"),
      async (key, value) => !ctx.match(key) && !(await scriptMatches(ctx, value)),
      "JavaScript",
    );
    await filterNameTree(
      ctx,
      names.get("EmbeddedFiles"),
      async (key, value) => !ctx.match(key) && !(await fileSpecMatches(ctx, value)),
      "embedded file",
    );
  }
  // PDF 1.1 style named destinations.
  const dests = ctx.doc.dict(catalog.get("Dests"));
  if (dests) {
    for (const k of [...dests.keys()]) {
      if (ctx.match(k)) {
        dests.delete(k);
        ctx.removed.push("named destination");
      }
    }
  }
  const labels = ctx.doc.dict(catalog.get("PageLabels"));
  if (labels) {
    const seen = new Set<PdfDict>();
    const visit = (node: PdfDict) => {
      if (seen.has(node)) return;
      seen.add(node);
      const nums = ctx.doc.array(node.get("Nums")) ?? [];
      for (let i = 1; i < nums.length; i += 2) {
        const label = ctx.doc.dict(nums[i]);
        if (label && isTextMatch(ctx, label.get("P"))) {
          label.delete("P");
          ctx.removed.push("page label");
        }
      }
      for (const kid of ctx.doc.array(node.get("Kids")) ?? []) {
        const d = ctx.doc.dict(kid);
        if (d) visit(d);
      }
    };
    visit(labels);
  }
}

/** A file specification whose names, description or file content name a redacted word. */
async function fileSpecMatches(ctx: Ctx, spec: PdfObj | undefined): Promise<boolean> {
  const fs = ctx.doc.dict(spec);
  if (!fs) return isTextMatch(ctx, spec);
  if (["F", "UF", "Desc"].some((k) => isTextMatch(ctx, fs.get(k)))) return true;
  const ef = ctx.doc.dict(fs.get("EF"));
  for (const file of ef?.values() ?? []) {
    const text = await streamText(ctx, file, "an attached file");
    if (text !== null && ctx.match(text)) return true;
  }
  return false;
}

const FIELD_STRINGS = ["V", "DV"] as const;

/** Form fields: values, defaults, tooltips and option labels; their appearances when the value goes. */
async function sanitizeFields(ctx: Ctx, catalog: PdfDict): Promise<void> {
  const form = ctx.doc.dict(catalog.get("AcroForm"));
  if (!form) return;
  const seen = new Set<PdfDict>();
  const state = { regenerate: false, renamed: 0 };
  const visit = async (field: PdfDict) => {
    if (seen.has(field)) return;
    seen.add(field);
    let valueGone = false;
    for (const k of FIELD_STRINGS) {
      const v = ctx.doc.get(field.get(k));
      const text = v.t === "str" ? textOf(v.v) : v.t === "arr" ? v.v.map((x) => ctx.doc.get(x)).map((x) => (x.t === "str" ? textOf(x.v) : "")).join(" ") : null;
      if (text !== null && ctx.match(text)) {
        field.delete(k);
        ctx.removed.push(`field /${k}`);
        valueGone = true;
      }
    }
    dropKeys(ctx, field, ["TU", "TM"], "field");
    if (isTextMatch(ctx, field.get("T"))) {
      // Names are structure (a field needs one): a neutral one replaces it.
      state.renamed++;
      field.set("T", textString(`redacted_${state.renamed}`));
      ctx.removed.push("field name");
    }
    const opt = ctx.doc.array(field.get("Opt"));
    if (opt) {
      opt.forEach((o, i) => {
        const v = ctx.doc.get(o);
        const label = v.t === "arr" ? ctx.doc.get(v.v[1]) : v;
        if (label.t === "str" && ctx.match(textOf(label.v))) {
          opt[i] = v.t === "arr" ? { t: "arr", v: [textString(REDACTED_TEXT), textString(REDACTED_TEXT)] } : textString(REDACTED_TEXT);
          ctx.removed.push("field option");
          valueGone = true;
        }
      });
    }
    await sanitizeActions(ctx, field);
    const kids = ctx.doc.array(field.get("Kids")) ?? [];
    if (valueGone) {
      // The appearance shows the old value: drop it, viewers draw the field anew.
      field.delete("AP");
      for (const kid of kids) ctx.doc.dict(kid)?.delete("AP");
      state.regenerate = true;
    }
    for (const kid of kids) {
      const d = ctx.doc.dict(kid);
      if (d) await visit(d);
    }
  };
  for (const f of ctx.doc.array(form.get("Fields")) ?? []) {
    const d = ctx.doc.dict(f);
    if (d) await visit(d);
  }
  if (state.regenerate) form.set("NeedAppearances", { t: "bool", v: true });
}

/**
 * Form fields left without a widget on any page (their widget was under a
 * mark, removed by PDFium) leave /AcroForm /Fields too: a field nobody can
 * see or fill only keeps its name and tooltip around. Widget kids that are on
 * no page go from their parent the same way.
 */
function removeOrphanFields(ctx: Ctx, catalog: PdfDict): void {
  const form = ctx.doc.dict(catalog.get("AcroForm"));
  const fields = ctx.doc.array(form?.get("Fields"));
  if (!form || !fields) return;
  const onPage = new Set<PdfDict>();
  for (const page of pagesOf(ctx, catalog)) {
    for (const a of ctx.doc.array(page.get("Annots")) ?? []) {
      const d = ctx.doc.dict(a);
      if (d) onPage.add(d);
    }
  }
  const seen = new Set<PdfDict>();
  /** Whether the field (or one of its kids) still has a widget on a page; prunes the kids that do not. */
  const alive = (field: PdfDict): boolean => {
    if (seen.has(field)) return onPage.has(field);
    seen.add(field);
    const kids = ctx.doc.array(field.get("Kids"));
    if (!kids || kids.length === 0) return onPage.has(field);
    const kept = kids.filter((k) => {
      const d = ctx.doc.dict(k);
      return d !== null && alive(d);
    });
    kids.splice(0, kids.length, ...kept);
    return kept.length > 0 || onPage.has(field);
  };
  const kept = fields.filter((f) => {
    const d = ctx.doc.dict(f);
    if (d && alive(d)) return true;
    ctx.removed.push("orphan field");
    return false;
  });
  fields.splice(0, fields.length, ...kept);
}

/** Removes the form fields left without a widget on any page; returns how many went. */
export function pruneOrphanFields(doc: PdfDocumentObjects): number {
  const catalog = doc.catalog();
  if (!catalog) return 0;
  const ctx: Ctx = { doc, match: () => false, checking: false, removed: [], annotations: [], kept: new Set() };
  removeOrphanFields(ctx, catalog);
  return ctx.removed.length;
}

function pagesOf(ctx: Ctx, catalog: PdfDict): PdfDict[] {
  const pages: PdfDict[] = [];
  const seen = new Set<PdfDict>();
  const collect = (node: PdfDict) => {
    if (seen.has(node)) return;
    seen.add(node);
    const kids = ctx.doc.array(node.get("Kids"));
    if (kids) {
      for (const k of kids) {
        const d = ctx.doc.dict(k);
        if (d) collect(d);
      }
    } else pages.push(node);
  };
  const root = ctx.doc.dict(catalog.get("Pages"));
  if (root) collect(root);
  return pages;
}

/** Annotations: those whose text or drawn appearance names a redacted word go; author / subject keys go. */
async function sanitizeAnnotations(ctx: Ctx, catalog: PdfDict): Promise<void> {
  for (const page of pagesOf(ctx, catalog)) {
    await sanitizeActions(ctx, page);
    const annots = ctx.doc.array(page.get("Annots"));
    if (!annots) continue;
    const gone = new Set<PdfDict>();
    for (const a of annots) {
      const d = ctx.doc.dict(a);
      if (!d || ctx.kept.has(d)) continue;
      // Widgets are form fields: handled with their field (values, appearances).
      if (d.get("Subtype")?.t === "name" && (d.get("Subtype") as { v: string }).v === "Widget") {
        await sanitizeActions(ctx, d);
        continue;
      }
      const contents = ctx.doc.get(d.get("Contents"));
      const label = contents.t === "str" && textOf(contents.v).trim() !== "" ? textOf(contents.v).trim() : (nameOf(d.get("Subtype")) ?? "annotation");
      const texts = [d.get("Contents"), d.get("RC")];
      let named = false;
      for (const t of texts) {
        const text = t ? await streamText(ctx, t, "an annotation's text") : null;
        if (text !== null && ctx.match(text)) named = true;
      }
      const ap = ctx.doc.dict(d.get("AP"));
      const normal = ap ? ctx.doc.get(ap.get("N")) : null;
      if (!named && normal?.t === "stream") {
        const text = await streamText(ctx, normal, "an annotation's appearance");
        if (text !== null && ctx.match(text)) named = true;
      }
      if (d.get("FS") && (await fileSpecMatches(ctx, d.get("FS")))) named = true;
      if (named) {
        gone.add(d);
        const popup = ctx.doc.dict(d.get("Popup"));
        if (popup) gone.add(popup);
        ctx.removed.push("annotation");
        ctx.annotations.push(label);
        continue;
      }
      dropKeys(ctx, d, ["T", "Subj"], "annotation");
      await sanitizeActions(ctx, d);
    }
    if (gone.size > 0) {
      const kept = annots.filter((a) => {
        const d = ctx.doc.dict(a);
        return !d || !gone.has(d);
      });
      annots.splice(0, annots.length, ...kept);
    }
  }
}

function sanitizeStructure(ctx: Ctx, catalog: PdfDict): void {
  const seen = new Set<PdfDict>();
  const visit = (o: PdfObj | undefined) => {
    const v = ctx.doc.get(o);
    if (v.t === "arr") {
      for (const x of v.v) visit(x);
      return;
    }
    const d = ctx.doc.dict(o);
    if (!d || seen.has(d)) return;
    seen.add(d);
    dropKeys(ctx, d, ["Alt", "ActualText", "E", "T"], "structure");
    visit(d.get("K"));
  };
  const tree = ctx.doc.dict(catalog.get("StructTreeRoot"));
  if (tree) visit(tree.get("K"));
}

/**
 * Associated files (/AF arrays: catalog, pages, annotations, structure
 * elements, XObjects; PDF/A-3, Factur-X) that name a redacted word go from
 * every array, not only from /Names /EmbeddedFiles: the same file spec is
 * often listed in both.
 */
async function sanitizeAssociatedFiles(ctx: Ctx): Promise<void> {
  const seen = new Set<PdfObj>();
  const dicts: PdfDict[] = [];
  const visit = (o: PdfObj) => {
    if (seen.has(o)) return;
    seen.add(o);
    if (o.t === "arr") for (const x of o.v) visit(x);
    else if (o.t === "dict" || o.t === "stream") {
      const d = o.t === "dict" ? o.v : o.dict;
      if (d.has("AF")) dicts.push(d);
      for (const x of d.values()) visit(x);
    }
  };
  for (const o of ctx.doc.objects.values()) visit(o);
  for (const d of dicts) {
    const af = ctx.doc.array(d.get("AF"));
    if (!af) continue;
    const kept: PdfObj[] = [];
    for (const spec of af) {
      if (await fileSpecMatches(ctx, spec)) ctx.removed.push("associated file");
      else kept.push(spec);
    }
    if (kept.length === 0) d.delete("AF");
    else af.splice(0, af.length, ...kept);
  }
}

/** Identifiers, not text: a match there is chance (an annotation's /NM, the file /ID). */
const IDENTIFIER_KEYS = new Set(["NM", "ID"]);

/** Any other text string left that names a redacted word becomes empty. */
function sweepStrings(ctx: Ctx): void {
  const seen = new Set<PdfObj>();
  const visit = (o: PdfObj) => {
    if (seen.has(o)) return;
    seen.add(o);
    switch (o.t) {
      case "arr":
        o.v.forEach((x, i) => {
          if (x.t === "str" && ctx.match(textOf(x.v))) {
            o.v[i] = textString("");
            ctx.removed.push("text");
          } else visit(x);
        });
        return;
      case "dict":
      case "stream": {
        const d = o.t === "dict" ? o.v : o.dict;
        if (ctx.kept.has(d)) return;
        for (const [k, x] of d) {
          if (x.t === "str" && !IDENTIFIER_KEYS.has(k) && ctx.match(textOf(x.v))) {
            d.set(k, textString(""));
            ctx.removed.push(`/${k}`);
          } else visit(x);
        }
        return;
      }
      default:
    }
  };
  for (const o of ctx.doc.objects.values()) visit(o);
}

/**
 * Takes every trace of `terms` out of the document-level parts of `bytes` and
 * writes the file anew. `bytes` must not be encrypted (the caller removes the
 * encryption first). With no usable term the file is still written anew.
 * Annotations whose /NM `keep` accepts are left as they are.
 */
export async function sanitizeRedacted(
  bytes: Uint8Array,
  terms: readonly string[],
  keep: (nm: string) => boolean = () => false,
): Promise<{ bytes: Uint8Array; report: SanitizeReport }> {
  const doc = await PdfDocumentObjects.parse(bytes);
  const kept = new Set<PdfDict>();
  for (const o of doc.objects.values()) {
    const nm = o.t === "dict" ? o.v.get("NM") : undefined;
    if (o.t === "dict" && nm?.t === "str" && keep(textOf(nm.v))) kept.add(o.v);
  }
  const ctx: Ctx = { doc, match: termMatcher(terms), checking: termKeys(terms).size > 0, removed: [], annotations: [], kept };
  const catalog = doc.catalog();
  if (!catalog) throw new Error("no catalog");
  await sanitizeMetadata(ctx);
  sanitizeOutline(ctx, catalog);
  await sanitizeNames(ctx, catalog);
  await sanitizeAssociatedFiles(ctx);
  await sanitizeActions(ctx, catalog);
  await sanitizeFields(ctx, catalog);
  await sanitizeAnnotations(ctx, catalog);
  sanitizeStructure(ctx, catalog);
  removeOrphanFields(ctx, catalog);
  detachRemovedAnnotations(doc);
  sweepStrings(ctx);
  return { bytes: doc.write(), report: { removed: ctx.removed, annotations: ctx.annotations } };
}
