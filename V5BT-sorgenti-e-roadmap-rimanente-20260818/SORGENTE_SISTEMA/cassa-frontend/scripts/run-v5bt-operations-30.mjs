#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import {
  V5BT_ACTION_MAX_MS,
  V5BT_ACTION_P95_MAX_MS,
  V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
  V5BT_COMMAND_P95_MAX_MS,
  V5BT_GUI_HOT_READ_BASE_BUDGET,
  V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
  V5BT_MAX_IN_FLIGHT_GLOBAL,
  V5BT_MAX_IN_FLIGHT_PER_DEVICE,
} from "./v5bt-operations-gates.mjs";
import {
  evaluateV5btHostPressure,
  parseLinuxLoadavg,
  parseLinuxMeminfo,
} from "./v5bt-host-pressure-preflight.mjs";
import { V5BT_OPERATIONS_SCHEDULER_CONTRACT_VERSION } from "./v5bt-operations-scheduler.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const micro = args.has("--micro");
const smoke = args.has("--smoke");
const unknownArgs = [...args].filter((arg) => !["--dry-run", "--micro", "--smoke"].includes(arg));
if (unknownArgs.length > 0) {
  throw new Error(`Argomenti non riconosciuti: ${unknownArgs.join(", ")}.`);
}
if (micro && smoke) {
  throw new Error("Le modalita --micro e --smoke sono alternative.");
}

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
  return [
    path.join(home, ".cache", "ms-playwright"),
    path.join(process.env.LOCALAPPDATA || "", "ms-playwright"),
  ]
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
    const adjacentNpm = path.join(path.dirname(process.execPath), "npm");
    return { command: existsSync(adjacentNpm) ? adjacentNpm : "npm", args: commandArgs };
  }
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...commandArgs],
  };
}

const V5BT_MICRO_ACTIONS_PER_DEVICE = 10;
const V5BT_SMOKE_ACTIONS_PER_DEVICE = 40;
const V5BT_FULL_ACTIONS_PER_DEVICE = 200;
const HANDHELDS = 25;
const STATIONS = 5;
const MOBILE_GUI_WINDOWS = 2;
const ACTION_INTERVAL_MS = 3_000;
const COMMAND_INTERVAL_MIN_MS = 7_000;
const COMMAND_INTERVAL_MAX_MS = 8_000;
const mode = micro ? "micro" : smoke ? "smoke" : "full";
const actionsPerDevice = micro
  ? V5BT_MICRO_ACTIONS_PER_DEVICE
  : smoke
    ? V5BT_SMOKE_ACTIONS_PER_DEVICE
    : V5BT_FULL_ACTIONS_PER_DEVICE;
const totalDevices = HANDHELDS + STATIONS;
const totalActions = totalDevices * actionsPerDevice;
const minimumDurationMs =
  (actionsPerDevice - 1) * ACTION_INTERVAL_MS +
  (totalDevices - 1) * (ACTION_INTERVAL_MS / totalDevices);
const V5BT_DIAGNOSTIC_LANE_MATRIX = "orders0-tables1-payments1-presence0";
const requestedDiagnosticLaneMatrix = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_LANE_MATRIX || "",
).trim();
if (
  requestedDiagnosticLaneMatrix &&
  requestedDiagnosticLaneMatrix !== V5BT_DIAGNOSTIC_LANE_MATRIX
) {
  throw new Error(
    `Matrice lane diagnostica non riconosciuta: ${requestedDiagnosticLaneMatrix}.`,
  );
}
const diagnosticLaneMatrixEnabled =
  requestedDiagnosticLaneMatrix === V5BT_DIAGNOSTIC_LANE_MATRIX;
const laneCrossExclusions = diagnosticLaneMatrixEnabled
  ? { orders: false, tables: true, payments: true, presence: false }
  : { orders: false, tables: false, payments: false, presence: false };
