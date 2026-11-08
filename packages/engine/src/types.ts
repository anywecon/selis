/** Page size in PDF points (1/72 in), after the page's own /Rotate is applied. */
import type { PageRect, QuarterTurns } from "./geometry";
import type { RenderLimits } from "./limits";
import type { DeviceRect } from "./tiles";
import type { PageOp } from "./pages";

export type PageSize = { readonly width: number; readonly height: number };

/** `unchecked`: a redaction or erase met content it cannot read or prove removed, and saved nothing. */
export type EngineErrorCode = "password" | "format" | "closed" | "cancelled" | "init" | "unchecked" | "unknown";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export type OpenOptions = {
  password?: string;
};

/** One outline (bookmarks) entry; `page` is null when it points nowhere in this file. */
export type OutlineItem = { readonly title: string; readonly page: number | null; readonly children: readonly OutlineItem[] };

/** One search match: its highlight rects in page points (top-left origin, unrotated). */
export type SearchHit = { readonly rects: readonly PageRect[] };

/** A run of text on the page, for the selectable text layer (page points, unrotated). */
export type TextRun = PageRect & { readonly text: string; readonly fontSize: number };

/** A text run with its style (Export as Word, ADR 0035). */
export type StyledTextRun = TextRun & { readonly bold: boolean; readonly italic: boolean };

/** What a page carries for rebuilding its reading structure: styled text and image placements. */
export type PageContent = { readonly runs: readonly StyledTextRun[]; readonly images: readonly PageRect[] };

export type SearchOptions = {
  signal?: AbortSignal;
  /** Called per page with matches, in page order, while the search runs. */
  onHits?: (page: number, hits: readonly SearchHit[]) => void;
};

export type RenderOptions = {
  /** Aborting drops a queued render; the promise rejects with code "cancelled". */
  signal?: AbortSignal;
  /** Prefetch renders (off-screen buffer pages) yield to visible ones. */
  prefetch?: boolean;
  /** View rotation, clockwise quarter turns (not saved into the document). */
  rotation?: QuarterTurns;
  /** Night mode: lightness inverted, hues and images kept. */
  night?: boolean;
  /**
   * Render only this part of the page (a tile): a rect of the whole-page bitmap at
   * this scale (`round(width × scale)` × `round(height × scale)` after `rotation`), in
   * pixels. A tile is the same pixels as the page rendered whole (ADR 0002 amendment).
   */
  rect?: DeviceRect;
};

/** An encoded page preview, ready to store. */
export type Thumbnail = {
  readonly mime: string;
  readonly bytes: ArrayBuffer;
  readonly width: number;
  readonly height: number;
};

