#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RSYNC_EXCLUDES,
  pathExists,
  validateReleasePackage,
} from "./package-guardrails.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.resolve(cassaRoot, "..");
const workspaceRoot = path.resolve(sourceRoot, "..", "..", "..");
const defaultOutputRoot = path.join(workspaceRoot, "release-packages");
const PACKAGE_METADATA_FILES = new Set([
  "README_HANDOVER.md",
  "BUILD_INFO.json",
  "MANIFEST.txt",
  "SHA256SUMS",
]);
const REQUIRED_REPORT_MODULES = [
  "cassa-frontend/backend/modules/reports/index.js",
  "cassa-frontend/backend/modules/reports/reports.routes.js",
  "cassa-frontend/backend/modules/reports/reports.handlers.js",
  "cassa-frontend/backend/modules/reports/handheld-session-report.js",
  "cassa-frontend/backend/modules/reports/settlement-ledger.js",
];

function parseArgs(argv) {
  const parsed = {
    version: "v4.1.0",
    outputRoot: defaultOutputRoot,
    clean: false,
    dryRun: false,
    noZip: false,
    verifyOnly: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--clean") parsed.clean = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--no-zip") parsed.noZip = true;
    else if (arg === "--version") {
      parsed.version = normalizeVersion(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--version=")) {
      parsed.version = normalizeVersion(arg.slice("--version=".length));
    } else if (arg === "--output") {
      parsed.outputRoot = path.resolve(String(argv[index + 1] ?? ""));
      index += 1;
    } else if (arg.startsWith("--output=")) {
      parsed.outputRoot = path.resolve(arg.slice("--output=".length));
    } else if (arg === "--verify") {
      parsed.verifyOnly = path.resolve(String(argv[index + 1] ?? ""));
      index += 1;
    } else if (arg.startsWith("--verify=")) {
      parsed.verifyOnly = path.resolve(arg.slice("--verify=".length));
    }
  }

  return parsed;
}

function normalizeVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "v4.1.0";
  const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) return "v4.1.0";
  return /^\d/.test(safe) ? `v${safe}` : safe;
}

function printHelp() {
  console.log(`Uso:
  node scripts/release-package.mjs [--version v4.1.0] [--output DIR] [--clean] [--no-zip]
  node scripts/release-package.mjs --verify PACKAGE_DIR
  node scripts/release-package.mjs --dry-run

Output default:
  ${defaultOutputRoot}/v4.1.0/

Il pacchetto esclude runtime/cache/DB/log/certificati e fallisce se li ritrova
nella cartella finale. Include manifest, checksum per-file e smoke runtime isolato.`);
}

function ensureTool(name) {
  try {
    return execFileSync("sh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`Tool richiesto non disponibile nel PATH: ${name}`);
  }
}

async function checksumFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

async function collectFileEntries(root, excludedNames = new Set()) {
  const entries = [];

  async function visit(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(current, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (excludedNames.has(relativePath)) continue;
      if (child.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`Tipo di file non supportato nel pacchetto: ${relativePath}`);
      }
      const stat = await fs.stat(absolutePath);
      entries.push({
        path: relativePath,
        bytes: stat.size,
        sha256: await checksumFile(absolutePath),
      });
    }
  }

  await visit(root);
  return entries;
}