const V5BT_CERTIFIED_PAYMENT_LANE_CONCURRENCY = 2;
const V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY = 3;
const requestedDiagnosticPaymentLaneConcurrency = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY || "",
).trim();
if (
  requestedDiagnosticPaymentLaneConcurrency &&
  requestedDiagnosticPaymentLaneConcurrency !==
    String(V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY)
) {
  throw new Error(
    "Override diagnostico payment lane non riconosciuto: usare esclusivamente " +
      `LOADTEST_V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY=${V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY}.`,
  );
}
const diagnosticPaymentLaneConcurrencyEnabled =
  requestedDiagnosticPaymentLaneConcurrency ===
  String(V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY);
const paymentLaneConcurrency = diagnosticPaymentLaneConcurrencyEnabled
  ? V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY
  : V5BT_CERTIFIED_PAYMENT_LANE_CONCURRENCY;
const V5BT_CERTIFIED_AUTO_PRINT_OWNER_INTERVAL_MS = 25;
const V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS = 100;
const requestedDiagnosticAutoPrintOwnerIntervalMs = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS || "",
).trim();
if (
  requestedDiagnosticAutoPrintOwnerIntervalMs &&
  requestedDiagnosticAutoPrintOwnerIntervalMs !==
    String(V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS)
) {
  throw new Error(
    "Override diagnostico intervallo owner auto-print non riconosciuto: usare esclusivamente " +
      `LOADTEST_V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS=${V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS}.`,
  );
}
const diagnosticAutoPrintOwnerIntervalEnabled =
  requestedDiagnosticAutoPrintOwnerIntervalMs ===
  String(V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS);
const autoPrintOwnerIntervalMs = diagnosticAutoPrintOwnerIntervalEnabled
  ? V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS
  : V5BT_CERTIFIED_AUTO_PRINT_OWNER_INTERVAL_MS;
const requestedDiagnosticStationStateMarkerLockSkip = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP || "",
).trim();
if (
  requestedDiagnosticStationStateMarkerLockSkip &&
  requestedDiagnosticStationStateMarkerLockSkip !== "1"
) {
  throw new Error(
    "Override diagnostico skip lock marker station-state non riconosciuto: usare esclusivamente " +
      "LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP=1.",
  );
}
const diagnosticStationStateMarkerLockSkipEnabled =
  requestedDiagnosticStationStateMarkerLockSkip === "1";
const requestedDiagnosticStationStateLastWriteCoalesce = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE || "",
).trim();
if (
  requestedDiagnosticStationStateLastWriteCoalesce &&
  requestedDiagnosticStationStateLastWriteCoalesce !== "1"
) {
  throw new Error(
    "Override diagnostico coalescing lastWriteAt station-state non riconosciuto: usare esclusivamente " +
      "LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE=1.",
  );
}
const diagnosticStationStateLastWriteCoalesceEnabled =
  requestedDiagnosticStationStateLastWriteCoalesce === "1";
const diagnosticOverridesEnabled =
  diagnosticLaneMatrixEnabled ||
  diagnosticPaymentLaneConcurrencyEnabled ||
  diagnosticAutoPrintOwnerIntervalEnabled ||
  diagnosticStationStateMarkerLockSkipEnabled ||
  diagnosticStationStateLastWriteCoalesceEnabled;
const v5btOperationsEvidenceClass = diagnosticOverridesEnabled
  ? "NON_GATE"
  : "QUALIFYING_PROFILE";
const v5btOperationsPromotionEligibility = diagnosticOverridesEnabled
  ? "NON_PROMOTABLE"
  : "READINESS_ELIGIBLE";
