/**
 * Screens at the reference phone size (390×844) in every theme, compared with
 * committed baselines (docs/design/p1-ui-brief.md). English is the primary set
 * (`<screen>-<theme>.png`), required on every change; Greek, the translation, is the second set
 * (`<screen>-el-<theme>.png`): long Greek labels must fit too. The Greek set runs in the
 * translation pass before each release candidate (`./langs.ts`, ADR 0030 amendment).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { makePhoto } from "@selis/fixtures";
import el from "../src/i18n/el.json" with { type: "json" };
import en from "../src/i18n/en.json" with { type: "json" };
import { UI_LANGS } from "./langs";
import { addToLibrary, firstPageRendered, importFixture, presetSettings, thumbnailsLoaded } from "./helpers";
import { useFakeScanCamera } from "./scan-camera";

const LINK = readFileSync(fileURLToPath(import.meta.resolve("@selis/fixtures/transfer/link.txt")), "utf8").trim();
const THEMES = ["light", "dark", "sepia"] as const;
type Lang = (typeof UI_LANGS)[number];

/** A UI string as the app shows it (simple `{name}` placeholders only). */
function ui(lang: Lang, key: string, vars: Record<string, string> = {}): string {
  let node: unknown = lang === "en" ? en : el;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`no message ${key}`);
  return node.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}

/** Document names and typed text per set: what a user of that language would see. */
const CONTENT = {
  en: {
    greek: "Greek sample.pdf",
    lease: "Lease agreement 2026.pdf",
    form: "Application.pdf",
    formTitle: "Application",
    note: "Check this paragraph",
    signer: "Maria Papadopoulou",
    fullName: "John Papadopoulos",
    whiteout: "Corrected line",
  },
  el: {
    greek: "Ελληνικό δοκιμαστικό.pdf",
    lease: "Συμβόλαιο ενοικίασης 2026.pdf",
    form: "Αίτηση.pdf",
    formTitle: "Αίτηση",
    note: "Να ελεγχθεί η παράγραφος",
    signer: "Μαρία Παπαδοπούλου",
    fullName: "Γιάννης Παπαδόπουλος",
    whiteout: "Διορθωμένη γραμμή",
  },
} as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  // Focusing a field scrolls its container into view; inside a sheet that overflows by a
  // fraction of a pixel that scroll can stop at a fractional offset, and borders then land a
  // pixel apart from one run to the next (pack-export, ADR 0019). Snap every scroll offset.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (el.scrollTop % 1 !== 0) el.scrollTop = Math.floor(el.scrollTop);
      if (el.scrollLeft % 1 !== 0) el.scrollLeft = Math.floor(el.scrollLeft);
    }
  });
}

async function stockLibrary(page: Page, lang: Lang): Promise<void> {
  const c = CONTENT[lang];
  await addToLibrary(page, "greek.pdf", c.greek);
  await addToLibrary(page, "mixed-sizes.pdf", c.lease);
  await addToLibrary(page, "acroform.pdf", c.form);
  await thumbnailsLoaded(page, 3);
  await page.getByRole("button", { name: ui(lang, "library.openDocument", { title: c.formTitle }) }).click({ button: "right" });
  await page.getByRole("button", { name: ui(lang, "library.addFavorite") }).click();
  await expect(page.getByTestId("favorite-badge")).toHaveCount(1);
}

