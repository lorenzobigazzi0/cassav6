#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const smoke = args.has("--smoke");
const canary = args.has("--canary");
const keepReportJsonOnly = args.has("--no-pdf");
if (smoke && canary) {
  throw new Error("Le modalita --smoke e --canary sono mutuamente esclusive.");
}
const hasDisplay =
  process.platform === "win32" ||
  process.platform === "darwin" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function filesIn(directory, name) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...filesIn(target, name));
    else if (entry.isFile() && entry.name === name) results.push(target);
  }
  return results;
}

function findChrome() {
  const explicit = String(process.env.LOADTEST_CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const fixed = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find(existsSync);
  if (fixed) return fixed;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const selenium = filesIn(path.join(home, ".cache", "selenium", "chrome"), "chrome")
    .sort()
    .at(-1);
  if (selenium) return selenium;
  const playwrightRoots = [
    path.join(home, ".cache", "ms-playwright"),
    path.join(process.env.LOCALAPPDATA || "", "ms-playwright"),
  ];
  return playwrightRoots
    .flatMap((root) => [
      ...filesIn(root, "chrome"),
      ...filesIn(root, "chrome.exe"),
    ])
    .sort()
    .at(-1) || null;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} terminato con ${signal || `codice ${code}`}.`));
    });
  });
}

function npmInvocation(commandArgs) {
  if (process.platform !== "win32") {
    return { command: "npm", args: commandArgs };
  }
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...commandArgs],
  };
}

const P5_SMOKE_ACTIONS_PER_DEVICE = 8;
const P5_CANARY_ACTIONS_PER_DEVICE = 100;
const P5_FULL_ACTIONS_PER_DEVICE = 1_000;
const mode = smoke ? "smoke" : canary ? "canary" : "full";
const actionsPerDevice = smoke
  ? P5_SMOKE_ACTIONS_PER_DEVICE
  : canary
    ? P5_CANARY_ACTIONS_PER_DEVICE
    : P5_FULL_ACTIONS_PER_DEVICE;
const chrome = findChrome();
const runId = process.env.LOADTEST_RUN_ID ||
  `p5_20x5_${mode}_${25 * actionsPerDevice}_${timestamp()}`;
const totalDevices = 25;
const totalActions = totalDevices * actionsPerDevice;
const minimumDurationMs = (totalActions - 1) * Math.ceil(1_000 / 3) + 1;
const reportDir = path.join(projectRoot, "logs", `loadtest-${runId}`);
const reportJson = path.join(reportDir, "report.json");
const latencyCheckpoints = path.join(reportDir, "p5-latency-checkpoints.jsonl");
const contentionReportJson = path.join(reportDir, "p5-contention-report.json");
const contentionReportMarkdown = path.join(reportDir, "P5_CONTENTION_REPORT.md");
const expectedApiWorkers = Math.max(
  1,
  Math.min(8, Math.trunc(Number(process.env.LOADTEST_API_WORKERS || 2) || 2)),
);
const expectedTableLockWorkers = Math.max(
  0,
  Math.min(
    4,
    Math.trunc(Number(process.env.LOADTEST_TABLE_LOCK_WORKERS || 1) || 1),
  ),
);
const baselineDiagnostics = [
  path.join(reportDir, "backend-baseline.jsonl"),
  path.join(reportDir, "backend-realtime-baseline.jsonl"),
  ...Array.from({ length: expectedApiWorkers }, (_, index) =>
    path.join(reportDir, `backend-api-worker-${index + 1}-baseline.jsonl`),
  ),
  ...Array.from({ length: expectedTableLockWorkers }, (_, index) =>
    path.join(reportDir, `backend-table-lock-worker-${index + 1}-baseline.jsonl`),
  ),
];
const stationRoot = path.join(projectRoot, "postazione");
const stationDistIndex = path.join(stationRoot, "dist", "index.html");

const env = {
  ...process.env,
  NODE_BIN: process.execPath,
  LOADTEST_RUN_ID: runId,
  LOADTEST_PROFILE: "p5-endurance",
  LOADTEST_HANDHELDS: "20",
  LOADTEST_STATIONS: "5",
  LOADTEST_GUI: "2",
  LOADTEST_REALTIME_CLIENTS: "20",
  LOADTEST_P5_ACTIONS_PER_DEVICE: String(actionsPerDevice),
  LOADTEST_P5_ACTIONS_PER_SECOND: "3",
  LOADTEST_P5_GUI_ACTION_EVERY: smoke ? "1" : "4",
  LOADTEST_P5_LONG_PRESS_MS: "2100",
  LOADTEST_MULTIPROCESS: "1",
  LOADTEST_API_WORKERS: process.env.LOADTEST_API_WORKERS || "2",
  LOADTEST_TABLE_LOCK_WORKERS: process.env.LOADTEST_TABLE_LOCK_WORKERS || "1",
  LOADTEST_TABLE_LOCK_TOMBSTONES: "1",
  LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT: process.env.LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT || "8",
  LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE: process.env.LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE || "4",
  LOADTEST_API_WORKER_AUTH_FASTPATH: "1",
  LOADTEST_API_WORKER_REDIS_POOL_SIZE: process.env.LOADTEST_API_WORKER_REDIS_POOL_SIZE || "4",
  LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH:
    process.env.LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH || "1",
  LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH:
    process.env.LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH || "1",
  LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH:
    process.env.LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH || "1",
  LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH:
    process.env.LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH || "1",
  LOADTEST_PRINTING_ENABLED: "1",
  LOADTEST_PRINTER_HOST: "127.0.0.1",
  LOADTEST_PRINTER_PORT: "19109",
  LOADTEST_PRINTER_COUNT: "5",
  LOADTEST_PRINTER_METRICS_PORT: "19299",
  LOADTEST_START_MOCK_IO: "1",
  POS_FISCAL_API_BASE_URL: "http://127.0.0.1:19290",
  LOADTEST_AUTOMATIC_CASH_BASE_URL: "http://127.0.0.1:19190",
  LOADTEST_BATTERY_SERVICE_URL: "http://127.0.0.1:19790/battery",
  LOADTEST_ALLOW_NON_LOOPBACK_IO: "0",
  LOADTEST_GUI_HEADLESS: smoke && !hasDisplay ? "1" : "0",
  LOADTEST_CHROMIUM_EXECUTABLE_PATH: chrome || "",
  LOADTEST_CHROMIUM_NO_SANDBOX: process.env.LOADTEST_CHROMIUM_NO_SANDBOX || "0",
  LOADTEST_REALISTIC_NETWORK_OUTAGE_MS: smoke ? "2000" : canary ? "10000" : "60000",
  LOADTEST_REALISTIC_STATION_LOGOUT_MS: smoke ? "5000" : canary ? "30000" : "600000",
  LOADTEST_FISCAL_SAMPLE_LIMIT: smoke ? "1" : canary ? "3" : "5",
  LOADTEST_P5_ALLOW_NONSTANDARD: smoke || canary ? "1" : "0",
  LOADTEST_P5_ALLOW_HEADLESS: smoke ? "1" : "0",
  LOADTEST_P5_CHECKPOINT_INTERVAL_MS: smoke ? "1000" : canary ? "10000" : "30000",
  APP_STATE_DIRTY_TRACKING: "write",
  APP_STATE_DIRTY_TRACKING_MODE: "write",
  PRINT_SPOOL_FAST_WORKER: "1",
};

const manifest = {
  mode,
  runId,
  profile: env.LOADTEST_PROFILE,
  handhelds: 20,
  stations: 5,
  mobileGuiWindows: 2,
  stationGuiWindows: 1,
  actionsPerDevice,
  totalActions,
  maxActionStartsPerSecond: 3,
  minimumDurationMs,
  minimumDuration: `${Math.floor(minimumDurationMs / 3_600_000)}h ${Math.floor((minimumDurationMs % 3_600_000) / 60_000)}m ${Math.ceil((minimumDurationMs % 60_000) / 1_000)}s`,
  virtualTcpPrinters: [19109, 19110, 19111, 19112, 19113],
  virtualFiscal: env.POS_FISCAL_API_BASE_URL,
  virtualAutomaticCash: env.LOADTEST_AUTOMATIC_CASH_BASE_URL,
  virtualBattery: env.LOADTEST_BATTERY_SERVICE_URL,
  nonLoopbackIoAllowed: false,
  chrome,
  headed: env.LOADTEST_GUI_HEADLESS === "0",
  reportDir,
  latencyCheckpoints,
  contentionReportJson,
  contentionReportMarkdown,
  baselineDiagnostics,
  stationDistPresent: existsSync(stationDistIndex),
};

if (!chrome) {
  throw new Error("Chrome/Chromium non trovato. Installa un browser Playwright o imposta LOADTEST_CHROMIUM_EXECUTABLE_PATH.");
}
if (!smoke && !hasDisplay) {
  throw new Error("Il run P5 canary/full richiede una sessione grafica visibile (DISPLAY o WAYLAND_DISPLAY).");
}

console.log(JSON.stringify(manifest, null, 2));
if (dryRun) process.exit(0);

if (!existsSync(path.join(stationRoot, "node_modules"))) {
  const npmCi = npmInvocation(["ci", "--no-audit", "--no-fund"]);
  await run(npmCi.command, npmCi.args, { cwd: stationRoot, env });
}
const npmBuild = npmInvocation(["run", "build"]);
await run(npmBuild.command, npmBuild.args, { cwd: stationRoot, env });
if (!existsSync(stationDistIndex)) {
  throw new Error(`Build postazione assente dopo il preflight: ${stationDistIndex}`);
}

await run(process.execPath, [path.join(scriptDir, "loadtest-full-capacity.mjs")], {
  cwd: projectRoot,
  env,
});

if (!existsSync(reportJson)) {
  throw new Error(`Report P5 non trovato dopo il test: ${reportJson}`);
}
await run(
  process.execPath,
  [path.join(scriptDir, "p5-contention-report.mjs"), reportDir],
  { cwd: projectRoot, env },
);
if (!existsSync(latencyCheckpoints)) {
  throw new Error(`Checkpoint latenze P5 non trovato dopo il test: ${latencyCheckpoints}`);
}
const missingBaselineDiagnostics = baselineDiagnostics.filter(
  (filePath) => !existsSync(filePath),
);
if (missingBaselineDiagnostics.length > 0) {
  throw new Error(
    `Diagnostica baseline P5 mancante: ${missingBaselineDiagnostics.join(", ")}`,
  );
}
if (!existsSync(contentionReportJson) || !existsSync(contentionReportMarkdown)) {
  throw new Error("Report contesa P5 non prodotto.");
}
if (!keepReportJsonOnly) {
  await run(process.execPath, [path.join(scriptDir, "p5-endurance-report-pdf.mjs"), reportJson], {
    cwd: projectRoot,
    env,
  });
}

const completedReport = JSON.parse(readFileSync(reportJson, "utf8"));
const completedContentionReport = JSON.parse(readFileSync(contentionReportJson, "utf8"));
const recordedFailures = Array.isArray(completedReport?.recorder?.failures)
  ? completedReport.recorder.failures
  : [];
const p5FailedActions = Number(completedReport?.p5Profile?.totalFailed || 0);
const contentionGateFailures = Array.isArray(completedContentionReport?.gate?.failures)
  ? completedContentionReport.gate.failures
  : ["contention_gate_missing"];
if (recordedFailures.length > 0 || p5FailedActions > 0 || contentionGateFailures.length > 0) {
  const failureTypes = [...new Set(
    recordedFailures.map((entry) => String(entry?.type || "unknown")).filter(Boolean),
  )];
  throw new Error(
    `P5 non superato: ${recordedFailures.length} failure registrate, ` +
    `${p5FailedActions} azioni fallite (${failureTypes.join(", ") || "senza dettaglio"}); ` +
    `gate contesa: ${contentionGateFailures.join(", ") || "verde"}.`,
  );
}
