import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cassaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.resolve(cassaDir, "..");
const postazioneDistDir = path.join(workspaceDir, "postazione", "dist");
const postazioneIndexPath = path.join(postazioneDistDir, "index.html");
const fontAwesomeHref = "/postazione/assets/fontawesome/css/all.min.css";

async function assertFile(filePath, label) {
  const stat = await fs.stat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} mancante: ${filePath}`);
    }
    throw error;
  });
  if (!stat.isFile()) throw new Error(`${label} non e un file: ${filePath}`);
}

function resolvePostazioneUrl(urlPath) {
  const cleanPath = String(urlPath ?? "").split("#")[0].split("?")[0];
  if (!cleanPath.startsWith("/postazione/")) {
    throw new Error(`URL postazione non gestito: ${urlPath}`);
  }
  return path.resolve(postazioneDistDir, cleanPath.slice("/postazione/".length));
}

function collectCssUrls(css) {
  const urls = [];
  const pattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let match = pattern.exec(css);
  while (match) {
    const value = String(match[1] ?? "").trim();
    if (
      value &&
      !value.startsWith("data:") &&
      !value.startsWith("http://") &&
      !value.startsWith("https://")
    ) {
      urls.push(value.split("#")[0].split("?")[0]);
    }
    match = pattern.exec(css);
  }
  return urls;
}

async function validatePostazioneFontAwesome() {
  await assertFile(postazioneIndexPath, "postazione/dist/index.html");
  const html = await fs.readFile(postazioneIndexPath, "utf8");
  const lowerHtml = html.toLowerCase();
  const forbidden = ["http://", "https://", "cdnjs", "cloudflare"];
  const foundForbidden = forbidden.filter((token) => lowerHtml.includes(token));
  if (foundForbidden.length > 0) {
    throw new Error(`postazione/dist/index.html contiene riferimenti remoti vietati: ${foundForbidden.join(", ")}`);
  }
  if (!html.includes(fontAwesomeHref)) {
    throw new Error(`postazione/dist/index.html non referencia ${fontAwesomeHref}`);
  }

  const cssPath = resolvePostazioneUrl(fontAwesomeHref);
  await assertFile(cssPath, "Font Awesome CSS locale");

  const css = await fs.readFile(cssPath, "utf8");
  const cssDir = path.dirname(cssPath);
  const webfontRefs = collectCssUrls(css).filter((reference) => /webfonts\/.+\.(?:woff2?|ttf|eot|svg)$/i.test(reference));
  if (webfontRefs.length === 0) {
    throw new Error("Font Awesome CSS locale non referencia webfont locali.");
  }

  const existingWebfonts = [];
  for (const reference of webfontRefs) {
    const fontPath = path.resolve(cssDir, reference);
    if (!fontPath.startsWith(postazioneDistDir)) {
      throw new Error(`Font Awesome CSS referencia un font fuori dist: ${reference}`);
    }
    try {
      await assertFile(fontPath, `Font Awesome webfont ${reference}`);
      existingWebfonts.push(reference);
    } catch {
      // All referenced webfonts are checked below as a missing list.
    }
  }

  const missingWebfonts = [];
  for (const reference of webfontRefs) {
    const fontPath = path.resolve(cssDir, reference);
    try {
      await assertFile(fontPath, `Font Awesome webfont ${reference}`);
    } catch {
      missingWebfonts.push(reference);
    }
  }
  if (missingWebfonts.length > 0) {
    throw new Error(`Font Awesome webfont mancanti: ${missingWebfonts.join(", ")}`);
  }

  console.log(`static frontends ok: Font Awesome locale con ${existingWebfonts.length} webfont verificati`);
}

validatePostazioneFontAwesome().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