const chrome = findChrome();
const requestedRunId = String(process.env.LOADTEST_RUN_ID || "").trim();
const runId = requestedRunId ||
  `v5bt_operations_25x5_${mode}_${totalActions}_${timestamp()}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 10)}`;
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(runId)) {
  throw new Error("LOADTEST_RUN_ID non valido: usa solo lettere, numeri, punto, trattino e underscore.");
}
const reportDir = path.join(projectRoot, "logs", `loadtest-${runId}`);
const reportJson = path.join(reportDir, "report.json");
const printSpoolDir = path.join(reportDir, "runtime", "print-spool");
const backendHost = "127.0.0.1";
const stationRoot = path.join(projectRoot, "postazione");
const stationDistIndex = path.join(stationRoot, "dist", "index.html");
if (existsSync(reportDir)) {
  throw new Error(`LOADTEST_RUN_ID gia utilizzato: la directory ${reportDir} esiste gia.`);
}

let hostReadings = {};
if (process.platform === "linux") {
  try {
    hostReadings = {
      ...parseLinuxMeminfo(readFileSync("/proc/meminfo", "utf8")),
      ...parseLinuxLoadavg(readFileSync("/proc/loadavg", "utf8")),
      logicalCpuCount: availableParallelism(),
    };
  } catch {
    hostReadings = {};
  }
}
const hostPressurePreflight = evaluateV5btHostPressure({
  platform: process.platform,
  mode,
  dryRun,
  ...hostReadings,
  overrideValue: process.env.LOADTEST_ALLOW_HOST_PRESSURE,
});

