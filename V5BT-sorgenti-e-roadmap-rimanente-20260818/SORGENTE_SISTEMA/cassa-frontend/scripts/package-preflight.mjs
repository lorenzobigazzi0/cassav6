#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  relFrom,
  validateReleasePackage,
  validateReleaseSourceShape,
} from "./package-guardrails.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaDir = path.resolve(scriptDir, "..");
const sourceRoot = path.resolve(cassaDir, "..");
const options = parseArgs(process.argv.slice(2));
const findings = [];

function parseArgs(argv) {
  const parsed = {
    json: false,
    strict: true,
    root: "",
    rootProvided: false,
    mode: "package",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--no-strict") parsed.strict = false;
    else if (arg === "--source") parsed.mode = "source";
    else if (arg === "--package") parsed.mode = "package";
    else if (arg === "--mode") {
      const value = String(argv[index + 1] ?? "").trim().toLowerCase();
      parsed.mode = value === "source" ? "source" : "package";
      index += 1;
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length).trim().toLowerCase();
      parsed.mode = value === "source" ? "source" : "package";
    } else if (arg === "--root") {
      parsed.root = path.resolve(String(argv[index + 1] ?? ""));
      parsed.rootProvided = true;
      index += 1;
    } else if (arg.startsWith("--root=")) {
      parsed.root = path.resolve(arg.slice("--root=".length));
      parsed.rootProvided = true;
    }
  }
  if (!parsed.root) parsed.root = sourceRoot;
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/package-preflight.mjs --source [--root SOURCE_ROOT] [--json] [--no-strict]
  node scripts/package-preflight.mjs --package --root PACKAGE_DIR [--json] [--no-strict]

Controlli eseguiti:
  - in modalita' source: layout sorgente release-package e contratti anti-regressione mobile;
  - in modalita' package: stessi path obbligatori piu' blocco DB/log/spool/node_modules/cert/snapshot runtime;
  - mobile src/dist senza fallback stanze statiche legacy;
  - il layout supportato e' quello prodotto da scripts/release-package.mjs.
`);
}

function addFinding(severity, type, message, file = "") {
  findings.push({ severity, type, message, file });
}

function rel(filePath) {
  return relFrom(options.root, filePath);
}

function walk(root, visitor) {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = statSync(current);
    } catch (error) {
      addFinding("P2", "stat_failed", error.message, current);
      continue;
    }
    visitor(current, stat);
    if (!stat.isDirectory()) continue;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      addFinding("P2", "read_dir_failed", error.message, current);
      continue;
    }
    for (const entry of entries) {
      stack.push(path.join(current, entry.name));
    }
  }
}

function shouldScanText(filePath) {
  const normalized = filePath.replaceAll(path.sep, "/");
  if (!normalized.includes("/mobile-frontend/src/") && !normalized.includes("/mobile-frontend/dist/")) {
    return false;
  }
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|html|css|json|map)$/i.test(filePath);
}

function checkMobileFallbackStrings() {
  const forbiddenPatterns = [
    { type: "legacy_room_id", pattern: /\bsala_main\b/g },
    { type: "legacy_room_id", pattern: /\bsala_terrazza\b/g },
    { type: "legacy_room_id", pattern: /\bsala_privata\b/g },
    { type: "legacy_room_id", pattern: /\bsala_eventi\b/g },
    { type: "legacy_room_id", pattern: /\bsala_bar\b/g },
    { type: "legacy_room_label", pattern: /Sala Principale/g },
    { type: "legacy_room_fallback_symbol", pattern: /BUILTIN_FALLBACK_ROOMS|buildRoomsForRole|DEFAULT_ROOM_ID/g },
    { type: "battery_early_block_message", pattern: /Device mobile non riconosciuto/g },
  ];

  const mobileRoot = path.join(options.root, "mobile-frontend");
  walk(mobileRoot, (current, stat) => {
    if (!stat.isFile() || !shouldScanText(current)) return;
    let content = "";
    try {
      content = readFileSync(current, "utf8");
    } catch {
      return;
    }
    for (const { type, pattern } of forbiddenPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        addFinding("P1", type, `Stringa legacy rilevata nel mobile: ${pattern.source}`, current);
      }
    }
  });
}

async function collectModeFindings() {
  if (options.mode === "source") {
    findings.push(...(await validateReleaseSourceShape(options.root)));
  } else {
    if (!options.rootProvided && options.root === sourceRoot) {
      addFinding(
        "P1",
        "package_root_missing",
        "In modalita' package indica la cartella generata con --root PACKAGE_DIR; usa --source per il sorgente corrente.",
        options.root,
      );
    } else {
      findings.push(...(await validateReleasePackage(options.root)));
    }
  }
  checkMobileFallbackStrings();
}

function printHumanSummary() {
  if (findings.length === 0) {
    const label = options.mode === "source" ? "sorgente" : "pacchetto";
    console.log(`[package-preflight] OK: ${label} release-package pulito e contratti anti-regressione presenti.`);
    return;
  }
  console.error(`[package-preflight] FAIL: ${findings.length} finding.`);
  for (const finding of findings) {
    const location = finding.file ? ` (${rel(finding.file)})` : "";
    console.error(`- ${finding.severity} ${finding.type}: ${finding.message}${location}`);
  }
}

if (options.help) {
  printHelp();
  process.exit(0);
}

await collectModeFindings();

if (options.json) {
  console.log(JSON.stringify({ ok: findings.length === 0, mode: options.mode, root: options.root, findings }, null, 2));
} else {
  printHumanSummary();
}

const blockingSeverities = options.strict ? new Set(["P0", "P1", "P2", "P3"]) : new Set(["P0", "P1", "P2"]);
const hasBlocking = findings.some((finding) => blockingSeverities.has(finding.severity));
process.exit(hasBlocking ? 2 : 0);