/** An open document inside the engine worker. */
export interface DocHandle {
  readonly id: string;
  /** Current pages: replaced (not mutated) by page operations and reloads. */
  readonly pageCount: number;
  readonly pages: readonly PageSize[];
  /** /Title from the document info dictionary, if any. */
  readonly title: string | null;
  /**
   * Renders one page. `scale` is device pixels per PDF point. The bitmap may be
   * smaller than requested when it would exceed the engine's pixel budget.
   * The caller owns the bitmap and must `close()` it (or transfer it) when done.
   */
  renderPage(index: number, scale: number, options?: RenderOptions): Promise<ImageBitmap>;
  /**
   * Same as `renderPage` but returns raw RGBA pixels. Preferred for on-screen
   * pages drawn into reused canvases: no per-render GPU/shared-memory resource.
   */
  renderPageImage(index: number, scale: number, options?: RenderOptions): Promise<ImageData>;
  /**
   * Renders a small preview of one page and encodes it in the worker (WebP;
   * JPEG where the WebView cannot encode WebP). Queued behind visible pages.
   */
  renderThumbnail(index: number, maxWidth: number, maxHeight: number, options?: RenderOptions): Promise<Thumbnail>;
  /** The document outline (bookmarks), empty when there is none. */
  outline(): Promise<OutlineItem[]>;
  /** Case-insensitive full-text search over all pages; resolves to the number of matches. */
  search(query: string, options?: SearchOptions): Promise<number>;
  /** Text runs of one page (for selection and copy). */
  textRuns(index: number): Promise<TextRun[]>;
  /** Every glyph of one page in reading order (text markup selection). */
  glyphs(index: number): Promise<readonly Glyph[]>;
  /** Annotations of one page, in drawing order. */
  annotations(index: number): Promise<Annotation[]>;
  /**
   * Adds an annotation and returns it as stored. An `id` that is already on the
   * page is replaced (redo of a removal keeps the same id).
   */
  addAnnotation(annotation: Annotation): Promise<Annotation>;
  /** Removes an annotation; resolves false if it was not there. */
  removeAnnotation(page: number, id: string): Promise<boolean>;
  /** Every form widget of the document, by page (empty without an AcroForm). */
  documentFields(): Promise<FormField[]>;
  /** Form widgets of one page, in drawing order. */
  formFields(index: number): Promise<FormField[]>;
  /** Changes a field through one of its widgets; resolves to the page's widgets after the change. */
  setFormField(page: number, id: string, change: FieldChange): Promise<FormField[]>;
  /** Turns form fields and annotations of every page into page content. Resolves to the pages changed. */
  flatten(): Promise<number>;
  /** Replaces the document's content with `bytes` (undo of flatten and page operations). */
  reload(bytes: ArrayBuffer): Promise<void>;
  /**
   * Changes the pages (rotate, delete, move, insert, duplicate, insert a PDF).
   * Resolves to the document's bytes from before, for undo. `pages` and
   * `pageCount` change; `onStructureChange` listeners are told.
   */
  editPages(op: PageOp): Promise<ArrayBuffer>;
  /**
   * Applies every redaction mark: the content under it (text, images, vector
   * art, annotations, form values) is removed from the document; whiteouts get
   * their text. Resolves to the bytes from before (undo) and the number of marks
   * applied. Like a page operation, it rebuilds the document (`onStructureChange`).
   */
  applyRedactions(): Promise<{ before: ArrayBuffer; applied: number; annotations: AreaAnnotations }>;
  /**
   * What applying the marks would also do beyond the page content (runs the
   * whole redaction on a scratch copy; the document does not change).
   */
  redactionPreview(): Promise<RedactionPreview>;
  /**
   * Erases page content (ADR 0033): text glyphs, image pixels and the parts of
   * vector paths inside `area` leave the file, and the area is filled with
   * `area.fill`. Rebuilds the document like a page operation; resolves to the
   * bytes from before (undo).
   */
  erase(area: EraseArea): Promise<{ before: ArrayBuffer; annotations: AreaAnnotations }>;
  /** The top-level objects of page `index` in drawing order (for "Delete object"). */
  pageObjects(index: number): Promise<PageObjectInfo[]>;
  /**
   * Removes one top-level object from page `index`. Rejects when the page no
   * longer has that object where it was. Resolves to the bytes from before (undo).
   */
  deleteObject(index: number, object: PageObjectInfo): Promise<{ before: ArrayBuffer }>;
  /**
   * The page's colour around the rects (median of a thin ring outside them,
   * page content only), as #rrggbb: "Match background" and the eyedropper.
   */
  sampleColor(index: number, rects: readonly PageRect[]): Promise<string>;
  /** What inserting the PDF `bytes` into this document would not carry over (ADR 0008). */
  importLosses(bytes: ArrayBuffer): Promise<ImportLosses>;
  /** The pages `indices` as a new PDF (forms kept fillable). */
  extractPages(indices: readonly number[]): Promise<ArrayBuffer>;
  /**
   * Page `index` as a PNG or JPEG at `dpi` (with annotations and form values), within the
   * engine's bitmap limit (`limits.maxBitmapPixels`; see `exportPixels`).
   */
  exportPageImage(
    index: number,
    options: {
      readonly dpi: number;
      readonly format: "png" | "jpeg";
      /** Pixel cap instead of the device tier's (OCR renders A4 at 300 dpi on every tier). */
      readonly maxPixels?: number;
    },
  ): Promise<ExportedImage>;
  /**
   * Adds an invisible text layer of `words` to page `index` (OCR, P4d), replacing a Selis OCR
   * layer it had. Resolves to the words of the layer it replaced (for undo; empty if none).
   */
  setTextLayer(index: number, words: readonly TextLayerWord[]): Promise<TextLayerWord[]>;
  /**
   * Page `index` in 8-bit grey (a binary PGM) at `dpi`, within `maxPixels` and a longest side of
   * `maxSide` px — the OCR input (P4d).
   */
  renderPageGray(index: number, options: { readonly dpi: number; readonly maxPixels: number; readonly maxSide: number }): Promise<GrayPage>;
  /** Text on page `index` besides Selis' OCR layer, and whether it has that layer. */
  pageTextInfo(index: number): Promise<PageTextInfo>;
  /** Styled text runs and image placements of page `index`, as shown (Export as Word). */
  pageContent(index: number): Promise<PageContent>;
  /** Bumped by every change to the list of pages (count, order, sizes). */
  structureRevision(): number;
  onStructureChange(listener: () => void): () => void;
  /** A one-page PDF of an annotation's appearance (to recreate it later). */
  annotationAppearance(page: number, id: string): Promise<StampImage>;
  /** Monotonic counter per page, bumped by every change to the page. */
  pageRevision(index: number): number;
  /** Called with the page index after each change; returns an unsubscribe function. */
  onPageChange(listener: (index: number) => void): () => void;
  /** The document with all changes, as a new PDF file (the original bytes stay untouched). */
  save(): Promise<ArrayBuffer>;
  close(): Promise<void>;
}

