/**
 * Static website (P5a, ADR 0024): English at /, Greek at /el/; landing, features, privacy
 * (docs/PRIVACY.md, docs/PRIVACY.el.md), download (GitHub release APKs with SHA-256). No
 * JavaScript, no cookies, no trackers, no remote fonts or CDNs: Inter is self-hosted, the
 * colours are the app's design tokens (packages/ui/src/tokens.css).
 *
 * Usage: node website/build.ts [outDir=website/dist]
 * Env:   SITE_URL (absolute, for canonical / hreflang / sitemap; default the GitHub Pages URL),
 *        SELIS_RELEASE_DIR (release.json from `gh release view --json …` and SHA256SUMS),
 *        SELIS_APK_CERT_SHA256 (the release certificate's fingerprint, once there is one).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COPY, type Copy, type Lang, STORES } from "./content.ts";
import { escapeHtml as e, markdownToHtml } from "./md.ts";

const ROOT = join(import.meta.dirname, "..");
const HERE = import.meta.dirname;
const OUT = process.argv[2] ?? join(HERE, "dist");
const SITE_URL = (process.env.SITE_URL ?? "https://anywecon.github.io/selis/").replace(/\/?$/, "/");
const REPO = "https://github.com/anywecon/selis";
const LANGS: Lang[] = ["en", "el"];
const PAGES = ["", "features/", "privacy/", "download/"] as const;
type PagePath = (typeof PAGES)[number];

export type ReleaseAsset = { name: string; size: number; url: string };
export type Release = { tag: string; name: string; published: string; url: string; apks: Array<ReleaseAsset & { abi: string; sha256: string }> };

const ABIS: Array<[string, string]> = [
  ["arm64-v8a", "arm64-v8a"],
  ["armeabi-v7a", "armeabi-v7a"],
  ["x86_64", "x86_64"],
  ["x86", "x86"],
  ["universal", "universal"],
];

/** The release to list on the download page, from `gh release view --json` and SHA256SUMS. */
export function readRelease(json: string, sums: string): Release {
  const data = JSON.parse(json) as { tagName: string; name: string; publishedAt: string; url: string; assets: Array<{ name: string; size: number; url: string }> };
  const hashes = new Map(
    sums
      .split("\n")
      .map((line) => line.trim().split(/\s+\*?/))
      .filter((parts) => parts.length === 2)
      .map(([hash, file]) => [file ?? "", hash ?? ""]),
  );
  const apks = data.assets
    .filter((a) => a.name.endsWith(".apk"))
    .map((a) => {
      const abi = ABIS.find(([needle]) => a.name.includes(`-${needle}`))?.[1] ?? "universal";
      const sha256 = hashes.get(a.name);
      if (!sha256) throw new Error(`SHA256SUMS has no entry for ${a.name}`);
      return { ...a, abi, sha256 };
    })
    .sort((x, y) => ABIS.findIndex(([n]) => n === x.abi) - ABIS.findIndex(([n]) => n === y.abi));
  return { tag: data.tagName, name: data.name, published: data.publishedAt, url: data.url, apks };
}

function release(): Release | null {
  const dir = process.env.SELIS_RELEASE_DIR;
  if (!dir || !existsSync(join(dir, "release.json"))) return null;
  return readRelease(readFileSync(join(dir, "release.json"), "utf8"), readFileSync(join(dir, "SHA256SUMS"), "utf8"));
}

/** Relative prefix from a page to the site root. */
function up(lang: Lang, page: PagePath | "404"): string {
  const depth = (lang === "el" ? 1 : 0) + (page === "" || page === "404" ? 0 : 1);
  return depth === 0 ? "./" : "../".repeat(depth);
}

function href(from: { lang: Lang; page: PagePath | "404" }, lang: Lang, page: PagePath): string {
  return `${up(from.lang, from.page)}${lang === "el" ? "el/" : ""}${page}` || "./";
}

function absolute(lang: Lang, page: PagePath): string {
  return `${SITE_URL}${lang === "el" ? "el/" : ""}${page}`;
}

type Shot = { name: string; width: number; height: number };

function screens(lang: Lang): Map<string, Shot> {
  const dir = join(HERE, "assets", "screens", lang);
  const out = new Map<string, Shot>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    const m = file.match(/^(.+)\.webp$/);
    if (m?.[1]) out.set(m[1], { name: `${lang}/${file}`, width: 540, height: 960 });
  }
  return out;
}

