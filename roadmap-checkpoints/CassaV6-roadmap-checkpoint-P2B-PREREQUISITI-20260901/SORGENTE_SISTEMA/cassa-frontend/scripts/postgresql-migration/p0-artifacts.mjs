import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, readFile, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGoldenDataset,
  validateGoldenDataset,
} from "./p0-golden-dataset.mjs";

export { buildGoldenDataset, validateGoldenDataset };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_OUTPUT_DIR = path.join(DEFAULT_APP_ROOT, "reports", "postgresql-migration", "p0");
const DEFAULT_SOURCE_ARCHIVE = {
  label: "V6.0.0.6.zip",
  sha256: "8FDC73B116FD1C697A127CC10E1104BCF7046121522F4C65FB8177F7F1506361",
};
const DEFAULT_ROADMAP_ARCHIVE = {
  label: "V6_POSTGRESQL_MIGRATION_ROADMAP_REV2.zip",
  sha256: "6AA37ACC12F423A9B021B9419F21D405C091D132C6304CDF47102D481AEDD992",
};

const LEGACY_PATTERNS = [
  "readDb(",
  "writeDb(",
  "node:sqlite",
  "mysql2",
  "app_state",
  "app_state_domain_records",
  "BACKEND_RELATIONAL_DB_PATH",
];

const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".sql", ".sh", ".json"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "test-results"]);

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function listSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

function isRuntimeFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return !(
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("/fixtures/") ||
    /(?:^|\/)tests?\.(?:js|mjs|ts)$/.test(normalized) ||
    /\.(?:test|spec)\.(?:js|mjs|ts)$/.test(normalized)
  );
}

export async function collectLegacyReferences(appRoot = DEFAULT_APP_ROOT) {
  const backendRoot = path.join(appRoot, "backend");
  const rows = [];
  const files = await listSourceFiles(backendRoot);

  for (const absolutePath of files) {
    const relativePath = path.relative(appRoot, absolutePath).replaceAll("\\", "/");
    const runtime = isRuntimeFile(relativePath);
    const lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/u);
    for (const [lineIndex, code] of lines.entries()) {
      for (const pattern of LEGACY_PATTERNS) {
        let searchFrom = 0;
        while (true) {
          const column = code.indexOf(pattern, searchFrom);
          if (column < 0) break;
          rows.push({
            pattern,
            file: relativePath,
            line: lineIndex + 1,
            column: column + 1,
            runtime,
            code: code.trim(),
          });
          searchFrom = column + pattern.length;
        }
      }
    }
  }

  rows.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.pattern.localeCompare(right.pattern),
  );
  return rows;
}

