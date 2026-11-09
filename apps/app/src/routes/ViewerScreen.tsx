import { type AreaAnnotations, EngineError, nextTurn, type QuarterTurns } from "@selis/engine";
import { Button, EmptyState, Skeleton } from "@selis/ui";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DocumentGlyph } from "../components/Illustrations";
import { useToast } from "../components/Toast";
import { AnnotateBar, ToolSheet } from "../features/annotate/AnnotateChrome";
import { AnnotationLayer } from "../features/annotate/AnnotationLayer";
import type { Command, EditSession, SaveStatus, SessionState } from "../features/annotate/session";
import { useTools as useAnnotateTools } from "../features/annotate/tools";
import { EraseLayer } from "../features/erase/EraseLayer";
import { EraseOptions } from "../features/erase/EraseOptions";
import {
  addAnnotations,
  applyEraseCommand,
  deleteObjectCommand,
  selectedObject,
  useEraseState,
  versionNote,
} from "../features/erase/eraseState";
import { FormBanner, FormSheet } from "../features/forms/FormChrome";
import { FormLayer } from "../features/forms/FormLayer";
import { flattenCommand, useFormState } from "../features/forms/formState";
import { useDocStructure } from "../features/pages/pageCommands";
import { PagesMode } from "../features/pages/PagesMode";
import { RedactLayer } from "../features/redact/RedactLayer";
import { applyCommand, discardCommand, useRedactState } from "../features/redact/redactState";
import { EarlierVersionsSheet } from "../features/redact/EarlierVersionsSheet";
import { RedactSheet } from "../features/redact/RedactSheet";
import { SignatureLayer, useSignState } from "../features/sign/SignatureLayer";
import { SignSheet } from "../features/sign/SignSheet";
import { PdfViewer, type PdfViewerHandle, type ScrollInfo } from "../features/viewer/PdfViewer";
import { shareDocument } from "../features/viewer/share";
import { type OpenState, useOpenDocument } from "../features/viewer/useOpenDocument";
import { useDocumentSearch } from "../features/viewer/useDocumentSearch";
import { PageChip, Scrubber, ViewerDock, ViewerSearchBar, ViewerTopBar } from "../features/viewer/ViewerChrome";
import { OcrCard } from "../features/ocr/OcrCard";
import { useOcr } from "../features/ocr/ocrStore";
import { useTools } from "../features/tools/toolsStore";
import { useExport } from "../features/convert/exportStore";
import { UnlockSheet } from "../features/tools/UnlockSheet";
import { OutlineSheet, ThumbnailsSheet, ViewerMoreSheet } from "../features/viewer/ViewerSheets";
import { api } from "../lib/api";
import { currentRenderLimits } from "../lib/engine";
import { useNavigation, useOverlay } from "../state/navigation";
import { useSettings } from "../state/settings";

const THUMB_PIXEL_BUDGET = 250_000;
/** Page chip and scrubber fade out this long after scrolling stops. */
const CHIP_HIDE_MS = 1_500;
/** Reading position is saved after the reader settles on a page. */
const SAVE_PAGE_MS = 800;
/** Room under the last page for the floating dock (64 + 28 + breathing room). */
const DOCK_SPACE = 112;
/** Notes quoted by name in the redaction confirm; the rest are counted. */
const MAX_LISTED_NOTES = 3;
const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);
/** Scrolling this far down hides the dock; up shows it again. */
const DOCK_SCROLL_PX = 8;

function errorBody(state: Extract<OpenState, { status: "error" }>): string {
  switch (state.code) {
    case "password":
      return "viewer.errorPassword";
    case "format":
      return "viewer.errorFormat";
    default:
      return "viewer.errorGeneric";
  }
}

/** Fixed-geometry placeholder (A4 ratio) shown while the document opens. */
function ViewerSkeleton({ insetTop }: { insetTop: number }) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-hidden bg-page-canvas px-4" style={{ paddingTop: insetTop + 12 }} aria-busy="true">
      <span className="sr-only">{t("viewer.loading")}</span>
      <Skeleton className="w-full rounded-[2px]" style={{ aspectRatio: "595 / 842" }} />
    </div>
  );
}

type Variant = "phone" | "tablet";
type ViewerSheet = "more" | "outline" | "thumbnails" | null;
type Mode = "view" | "annotate" | "sign" | "form" | "pages" | "redact";

