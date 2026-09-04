import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(projectDir, "dist");
const indexPath = path.join(distDir, "index.html");

function collectAssetReferences(html) {
  const references = new Set();
  const attributePattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  let match = attributePattern.exec(html);
  while (match) {
    const rawValue = String(match[1] ?? "").trim();
    const withoutFragment = rawValue.split("#")[0] ?? "";
    const cleanValue = withoutFragment.split("?")[0] ?? "";
    if (
      cleanValue &&
      !cleanValue.startsWith("http://") &&
      !cleanValue.startsWith("https://") &&
      !cleanValue.startsWith("data:") &&
      !cleanValue.startsWith("mailto:") &&
      !cleanValue.startsWith("#")
    ) {
      references.add(cleanValue);
    }
    match = attributePattern.exec(html);
  }
  return [...references];
}

function resolveDistReference(reference) {
  const normalized = reference.replace(/^\/+/, "");
  return path.resolve(distDir, normalized || "index.html");
}

async function assertFileExists(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} non e un file.`);
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`${label} mancante: ${filePath}`);
    }
    throw error;
  }
}

async function main() {
  await assertFileExists(indexPath, "dist/index.html");
  const html = await fs.readFile(indexPath, "utf-8");
  if (!html.includes('<div id="root"></div>')) {
    throw new Error("dist/index.html non contiene il mount point #root.");
  }

  const references = collectAssetReferences(html);
  const missing = [];
  for (const reference of references) {
    const resolved = resolveDistReference(reference);
    if (!resolved.startsWith(distDir)) {
      missing.push(`${reference} -> path fuori dist`);
      continue;
    }
    try {
      await assertFileExists(resolved, reference);
    } catch {
      missing.push(reference);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Asset dist mancanti: ${missing.join(", ")}`);
  }

  console.log(`static dist ok: ${references.length} asset referenziati verificati`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