function layout(c: Copy, lang: Lang, page: PagePath | "404", title: string, body: string): string {
  const root = up(lang, page);
  const other: Lang = lang === "en" ? "el" : "en";
  const nav = (["", "features/", "privacy/", "download/"] as PagePath[])
    .map((p) => {
      const label = p === "" ? c.nav.home : p === "features/" ? c.nav.features : p === "privacy/" ? c.nav.privacy : c.nav.download;
      const current = p === page ? ' aria-current="page"' : "";
      return `<a href="${href({ lang, page }, lang, p)}"${current}${p === "" ? ' class="brand"' : ""}>${p === "" ? `<img src="${root}assets/icon.svg" alt="" width="28" height="28"><span class="brand-name">${e(label)}</span>` : e(label)}</a>`;
    })
    .join("");
  const alternates =
    page === "404"
      ? ""
      : LANGS.map((l) => `<link rel="alternate" hreflang="${COPY[l].htmlLang}" href="${absolute(l, page)}">`).join("") +
        `<link rel="alternate" hreflang="x-default" href="${absolute("en", page)}"><link rel="canonical" href="${absolute(lang, page)}">`;
  const switchTo = page === "404" ? href({ lang, page }, other, "") : href({ lang, page }, other, page);
  return `<!doctype html>
<html lang="${c.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(c.meta.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#24438f">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(c.meta.description)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="${c.locale}">
<meta property="og:image" content="${SITE_URL}assets/og.png">
${alternates}
<link rel="icon" href="${root}assets/icon.svg" type="image/svg+xml">
<link rel="preload" href="${root}assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${root}assets/site.css">
</head>
<body>
<a class="skip" href="#main">${lang === "el" ? "Μετάβαση στο περιεχόμενο" : "Skip to content"}</a>
<header class="top"><nav aria-label="${e(c.nav.menu)}">${nav}</nav><a class="lang" href="${switchTo}" hreflang="${COPY[other].htmlLang}" lang="${COPY[other].htmlLang}">${e(c.nav.otherLanguage)}</a></header>
<main id="main">
${body}
</main>
<footer class="foot"><p><a href="${REPO}">${e(c.footer.source)}</a> · <a href="${REPO}/blob/main/LICENSE">${e(c.footer.license)}</a> · <a href="${href({ lang, page }, lang, "privacy/")}">${e(c.nav.privacy)}</a></p>${STORES.some((s) => s.live) ? `<p class="small">${e(c.footer.trademarks)}</p>` : ""}<p class="small">© 2026 Any WeCon</p></footer>
</body>
</html>
`;
}