const MODE_TITLES: Record<Exclude<Mode, "view" | "pages">, { title: string; close: string }> = {
  annotate: { title: "annotate.title", close: "annotate.close" },
  sign: { title: "sign.title", close: "sign.close" },
  form: { title: "forms.title", close: "forms.close" },
  redact: { title: "redact.title", close: "redact.close" },
};

const NO_SESSION: SessionState = { status: "saved", canUndo: false, canRedo: false, undoTool: null };
const noop = () => () => undefined;
const NO_ANNOTATIONS: AreaAnnotations = { removed: 0, clipped: 0 };

function useSessionState(session: EditSession | null): SessionState {
  return useSyncExternalStore(session?.subscribe ?? noop, session?.getState ?? (() => NO_SESSION));
}

const STATUS_KEYS: Record<SaveStatus, string> = {
  saved: "annotate.statusSaved",
  autosaved: "annotate.statusSaved",
  saving: "annotate.statusSaving",
  error: "annotate.statusError",
};

/**
 * Document view (docs/design/p1-ui-brief.md §2): top bar with title and page,
 * page chip, scrubber, floating dock, search, outline / thumbnails sheets,
 * rotate and night mode. Tablet adds a thumbnails strip.
 */
export function ViewerScreen({ docId, variant }: { docId: string; variant: Variant }) {
  const { t } = useTranslation();
  const back = useNavigation((s) => s.back);
  const showToast = useToast((s) => s.show);
  const night = useSettings((s) => s.nightMode);
  const setNight = useSettings((s) => s.setNightMode);
  // A tool saved a new version: open the document again.
  const [reloadKey, setReloadKey] = useState(0);
  const state = useOpenDocument(docId, reloadKey);
  const [chrome, setChrome] = useState(true);
  const [dockHidden, setDockHidden] = useState(false);
  const [page, setPage] = useState(0);
  const [fraction, setFraction] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [barHeight, setBarHeight] = useState(0);
  const [rotation, setRotation] = useState<QuarterTurns>(0);
  const [sheet, setSheet] = useState<ViewerSheet>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("view");
  const [sheetHeight, setSheetHeight] = useState(0);
  const barRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const mainRef = useRef<PdfViewerHandle>(null);
  const hideTimer = useRef<number | null>(null);

  const doc = state.status === "ready" ? state.doc : null;
  const session = state.status === "ready" ? state.session : null;
  const annotateTool = useAnnotateTools((s) => s.tool);
  const sessionState = useSessionState(session);
  // Any editing mode (annotate, sign, form, pages): its own top bar and bottom sheet / bar.
  const editing = mode !== "view" && doc !== null && session !== null;
  const annotating = editing && mode !== "pages";
  const pagesMode = editing && mode === "pages";
  // Page operations (and their undo) replace the list of pages: the viewer is
  // rebuilt for it and resumes at the same page number (or the last one).
  const structure = useDocStructure(doc);
  const [seenStructure, setSeenStructure] = useState(structure);
  const [resumePage, setResumePage] = useState<number | null>(null);
  if (structure !== seenStructure && doc) {
    setSeenStructure(structure);
    const clamped = Math.min(page, doc.pageCount - 1);
    setResumePage(clamped);
    setPage(clamped);
  }
  const search = useDocumentSearch(searching ? doc : null, query);

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
  }, []);
  useOverlay(searching, closeSearch);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarHeight(bar.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
    // Each of these swaps the top bar for another element: measure the new one.
  }, [searching, annotating, pagesMode]);

  // The tool sheet covers the bottom of the pages: reserve its height.
  useLayoutEffect(() => {
    const sheetEl = sheetRef.current;
    if (!annotating || !sheetEl) {
      setSheetHeight(0);
      return;
    }
    const measure = () => setSheetHeight(sheetEl.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheetEl);
    return () => observer.disconnect();
  }, [annotating]);

  // Leaving the app (switch, lock): write the working copy now, it may be killed.
  useEffect(() => {
    if (!session) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") void session.autosave().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [session]);

  const recovered = state.status === "ready" && state.recovered;
  useEffect(() => {
    if (recovered) showToast(t("recovery.restored"));
  }, [recovered, showToast, t]);

  // The form's fields, for the banner and form mode (empty without an AcroForm).
  const setFormFields = useFormState((s) => s.setFields);
  useEffect(() => {
    if (!doc) return;
    const request = { live: true };
    void (async () => {
      try {
        const fields = await doc.documentFields();
        if (request.live) setFormFields(fields);
      } catch (err) {
        console.warn("selis: form fields unavailable", err);
      }
    })();
    return () => {
      request.live = false;
      setFormFields(null);
    };
  }, [doc, structure, setFormFields]);

  // The library shows the page count: keep it right after page operations.
  useEffect(() => {
    if (!doc || structure === 0) return;
    void api.recordDocumentInfo(docId, doc.pageCount, null).catch(() => undefined);
  }, [doc, docId, structure]);

  /** The sheet that offers to delete the versions from before a redaction. */
  const [earlierVersions, setEarlierVersions] = useState(false);
  const [confirmDeleteEarlier, setConfirmDeleteEarlier] = useState(false);
  const [deletingEarlier, setDeletingEarlier] = useState(false);
  /** Annotations over the marks that the redactions since the last version removed (its note). */
  const redactedAnnotations = useRef<AreaAnnotations>(NO_ANNOTATIONS);

  /**
   * Leaves the editing mode; the session's edits become a version. Redaction
   * marks that were not applied are taken away first: a saved version never
   * shows a black box over content that is still there.
   */
  const finishAnnotating = useCallback(() => {
    setMode("view");
    // Back in view mode the actions show again, even if the page scrolled down meanwhile.
    setDockHidden(false);
    useSignState.getState().activate(null);
    useFormState.getState().setActive(null);
    // Erase strokes are a preview: nothing of them is in the document to save.
    const strokes = useEraseState.getState().strokes.length;
    useEraseState.getState().reset();
    if (strokes > 0) showToast(t("erase.discarded", { count: strokes }));
    if (!session || !doc) return;
    const pending = [...useRedactState.getState().marks.values()];
    void (async () => {
      try {
        if (pending.length > 0) {
          await session.run(discardCommand(doc, pending));
          showToast(t("redact.discarded", { count: pending.length }));
        }
        // A redacted version notes the annotations it removed over the marks.
        const redacted = useRedactState.getState().applied > 0;
        const saved = await session.commit("manual", redacted ? versionNote(redactedAnnotations.current) : null);
        redactedAnnotations.current = NO_ANNOTATIONS;
        // A redacted version: the earlier ones still have the removed content (ADR 0009).
        useRedactState.getState().resetApplied();
        if (redacted && saved && saved.seq > 1) setEarlierVersions(true);
      } catch (err) {
        console.warn("selis: saving the annotations failed", err);
        showToast(t("annotate.saveFailed"), "error");
      }
    })();
  }, [session, doc, showToast, t]);
  useOverlay(annotating, finishAnnotating);

  // Tools work on the current version: pending edits become a version first.
  const openTools = async () => {
    setSheet(null);
    try {
      await session?.commit();
    } catch {
      showToast(t("annotate.saveFailed"), "error");
      return;
    }
    const pageContext =
      state.status === "ready" ? { doc: state.doc, page, title: title || t("library.untitled"), session: state.session } : undefined;
    void useTools.getState().open(docId, () => setReloadKey((key) => key + 1), pageContext);
  };

  // An OCR job belongs to this open document: it stops where it is when the viewer goes.
  useEffect(
    () => () => {
      if (useOcr.getState().docId === docId) useOcr.getState().reset();
    },
    [docId],
  );

  const startEditing = (next: Exclude<Mode, "view">) => {
    // Page operations and redaction renumber or rewrite pages: a running OCR job stops first
    // (the pages it finished stay).
    if ((next === "pages" || next === "redact") && useOcr.getState().docId === docId) useOcr.getState().reset();
    // Editing an encrypted file is not supported (docs/design/p4-ui-brief.md §1).
    if (state.status === "ready" && state.locked) {
      setSheet(null);
      showToast(t("tools.lockedEdit"));
      return;
    }
    // Back from the pages grid, the viewer opens at the page it was on.
    if (next === "pages") setResumePage(page);
    // Editing works on the unrotated page with the chrome shown.
    setRotation(0);
    setSearching(false);
    setQuery("");
    setSheet(null);
    setChrome(true);
    setDockHidden(false);
    setMode(next);
  };

  const deleteEarlierVersions = async () => {
    setConfirmDeleteEarlier(false);
    setDeletingEarlier(true);
    try {
      const removed = await api.deleteEarlierVersions(docId);
      showToast(t("redact.earlierDeleted", { count: removed }));
    } catch (err) {
      console.warn("selis: deleting earlier versions failed", err);
      showToast(t("redact.earlierFailed"), "error");
    } finally {
      setDeletingEarlier(false);
      setEarlierVersions(false);
    }
  };

  /** Side effects listed in the confirm dialog; null while it is closed. */
  const [confirmRedact, setConfirmRedact] = useState<readonly string[] | null>(null);
  const [checkingRedact, setCheckingRedact] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const redactCount = useRedactState((s) => s.marks.size);
  /** Opens the confirm dialog with what the redaction also does beyond the marked areas. */
  const askRedact = async () => {
    if (!doc) return;
    const details: string[] = [];
    if (state.status === "ready" && state.meta.kind === "linked") details.push(t("redact.sideLinked"));
    setCheckingRedact(true);
    try {
      const preview = await doc.redactionPreview();
      if (preview.annotations.length > 0) {
        const shown = preview.annotations.slice(0, MAX_LISTED_NOTES).map((text) => t("redact.sideNoteQuote", { text: clip(text) }));
        const list = shown.join(", ") + (preview.annotations.length > MAX_LISTED_NOTES ? "…" : "");
        details.push(t("redact.sideNotes", { count: preview.annotations.length, list }));
      }
      if (preview.ownerPassword) details.push(t("redact.sideOwnerPassword"));
    } catch (err) {
      // The dialog still opens; applying reports its own failure.
      console.warn("selis: redaction preview failed", err);
    } finally {
      setCheckingRedact(false);
    }
    setConfirmRedact(details);
  };
  const applyRedactions = async () => {
    setConfirmRedact(null);
    if (!doc || !session) return;
    setRedacting(true);
    try {
      await session.run(
        applyCommand(doc, (count, annotations) => {
          redactedAnnotations.current = addAnnotations(redactedAnnotations.current, annotations);
          showToast(t("redact.applied", { count }));
        }),
      );
    } catch (err) {
      console.warn("selis: redaction failed", err);
      showToast(t(err instanceof EngineError && err.code === "unchecked" ? "redact.unchecked" : "redact.failed"), "error");
    } finally {
      setRedacting(false);
    }
  };

  // Erase (ADR 0033): every apply is its own version labelled "erase"; a signed
  // document warns once per opening that erasing invalidates the signature.
  const [erasing, setErasing] = useState(false);
  const [signedAsk, setSignedAsk] = useState<(() => void) | null>(null);
  const signedWarned = useRef(false);
  const eraseSelection = useEraseState((s) => s.selection);
  useEffect(() => {
    signedWarned.current = false;
    return () => useEraseState.getState().reset();
  }, [docId]);
  // A rebuilt document has new page objects: a picked one no longer applies.
  useEffect(() => {
    useEraseState.getState().select(null);
  }, [structure]);

  const runErase = async (command: Command, done: string, touched: () => AreaAnnotations) => {
    if (!session) return;
    setErasing(true);
    try {
      // Pending annotation edits become their own version first.
      await session.commit();
      await session.run(command);
      const annotations = touched();
      await session.commit("erase", versionNote(annotations));
      showToast(versionNote(annotations) ? t("erase.appliedAnnotations", { ...annotations }) : t(done));
    } catch (err) {
      console.warn("selis: erase failed", err);
      showToast(t(err instanceof EngineError && err.code === "unchecked" ? "erase.unchecked" : "erase.failed"), "error");
    } finally {
      setErasing(false);
    }
  };
  const afterSignatureCheck = async (action: () => void) => {
    if (!doc) return;
    if (!signedWarned.current) {
      let signed = false;
      try {
        signed = (await doc.documentFields()).some((f) => f.kind === "signature");
      } catch (err) {
        console.warn("selis: signature check failed", err);
      }
      if (signed) {
        setSignedAsk(() => () => {
          signedWarned.current = true;
          action();
        });
        return;
      }
    }
    action();
  };
  const applyErase = () => {
    if (!doc) return;
    let touched: AreaAnnotations = { removed: 0, clipped: 0 };
    const command = applyEraseCommand(doc, (annotations) => {
      touched = annotations;
    });
    void afterSignatureCheck(() => void runErase(command, "erase.applied", () => touched));
  };
  const deleteObject = () => {
    const object = selectedObject(eraseSelection);
    if (!doc || !object || !eraseSelection) return;
    const { page: objectPage } = eraseSelection;
    void afterSignatureCheck(() => void runErase(deleteObjectCommand(doc, objectPage, object), "erase.deleted", () => NO_ANNOTATIONS));
  };

  const flatten = async () => {
    if (!doc || !session) return;
    try {
      await session.run(flattenCommand(doc));
      showToast(t("forms.flattened"));
    } catch (err) {
      console.warn("selis: flatten failed", err);
      showToast(t("annotate.failed"), "error");
    }
  };

  const undo = () => {
    session?.undo().catch(() => showToast(t("annotate.failed"), "error"));
  };
  const redo = () => {
    session?.redo().catch(() => showToast(t("annotate.failed"), "error"));
  };

  const renderOverlay = useCallback(
    (index: number, scale: number) => {
      if (!doc || !session) return null;
      if (mode === "sign") return <SignatureLayer doc={doc} index={index} scale={scale} session={session} />;
      if (mode === "form") return <FormLayer doc={doc} index={index} scale={scale} session={session} />;
      if (mode === "redact") return <RedactLayer doc={doc} index={index} scale={scale} session={session} />;
      if (annotateTool === "erase") return <EraseLayer doc={doc} index={index} scale={scale} session={session} />;
      return <AnnotationLayer doc={doc} index={index} scale={scale} session={session} />;
    },
    [doc, session, mode, annotateTool],
  );

  // Remember the reading position (debounced), and once more when leaving.
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
    if (state.status !== "ready") return;
    const timer = window.setTimeout(() => {
      void api.setLastPage(docId, page).catch(() => undefined);
    }, SAVE_PAGE_MS);
    return () => window.clearTimeout(timer);
  }, [page, docId, state.status]);
  useEffect(
    () => () => {
      void api.setLastPage(docId, pageRef.current).catch(() => undefined);
    },
    [docId],
  );

  // Jump to the active search match.
  const current = search.current;
  useEffect(() => {
    if (current) mainRef.current?.scrollToPage(current.page, Math.max(0, (current.rects[0]?.y ?? 0) - 48));
  }, [current]);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const onPageChange = useCallback((index: number) => setPage(index), []);
  const toggleChrome = useCallback(() => {
    setChrome((c) => !c);
    setDockHidden(false);
  }, []);
  const onScroll = useCallback((info: ScrollInfo) => {
    setFraction(info.fraction);
    setScrolling(true);
    if (info.delta > DOCK_SCROLL_PX) setDockHidden(true);
    else if (info.delta < -DOCK_SCROLL_PX) setDockHidden(false);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setScrolling(false), CHIP_HIDE_MS);
  }, []);
  const jumpTo = useCallback((index: number) => mainRef.current?.scrollToPage(index), []);
  const jumpFromSheet = (index: number) => {
    setSheet(null);
    mainRef.current?.scrollToPage(index);
  };

  const share = async () => {
    if (state.status !== "ready") return;
    const title = state.meta.title || state.doc.title || t("library.untitled");
    const result = await shareDocument(docId, title, state.path);
    if (result === "unsupported") showToast(t("viewer.shareUnsupported"));
    else if (result === "failed") showToast(t("viewer.shareFailed"), "error");
  };

  const title = state.status === "ready" ? state.meta.title || state.doc.title || t("library.untitled") : "";
  const total = doc?.pageCount ?? 0;
  const subtitle = doc ? t("viewer.pageIndicator", { page: page + 1, total }) : "";
  const saveStatus = doc ? t(STATUS_KEYS[sessionState.status]) : "";
  const showChrome = chrome || state.status !== "ready" || searching || annotating;
  const initialPage = Math.min(total - 1, Math.max(0, resumePage ?? (state.status === "ready" ? (state.meta.lastPage ?? 0) : 0)));
  const searchStatus =
    query.trim() === ""
      ? ""
      : search.matches.length > 0
        ? t("viewer.searchCount", { current: search.active + 1, total: search.matches.length })
        : search.done
          ? t("viewer.searchNone")
          : t("viewer.searching");

  let body;
  if (state.status === "loading" || state.status === "recovery" || state.status === "locked") {
    body = <ViewerSkeleton insetTop={barHeight} />;
  } else if (state.status === "error") {
    body = (
      <div className="flex h-full items-center justify-center" style={{ paddingTop: barHeight }}>
        <EmptyState
          illustration={<DocumentGlyph />}
          title={t("viewer.errorTitle")}
          body={t(errorBody(state))}
          action={
            <Button variant="secondary" onClick={back}>
              {t("viewer.back")}
            </Button>
          }
        />
      </div>
    );
  } else if (mode === "pages" && session) {
    body = (
      <PagesMode
        doc={state.doc}
        session={session}
        sessionState={sessionState}
        structure={structure}
        title={title}
        onClose={finishAnnotating}
      />
    );
  } else {
    const main = (
      <PdfViewer
        key={structure}
        ref={mainRef}
        doc={state.doc}
        insetTop={barHeight}
        insetBottom={annotating ? sheetHeight + 16 : DOCK_SPACE}
        gutter={variant === "phone" ? 16 : 24}
        gap={12}
        maxPixels={currentRenderLimits().maxBitmapPixels}
        rotation={rotation}
        night={night && !annotating}
        textLayer={!annotating}
        highlights={searching ? search.highlights : undefined}
        initialPage={initialPage}
        onPageChange={onPageChange}
        onTap={annotating ? undefined : toggleChrome}
        onScroll={onScroll}
        testId="pdf-viewer"
        ariaLabel={title}
        renderOverlay={annotating ? renderOverlay : undefined}
      />
    );
    body =
      variant === "tablet" ? (
        <div className="flex h-full">
          <aside className="h-full w-44 shrink-0 border-r border-neutral-5" aria-label={t("viewer.thumbnails")}>
            <PdfViewer
              key={structure}
              doc={state.doc}
              insetTop={barHeight}
              gutter={20}
              gap={16}
              zoomable={false}
              buffer={3}
              maxPixels={THUMB_PIXEL_BUDGET}
              rotation={rotation}
              night={night}
              activePage={page}
              onPageClick={jumpTo}
              testId="thumbnails"
            />
          </aside>
          <div className="relative h-full min-w-0 flex-1">{main}</div>
        </div>
      ) : (
        main
      );
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-page-canvas"
      // What covers the pages (top bar, mode sheet): inline editors keep clear of it (scroll-margin).
      style={{ "--selis-cover-top": `${barHeight}px`, "--selis-cover-bottom": `${sheetHeight}px` } as CSSProperties}
      data-testid="viewer-screen"
    >
      {body}
      {pagesMode ? null : annotating ? (
        <AnnotateBar
          ref={barRef}
          title={t(MODE_TITLES[mode].title)}
          closeLabel={t(MODE_TITLES[mode].close)}
          status={saveStatus}
          canUndo={sessionState.canUndo}
          canRedo={sessionState.canRedo}
          onClose={finishAnnotating}
          onUndo={undo}
          onRedo={redo}
          onDone={finishAnnotating}
        />
      ) : searching ? (
        <ViewerSearchBar
          ref={barRef}
          query={query}
          onQuery={setQuery}
          onClose={closeSearch}
          onNext={search.next}
          onPrevious={search.previous}
          status={searchStatus}
          canStep={search.matches.length > 0}
        />
      ) : (
        <ViewerTopBar
          ref={barRef}
          title={title}
          subtitle={subtitle}
          status={saveStatus}
          onBack={back}
          onSearch={() => setSearching(true)}
          onMore={() => setSheet("more")}
          hidden={!showChrome}
        />
      )}
      {doc && !pagesMode ? (
        <>
          <PageChip page={page + 1} total={total} top={barHeight} visible={(scrolling || dragging) && total > 1} />
          {total > 1 && !annotating ? (
            <Scrubber
              fraction={fraction}
              top={barHeight + 8}
              bottom={DOCK_SPACE}
              visible={scrolling || dragging}
              label={t("viewer.scrubber")}
              onSeek={(f) => mainRef.current?.scrollToFraction(f)}
              onDragging={setDragging}
            />
          ) : null}
          {annotating ? (
            mode === "sign" ? (
              <SignSheet ref={sheetRef} />
            ) : mode === "redact" ? (
              <RedactSheet ref={sheetRef} busy={redacting || checkingRedact} onApply={() => void askRedact()} />
            ) : mode === "form" ? (
              <FormSheet ref={sheetRef} onJump={(index, y) => mainRef.current?.scrollToPage(index, y)} onFlatten={() => void flatten()} />
            ) : (
              <ToolSheet
                ref={sheetRef}
                eraseOptions={<EraseOptions busy={erasing} onApply={applyErase} onDelete={deleteObject} />}
              />
            )
          ) : (
            <ViewerDock
              hidden={!showChrome || (dockHidden && !searching)}
              onSoon={() => showToast(t("viewer.soon"))}
              onShare={() => void share()}
              onAnnotate={() => startEditing("annotate")}
              onSign={() => startEditing("sign")}
              onPages={() => startEditing("pages")}
            />
          )}
          {annotating ? null : <FormBanner top={barHeight} hidden={!showChrome} onFill={() => startEditing("form")} />}
          {annotating ? null : <OcrCard docId={docId} top={barHeight} />}
          <ViewerMoreSheet
            open={sheet === "more"}
            onClose={() => setSheet(null)}
            rotation={rotation}
            night={night}
            onOutline={() => setSheet("outline")}
            onThumbnails={() => setSheet("thumbnails")}
            onRotate={() => setRotation((r) => nextTurn(r))}
            onNight={(on) => void setNight(on)}
            onRedact={() => startEditing("redact")}
            onTools={() => void openTools()}
            onExport={() => {
              setSheet(null);
              useExport.getState().open(doc, title || t("library.untitled"));
            }}
          />
          <OutlineSheet open={sheet === "outline"} onClose={() => setSheet(null)} doc={doc} onJump={jumpFromSheet} />
          <ThumbnailsSheet
            open={sheet === "thumbnails"}
            onClose={() => setSheet(null)}
            doc={doc}
            current={page}
            onJump={jumpFromSheet}
          />
        </>
      ) : null}
      <EarlierVersionsSheet
        open={earlierVersions}
        busy={deletingEarlier}
        onDelete={() => setConfirmDeleteEarlier(true)}
        onKeep={() => setEarlierVersions(false)}
      />
      <ConfirmDialog
        open={confirmRedact !== null}
        danger
        title={t("redact.confirmTitle", { count: redactCount })}
        message={t("redact.confirmBody")}
        details={confirmRedact ?? []}
        confirmLabel={t("redact.confirm")}
        cancelLabel={t("redact.cancel")}
        onConfirm={() => void applyRedactions()}
        onCancel={() => setConfirmRedact(null)}
        testId="redact-dialog"
      />
      <ConfirmDialog
        open={signedAsk !== null}
        danger
        title={t("erase.signedTitle")}
        message={t("erase.signedBody")}
        confirmLabel={t("erase.signedContinue")}
        cancelLabel={t("erase.cancel")}
        onConfirm={() => {
          const go = signedAsk;
          setSignedAsk(null);
          go?.();
        }}
        onCancel={() => setSignedAsk(null)}
        testId="erase-signed-dialog"
      />
      <ConfirmDialog
        open={confirmDeleteEarlier}
        danger
        title={t("redact.earlierConfirmTitle")}
        message={t("redact.earlierConfirmBody")}
        confirmLabel={t("redact.earlierConfirm")}
        cancelLabel={t("redact.cancel")}
        onConfirm={() => void deleteEarlierVersions()}
        onCancel={() => setConfirmDeleteEarlier(false)}
        testId="redact-earlier-dialog"
      />
      <ConfirmDialog
        open={state.status === "recovery"}
        title={t("recovery.title")}
        message={t("recovery.body")}
        confirmLabel={t("recovery.restore")}
        cancelLabel={t("recovery.discard")}
        onConfirm={() => state.status === "recovery" && state.choose("restore")}
        onCancel={() => state.status === "recovery" && state.choose("discard")}
        // Back / outside tap leaves the document; the edits stay for next time.
        onDismiss={back}
        testId="recovery-dialog"
      />
      <UnlockSheet
        open={state.status === "locked"}
        wrong={state.status === "locked" && state.wrong}
        onUnlock={(password) => state.status === "locked" && state.unlock(password)}
        onBack={back}
      />
    </div>
  );
}
