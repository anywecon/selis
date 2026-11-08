/**
 * Scanning the QR code with the camera (project `camera`: Chromium with a fake
 * camera that films the fixture QR code, see fake-camera.ts). The decoded link
 * starts the receive exactly as a pasted one would.
 */
import { expect, test } from "@playwright/test";
import { presetSettings } from "./helpers";

test("scans the QR code with the camera and starts receiving", async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Transfer" }).click();
  await page.getByRole("tab", { name: "Receive" }).click();
  await page.getByTestId("transfer-scan").click();
  // The decoder reads the code within a few frames; who sends it is asked first, then the code.
  await page.getByTestId("transfer-link-accept").click();
  await expect(page.getByTestId("transfer-receive-code")).toHaveText("482 913");
  // The camera is off again once the code was read.
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll("video")].some((v) => v.srcObject !== null)))
    .toBe(false);
});
