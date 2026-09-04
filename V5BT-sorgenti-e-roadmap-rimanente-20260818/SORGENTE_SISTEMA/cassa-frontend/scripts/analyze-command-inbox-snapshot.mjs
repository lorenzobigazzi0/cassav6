#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const parsed = {
    input: path.join(projectRoot, "reports", "runtime-metrics-snapshot.json"),
    outDir: path.join(projectRoot, "reports"),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--input") { parsed.input = path.resolve(String(argv[index + 1] ?? parsed.input)); index += 1; }
    else if (arg.startsWith("--input=")) parsed.input = path.resolve(arg.slice("--input=".length));
    else if (arg === "--out-dir") { parsed.outDir = path.resolve(String(argv[index + 1] ?? parsed.outDir)); index += 1; }
    else if (arg.startsWith("--out-dir=")) parsed.outDir = path.resolve(arg.slice("--out-dir=".length));
  }
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/analyze-command-inbox-snapshot.mjs --input reports/runtime-metrics-snapshot.json --out-dir reports

Legge uno snapshot runtime e genera:
  reports/command-inbox-summary.json
  reports/command-inbox-summary.md
`);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

export function buildCommandInboxSummary(snapshot = {}) {
  const counters = asObject(snapshot.counters);
  const dashboard = asObject(asObject(snapshot.dashboard).commandInbox);
  const attempts = count(counters.commandInboxClaims ?? dashboard.attempts);
  const created = count(counters.commandInboxCreated ?? dashboard.created);
  const replays = count(counters.commandInboxReplays ?? dashboard.replays);
  const conflicts = count(counters.commandInboxConflicts ?? dashboard.conflicts);
  const inProgress = count(counters.commandInboxInProgress ?? dashboard.inProgress);
  const committed = count(counters.commandInboxCommitted ?? dashboard.committed);
  const rejected = count(counters.commandInboxRejected ?? dashboard.rejected);
  const failed = count(counters.commandInboxFailed ?? dashboard.failed);
  return {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAtMs: count(snapshot.generatedAtMs),
    attempts,
    created,
    replays,
    replayRatePct: attempts > 0 ? Math.round((replays / attempts) * 10_000) / 100 : 0,
    conflicts,
    conflictRatePct: attempts > 0 ? Math.round((conflicts / attempts) * 10_000) / 100 : 0,
    inProgress,
    committed,
    rejected,
    failed,
    terminal: committed + rejected + failed,
    status: conflicts > 0 ? "review" : "ok",
  };
}

export function toMarkdown(summary) {
  return `# Command inbox summary

Generato: ${summary.generatedAt}

## Sintesi

- Attempts: ${summary.attempts}
- Created: ${summary.created}
- Replays: ${summary.replays}
- Replay rate: ${summary.replayRatePct}%
- Conflicts: ${summary.conflicts}
- Conflict rate: ${summary.conflictRatePct}%
- In progress: ${summary.inProgress}
- Committed: ${summary.committed}
- Rejected: ${summary.rejected}
- Failed: ${summary.failed}
- Stato: ${summary.status}

## Interpretazione

- Replay > 0 indica retry/doppio tap correttamente intercettati.
- Conflict > 0 indica stessa idempotency key con payload diverso: va verificato prima di abilitare command bus/MQTT commands.
- In progress crescente indica comandi rimasti pendenti o worker bloccati.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(options.input, "utf8"));
  } catch (error) {
    console.error(`[command-inbox] impossibile leggere ${options.input}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const summary = buildCommandInboxSummary(snapshot);
  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(path.join(options.outDir, "command-inbox-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(options.outDir, "command-inbox-summary.md"), toMarkdown(summary), "utf8");
  console.log(`[command-inbox] report scritto in ${options.outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
