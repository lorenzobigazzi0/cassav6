import { promises as fs } from "node:fs";
import path from "node:path";

export const FORBIDDEN_DIR_NAMES = new Set([
  ".git",
  ".gradle",
  ".print-spool",
  ".tmp-refactor",
  "logs",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export const FORBIDDEN_FILE_PATTERNS = [
  /^(?:README|MANIFEST)_STEP\d+\.(?:md|txt)$/i,
  /\.(?:apk|aab)$/i,
  /\.log$/i,
  /\.pid$/i,
  /\.sqlite(?:-(?:wal|shm))?$/i,
  /\.db$/i,
  /\.db-(?:wal|shm)$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.crt$/i,
  /\.bak(?:[-._].*)?$/i,
  /\.bak[-._]/i,
  /tsconfig\.tsbuildinfo$/i,
  /^app-state\.json$/i,
  /^mock-db\.json$/i,
  /^app-state\.before-.*\.json$/i,
  /^app-state\.partial-.*\.json$/i,
];

export const RSYNC_EXCLUDES = [
  "node_modules/",
  ".git/",
  ".gradle/",
  ".print-spool/",
  ".tmp-refactor/",
  "logs/",
  "test-results/",
  "playwright-report/",
  "screenshots/",
  "/cassa-frontend/reports/",
  "mobile-frontend/certs/",
  "/README_STEP*.md",
  "/MANIFEST_STEP*.txt",
  "/PACKAGE_MANIFEST*.txt",
  "/EXPORT_MANIFEST*.txt",
  "/EXPORT_FILE_COUNT*.txt",
  "/cassa-frontend/README_STEP*.md",
  "/cassa-frontend/MANIFEST_STEP*.txt",
  "/cassa-frontend/PACKAGE_MANIFEST*.txt",
  "*.apk",
  "*.aab",
  "*.log",
  "*.pid",
  "*.sqlite",
  "*.sqlite-wal",
  "*.sqlite-shm",
  "*.db",
  "*.db-wal",
  "*.db-shm",
  "*.pem",
  "*.key",
  "*.p12",
  "*.crt",
  "*.bak",
  "*.bak-*",
  "tsconfig.tsbuildinfo",
  "app-state.json",
  "mock-db.json",
  "app-state.before-*.json",
  "app-state.partial-*.json",
];

export const RELEASE_REQUIRED_PATHS = [
  "ROADMAP_ARCHITETTURA_v4.1.0.md",
  "docs/architecture/ADR-0001-modular-monolith.md",
  "docs/architecture/PHASE0_BASELINE_v4.1.0.md",
  "docs/architecture/PHASE0_GATE_RESULTS_v4.1.0.md",
  "cassa-frontend/package.json",
  "cassa-frontend/package-lock.json",
  "cassa-frontend/backend/server.js",
  "cassa-frontend/backend/scripts/start-backend.mjs",
  "cassa-frontend/backend/routes/index.js",
  "cassa-frontend/backend/modules/reports/index.js",
  "cassa-frontend/backend/modules/reports/reports.routes.js",
  "cassa-frontend/backend/modules/reports/reports.handlers.js",
  "cassa-frontend/backend/modules/reports/handheld-session-report.js",
  "cassa-frontend/backend/modules/reports/settlement-ledger.js",
  "cassa-frontend/scripts/architecture-health-report.mjs",
  "cassa-frontend/scripts/package-runtime-smoke.mjs",
  "cassa-frontend/scripts/release-package.mjs",
  "mobile-frontend/package.json",
  "mobile-frontend/src",
  "postazione/src",
  "settings-frontend/dist",
  "serve-frontends.mjs",
];

export function relFrom(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/") || ".";
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function walk(root, visitor) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) return;
  await visitor(root, stat);
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    await walk(path.join(root, entry.name), visitor);
  }
}

export async function validateRequiredReleasePaths(root, requiredPaths = RELEASE_REQUIRED_PATHS) {
  const missing = [];
  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(path.join(root, requiredPath)))) missing.push(requiredPath);
  }
  if (missing.length === 0) return [];
  return [
    {
      severity: "P1",
      type: "missing_required_path",
      message: `Percorsi obbligatori mancanti: ${missing.join(", ")}`,
    },
  ];
}

export async function validateReleaseSourceShape(sourceRoot) {
  return validateRequiredReleasePaths(sourceRoot);
}

export async function validateReleasePackage(packageDir) {
  const findings = [...(await validateReleaseSourceShape(packageDir))];

  await walk(packageDir, async (current, stat) => {
    const name = path.basename(current);
    const rel = relFrom(packageDir, current);
    if (stat.isDirectory() && FORBIDDEN_DIR_NAMES.has(name)) {
      findings.push({
        severity: "P1",
        type: "forbidden_directory",
        message: `Directory runtime vietata: ${rel}`,
      });
    }
    if (stat.isFile() && FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
      findings.push({
        severity: "P1",
        type: "forbidden_file",
        message: `File runtime/segreto vietato: ${rel}`,
      });
    }
  });

  return findings;
}