/** Side effects of applying the redaction marks, for the confirm dialog. */
export type RedactionPreview = {
  /** Text of the notes / comments elsewhere that go because they share a redacted word. */
  readonly annotations: readonly string[];
  /** The document has an owner password: the new version is written without its permission settings. */
  readonly ownerPassword: boolean;
};

/** Parts of an inserted PDF the page import drops: counts per kind (0 = none). */
export type ImportLosses = {
  readonly signatures: number;
  readonly buttons: number;
  readonly tooltips: number;
  readonly scripts: number;
};

/**
 * A word of an OCR text layer (P4d): invisible text over a scanned page, in page view
 * coordinates (points, top-left origin). The word is drawn from (`x`, `y`) on its baseline at
 * `fontSize` and stretched horizontally to `width`.
 */
export type TextLayerWord = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
};

/** A page in 8-bit grey: a binary PGM (`P5`) of `width × height` pixels. */
export type GrayPage = { readonly bytes: ArrayBuffer; readonly width: number; readonly height: number };

/** What text a page has: characters outside Selis' OCR layer, and whether it has that layer. */
export type PageTextInfo = { readonly chars: number; readonly ocr: boolean };

/** An image placed on a sheet: its box in page points, bottom-left origin (filled exactly). */
export type SheetImage = {
  readonly bytes: ArrayBuffer;
  readonly mime: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
};

/** Images → PDF (P4b), one image at a time (see `images.ts`). */
export type ImagePdfSession = {
  /** Adds a page for the image (JPEG kept as is, others decoded); resolves to the page count. */
  add(bytes: ArrayBuffer, mime: string, size: "fit" | "a4" | "letter"): Promise<number>;
  /** Adds one `width × height` pt page with several images at given boxes (an ID card's sides); resolves to the page count. */
  addSheet(width: number, height: number, items: readonly SheetImage[]): Promise<number>;
  /** The PDF; the session is over. */
  finish(): Promise<ArrayBuffer>;
  /** Drops what was built. */
  discard(): Promise<void>;
};

/** A page exported as an image. */
export type ExportedImage = { readonly bytes: ArrayBuffer; readonly mime: string; readonly width: number; readonly height: number };

export interface PdfEngine {
  open(bytes: ArrayBuffer, options?: OpenOptions): Promise<DocHandle>;
  /** Starts building a PDF from images. */
  createImagePdf(): Promise<ImagePdfSession>;
  /** Current render limits (resolution cap, bitmap budget, page cache bounds). */
  readonly limits: RenderLimits;
  /** Applies limits for this device (see `renderLimitsFor`). */
  setLimits(limits: RenderLimits): void;
  /** Loads and compiles the PDF engine ahead of the first `open` (idempotent). */
  warmUp(): Promise<void>;
  /** Terminates the worker and frees all WASM memory. */
  destroy(): void;
}

export type Point = { readonly x: number; readonly y: number };

/** Annotations over an erased or redacted area: removed, or clipped to outside it (ink, text markup). */
export type AreaAnnotations = { readonly removed: number; readonly clipped: number };