for (const lang of UI_LANGS) {
  for (const theme of THEMES) {
    /** English keeps the plain names; Greek adds "-el". */
    const shot = (name: string) => (lang === "en" ? `${name}-${theme}.png` : `${name}-el-${theme}.png`);
    const c = CONTENT[lang];
    test.describe(`${lang} ${theme}`, () => {
      test.beforeEach(async ({ page }) => {
        // The fake scan camera holds one steady page: automatic capture would take it mid-shot.
        await presetSettings(page, { theme, locale: lang, scanAuto: false });
      });

      test(`library empty (${theme})`, async ({ page }) => {
        await page.goto("/");
        await expect(page.getByRole("heading", { name: ui(lang, "library.emptyTitle") })).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("library-empty"));
      });

      test(`library grid, list, sort sheet (${theme})`, async ({ page }) => {
        await page.goto("/");
        await stockLibrary(page, lang);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("library-grid"));

        await page.getByRole("button", { name: ui(lang, "library.sort") }).click();
        await expect(page.getByTestId("sort-sheet")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("library-sort-sheet"));
        await page.getByRole("radio", { name: ui(lang, "library.viewList") }).click();
        await expect(page.getByTestId("document-collection")).toHaveAttribute("data-view", "list");
        await thumbnailsLoaded(page, 3);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("library-list"));
      });

      test(`viewer, more sheet, search (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "greek.pdf", c.greek);
        await firstPageRendered(page);
        await expect(page.locator('[data-page="2"] canvas')).toHaveCount(1);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("viewer"));

        await page.getByRole("button", { name: ui(lang, "viewer.more") }).click();
        await expect(page.getByTestId("viewer-more")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("viewer-more"));
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: ui(lang, "viewer.search") }).click();
        await page.getByRole("searchbox").fill("κείμενο");
        await expect(page.getByTestId("search-status")).toHaveText(/^1 \//);
        await page.locator("input").blur();
        // The hit is drawn (its page settles) before the scroll indicators fade: on a slow
        // runner a late layout scroll would otherwise bring the page chip back.
        await expect(page.getByTestId("search-hit-active")).toBeVisible();
        await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "0", { timeout: 4_000 });
        await page.waitForTimeout(600);
        await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "0", { timeout: 4_000 });
        await settle(page);
        await expect(page).toHaveScreenshot(shot("viewer-search"));
      });

      test(`annotate: tool sheet, pen options, note (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "greek.pdf", c.greek);
        await firstPageRendered(page);
        await page.getByTestId("dock-annotate").click();
        const layer = page.getByTestId("annotation-layer-1");
        const box = await layer.boundingBox();
        if (!box) throw new Error("page not laid out");
        const y = box.y + box.height * 0.152;
        await page.mouse.move(box.x + box.width * 0.11, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
        await page.mouse.up();
        await expect(page.getByTestId("annotate-undo")).toBeEnabled();
        // Wait for the autosave so the status reads "saved", not "saving…".
        await expect(page.getByTestId("save-status")).toHaveText(ui(lang, "annotate.statusSaved"), { timeout: 10_000 });
        await settle(page);
        await expect(page).toHaveScreenshot(shot("annotate"));

        await page.getByTestId("tool-pen").click();
        await settle(page);
        await expect(page.getByTestId("annotate-sheet")).toHaveScreenshot(shot("annotate-pen-sheet"));

        await page.getByTestId("tool-note").click();
        await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
        await expect(page.getByTestId("note-editor")).toBeVisible();
        await page.getByTestId("note-editor-input").fill(c.note);
        await page.getByTestId("note-editor-input").blur();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("annotate-note"));
      });

      test(`sign: sheet, new signature (draw, type), placed (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "greek.pdf", c.greek);
        await firstPageRendered(page);
        await page.getByTestId("dock-sign").click();
        await expect(page.getByTestId("sign-sheet")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("sign-empty"));

        await page.getByTestId("signature-new").click();
        const pad = page.getByTestId("signature-pad");
        await expect(pad).toBeVisible();
        // Measure after the sheet has slid in.
        await settle(page);
        const box = await pad.boundingBox();
        if (!box) throw new Error("pad not laid out");
        const stroke = async (points: [number, number][]) => {
          const [first, ...rest] = points;
          if (!first) return;
          await page.mouse.move(box.x + box.width * first[0], box.y + box.height * first[1]);
          await page.mouse.down();
          for (const [x, y] of rest) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 6 });
          await page.mouse.up();
        };
        await stroke([
          [0.12, 0.62],
          [0.22, 0.3],
          [0.3, 0.64],
          [0.42, 0.34],
          [0.5, 0.6],
          [0.62, 0.42],
          [0.85, 0.5],
        ]);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("sign-new-draw"));

        await page.getByTestId("signature-mode-type").click();
        await page.getByTestId("signature-name").fill(c.signer);
        await page.getByTestId("signature-name").blur();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await expect(page).toHaveScreenshot(shot("sign-new-type"));

        await page.getByTestId("signature-mode-draw").click();
        await page.getByTestId("signature-save").click();
        await expect(page.getByTestId("signature-card")).toHaveCount(1);
        // The new signature is armed for placing before the page tap (a loaded runner can lag).
        await expect(page.getByTestId("signature-card")).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("signature-pad")).toHaveCount(0);
        const layer = page.getByTestId("signature-layer-1");
        const pageBox = await layer.boundingBox();
        if (!pageBox) throw new Error("page not laid out");
        await page.mouse.click(pageBox.x + pageBox.width * 0.55, pageBox.y + pageBox.height * 0.5);
        await expect(page.getByTestId("signature-selection")).toBeVisible();
        await expect(page.getByTestId("annotate-undo")).toBeEnabled();
        await expect(page.getByTestId("save-status")).toHaveText(ui(lang, "annotate.statusSaved"), { timeout: 10_000 });
        await settle(page);
        await expect(page).toHaveScreenshot(shot("sign-placed"));
      });

      test(`forms: banner and form mode (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "acroform.pdf", c.form);
        await firstPageRendered(page);
        await expect(page.getByTestId("form-banner")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("form-banner"));

        await page.getByTestId("form-fill").click();
        await page.getByTestId("field-full_name").click();
        await page.getByTestId("field-input-full_name").fill(c.fullName);
        await page.getByTestId("field-input-full_name").press("Enter");
        // The change lands asynchronously: wait for it, then for its autosave.
        await expect(page.getByTestId("annotate-undo")).toBeEnabled();
        await expect(page.getByTestId("save-status")).toHaveText(ui(lang, "annotate.statusSaved"), { timeout: 10_000 });
        await page.getByTestId("form-next").click();
        await expect(page.getByTestId("field-input-email")).toBeFocused();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("form-mode"));

        await page.getByTestId("field-input-email").press("Escape");
        await page.getByTestId("form-flatten").click();
        await expect(page.getByTestId("flatten-dialog")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("form-flatten"));
      });

      test(`pages: grid with selection, extract sheet, delete dialog (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "mixed-sizes.pdf", c.lease);
        await firstPageRendered(page);
        await page.getByTestId("dock-pages").click();
        const grid = page.getByTestId("pages-grid");
        await expect
          .poll(() => grid.locator("img").evaluateAll((imgs: HTMLImageElement[]) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length))
          .toBe(7);
        await page.getByTestId("page-thumb-2").click();
        await page.getByTestId("page-thumb-3").click();
        await settle(page);
        // The title fits next to undo / redo / "Select all" (no ellipsis), Greek included.
        expect(await page.getByTestId("pages-selected").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(page).toHaveScreenshot(shot("pages-grid"));

        await page.getByTestId("pages-extract").click();
        await expect(page.getByTestId("pages-extract-sheet")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("pages-extract"));
        await page.keyboard.press("Escape");

        await page.getByTestId("pages-delete").click();
        await expect(page.getByTestId("pages-delete-dialog")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("pages-delete"));
      });

      test(`redact: marks, whiteout and the confirm dialog (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "greek.pdf", c.greek);
        await firstPageRendered(page);
        await page.getByRole("button", { name: ui(lang, "viewer.more") }).click();
        await page.getByTestId("more-redact").click();
        const layer = page.getByTestId("redact-layer-1");
        const box = await layer.boundingBox();
        if (!box) throw new Error("layer not laid out");
        const s = box.width / 595;
        const drag = async (a: [number, number], b: [number, number]) => {
          await page.mouse.move(box.x + a[0] * s, box.y + a[1] * s);
          await page.mouse.down();
          await page.mouse.move(box.x + b[0] * s, box.y + b[1] * s, { steps: 6 });
          await page.mouse.up();
        };
        await page.getByTestId("redact-tool-area").click();
        await drag([50, 143], [545, 163]);
        await page.getByTestId("redact-tool-whiteout").click();
        await drag([50, 169], [400, 189]);
        await page.getByTestId("text-editor-input").fill(c.whiteout);
        await page.getByTestId("text-editor-input").blur();
        await page.getByRole("button", { name: ui(lang, "annotate.textAdd") }).click();
        await expect(page.getByTestId("redact-mark")).toHaveCount(2);
        await expect(page.getByTestId("save-status")).toHaveText(ui(lang, "annotate.statusSaved"), { timeout: 10_000 });
        await settle(page);
        await expect(page).toHaveScreenshot(shot("redact-marks"));

        await page.getByTestId("redact-apply").click();
        await expect(page.getByTestId("redact-dialog")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("redact-confirm"));
      });

      test(`erase: brush and rectangle preview, object picked (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "erase.pdf");
        await firstPageRendered(page);
        await page.getByTestId("dock-annotate").click();
        await page.getByTestId("tool-erase").click();
        const layer = page.getByTestId("erase-layer-1");
        const box = await layer.boundingBox();
        if (!box) throw new Error("layer not laid out");
        const s = box.width / 595.28;
        const drag = async (a: [number, number], b: [number, number]) => {
          await page.mouse.move(box.x + a[0] * s, box.y + a[1] * s);
          await page.mouse.down();
          await page.mouse.move(box.x + b[0] * s, box.y + b[1] * s, { steps: 6 });
          await page.mouse.up();
        };
        // A brush stroke across the blue rectangle, a rectangle over the secret line.
        await drag([150, 282], [240, 282]);
        await page.getByTestId("erase-mode-rect").click();
        await drag([50, 130], [200, 148]);
        await expect(page.getByTestId("erase-stroke")).toHaveCount(2);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("erase-strokes"));

        await page.getByTestId("erase-mode-object").click();
        await page.mouse.click(box.x + 150 * s, box.y + 500 * s);
        await expect(page.getByTestId("erase-selection")).toHaveAttribute("data-kind", "image");
        await settle(page);
        await expect(page).toHaveScreenshot(shot("erase-object"));
      });

      test(`settings and transfer (${theme})`, async ({ page }) => {
        await page.goto("/");
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.settings") }).click();
        await expect(page.getByTestId("settings-screen")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("settings"), { fullPage: true });
        await page.getByTestId("setting-language").click();
        await expect(page.getByTestId("language-sheet")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("settings-language"));
        await page.keyboard.press("Escape");
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.transfer") }).click();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer"));
      });

      test(`transfer flow (${theme})`, async ({ page }) => {
        await page.goto("/");
        await addToLibrary(page, "greek.pdf", c.greek);
        await addToLibrary(page, "mixed-sizes.pdf", c.lease);
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.transfer") }).click();
        await page.getByTestId("transfer-doc").first().click();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-choose"));

        await page.getByTestId("transfer-send-start").click();
        await expect(page.getByTestId("transfer-qr")).toBeVisible();
        await page.evaluate(() => document.querySelector<HTMLImageElement>('[data-testid="transfer-qr"]')?.decode());
        await settle(page);
        // The countdown ticks every second.
        await expect(page).toHaveScreenshot(shot("transfer-offer"), { mask: [page.getByTestId("transfer-expires")] });

        await page.evaluate(() => {
          const hooks = (window as unknown as { __selisTest: { transfer: { peerScans: () => void; hold: (on: boolean) => void } } })
            .__selisTest.transfer;
          hooks.hold(true);
          hooks.peerScans();
        });
        await expect(page.getByTestId("transfer-send-code")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-code"));

        await page.getByTestId("transfer-confirm").click();
        await expect(page.getByTestId("transfer-send-progress").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-sending"));

        await page.getByTestId("transfer-send-cancel").click();
        await page.getByRole("tab", { name: ui(lang, "transfer.tabReceive") }).click();
        await expect(page.getByTestId("transfer-viewfinder")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-receive"));
      });

      test(`transfer problems (${theme})`, async ({ page }) => {
        const hook = (name: string, ...args: unknown[]) =>
          page.evaluate(
            ({ name, args }) => {
              const hooks = (window as unknown as { __selisTest: { transfer: Record<string, (...a: unknown[]) => void> } })
                .__selisTest.transfer;
              hooks[name]?.(...args);
            },
            { name, args },
          );
        await page.goto("/");
        await addToLibrary(page, "greek.pdf", c.greek);
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.transfer") }).click();
        await page.getByTestId("transfer-doc").first().click();
        await page.getByTestId("transfer-send-start").click();
        await expect(page.getByTestId("transfer-qr")).toBeVisible();
        await hook("expireOffers");
        await expect(page.getByTestId("transfer-offer-expired")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-expired"));

        await page.getByTestId("transfer-send-cancel").click();
        await page.getByRole("tab", { name: ui(lang, "transfer.tabReceive") }).click();
        await hook("failReceive", "unreachable");
        await hook("failResumes", "unreachable");
        await page.getByTestId("transfer-paste").click();
        await page.getByTestId("transfer-paste-input").fill(LINK);
        await page.getByTestId("transfer-paste-submit").click();
        await page.getByTestId("transfer-link-accept").click();
        await hook("senderConfirms");
        await expect(page.getByTestId("transfer-paused-reason")).toBeVisible();
        for (const n of ["1", "2", "3"]) {
          await page.getByTestId("transfer-resume").click();
          await expect(page.getByTestId("transfer-resume-attempts")).toContainText(n);
        }
        await expect(page.getByTestId("transfer-new-code")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-paused"));
      });

      test(`transfer devices and move (${theme})`, async ({ page }) => {
        await page.goto("/");
        await addToLibrary(page, "greek.pdf", c.greek);
        const deviceNames: [string, string] =
          lang === "en" ? ["Maria's laptop", "Office tablet"] : ["Λάπτοπ της Μαρίας", "Tablet γραφείου"];
        await page.evaluate((names) => {
          type Device = { id: string; name: string; online: boolean; ready: boolean };
          const hooks = (window as unknown as { __selisTest: { transfer: { devices: (l: Device[]) => void } } }).__selisTest
            .transfer;
          hooks.devices([
            { id: "1".repeat(64), name: names[0], online: true, ready: true },
            { id: "2".repeat(64), name: names[1], online: false, ready: false },
          ]);
        }, deviceNames);
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.transfer") }).click();
        await page.getByTestId("transfer-doc").first().click();
        await expect(page.locator('[data-testid="trusted-device"][data-status="offline"]')).toHaveCount(1);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-devices"), { fullPage: true });
        await page.getByTestId("transfer-move-open").click();
        await expect(page.getByTestId("transfer-move-summary")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("transfer-move"));
      });

      test(`selispack export and passphrase (${theme})`, async ({ page }) => {
        await page.goto("/");
        await addToLibrary(page, "greek.pdf", c.greek);
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.transfer") }).click();
        await page.getByTestId("transfer-doc").first().click();
        await page.getByTestId("pack-export-open").click();
        await page.getByTestId("pack-protect").click();
        await page.getByTestId("pack-passphrase").fill("correct horse");
        await page.getByTestId("pack-passphrase-again").fill("correct hors");
        await expect(page.getByTestId("pack-mismatch")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("pack-export"));
        await page.getByTestId("pack-passphrase-again").fill("correct horse");
        await page.getByTestId("pack-export-create").click();
        await expect(page.getByTestId("pack-export-sheet")).toHaveCount(0);
        // The "file ready" toast must not end up in the next screenshots.
        await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 15_000 });
        await page.getByRole("tab", { name: ui(lang, "transfer.tabReceive") }).click();
        await page.evaluate(() => {
          type Hooks = { lastExport: () => string | null; nextPick: (t: string | null) => void };
          const hooks = (window as unknown as { __selisTest: { pack: Hooks } }).__selisTest.pack;
          hooks.nextPick(hooks.lastExport());
        });
        await page.getByTestId("pack-import-open").click();
        await page.getByTestId("pack-unlock-passphrase").fill("wrong passphrase");
        await page.getByTestId("pack-unlock").click();
        await expect(page.getByTestId("pack-wrong")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("pack-passphrase"));
        await page.getByTestId("pack-unlock-passphrase").fill("correct horse");
        await page.getByTestId("pack-unlock").click();
        await expect(page.getByTestId("pack-import-done")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("pack-imported"));
      });

      test(`images to PDF and page export (${theme})`, async ({ page }) => {
        await page.goto("/");
        const photos = await Promise.all(
          [1, 6, 1, 3].map(async (orientation, i) => ({
            name: `IMG_${String(i)}.jpg`,
            bytes: [...(await makePhoto({ width: 320, height: 240, orientation }))],
          })),
        );
        await page.evaluate((items) => {
          type Hooks = { photos: { pickNext: (p: Array<{ name: string; bytes: number[] }>) => void } };
          (window as unknown as { __selisTest: Hooks }).__selisTest.photos.pickNext(items);
        }, photos);
        await page.getByTestId("images-empty").click();
        await expect(page.getByTestId("images-tile")).toHaveCount(4);
        await expect(page.locator('[data-testid="images-grid"] img')).toHaveCount(4);
        await expect
          .poll(() => page.locator('[data-testid="images-grid"] img').evaluateAll((imgs: HTMLImageElement[]) => imgs.every((i) => i.complete && i.naturalWidth > 0)))
          .toBe(true);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("images-screen"));
        await page.goBack();
        await expect(page.getByTestId("images-screen")).toHaveCount(0);

        await importFixture(page, "greek.pdf", c.greek);
        await firstPageRendered(page);
        await page.getByRole("button", { name: ui(lang, "viewer.more") }).click();
        await page.getByTestId("more-tools").click();
        await page.getByTestId("tool-export-image").click();
        await expect(page.getByTestId("tools-export-pixels")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("tools-export"));
      });

      test(`tools: sheet, protect, compressed, unlock (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "greek.pdf", c.greek);
        await firstPageRendered(page);
        await page.getByRole("button", { name: ui(lang, "viewer.more") }).click();
        await page.getByTestId("more-tools").click();
        await expect(page.getByTestId("tools-rows")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("tools-sheet"));
        await page.getByTestId("tool-protect").click();
        await page.getByTestId("tools-password").fill("correct horse");
        await page.getByTestId("tools-password-again").fill("correct hors");
        await page.getByTestId("tools-restrictions").click();
        await expect(page.getByTestId("tools-password-problem")).toBeVisible();
        // Which field keeps the focus ring after the clicks varied between runs: none does.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await settle(page);
        // The first password field's border lands a pixel apart from run to run while its text
        // does not (sub-pixel position): the shot starts below it; the second field, styled
        // the same, stays in.
        await expect(page).toHaveScreenshot(shot("tools-protect"), { clip: { x: 0, y: 352, width: 390, height: 492 } });
        await page.goBack();
        await page.getByTestId("tool-compress").click();
        await expect(page.getByTestId("tools-compressed")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("tools-compressed"));
        await page.getByTestId("tools-done").click();
        await expect(page.getByTestId("tools-sheet")).toHaveCount(0);

        await page.goBack();
        await importFixture(page, "encrypted.pdf", c.greek.replace(/\.pdf$/, " 2.pdf"));
        await expect(page.getByTestId("unlock-sheet")).toBeVisible();
        await page.getByTestId("unlock-password").fill("wrong");
        await page.getByTestId("unlock-submit").click();
        await expect(page.getByTestId("unlock-wrong")).toBeVisible({ timeout: 15_000 });
        await settle(page);
        await expect(page).toHaveScreenshot(shot("tools-unlock"));
      });

      test(`scan: camera, adjust corners, pages (${theme})`, async ({ page }) => {
        await useFakeScanCamera(page);
        await page.goto("/");
        await page.getByTestId("scan-empty").click();
        await expect(page.getByTestId("scan-camera")).toHaveAttribute("data-camera", "live");
        await expect(page.getByTestId("scan-outline")).toBeVisible();
        // The fake camera repeats one frame: the eased outline settles on it.
        await page.waitForTimeout(1500);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("scan-camera"));
        await page.getByTestId("scan-shutter").click();
        await expect(page.getByTestId("scan-still")).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => page.getByTestId("scan-still").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("scan-adjust"));
        await page.getByTestId("scan-filter-bw").click();
        await page.getByTestId("scan-keep").click();
        await expect(page.getByTestId("scan-queue-open")).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("scan-shutter").click();
        await expect(page.getByTestId("scan-still")).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("scan-keep").click();
        await expect(page.getByTestId("scan-count")).toContainText("2", { timeout: 20_000 });
        await page.getByTestId("scan-queue-open").click();
        await expect(page.getByTestId("scan-page")).toHaveCount(2);
        await expect
          .poll(() => page.locator('[data-testid="scan-pages"] img').evaluateAll((imgs: HTMLImageElement[]) => imgs.every((i) => i.complete && i.naturalWidth > 0)))
          .toBe(true);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("scan-queue"));
        await page.getByTestId("scan-page-open").nth(1).click();
        await expect(page.getByTestId("scan-page-preview")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("scan-page-rendering")).toHaveCount(0, { timeout: 20_000 });
        await expect.poll(() => page.getByTestId("scan-page-preview").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("scan-page"));
      });

      test(`scan: ID card camera (${theme})`, async ({ page }) => {
        await useFakeScanCamera(page);
        await page.goto("/");
        await page.getByTestId("scan-empty").click();
        await expect(page.getByTestId("scan-outline")).toBeVisible();
        await page.getByTestId("scan-mode").getByRole("tab").nth(1).click();
        await expect(page.getByTestId("scan-id-side")).toBeVisible();
        await page.waitForTimeout(1500);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("scan-idcard"));
      });

      test(`scan: camera denied (${theme})`, async ({ page }) => {
        await useFakeScanCamera(page, { denied: true });
        await page.goto("/");
        await page.getByTestId("scan-empty").click();
        await expect(page.getByTestId("scan-camera-problem")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("scan-denied"));
      });

      test(`ocr: options sheet, stopped card (${theme})`, async ({ page }) => {
        await page.goto("/");
        await importFixture(page, "scanned-english.pdf", lang === "en" ? "Scan.pdf" : "Σάρωση.pdf");
        await firstPageRendered(page);
        await page.getByRole("button", { name: ui(lang, "viewer.more") }).click();
        await page.getByTestId("more-tools").click();
        await page.getByTestId("tool-ocr").click();
        await expect(page.getByTestId("ocr-sheet")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot("ocr-sheet"));
        await page.getByTestId("ocr-start").click();
        await expect(page.getByTestId("ocr-label")).toHaveText(ui(lang, "ocr.reading", { page: "1", total: "2" }), { timeout: 30_000 });
        await page.getByTestId("ocr-cancel").click();
        await expect(page.getByTestId("ocr-card")).toHaveAttribute("data-step", "stopped");
        await settle(page);
        await expect(page).toHaveScreenshot(shot("ocr-stopped"));
      });

      test(`recent (${theme})`, async ({ page }) => {
        await page.goto("/");
        await stockLibrary(page, lang);
        await page.getByRole("navigation").getByRole("button", { name: ui(lang, "tabs.recent") }).click();
        await thumbnailsLoaded(page, 3);
        await settle(page);
        await expect(page).toHaveScreenshot(shot("recent"));
      });
    });
  }
}