const env = {
  ...process.env,
  PATH: [path.dirname(process.execPath), process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter),
  NODE_BIN: process.execPath,
  LOADTEST_RUN_ID: runId,
  LOADTEST_PROFILE: "v5bt-operations-30",
  LOADTEST_HOST_PRESSURE_PREFLIGHT_JSON: JSON.stringify(hostPressurePreflight),
  LOADTEST_HANDHELDS: "25",
  LOADTEST_STATIONS: "5",
  LOADTEST_GUI: "2",
  LOADTEST_REALTIME_CLIENTS: "25",
  LOADTEST_V5BT_ACTIONS_PER_DEVICE: String(actionsPerDevice),
  LOADTEST_V5BT_BATTERY_NOTIFICATION_INTERVAL_MS: String(
    V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
  ),
  LOADTEST_P5_GUI_ACTION_EVERY: "4",
  LOADTEST_P5_LONG_PRESS_MS: "2100",
  LOADTEST_P5_CHECKPOINT_INTERVAL_MS: micro || smoke ? "1000" : "30000",
  LOADTEST_V5BT_MAX_IN_FLIGHT_PER_DEVICE: String(V5BT_MAX_IN_FLIGHT_PER_DEVICE),
  LOADTEST_V5BT_MAX_IN_FLIGHT_GLOBAL: String(V5BT_MAX_IN_FLIGHT_GLOBAL),
  LOADTEST_V5BT_ACTION_P95_MAX_MS: String(V5BT_ACTION_P95_MAX_MS),
  LOADTEST_V5BT_COMMAND_P95_MAX_MS: String(V5BT_COMMAND_P95_MAX_MS),
  LOADTEST_V5BT_ACTION_MAX_MS: String(V5BT_ACTION_MAX_MS),
  LOADTEST_V5BT_GUI_HOT_READ_BASE_BUDGET: String(V5BT_GUI_HOT_READ_BASE_BUDGET),
  LOADTEST_V5BT_GUI_HOT_READS_PER_ACTION_BUDGET: String(
    V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
  ),
  LOADTEST_MULTIPROCESS: "1",
  LOADTEST_API_WORKERS: process.env.LOADTEST_API_WORKERS || "4",
  LOADTEST_TABLE_LOCK_WORKERS: process.env.LOADTEST_TABLE_LOCK_WORKERS || "1",
  LOADTEST_TABLE_LOCK_TOMBSTONES: "1",
  LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT:
    process.env.LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT || "8",
  LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE:
    process.env.LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE || "4",
  LOADTEST_PAYMENT_LANE_CONCURRENCY: String(paymentLaneConcurrency),
  LOADTEST_V5BT_EVIDENCE_CLASS: v5btOperationsEvidenceClass,
  LOADTEST_V5BT_PROMOTION_ELIGIBILITY: v5btOperationsPromotionEligibility,
  LOADTEST_V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY:
    diagnosticPaymentLaneConcurrencyEnabled
      ? String(V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY)
      : "",
  LOADTEST_PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS: String(
    autoPrintOwnerIntervalMs,
  ),
  LOADTEST_V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS:
    diagnosticAutoPrintOwnerIntervalEnabled
      ? String(V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS)
      : "",
  LOADTEST_STATION_STATE_MARKER_LOCK_SKIP:
    diagnosticStationStateMarkerLockSkipEnabled ? "1" : "0",
  LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP:
    diagnosticStationStateMarkerLockSkipEnabled ? "1" : "",
  LOADTEST_STATION_STATE_LAST_WRITE_COALESCE:
    diagnosticStationStateLastWriteCoalesceEnabled ? "1" : "0",
  LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE:
    diagnosticStationStateLastWriteCoalesceEnabled ? "1" : "",
  LOADTEST_PRINT_LANE_CONCURRENCY: "1",
  LOADTEST_ORDERS_ASYNC_FLUSH_INTERVAL_MS: "500",
  LOADTEST_ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT: "0",
  LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT: "0",
  LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE: "0",
  LOADTEST_API_WORKER_AUTH_FASTPATH: "1",
  LOADTEST_API_WORKER_REDIS_POOL_SIZE:
    process.env.LOADTEST_API_WORKER_REDIS_POOL_SIZE || "4",
  LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH:
    process.env.LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH || "1",
  LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH:
    process.env.LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH || "1",
  LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH:
    process.env.LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH || "1",
  LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH:
    process.env.LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH || "1",
  BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR: "1",
  BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES: "1",
  BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER: "1",
  BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE: "1",
  BACKEND_PAYMENT_DOMAIN_NAMED_LOCK: "1",
  LANE_CROSS_EXCLUSION_ORDERS: laneCrossExclusions.orders ? "1" : "0",
  LANE_CROSS_EXCLUSION_TABLES: laneCrossExclusions.tables ? "1" : "0",
  LANE_CROSS_EXCLUSION_PAYMENTS: laneCrossExclusions.payments ? "1" : "0",
  LANE_CROSS_EXCLUSION_PRESENCE: laneCrossExclusions.presence ? "1" : "0",
  LOADTEST_PRINTING_ENABLED: "1",
  LOADTEST_PRINTER_HOST: "127.0.0.1",
  LOADTEST_PRINTER_PORT: "20109",
  LOADTEST_PRINTER_COUNT: "5",
  LOADTEST_PRINTER_METRICS_PORT: "20299",
  LOADTEST_START_MOCK_IO: "1",
  POS_FISCAL_API_BASE_URL: "http://127.0.0.1:20290",
  LOADTEST_AUTOMATIC_CASH_BASE_URL: "http://127.0.0.1:20190",
  LOADTEST_BATTERY_SERVICE_URL: "http://127.0.0.1:20790/battery",
  LOADTEST_ALLOW_NON_LOOPBACK_IO: "0",
  LOADTEST_GUI_HEADLESS: "1",
  LOADTEST_CHROMIUM_EXECUTABLE_PATH: chrome || "",
  LOADTEST_CHROMIUM_NO_SANDBOX: process.env.LOADTEST_CHROMIUM_NO_SANDBOX || "0",
  LOADTEST_REALISTIC_NETWORK_OUTAGE_MS: "2000",
  LOADTEST_REALISTIC_STATION_LOGOUT_MS: "5000",
  LOADTEST_FISCAL_SAMPLE_LIMIT: micro || smoke ? "1" : "5",
  APP_STATE_DIRTY_TRACKING: "write",
  APP_STATE_DIRTY_TRACKING_MODE: "write",
  PRINT_SPOOL_FAST_WORKER: "1",
};

