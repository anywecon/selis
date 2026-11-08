/**
 * Transfer screen against the mock backend's scripted other device
 * (src/lib/mock-transfer.ts): send with the code, decline, receive by paste,
 * deep link and camera scan, pause and resume, plain-language errors.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { fixturePath } from "@selis/fixtures";
import { addToLibrary, presetSettings } from "./helpers";

const LINK = readFileSync(fileURLToPath(import.meta.resolve("@selis/fixtures/transfer/link.txt")), "utf8").trim();

type Hooks = {
  peerScans: () => void;
  senderConfirms: () => void;
  hold: (on: boolean) => void;
  incoming: (files: Array<{ name: string; bytes: number[] }>) => void;
  failReceive: (code: string | null) => void;
  failResumes: (code: string | null) => void;
  link: (url: string) => void;
  expireOffers: () => void;
};

async function hook<K extends keyof Hooks>(page: Page, name: K, ...args: Parameters<Hooks[K]>): Promise<void> {
  await page.evaluate(
    ({ name, args }) => {
      const hooks = (window as unknown as { __selisTest: { transfer: Record<string, (...a: unknown[]) => void> } }).__selisTest
        .transfer;
      hooks[name]?.(...args);
    },
    { name, args },
  );
}

async function openTransfer(page: Page): Promise<void> {
  await page.getByRole("navigation").getByRole("button", { name: "Transfer" }).click();
  await expect(page.getByTestId("transfer-screen")).toBeVisible();
}

async function receiveTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Receive" }).click();
  await expect(page.getByTestId("transfer-receive")).toBeVisible();
}

async function submitLink(page: Page, link: string): Promise<void> {
  await page.getByTestId("transfer-paste").click();
  await page.getByTestId("transfer-paste-input").fill(link);
  await page.getByTestId("transfer-paste-submit").click();
}

async function pasteLink(page: Page, link: string): Promise<void> {
  await submitLink(page, link);
  // A link only asks first, with the sender (security audit run-1, lead 5).
  await expect(page.getByTestId("transfer-link-sender")).toBeVisible();
  await page.getByTestId("transfer-link-accept").click();
}

test.beforeEach(async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
});

test("sends two documents once the same code is confirmed", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Invoice.pdf");
  await openTransfer(page);

  const send = page.getByTestId("transfer-send-start");
  await expect(send).toBeDisabled();
  await page.getByTestId("transfer-select-all").click();
  await expect(page.getByTestId("transfer-doc").and(page.locator('[aria-checked="true"]'))).toHaveCount(2);
  await page.getByTestId("transfer-history").click();
  await send.click();

  await expect(page.getByTestId("transfer-qr")).toBeVisible();
  await expect(page.getByTestId("transfer-offer-summary")).toContainText("2 documents");
  await expect(page.getByTestId("transfer-expires")).toContainText(/Expires in (10:00|9:\d\d)/);

  await hook(page, "peerScans");
  await expect(page.getByTestId("transfer-send-code")).toHaveText("482 913");
  await page.getByTestId("transfer-confirm").click();
  await expect(page.getByTestId("transfer-send-done")).toBeVisible();
  await expect(page.getByTestId("transfer-send-done")).toContainText("2 documents arrived");
  await page.getByTestId("transfer-send-again").click();
  await expect(page.getByTestId("transfer-choose")).toBeVisible();
});

test("a code that does not match sends nothing", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  await openTransfer(page);
  await page.getByTestId("transfer-doc").first().click();
  await page.getByTestId("transfer-send-start").click();
  await hook(page, "peerScans");
  await page.getByTestId("transfer-mismatch").click();
  await expect(page.getByTestId("transfer-send-problem")).toHaveAttribute("data-problem", "declined");
  await expect(page.getByTestId("transfer-send-problem")).toHaveText("The code wasn’t confirmed, so nothing was sent.");
});

test("an expired code is replaced by a new one for the same documents", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  await openTransfer(page);
  await page.getByTestId("transfer-doc").first().click();
  await page.getByTestId("transfer-send-start").click();
  await expect(page.getByTestId("transfer-qr")).toBeVisible();
  await hook(page, "expireOffers");
  await expect(page.getByTestId("transfer-offer-expired")).toContainText("This code has expired");
  await expect(page.getByTestId("transfer-qr")).toHaveCount(0);
  await page.getByRole("button", { name: "New code" }).click();
  // Straight back to a live QR code for the same document, no dead end.
  await expect(page.getByTestId("transfer-qr")).toBeVisible();
  await expect(page.getByTestId("transfer-offer-summary")).toContainText("1 document");
  await expect(page.getByTestId("transfer-expires")).toContainText(/Expires in (10:00|9:\d\d)/);
  await hook(page, "peerScans");
  await page.getByTestId("transfer-confirm").click();
  await expect(page.getByTestId("transfer-send-done")).toBeVisible();
});

test("receives by pasted link into the library", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await page.evaluate(
    (bytes) => {
      const hooks = (window as unknown as { __selisTest: { transfer: Hooks } }).__selisTest.transfer;
      hooks.incoming([{ name: "Lease.pdf", bytes }]);
    },
    [...readFileSync(fixturePath("greek.pdf"))],
  );
  await pasteLink(page, `  ${LINK}\n`);
  await expect(page.getByTestId("transfer-receive-code")).toHaveText("482 913");
  await hook(page, "senderConfirms");
  await expect(page.getByTestId("transfer-receive-done")).toBeVisible();
  await expect(page.getByTestId("transfer-receive-count")).toHaveText("1 document was added to your library.");
  await page.getByTestId("transfer-open-library").click();
  await expect(page.getByRole("button", { name: /Lease/ })).toBeVisible();
});

test("refuses what is not a transfer link", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await submitLink(page, "https://example.com/not-selis");
  await expect(page.getByTestId("transfer-link-prompt")).toHaveCount(0);
  await expect(page.getByTestId("transfer-receive-problem")).toHaveText("That isn’t a Selis transfer link.");
});

test("a selis:// link from another app opens Receive, asks with the sender, then shows the code", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
  await hook(page, "link", LINK);
  await expect(page.getByTestId("transfer-screen")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Receive" })).toHaveAttribute("aria-selected", "true");
  // Security audit run-1, lead 5: nothing connects before the user says yes.
  await expect(page.getByTestId("transfer-link-sender")).toContainText("From device 5e11 5e11 5e11 5e11");
  await expect(page.getByTestId("transfer-receive-code")).toHaveCount(0);
  await page.getByTestId("transfer-link-accept").click();
  await expect(page.getByTestId("transfer-receive-code")).toHaveText("482 913");
});

test("declining a link from another app receives nothing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
  await hook(page, "link", LINK);
  await page.getByTestId("transfer-link-decline").click();
  await expect(page.getByTestId("transfer-link-prompt")).toHaveCount(0);
  await expect(page.getByTestId("transfer-receive")).toBeVisible();
});

test("an interrupted receive pauses and resumes", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await hook(page, "failReceive", "interrupted");
  await pasteLink(page, LINK);
  await hook(page, "senderConfirms");
  await expect(page.getByTestId("transfer-receive-paused")).toBeVisible();
  await page.getByTestId("transfer-resume").click();
  await expect(page.getByTestId("transfer-receive-done")).toBeVisible();
});

test("a resume that fails says why, counts, and then offers a new code", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await hook(page, "failReceive", "unreachable");
  await hook(page, "failResumes", "unreachable");
  await pasteLink(page, LINK);
  await hook(page, "senderConfirms");
  const paused = page.getByTestId("transfer-receive-paused");
  await expect(paused).toBeVisible();
  await expect(page.getByTestId("transfer-paused-reason")).toHaveText("Sender not reachable — ask for a new code.");
  await expect(page.getByTestId("transfer-new-code")).toHaveCount(0);
  for (const n of [1, 2, 3]) {
    await page.getByTestId("transfer-resume").click();
    await expect(page.getByTestId("transfer-resume-attempts")).toHaveText(n === 1 ? "1 attempt failed" : `${n} attempts failed`);
  }
  await expect(page.getByTestId("transfer-paused-reason")).toBeVisible();
  await page.getByTestId("transfer-new-code").click();
  await expect(paused).toHaveCount(0);
  await expect(page.getByTestId("transfer-scan")).toBeVisible();
  await expect(page.getByTestId("transfer-paused-list")).toHaveCount(0);
});

test("a dropped connection pauses with the reason and resumes", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await hook(page, "failReceive", "interrupted");
  await pasteLink(page, LINK);
  await hook(page, "senderConfirms");
  await expect(page.getByTestId("transfer-paused-reason")).toHaveText(
    "The connection dropped. Resume, or ask the sender for a new code.",
  );
  await page.getByTestId("transfer-resume").click();
  await expect(page.getByTestId("transfer-receive-done")).toBeVisible();
});

test("a paused receive survives leaving the screen and resumes from the list", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await hook(page, "failReceive", "interrupted");
  await pasteLink(page, LINK);
  await hook(page, "senderConfirms");
  await expect(page.getByTestId("transfer-receive-paused")).toBeVisible();
  await page.getByTestId("transfer-receive-cancel").click();
  // Cancel drops it for good: nothing is listed.
  await expect(page.getByTestId("transfer-paused-list")).toHaveCount(0);
});

test("camera denied falls back to pasting", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "permission emulation is Chromium-only");
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await page.getByTestId("transfer-scan").click();
  await expect(page.getByTestId("transfer-camera-problem")).toBeVisible();
  await expect(page.getByTestId("transfer-paste")).toBeVisible();
});

const LAPTOP = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";

async function devices(page: Page, list: Array<{ id: string; name: string; online: boolean; ready: boolean }>): Promise<void> {
  await page.evaluate((l) => {
    (window as unknown as { __selisTest: { transfer: Hooks & { devices: (x: typeof l) => void } } }).__selisTest.transfer.devices(l);
  }, list);
}

test("saves the device after a QR transfer, then sends to it with one tap", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  await openTransfer(page);
  await page.getByTestId("transfer-doc").first().click();
  await page.getByTestId("transfer-send-start").click();
  await hook(page, "peerScans");
  await page.getByTestId("transfer-confirm").click();
  await expect(page.getByTestId("transfer-send-done")).toBeVisible();
  await page.getByTestId("transfer-save-device").click();
  await page.getByTestId("save-device-name").fill("Maria's laptop");
  await page.getByTestId("save-device-confirm").click();
  await expect(page.getByTestId("transfer-save-device")).toHaveCount(0);

  await page.getByTestId("transfer-send-again").click();
  const row = page.getByTestId("trusted-device");
  await expect(row).toHaveText(/Maria's laptop/);
  await expect(row).toHaveAttribute("data-status", "ready");
  // Nothing chosen yet: the pill waits.
  await expect(page.getByTestId("trusted-send")).toBeDisabled();
  await page.getByTestId("transfer-doc").first().click();
  await page.getByTestId("trusted-send").click();
  await expect(page.getByTestId("transfer-send-done")).toBeVisible();
  // Already trusted: no "Save this device" this time, and no code was asked.
  await expect(page.getByTestId("transfer-save-device")).toHaveCount(0);
});

test("a saved device that is not ready cannot be sent to, and can be removed", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  await devices(page, [{ id: LAPTOP, name: "Laptop", online: true, ready: false }]);
  await openTransfer(page);
  await page.getByTestId("transfer-doc").first().click();
  const row = page.getByTestId("trusted-device");
  await expect(row).toHaveAttribute("data-status", "online");
  await expect(row).toContainText("Online · open Receive on it");
  await expect(page.getByTestId("trusted-send")).toBeDisabled();
  await page.getByTestId("trusted-remove").click();
  await expect(page.getByTestId("trusted-remove-dialog")).toBeVisible();
  await page.getByTestId("trusted-remove-dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("transfer-trusted")).toHaveCount(0);
});

test("a saved device sends here while the Receive tab is open", async ({ page }) => {
  await page.goto("/");
  await devices(page, [{ id: LAPTOP, name: "Laptop", online: true, ready: true }]);
  await openTransfer(page);
  await receiveTab(page);
  await expect(page.getByTestId("transfer-trusted-hint")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __selisTest: { transfer: { incomingPush: (n: string) => void } } }).__selisTest.transfer.incomingPush("Laptop");
  });
  await expect(page.getByTestId("transfer-receive-done")).toBeVisible();
  await expect(page.getByTestId("transfer-receive-count")).toHaveText("1 document was added to your library.");
  await expect(page.getByTestId("transfer-save-device")).toHaveCount(0);
});

test("moving the library shows what goes first, then the QR code", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Invoice.pdf");
  await openTransfer(page);
  await page.getByTestId("transfer-move-open").click();
  const summary = page.getByTestId("transfer-move-summary");
  await expect(summary).toContainText("2 documents");
  await expect(summary).toContainText("0 tags");
  await page.getByTestId("transfer-move-qr").click();
  await expect(page.getByTestId("transfer-qr")).toBeVisible();
  await expect(page.getByTestId("transfer-offer-summary")).toContainText("2 documents");
  await hook(page, "peerScans");
  await page.getByTestId("transfer-confirm").click();
  await expect(page.getByTestId("transfer-send-done")).toBeVisible();
});

test("after receiving from a new device, it can be saved", async ({ page }) => {
  await page.goto("/");
  await openTransfer(page);
  await receiveTab(page);
  await pasteLink(page, LINK);
  await hook(page, "senderConfirms");
  await expect(page.getByTestId("transfer-receive-done")).toBeVisible();
  await page.getByTestId("transfer-save-device").click();
  await page.getByTestId("save-device-confirm").click();
  await expect(page.getByTestId("transfer-save-device")).toHaveCount(0);
  await page.getByTestId("transfer-receive-again").click();
  await expect(page.getByTestId("transfer-trusted-hint")).toBeVisible();
});