function hashEntryList(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.sha256}  ${entry.path}\n`);
  }
  return hash.digest("hex");
}

async function writePackageMetadata({ packageDir, packageName, options }) {
  const generatedAt = new Date().toISOString();
  const payloadEntries = await collectFileEntries(packageDir, PACKAGE_METADATA_FILES);
  const payloadBytes = payloadEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  const contentTreeSha256 = hashEntryList(payloadEntries);
  const buildInfo = {
    schemaVersion: 1,
    packageLabel: options.version,
    packageRoot: packageName,
    generatedAt,
    source: {
      snapshot: path.basename(sourceRoot),
      gitAvailable: false,
      gitCommit: null,
      note: "La sorgente consegnata non contiene metadati Git; l'identita' verificabile e' contentTreeSha256.",
    },
    content: {
      payloadFileCount: payloadEntries.length,
      payloadBytes,
      contentTreeSha256,
    },
    requiredRuntimeReports: REQUIRED_REPORT_MODULES,
    hardwarePolicy: {
      apkIncluded: false,
      runtimeDatabasesIncluded: false,
      realPrintingUsedBySmoke: false,
      realFiscalUsedBySmoke: false,
      realAutomaticCashUsedBySmoke: false,
    },
  };
  await fs.writeFile(
    path.join(packageDir, "BUILD_INFO.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );

  const readmeLines = [
    `# Sistema Cassa V4 - handover ${options.version}`,
    "",
    "Questo e' il metadato autorevole del pacchetto. I vecchi README/MANIFEST Step 2 e Step 3 sono esclusi per evitare ambiguita' sul contenuto certificato.",
    "",
    "## Correzione P0 packaging",
    "",
    "Il pacchetto include e verifica tutti i moduli runtime in `cassa-frontend/backend/modules/reports/`. La preflight fallisce se anche uno dei cinque file obbligatori manca.",
    "",
    "## Identita'",
    "",
    `- Label: \`${options.version}\``,
    `- Root archivio: \`${packageName}/\``,
    `- Snapshot sorgente: \`${path.basename(sourceRoot)}\``,
    "- Commit Git: non disponibile nella sorgente ricevuta",
    `- Content tree SHA256: \`${contentTreeSha256}\``,
    "- Dettagli macchina: `BUILD_INFO.json`",
    "- Elenco file: `MANIFEST.txt`",
    "- Checksum di ogni file: `SHA256SUMS`",
    "",
    "## Installazione e verifica isolata",
    "",
    "Dalla root estratta:",
    "",
    "```bash",
    "cd cassa-frontend",
    "npm ci --no-audit --no-fund",
    "npm run check:backend",
    "node scripts/package-preflight.mjs --package --root ..",
    "npm run smoke:package-runtime",
    "```",
    "",
    "Lo smoke avvia il vero entry point backend, usa un DB JSON temporaneo, chiama `/api/health` e tre API pubbliche, quindi termina il processo. Stampa, fiscale, MQTT, Redis e cassa automatica reali restano disabilitati.",
    "",
    "## Stato della roadmap",
    "",
    "La roadmap e le evidenze disponibili sono incluse nel pacchetto. Il sorgente contiene anche l'harness P5; il packaging non dichiara da solo completata alcuna fase e gli esiti devono essere letti nei report allegati.",
    "",
  ];
  await fs.writeFile(path.join(packageDir, "README_HANDOVER.md"), readmeLines.join("\n"));

  const manifestEntries = await collectFileEntries(
    packageDir,
    new Set(["MANIFEST.txt", "SHA256SUMS"]),
  );
  const manifestLines = [
    `Sistema Cassa V4 source handover ${options.version}`,
    `Generated at: ${generatedAt}`,
    `Package root: ${packageName}/`,
    `Source snapshot: ${path.basename(sourceRoot)}`,
    "Git commit: unavailable",
    `Payload content tree SHA256: ${contentTreeSha256}`,
    `Listed files: ${manifestEntries.length}`,
    "",
    "BYTES\tPATH",
    ...manifestEntries.map((entry) => `${entry.bytes}\t${entry.path}`),
    "",
  ];
  await fs.writeFile(path.join(packageDir, "MANIFEST.txt"), manifestLines.join("\n"));

  const checksumEntries = await collectFileEntries(packageDir, new Set(["SHA256SUMS"]));
  await fs.writeFile(
    path.join(packageDir, "SHA256SUMS"),
    checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n",
  );

  return {
    generatedAt,
    payloadFileCount: payloadEntries.length,
    payloadBytes,
    checksumFileCount: checksumEntries.length,
    contentTreeSha256,
  };
}

async function createPackage(options) {
  const releaseDir = path.join(options.outputRoot, options.version);
  const packageName = `sistema-cassa-${options.version}-source`;
  const packageDir = path.join(releaseDir, packageName);
  const zipPath = path.join(releaseDir, `${packageName}.zip`);
  const checksumPath = `${zipPath}.sha256`;

  if (options.dryRun) {
    return {
      dryRun: true,
      releaseDir,
      packageDir,
      zipPath: options.noZip ? "" : zipPath,
      excludes: RSYNC_EXCLUDES,
    };
  }

  ensureTool("rsync");
  if (!options.noZip) ensureTool("zip");

  if (await pathExists(releaseDir)) {
    if (!options.clean) {
      throw new Error(`Output gia' esistente: ${releaseDir}. Usa --clean per rigenerarlo.`);
    }
    await fs.rm(releaseDir, { recursive: true, force: true });
  }

  await fs.mkdir(releaseDir, { recursive: true });

  const rsyncArgs = [
    "-a",
    "--delete",
    ...RSYNC_EXCLUDES.flatMap((entry) => ["--exclude", entry]),
    `${sourceRoot}/`,
    `${packageDir}/`,
  ];
  execFileSync("rsync", rsyncArgs, { stdio: "inherit" });

  const metadata = await writePackageMetadata({ packageDir, packageName, options });

  let findings = await validateReleasePackage(packageDir);
  if (findings.length > 0) {
    throw new Error(`Pacchetto non pulito:\n${findings.map((finding) => `- ${finding.message}`).join("\n")}`);
  }

  let sha256 = "";
  if (!options.noZip) {
    execFileSync("zip", ["-qr", zipPath, packageName], {
      cwd: releaseDir,
      stdio: "inherit",
    });
    sha256 = await checksumFile(zipPath);
    await fs.writeFile(checksumPath, `${sha256}  ${path.basename(zipPath)}\n`);
  }

  return {
    dryRun: false,
    releaseDir,
    packageDir,
    zipPath: options.noZip ? "" : zipPath,
    checksumPath: options.noZip ? "" : checksumPath,
    sha256,
    metadata,
    findings,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.verifyOnly) {
    const findings = await validateReleasePackage(options.verifyOnly);
    if (findings.length > 0) {
      console.error(JSON.stringify({ ok: false, packageDir: options.verifyOnly, findings }, null, 2));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ ok: true, packageDir: options.verifyOnly, findings: [] }, null, 2));
    return;
  }

  const result = await createPackage(options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