export function summarizeLegacyReferences(rows) {
  const summary = {};
  for (const pattern of LEGACY_PATTERNS) {
    const allRows = rows.filter((row) => row.pattern === pattern);
    const runtimeRows = allRows.filter((row) => row.runtime);
    summary[pattern] = {
      allOccurrences: allRows.length,
      allFiles: new Set(allRows.map((row) => row.file)).size,
      runtimeOccurrences: runtimeRows.length,
      runtimeFiles: new Set(runtimeRows.map((row) => row.file)).size,
    };
  }
  return summary;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function gitValue(appRoot, args) {
  try {
    return execFileSync("git", ["-C", appRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function pathExists(candidatePath) {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function buildRuntimeArtifactDeclaration(appRoot) {
  const repositoryRoot = path.dirname(appRoot);
  const artifacts = {
    cassaCompiledEntry: "cassa-frontend/dist/index.html",
    cassaBuildEntry: "cassa-frontend/index.html",
    settingsCompiledEntry: "settings-frontend/dist/index.html",
    mobileCompiledEntry: "mobile-frontend/dist/index.html",
    workstationCompiledEntry: "postazione/dist/index.html",
  };
  const availability = Object.fromEntries(await Promise.all(
    Object.entries(artifacts).map(async ([name, relativePath]) => [
      name,
      {
        relativePath,
        present: await pathExists(path.join(repositoryRoot, relativePath)),
      },
    ]),
  ));

  return {
    repositoryRoot,
    availability,
    cassaWebRuntimeAvailable: availability.cassaCompiledEntry.present,
    cassaWebRebuildPossible: availability.cassaBuildEntry.present,
    sourcePackageOperationallyComplete:
      availability.cassaCompiledEntry.present || availability.cassaBuildEntry.present,
  };
}

async function buildHardwareDeclaration(appRoot) {
  const disk = await statfs(appRoot);
  return {
    evidenceScope: "development-workstation-only",
    validForProductionHardwareGate: false,
    reason: "HW-GATE-01..05 require measurements on the production Raspberry or identical hardware.",
    capturedAt: new Date().toISOString(),
    host: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    disk: {
      blockSize: Number(disk.bsize),
      blocks: Number(disk.blocks),
      availableBlocks: Number(disk.bavail),
    },
    nodeVersion: process.version,
  };
}

export async function generateP0Artifacts({
  appRoot = DEFAULT_APP_ROOT,
  outputDir = DEFAULT_OUTPUT_DIR,
} = {}) {
  await mkdir(outputDir, { recursive: true });
  const references = await collectLegacyReferences(appRoot);
  const inventoryHeader = ["pattern", "file", "line", "column", "runtime", "code"];
  const inventoryCsv = [
    inventoryHeader.map(csvCell).join(","),
    ...references.map((row) => inventoryHeader.map((key) => csvCell(row[key])).join(",")),
  ].join("\n") + "\n";
  await writeFile(path.join(outputDir, "legacy-storage-inventory.csv"), inventoryCsv, "utf8");

  const inventorySummary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appRoot,
    patterns: summarizeLegacyReferences(references),
  };
  await writeFile(
    path.join(outputDir, "legacy-storage-summary.json"),
    `${JSON.stringify(inventorySummary, null, 2)}\n`,
    "utf8",
  );

  const dataset = buildGoldenDataset();
  const validation = validateGoldenDataset(dataset);
  if (!validation.ok) throw new Error(`Invalid golden dataset: ${validation.errors.join("; ")}`);
  const datasetJson = `${JSON.stringify(dataset, null, 2)}\n`;
  const datasetHash = sha256(datasetJson);
  await writeFile(path.join(outputDir, "golden-dataset.json"), datasetJson, "utf8");
  await writeFile(
    path.join(outputDir, "golden-dataset.sha256"),
    `${datasetHash}  golden-dataset.json\n`,
    "utf8",
  );

  const baseline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      sourceArchive: {
        label: process.env.PG_MIGRATION_SOURCE_LABEL ?? DEFAULT_SOURCE_ARCHIVE.label,
        sha256: process.env.PG_MIGRATION_SOURCE_SHA256 ?? DEFAULT_SOURCE_ARCHIVE.sha256,
      },
      roadmapArchive: {
        label: process.env.PG_MIGRATION_ROADMAP_LABEL ?? DEFAULT_ROADMAP_ARCHIVE.label,
        sha256: process.env.PG_MIGRATION_ROADMAP_SHA256 ?? DEFAULT_ROADMAP_ARCHIVE.sha256,
      },
      gitRepositoryLineage: {
        head: gitValue(appRoot, ["rev-parse", "HEAD"]),
        branch: gitValue(appRoot, ["branch", "--show-current"]),
      },
      packageVersion: JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")).version,
    },
    runtimeArtifacts: await buildRuntimeArtifactDeclaration(appRoot),
    hardware: await buildHardwareDeclaration(appRoot),
    goldenDataset: {
      relativePath: path.relative(appRoot, path.join(outputDir, "golden-dataset.json")).replaceAll("\\", "/"),
      sha256: datasetHash,
      validation,
      expected: dataset.expected,
    },
    legacyStorage: inventorySummary.patterns,
    migrationGate: {
      phase: "P0",
      productionHardwareEvidenceComplete: false,
      nextBlockingDecision: "HW-01",
    },
  };
  await writeFile(path.join(outputDir, "baseline-declaration.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  const markdown = `# PostgreSQL migration P0 baseline\n\n` +
    `Generated: ${baseline.generatedAt}\n\n` +
    `- Source archive: ${baseline.source.sourceArchive.label} (${baseline.source.sourceArchive.sha256})\n` +
    `- Roadmap archive: ${baseline.source.roadmapArchive.label} (${baseline.source.roadmapArchive.sha256})\n` +
    `- Git lineage: ${baseline.source.gitRepositoryLineage.head ?? "archive without Git identity"}\n` +
    `- Runtime readDb occurrences: ${baseline.legacyStorage["readDb("].runtimeOccurrences} in ${baseline.legacyStorage["readDb("].runtimeFiles} files\n` +
    `- Runtime writeDb occurrences: ${baseline.legacyStorage["writeDb("].runtimeOccurrences} in ${baseline.legacyStorage["writeDb("].runtimeFiles} files\n` +
    `- Golden dataset SHA-256: ${datasetHash}\n` +
    `- Cassa web runtime available: ${baseline.runtimeArtifacts.cassaWebRuntimeAvailable}\n` +
    `- Cassa web rebuild possible: ${baseline.runtimeArtifacts.cassaWebRebuildPossible}\n` +
    `- Hardware evidence: development workstation only\n` +
    `- P1 status: blocked until HW-01 is closed on the production Raspberry or identical hardware\n`;
  await writeFile(path.join(outputDir, "README.md"), markdown, "utf8");
  return baseline;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const baseline = await generateP0Artifacts();
  console.log(JSON.stringify({
    outputDir: DEFAULT_OUTPUT_DIR,
    readDb: baseline.legacyStorage["readDb("],
    writeDb: baseline.legacyStorage["writeDb("],
    goldenDatasetSha256: baseline.goldenDataset.sha256,
  }, null, 2));
}
