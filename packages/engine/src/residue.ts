/**
 * The last step before a redacted or erased file is written (security audit
 * run-1, leads 1 and 2): the writer keeps every object still reachable from
 * the catalog, so content under a mark survives whenever something still
 * points at it. Here, on the parsed result:
 *
 * - XObject names that no content stream draws leave their resource
 *   dictionaries (page, inherited /Pages, form, pattern, Type 3 font), so an
 *   original that was un-shared, or a copy PDFium replaced, is no longer
 *   reachable through a dictionary that only lists it;
 * - annotations removed from every page's /Annots are detached from what
 *   still points at them (a popup's /Parent, a reply's /IRT, a structure-tree
 *   OBJR), so their appearance and text do not ride along;
 * - fail closed: an un-shared original that is still reachable but that no
 *   checked content draws makes the rewrite refuse (UncheckedContentError).
 */
import { ContentSyntaxError, IDENTITY, operations, walk } from "./content-stream";
import { bytesToLatin1, decodeStream, nameOf, type PdfDict, type PdfDocumentObjects, type PdfObj, UncheckedContentError } from "./pdf-objects";

type Stream = Extract<PdfObj, { t: "stream" }>;

/** Where a dictionary is referenced from: the containing dictionary (or array) and the key. */
type Parent = { readonly holder: PdfDict | PdfObj[]; readonly key: string | number; readonly owner: PdfObj };

/** Every dictionary reachable from the trailer, with what refers to each; and every reachable stream. */
function graph(doc: PdfDocumentObjects): { parents: Map<PdfDict, Parent[]>; streams: Set<Stream> } {
  const parents = new Map<PdfDict, Parent[]>();
  const streams = new Set<Stream>();
  const seen = new Set<PdfObj>();
  const note = (d: PdfDict, p: Parent) => {
    const list = parents.get(d);
    if (list) list.push(p);
    else parents.set(d, [p]);
  };
  const child = (o: PdfObj, holder: PdfDict | PdfObj[], key: string | number, owner: PdfObj) => {
    const v = doc.get(o);
    const d = v.t === "dict" ? v.v : v.t === "stream" ? v.dict : null;
    if (d) note(d, { holder, key, owner });
    visit(v);
  };
  const visit = (o: PdfObj): void => {
    if (seen.has(o)) return;
    seen.add(o);
    if (o.t === "arr") o.v.forEach((x, i) => child(x, o.v, i, o));
    else if (o.t === "dict") for (const [k, x] of o.v) child(x, o.v, k, o);
    else if (o.t === "stream") {
      streams.add(o);
      for (const [k, x] of o.dict) child(x, o.dict, k, o);
    }
  };
  for (const k of ["Root", "Info"]) {
    const o = doc.trailer.get(k);
    if (o) child(o, doc.trailer, k, { t: "dict", v: doc.trailer });
  }
  return { parents, streams };
}

const dictOf = (o: PdfObj): PdfDict | null => (o.t === "dict" ? o.v : o.t === "stream" ? o.dict : null);

/** XObject names each resource dictionary is known to draw, and the dictionaries that could not be checked. */
class Usage {
  readonly used = new Map<PdfDict, Set<string>>();
  readonly unknown = new Set<PdfDict>();
  /** Every stream reached through a drawn name. */
  readonly drawn = new Set<Stream>();
  private readonly walked = new Set<string>();
  private readonly ids = new Map<object, number>();
  constructor(private readonly doc: PdfDocumentObjects) {}

  private id(o: object): number {
    let v = this.ids.get(o);
    if (v === undefined) {
      v = this.ids.size + 1;
      this.ids.set(o, v);
    }
    return v;
  }

  private names(res: PdfDict): Set<string> {
    let s = this.used.get(res);
    if (!s) {
      s = new Set();
      this.used.set(res, s);
    }
    return s;
  }

  /** Content `data` drawn with resources `res` (null: the content has none to draw from). */
  async content(data: Stream | readonly Stream[], res: PdfDict | null): Promise<void> {
    const parts: readonly Stream[] = "t" in data ? [data] : data;
    if (res === null) return;
    const key = `${parts.map((p) => this.id(p)).join(",")}@${this.id(res)}`;
    if (this.walked.has(key)) return;
    this.walked.add(key);
    const texts: string[] = [];
    for (const part of parts) {
      const decoded = await decodeStream(part);
      if (!decoded) {
        this.unknown.add(res);
        return;
      }
      texts.push(bytesToLatin1(decoded));
    }
    const names = this.names(res);
    const draws: string[] = [];
    try {
      walk(operations(texts.join("\n")), IDENTITY, { onDo: (e) => draws.push(e.name) });
    } catch (err) {
      if (!(err instanceof ContentSyntaxError)) throw err;
      this.unknown.add(res);
      return;
    }
    const xobjects = this.doc.dict(res.get("XObject"));
    for (const name of draws) {
      names.add(name);
      const target = this.doc.get(xobjects?.get(name));
      if (target.t !== "stream") continue;
      this.drawn.add(target);
      // A form without resources of its own draws from the ones it is drawn with.
      if (nameOf(target.dict.get("Subtype")) === "Form" && !target.dict.has("Resources")) await this.content(target, res);
    }
    await this.inheritors(res);
  }