/** An area to erase from one page (ADR 0033). */
export type EraseArea = {
  readonly page: number;
  /** Rects on the page (points, top-left origin, as the viewer draws the page). */
  readonly rects: readonly PageRect[];
  /** Fill colour, #rrggbb. */
  readonly fill: string;
};

export type PageObjectKind = "text" | "path" | "image" | "shading" | "form";

/** A top-level page object: its index in drawing order, kind and bounds (top-left page points). */
export type PageObjectInfo = { readonly index: number; readonly kind: PageObjectKind; readonly rect: PageRect };

/**
 * An annotation as the editor sees it. Geometry is in page points, top-left
 * origin, on the unrotated page (like text and search rects). Colors are
 * `#rrggbb`.
 */
export type Annotation =
  | (AnnotationBase & {
      readonly kind: "highlight" | "underline" | "strikeout";
      /** One rect per selected line. */
      readonly segments: readonly PageRect[];
    })
  | (AnnotationBase & { readonly kind: "ink"; readonly width: number; readonly strokes: readonly (readonly Point[])[] })
  | (AnnotationBase & {
      readonly kind: "square" | "circle";
      readonly width: number;
      /** Interior color, null = transparent. */
      readonly fill: string | null;
    })
  | (AnnotationBase & {
      readonly kind: "line" | "arrow";
      readonly width: number;
      readonly start: Point;
      readonly end: Point;
    })
  /** Typed text, drawn with the embedded Latin + Greek font (a Stamp annotation). */
  | (AnnotationBase & { readonly kind: "text"; readonly text: string; readonly fontSize: number })
  /** Sticky note: an icon on the page with a comment (a Text annotation). */
  | (AnnotationBase & { readonly kind: "note"; readonly text: string })
  /**
   * Visual signature: a Stamp showing an image, labelled "visual signature" in
   * /Contents (not a digital signature). `image` is null when read back from a
   * file; `annotationAppearance` gives a copy that can recreate it.
   */
  | (AnnotationBase & { readonly kind: "signature"; readonly image: StampImage | null })
  /**
   * A redaction mark not applied yet (a /Redact annotation). `fill` paints the
   * area once applied: black, or white with `text` written over it (whiteout).
   */
  | (AnnotationBase & {
      readonly kind: "redact";
      readonly segments: readonly PageRect[];
      readonly fill: "black" | "white";
      readonly text: string;
    })
  /** Anything else (links, form widgets, foreign stamps…): shown, never edited. */
  | (AnnotationBase & { readonly kind: "other" });

type AnnotationBase = {
  /** /NM of the annotation (stable across saves). */
  readonly id: string;
  readonly page: number;
  /** Bounding box. */
  readonly rect: PageRect;
  readonly color: string;
  readonly opacity: number;
};

export type AnnotationKind = Annotation["kind"];

/** Image (PNG / JPEG) or one-page PDF drawn as a stamp's appearance. */
export type StampImage = {
  readonly mime: "image/png" | "image/jpeg" | "application/pdf";
  readonly bytes: ArrayBuffer;
};

export type FormFieldKind = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "button" | "signature" | "unknown";

/** One form widget (a field can have several, e.g. the options of a radio group). */
export type FormField = {
  /** /NM of the widget annotation (stable for the open document). */
  readonly id: string;
  readonly page: number;
  readonly rect: PageRect;
  /** Fully qualified field name. */
  readonly name: string;
  /** What to call the field (its /TU tooltip, else the name). */
  readonly label: string;
  readonly kind: FormFieldKind;
  /** Text value, or the field's current export value for buttons and choices. */
  readonly value: string;
  /** Checkbox / radio widget: whether this widget is on. */
  readonly checked: boolean;
  /** Choice fields: options in order. */
  readonly options: readonly { readonly label: string; readonly selected: boolean }[];
  readonly readOnly: boolean;
  readonly required: boolean;
  readonly multiline: boolean;
  readonly maxLength: number | null;
  /** Points; 0 = auto. */
  readonly fontSize: number;
  readonly fontColor: string;
};

export type FieldChange =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "checked"; readonly checked: boolean }
  | { readonly kind: "select"; readonly index: number };

/** One glyph of the page text, in logical (reading) order. */
export type Glyph = PageRect & {
  /** Index of the text run (PDF text object) the glyph belongs to. */
  readonly run: number;
  readonly space: boolean;
};
