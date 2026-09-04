import fs from "node:fs";
import path from "node:path";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".gradle",
  "__pycache__",
  "build",
  "dist",
  "node_modules"
]);

const PRIVATE_DIRECTORY_NAMES = new Set([
  ".credentials",
  ".keys",
  ".logs",
  ".private",
  ".registry",
  ".runtime",
  ".secrets",
  "certificates",
  "certs",
  "credentials",
  "keys",
  "logs",
  "private",
  "registry",
  "runtime",
  "secrets"
]);

const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  ".gitignore",
  "00_INDEX.md",
  "MANIFEST.txt",
  "README.md",
  "VERSION.txt",
  "android",
  "architecture",
  "backend",
  "checklists",
  "configs",
  "contracts",
  "prompts",
  "raspberry",
  "references",
  "reports",
  "roadmap",
  "scripts",
  "shared",
  "templates",
  "testing"
]);

const ALLOWED_FILE_EXTENSIONS = new Set([
  ".example",
  ".gitignore",
  ".gitkeep",
  ".json",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".mts",
  ".png",
  ".proto",
  ".py",
  ".service",
  ".sh",
  ".ts",
  ".txt",
  ".xml"
]);

const EXCLUDED_FILE_PATTERNS = [
  /(?:^|\/)\.DS_Store$/u,
  /\.pyc$/u
];

const FORBIDDEN_FILE_PATTERNS = [
  /(?:^|\/)(?:\.env|credentials\.json|id_ed25519|id_rsa|secrets?\.json)$/iu,
  /\.(?:7z|aab|apk|bz2|db|gz|jks|key|keystore|log|p12|pem|pfx|rar|sqlite|sqlite3|tar|tgz|xz|zip)$/iu
];

function normalizedRelativePath(value) {
  return value.split(path.sep).join("/");
}

function isExcludedFile(relativePath) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function isForbiddenFile(relativePath) {
  return FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function assertAllowedTopLevel(relativeDirectory, entryName, relativePath) {
  if (relativeDirectory === "" && !ALLOWED_TOP_LEVEL_ENTRIES.has(entryName)) {
    throw new Error(`Top-level package entry is not allowlisted: ${relativePath}`);
  }
}

function assertAllowedFile(relativePath) {
  if (isForbiddenFile(relativePath)) {
    throw new Error(`Sensitive or generated file is forbidden: ${relativePath}`);
  }
  const basename = path.basename(relativePath);
  const extension = basename === ".gitignore" || basename === ".gitkeep"
    ? basename
    : path.extname(relativePath).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Package file extension is not allowlisted: ${relativePath}`);
  }
}

export function listRoadmapPackageFiles(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];

  function visit(directory, relativeDirectory = "") {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const relativePath = normalizedRelativePath(
        path.join(relativeDirectory, entry.name)
      );
      const absolutePath = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (PRIVATE_DIRECTORY_NAMES.has(entry.name)) {
          if (fs.readdirSync(absolutePath).length > 0) {
            throw new Error(`Private package directory is not empty: ${relativePath}`);
          }
          continue;
        }
        assertAllowedTopLevel(relativeDirectory, entry.name, relativePath);
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported filesystem entry: ${relativePath}`);
      }
      if (isExcludedFile(relativePath)) continue;
      assertAllowedTopLevel(relativeDirectory, entry.name, relativePath);
      assertAllowedFile(relativePath);
      files.push(relativePath);
    }
  }

  visit(resolvedRoot);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

export function readRoadmapManifest(manifestPath) {
  const rawLines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/u);
  const entries = rawLines.filter((line) => line.length > 0);
  const errors = [];
  const seen = new Set();

  for (const entry of entries) {
    if (
      entry.trim() !== entry ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").includes("..")
    ) {
      errors.push(`Invalid manifest entry: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry)) errors.push(`Duplicate manifest entry: ${entry}`);
    seen.add(entry);
  }

  const sorted = [...entries].sort((left, right) =>
    left.localeCompare(right, "en")
  );
  if (entries.some((entry, index) => entry !== sorted[index])) {
    errors.push("Manifest entries must be sorted canonically");
  }

  return { entries, errors };
}

export function compareRoadmapManifest(root, manifestPath) {
  const { entries, errors } = readRoadmapManifest(manifestPath);
  const actual = listRoadmapPackageFiles(root);
  const declaredSet = new Set(entries);
  const actualSet = new Set(actual);

  return {
    errors,
    missingFromManifest: actual.filter((entry) => !declaredSet.has(entry)),
    missingFromPackage: entries.filter((entry) => !actualSet.has(entry))
  };
}

export function serializeRoadmapManifest(entries) {
  return `${[...entries]
    .sort((left, right) => left.localeCompare(right, "en"))
    .join("\n")}\n`;
}