const manifest = {
  mode,
  runId,
  profile: env.LOADTEST_PROFILE,
  schedulerContractVersion: V5BT_OPERATIONS_SCHEDULER_CONTRACT_VERSION,
  handhelds: HANDHELDS,
  stations: STATIONS,
  mobileGuiWindows: MOBILE_GUI_WINDOWS,
  stationGuiWindows: 1,
  apiWorkers: Number(env.LOADTEST_API_WORKERS),
  tableLockWorkers: Number(env.LOADTEST_TABLE_LOCK_WORKERS),
  actionsPerDevice,
  totalActions,
  actionIntervalMs: ACTION_INTERVAL_MS,
  aggregateActionStartsPerSecond: totalDevices * 1_000 / ACTION_INTERVAL_MS,
  commandAverageTargetMs: 7_500,
  commandIntervalGateMs: [COMMAND_INTERVAL_MIN_MS, COMMAND_INTERVAL_MAX_MS],
  runtimeLimits: {
    maxInFlightPerDevice: V5BT_MAX_IN_FLIGHT_PER_DEVICE,
    maxInFlightGlobal: V5BT_MAX_IN_FLIGHT_GLOBAL,
    actionP95MaxMs: V5BT_ACTION_P95_MAX_MS,
    commandP95MaxMs: V5BT_COMMAND_P95_MAX_MS,
    actionMaxMs: V5BT_ACTION_MAX_MS,
    guiHotReadBaseBudget: V5BT_GUI_HOT_READ_BASE_BUDGET,
    guiHotReadsPerActionBudget: V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
  },
  minimumDurationMs,
  minimumDurationSeconds: Math.ceil(minimumDurationMs / 1_000),
  virtualTcpPrinters: [20109, 20110, 20111, 20112, 20113],
  virtualFiscal: env.POS_FISCAL_API_BASE_URL,
  virtualAutomaticCash: env.LOADTEST_AUTOMATIC_CASH_BASE_URL,
  virtualBattery: env.LOADTEST_BATTERY_SERVICE_URL,
  batteryNotificationIntervalMs: V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
  laneCrossExclusionsEnabled: {
    orders: env.LANE_CROSS_EXCLUSION_ORDERS !== "0",
    tables: env.LANE_CROSS_EXCLUSION_TABLES !== "0",
    payments: env.LANE_CROSS_EXCLUSION_PAYMENTS !== "0",
    presence: env.LANE_CROSS_EXCLUSION_PRESENCE !== "0",
  },
  paymentLaneConcurrency: Number(env.LOADTEST_PAYMENT_LANE_CONCURRENCY),
  paymentLaneConcurrencyQualificationEligible:
    !diagnosticPaymentLaneConcurrencyEnabled,
  diagnosticPaymentLaneConcurrency:
    diagnosticPaymentLaneConcurrencyEnabled
      ? V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY
      : null,
  autoPrintOwnerIntervalMs: Number(
    env.LOADTEST_PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS,
  ),
  autoPrintOwnerIntervalQualificationEligible:
    !diagnosticAutoPrintOwnerIntervalEnabled,
  diagnosticAutoPrintOwnerIntervalMs:
    diagnosticAutoPrintOwnerIntervalEnabled
      ? V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS
      : null,
  stationStateMarkerLockSkipEnabled:
    env.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP === "1",
  stationStateMarkerLockSkipQualificationEligible:
    !diagnosticStationStateMarkerLockSkipEnabled,
  diagnosticStationStateMarkerLockSkipEnabled:
    diagnosticStationStateMarkerLockSkipEnabled ? true : null,
  stationStateLastWriteCoalesceEnabled:
    env.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE === "1",
  stationStateLastWriteNowaitEnabled:
    env.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE === "1",
  stationStateLastWriteCoalesceQualificationEligible:
    !diagnosticStationStateLastWriteCoalesceEnabled,
  diagnosticStationStateLastWriteCoalesceEnabled:
    diagnosticStationStateLastWriteCoalesceEnabled ? true : null,
  printLaneConcurrency: Number(env.LOADTEST_PRINT_LANE_CONCURRENCY),
  ordersAsyncFlushIntervalMs: Number(env.LOADTEST_ORDERS_ASYNC_FLUSH_INTERVAL_MS),
  ordersAsyncFlushMysqlNowaitEnabled:
    env.LOADTEST_ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT === "1",
  ordersAsyncFlushDetachLastWriteAtEnabled:
    env.LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT === "1",
  ordersAsyncFlushDetachSequenceWhenSafeEnabled:
    env.LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE === "1",
  evidenceClass: v5btOperationsEvidenceClass,
  promotionEligibility: v5btOperationsPromotionEligibility,
  qualificationEligible: !diagnosticOverridesEnabled,
  diagnosticOverridesEnabled,
  laneMatrixQualificationEligible: !diagnosticLaneMatrixEnabled,
  diagnosticLaneMatrix: diagnosticLaneMatrixEnabled
    ? V5BT_DIAGNOSTIC_LANE_MATRIX
    : null,
  nonLoopbackIoAllowed: false,
  backendHost,
  backendLoopbackOnly: true,
  printSpoolDir,
  bluetoothOrPhysicalHardwareUsed: false,
  chrome,
  headed: false,
  reportDir,
  stationDistPresent: existsSync(stationDistIndex),
  hostPressurePreflight,
};