function picture(root: string, shot: Shot | undefined, alt: string, eager = false): string {
  if (!shot) return "";
  return `<img class="shot" src="${root}assets/screens/${shot.name}" alt="${e(alt)}" width="${String(shot.width)}" height="${String(shot.height)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
}

function home(c: Copy, lang: Lang): string {
  const root = up(lang, "");
  const shots = screens(lang);
  const h = c.home;
  const cards = h.highlights
    .map((f) => `<li class="card">${picture(root, f.shot ? shots.get(f.shot) : undefined, f.title)}<h3>${e(f.title)}</h3><p>${e(f.body)}</p></li>`)
    .join("");
  return `<section class="hero">
<div class="hero-text">
<h1>${e(h.tagline)}</h1>
<p class="lead">${e(h.lead)}</p>
<p class="actions"><a class="button" href="${href({ lang, page: "" }, lang, "download/")}">${e(h.cta)}</a><a class="button ghost" href="${href({ lang, page: "" }, lang, "features/")}">${e(h.secondary)}</a></p>
<ul class="pillars">${h.pillars.map((p) => `<li>${e(p)}</li>`).join("")}</ul>
</div>
${picture(root, shots.get("1-library"), h.highlights[5]?.title ?? "", true)}
</section>
<section><h2>${e(h.highlightsTitle)}</h2><ul class="cards">${cards}</ul></section>
<section class="split">
<div><h2>${e(h.privacyTitle)}</h2><p>${e(h.privacyBody)}</p><p><a href="${href({ lang, page: "" }, lang, "privacy/")}">${e(h.privacyLink)}</a></p></div>
<div><h2>${e(h.openTitle)}</h2><p>${e(h.openBody)}</p><p>${e(h.aiNote)}</p><p><a href="${REPO}">${e(h.openLink)}</a></p></div>
</section>`;
}

function features(c: Copy): string {
  const groups = c.features.groups.map((g) => `<section class="group"><h2>${e(g.title)}</h2><ul>${g.items.map((i) => `<li>${e(i)}</li>`).join("")}</ul></section>`).join("");
  return `<h1>${e(c.features.title)}</h1><p class="lead">${e(c.features.lead)}</p><div class="groups">${groups}</div>`;
}

function privacy(lang: Lang): { title: string; html: string } {
  const file = lang === "el" ? "PRIVACY.el.md" : "PRIVACY.md";
  const { title, html } = markdownToHtml(readFileSync(join(ROOT, "docs", file), "utf8"), (link) => (link === "PRIVACY.md" ? "../../privacy/" : link));
  return { title, html: `<article class="prose"><h1>${e(title)}</h1>\n${html}</article>` };
}

function mib(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function download(c: Copy, lang: Lang, rel: Release | null): string {
  const root = up(lang, "download/");
  const d = c.download;
  const stores = STORES.map((s) => {
    const badge = s.badge[lang];
    if (s.live && badge) return `<li><a href="${s.url}"><img src="${root}assets/${badge}" alt="${e(s.name)}" width="194" height="75"></a></li>`;
    return `<li class="soon"><span class="store">${e(s.name)}</span><span>${e(d.comingSoon)}</span></li>`;
  }).join("");
  const table = rel
    ? `<p>${e(rel.name)} · <time datetime="${e(rel.published)}">${e(rel.published.slice(0, 10))}</time> · <a href="${e(rel.url)}">${e(rel.tag)}</a></p>
<p class="hint">${e(d.which)}</p>
<div class="table"><table><thead><tr><th scope="col">${e(d.abi)}</th><th scope="col">${e(d.file)}</th><th scope="col">${e(d.size)}</th><th scope="col">${e(d.sha256)}</th></tr></thead><tbody>${rel.apks
        .map((a) => `<tr><td>${e(a.abi)}</td><td><a href="${e(a.url)}">${e(a.name)}</a></td><td>${mib(a.size)}</td><td><code class="hash">${e(a.sha256)}</code></td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p>${e(d.noRelease)}</p>`;
  const cert = process.env.SELIS_APK_CERT_SHA256;
  return `<h1>${e(d.title)}</h1><p class="lead">${e(d.lead)}</p>
<section><h2>${e(d.stores)}</h2><ul class="stores">${stores}</ul></section>
<section><h2>${e(d.github)}</h2><p>${e(d.githubBody)}</p>${table}<p><a href="${REPO}/releases">${e(d.releasesLink)}</a></p>
<h3>${e(d.verifyTitle)}</h3><p>${e(d.verifyBody)}</p>
<p>${e(d.certificate)}: ${cert ? `<code class="hash">${e(cert)}</code>` : e(d.certificatePending)}</p></section>
<section><h2>${e(d.obtainium)}</h2>${rel ? `<p><img src="${root}assets/badges/obtainium.png" alt="Obtainium" width="194" height="75"></p>` : ""}<p>${e(d.obtainiumBody)}</p></section>`;
}

/** Inter (latin, latin-ext, greek) from @fontsource-variable/inter, with its unicode ranges. */
function fonts(outDir: string): string {
  const dir = join(ROOT, "node_modules", "@fontsource-variable", "inter");
  const css = readFileSync(join(dir, "wght.css"), "utf8");
  const blocks = [...css.matchAll(/\/\* (inter-(?:latin|latin-ext|greek)-wght-normal) \*\/\s*(@font-face\s*\{[^}]+\})/g)];
  mkdirSync(join(outDir, "fonts"), { recursive: true });
  return blocks
    .map(([, name, block]) => {
      copyFileSync(join(dir, "files", `${name ?? ""}.woff2`), join(outDir, "fonts", `${name ?? ""}.woff2`));
      return (block ?? "").replace(/url\(\.\/files\//, "url(fonts/");
    })
    .join("\n");
}

function main(): void {
  rmSync(OUT, { recursive: true, force: true });
  const assets = join(OUT, "assets");
  mkdirSync(assets, { recursive: true });
  const tokens = readFileSync(join(ROOT, "packages", "ui", "src", "tokens.css"), "utf8");
  writeFileSync(join(assets, "site.css"), `${fonts(assets)}\n${tokens}\n${readFileSync(join(HERE, "site.css"), "utf8")}`);
  copyFileSync(join(ROOT, "apps", "app", "assets", "icon.svg"), join(assets, "icon.svg"));
  for (const sub of ["badges", "screens"]) {
    const from = join(HERE, "assets", sub);
    if (existsSync(from)) copyDir(from, join(assets, sub));
  }
  copyFileSync(join(HERE, "assets", "og.png"), join(assets, "og.png"));

  const rel = release();
  for (const lang of LANGS) {
    const c = COPY[lang];
    const pages: Array<[PagePath, string, string]> = [
      ["", c.home.title, home(c, lang)],
      ["features/", `${c.features.title} — Selis`, features(c)],
      ["privacy/", `${privacy(lang).title} — Selis`, privacy(lang).html],
      ["download/", c.download.title, download(c, lang, rel)],
    ];
    for (const [page, title, body] of pages) {
      const file = join(OUT, lang === "el" ? "el" : "", page, "index.html");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, layout(c, lang, page, title, body));
    }
  }
  const nf = COPY.en.notFound;
  writeFileSync(
    join(OUT, "404.html"),
    layout(COPY.en, "en", "404", `${nf.title} — Selis`, `<h1>${e(nf.title)}</h1><p>${e(nf.body)}</p><p><a href="${SITE_URL}">${e(nf.home)}</a></p>`).replace(
      /(href|src)="\.\/assets\//g,
      `$1="${SITE_URL}assets/`,
    ),
  );
  writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);
  const urls = LANGS.flatMap((l) => PAGES.map((p) => `<url><loc>${absolute(l, p)}</loc></url>`)).join("");
  writeFileSync(join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`);
  // GitHub Pages: serve files as they are (no Jekyll).
  writeFileSync(join(OUT, ".nojekyll"), "");
  console.log(`website: ${String(LANGS.length * PAGES.length)} pages → ${OUT}${rel ? ` (release ${rel.tag}, ${String(rel.apks.length)} APKs)` : " (no release yet)"}`);
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

if (process.argv[1]?.endsWith("build.ts")) main();
