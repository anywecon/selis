/**
 * Store graphics from the app's own artwork and design tokens (no image editor, reproducible):
 *
 * - Google Play app icon, 512 × 512 PNG, full-bleed square (Play applies its own mask):
 *   fastlane/metadata/android/en-US/images/icon.png
 * - Google Play feature graphic, 1024 × 500 PNG without alpha:
 *   fastlane/metadata/android/en-US/images/featureGraphic.png
 *   Store images are English-only (docs/store/play-console.md): every other listing language
 *   falls back to the en-US set; CI fails on another locale's images (scripts/check-store-images.sh).
 * - Website: social preview website/assets/og.png (1200 × 630) and the screenshots as WebP,
 *   540 × 960, website/assets/screens/en/ (from the light Play screenshots). The Greek pages keep
 *   their committed website/assets/screens/el/ set.
 * - GitHub social preview, 1280 × 640 PNG (English): docs/store/github-social-preview.png. It is
 *   uploaded by hand (repository Settings › Social preview); GitHub has no API for it.
 *
 * Sources: apps/app/assets/icon.svg, packages/ui/src/tokens.css (accent and neutral colours),
 * Inter from @fontsource-variable/inter (self-hosted, embedded as data URLs).
 * Specs: https://support.google.com/googleplay/android-developer/answer/9866151
 *
 * Usage: node tools/store/render-graphics.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
const META = join(ROOT, "fastlane", "metadata", "android");

const TAGLINE = { title: "Selis", line: "PDFs on your phone. No account, no ads, no tracking." };

function token(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`token --${name} not found`);
  return m[1].trim();
}

function fontFace(file: string): string {
  const data = readFileSync(join(ROOT, "node_modules", "@fontsource-variable", "inter", "files", file)).toString("base64");
  return `@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}

async function main(): Promise<void> {
  const tokens = readFileSync(join(ROOT, "packages", "ui", "src", "tokens.css"), "utf8");
  const accent = token(tokens, "accent-9");
  const paper = "#fdfcfa";
  const svg = readFileSync(join(ROOT, "apps", "app", "assets", "icon.svg"), "utf8");
  // Play masks the icon itself: full-bleed square, no rounded corners of our own.
  const squareIcon = svg.replace(/<rect width="1024" height="1024" rx="224"/, '<rect width="1024" height="1024"');
  const fonts = fontFace("inter-latin-wght-normal.woff2") + fontFace("inter-greek-wght-normal.woff2");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    {
      const text = TAGLINE;
      const dir = join(META, "en-US", "images");
      mkdirSync(dir, { recursive: true });

      await page.setViewportSize({ width: 512, height: 512 });
      await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:512px;height:512px}</style>${squareIcon}`);
      await page.screenshot({ path: join(dir, "icon.png"), omitBackground: false });

      await page.setViewportSize({ width: 1024, height: 500 });
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${fonts}
        html,body{margin:0;width:1024px;height:500px;overflow:hidden}
        body{background:linear-gradient(180deg,#2b4ea6,${accent});font-family:Inter,sans-serif;color:${paper};display:flex;align-items:center;gap:56px;padding:0 88px;box-sizing:border-box}
        svg{width:232px;height:232px;flex:none;filter:drop-shadow(0 12px 32px rgb(0 0 0 / .28))}
        h1{margin:0 0 18px;font-size:96px;font-weight:700;letter-spacing:-.02em;line-height:1}
        p{margin:0;font-size:36px;font-weight:500;line-height:1.25;max-width:560px;text-wrap:balance;color:#dfe6f7}
      </style>${svg}<div><h1>${text.title}</h1><p>${text.line}</p></div>`);
      // Runs in the page (DOM types are not in this Node project's lib).
      await page.evaluate("document.fonts.ready.then(() => true)");
      await page.screenshot({ path: join(dir, "featureGraphic.png"), omitBackground: false });
      console.log("en-US: icon.png 512×512, featureGraphic.png 1024×500");
    }

    for (const [width, height, out] of [
      [1200, 630, join(ROOT, "website", "assets", "og.png")],
      [1280, 640, join(ROOT, "docs", "store", "github-social-preview.png")],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${fonts}
        html,body{margin:0;width:${String(width)}px;height:${String(height)}px;overflow:hidden}
        body{background:linear-gradient(180deg,#2b4ea6,${accent});font-family:Inter,sans-serif;color:${paper};display:flex;align-items:center;gap:64px;padding:0 110px;box-sizing:border-box}
        svg{width:280px;height:280px;flex:none;filter:drop-shadow(0 12px 32px rgb(0 0 0 / .28))}
        h1{margin:0 0 20px;font-size:110px;font-weight:700;letter-spacing:-.02em;line-height:1}
        p{margin:0;font-size:40px;font-weight:500;line-height:1.25;text-wrap:balance;color:#dfe6f7}
      </style>${svg}<div><h1>${TAGLINE.title}</h1><p>${TAGLINE.line}</p></div>`);
      await page.evaluate("document.fonts.ready.then(() => true)");
      await page.screenshot({ path: out });
      console.log(`${out.slice(ROOT.length + 1)} ${String(width)}×${String(height)}`);
    }

    // Store screenshots → WebP for the website (canvas encoder of Chromium, quality 0.85).
    {
      const from = join(META, "en-US", "images", "phoneScreenshots");
      const to = join(ROOT, "website", "assets", "screens", "en");
      mkdirSync(to, { recursive: true });
      for (const file of readdirSync(from).filter((f) => f.endsWith(".png"))) {
        const png = readFileSync(join(from, file)).toString("base64");
        await page.setContent("<!doctype html><canvas></canvas>");
        const dataUrl = await page.evaluate<string>(`(async () => {
          const img = new Image();
          img.src = "data:image/png;base64,${png}";
          await img.decode();
          const c = document.querySelector("canvas");
          c.width = 540; c.height = 960;
          const g = c.getContext("2d");
          g.imageSmoothingQuality = "high";
          g.drawImage(img, 0, 0, 540, 960);
          return c.toDataURL("image/webp", 0.85);
        })()`);
        writeFileSync(join(to, file.replace(/\.png$/, ".webp")), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
      }
      console.log(`website: screens/en (${String(readdirSync(to).length)} WebP)`);
    }
  } finally {
    await browser.close();
  }
}

await main();