console.log(JSON.stringify(manifest, null, 2));
if (dryRun) process.exit(0);
if (!hostPressurePreflight.launchAllowed) {
  throw new Error(
    `Preflight pressione host bloccato: ${hostPressurePreflight.reasonCodes.join(", ")}. ` +
    "Liberare RAM/swap prima della prova; l'unico override esplicito e " +
    "LOADTEST_ALLOW_HOST_PRESSURE=1.",
  );
}
if (!chrome) {
  throw new Error(
    "Chrome/Chromium non trovato. Installa un browser Playwright o imposta LOADTEST_CHROMIUM_EXECUTABLE_PATH.",
  );
}

if (!existsSync(path.join(stationRoot, "node_modules"))) {
  const npmCi = npmInvocation(["ci", "--no-audit", "--no-fund"]);
  await run(npmCi.command, npmCi.args, { cwd: stationRoot, env });
}
const npmBuild = npmInvocation(["run", "build"]);
await run(npmBuild.command, npmBuild.args, { cwd: stationRoot, env });
if (!existsSync(stationDistIndex)) {
  throw new Error(`Build Postazione assente dopo il preflight: ${stationDistIndex}`);
}

await run(process.execPath, [path.join(scriptDir, "loadtest-full-capacity.mjs")], {
  cwd: projectRoot,
  env,
});

if (!existsSync(reportJson)) {
  throw new Error(`Report simulazione V5BT non trovato: ${reportJson}`);
}
const completedReport = JSON.parse(readFileSync(reportJson, "utf8"));
const profile = completedReport?.v5btOperationsProfile;
const recordedFailures = Array.isArray(completedReport?.recorder?.failures)
  ? completedReport.recorder.failures
  : [];