  /** Type 3 glyphs, soft-mask groups and patterns without resources of their own use `res` too. */
  private async inheritors(res: PdfDict): Promise<void> {
    for (const font of this.doc.dict(res.get("Font"))?.values() ?? []) {
      const f = this.doc.dict(font);
      if (!f || nameOf(f.get("Subtype")) !== "Type3" || f.has("Resources")) continue;
      for (const proc of this.doc.dict(f.get("CharProcs"))?.values() ?? []) {
        const s = this.doc.get(proc);
        if (s.t === "stream") await this.content(s, res);
      }
    }
    for (const gs of this.doc.dict(res.get("ExtGState"))?.values() ?? []) {
      const group = this.doc.get(this.doc.dict(this.doc.dict(gs)?.get("SMask"))?.get("G"));
      if (group.t === "stream" && !group.dict.has("Resources")) await this.content(group, res);
    }
    for (const pattern of this.doc.dict(res.get("Pattern"))?.values() ?? []) {
      const p = this.doc.get(pattern);
      if (p.t === "stream" && !p.dict.has("Resources")) await this.content(p, res);
    }
  }
}

/** What uses a resource dictionary held under `parent`: content to walk, or null when it cannot be told. */
function contentOfOwner(doc: PdfDocumentObjects, parent: Parent, pages: Set<PdfDict>): Stream | Stream[] | "pages" | null {
  if (parent.key !== "Resources") return null;
  const owner = parent.owner;
  if (owner.t === "stream") {
    const subtype = nameOf(owner.dict.get("Subtype"));
    if (subtype === "Form" || num(owner.dict.get("PatternType")) === 1) return owner;
    return null;
  }
  if (owner.t !== "dict") return null;
  const d = owner.v;
  if (pages.has(d)) {
    const c = doc.get(d.get("Contents"));
    if (c.t === "stream") return c;
    if (c.t === "arr") return c.v.map((x) => doc.get(x)).filter((x): x is Stream => x.t === "stream");
    return [];
  }
  if (nameOf(d.get("Type")) === "Pages" || d.has("Kids")) return "pages";
  if (nameOf(d.get("Subtype")) === "Type3") {
    return [...(doc.dict(d.get("CharProcs"))?.values() ?? [])].map((x) => doc.get(x)).filter((x): x is Stream => x.t === "stream");
  }
  return null;
}

const num = (o: PdfObj | undefined): number | null => (o?.t === "num" ? Number(o.v) : null);

/**
 * Drops XObject names no content draws from every resource dictionary whose
 * users can all be checked; then refuses when an un-shared original
 * (`originals`, by data) is still reachable without anything checked drawing it.
 */