test("viewer night mode keeps the image on page 2", async ({ page }) => {
  await presetSettings(page, { theme: "light", locale: "en", nightMode: true });
  await page.goto("/");
  await importFixture(page, "greek.pdf", CONTENT.en.greek);
  await firstPageRendered(page);
  await page.getByTestId("pdf-viewer").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "0", { timeout: 4_000 });
  await settle(page);
  await expect(page).toHaveScreenshot("viewer-night.png");
});

// The scan camera's header at the narrowest common phone width (360 dp): no text at the edges,
// en and el, before and after the first page.
test.describe("scan header at 360 × 800", () => {
  test.use({ viewport: { width: 360, height: 800 } });
  for (const lang of UI_LANGS) {
    test(`scan header 360 (${lang})`, async ({ page }) => {
      await presetSettings(page, { theme: "light", locale: lang, scanAuto: false });
      await useFakeScanCamera(page);
      await page.goto("/");
      await page.getByTestId("scan-empty").click();
      await expect(page.getByTestId("scan-camera")).toHaveAttribute("data-camera", "live");
      const header = page.getByTestId("scan-header");
      await settle(page);
      await expect(header).toHaveScreenshot(`scan-header-360-${lang}.png`);
      await page.getByTestId("scan-shutter").click();
      await expect(page.getByTestId("scan-keep")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("scan-keep").click();
      await expect(page.getByTestId("scan-count")).toBeVisible({ timeout: 20_000 });
      await settle(page);
      await expect(header).toHaveScreenshot(`scan-header-360-page-${lang}.png`);
    });
  }
});