const gateFailures = [];
if (!profile) gateFailures.push("profilo assente");
if (Number(profile?.totalStarted) !== totalActions) gateFailures.push("quota totale avviata");
if (Number(profile?.totalCompleted) !== totalActions) gateFailures.push("quota totale completata");
if (Number(profile?.totalFailed) !== 0) gateFailures.push("eccezioni azione");
if (profile?.cadence?.mobileActionCadenceOk !== true) gateFailures.push("cadenza mobile 3s");
if (profile?.cadence?.commandCadenceOk !== true) gateFailures.push("cadenza comande 7-8s");
if (profile?.runtimeGate?.ok !== true) gateFailures.push("limiti runtime e anti-tempesta");
if ((profile?.missingMobileActionTypes?.length || 0) > 0) gateFailures.push("copertura azioni");
if ((profile?.mobileActionTypesWithoutSuccess?.length || 0) > 0) {
  gateFailures.push("azioni senza esito positivo");
}
if (profile?.persistedOrderTargetOk !== true) gateFailures.push("comande persistite per palmare");
if (completedReport?.relationalAudit?.drained !== true) gateFailures.push("drain relazionale");
if (completedReport?.autoPrintOwnerAudit?.ok !== true) gateFailures.push("auto-print solo owner");
if (completedReport?.stationStateMarkerLockElisionAudit?.ok !== true) {
  gateFailures.push("audit skip lock marker station-state");
}
if (
  completedReport?.config?.backendHost !== backendHost ||
  completedReport?.config?.backendLoopbackOnly !== true
) {
  gateFailures.push("binding backend loopback");
}
if (
  completedReport?.config?.printSpoolDir !== printSpoolDir ||
  completedReport?.cleanup?.printSpool?.path !== printSpoolDir ||
  completedReport?.cleanup?.printSpool?.verified !== true ||
  completedReport?.cleanup?.printSpool?.remaining !== false
) {
  gateFailures.push("cleanup spool stampa per-run");
}
if (
  completedReport?.config?.v5btSchedulerContractVersion !==
    V5BT_OPERATIONS_SCHEDULER_CONTRACT_VERSION ||
  completedReport?.config?.v5btOperationsStage !== mode
) {
  gateFailures.push("contratto scheduler/stage");
}
if (
  completedReport?.config?.batteryNotificationIntervalMs !==
    V5BT_BATTERY_NOTIFICATION_INTERVAL_MS ||
  completedReport?.mockIoMetrics?.battery?.body?.notificationIntervalMs !==
    V5BT_BATTERY_NOTIFICATION_INTERVAL_MS
) {
  gateFailures.push("notifica batteria 120s");
}
for (const [property, expected] of [
  ["laneCrossExclusionOrdersEnabled", laneCrossExclusions.orders],
  ["laneCrossExclusionTablesEnabled", laneCrossExclusions.tables],
  ["laneCrossExclusionPaymentsEnabled", laneCrossExclusions.payments],
  ["laneCrossExclusionPresenceEnabled", laneCrossExclusions.presence],
]) {
  if (completedReport?.config?.[property] !== expected) {
    gateFailures.push("attestazione matrice lane");
    break;
  }
}
if (diagnosticLaneMatrixEnabled) {
  gateFailures.push("matrice lane diagnostica non promuovibile");
}
if (
  completedReport?.config?.paymentLaneConcurrency !== paymentLaneConcurrency ||
  completedReport?.config?.v5btOperationsDiagnosticPaymentLaneConcurrency !==
    (diagnosticPaymentLaneConcurrencyEnabled
      ? V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY
      : null)
) {
  gateFailures.push("attestazione concorrenza payment lane");
}
if (
  completedReport?.config?.v5btOperationsEvidenceClass !==
    v5btOperationsEvidenceClass ||
  completedReport?.config?.v5btOperationsPromotionEligibility !==
    v5btOperationsPromotionEligibility ||
  completedReport?.config?.v5btOperationsDiagnostic !==
    diagnosticOverridesEnabled
) {
  gateFailures.push("attestazione classificazione evidenza");
}
if (diagnosticPaymentLaneConcurrencyEnabled) {
  gateFailures.push("concorrenza payment lane diagnostica non promuovibile");
}
if (
  completedReport?.config?.printSpoolAutoPrintOwnerIntervalMs !==
    autoPrintOwnerIntervalMs ||
  completedReport?.config
    ?.v5btOperationsDiagnosticAutoPrintOwnerIntervalMs !==
    (diagnosticAutoPrintOwnerIntervalEnabled
      ? V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS
      : null)
) {
  gateFailures.push("attestazione intervallo owner auto-print");
}
if (diagnosticAutoPrintOwnerIntervalEnabled) {
  gateFailures.push("intervallo owner auto-print diagnostico non promuovibile");
}
if (
  completedReport?.config?.stationStateMarkerLockSkipEnabled !==
    diagnosticStationStateMarkerLockSkipEnabled ||
  completedReport?.config
    ?.v5btOperationsDiagnosticStationStateMarkerLockSkipEnabled !==
    (diagnosticStationStateMarkerLockSkipEnabled ? true : null)
) {
  gateFailures.push("attestazione skip lock marker station-state");
}
if (diagnosticStationStateMarkerLockSkipEnabled) {
  gateFailures.push("skip lock marker station-state diagnostico non promuovibile");
}
if (
  completedReport?.config?.stationStateLastWriteCoalesceEnabled !==
    diagnosticStationStateLastWriteCoalesceEnabled ||
  completedReport?.config?.stationStateLastWriteNowaitEnabled !==
    diagnosticStationStateLastWriteCoalesceEnabled ||
  completedReport?.config
    ?.v5btOperationsDiagnosticStationStateLastWriteCoalesceEnabled !==
    (diagnosticStationStateLastWriteCoalesceEnabled ? true : null)
) {
  gateFailures.push("attestazione coalescing lastWriteAt station-state");
}
if (diagnosticStationStateLastWriteCoalesceEnabled) {
  gateFailures.push(
    "coalescing lastWriteAt station-state diagnostico non promuovibile",
  );
}
if (diagnosticOverridesEnabled) {
  gateFailures.push("evidenza diagnostica NON_GATE/NON_PROMOTABLE");
}
if (completedReport?.config?.printLaneConcurrency !== 1) {
  gateFailures.push("concorrenza print lane");
}
if (completedReport?.config?.ordersAsyncFlushIntervalMs !== 500) {
  gateFailures.push("intervallo async flush ordini");
}
if (completedReport?.config?.ordersAsyncFlushMysqlNowaitEnabled !== false) {
  gateFailures.push("profilo async flush MySQL stabile");
}
if (completedReport?.config?.ordersAsyncFlushDetachLastWriteAtEnabled !== false) {
  gateFailures.push("profilo lastWriteAt async flush stabile");
}
if (completedReport?.config?.ordersAsyncFlushDetachSequenceWhenSafeEnabled !== false) {
  gateFailures.push("profilo sequence async flush stabile");
}
if (
  completedReport?.config?.hostPressurePreflight?.schemaVersion !== 2 ||
  completedReport?.config?.hostPressurePreflight?.status !== "PASS" ||
  completedReport?.config?.hostPressurePreflight?.enforced !== true ||
  completedReport?.config?.hostPressurePreflight?.sufficient !== true ||
  completedReport?.config?.hostPressurePreflight?.checks?.schedulerLoad?.ok !== true
) {
  gateFailures.push("attestazione pressione host");
}

if (recordedFailures.length > 0 || gateFailures.length > 0) {
  const failureTypes = [...new Set(
    recordedFailures.map((entry) => String(entry?.type || "unknown")).filter(Boolean),
  )];
  throw new Error(
    `Simulazione V5BT non superata: ${recordedFailures.length} anomalie ` +
    `(${failureTypes.join(", ") || "nessun dettaglio"}); gate: ` +
    `${gateFailures.join(", ") || "verdi"}.`,
  );
}

console.log(JSON.stringify({
  ok: true,
  reportJson,
  handhelds: HANDHELDS,
  stations: STATIONS,
  actionsPerDevice,
  totalActions,
  mobileActionAverageGapMs: profile.cadence.mobileActionAverageGapMs,
  commandAverageGapMs: profile.cadence.commandAverageGapMs,
  batteryNotificationIntervalMs: V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
  runtimeGate: profile.runtimeGate,
}, null, 2));