export async function pruneUnusedXObjects(doc: PdfDocumentObjects, originals: readonly Uint8Array[] = []): Promise<number> {
  const { parents } = graph(doc);
  const pageList = doc.pages();
  const pages = new Set(pageList.map((p) => p.dict));
  const usage = new Usage(doc);
  // Pages draw from their own or their inherited dictionary.
  for (const p of pageList) {
    const c = doc.get(p.dict.get("Contents"));
    const parts = c.t === "stream" ? [c] : c.t === "arr" ? c.v.map((x) => doc.get(x)).filter((x): x is Stream => x.t === "stream") : [];
    await usage.content(parts, p.resources);
  }
  // Every other holder of a /Resources dictionary.
  const resourceDicts = new Set<PdfDict>();
  for (const [d, list] of parents) {
    for (const parent of list) {
      if (parent.key !== "Resources") continue;
      resourceDicts.add(d);
      const owned = contentOfOwner(doc, parent, pages);
      if (owned === null) usage.unknown.add(d);
      else if (owned !== "pages") await usage.content(owned, d);
    }
  }
  // A resource dictionary also held under another key (an /AcroForm /DR, say) has users not checked here.
  for (const d of resourceDicts) if ((parents.get(d) ?? []).some((p) => p.key !== "Resources")) usage.unknown.add(d);
  // Each XObject subdictionary, with every resource dictionary that holds it.
  const holders = new Map<PdfDict, PdfDict[]>();
  const unknownX = new Set<PdfDict>();
  for (const res of resourceDicts) {
    const x = doc.dict(res.get("XObject"));
    if (!x) continue;
    holders.set(x, [...(holders.get(x) ?? []), res]);
  }
  for (const [x, list] of holders) {
    // Held anywhere else than under a checked dictionary's /XObject: leave it.
    const refs = parents.get(x) ?? [];
    if (refs.some((r) => r.key !== "XObject" || !(r.holder instanceof Map) || !resourceDicts.has(r.holder))) unknownX.add(x);
    if (list.some((r) => usage.unknown.has(r))) unknownX.add(x);
  }
  let pruned = 0;
  for (const [x, list] of holders) {
    if (unknownX.has(x)) continue;
    const keep = new Set<string>();
    for (const r of list) for (const n of usage.used.get(r) ?? []) keep.add(n);
    for (const name of [...x.keys()]) {
      if (keep.has(name)) continue;
      x.delete(name);
      pruned++;
    }
  }
  if (originals.length > 0) {
    // Fail closed: an original still reachable that nothing checked draws.
    for (const s of graph(doc).streams) {
      if (usage.drawn.has(s) || !originals.some((o) => sameBytes(o, s.data))) continue;
      throw new UncheckedContentError("an image or form from under the area is still in the file where it cannot be checked");
    }
  }
  return pruned;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ANNOT_SUBTYPES = new Set([
  "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly",
  "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "FileAttachment", "Sound", "Movie", "Widget", "Screen", "PrinterMark",
  "TrapNet", "Watermark", "3D", "Redact", "RichMedia", "Projection",
]);

function isAnnotation(d: PdfDict): boolean {
  if (nameOf(d.get("Type")) === "Annot") return true;
  const subtype = nameOf(d.get("Subtype"));
  return subtype !== null && ANNOT_SUBTYPES.has(subtype) && d.has("Rect");
}

/**
 * Annotations on no page any more (removed by PDFium or the sanitiser) are cut
 * loose from what still refers to them: popups whose parent is gone leave
 * /Annots, /IRT and other keys pointing at them go, structure-tree OBJR
 * entries for them go. Returns how many references were cut.
 */
export function detachRemovedAnnotations(doc: PdfDocumentObjects): number {
  const pages = doc.pages().map((p) => p.dict);
  const onPage = new Set<PdfDict>();
  const collect = () => {
    onPage.clear();
    for (const page of pages) for (const a of doc.array(page.get("Annots")) ?? []) {
      const d = doc.dict(a);
      if (d) onPage.add(d);
    }
  };
  collect();
  const gone = (o: PdfObj | undefined): boolean => {
    const d = doc.dict(o);
    return d !== null && isAnnotation(d) && !onPage.has(d);
  };
  let cut = 0;
  for (const page of pages) {
    const annots = doc.array(page.get("Annots"));
    if (!annots) continue;
    const kept = annots.filter((a) => {
      const d = doc.dict(a);
      const orphanPopup = d !== null && nameOf(d.get("Subtype")) === "Popup" && d.has("Parent") && gone(d.get("Parent"));
      if (orphanPopup) cut++;
      return !orphanPopup;
    });
    annots.splice(0, annots.length, ...kept);
  }
  collect();
  const annotLists = new Set(pages.map((p) => doc.array(p.get("Annots"))).filter((a): a is PdfObj[] => a !== null));
  const seen = new Set<PdfObj>();
  const visit = (o: PdfObj): void => {
    if (seen.has(o)) return;
    seen.add(o);
    if (o.t === "arr") {
      if (annotLists.has(o.v)) {
        for (const x of o.v) visit(doc.get(x));
        return;
      }
      const kept = o.v.filter((x) => {
        const d = doc.dict(x);
        const objr = d !== null && nameOf(d.get("Type")) === "OBJR" && gone(d.get("Obj"));
        if (gone(x) || objr) {
          cut++;
          return false;
        }
        return true;
      });
      if (kept.length !== o.v.length) o.v.splice(0, o.v.length, ...kept);
      for (const x of o.v) visit(doc.get(x));
      return;
    }
    const d = dictOf(o);
    if (!d) return;
    for (const [k, x] of [...d]) {
      if (gone(x)) {
        d.delete(k);
        cut++;
      } else visit(doc.get(x));
    }
  };
  for (const k of ["Root", "Info"]) {
    const o = doc.trailer.get(k);
    if (o) visit(doc.get(o));
  }
  return cut;
}
