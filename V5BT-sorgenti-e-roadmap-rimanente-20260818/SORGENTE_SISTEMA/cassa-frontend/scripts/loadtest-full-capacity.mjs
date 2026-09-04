import mysql from "mysql2/promise";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { buildInitialAppState } from "../backend/modules/app-state/initial-state.js";
import { hashPin } from "../backend/auth/password.js";
import {
  createAutomaticCashConfigSet,
  createAutomaticCashReserveConfigSet,
} from "../backend/modules/automatic-cash/index.js";
import { recordRealtimeDeliverySample } from "./loadtest-realtime-delivery.mjs";
import {
  collectWorkerOperationHistograms,
  resolveLoadtestRuntimeQueueSampleLimit,
} from "./loadtest-runtime-metrics.mjs";
import {
  firstPayableOrderArticleUnit,
  isStalePaymentArticleSelectionResponse,
  resolveRefreshedOrder,
} from "./loadtest-order-article-units.mjs";
import { calculateMysqlStatusDelta } from "./loadtest-mysql-status.mjs";
import { runP5ActionSchedule } from "./p5-action-scheduler.mjs";
import { createP5LatencyCheckpointWriter } from "./p5-latency-checkpoint.mjs";
import {
  createP5MobileGuiController,
  createP5StationGuiController,
} from "./p5-headed-gui.mjs";
import {
  V5BT_COMMAND_INTERVAL_MAX_MS,
  V5BT_COMMAND_INTERVAL_MIN_MS,
  V5BT_DEVICE_ACTION_INTERVAL_MS,
  V5BT_MAX_HANDHELDS,
  V5BT_MAX_STATIONS,
  V5BT_MOBILE_OPERATION_TYPES,
  V5BT_OPERATIONS_SCHEDULER_CONTRACT_VERSION,
  countV5btCommands,
  runV5btOperationsSchedule,
  v5btMobileActionType,
  v5btStationActionType,
} from "./v5bt-operations-scheduler.mjs";
import {
  V5BT_ACTION_MAX_MS,
  V5BT_ACTION_P95_MAX_MS,
  V5BT_COMMAND_P95_MAX_MS,
  V5BT_GUI_HOT_READ_BASE_BUDGET,
  V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
  V5BT_MAX_IN_FLIGHT_GLOBAL,
  V5BT_MAX_IN_FLIGHT_PER_DEVICE,
  V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
  evaluateV5btOperationsRuntimeGate,
  evaluateV5btPersistedOrderTarget,
} from "./v5bt-operations-gates.mjs";
import { buildAutoPrintOwnerAudit } from "./v5bt-auto-print-owner-gate.mjs";
import { buildV5btLatencyAttribution } from "./v5bt-latency-attribution.mjs";
import { buildStationStateMarkerLockElisionAudit } from "./v5bt-station-state-marker-gate.mjs";
import { buildStationStateLastWriteAudit } from "./v5bt-station-state-last-write-gate.mjs";
import { runV5btOrderCreateRetry } from "./v5bt-order-create-retry.mjs";
import { runV5btMobileBusinessActionRetry } from "./v5bt-mobile-action-retry.mjs";
import { acquireV5btOrderCreateTable } from "./v5bt-order-table-acquisition.mjs";
import { availableV5btFixtureTables } from "./v5bt-fixture-table-cycle.mjs";
import { ensureV5btOrderTableCapacity } from "./v5bt-order-table-capacity.mjs";
import {
  claimV5btStationWorkflowTarget,
  filterV5btStationWorkflowCandidates,
} from "./v5bt-station-workflow-reservation.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");
let chromium = null;
const nodeBin = process.env.NODE_BIN || process.execPath;

const requestedRunId = String(process.env.LOADTEST_RUN_ID || "").trim();
const runId =
  requestedRunId ||
  `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(runId)) {
  throw new Error("LOADTEST_RUN_ID non valido: usa solo lettere, numeri, punto, trattino e underscore.");
}
function mysqlSafeLoadPrefix(value) {
  const safe = String(value ?? "run").replace(/[^a-zA-Z0-9_]/g, "_") || "run";
  const raw = `load_${safe}`;
  if (raw.length <= 35) return raw;
  const hash = createHash("sha1").update(safe).digest("hex").slice(0, 8);
  return `load_${safe.slice(0, 21)}_${hash}`.slice(0, 35);
}
const prefix = mysqlSafeLoadPrefix(runId);
function parseHostPressurePreflight(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LOADTEST_HOST_PRESSURE_PREFLIGHT_JSON non valido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LOADTEST_HOST_PRESSURE_PREFLIGHT_JSON deve essere un oggetto.");
  }
  return parsed;
}
const hostPressurePreflight = parseHostPressurePreflight(
  process.env.LOADTEST_HOST_PRESSURE_PREFLIGHT_JSON,
);
const backendPort = Number(process.env.LOADTEST_BACKEND_PORT || 5291);
const frontendPort = Number(process.env.LOADTEST_FRONTEND_PORT || 5290);
const MULTIPROCESS = String(process.env.LOADTEST_MULTIPROCESS ?? "0") === "1";
const realtimePort = Number(process.env.LOADTEST_REALTIME_PORT || 5292);
const apiWorkerPort = Number(process.env.LOADTEST_API_WORKER_PORT || 5293);
const apiWorkerCount = Math.max(
  1,
  Math.min(Number(process.env.LOADTEST_API_WORKERS || 1), 8),
);
const tableLockWorkerPort = Number(
  process.env.LOADTEST_TABLE_LOCK_WORKER_PORT || 5297,
);
const tableLockWorkerCount = Math.max(
  0,
  Math.min(Number(process.env.LOADTEST_TABLE_LOCK_WORKERS || 0), 4),
);
const apiBaseUrl = `http://127.0.0.1:${backendPort}`;
const backendHost = "127.0.0.1";
const realtimeBaseUrl = `http://127.0.0.1:${realtimePort}`;
const apiWorkerPorts = Array.from(
  { length: apiWorkerCount },
  (_, index) => apiWorkerPort + index,
);
const apiWorkerBaseUrls = apiWorkerPorts.map(
  (port) => `http://127.0.0.1:${port}`,
);
const apiWorkerBaseUrl = apiWorkerBaseUrls[0];
const tableLockWorkerPorts = Array.from(
  { length: tableLockWorkerCount },
  (_, index) => tableLockWorkerPort + index,
);
const tableLockWorkerBaseUrls = tableLockWorkerPorts.map(
  (port) => `http://127.0.0.1:${port}`,
);
const tableLockTombstonesEnabled =
  String(process.env.LOADTEST_TABLE_LOCK_TOMBSTONES ?? "1") === "1";
const tableLockMysqlConnectionLimit = Math.max(
  1,
  Math.min(
    Number(process.env.LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT) || 8,
    32,
  ),
);
const tableLockRedisPoolSize = Math.max(
  1,
  Math.min(Number(process.env.LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE) || 4, 32),
);
const apiWorkerAuthFastPathEnabled =
  String(process.env.LOADTEST_API_WORKER_AUTH_FASTPATH ?? "1") === "1";
const apiWorkerRedisPoolSize = Math.max(
  1,
  Math.min(Number(process.env.LOADTEST_API_WORKER_REDIS_POOL_SIZE) || 4, 32),
);
const runtimeMetricsQueueSampleLimit =
  resolveLoadtestRuntimeQueueSampleLimit(
    process.env.RUNTIME_METRICS_QUEUE_SAMPLE_LIMIT,
  );
const orderCreateTargetedLockRefreshEnabled =
  String(process.env.LOADTEST_ORDER_CREATE_TARGETED_LOCK_REFRESH ?? "0") ===
  "1";
const orderCreateParallelExternalRefreshEnabled =
  String(process.env.LOADTEST_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH ?? "0") ===
  "1";
const laneCrossExclusionOrdersEnabled =
  String(process.env.LANE_CROSS_EXCLUSION_ORDERS ?? "1") !== "0";
const laneCrossExclusionTablesEnabled =
  String(process.env.LANE_CROSS_EXCLUSION_TABLES ?? "1") !== "0";
const laneCrossExclusionPaymentsEnabled =
  String(process.env.LANE_CROSS_EXCLUSION_PAYMENTS ?? "1") !== "0";
const laneCrossExclusionPresenceEnabled =
  String(process.env.LANE_CROSS_EXCLUSION_PRESENCE ?? "1") !== "0";
const paymentLaneConcurrency = Math.max(
  1,
  Math.min(
    4,
    Math.trunc(Number(process.env.LOADTEST_PAYMENT_LANE_CONCURRENCY) || 2),
  ),
);
const printLaneConcurrency = Math.max(
  1,
  Math.min(
    2,
    Math.trunc(Number(process.env.LOADTEST_PRINT_LANE_CONCURRENCY) || 1),
  ),
);
const printSpoolAutoPrintOwnerIntervalMs = Math.max(
  10,
  Math.min(
    1_000,
    Math.trunc(
      Number(
        process.env.LOADTEST_PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS,
      ) || 25,
    ),
  ),
);
const rawStationStateMarkerLockSkip = String(
  process.env.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP ?? "0",
).trim();
if (
  rawStationStateMarkerLockSkip !== "0" &&
  rawStationStateMarkerLockSkip !== "1"
) {
  throw new Error(
    "LOADTEST_STATION_STATE_MARKER_LOCK_SKIP ammette esclusivamente 0 o 1.",
  );
}
const stationStateMarkerLockSkipEnabled =
  rawStationStateMarkerLockSkip === "1";
const rawStationStateLastWriteCoalesce = String(
  process.env.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE ?? "0",
).trim();
if (
  rawStationStateLastWriteCoalesce !== "0" &&
  rawStationStateLastWriteCoalesce !== "1"
) {
  throw new Error(
    "LOADTEST_STATION_STATE_LAST_WRITE_COALESCE ammette esclusivamente 0 o 1.",
  );
}
const stationStateLastWriteCoalesceEnabled =
  rawStationStateLastWriteCoalesce === "1";
const stationStateLastWriteNowaitEnabled =
  stationStateLastWriteCoalesceEnabled;
const stationStateLastWriteCoalesceIntervalMs = Math.max(
  25,
  Math.min(
    5_000,
    Math.trunc(
      Number(
        process.env.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE_INTERVAL_MS,
      ) || 250,
    ),
  ),
);
const ordersAsyncFlushIntervalMs = Math.max(
  1,
  Math.min(
    300_000,
    Math.trunc(Number(process.env.LOADTEST_ORDERS_ASYNC_FLUSH_INTERVAL_MS) || 500),
  ),
);
const ordersAsyncFlushMysqlNowaitEnabled =
  String(process.env.LOADTEST_ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT ?? "0") === "1";
const ordersAsyncFlushDetachLastWriteAtEnabled =
  String(process.env.LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT ?? "0") === "1";
const ordersAsyncFlushDetachSequenceWhenSafeEnabled =
  String(process.env.LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE ?? "0") === "1";
const V5BT_ORDER_CREATE_TABLE_WAIT_MS = Math.max(
  0,
  Math.min(
    Number(process.env.LOADTEST_ORDER_CREATE_TABLE_WAIT_MS) || 5_000,
    V5BT_ACTION_MAX_MS - 1_000,
  ),
);
const tableSyncAppStateFastPathEnabled =
  String(process.env.LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH ?? "0") === "1";
const tableRoomMoveRequestAppStateFastPathEnabled =
  String(
    process.env.LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH ?? "0",
  ) === "1";
const waiterPauseSessionAuditFastPathEnabled =
  String(process.env.LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH ?? "0") ===
  "1";
const counterCollectionAtomicFastPathEnabled =
  String(process.env.LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH ?? "0") ===
  "1";
const paymentLockDiagnosticsEnabled =
  String(process.env.LOADTEST_PAYMENT_LOCK_DIAGNOSTICS ?? "0") === "1";
const paymentFreeSplitDurableMirror =
  String(process.env.BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR ?? "0") === "1";
const paymentMirrorSkipPosSettingsTables =
  String(process.env.BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES ?? "0") ===
  "1";
const paymentMirrorStatelessConsumer =
  String(process.env.BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER ?? "0") === "1";
const paymentFreeSplitSettingsReuse =
  String(process.env.BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE ?? "0") === "1";
const paymentDomainNamedLockEnabled =
  String(process.env.BACKEND_PAYMENT_DOMAIN_NAMED_LOCK ?? "0") === "1";
const ROOM_CHANGE_BRANCH_PROBES = Math.max(
  0,
  Math.min(
    40,
    Math.trunc(Number(process.env.LOADTEST_ROOM_CHANGE_BRANCH_PROBES) || 0),
  ),
);
const ROOM_LANE_CONCURRENCY = Math.max(
  1,
  Math.min(
    4,
    Math.trunc(Number(process.env.LOADTEST_ROOM_LANE_CONCURRENCY) || 4),
  ),
);
const ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE =
  String(process.env.LOADTEST_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE ?? "0") ===
  "1";
const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
// In modalita' multi-processo il traffico device passa dal proxy frontend, che
// instrada mutazioni ordine -> api-worker, letture -> api-worker, SSE -> realtime.
const deviceApiBaseUrl = MULTIPROCESS ? frontendBaseUrl : apiBaseUrl;
const MULTIPROCESS_ORDER_ALLOWLIST = [
  "POST /api/integration/orders/create",
  "POST /api/integration/orders/sync",
  "POST /api/integration/orders/cancel",
  "POST /api/integration/orders/comp",
  "POST /api/integration/orders/correct",
  "POST /api/integration/orders/replacement/bar-charge",
  "POST /api/orders/replacement/bar-charge",
  "POST /api/integration/orders/line/split",
  "POST /api/integration/orders/transfer/resolve",
  "POST /api/integration/orders/transfer/request",
  "POST /api/integration/orders/line/price-override",
  "POST /api/integration/orders/transfer/force",
  "POST /api/integration/orders/storno",
  "POST /api/tables/lock/acquire",
  "POST /api/tables/lock/heartbeat",
  "POST /api/tables/lock/release",
  "POST /api/tables/lock/force-release",
].join(",");
const outputDir = path.resolve(projectRoot, "logs", `loadtest-${runId}`);
const printSpoolDir = path.join(outputDir, "runtime", "print-spool");
const seedPath = path.join(outputDir, "seed.json");
const reportJsonPath = path.join(outputDir, "report.json");
const reportMdPath = path.join(outputDir, "REPORT.md");
const eventsPath = path.join(outputDir, "events.jsonl");
const p5LatencyCheckpointsPath = path.join(
  outputDir,
  "p5-latency-checkpoints.jsonl",
);
let outputDirReserved = false;
const p5BaselineDiagnosticsPaths = {
  owner: path.join(outputDir, "backend-baseline.jsonl"),
  realtime: path.join(outputDir, "backend-realtime-baseline.jsonl"),
  apiWorker: (index) =>
    path.join(outputDir, `backend-api-worker-${index + 1}-baseline.jsonl`),
  tableLockWorker: (index) =>
    path.join(
      outputDir,
      `backend-table-lock-worker-${index + 1}-baseline.jsonl`,
    ),
};
function listP5BaselineDiagnosticsPaths() {
  return [
    p5BaselineDiagnosticsPaths.owner,
    ...(MULTIPROCESS ? [p5BaselineDiagnosticsPaths.realtime] : []),
    ...(MULTIPROCESS
      ? apiWorkerPorts.map((_, index) =>
          p5BaselineDiagnosticsPaths.apiWorker(index),
        )
      : []),
    ...(MULTIPROCESS
      ? tableLockWorkerPorts.map((_, index) =>
          p5BaselineDiagnosticsPaths.tableLockWorker(index),
        )
      : []),
  ];
}
const relationalDbPath = path.join(outputDir, "relational.sqlite");
const appStateSplitDbPath = path.join(outputDir, "app-state-split.sqlite");
const redisKeyPrefix = `cassav5bt:${prefix}`;

const HANDHELD_COUNT = Number(process.env.LOADTEST_HANDHELDS || 100);
const STATION_COUNT = Number(process.env.LOADTEST_STATIONS || 10);
const GUI_COUNT = Number(process.env.LOADTEST_GUI || 5);
const LOADTEST_PROFILE = String(process.env.LOADTEST_PROFILE || "mixed")
  .trim()
  .toLowerCase();
const PACED_HANDHELD_PROFILE = LOADTEST_PROFILE === "paced-orders";
const REALISTIC_HOUR_PROFILE = LOADTEST_PROFILE === "realistic-hour";
const P5_ENDURANCE_PROFILE = LOADTEST_PROFILE === "p5-endurance";
const V5BT_OPERATIONS_PROFILE = LOADTEST_PROFILE === "v5bt-operations-30";
const v5btOperationsEvidenceClass = String(
  process.env.LOADTEST_V5BT_EVIDENCE_CLASS || "",
).trim();
const v5btOperationsPromotionEligibility = String(
  process.env.LOADTEST_V5BT_PROMOTION_ELIGIBILITY || "",
).trim();
const rawV5btDiagnosticPaymentLaneConcurrency = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY || "",
).trim();
const v5btOperationsDiagnosticPaymentLaneConcurrency =
  rawV5btDiagnosticPaymentLaneConcurrency === ""
    ? null
    : Number(rawV5btDiagnosticPaymentLaneConcurrency);
const rawV5btDiagnosticAutoPrintOwnerIntervalMs = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS || "",
).trim();
const v5btOperationsDiagnosticAutoPrintOwnerIntervalMs =
  rawV5btDiagnosticAutoPrintOwnerIntervalMs === ""
    ? null
    : Number(rawV5btDiagnosticAutoPrintOwnerIntervalMs);
const rawV5btDiagnosticStationStateMarkerLockSkip = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP || "",
).trim();
if (
  rawV5btDiagnosticStationStateMarkerLockSkip !== "" &&
  rawV5btDiagnosticStationStateMarkerLockSkip !== "1"
) {
  throw new Error(
    "LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP ammette esclusivamente 1.",
  );
}
const v5btOperationsDiagnosticStationStateMarkerLockSkipEnabled =
  rawV5btDiagnosticStationStateMarkerLockSkip === "1" ? true : null;
const rawV5btDiagnosticStationStateLastWriteCoalesce = String(
  process.env.LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE || "",
).trim();
if (
  rawV5btDiagnosticStationStateLastWriteCoalesce !== "" &&
  rawV5btDiagnosticStationStateLastWriteCoalesce !== "1"
) {
  throw new Error(
    "LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE ammette esclusivamente 1.",
  );
}
const v5btOperationsDiagnosticStationStateLastWriteCoalesceEnabled =
  rawV5btDiagnosticStationStateLastWriteCoalesce === "1" ? true : null;
const v5btQualifyingLaneMatrix =
  laneCrossExclusionOrdersEnabled === false &&
  laneCrossExclusionTablesEnabled === false &&
  laneCrossExclusionPaymentsEnabled === false &&
  laneCrossExclusionPresenceEnabled === false;
const v5btDiagnosticLaneMatrix =
  laneCrossExclusionOrdersEnabled === false &&
  laneCrossExclusionTablesEnabled === true &&
  laneCrossExclusionPaymentsEnabled === true &&
  laneCrossExclusionPresenceEnabled === false;
const v5btDiagnosticPaymentLaneConcurrency =
  paymentLaneConcurrency === 3 &&
  rawV5btDiagnosticPaymentLaneConcurrency === "3";
const v5btQualifyingPaymentLaneConcurrency =
  paymentLaneConcurrency === 2 &&
  rawV5btDiagnosticPaymentLaneConcurrency === "";
const v5btDiagnosticAutoPrintOwnerInterval =
  printSpoolAutoPrintOwnerIntervalMs === 100 &&
  rawV5btDiagnosticAutoPrintOwnerIntervalMs === "100";
const v5btQualifyingAutoPrintOwnerInterval =
  printSpoolAutoPrintOwnerIntervalMs === 25 &&
  rawV5btDiagnosticAutoPrintOwnerIntervalMs === "";
const v5btDiagnosticStationStateMarkerLockSkip =
  stationStateMarkerLockSkipEnabled &&
  rawV5btDiagnosticStationStateMarkerLockSkip === "1";
const v5btQualifyingStationStateMarkerLockSkip =
  !stationStateMarkerLockSkipEnabled &&
  rawV5btDiagnosticStationStateMarkerLockSkip === "";
const v5btDiagnosticStationStateLastWriteCoalesce =
  stationStateLastWriteCoalesceEnabled &&
  rawV5btDiagnosticStationStateLastWriteCoalesce === "1";
const v5btQualifyingStationStateLastWriteCoalesce =
  !stationStateLastWriteCoalesceEnabled &&
  rawV5btDiagnosticStationStateLastWriteCoalesce === "";
const v5btOperationsDiagnostic =
  v5btDiagnosticLaneMatrix ||
  v5btDiagnosticPaymentLaneConcurrency ||
  v5btDiagnosticAutoPrintOwnerInterval ||
  v5btDiagnosticStationStateMarkerLockSkip ||
  v5btDiagnosticStationStateLastWriteCoalesce;
if (
  V5BT_OPERATIONS_PROFILE &&
  !(
    (v5btQualifyingLaneMatrix || v5btDiagnosticLaneMatrix) &&
    (v5btQualifyingPaymentLaneConcurrency ||
      v5btDiagnosticPaymentLaneConcurrency) &&
    (v5btQualifyingAutoPrintOwnerInterval ||
      v5btDiagnosticAutoPrintOwnerInterval) &&
    (v5btQualifyingStationStateMarkerLockSkip ||
      v5btDiagnosticStationStateMarkerLockSkip) &&
    (v5btQualifyingStationStateLastWriteCoalesce ||
      v5btDiagnosticStationStateLastWriteCoalesce) &&
    (v5btOperationsDiagnostic
      ? v5btOperationsEvidenceClass === "NON_GATE" &&
        v5btOperationsPromotionEligibility === "NON_PROMOTABLE"
      : v5btOperationsEvidenceClass === "QUALIFYING_PROFILE" &&
        v5btOperationsPromotionEligibility === "READINESS_ELIGIBLE")
  )
) {
  throw new Error(
    "Classificazione V5BT incoerente: il profilo certificato richiede payment lane 2 " +
      "intervallo owner auto-print 25 ms e skip lock marker station-state disattivo; " +
      "gli unici override sono payment lane 3, intervallo owner auto-print 100 ms, " +
      "skip lock marker station-state attivo o coalescing lastWriteAt station-state attivo, " +
      "tutti NON_GATE/NON_PROMOTABLE.",
  );
}
const configuredV5btBatteryNotificationIntervalMs = Number(
  process.env.LOADTEST_V5BT_BATTERY_NOTIFICATION_INTERVAL_MS ||
    V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
);
if (
  V5BT_OPERATIONS_PROFILE &&
  configuredV5btBatteryNotificationIntervalMs !==
    V5BT_BATTERY_NOTIFICATION_INTERVAL_MS
) {
  throw new Error(
    `LOADTEST_V5BT_BATTERY_NOTIFICATION_INTERVAL_MS deve restare ${V5BT_BATTERY_NOTIFICATION_INTERVAL_MS} ms.`,
  );
}
const ACTION_SCHEDULE_PROFILE = P5_ENDURANCE_PROFILE || V5BT_OPERATIONS_PROFILE;
const REALISTIC_LOAD_PROFILE =
  REALISTIC_HOUR_PROFILE || ACTION_SCHEDULE_PROFILE;
const P5_ACTIONS_PER_DEVICE = Math.max(
  1,
  Math.min(
    10_000,
    Math.trunc(Number(process.env.LOADTEST_P5_ACTIONS_PER_DEVICE || 1_000)),
  ),
);
const P5_ACTIONS_PER_SECOND = Math.max(
  1,
  Math.min(
    20,
    Math.trunc(Number(process.env.LOADTEST_P5_ACTIONS_PER_SECOND || 3)),
  ),
);
const P5_TOTAL_ACTIONS =
  (HANDHELD_COUNT + STATION_COUNT) * P5_ACTIONS_PER_DEVICE;
const P5_START_INTERVAL_MS = Math.ceil(1_000 / P5_ACTIONS_PER_SECOND);
const P5_MINIMUM_DURATION_MS =
  (P5_TOTAL_ACTIONS - 1) * P5_START_INTERVAL_MS + 1;
const V5BT_ACTIONS_PER_DEVICE = Math.max(
  10,
  Math.min(
    10_000,
    Math.trunc(Number(process.env.LOADTEST_V5BT_ACTIONS_PER_DEVICE || 200)),
  ),
);
const V5BT_OPERATIONS_STAGE =
  V5BT_ACTIONS_PER_DEVICE === 10
    ? "micro"
    : V5BT_ACTIONS_PER_DEVICE === 40
      ? "smoke"
      : V5BT_ACTIONS_PER_DEVICE === 200
        ? "full"
        : "custom";
const V5BT_TOTAL_ACTIONS =
  (HANDHELD_COUNT + STATION_COUNT) * V5BT_ACTIONS_PER_DEVICE;
const V5BT_COMMANDS_PER_HANDHELD = countV5btCommands(V5BT_ACTIONS_PER_DEVICE);
const V5BT_MINIMUM_DURATION_MS =
  (V5BT_ACTIONS_PER_DEVICE - 1) * V5BT_DEVICE_ACTION_INTERVAL_MS +
  Math.max(0, HANDHELD_COUNT + STATION_COUNT - 1) *
    (V5BT_DEVICE_ACTION_INTERVAL_MS /
      Math.max(1, HANDHELD_COUNT + STATION_COUNT));
const V5BT_RUNTIME_LIMITS = Object.freeze({
  maxInFlightPerDevice: Math.max(
    1,
    Math.trunc(
      Number(process.env.LOADTEST_V5BT_MAX_IN_FLIGHT_PER_DEVICE) ||
        V5BT_MAX_IN_FLIGHT_PER_DEVICE,
    ),
  ),
  maxInFlightGlobal: Math.max(
    1,
    Math.trunc(
      Number(process.env.LOADTEST_V5BT_MAX_IN_FLIGHT_GLOBAL) ||
        V5BT_MAX_IN_FLIGHT_GLOBAL,
    ),
  ),
  actionP95MaxMs: Math.max(
    1,
    Math.trunc(
      Number(process.env.LOADTEST_V5BT_ACTION_P95_MAX_MS) ||
        V5BT_ACTION_P95_MAX_MS,
    ),
  ),
  commandP95MaxMs: Math.max(
    1,
    Math.trunc(
      Number(process.env.LOADTEST_V5BT_COMMAND_P95_MAX_MS) ||
        V5BT_COMMAND_P95_MAX_MS,
    ),
  ),
  actionMaxMs: Math.max(
    1,
    Math.trunc(
      Number(process.env.LOADTEST_V5BT_ACTION_MAX_MS) || V5BT_ACTION_MAX_MS,
    ),
  ),
  guiBaseBudget: Math.max(
    0,
    Math.trunc(
      Number(process.env.LOADTEST_V5BT_GUI_HOT_READ_BASE_BUDGET) ||
        V5BT_GUI_HOT_READ_BASE_BUDGET,
    ),
  ),
  guiReadsPerActionBudget: Math.max(
    0,
    Number(process.env.LOADTEST_V5BT_GUI_HOT_READS_PER_ACTION_BUDGET) ||
      V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
  ),
});
const P5_LONG_PRESS_MS = Math.max(
  2_000,
  Math.min(
    10_000,
    Math.trunc(Number(process.env.LOADTEST_P5_LONG_PRESS_MS || 2_100)),
  ),
);
const P5_GUI_ACTION_EVERY = Math.max(
  1,
  Math.min(
    50,
    Math.trunc(Number(process.env.LOADTEST_P5_GUI_ACTION_EVERY || 4)),
  ),
);
const P5_ALLOW_HEADLESS =
  String(process.env.LOADTEST_P5_ALLOW_HEADLESS ?? "0") === "1";
const P5_ALLOW_NONSTANDARD =
  String(process.env.LOADTEST_P5_ALLOW_NONSTANDARD ?? "0") === "1";
const P5_LATENCY_CHECKPOINT_INTERVAL_MS = Math.max(
  1_000,
  Math.min(
    300_000,
    Math.trunc(
      Number(process.env.LOADTEST_P5_CHECKPOINT_INTERVAL_MS) || 30_000,
    ),
  ),
);
const PACED_ORDER_COUNT = Math.max(
  20,
  Math.trunc(Number(process.env.LOADTEST_PACED_ORDER_COUNT || 20)),
);
const PACED_OTHER_ACTION_COUNT = Math.max(
  10,
  Math.trunc(Number(process.env.LOADTEST_PACED_OTHER_ACTION_COUNT || 10)),
);
const PACED_ACTION_INTERVAL_MS = Math.max(
  10_000,
  Math.trunc(Number(process.env.LOADTEST_PACED_INTERVAL_MS || 10_000)),
);
const PACED_MAX_ACTIVE_MS = Math.min(
  5 * 60_000,
  Math.max(
    60_000,
    Math.trunc(Number(process.env.LOADTEST_PACED_MAX_ACTIVE_MS || 5 * 60_000)),
  ),
);
const PACED_ACTION_TIMEOUT_MS = Math.min(
  PACED_ACTION_INTERVAL_MS - 500,
  Math.max(
    5_000,
    Math.trunc(Number(process.env.LOADTEST_PACED_ACTION_TIMEOUT_MS || 9_000)),
  ),
);
const PACED_START_GAP_TOLERANCE_MS = 5;
const REALISTIC_DURATION_MS = Math.max(
  60_000,
  Math.min(
    8 * 60 * 60_000,
    Math.trunc(Number(process.env.LOADTEST_REALISTIC_DURATION_MS || 3_600_000)),
  ),
);
const REALISTIC_ORDER_COUNT = Math.max(
  1,
  Math.min(
    200,
    Math.trunc(Number(process.env.LOADTEST_REALISTIC_ORDER_COUNT || 50)),
  ),
);
const REALISTIC_OTHER_ACTION_COUNT = Math.max(
  10,
  Math.min(
    300,
    Math.trunc(Number(process.env.LOADTEST_REALISTIC_OTHER_ACTIONS || 60)),
  ),
);
const REALISTIC_NETWORK_OUTAGE_MS = Math.max(
  2_000,
  Math.min(
    60_000,
    Math.trunc(
      Number(process.env.LOADTEST_REALISTIC_NETWORK_OUTAGE_MS || 60_000),
    ),
  ),
);
const REALISTIC_STATION_LOGOUT_MS = Math.max(
  5_000,
  Math.min(
    10 * 60_000,
    Math.trunc(
      Number(process.env.LOADTEST_REALISTIC_STATION_LOGOUT_MS || 600_000),
    ),
  ),
);
const waiterPauseProbeRequest = Math.max(
  0,
  Math.min(
    40,
    Math.trunc(Number(process.env.LOADTEST_WAITER_PAUSE_PROBES) || 0),
  ),
);
const WAITER_PAUSE_PROBES = Math.min(
  waiterPauseProbeRequest,
  Math.max(0, Math.floor((REALISTIC_DURATION_MS - 5_000) / 4_000)),
);
const paymentFreeSplitProbeRequest = Math.max(
  0,
  Math.min(
    20,
    Math.trunc(Number(process.env.LOADTEST_PAYMENT_FREE_SPLIT_PROBES) || 0),
  ),
);
const PAYMENT_FREE_SPLIT_PROBES = Math.min(
  paymentFreeSplitProbeRequest,
  Math.max(0, Math.floor((REALISTIC_DURATION_MS - 5_000) / 5_000)),
);
const realtimeClientCountRaw = Number(
  process.env.LOADTEST_REALTIME_CLIENTS ?? HANDHELD_COUNT,
);
const REALTIME_CLIENT_COUNT = Math.max(
  0,
  Math.min(
    Number.isFinite(realtimeClientCountRaw)
      ? Math.trunc(realtimeClientCountRaw)
      : HANDHELD_COUNT,
    HANDHELD_COUNT + GUI_COUNT,
  ),
);
const OPS_PER_DEVICE = PACED_HANDHELD_PROFILE
  ? PACED_ORDER_COUNT + PACED_OTHER_ACTION_COUNT
  : Number(process.env.LOADTEST_OPS_PER_DEVICE || 80);
const FISCAL_SAMPLE_LIMIT = Number(
  process.env.LOADTEST_FISCAL_SAMPLE_LIMIT || 5,
);
const RELATIONAL_DRAIN_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(Number(process.env.LOADTEST_DRAIN_TIMEOUT_MS || 60_000), 300_000),
);
const RT_BASE_URL =
  process.env.POS_FISCAL_API_BASE_URL || "http://127.0.0.1:9290";
const PRINTING_ENABLED =
  String(process.env.LOADTEST_PRINTING_ENABLED ?? "0") === "1";
const PRINTER_HOST = String(
  process.env.LOADTEST_PRINTER_HOST || "127.0.0.1",
).trim();
const PRINTER_PORT = Number(process.env.LOADTEST_PRINTER_PORT || 9109);
const PRINTER_COUNT = Math.max(
  1,
  Math.min(
    16,
    Math.trunc(
      Number(
        process.env.LOADTEST_PRINTER_COUNT ||
          (ACTION_SCHEDULE_PROFILE ? 5 : REALISTIC_LOAD_PROFILE ? 4 : 1),
      ),
    ),
  ),
);
const PRINTER_METRICS_PORT = Number(
  process.env.LOADTEST_PRINTER_METRICS_PORT || 9299,
);
const VIRTUAL_PRINTERS = Array.from({ length: PRINTER_COUNT }, (_, index) => ({
  id: `load_printer_simulated_${index + 1}`,
  name: `Load Printer Simulated ${index + 1}`,
  host: PRINTER_HOST,
  port: PRINTER_PORT + index,
}));
const START_MOCK_IO =
  String(
    process.env.LOADTEST_START_MOCK_IO ?? (REALISTIC_LOAD_PROFILE ? "1" : "0"),
  ) === "1";
const AUTOMATIC_CASH_BASE_URL = String(
  process.env.LOADTEST_AUTOMATIC_CASH_BASE_URL || "http://127.0.0.1:9190",
).replace(/\/+$/, "");
const AUTOMATIC_CASH_MOCK_PORT = Number(
  new URL(AUTOMATIC_CASH_BASE_URL).port || 80,
);
const BATTERY_SERVICE_URL = String(
  process.env.LOADTEST_BATTERY_SERVICE_URL || "http://127.0.0.1:9790/battery",
).replace(/\/+$/, "");
const BATTERY_MOCK_PORT = Number(new URL(BATTERY_SERVICE_URL).port || 80);
const ALLOW_NON_LOOPBACK_IO =
  String(process.env.LOADTEST_ALLOW_NON_LOOPBACK_IO ?? "0") === "1";
const CHROMIUM_EXECUTABLE_PATH = String(
  process.env.LOADTEST_CHROMIUM_EXECUTABLE_PATH || "",
).trim();
const CHROMIUM_NO_SANDBOX =
  String(process.env.LOADTEST_CHROMIUM_NO_SANDBOX ?? "0") === "1";
const integrationServiceToken = `loadtest-service-${runId}-12345678901234567890`;
let automaticCashSeed = null;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (primaryError) {
    try {
      return await import("playwright-core");
    } catch (coreError) {
      const fallbackPath = path.join(
        projectRoot,
        "mobile-frontend",
        "node_modules",
        "playwright",
        "index.mjs",
      );
      try {
        return await import(pathToFileURL(fallbackPath).href);
      } catch (fallbackError) {
        const error = new Error(
          `Playwright non disponibile per il loadtest. Errore playwright: ${primaryError.message}. Errore playwright-core: ${coreError.message}. Fallback: ${fallbackError.message}`,
        );
        error.cause = primaryError;
        throw error;
      }
    }
  }
}

const dbConfig = {
  host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
  user: process.env.BACKEND_MYSQL_USER || "cassa_app",
  password: process.env.BACKEND_MYSQL_PASSWORD || "amalia2026",
  database: process.env.BACKEND_MYSQL_DATABASE || "cassa",
};

const rooms = [
  { id: "room_pedana", name: "Pedana", label: "Pedana" },
  { id: "room_sala", name: "Sala", label: "Sala" },
  { id: "room_bar", name: "Bar", label: "Bar" },
  { id: "room_gazebo", name: "Gazebo", label: "Gazebo" },
  { id: "room_terrazza", name: "Terrazza", label: "Terrazza" },
  { id: "room_spiaggia", name: "Spiaggia", label: "Spiaggia" },
  {
    id: "room_attesa_virtuale",
    name: "Attesa virtuale",
    label: "Attesa virtuale",
    virtual: true,
  },
];

const stationNames = [
  "BAR-1",
  "BAR-2",
  "BAR PRINCIPALE",
  "COCKTAIL",
  "CAFFETTERIA",
  "CUCINA",
  "PIZZA",
  "SPIAGGIA",
  "TERRAZZA",
  "DOLCI",
];
const activeStationNames = stationNames.slice(
  0,
  Math.max(1, Math.min(STATION_COUNT, stationNames.length)),
);

function printerForStationIndex(index) {
  return VIRTUAL_PRINTERS[index % VIRTUAL_PRINTERS.length];
}

function printerForStationName(name) {
  const index = Math.max(
    0,
    activeStationNames.indexOf(String(name || "").trim()),
  );
  return printerForStationIndex(index);
}

const catalog = [
  ["menu_caffetteria_caffe", "Caffe", 1.3],
  ["menu_caffetteria_cappuccino", "Cappuccino", 1.6],
  ["menu_bevande_acqua_0_5l_nat", "Acqua 0,5L Nat", 1.3],
  ["menu_bevande_coca_cola", "Coca Cola", 4],
  ["menu_drink_aperol_spritz", "Aperol Spritz", 8],
  ["menu_drink_gin_tonic", "Gin Tonic", 8],
  ["menu_drink_special_10", "Special 10", 10],
  ["menu_apericena_standard", "Apericena", 12],
  ["menu_birre_ichnusa", "Ichnusa", 4.5],
  ["menu_vino_k_prosecco", "K Prosecco", 6],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const spawnedChildren = new Set();
const spawnedLogClosures = new Set();
const trackedSessions = new Set();
let activeBrowser = null;
let activeP5LatencyCheckpointWriter = null;
let activeSessionsTableName = "";
let cleanupPromise = null;
const suppressedStationIndexes = new Set();

function isLoopbackHostname(value) {
  const hostname = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function assertLoadtestIoSafety() {
  let fiscalUrl;
  try {
    fiscalUrl = new URL(RT_BASE_URL);
  } catch {
    throw new Error(`POS_FISCAL_API_BASE_URL non valido: ${RT_BASE_URL}`);
  }
  if (!ALLOW_NON_LOOPBACK_IO && !isLoopbackHostname(fiscalUrl.hostname)) {
    throw new Error(
      `Loadtest bloccato: endpoint fiscale non-loopback ${fiscalUrl.hostname}. Usa un mock locale oppure LOADTEST_ALLOW_NON_LOOPBACK_IO=1 in modo esplicito.`,
    );
  }
  if (
    PRINTING_ENABLED &&
    !ALLOW_NON_LOOPBACK_IO &&
    !isLoopbackHostname(PRINTER_HOST)
  ) {
    throw new Error(
      `Loadtest bloccato: stampante non-loopback ${PRINTER_HOST}. Usa il mock TCP locale oppure LOADTEST_ALLOW_NON_LOOPBACK_IO=1 in modo esplicito.`,
    );
  }
  if (
    PRINTING_ENABLED &&
    (!Number.isInteger(PRINTER_PORT) ||
      PRINTER_PORT < 1 ||
      PRINTER_PORT > 65535)
  ) {
    throw new Error(`LOADTEST_PRINTER_PORT non valida: ${PRINTER_PORT}`);
  }
  if (PRINTING_ENABLED && PRINTER_PORT + PRINTER_COUNT - 1 > 65535) {
    throw new Error("Intervallo porte stampanti virtuali non valido.");
  }
  for (const [label, rawUrl] of [
    ["cassa automatica", AUTOMATIC_CASH_BASE_URL],
    ["batteria", BATTERY_SERVICE_URL],
  ]) {
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      throw new Error(`URL ${label} non valido: ${rawUrl}`);
    }
    if (!ALLOW_NON_LOOPBACK_IO && !isLoopbackHostname(target.hostname)) {
      throw new Error(
        `Loadtest bloccato: ${label} non-loopback ${target.hostname}.`,
      );
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rnd(max) {
  return Math.floor(Math.random() * max);
}

function pick(items) {
  return items[rnd(items.length)];
}

function money(value) {
  return Number((Math.round((Number(value) || 0) * 100) / 100).toFixed(2));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
    ],
  );
}

function latencySummary(values) {
  return {
    p50ms: percentile(values, 0.5),
    p95ms: percentile(values, 0.95),
    p98ms: percentile(values, 0.98),
    p99ms: percentile(values, 0.99),
    p999ms: percentile(values, 0.999),
    maxMs: values.reduce((max, value) => Math.max(max, Number(value) || 0), 0),
  };
}

function latencyDriftSummary(samples, valueSelector = (sample) => sample) {
  const ordered = [...(samples || [])].sort(
    (left, right) =>
      Number(left?.sequence ?? left?.at ?? 0) -
      Number(right?.sequence ?? right?.at ?? 0),
  );
  if (ordered.length === 0) {
    return {
      sampleCount: 0,
      first: latencySummary([]),
      last: latencySummary([]),
      drift: {},
    };
  }
  const sliceSize = Math.max(1, Math.floor(ordered.length * 0.1));
  const first = latencySummary(ordered.slice(0, sliceSize).map(valueSelector));
  const last = latencySummary(ordered.slice(-sliceSize).map(valueSelector));
  const drift = {};
  for (const key of ["p50ms", "p95ms", "p98ms", "p99ms", "p999ms", "maxMs"]) {
    const deltaMs = Number(last[key] || 0) - Number(first[key] || 0);
    drift[key] = {
      deltaMs,
      percent: first[key] > 0 ? money((deltaMs / first[key]) * 100) : null,
    };
  }
  return { sampleCount: ordered.length, sliceSize, first, last, drift };
}

function p5ActionTimeWindows(samples, totalActions, windowCount = 10) {
  const safeTotal = Math.max(1, Number(totalActions) || 1);
  return Array.from({ length: windowCount }, (_, index) => {
    const firstSequence = Math.floor((index * safeTotal) / windowCount) + 1;
    const lastSequence = Math.floor(((index + 1) * safeTotal) / windowCount);
    const values = samples
      .filter(
        (sample) =>
          sample.sequence >= firstSequence && sample.sequence <= lastSequence,
      )
      .map((sample) => sample.durationMs);
    return {
      index: index + 1,
      firstSequence,
      lastSequence,
      count: values.length,
      latencyMs: latencySummary(values),
    };
  });
}

function p5ActionOutcome(result, type, disruptive = false) {
  const actionType = String(type ?? "").trim() || "unknown";
  return {
    result,
    actionType,
    disruptive: disruptive === true,
  };
}

function tagP5ActionError(error, type, disruptive = false) {
  const tagged =
    error instanceof Error
      ? error
      : new Error(String(error ?? "P5 action failed"));
  tagged.p5ActionType = String(type ?? "").trim() || "unknown";
  tagged.p5Disruptive = disruptive === true;
  return tagged;
}

function isP5DisruptiveActionType(type) {
  return /(?:network-reconnect|logout|reload|long-press)/i.test(
    String(type ?? ""),
  );
}

function p5ActionTypeSummaries(samples) {
  const grouped = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const type = String(sample?.type ?? "unknown").trim() || "unknown";
    const current = grouped.get(type) ?? { count: 0, failed: 0, values: [] };
    current.count += 1;
    current.failed += sample?.ok === false ? 1 : 0;
    current.values.push(Number(sample?.durationMs) || 0);
    grouped.set(type, current);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, current]) => [
        type,
        {
          count: current.count,
          failed: current.failed,
          latencyMs: latencySummary(current.values),
        },
      ]),
  );
}

function lineFromCatalog(multiplier = 1) {
  const [productId, name, price] = pick(catalog);
  const qty = Math.max(1, Math.min(4, multiplier || 1));
  return {
    name,
    productName: name,
    productId,
    qty,
    quantity: qty,
    price,
    unitPrice: price,
  };
}

function linesTotal(lines) {
  return money(
    lines.reduce(
      (sum, entry) =>
        sum +
        Number(entry.price || entry.unitPrice || 0) *
          Number(entry.qty || entry.quantity || 1),
      0,
    ),
  );
}

function tableNumberFromId(tableId) {
  return Number(String(tableId).match(/_t(\d+)$/)?.[1] ?? 0);
}

function tablesAuthorizedForSession(session, tableList) {
  const candidates = Array.isArray(tableList) ? tableList : [];
  const authorizedRoomIds = Array.isArray(session?.user?.authorizedRoomIds)
    ? session.user.authorizedRoomIds
        .map((roomId) => String(roomId ?? "").trim())
        .filter(Boolean)
    : [];
  if (authorizedRoomIds.length === 0) return candidates;
  const allowed = new Set(authorizedRoomIds);
  return candidates.filter((table) =>
    allowed.has(String(table?.roomId ?? "").trim()),
  );
}

function createUser(
  id,
  username,
  fullName,
  role,
  pin,
  permissions,
  extra = {},
) {
  const now = nowIso();
  return {
    id,
    username,
    fullName,
    role,
    roleLabel:
      role === "admin"
        ? "Amministratore"
        : role === "responsabile"
          ? "Responsabile"
          : "Operatore",
    permissions,
    enabledAppIds: ["cassa", "postazione", "palmare"],
    workstationIds: activeStationNames.map(
      (_, index) => `workstation_load_${index + 1}`,
    ),
    authorizedRoomIds: rooms.map((room) => room.id),
    enabledRoomIds: rooms.map((room) => room.id),
    allowedPaymentMethodIds: ["pay_cash", "pay_card", "pay_smart", "pay_chip"],
    pinHash: hashPin(pin),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function buildAutomaticCashGatewayInventory() {
  return {
    ok: true,
    inventory: {
      ok: true,
      error: null,
      listCassette: [2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1].map(
        (cents) => ({
          Value_Money: cents,
          Stock: 120,
          IsExist: true,
          IsEmpty: false,
        }),
      ),
    },
    activeOperation: null,
    deposit: null,
    updatedAtMs: Date.now(),
  };
}

function buildAutomaticCashReserveConfig() {
  return {
    schema_version: 1,
    id: "reserve-loadtest-realistic-v1",
    nome: "Riserva loadtest realistico",
    valuta: "EUR",
    enabled: true,
    missing_denomination_policy: "reject",
    denominazioni_centesimi: {
      "20_euro": 2000,
      "10_euro": 1000,
      "5_euro": 500,
      "2_euro": 200,
      "1_euro": 100,
      "50_cent": 50,
      "20_cent": 20,
      "10_cent": 10,
      "5_cent": 5,
      "2_cent": 2,
      "1_cent": 1,
    },
    riserva_minima_pezzi: {
      "20_euro": 1,
      "10_euro": 1,
      "5_euro": 1,
      "2_euro": 1,
      "1_euro": 1,
      "50_cent": 1,
      "20_cent": 1,
      "10_cent": 1,
      "5_cent": 1,
      "2_cent": 0,
      "1_cent": 0,
    },
  };
}

async function prepareAutomaticCashSeed() {
  const configPath = path.join(
    cassaRoot,
    "backend",
    "fixtures",
    "fondo_cassa_100_combinazioni.json",
  );
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  const uploadedAt = nowIso();
  const { validation, configSet } = createAutomaticCashConfigSet({
    config: rawConfig,
    uploadedAt,
    uploadedBy: "loadtest-realistic",
  });
  if (!validation.ok || !configSet) {
    throw new Error(
      `Configurazione 100 fondi cassa non valida: ${validation.errors.join("; ")}`,
    );
  }
  const reserveRawConfig = buildAutomaticCashReserveConfig();
  const { validation: reserveValidation, reserveConfig } =
    createAutomaticCashReserveConfigSet({
      config: reserveRawConfig,
      uploadedAt,
      uploadedBy: "loadtest-realistic",
    });
  if (!reserveValidation.ok || !reserveConfig) {
    throw new Error(
      `Riserva cassa automatica non valida: ${reserveValidation.errors.join("; ")}`,
    );
  }
  return {
    configPath,
    rawConfig,
    reserveRawConfig,
    settings: {
      enabled: true,
      gatewayConfigured: true,
      feedbackEnabled: true,
      warningThresholdCents: 1000,
      dangerThresholdCents: 1000,
      autoCashFloatMode: "random_file",
      configSetId: configSet.id,
      configSet,
      configSets: [configSet],
      reserveConfigId: reserveConfig.id,
      reserveConfig,
      reserveConfigs: [reserveConfig],
      gatewayInventory: buildAutomaticCashGatewayInventory(),
      workflows: [],
      assignments: [],
      cashFloats: [],
      deposits: [],
      cashExchanges: [],
      cashPayments: [],
      settlementRecords: [],
    },
  };
}

function buildSeedState() {
  const state = buildInitialAppState();
  const now = nowIso();
  const allPerms = [
    "collect_payments",
    "approve_room_change",
    "manage_tables",
    "manage_menu",
    "override_order_price",
    "view_analytics",
    "manage_sale_sessions",
    "print_orders",
    "open_drawer",
    "fiscal_operations",
    "manage_settings",
    "manage_reservations",
    "manage_smart_customers",
    "create_bar_replacement",
    "manage_users",
    "automatic_cash_admin",
    "counter_mode",
  ];
  const opPerms = [
    "collect_payments",
    "approve_room_change",
    "manage_tables",
    "override_order_price",
    "view_analytics",
    "print_orders",
    "fiscal_operations",
    "manage_reservations",
    "create_bar_replacement",
    "counter_mode",
  ];

  state.users = [
    createUser(
      "u_load_admin",
      "admin_load",
      "Admin Load",
      "admin",
      "1111",
      allPerms,
    ),
    createUser(
      "u_load_manager",
      "manager",
      "Manager Load",
      "responsabile",
      "4444",
      allPerms,
    ),
    createUser(
      "u_load_lock_observer",
      "lock_observer",
      "Lock Observer",
      "operator",
      "3333",
      [],
    ),
    ...Array.from({ length: 40 }, (_, index) =>
      createUser(
        `u_load_op_${index + 1}`,
        `op${index + 1}`,
        `Operatore Load ${index + 1}`,
        "operator",
        "2222",
        opPerms,
        {
          waiterPauseSettings: {
            enabled: true,
            durationMinutes: 15,
            renewalMinutes: 120,
          },
          ...(index === 19
            ? {
                authorizedRoomIds: ["room_pedana"],
                enabledRoomIds: ["room_pedana", "room_sala"],
              }
            : {}),
        },
      ),
    ),
  ];

  const tables = [];
  for (const room of rooms) {
    const count = room.virtual ? 20 : 50;
    for (let index = 1; index <= count; index += 1) {
      tables.push({
        id: `${room.id}_t${String(index).padStart(2, "0")}`,
        number: index,
        type: room.name,
        roomId: room.id,
        status: "free",
        covers: 0,
        totalDue: 0,
        pendingBills: [],
        guestName: "",
        reservation: null,
      });
    }
  }

  state.posSettings = {
    ...(state.posSettings || {}),
    rooms: rooms.map((room) => ({ ...room, roomId: room.id, enabled: true })),
    tables,
    activities: [
      {
        ...(state.posSettings?.activities?.find(
          (entry) => entry?.id === "activity_default",
        ) || {}),
        id: "activity_default",
        name: "Operativa",
        status: "active",
        printerIds: VIRTUAL_PRINTERS.map((printer) => printer.id),
        precontoPrinterIds: VIRTUAL_PRINTERS.map((printer) => printer.id),
        workstationIds: activeStationNames.map(
          (_, index) => `workstation_load_${index + 1}`,
        ),
      },
    ],
    activityRoomBindings: rooms.map((room) => ({
      activityId: "activity_default",
      roomId: room.id,
    })),
    printers: VIRTUAL_PRINTERS.map((printer) => ({
      ...printer,
      purpose: "generic",
      active: true,
    })),
    areas: rooms.map((room, roomIndex) => ({
      id: room.id,
      name: room.name,
      printerIds: [printerForStationIndex(roomIndex).id],
      precontoPrinterIds: [printerForStationIndex(roomIndex).id],
      cashPoints: [
        {
          id: `${room.id}_cash`,
          name: `${room.name} Cassa`,
          printerIds: [printerForStationIndex(roomIndex).id],
          precontoPrinterIds: [printerForStationIndex(roomIndex).id],
          fiscalPrinterId: "rt_load_real",
        },
      ],
      workstations: activeStationNames.map((stationName, index) => ({
        id: `${room.id}_station_${index + 1}`,
        name: stationName,
        stationName,
        printerIds: [printerForStationIndex(index).id],
        precontoPrinterIds: [printerForStationIndex(index).id],
        printOrderEnabled: true,
        printPrecontoEnabled: true,
      })),
    })),
    workstations: activeStationNames.map((stationName, index) => ({
      id: `workstation_load_${index + 1}`,
      name: stationName,
      stationName,
      active: true,
      status: "active",
      roomIds: rooms.map((room) => room.id),
      printerIds: [printerForStationIndex(index).id],
      precontoPrinterIds: [printerForStationIndex(index).id],
      printOrderEnabled: true,
      printPrecontoEnabled: true,
    })),
    mobileDevices: [
      ...Array.from(
        { length: HANDHELD_COUNT + GUI_COUNT + 20 },
        (_, index) => ({
          id: `load-device-${index + 1}`,
          deviceId: `load-device-${index + 1}`,
          deviceUuid: `load-device-${index + 1}`,
          name: `Load device ${index + 1}`,
          fiscalEnabled: index < Math.max(FISCAL_SAMPLE_LIMIT, GUI_COUNT),
          cashPaymentEnabled: true,
          electronicPaymentEnabled: true,
        }),
      ),
      {
        id: "load-admin-device",
        deviceId: "load-admin-device",
        deviceUuid: "load-admin-device",
        name: "Load admin device",
        fiscalEnabled: true,
        cashPaymentEnabled: true,
        electronicPaymentEnabled: true,
      },
    ],
    fiscalDevices: [
      {
        id: "rt_load_real",
        name: "RT virtuale load test",
        type: "api",
        fiscalProvider: "pos-fiscal-api",
        apiBaseUrl: RT_BASE_URL,
        statusEndpoint: "/api/fiscal/status",
        receiptEndpoint: "/api/fiscal/receipt",
        reprintEndpoint: "/api/fiscal/reprint",
        paymentMethodIds: ["pay_cash", "pay_card"],
        supportsCash: true,
        supportsElectronic: true,
        supportsReprint: true,
        active: true,
      },
    ],
    orderWorkflow: {
      ...(state.posSettings?.orderWorkflow || {}),
      deliveryConfirmationEnabled: false,
      requireReadyForDelivery: false,
      requireDeliveredForPayment: false,
    },
    automaticCash:
      automaticCashSeed?.settings ?? state.posSettings?.automaticCash,
    demoMode: false,
  };

  state.sessions = [];
  state.auditEvents = [];
  state.saleSessions = [];
  state.payments = [];
  state.paymentContainers = [];
  state.paymentParts = [];
  state.paymentTransactions = [];
  state.cashTxDenoms = [];
  state.fiscalReceipts = [];
  state.fiscalEvents = [];
  state.smartNonFiscal = [];
  state.integration = {
    ...(state.integration || {}),
    orders: [],
    tickets: [],
    notifications: [],
    orderComps: [],
    orderCorrections: [],
    sequence: { order: 0, notification: 0 },
    stationStates: [],
    waiterPauses: [],
    waiterDeferredCalls: [],
  };
  state.posRoomChangeRequests = [];
  state.posTableRoomMoveRequests = [];
  state.posReservationStates = [];
  state.posReservationLocks = [];
  state.posReservations = [];
  state.printSpoolJobs = [];
  state.paymentProviderTransactions = [];
  state.tableLocks = [];
  state.handheldCashSessions = [];
  state.meta = {
    ...(state.meta || {}),
    lastWriteAt: now,
    settingsVersion: Date.now(),
  };
  return state;
}

async function writeSeed() {
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  try {
    await fs.mkdir(outputDir, { recursive: false });
    outputDirReserved = true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      const collision = new Error(
        `LOADTEST_RUN_ID gia utilizzato: la directory ${outputDir} esiste gia.`,
      );
      collision.code = "LOADTEST_RUN_ID_ALREADY_USED";
      throw collision;
    }
    throw error;
  }
  if (REALISTIC_LOAD_PROFILE)
    automaticCashSeed = await prepareAutomaticCashSeed();
  const seed = buildSeedState();
  await fs.writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  return seed;
}

function spawnLogged(name, command, args, options = {}) {
  const logPath = path.join(outputDir, `${name}.log`);
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedChildren.add(child);
  const writeStream = fs.open(logPath, "a");
  let writeTail = Promise.resolve();
  let closeStarted = false;
  let resolveLogClosure;
  const logClosure = new Promise((resolve) => {
    resolveLogClosure = resolve;
  });
  spawnedLogClosures.add(logClosure);
  const appendLog = (chunk) => {
    writeTail = writeTail
      .then(async () => {
        const file = await writeStream;
        await file.write(chunk);
      })
      .catch(() => undefined);
  };
  const closeLog = () => {
    if (closeStarted) return;
    closeStarted = true;
    void writeTail
      .then(async () => {
        const file = await writeStream;
        await file.close();
      })
      .catch(() => undefined)
      .finally(() => {
        spawnedLogClosures.delete(logClosure);
        resolveLogClosure();
      });
  };
  child.stdout.on("data", (chunk) => {
    appendLog(chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendLog(chunk);
  });
  child.once("exit", () => {
    spawnedChildren.delete(child);
  });
  child.once("close", closeLog);
  child.once("error", () => {
    spawnedChildren.delete(child);
    closeLog();
  });
  return { child, logPath };
}

async function terminateChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    forceTimer.unref?.();
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

async function closeEventFile() {
  const file = eventFile;
  eventFile = null;
  if (file) await file.close().catch(() => undefined);
}

async function logoutTrackedSessions() {
  const sessions = [...trackedSessions].filter(
    (session) => session?.token && session?.user?.id && session?.deviceUuid,
  );
  const results = [];
  for (let offset = 0; offset < sessions.length; offset += 8) {
    const batch = sessions.slice(offset, offset + 8);
    results.push(
      ...(await Promise.all(
        batch.map(async (session) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          timer.unref?.();
          const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`,
            "X-User-Id": session.user.id,
            "X-Device-Uuid": session.deviceUuid,
          };
          const body = JSON.stringify({
            token: session.token,
            userId: session.user.id,
            deviceUuid: session.deviceUuid,
            clientApp: session.clientApp,
            stationName: session.stationName || "",
          });
          try {
            const response = await fetch(`${apiBaseUrl}/api/auth/logout`, {
              method: "POST",
              headers,
              body,
              signal: controller.signal,
            });
            const accepted = response.status === 200 || response.status === 401;
            const verification = accepted
              ? await fetch(`${apiBaseUrl}/api/auth/session/status`, {
                  method: "POST",
                  headers,
                  body,
                  signal: controller.signal,
                })
              : null;
            return {
              status: response.status,
              verificationStatus: verification?.status ?? 0,
              ok: accepted && verification?.status === 401,
            };
          } catch (error) {
            return {
              status: 0,
              ok: false,
              error: error?.name === "AbortError" ? "timeout" : "network",
            };
          } finally {
            clearTimeout(timer);
          }
        }),
      )),
    );
  }
  return {
    tracked: trackedSessions.size,
    attempted: sessions.length,
    accepted: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    statusCounts: Object.fromEntries(
      [...new Set(results.map((entry) => entry.status))]
        .sort((left, right) => left - right)
        .map((status) => [
          String(status),
          results.filter((entry) => entry.status === status).length,
        ]),
    ),
    verificationStatusCounts: Object.fromEntries(
      [...new Set(results.map((entry) => entry.verificationStatus ?? 0))]
        .sort((left, right) => left - right)
        .map((status) => [
          String(status),
          results.filter((entry) => (entry.verificationStatus ?? 0) === status)
            .length,
        ]),
    ),
  };
}

async function verifyRunSessionStoreEmpty() {
  if (!activeSessionsTableName) {
    return {
      tablePresent: false,
      before: 0,
      deleted: 0,
      remaining: 0,
      verified: trackedSessions.size === 0,
    };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(activeSessionsTableName)) {
    return {
      tablePresent: null,
      before: null,
      deleted: 0,
      remaining: null,
      verified: false,
      error: "invalid-table-name",
    };
  }

  let connection;
  try {
    connection = await mysqlConnection();
    const [tableRows] = await connection.query(
      `SELECT COUNT(*) AS count FROM information_schema.tables ` +
        `WHERE table_schema = DATABASE() AND table_name = ?`,
      [activeSessionsTableName],
    );
    const tablePresent = Number(tableRows?.[0]?.count ?? 0) > 0;
    if (!tablePresent) {
      return {
        tablePresent: false,
        before: 0,
        deleted: 0,
        remaining: 0,
        verified: true,
      };
    }

    const tableSql = `\`${activeSessionsTableName}\``;
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${tableSql}`,
    );
    const remaining = Number(rows?.[0]?.count ?? 0);
    return {
      tablePresent: true,
      before: remaining,
      deleted: 0,
      remaining,
      verified: remaining === 0,
    };
  } catch {
    return {
      tablePresent: null,
      before: null,
      deleted: 0,
      remaining: null,
      verified: false,
      error: "session-store-unavailable",
    };
  } finally {
    if (connection) await connection.end().catch(() => undefined);
  }
}

async function cleanupResources() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const checkpointWriter = activeP5LatencyCheckpointWriter;
    activeP5LatencyCheckpointWriter = null;
    if (checkpointWriter) {
      await checkpointWriter.close("process-cleanup").catch(() => undefined);
    }
    const browser = activeBrowser;
    activeBrowser = null;
    if (browser) await browser.close().catch(() => undefined);
    const apiLogout = await logoutTrackedSessions();
    const children = [...spawnedChildren];
    await Promise.all(children.map((child) => terminateChild(child)));
    await Promise.allSettled([...spawnedLogClosures]);
    const printSpool = await cleanupRunPrintSpool();
    const store = await verifyRunSessionStoreEmpty();
    trackedSessions.clear();
    await closeEventFile();
    return {
      sessions: {
        ok: apiLogout.failed === 0 && store.verified === true,
        apiLogout,
        store,
      },
      processes: {
        remaining: spawnedChildren.size,
        verified: spawnedChildren.size === 0,
      },
      logs: {
        openHandles: spawnedLogClosures.size,
        verified: spawnedLogClosures.size === 0,
      },
      printSpool,
    };
  })();
  return cleanupPromise;
}

async function cleanupRunPrintSpool() {
  const expectedPath = path.join(outputDir, "runtime", "print-spool");
  const base = { path: printSpoolDir, expectedPath };
  if (!outputDirReserved) {
    return {
      ...base,
      existed: null,
      removed: false,
      remaining: null,
      verified: true,
      skipped: "output-dir-not-reserved",
    };
  }
  if (printSpoolDir !== expectedPath) {
    return {
      ...base,
      existed: null,
      removed: false,
      remaining: null,
      verified: false,
      error: "unexpected-path",
    };
  }
  let stat;
  try {
    stat = await fs.lstat(printSpoolDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ...base,
        existed: false,
        removed: false,
        remaining: false,
        verified: true,
      };
    }
    return {
      ...base,
      existed: null,
      removed: false,
      remaining: null,
      verified: false,
      error: error?.code || "lstat-failed",
    };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      ...base,
      existed: true,
      removed: false,
      remaining: true,
      verified: false,
      error: "unsafe-file-type",
    };
  }
  try {
    const [realOutputDir, realPrintSpoolDir] = await Promise.all([
      fs.realpath(outputDir),
      fs.realpath(printSpoolDir),
    ]);
    const relative = path.relative(realOutputDir, realPrintSpoolDir);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return {
        ...base,
        existed: true,
        removed: false,
        remaining: true,
        verified: false,
        error: "outside-report-dir",
      };
    }
    await fs.rm(printSpoolDir, { recursive: true, force: false });
    try {
      await fs.lstat(printSpoolDir);
      return {
        ...base,
        existed: true,
        removed: true,
        remaining: true,
        verified: false,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          ...base,
          existed: true,
          removed: true,
          remaining: false,
          verified: true,
        };
      }
      return {
        ...base,
        existed: true,
        removed: true,
        remaining: null,
        verified: false,
        error: error?.code || "verify-failed",
      };
    }
  } catch (error) {
    return {
      ...base,
      existed: true,
      removed: false,
      remaining: true,
      verified: false,
      error: error?.code || "cleanup-failed",
    };
  }
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
      last = new Error(`${url} -> ${response.status}`);
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw last || new Error(`Timeout waiting for ${url}`);
}

async function fetchJsonIfAvailable(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function fetchRtFiscalProviderMetrics() {
  return await fetchJsonIfAvailable(`${RT_BASE_URL}/metrics`);
}

async function startMockIo() {
  if (!START_MOCK_IO) return { started: false, logs: {} };
  const logs = {};
  if (PRINTING_ENABLED) {
    const printerFarm = spawnLogged(
      "mock-printer-farm",
      nodeBin,
      [path.join(projectRoot, "tools", "mock-tcp-printer-farm.mjs")],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          MOCK_PRINTER_FARM_HOST: PRINTER_HOST,
          MOCK_PRINTER_FARM_PORTS: VIRTUAL_PRINTERS.map(
            (printer) => printer.port,
          ).join(","),
          MOCK_PRINTER_FARM_METRICS_PORT: String(PRINTER_METRICS_PORT),
        },
      },
    );
    logs.printers = printerFarm.logPath;
    await waitForHttp(`http://${PRINTER_HOST}:${PRINTER_METRICS_PORT}/health`);
  }

  const fiscalUrl = new URL(RT_BASE_URL);
  const fiscal = spawnLogged(
    "mock-fiscal",
    nodeBin,
    [path.join(projectRoot, "tools", "mock-fiscal-server.mjs")],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        MOCK_FISCAL_HOST: fiscalUrl.hostname,
        MOCK_FISCAL_PORT: String(Number(fiscalUrl.port || 80)),
      },
    },
  );
  logs.fiscal = fiscal.logPath;
  await waitForHttp(`${RT_BASE_URL}/api/fiscal/status`);

  if (REALISTIC_LOAD_PROFILE) {
    const automaticCash = spawnLogged(
      "mock-automatic-cash",
      nodeBin,
      [path.join(projectRoot, "tools", "fake-automatic-cash-gateway.mjs")],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          FAKE_AUTOMATIC_CASH_HOST: "127.0.0.1",
          FAKE_AUTOMATIC_CASH_PORT: String(AUTOMATIC_CASH_MOCK_PORT),
          FAKE_AUTOMATIC_CASH_DEPOSIT_TOTAL_CENTS: "2000",
          FAKE_AUTOMATIC_CASH_STOCK_PER_DENOMINATION: "500",
        },
      },
    );
    logs.automaticCash = automaticCash.logPath;
    await waitForHttp(`${AUTOMATIC_CASH_BASE_URL}/api/health`);

    const battery = spawnLogged(
      "mock-battery",
      nodeBin,
      [path.join(projectRoot, "tools", "mock-battery-service.mjs")],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          MOCK_BATTERY_HOST: "127.0.0.1",
          MOCK_BATTERY_PORT: String(BATTERY_MOCK_PORT),
          MOCK_BATTERY_DEVICES: String(HANDHELD_COUNT),
          MOCK_BATTERY_CHANGE_INTERVAL_MS: String(
            V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
          ),
        },
      },
    );
    logs.battery = battery.logPath;
    await waitForHttp(`http://127.0.0.1:${BATTERY_MOCK_PORT}/health`);
  }
  return { started: true, logs };
}

async function fetchMockIoMetrics() {
  return {
    printers: PRINTING_ENABLED
      ? await fetchJsonIfAvailable(
          `http://${PRINTER_HOST}:${PRINTER_METRICS_PORT}/metrics`,
        )
      : null,
    fiscal: await fetchRtFiscalProviderMetrics(),
    automaticCash: REALISTIC_LOAD_PROFILE
      ? await fetchJsonIfAvailable(`${AUTOMATIC_CASH_BASE_URL}/api/health`)
      : null,
    battery: REALISTIC_LOAD_PROFILE
      ? await fetchJsonIfAvailable(
          `http://127.0.0.1:${BATTERY_MOCK_PORT}/battery`,
        )
      : null,
  };
}

async function startBackend() {
  const appStateTable = `${prefix}_app_state`;
  const sessionsTable = `${prefix}_sessions`;
  activeSessionsTableName = sessionsTable;
  const auditTable = `${prefix}_audit`;
  const domainsTable = `${prefix}_domains`;
  const tableLocksTable = `${prefix}_table_work_locks`;
  const env = {
    ...process.env,
    NODE_ENV: "development",
    APP_STATE_DIRTY_TRACKING:
      process.env.APP_STATE_DIRTY_TRACKING ||
      (MULTIPROCESS ? "write" : "shadow"),
    APP_STATE_DIRTY_TRACKING_MODE:
      process.env.APP_STATE_DIRTY_TRACKING_MODE ||
      (MULTIPROCESS ? "write" : "shadow"),
    SCOPED_READS: process.env.SCOPED_READS || "1",
    SSE_EVENT_PAYLOAD: process.env.SSE_EVENT_PAYLOAD || "1",
    PORT: String(backendPort),
    BACKEND_PORT: String(backendPort),
    BACKEND_HOST: backendHost,
    BACKEND_PRINT_SPOOL_DIR: printSpoolDir,
    BACKEND_DB_MODE: "mysql",
    BACKEND_MYSQL_HOST: dbConfig.host,
    BACKEND_MYSQL_PORT: String(dbConfig.port),
    BACKEND_MYSQL_USER: dbConfig.user,
    BACKEND_MYSQL_PASSWORD: dbConfig.password,
    BACKEND_MYSQL_DATABASE: dbConfig.database,
    BACKEND_MYSQL_APP_STATE_TABLE: appStateTable,
    BACKEND_MYSQL_SPLIT_SESSIONS: "1",
    BACKEND_MYSQL_SESSIONS_TABLE: sessionsTable,
    BACKEND_MYSQL_SPLIT_AUDIT_EVENTS: "1",
    BACKEND_MYSQL_AUDIT_EVENTS_TABLE: auditTable,
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_MYSQL_APP_STATE_DOMAINS_TABLE: domainsTable,
    BACKEND_MYSQL_TABLE_LOCKS: "1",
    BACKEND_MYSQL_TABLE_LOCKS_TABLE: tableLocksTable,
    BACKEND_MYSQL_TABLE_LOCK_TOMBSTONES: tableLockTombstonesEnabled ? "1" : "0",
    BACKEND_API_WORKER_REQUEST_AUTH_FASTPATH: apiWorkerAuthFastPathEnabled
      ? "1"
      : "0",
    BACKEND_API_WORKER_REDIS_SESSION_CACHE: apiWorkerAuthFastPathEnabled
      ? "1"
      : "0",
    BACKEND_ORDER_CREATE_TARGETED_LOCK_REFRESH:
      orderCreateTargetedLockRefreshEnabled ? "1" : "0",
    BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH:
      orderCreateParallelExternalRefreshEnabled ? "1" : "0",
    BACKEND_TABLE_SYNC_APP_STATE_FASTPATH: tableSyncAppStateFastPathEnabled
      ? "1"
      : "0",
    BACKEND_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH:
      tableRoomMoveRequestAppStateFastPathEnabled ? "1" : "0",
    BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH:
      waiterPauseSessionAuditFastPathEnabled ? "1" : "0",
    BACKEND_COUNTER_COLLECTION_ATOMIC_FASTPATH:
      counterCollectionAtomicFastPathEnabled ? "1" : "0",
    BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR:
      paymentFreeSplitDurableMirror ? "1" : "0",
    BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES:
      paymentMirrorSkipPosSettingsTables ? "1" : "0",
    BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER: paymentMirrorStatelessConsumer
      ? "1"
      : "0",
    BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE: paymentFreeSplitSettingsReuse
      ? "1"
      : "0",
    BACKEND_PAYMENT_DOMAIN_NAMED_LOCK: paymentDomainNamedLockEnabled
      ? "1"
      : "0",
    BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE:
      ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE ? "1" : "0",
    BACKEND_APP_STATE_SPLIT_DB_PATH: appStateSplitDbPath,
    REDIS_KEY_PREFIX: redisKeyPrefix,
    ...(MULTIPROCESS && apiWorkerAuthFastPathEnabled
      ? {
          REDIS_PERSISTENT_CLIENT: "1",
          REDIS_PERSISTENT_POOL_SIZE: String(apiWorkerRedisPoolSize),
        }
      : {}),
    MQTT_ENABLED: "0",
    MQTT_EVENTS_ENABLED: "0",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_COMMAND_ACK_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "0",
    MQTT_STORE_ID: `${prefix}_mqtt_disabled`,
    BACKEND_ALLOW_EMPTY_DB_INIT: "1",
    BACKEND_ALLOW_MYSQL_IMPORT_JSON: "1",
    BACKEND_DB_IMPORT_JSON_PATH: seedPath,
    PRINTING_ENABLED: PRINTING_ENABLED ? "1" : "0",
    PRINT_SPOOL_FAST_WORKER: process.env.PRINT_SPOOL_FAST_WORKER || "1",
    PRINT_ASYNC_DISPATCH: "1",
    CARD_PAYMENT_PROVIDER: "mock",
    CARD_PAYMENT_MOCK_ENABLED: "1",
    POS_FISCAL_API_BASE_URL: RT_BASE_URL,
    POS_FISCAL_API_TIMEOUT_MS: "3500",
    POS_FISCAL_API_JOB_RETRY_DELAY_MS: "250",
    POS_FISCAL_API_JOB_MAX_ATTEMPTS: "3",
    POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "250",
    FISCAL_REAL_IO_DISABLED: "0",
    POS_FISCAL_REAL_IO_DISABLED: "0",
    CASSAV4_TEST_DISABLE_REAL_IO: "0",
    REAL_DEVICE_IO_DISABLED: "0",
    AUTOMATIC_CASH_GATEWAY_ENABLED: REALISTIC_LOAD_PROFILE ? "1" : "0",
    AUTOMATIC_CASH_REAL_ENABLED: "0",
    AUTOMATIC_CASH_GATEWAY_BASE_URL: REALISTIC_LOAD_PROFILE
      ? AUTOMATIC_CASH_BASE_URL
      : "http://127.0.0.1:9",
    AUTOMATIC_CASH_GATEWAY_USERNAME: "loadtest",
    AUTOMATIC_CASH_GATEWAY_PASSWORD: "loadtest",
    AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS: "10000",
    AUTOMATIC_CASH_SIMULATOR_SEED: REALISTIC_LOAD_PROFILE ? "1" : "0",
    AUTOMATIC_CASH_SIMULATOR_CONFIG_PATH: path.join(
      cassaRoot,
      "backend",
      "fixtures",
      "fondo_cassa_100_combinazioni.json",
    ),
    BATTERY_SERVICE_URL,
    BATTERY_SERVICE_TIMEOUT_MS: "2000",
    BATTERY_PROXY_CACHE_MS: "250",
    BATTERY_PROXY_EVENT_POLL_MS: "1000",
    RUNTIME_METRICS: process.env.RUNTIME_METRICS || "1",
    RUNTIME_METRICS_QUEUE_SAMPLE_LIMIT:
      String(runtimeMetricsQueueSampleLimit),
    ...(ACTION_SCHEDULE_PROFILE
      ? {
          DIAGNOSTICS_BASELINE: "1",
          DIAGNOSTICS_LOG_JSON: "0",
          DIAGNOSTICS_SAMPLE_RATE: "1",
          DIAGNOSTICS_BASELINE_LOG_PATH: p5BaselineDiagnosticsPaths.owner,
        }
      : {}),
    SMART_CARD_AUTO_DETECT: "0",
    SMART_CARD_READER_MODE: "push",
    BACKEND_TOKEN_SECRET: `loadtest-secret-${runId}-12345678901234567890`,
    INTEGRATION_SERVICE_TOKEN: integrationServiceToken,
    CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${frontendPort},http://localhost:${frontendPort}`,
    ...(MULTIPROCESS ? buildMultiprocessSharedEnv() : {}),
    ...(MULTIPROCESS
      ? {
          BACKEND_PROCESS_ROLE: "api-owner",
          BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER: "1",
          BACKEND_FISCAL_OUTBOX_WORKER_ENABLED: "1",
        }
      : {}),
  };
  const { child, logPath } = spawnLogged(
    "backend",
    nodeBin,
    ["backend/server.js"],
    {
      cwd: cassaRoot,
      env,
    },
  );
  await waitForHttp(`${apiBaseUrl}/api/health`);
  const siblings = [];
  if (MULTIPROCESS) {
    // I processi non-owner non devono importare il seed ne' inizializzare il DB:
    // leggono lo stato gia' scritto dall'owner dalle stesse tabelle MySQL.
    const siblingBaseEnv = { ...env };
    delete siblingBaseEnv.BACKEND_DB_IMPORT_JSON_PATH;
    siblingBaseEnv.BACKEND_ALLOW_MYSQL_IMPORT_JSON = "0";
    siblingBaseEnv.BACKEND_ALLOW_EMPTY_DB_INIT = "0";
    siblingBaseEnv.BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER = "0";
    siblingBaseEnv.BACKEND_FISCAL_OUTBOX_WORKER_ENABLED = "0";
    const realtime = spawnLogged(
      "backend-realtime",
      nodeBin,
      ["backend/server.js"],
      {
        cwd: cassaRoot,
        env: {
          ...siblingBaseEnv,
          BACKEND_PROCESS_ROLE: "realtime-gateway",
          PORT: String(realtimePort),
          BACKEND_PORT: String(realtimePort),
          ...(ACTION_SCHEDULE_PROFILE
            ? {
                DIAGNOSTICS_BASELINE_LOG_PATH:
                  p5BaselineDiagnosticsPaths.realtime,
              }
            : {}),
        },
      },
    );
    siblings.push(realtime);
    for (const [workerIndex, workerPort] of apiWorkerPorts.entries()) {
      const apiWorker = spawnLogged(
        `backend-api-worker-${workerIndex + 1}`,
        nodeBin,
        ["backend/server.js"],
        {
          cwd: cassaRoot,
          env: {
            ...siblingBaseEnv,
            BACKEND_PROCESS_ROLE: "api-worker",
            PORT: String(workerPort),
            BACKEND_PORT: String(workerPort),
            ...(ACTION_SCHEDULE_PROFILE
              ? {
                  DIAGNOSTICS_BASELINE_LOG_PATH:
                    p5BaselineDiagnosticsPaths.apiWorker(workerIndex),
                }
              : {}),
          },
        },
      );
      siblings.push(apiWorker);
    }
    for (const [workerIndex, workerPort] of tableLockWorkerPorts.entries()) {
      const lockWorker = spawnLogged(
        `backend-table-lock-worker-${workerIndex + 1}`,
        nodeBin,
        ["backend/server.js"],
        {
          cwd: cassaRoot,
          env: {
            ...siblingBaseEnv,
            BACKEND_PROCESS_ROLE: "table-lock-worker",
            PORT: String(workerPort),
            BACKEND_PORT: String(workerPort),
            BACKEND_MYSQL_CONNECTION_LIMIT: String(
              tableLockMysqlConnectionLimit,
            ),
            BACKEND_MYSQL_POOL_METRICS: "1",
            BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS: "1",
            BACKEND_MYSQL_TABLE_LOCK_HYBRID: "1",
            BACKEND_TABLE_LOCK_WORKER_REQUEST_FASTPATH: "1",
            BACKEND_TABLE_LOCK_WORKER_REDIS_SESSION_CACHE: "1",
            REDIS_PERSISTENT_CLIENT: "1",
            REDIS_PERSISTENT_POOL_SIZE: String(tableLockRedisPoolSize),
            ...(ACTION_SCHEDULE_PROFILE
              ? {
                  DIAGNOSTICS_BASELINE_LOG_PATH:
                    p5BaselineDiagnosticsPaths.tableLockWorker(workerIndex),
                }
              : {}),
          },
        },
      );
      siblings.push(lockWorker);
    }
    await waitForHttp(`${realtimeBaseUrl}/api/health`);
    for (const workerBaseUrl of apiWorkerBaseUrls) {
      await waitForHttp(`${workerBaseUrl}/api/health`);
    }
    for (const workerBaseUrl of tableLockWorkerBaseUrls) {
      await waitForHttp(`${workerBaseUrl}/api/health`);
    }
  }
  return {
    child,
    siblings,
    logPath,
    tables: {
      appStateTable,
      sessionsTable,
      auditTable,
      domainsTable,
      tableLocksTable,
    },
  };
}

function buildMultiprocessSharedEnv() {
  return {
    APP_STATE_DIRTY_TRACKING: "write",
    APP_STATE_DIRTY_TRACKING_MODE: "write",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_MYSQL_SPLIT_SESSIONS: "1",
    BACKEND_MYSQL_TABLE_LOCKS: "1",
    BACKEND_NOTIFICATION_PUNCTUAL_WRITER: "1",
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    BACKEND_RELATIONAL_DB_PATH: relationalDbPath,
    BACKEND_APP_STATE_SPLIT_DB_PATH: appStateSplitDbPath,
    EVENT_OUTBOX_ENABLED: "1",
    BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
    BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS:
      tableLockWorkerCount > 0 ? "1" : "0",
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_TABLE_SYNC_APP_STATE_FASTPATH: tableSyncAppStateFastPathEnabled
      ? "1"
      : "0",
    BACKEND_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH:
      tableRoomMoveRequestAppStateFastPathEnabled ? "1" : "0",
    BACKEND_COUNTER_COLLECTION_ATOMIC_FASTPATH:
      counterCollectionAtomicFastPathEnabled ? "1" : "0",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_TABLES_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_TABLE_SYNC_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_TABLES_STARTUP_RECONCILE: "1",
    BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING: "1",
    BACKEND_RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_READS: "1",
    BACKEND_RELATIONAL_RESERVATIONS_CREATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_DELETE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_LOCK_ACQUIRE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_LOCK_RELEASE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_STATUS_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS: "1",
    BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY: "1",
    BACKEND_FISCAL_OUTBOX_ENABLED: "1",
    PRINT_SPOOL_SQL_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    BACKEND_ORDERS_SYNC_FINANCIAL_NOOP_FASTPATH: "1",
    BACKEND_ORDERS_SYNC_NOOP_TABLE_SNAPSHOT: "1",
    BACKEND_ORDERS_SYNC_WORKFLOW_STATION_STATUS_FILTER: "1",
    BACKEND_ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP: "1",
    BACKEND_ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP: "1",
    BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT: "1",
    BACKEND_ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT: "1",
    LANE_PRINT: "1",
    PRINT_LANE_ENABLED: "1",
    PRINT_SPOOL_DISABLED_FAST_APPEND: "1",
    PRINT_SPOOL_LEGACY_MIRROR_INTERVAL_MS: "1000",
    PRINT_SPOOL_LEGACY_MIRROR_REMOTE_OWNER: "1",
    PRINT_SPOOL_LEGACY_MIRROR_OWNER_URL: apiBaseUrl,
    PRINT_SPOOL_LEGACY_MIRROR_REMOTE_OWNER_TIMEOUT_MS: "10000",
    PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER: "1",
    PRINT_SPOOL_AUTO_PRINT_OWNER_URL: apiBaseUrl,
    PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_TIMEOUT_MS: "10000",
    PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS: String(
      printSpoolAutoPrintOwnerIntervalMs,
    ),
    BACKEND_STATION_STATE_MARKER_LOCK_SKIP:
      stationStateMarkerLockSkipEnabled ? "1" : "0",
    BACKEND_STATION_STATE_LAST_WRITE_COALESCE:
      stationStateLastWriteCoalesceEnabled ? "1" : "0",
    BACKEND_STATION_STATE_LAST_WRITE_COALESCE_INTERVAL_MS: String(
      stationStateLastWriteCoalesceIntervalMs,
    ),
    PRINT_SPOOL_INTERMEDIATE_STATUS_EVENTS: "0",
    PRINT_SPOOL_INITIAL_STATUS_EVENTS: "0",
    PRINT_SPOOL_PRE_SEND_PROBE: "0",
    PRINT_SPOOL_LEGACY_MIRROR_ENABLED: "0",
    PRINT_SPOOL_OWNER_POLL_INTERVAL_MS: "50",
    PRINT_TCP_END_DELAY_MS: "0",
    ORDERS_ASYNC_FLUSH_INTERVAL_MS: String(ordersAsyncFlushIntervalMs),
    ORDERS_ASYNC_FLUSH_SKIP_POSSETTINGS_TABLES: "1",
    ORDERS_ASYNC_FLUSH_SKIP_EMPTY_AUDIT: "1",
    ORDERS_ASYNC_FLUSH_REMOTE_OWNER: "1",
    ORDERS_ASYNC_FLUSH_OWNER_URL: apiBaseUrl,
    ORDERS_ASYNC_FLUSH_REMOTE_OWNER_TIMEOUT_MS: "10000",
    ORDERS_ASYNC_FLUSH_MYSQL_LOCK: "1",
    ORDERS_ASYNC_FLUSH_MYSQL_LOCK_TIMEOUT_SEC: "3",
    ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT: ordersAsyncFlushMysqlNowaitEnabled ? "1" : "0",
    ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT: ordersAsyncFlushDetachLastWriteAtEnabled ? "1" : "0",
    ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE: ordersAsyncFlushDetachSequenceWhenSafeEnabled ? "1" : "0",
    BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS: "1000",
    BACKEND_RUNTIME_METRICS_PEER_URLS: [
      realtimeBaseUrl,
      ...apiWorkerBaseUrls,
      ...tableLockWorkerBaseUrls,
    ].join(","),
    BACKEND_RUNTIME_METRICS_PEER_TIMEOUT_MS: "750",
    LANE_CROSS_EXCLUSION_ORDERS: laneCrossExclusionOrdersEnabled ? "1" : "0",
    LANE_CROSS_EXCLUSION_TABLES: laneCrossExclusionTablesEnabled ? "1" : "0",
    LANE_CROSS_EXCLUSION_PAYMENTS: laneCrossExclusionPaymentsEnabled ? "1" : "0",
    LANE_CROSS_EXCLUSION_PRESENCE: laneCrossExclusionPresenceEnabled ? "1" : "0",
    PAYMENT_LANE_CONCURRENCY: String(paymentLaneConcurrency),
    PRINT_LANE_CONCURRENCY: String(printLaneConcurrency),
    ROOM_LANE_CONCURRENCY: String(ROOM_LANE_CONCURRENCY),
    RESERVATION_LANE_CONCURRENCY: "4",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST:
      MULTIPROCESS_ORDER_ALLOWLIST,
  };
}

async function startFrontend() {
  const env = {
    ...process.env,
    NODE_ENV: "development",
    FRONTEND_HOST: "127.0.0.1",
    FRONTEND_PORT: String(frontendPort),
    BACKEND_ORIGIN: apiBaseUrl,
    FRONTEND_ROOT: projectRoot,
    ...(REALISTIC_LOAD_PROFILE
      ? { BATTERY_ORIGIN: `http://127.0.0.1:${BATTERY_MOCK_PORT}` }
      : {}),
    ...(MULTIPROCESS
      ? {
          ...buildMultiprocessSharedEnv(),
          BACKEND_REALTIME_ORIGIN: realtimeBaseUrl,
          BACKEND_API_WORKER_ORIGIN: apiWorkerBaseUrls.join(","),
          ...(tableLockWorkerBaseUrls.length > 0
            ? {
                BACKEND_TABLE_LOCK_WORKER_ORIGIN:
                  tableLockWorkerBaseUrls.join(","),
              }
            : {}),
        }
      : {}),
  };
  const { child, logPath } = spawnLogged(
    "frontend",
    nodeBin,
    ["serve-frontends.mjs"],
    {
      cwd: projectRoot,
      env,
    },
  );
  await waitForHttp(`${frontendBaseUrl}/mobile/`);
  if (REALISTIC_LOAD_PROFILE)
    await waitForHttp(`${frontendBaseUrl}/postazione/`);
  return { child, logPath };
}

class Recorder {
  constructor() {
    this.startedAt = Date.now();
    this.endedAt = 0;
    this.ops = new Map();
    this.failures = [];
    this.httpRequests = 0;
    this.httpRequestBytes = 0;
    this.httpResponseBytes = 0;
    this.httpDurations = [];
    this.httpSamples = [];
    this.businessOps = 0;
    this.rtFiscalAttempts = 0;
    this.rtFiscalSuccess = 0;
    this.gui = [];
    this.coverage = new Map();
    this.radio = null;
  }

  record(type, durationMs, status, reqBytes, resBytes, ok, detail = {}) {
    this.httpRequests += 1;
    this.httpRequestBytes += reqBytes;
    this.httpResponseBytes += resBytes;
    this.httpDurations.push(durationMs);
    this.httpSamples.push({
      sequence: this.httpRequests,
      at: Date.now(),
      durationMs,
      type: String(type || "unknown"),
      status,
    });
    const key = String(type || "unknown");
    const bucket = this.ops.get(key) || {
      count: 0,
      ok: 0,
      fail: 0,
      durations: [],
      statuses: new Map(),
    };
    bucket.count += 1;
    bucket.ok += ok ? 1 : 0;
    bucket.fail += ok ? 0 : 1;
    bucket.durations.push(durationMs);
    bucket.statuses.set(status, (bucket.statuses.get(status) || 0) + 1);
    this.ops.set(key, bucket);
    if (!ok) {
      this.failures.push({ at: nowIso(), type: key, status, detail });
      if (this.failures.length > 500) this.failures.shift();
    }
  }

  business(type) {
    this.businessOps += 1;
    const key = `business:${type}`;
    const bucket = this.ops.get(key) || {
      count: 0,
      ok: 0,
      fail: 0,
      durations: [],
      statuses: new Map(),
    };
    bucket.count += 1;
    bucket.ok += 1;
    bucket.statuses.set("n/a", (bucket.statuses.get("n/a") || 0) + 1);
    this.ops.set(key, bucket);
  }

  cover(name, ok = true, detail = {}) {
    const key = String(name || "unknown");
    const current = this.coverage.get(key) || {
      attempts: 0,
      ok: 0,
      fail: 0,
      details: [],
    };
    current.attempts += 1;
    current.ok += ok ? 1 : 0;
    current.fail += ok ? 0 : 1;
    if (
      current.details.length < 50 &&
      detail &&
      Object.keys(detail).length > 0
    ) {
      current.details.push(detail);
    }
    this.coverage.set(key, current);
  }

  summary() {
    this.endedAt = this.endedAt || Date.now();
    const ops = {};
    for (const [key, bucket] of this.ops.entries()) {
      ops[key] = {
        count: bucket.count,
        ok: bucket.ok,
        fail: bucket.fail,
        ...latencySummary(bucket.durations),
        statuses: Object.fromEntries(bucket.statuses.entries()),
      };
    }
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(this.endedAt).toISOString(),
      durationMs: this.endedAt - this.startedAt,
      businessOps: this.businessOps,
      httpRequests: this.httpRequests,
      httpRequestBytes: this.httpRequestBytes,
      httpResponseBytes: this.httpResponseBytes,
      latencyMs: latencySummary(this.httpDurations),
      latencyDrift: latencyDriftSummary(
        this.httpSamples,
        (sample) => sample.durationMs,
      ),
      rtFiscalAttempts: this.rtFiscalAttempts,
      rtFiscalSuccess: this.rtFiscalSuccess,
      ops,
      failures: this.failures,
      gui: this.gui,
      radio: this.radio,
      coverage: Object.fromEntries(
        [...this.coverage.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };
  }
}

const recorder = new Recorder();
let eventFile = null;

async function writeEvent(event) {
  if (!eventFile) eventFile = await fs.open(eventsPath, "a");
  await eventFile.write(`${JSON.stringify({ at: nowIso(), ...event })}\n`);
}

function parseRealtimeSseBlock(block, aggregate) {
  const lines = String(block || "").split(/\r?\n/);
  const eventName = String(
    lines.find((line) => line.startsWith("event:"))?.slice(6) ?? "message",
  ).trim();
  if (eventName === "ready") aggregate.readyEvents += 1;
  if (eventName === "recovery") aggregate.recoveryEvents += 1;
  if (eventName !== "payload") return;
  const rawData = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!rawData) return;
  try {
    const envelope = JSON.parse(rawData);
    aggregate.payloadEvents += 1;
    recordRealtimeDeliverySample(aggregate, envelope);
  } catch {
    aggregate.parseErrors += 1;
  }
}

async function startRealtimeClients(sessions) {
  const selected = sessions.slice(0, REALTIME_CLIENT_COUNT);
  const aggregate = {
    expected: selected.length,
    connected: 0,
    connectionFailures: 0,
    streamFailures: 0,
    readyEvents: 0,
    payloadEvents: 0,
    recoveryEvents: 0,
    parseErrors: 0,
    bytes: 0,
    deliveryLagMs: [],
    deliveryLagMsByReason: {},
    eventTypeCounts: {},
    eventReasonCounts: {},
  };
  let closing = false;
  const clients = await Promise.all(
    selected.map(async (session, index) => {
      const controller = new AbortController();
      const query = new URLSearchParams({
        consumer: `load-${runId}-${index + 1}`,
        clientApp: session.clientApp || "mobile-frontend",
        userId: session.user.id,
        username: session.user.username,
        deviceUuid: session.deviceUuid,
        roomId: session.auth?.roomId || "",
        roomName: session.auth?.roomName || "",
      });
      const connectionTimer = setTimeout(() => controller.abort(), 15_000);
      let response;
      try {
        response = await fetch(
          `${frontendBaseUrl}/api/integration/notifications/stream?${query}`,
          {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${session.token}`,
              "X-Client-App": session.clientApp,
              "X-Session-Started-At": String(session.sessionStartedAt),
              "X-User-Id": session.user.id,
              "X-Username": session.user.username,
              "X-Device-Uuid": session.deviceUuid,
            },
            signal: controller.signal,
          },
        );
      } catch (error) {
        clearTimeout(connectionTimer);
        aggregate.connectionFailures += 1;
        recorder.failures.push({
          at: nowIso(),
          type: "realtime.stream.connect",
          status: 0,
          detail: { index, message: String(error?.message || error) },
        });
        return { controller, done: Promise.resolve() };
      }
      clearTimeout(connectionTimer);
      if (!response.ok || !response.body) {
        aggregate.connectionFailures += 1;
        recorder.failures.push({
          at: nowIso(),
          type: "realtime.stream.connect",
          status: response.status,
          detail: { index, message: "Stream SSE non disponibile." },
        });
        controller.abort();
        return { controller, done: Promise.resolve() };
      }

      aggregate.connected += 1;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const done = (async () => {
        let buffer = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            aggregate.bytes += chunk.value?.byteLength ?? 0;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              parseRealtimeSseBlock(buffer.slice(0, boundary), aggregate);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");
            }
          }
        } catch (error) {
          if (!closing && error?.name !== "AbortError") {
            aggregate.streamFailures += 1;
            recorder.failures.push({
              at: nowIso(),
              type: "realtime.stream.read",
              status: 0,
              detail: { index, message: String(error?.message || error) },
            });
          }
        } finally {
          reader.releaseLock();
        }
      })();
      return { controller, done };
    }),
  );

  return {
    summary() {
      return {
        expected: aggregate.expected,
        connected: aggregate.connected,
        connectionFailures: aggregate.connectionFailures,
        streamFailures: aggregate.streamFailures,
        readyEvents: aggregate.readyEvents,
        payloadEvents: aggregate.payloadEvents,
        recoveryEvents: aggregate.recoveryEvents,
        parseErrors: aggregate.parseErrors,
        bytes: aggregate.bytes,
        deliveryLagMs: latencySummary(aggregate.deliveryLagMs),
        deliveryLagMsByReason: Object.fromEntries(
          Object.entries(aggregate.deliveryLagMsByReason)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reason, values]) => [reason, latencySummary(values)]),
        ),
        eventTypeCounts: { ...aggregate.eventTypeCounts },
        eventReasonCounts: { ...aggregate.eventReasonCounts },
      };
    },
    async close() {
      closing = true;
      clients.forEach((client) => client.controller.abort());
      await Promise.allSettled(clients.map((client) => client.done));
    },
  };
}

function buildRadioFrame(streamId, sequence, payloadSize = 160) {
  const frame = Buffer.alloc(16 + payloadSize);
  frame.write("RPT1", 0, 4, "ascii");
  frame.writeUInt32BE(Number(streamId) >>> 0, 4);
  frame.writeUInt32BE(Number(sequence) >>> 0, 8);
  frame.writeUInt32BE(Date.now() >>> 0, 12);
  for (let index = 16; index < frame.length; index += 1)
    frame[index] = (sequence + index) % 255;
  return frame;
}

function radioWebSocketUrl() {
  const url = new URL("/api/radio/ws", frontendBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function startRadioScenario(sessions, deadlineAt) {
  const stats = {
    expected: sessions.length,
    connected: 0,
    connectionFailures: 0,
    transmissions: 0,
    framesSent: 0,
    binaryFramesReceived: 0,
    incomingStarts: 0,
    incomingStops: 0,
    busyResponses: 0,
    errors: [],
  };
  const clients = [];
  const channelIds = ["bar", "generale", "cassa"];

  const openClient = (session) =>
    new Promise((resolve) => {
      const socket = new WebSocket(radioWebSocketUrl(), {
        perMessageDeflate: false,
      });
      const client = { socket, session, listeners: new Set() };
      const timeout = setTimeout(() => {
        stats.connectionFailures += 1;
        socket.terminate();
        resolve(null);
      }, 10_000);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          stats.binaryFramesReceived += 1;
          return;
        }
        let message = null;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message?.type === "ptt:incoming-start") stats.incomingStarts += 1;
        if (message?.type === "ptt:incoming-stop") stats.incomingStops += 1;
        if (message?.type === "ptt:busy") stats.busyResponses += 1;
        for (const listener of [...client.listeners]) listener(message);
      });
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            type: "hello",
            token: session.token,
            userId: session.user.id,
            deviceUuid: session.deviceUuid,
            clientApp: session.clientApp,
            protocolVersion: 1,
          }),
        );
      });
      const readyListener = (message) => {
        if (message?.type !== "ready") return;
        client.listeners.delete(readyListener);
        socket.send(JSON.stringify({ type: "subscribe", channelIds }));
      };
      const subscribedListener = (message) => {
        if (message?.type !== "subscribed") return;
        clearTimeout(timeout);
        client.listeners.delete(subscribedListener);
        stats.connected += 1;
        resolve(client);
      };
      client.listeners.add(readyListener);
      client.listeners.add(subscribedListener);
      socket.once("error", (error) => {
        clearTimeout(timeout);
        stats.connectionFailures += 1;
        stats.errors.push(String(error?.message || error));
        resolve(null);
      });
    });

  for (let offset = 0; offset < sessions.length; offset += 5) {
    const opened = await Promise.all(
      sessions.slice(offset, offset + 5).map(openClient),
    );
    clients.push(...opened.filter(Boolean));
  }

  const waitMessage = (client, predicate, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.listeners.delete(listener);
        reject(new Error("radio event timeout"));
      }, timeoutMs);
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        client.listeners.delete(listener);
        resolve(message);
      };
      client.listeners.add(listener);
    });

  const transmitLoop = async (client, channelId, initialDelayMs) => {
    await sleep(initialDelayMs);
    let sequence = 0;
    while (Date.now() < deadlineAt) {
      const txId = `load-radio-${channelId}-${Date.now()}-${rnd(10000)}`;
      const started = performance.now();
      try {
        client.socket.send(
          JSON.stringify({
            type: "ptt:start",
            txId,
            channelId,
            codec: "mulaw",
            sampleRate: 16000,
            frameMs: 20,
          }),
        );
        const grant = await waitMessage(
          client,
          (message) =>
            (message?.type === "ptt:grant" && message.txId === txId) ||
            message?.type === "ptt:busy",
        );
        const grantMs = Math.round(performance.now() - started);
        recorder.record(
          "radio.ptt.grant",
          grantMs,
          grant?.type === "ptt:grant" ? 200 : 409,
          0,
          0,
          true,
          { channelId },
        );
        if (grant?.type === "ptt:busy") {
          await sleep(3_000 + rnd(4_000));
          continue;
        }
        stats.transmissions += 1;
        const transmissionMs = 3_000 + rnd(3_001);
        const transmissionEnd = Math.min(
          deadlineAt,
          Date.now() + transmissionMs,
        );
        while (Date.now() < transmissionEnd) {
          client.socket.send(buildRadioFrame(grant.streamId, sequence));
          sequence += 1;
          stats.framesSent += 1;
          await sleep(50);
        }
        client.socket.send(JSON.stringify({ type: "ptt:stop", txId }));
        recorder.cover("radio.transmission_min_3s", transmissionMs >= 3_000, {
          channelId,
          transmissionMs,
        });
      } catch (error) {
        stats.errors.push(String(error?.message || error));
      }
      await sleep(10_000 + rnd(35_000));
    }
  };

  const loops =
    clients.length >= 3
      ? channelIds.map((channelId, index) =>
          transmitLoop(clients[index], channelId, 2_000 + index * 3_000),
        )
      : [];
  const contender = (async () => {
    if (clients.length < 4) return;
    await sleep(15_000);
    while (Date.now() < deadlineAt) {
      const channelId = pick(channelIds);
      clients[3 + rnd(Math.max(1, clients.length - 3))].socket.send(
        JSON.stringify({
          type: "ptt:start",
          txId: `load-radio-busy-${Date.now()}-${rnd(10000)}`,
          channelId,
          codec: "mulaw",
          sampleRate: 16000,
          frameMs: 20,
        }),
      );
      await sleep(20_000 + rnd(30_000));
    }
  })();

  await Promise.allSettled([...loops, contender]);
  for (const client of clients) client.socket.close();
  recorder.cover("radio.clients_20", stats.connected === sessions.length, {
    connected: stats.connected,
    expected: sessions.length,
  });
  recorder.radio = stats;
  return stats;
}

async function readRelationalAudit() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalDbPath, { readOnly: true });
  const scalar = (sql) => Number(db.prepare(sql).get()?.value || 0);
  const grouped = (table) =>
    Object.fromEntries(
      db
        .prepare(
          `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status ORDER BY status`,
        )
        .all()
        .map((row) => [String(row.status), Number(row.count)]),
    );
  try {
    const pacedOrdersByDevice = Object.fromEntries(
      db
        .prepare(
          "SELECT created_by_device_uuid AS device_uuid, COUNT(*) AS count FROM orders WHERE created_by_device_uuid LIKE 'load-device-%' GROUP BY created_by_device_uuid ORDER BY created_by_device_uuid",
        )
        .all()
        .map((row) => [String(row.device_uuid), Number(row.count)]),
    );
    return {
      eventOutboxTotal: scalar("SELECT COUNT(*) AS value FROM event_outbox"),
      eventOutboxUnpublished: scalar(
        "SELECT COUNT(*) AS value FROM event_outbox WHERE published_at IS NULL",
      ),
      eventOutboxFailedUnpublished: scalar(
        "SELECT COUNT(*) AS value FROM event_outbox WHERE published_at IS NULL AND last_error IS NOT NULL",
      ),
      printSpoolStatuses: grouped("print_spool"),
      printSpoolPending: scalar(
        "SELECT COUNT(*) AS value FROM print_spool WHERE status NOT IN ('confirmed', 'failed_final')",
      ),
      printSpoolFailedFinal: scalar(
        "SELECT COUNT(*) AS value FROM print_spool WHERE status = 'failed_final'",
      ),
      fiscalOutboxStatuses: grouped("fiscal_outbox"),
      fiscalOutboxPending: scalar(
        "SELECT COUNT(*) AS value FROM fiscal_outbox WHERE status IN ('requested', 'processing', 'retrying')",
      ),
      fiscalOutboxProblem: scalar(
        "SELECT COUNT(*) AS value FROM fiscal_outbox WHERE status IN ('failed', 'manual_required')",
      ),
      paymentMirrorStatuses: grouped("payment_mirror_outbox"),
      paymentMirrorPending: scalar(
        "SELECT COUNT(*) AS value FROM payment_mirror_outbox WHERE status IN ('pending', 'processing', 'retrying')",
      ),
      paymentMirrorFailed: scalar(
        "SELECT COUNT(*) AS value FROM payment_mirror_outbox WHERE status = 'failed'",
      ),
      fiscalReceiptsNotIssued: scalar(
        "SELECT COUNT(*) AS value FROM fiscal_receipts WHERE UPPER(COALESCE(fiscal_status, '')) <> 'ISSUED'",
      ),
      duplicatePaymentIdempotencyKeys: scalar(
        "SELECT COUNT(*) AS value FROM (SELECT idempotency_key FROM payment_transactions WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING COUNT(*) > 1)",
      ),
      duplicateFiscalAttemptScopes: scalar(
        "SELECT COUNT(*) AS value FROM (SELECT payment_transaction_id, attempt_scope FROM fiscal_receipts WHERE payment_transaction_id IS NOT NULL GROUP BY payment_transaction_id, attempt_scope HAVING COUNT(*) > 1)",
      ),
      paymentTransactions: scalar(
        "SELECT COUNT(*) AS value FROM payment_transactions",
      ),
      orders: scalar("SELECT COUNT(*) AS value FROM orders"),
      pacedOrdersByDevice,
      pacedOrderDevices: Object.keys(pacedOrdersByDevice).length,
      pacedOrderDevicesMeetingTarget: Object.values(pacedOrdersByDevice).filter(
        (count) => count >= PACED_ORDER_COUNT,
      ).length,
      pacedOrderMinPerPresentDevice: Object.keys(pacedOrdersByDevice).length
        ? Math.min(...Object.values(pacedOrdersByDevice))
        : 0,
    };
  } finally {
    db.close();
  }
}

function runtimeGauge(metrics, name) {
  const value = Number(metrics?.gauges?.[name]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function readPrintRuntimeDrain(session) {
  const targets = MULTIPROCESS
    ? [apiBaseUrl, ...apiWorkerBaseUrls, ...tableLockWorkerBaseUrls]
    : [apiBaseUrl];
  const processes = await Promise.all(
    targets.map(async (url) => {
      try {
        const metrics = await fetchRuntimeMetrics(session, "snapshot", url);
        if (!metrics || metrics.ok === false) return { url, reachable: false };
        return {
          url,
          reachable: true,
          printLaneDepth: runtimeGauge(metrics, "printLaneDepth"),
          printLaneRunning: runtimeGauge(metrics, "printLaneRunning"),
          mirrorPendingDepth: runtimeGauge(
            metrics,
            "printSpoolLegacyMirrorPendingDepth",
          ),
          mirrorRunning: runtimeGauge(metrics, "printSpoolLegacyMirrorRunning"),
          paymentMirrorPendingDepth: runtimeGauge(
            metrics,
            "paymentMirrorPendingDepth",
          ),
          stationLastWritePendingDepth: runtimeGauge(
            metrics,
            "stationStateLastWritePendingDepth",
          ),
          stationLastWriteRunning: runtimeGauge(
            metrics,
            "stationStateLastWriteRunning",
          ),
        };
      } catch (error) {
        return {
          url,
          reachable: false,
          error: String(error?.message || error),
        };
      }
    }),
  );
  const totals = processes.reduce(
    (result, process) => {
      result.reachable += process.reachable ? 1 : 0;
      result.printLaneDepth += process.printLaneDepth || 0;
      result.printLaneRunning += process.printLaneRunning || 0;
      result.mirrorPendingDepth += process.mirrorPendingDepth || 0;
      result.mirrorRunning += process.mirrorRunning || 0;
      result.paymentMirrorPendingDepth +=
        process.paymentMirrorPendingDepth || 0;
      result.stationLastWritePendingDepth +=
        process.stationLastWritePendingDepth || 0;
      result.stationLastWriteRunning += process.stationLastWriteRunning || 0;
      return result;
    },
    {
      reachable: 0,
      printLaneDepth: 0,
      printLaneRunning: 0,
      mirrorPendingDepth: 0,
      mirrorRunning: 0,
      paymentMirrorPendingDepth: 0,
      stationLastWritePendingDepth: 0,
      stationLastWriteRunning: 0,
    },
  );
  return {
    expected: targets.length,
    ...totals,
    drained:
      totals.reachable === targets.length &&
      totals.printLaneDepth === 0 &&
      totals.printLaneRunning === 0 &&
      totals.mirrorPendingDepth === 0 &&
      totals.mirrorRunning === 0 &&
      totals.paymentMirrorPendingDepth === 0 &&
      totals.stationLastWritePendingDepth === 0 &&
      totals.stationLastWriteRunning === 0,
    processes,
  };
}

async function waitForRelationalDrain(
  session,
  timeoutMs = RELATIONAL_DRAIN_TIMEOUT_MS,
) {
  const startedAt = Date.now();
  let audit = null;
  let runtimeQueues = null;
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      audit = await readRelationalAudit();
      lastError = null;
      if (
        audit.eventOutboxUnpublished === 0 &&
        audit.printSpoolPending === 0 &&
        audit.fiscalOutboxPending === 0 &&
        audit.paymentMirrorPending === 0
      ) {
        runtimeQueues = await readPrintRuntimeDrain(session);
        if (runtimeQueues.drained) {
          return {
            ...audit,
            runtimeQueues,
            drained: true,
            waitedMs: Date.now() - startedAt,
          };
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  if (!audit)
    throw lastError || new Error("Audit relazionale non disponibile.");
  return {
    ...audit,
    runtimeQueues,
    drained: false,
    waitedMs: Date.now() - startedAt,
  };
}

function recordRelationalAuditFailures(audit) {
  const violations = [
    [audit?.drained !== true, "relational.drain.timeout", audit],
    [
      PRINTING_ENABLED && Number(audit?.printSpoolFailedFinal) > 0,
      "print.spool.failed_final",
      audit?.printSpoolStatuses,
    ],
    [
      Number(audit?.fiscalOutboxProblem) > 0,
      "fiscal.outbox.terminal_failure",
      audit?.fiscalOutboxStatuses,
    ],
    [
      Number(audit?.paymentMirrorFailed) > 0,
      "payment.mirror.terminal_failure",
      audit?.paymentMirrorStatuses,
    ],
    [
      Number(audit?.fiscalReceiptsNotIssued) > 0,
      "fiscal.receipt.not_issued",
      audit?.fiscalReceiptsNotIssued,
    ],
    [
      Number(audit?.duplicatePaymentIdempotencyKeys) > 0,
      "payment.duplicate_idempotency",
      audit?.duplicatePaymentIdempotencyKeys,
    ],
    [
      Number(audit?.duplicateFiscalAttemptScopes) > 0,
      "fiscal.duplicate_attempt_scope",
      audit?.duplicateFiscalAttemptScopes,
    ],
  ];
  for (const [failed, type, detail] of violations) {
    if (!failed) continue;
    recorder.failures.push({ at: nowIso(), type, status: 0, detail });
  }
}

async function request(session, method, route, body = {}, options = {}) {
  const payload =
    method === "GET" ? null : JSON.stringify({ ...session?.auth, ...body });
  let url = `${options.baseUrl ?? deviceApiBaseUrl}${route}`;
  if (method === "GET") {
    const params = new URLSearchParams({
      ...(options.includeAuthQuery === false ? {} : (session?.auth ?? {})),
      ...body,
    });
    const query = params.toString();
    if (query) url += `?${query}`;
  }
  const headers = { "Content-Type": "application/json" };
  if (session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
    headers["X-User-Id"] = session.user.id;
    headers["X-Device-Uuid"] = session.deviceUuid;
  }
  const reqBytes = Buffer.byteLength(payload || "") + Buffer.byteLength(route);
  const started = performance.now();
  let response;
  let text = "";
  let parsed = null;
  let ok = false;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload || undefined,
      signal: options.signal,
    });
    text = await response.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    const expected = options.expectedStatus;
    ok = expected
      ? response.status === expected
      : response.status >= 200 && response.status < 300;
    if (options.allow409 && response.status === 409) ok = true;
    if (options.allow428 && response.status === 428) ok = true;
    if (
      Array.isArray(options.allowStatuses) &&
      options.allowStatuses.includes(response.status)
    )
      ok = true;
    if (typeof options.allowResponse === "function") {
      ok =
        ok ||
        options.allowResponse({
          status: response.status,
          body: parsed,
          text,
          route,
        }) === true;
    }
  } catch (error) {
    parsed = { error: String(error?.message || error) };
    response = { status: 0 };
  }
  const durationMs = Math.round(performance.now() - started);
  const resBytes = Buffer.byteLength(text || "");
  if (options.record !== false) {
    const metricType =
      typeof options.type === "function"
        ? options.type({ status: response.status, body: parsed, route })
        : options.type;
    recorder.record(
      metricType || route,
      durationMs,
      response.status,
      reqBytes,
      resBytes,
      ok,
      {
        route,
        error: parsed?.error || parsed?.code || null,
        proxyRole: response.headers?.get?.("x-proxy-backend-role") ?? "",
        orderId: body?.orderId ?? body?.id ?? null,
        tableId: body?.tableId ?? null,
        expectedRevision: body?.expectedRevision ?? null,
      },
    );
  }
  if (!ok && options.throwOnError) {
    throw new Error(`${method} ${route} -> ${response.status}: ${text}`);
  }
  return {
    status: response.status,
    body: parsed,
    ok,
    durationMs,
    proxyRole: response.headers?.get?.("x-proxy-backend-role") ?? "",
  };
}

async function login(username, pin, deviceUuid, clientApp = "mobile-frontend") {
  const result = await request(
    null,
    "POST",
    "/api/auth/login",
    {
      username,
      pin,
      deviceUuid,
      clientApp,
    },
    { type: "login", throwOnError: true },
  );
  const user = result.body.user;
  const sessionStartedAt = Number(result.body.sessionStartedAt);
  if (!Number.isSafeInteger(sessionStartedAt) || sessionStartedAt <= 0) {
    throw new Error("Login privo dell'istante canonico della sessione.");
  }
  const session = {
    token: result.body.token,
    sessionStartedAt,
    user,
    deviceUuid,
    clientApp,
    auth: {
      token: result.body.token,
      userId: user.id,
      username: user.username,
      fullName: user.fullName,
      deviceUuid,
      clientApp,
      roomId: "room_pedana",
      roomName: "Pedana",
    },
  };
  trackedSessions.add(session);
  return session;
}

async function selectLoginWorkstation(session, workstationId, stationName) {
  if (session?.clientApp !== "postazione") {
    throw new Error("La selezione postazione richiede una sessione Postazione.");
  }
  const result = await request(
    session,
    "POST",
    "/api/auth/workstation/select",
    {
      clientApp: "postazione",
      workstationId,
      stationName,
    },
    { type: "login.workstation.select", throwOnError: true },
  );
  const selected = result.body?.selectedWorkstation;
  const normalizedExpectedStation = String(stationName || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const normalizedSelectedStation = String(selected?.stationName || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  if (
    String(selected?.id || "").trim() !== String(workstationId || "").trim() ||
    normalizedSelectedStation !== normalizedExpectedStation
  ) {
    throw new Error("La selezione API non ha confermato la postazione attesa.");
  }
  session.workstationId = String(selected.id).trim();
  session.stationName = String(selected.stationName).trim();
  session.auth = {
    ...session.auth,
    workstationId: session.workstationId,
    stationName: session.stationName,
  };
  return selected;
}

async function fetchRuntimeMetrics(
  session,
  action = "snapshot",
  baseUrl = undefined,
  options = {},
) {
  if (!session?.token) return null;
  const method = action === "reset" ? "POST" : "GET";
  const route =
    action === "reset"
      ? "/api/monitor/runtime-metrics/reset"
      : "/api/monitor/runtime-metrics";
  // In multi-processo le metriche order-workflow vivono sull'api-worker: di
  // default puntiamo li'; l'owner resta raggiungibile passando apiBaseUrl.
  const targetBaseUrl =
    baseUrl ?? (MULTIPROCESS ? apiWorkerBaseUrl : apiBaseUrl);
  const result = await request(
    session,
    method,
    route,
    {},
    {
      type: `monitor.runtime_metrics.${action}`,
      allowStatuses: [200, 401, 403, 404, 503],
      throwOnError: false,
      baseUrl: targetBaseUrl,
      record: options.record !== false,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error:
        result.body?.error ||
        result.body?.code ||
        "runtime_metrics_unavailable",
    };
  }
  return result.body?.runtimeMetrics || null;
}

async function lockTable(session, tableId, purpose, options = {}) {
  return request(
    session,
    "POST",
    "/api/tables/lock/acquire",
    { tableId, purpose },
    {
      type: "lock.acquire",
      allow409: true,
      signal: options.signal,
    },
  );
}

function isLockAcquired(result) {
  return result?.status === 200;
}

function isTransientTableLockConflict(result) {
  return (
    result?.status === 409 &&
    (String(result?.body?.code ?? "").trim() === "TABLE_LOCKED" ||
      /tavolo.+blocc/iu.test(String(result?.body?.error ?? "")))
  );
}

async function lockTableWithRetry(session, tableId, purpose, options = {}) {
  const attempts = Math.max(1, Math.min(Number(options.attempts) || 4, 6));
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await lockTable(session, tableId, purpose, options);
    if (isLockAcquired(result) || !isTransientTableLockConflict(result)) {
      return result;
    }
    if (attempt < attempts) await sleep(100 + attempt * 75);
  }
  return result;
}

async function releaseTable(session, tableId, options = {}) {
  return request(
    session,
    "POST",
    "/api/tables/lock/release",
    { tableId },
    {
      type: "lock.release",
      allow409: true,
      allowStatuses: [403],
      signal: options.signal,
    },
  );
}

async function verifyMultiprocessTableLockRouting(
  sessionA,
  sessionB,
  admin,
  unprivilegedUser,
) {
  if (!MULTIPROCESS) return null;
  const tableId = "room_pedana_t50";
  const expectedProxyRole =
    tableLockWorkerBaseUrls.length > 0 ? "table-lock-worker" : "api-worker";
  const workerA = tableLockWorkerBaseUrls[0] ?? apiWorkerBaseUrls[0];
  const workerB =
    tableLockWorkerBaseUrls[1] ??
    apiWorkerBaseUrls.find((url) => url !== workerA) ??
    workerA;
  const steps = [];
  const probe = async (
    name,
    session,
    route,
    expectedStatus,
    baseUrl = undefined,
  ) => {
    const result = await request(
      session,
      "POST",
      route,
      { tableId, purpose: `p4.${name}` },
      {
        baseUrl,
        expectedStatus,
        record: false,
        throwOnError: true,
        type: `preflight.table_lock.${name}`,
      },
    );
    steps.push({
      name,
      status: result.status,
      durationMs: result.durationMs,
      target: baseUrl ?? deviceApiBaseUrl,
      proxyRole: result.proxyRole,
      code: result.body?.code ?? null,
    });
    return result;
  };

  try {
    const proxyAcquire = await probe(
      "proxy_acquire",
      sessionA,
      "/api/tables/lock/acquire",
      200,
    );
    if (proxyAcquire.proxyRole !== expectedProxyRole) {
      throw new Error(
        `lock acquire instradato a ${proxyAcquire.proxyRole || "ruolo_sconosciuto"}`,
      );
    }
    const conflict = await probe(
      "cross_worker_conflict",
      sessionB,
      "/api/tables/lock/acquire",
      409,
      workerB,
    );
    if (conflict.body?.code !== "TABLE_LOCKED") {
      throw new Error(
        `conflitto lock inatteso: ${conflict.body?.code || "codice_assente"}`,
      );
    }
    const proxyHeartbeat = await probe(
      "proxy_heartbeat",
      sessionA,
      "/api/tables/lock/heartbeat",
      200,
    );
    if (proxyHeartbeat.proxyRole !== expectedProxyRole) {
      throw new Error(
        `lock heartbeat instradato a ${proxyHeartbeat.proxyRole || "ruolo_sconosciuto"}`,
      );
    }
    await probe(
      "cross_worker_heartbeat",
      sessionA,
      "/api/tables/lock/heartbeat",
      200,
      workerB,
    );
    await probe(
      "wrong_owner_release",
      sessionB,
      "/api/tables/lock/release",
      403,
      workerA,
    );
    const proxyRelease = await probe(
      "proxy_release",
      sessionA,
      "/api/tables/lock/release",
      200,
    );
    if (proxyRelease.proxyRole !== expectedProxyRole) {
      throw new Error(
        `lock release instradato a ${proxyRelease.proxyRole || "ruolo_sconosciuto"}`,
      );
    }
    await probe(
      "direct_reacquire",
      sessionA,
      "/api/tables/lock/acquire",
      200,
      workerA,
    );
    const deniedForceRelease = await probe(
      "non_admin_force_release",
      unprivilegedUser,
      "/api/tables/lock/force-release",
      403,
    );
    if (deniedForceRelease.proxyRole !== expectedProxyRole) {
      throw new Error(
        `lock force-release negato instradato a ${deniedForceRelease.proxyRole || "ruolo_sconosciuto"}`,
      );
    }
    const adminForceRelease = await probe(
      "admin_force_release",
      admin,
      "/api/tables/lock/force-release",
      200,
    );
    if (adminForceRelease.proxyRole !== expectedProxyRole) {
      throw new Error(
        `lock force-release instradato a ${adminForceRelease.proxyRole || "ruolo_sconosciuto"}`,
      );
    }
    await probe(
      "other_owner_acquire",
      sessionB,
      "/api/tables/lock/acquire",
      200,
      workerA,
    );
    await probe(
      "other_owner_release",
      sessionB,
      "/api/tables/lock/release",
      200,
      workerB,
    );
    return { ok: true, tableId, expectedProxyRole, workerA, workerB, steps };
  } finally {
    await request(
      admin,
      "POST",
      "/api/tables/lock/force-release",
      { tableId, purpose: "p4.cleanup" },
      {
        baseUrl: workerA,
        allowStatuses: [200, 404],
        record: false,
        throwOnError: false,
        type: "preflight.table_lock.cleanup",
      },
    );
  }
}

async function stationHeartbeat(session, station, active = true, extra = {}) {
  const printer = printerForStationName(station);
  return request(
    session,
    "POST",
    "/api/integration/stations/state",
    {
      station,
      active,
      clientApp: "postazione",
      autoPrintOrders: REALISTIC_LOAD_PROFILE,
      autoPrintPreconto: false,
      printerIds: [printer.id],
      printerId: printer.id,
      printerHost: printer.host,
      printerPort: printer.port,
      operatorUserId: session.user.id,
      operatorUsername: session.user.username,
      operatorName: session.user.fullName,
      operatorRole: session.user.roleLabel,
      ...extra,
    },
    {
      type: "station.heartbeat",
      allow409: true,
    },
  );
}

async function createOrder(session, table, options = {}) {
  const lock = await lockTable(session, table.id, "order.create", {
    signal: options.signal,
  });
  if (!isLockAcquired(lock)) return lock;
  try {
    const lineCount = options.long ? 8 + rnd(12) : 1 + rnd(4);
    const lines =
      options.lines ??
      Array.from({ length: lineCount }, (_, index) => ({
        ...lineFromCatalog((index % 3) + 1),
        ...(options.withVariants && index === 0
          ? {
              variant: "Secco",
              variantName: "Secco",
              note: "Poco ghiaccio, senza allergeni dichiarati",
            }
          : {}),
      }));
    return await request(
      session,
      "POST",
      "/api/integration/orders/create",
      {
        source: options.source || "mobile-frontend",
        tableId: table.id,
        roomId: table.roomId,
        tableNumber: table.number,
        covers: 1 + rnd(6),
        apericena: rnd(5) === 0 ? 2 : 0,
        note: options.note || `load note ${runId}`,
        orderNote: options.note || `load order ${runId}`,
        idempotencyKey:
          options.idempotencyKey ||
          `load-create-${session.deviceUuid}-${table.id}-${Date.now()}-${rnd(100000)}`,
        communications:
          options.long || options.withVariants
            ? "comunicazione reparto: priorita e verifica intolleranze"
            : "",
        orderComment:
          options.long || options.withVariants
            ? "commento ordine realistico"
            : "",
        total: linesTotal(lines),
        lines,
      },
      {
        type: options.long ? "order.create.long" : "order.create",
        allow409: true,
        signal: options.signal,
      },
    );
  } finally {
    await releaseTable(session, table.id, {
      signal: options.signal,
    });
  }
}

async function syncOrder(
  session,
  orderId,
  workflowStatus,
  station = "BAR PRINCIPALE",
) {
  return request(
    session,
    "POST",
    "/api/integration/orders/sync",
    {
      id: orderId,
      order: {
        workflowStatus,
        station,
        ownerStation: station,
      },
      workflowReason: "loadtest",
    },
    { type: `order.sync.${workflowStatus}`, allow409: true },
  );
}

async function refreshOrderById(session, order) {
  const orderId = String(order?.id ?? "").trim();
  if (!orderId) return order;
  const result = await request(
    session,
    "GET",
    "/api/integration/orders",
    {
      orderId,
      includeDone: "1",
      fresh: String(Date.now()),
    },
    {
      type: "order.refresh",
      allow409: true,
      allowStatuses: [404],
      includeAuthQuery: false,
    },
  );
  return resolveRefreshedOrder(order, result);
}

function currentOrderStation(order, fallbackStation = "BAR PRINCIPALE") {
  return (
    String(order?.ownerStation ?? order?.station ?? "").trim() ||
    fallbackStation
  );
}

async function syncOrderAtCurrentStation(
  session,
  order,
  workflowStatus,
  fallbackStation,
) {
  const current = await refreshOrderById(session, order);
  if (!current?.id) return null;
  return syncOrder(
    session,
    current.id,
    workflowStatus,
    currentOrderStation(current, fallbackStation),
  );
}

async function pollStationWorkflowOrders(session, station) {
  return request(
    session,
    "GET",
    "/api/integration/orders",
    {
      station,
      includeDone: "1",
      operatorUserId: session.user.id,
      operatorUsername: session.user.username,
      deviceUuid: session.deviceUuid,
      fresh: String(Date.now()),
    },
    { type: "orders.poll.workflow", includeAuthQuery: false },
  );
}

function stationWorkflowOrderMatchesSession(order, session) {
  const normalize = (value) => String(value ?? "").trim().toLowerCase();
  const assignedUserId = normalize(order?.assignedStationOperatorUserId);
  if (assignedUserId) return assignedUserId === normalize(session?.user?.id);
  const assignedUsername = normalize(order?.assignedStationOperatorUsername);
  if (assignedUsername) {
    return assignedUsername === normalize(session?.user?.username);
  }
  const assignedDeviceUuid = String(
    order?.assignedStationDeviceUuid ?? "",
  ).trim();
  if (assignedDeviceUuid) {
    return assignedDeviceUuid === String(session?.deviceUuid ?? "").trim();
  }
  const assignedName = normalize(order?.assignedStationOperatorName);
  return !assignedName || assignedName === normalize(session?.user?.fullName);
}

async function performStationWorkflowAction(
  session,
  fallbackOrder,
  workflowStatus,
  fallbackStation,
  options = {},
) {
  const refreshed = await refreshOrderById(session, fallbackOrder);
  const station = String(fallbackStation ?? "").trim() ||
    currentOrderStation(refreshed, fallbackStation);
  if (!station) return null;
  const polled = await pollStationWorkflowOrders(session, station);
  if (!operationSucceeded(polled)) return polled;
  const reservedOrderIds = options.reservedOrderIds instanceof Set
    ? options.reservedOrderIds
    : null;
  const eligibleOrderIds = options.eligibleOrderIds instanceof Set
    ? options.eligibleOrderIds
    : null;
  const fallbackOrderId = String(refreshed?.id ?? fallbackOrder?.id ?? "").trim();
  const polledOrders = Array.isArray(polled?.body?.orders)
    ? polled.body.orders
    : [];
  const orders = filterV5btStationWorkflowCandidates(
    polledOrders.filter((candidate) => stationWorkflowOrderMatchesSession(candidate, session)),
    { fallbackOrderId, eligibleOrderIds, reservedOrderIds },
  );
  const priorities = {
    prep: ["waiting", "prep"],
    ready: ["prep", "ready", "waiting"],
    delivered: ["ready", "delivered", "prep", "waiting"],
  }[workflowStatus] || [workflowStatus];
  const normalizedStatus = (candidate) =>
    String(candidate?.workflowStatus ?? "waiting").trim().toLowerCase();
  const target =
    priorities
      .map((status) => orders.find((candidate) => normalizedStatus(candidate) === status))
      .find(Boolean) ||
    (refreshed?.id &&
    stationWorkflowOrderMatchesSession(refreshed, session) &&
    currentOrderStation(refreshed, station).toLowerCase() === station.toLowerCase()
      ? refreshed
      : null);
  if (!target) {
    await writeEvent({
      event: "station_workflow_no_assigned_order",
      station,
      workflowStatus,
    });
    return { ok: true, skipped: true, reason: "no_assigned_station_order" };
  }
  claimV5btStationWorkflowTarget(target, reservedOrderIds);
  const initialStatus = normalizedStatus(target);
  if (workflowStatus === "prep" && initialStatus === "prep") {
    return { ok: true, skipped: true, reason: "already_in_preparation" };
  }
  const preparingCount = polledOrders.filter(
    (candidate) => normalizedStatus(candidate) === "prep" &&
      currentOrderStation(candidate, station).toLowerCase() === station.toLowerCase(),
  ).length;
  if (workflowStatus === "prep" && preparingCount >= 3) {
    return { ok: true, skipped: true, reason: "preparation_capacity_preserved" };
  }
  const stages =
    workflowStatus === "delivered" && initialStatus === "waiting"
      ? ["prep", "ready", "delivered"]
      : workflowStatus === "delivered" && initialStatus === "prep"
        ? ["ready", "delivered"]
        : workflowStatus === "ready" && initialStatus === "waiting"
          ? ["prep", "ready"]
          : [workflowStatus];
  const results = [];
  for (const stage of stages) {
    const result = await syncOrder(session, target.id, stage, station);
    results.push(result);
    if (stage === "prep" && result?.body?.code === "PREPARATION_QUEUE_FULL") {
      return { ok: true, skipped: true, reason: "preparation_capacity_race", results };
    }
    if (!operationSucceeded(result)) return result;
  }
  return { ok: true, workflowStatus, targetStatus: initialStatus, results };
}

async function correctOrder(session, order) {
  if (!order?.items?.length || !order?.tableId) return null;
  order = await refreshOrderById(session, order);
  if (!order?.items?.length || !order?.tableId) return null;
  const lockedTableId = order.tableId;
  const lock = await lockTableWithRetry(
    session,
    lockedTableId,
    "order.correct",
    { attempts: 6 },
  );
  if (!isLockAcquired(lock)) return lock;
  try {
    order = await refreshOrderById(session, order);
    if (
      !order?.items?.length ||
      !order?.tableId ||
      order.tableId !== lockedTableId
    ) {
      await writeEvent({
        event: "order_correct_skip_table_changed",
        tableId: lockedTableId,
        orderId: order?.id || null,
        nextTableId: order?.tableId || null,
      });
      return null;
    }
    const first =
      order.items.find(
        (item) => !item?.voidedAt && Number(item.qty ?? item.quantity ?? 0) > 0,
      ) || null;
    if (!first) return null;
    const body = {
      tableId: order.tableId,
      roomId: order.roomId,
      orderId: order.id,
      expectedRevision: order.currentRevision || order.revision || 1,
      idempotencyKey: `load-corr-${order.id}-${Date.now()}-${rnd(100000)}`,
    };
    const correctionKind = rnd(4);
    if (correctionKind === 0) {
      body.addedItems = [
        { productId: "menu_caffetteria_cappuccino", quantity: 1 },
      ];
    } else if (correctionKind === 1) {
      body.removedItems = [{ lineId: first.lineId, quantity: 1 }];
    } else if (correctionKind === 2) {
      body.changedItems = [
        {
          lineId: first.lineId,
          nextQuantity: Math.max(
            1,
            Number(first.qty || first.quantity || 1) + 1,
          ),
        },
      ];
    } else {
      body.changedItems = [
        {
          lineId: first.lineId,
          nextQuantity: Math.max(1, Number(first.qty || first.quantity || 1)),
          nextVariant: "Correzione test",
          nextNote: "Nota articolo aggiornata durante preparazione",
          nextUnitPrice: money(
            Math.max(0.1, Number(first.unitPrice ?? first.price ?? 1) + 0.2),
          ),
        },
      ];
      body.nextOrderNote = "Nota comanda aggiornata";
      body.nextOrderComment = "Commento comanda aggiornato";
    }
    const result = await request(
      session,
      "POST",
      "/api/integration/orders/correct",
      body,
      {
        type: "order.correct",
        allow409: true,
        allowStatuses: [404],
        allowResponse: ({ status, body: responseBody }) =>
          status === 400 &&
          String(responseBody?.error ?? "").includes(
            "La comanda non appartiene al tavolo indicato",
          ),
      },
    );
    if (result.status === 400 || result.status === 404) {
      await writeEvent({
        event: "order_correct_skip_table_changed_after_submit",
        tableId: lockedTableId,
        orderId: order.id,
      });
      return null;
    }
    return result;
  } finally {
    await releaseTable(session, lockedTableId);
  }
}

async function compOrder(session, order) {
  if (!order?.items?.length || !order?.tableId) return null;
  order = await refreshOrderById(session, order);
  if (!order?.items?.length || !order?.tableId) return null;
  const lockedTableId = order.tableId;
  const lock = await lockTableWithRetry(session, lockedTableId, "order.comp");
  if (!isLockAcquired(lock)) return lock;
  try {
    order = await refreshOrderById(session, order);
    if (
      !order?.items?.length ||
      !order?.tableId ||
      order.tableId !== lockedTableId
    ) {
      await writeEvent({
        event: "order_comp_skip_table_changed",
        tableId: lockedTableId,
        orderId: order?.id || null,
        nextTableId: order?.tableId || null,
      });
      return null;
    }
    let first =
      order.items.find(
        (item) =>
          !item?.voidedAt &&
          Number(item.qty ?? item.quantity ?? 0) > 0 &&
          (String(item.lineId ?? "").trim() ||
            String(item.productId ?? "").trim()),
      ) || null;
    if (!first) return null;
    const idempotencyKey = `load-comp-${order.id}-${Date.now()}-${rnd(100000)}`;
    const sendReplacement = rnd(2) === 0;
    let expectedRevision = Number(order.revision ?? order.currentRevision ?? 1);
    let result = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      result = await request(
        session,
        "POST",
        "/api/integration/orders/comp",
        {
          tableId: order.tableId,
          roomId: order.roomId,
          orderId: order.id,
          originalLineId: first.lineId,
          productId: first.productId,
          quantity: 1,
          reason: "Load reso/storno",
          sendReplacement,
          expectedRevision,
          idempotencyKey,
        },
        {
          type: "order.comp",
          allow409: true,
          allowStatuses: [404],
          allowResponse: ({ status, body: responseBody }) =>
            status === 400 &&
            [
              "Articolo da rendere non trovato",
              "La comanda non appartiene al tavolo indicato",
            ].some((message) =>
              String(responseBody?.error ?? "").includes(message),
            ),
        },
      );
      if (result?.body?.code !== "REVISION_CONFLICT" || attempt >= 3) break;
      const conflictRevision = Number(result?.body?.details?.currentRevision);
      order = await refreshOrderById(session, order);
      if (!order?.items?.length || order.tableId !== lockedTableId) return null;
      expectedRevision = Number.isFinite(conflictRevision) && conflictRevision > 0
        ? conflictRevision
        : Number(order.revision ?? order.currentRevision ?? expectedRevision);
      first = order.items.find(
        (item) => !item?.voidedAt && Number(item.qty ?? item.quantity ?? 0) > 0 &&
          (String(item.lineId ?? "").trim() || String(item.productId ?? "").trim()),
      ) || null;
      if (!first) return null;
      await sleep(75 * attempt);
    }
    if (result.status === 400 || result.status === 404) {
      const tableChanged = String(result.body?.error ?? "").includes(
        "La comanda non appartiene al tavolo indicato",
      );
      await writeEvent({
        event: tableChanged
          ? "order_comp_skip_table_changed_after_submit"
          : "order_comp_skip_line_changed_after_submit",
        tableId: lockedTableId,
        orderId: order.id,
        lineId: first.lineId || null,
        productId: first.productId || null,
      });
      return null;
    }
    return result;
  } finally {
    await releaseTable(session, lockedTableId);
  }
}

function firstMutableOrderLine(order) {
  return (
    (Array.isArray(order?.items) ? order.items : []).find(
      (item) =>
        !item?.voidedAt &&
        !item?.compedAt &&
        Number(item?.qty ?? item?.quantity ?? 0) > 0 &&
        String(item?.lineId ?? "").trim(),
    ) ?? null
  );
}

async function stornoOrder(session, order) {
  if (!order?.id || !order?.tableId) return null;
  const idempotencyKey = `load-storno-${order.id}-${Date.now()}-${rnd(100000)}`;
  let expectedRevision = 0;
  let result = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    order = await refreshOrderById(session, order);
    if (!order?.id || !order?.tableId) return null;
    if (expectedRevision <= 0) {
      expectedRevision = Number(order.revision ?? order.currentRevision ?? 1);
    }
    const lockedTableId = order.tableId;
    const lock = await lockTableWithRetry(session, lockedTableId, "order.storno");
    if (!isLockAcquired(lock)) result = lock;
    else {
      try {
        order = await refreshOrderById(session, order);
        if (!order?.id || order.tableId !== lockedTableId) return null;
        const line = firstMutableOrderLine(order);
        if (!line) return null;
        result = await request(
          session,
          "POST",
          "/api/integration/orders/storno",
          {
            orderId: order.id,
            tableId: order.tableId,
            roomId: order.roomId,
            originalLineId: line.lineId,
            productId: line.productId,
            quantity: 1,
            reason: "Storno simulazione operativa V5BT",
            expectedRevision,
            idempotencyKey,
          },
          {
            type: "order.storno",
            allow409: true,
            allowStatuses: [404],
            allowResponse: ({ status, body }) =>
              status === 400 &&
              /non appartiene|non trovato|non disponibile/iu.test(
                String(body?.error ?? ""),
              ),
          },
        );
      } finally {
        await releaseTable(session, lockedTableId);
      }
    }
    const revisionConflict = result?.body?.code === "REVISION_CONFLICT";
    if (revisionConflict) {
      const conflictRevision = Number(result?.body?.details?.currentRevision);
      if (Number.isFinite(conflictRevision) && conflictRevision > 0) {
        expectedRevision = conflictRevision;
      }
    }
    if ((!isTransientTableLockConflict(result) && !revisionConflict) || attempt >= 3) return result;
    await sleep(100 + attempt * 100);
  }
  return result;
}

async function barReplacementOrder(session, order) {
  if (!order?.id || !order?.tableId) return null;
  const idempotencyKey = `load-bar-replacement-${order.id}-${Date.now()}-${rnd(100000)}`;
  let result = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    order = await refreshOrderById(session, order);
    if (!order?.id || !order?.tableId) return null;
    const lockedTableId = order.tableId;
    const lock = await lockTableWithRetry(
      session,
      lockedTableId,
      "order.bar_replacement",
    );
    if (!isLockAcquired(lock)) {
      result = lock;
    } else {
      try {
        order = await refreshOrderById(session, order);
        if (!order?.id || order.tableId !== lockedTableId) return null;
        const line = firstMutableOrderLine(order);
        if (!line) return null;
        result = await request(
          session,
          "POST",
          "/api/integration/orders/replacement/bar-charge",
          {
            orderId: order.id,
            tableId: order.tableId,
            roomId: order.roomId,
            originalLineId: line.lineId,
            productId: line.productId,
            quantity: 1,
            reason: "Sostituzione addebito banco simulazione V5BT",
            idempotencyKey,
          },
          {
            type: "order.bar_replacement",
            allow409: true,
            allowStatuses: [404],
          },
        );
      } finally {
        await releaseTable(session, lockedTableId);
      }
    }
    if (!isTransientTableLockConflict(result) || attempt >= 3) return result;
    await sleep(100 + attempt * 100);
  }
  return result;
}

async function splitOrderLine(session, order) {
  if (!order?.id || !order?.tableId) return null;
  let result = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    order = await refreshOrderById(session, order);
    if (!order?.id || !order?.tableId) return null;
    const lockedTableId = order.tableId;
    const lock = await lockTableWithRetry(
      session,
      lockedTableId,
      "order.line_split",
      { attempts: 6 },
    );
    if (!isLockAcquired(lock)) {
      result = lock;
    } else {
      try {
        order = await refreshOrderById(session, order);
        if (!order?.id || order.tableId !== lockedTableId) return null;
        const line = firstMutableOrderLine(order);
        if (!line) return null;
        result = await request(
          session,
          "POST",
          "/api/integration/orders/line/split",
          {
            orderId: order.id,
            tableId: order.tableId,
            roomId: order.roomId,
            lineId: line.lineId,
            qty: 1,
            markDelivered: false,
            expectedRevision: order.revision ?? order.currentRevision ?? 1,
          },
          {
            type: "order.line_split",
            allow409: true,
            allowStatuses: [404],
          },
        );
      } finally {
        await releaseTable(session, lockedTableId);
      }
    }
    const revisionConflict = result?.body?.code === "REVISION_CONFLICT";
    if (!isTransientTableLockConflict(result) && !revisionConflict) {
      return result;
    }
    if (attempt < 5) await sleep(attempt * 250);
  }
  return result;
}

async function overrideOrderLinePrice(session, order, options = {}) {
  if (!order?.id || !order?.tableId) return null;
  order = await refreshOrderById(session, order);
  if (!order?.id || !order?.tableId) return null;
  const lockedTableId = order.tableId;
  const line = firstMutableOrderLine(order);
  if (!line) return null;
  const nextPrice = money(
    Math.max(0.1, Number(line.unitPrice ?? line.price ?? 1) + 0.1),
  );
  const expectedRevision = Number(order.revision ?? order.currentRevision ?? 1);
  const logicalActionId =
    String(options.logicalActionId ?? "").trim() ||
    `${runId}:mobile:order.price_override:${order.id}:${line.lineId}:${expectedRevision}`;
  const idempotencyKey =
    String(options.idempotencyKey ?? "").trim() ||
    `load-price-override-${createHash("sha256")
      .update(logicalActionId)
      .digest("hex")
      .slice(0, 32)}`;
  const requestBody = Object.freeze({
    orderId: order.id,
    lineId: line.lineId,
    unitPriceApplied: nextPrice,
    listPriceAtTime: Number(line.unitPrice ?? line.price ?? nextPrice),
    reason: "Cambio prezzo simulazione operativa V5BT",
    expectedRevision,
    idempotencyKey,
  });

  return runV5btMobileBusinessActionRetry({
    actionType: "order.price_override",
    logicalActionId,
    idempotencyKey,
    attempt: async ({ idempotencyKey: stableIdempotencyKey }) => {
      if (stableIdempotencyKey !== requestBody.idempotencyKey) {
        throw new Error("La chiave idempotente dell'override prezzo e cambiata.");
      }
      const lock = await lockTableWithRetry(
        session,
        lockedTableId,
        "order.price_override",
      );
      if (!isLockAcquired(lock)) return lock;
      try {
        const currentOrder = await refreshOrderById(session, order);
        if (!currentOrder?.id || currentOrder.tableId !== lockedTableId) return null;
        const currentLine = (Array.isArray(currentOrder.items)
          ? currentOrder.items
          : []
        ).find(
          (candidate) =>
            candidate?.lineId === requestBody.lineId &&
            !candidate?.voidedAt &&
            !candidate?.compedAt,
        );
        if (!currentLine) return null;
        return request(
          session,
          "POST",
          "/api/integration/orders/line/price-override",
          requestBody,
          {
            type: "order.price_override",
            allow409: true,
            allowStatuses: [404],
          },
        );
      } finally {
        await releaseTable(session, lockedTableId);
      }
    },
    wait: sleep,
    onRetry: ({ attempt, delayMs, status, code }) =>
      writeEvent({
        event: "v5bt_mobile_action_table_lock_retry",
        actionType: "order.price_override",
        attempt,
        delayMs,
        status,
        code,
      }),
  });
}

async function payOrder(session, order, options = {}) {
  if (!order?.tableId) return null;
  order = await refreshOrderById(session, order);
  if (!order?.tableId) return null;
  const lockedTableId = order.tableId;
  const lock = await lockTableWithRetry(
    session,
    lockedTableId,
    "payment.free_split",
  );
  if (!isLockAcquired(lock)) return lock;
  let lockHeld = true;
  try {
    order = await refreshOrderById(session, order);
    if (!order?.tableId || order.tableId !== lockedTableId) {
      await writeEvent({
        event: "payment_skip_table_changed",
        tableId: lockedTableId,
        orderId: order?.id || null,
        nextTableId: order?.tableId || null,
      });
      return null;
    }
    const splitMode =
      options.splitMode || (options.partial ? "amount" : "single");
    let articleSelection =
      splitMode === "article" ? firstPayableOrderArticleUnit(order) : null;
    if (splitMode === "article" && !articleSelection) {
      await writeEvent({
        event: "payment_skip_no_payable_article",
        tableId: lockedTableId,
        orderId: order.id,
      });
      return null;
    }
    const resolveAmount = () =>
      money(
        articleSelection?.amount ||
          options.amount ||
          Math.max(
            0.5,
            Number(order.dueAmount || order.total || 1) *
              (options.partial ? 0.5 : 1),
          ),
      );
    let amount = resolveAmount();
    const method = options.method || (rnd(4) === 0 ? "POS" : "CASH");
    const buildTransaction = () => ({
      method,
      methodId: method === "POS" ? "pay_card" : "pay_cash",
      methodLabel: method === "POS" ? "Carta" : "Contanti",
      amountPaid: amount,
      cashGiven:
        method === "CASH" ? amount + (rnd(3) === 0 ? 5 : 0) : undefined,
      posProvider: method === "POS" ? "mock-load" : undefined,
      posTxRef:
        method === "POS" ? `LOAD-POS-${order.id}-${Date.now()}` : undefined,
      note: options.note || "nota pagamento load",
      automaticCashOperationId: options.automaticCashOperationId,
    });
    const baseIdempotencyKey =
      options.idempotencyKey ||
      `load-pay-${order.id}-${Date.now()}-${rnd(100000)}`;
    const paymentType =
      options.type ||
      (options.issueFiscal
        ? "payment.free_split.rt"
        : options.adminAdjustment
          ? "payment.free_split.adjusted"
          : "payment.free_split");
    const buildBody = (retrySuffix = "") => ({
      tableId: order.tableId,
      roomId: order.roomId,
      orderId: order.id,
      splitType: "FREE_SPLIT",
      splitMode,
      articleUnitIds: articleSelection ? [articleSelection.unitId] : undefined,
      idempotencyKey: `${baseIdempotencyKey}${retrySuffix}`,
      releaseTable: options.releaseTable ?? !options.partial,
      note: options.note || "nota pagamento load",
      issueFiscal: options.issueFiscal === true,
      fiscalDocType: options.issueFiscal ? "RECEIPT" : undefined,
      fiscalDeviceId: options.issueFiscal ? "rt_load_real" : undefined,
      adminAdjustment: options.adminAdjustment,
      parts: [{ amountDue: amount, transactions: [buildTransaction()] }],
    });
    if (options.issueFiscal) recorder.rtFiscalAttempts += 1;
    let result = await request(
      session,
      "POST",
      "/api/payments/free-split",
      buildBody(),
      {
        type: paymentType,
        allow409: true,
        allow428: true,
        allowResponse: (response) =>
          splitMode === "article" &&
          isStalePaymentArticleSelectionResponse(response),
      },
    );
    if (
      splitMode === "article" &&
      isStalePaymentArticleSelectionResponse(result)
    ) {
      await writeEvent({
        event: "payment_article_selection_refresh_retry",
        tableId: lockedTableId,
        orderId: order.id,
        staleUnitId: articleSelection?.unitId ?? null,
      });
      order = await refreshOrderById(session, order);
      if (!order?.tableId || order.tableId !== lockedTableId) {
        await writeEvent({
          event: "payment_article_retry_skip_table_changed",
          tableId: lockedTableId,
          orderId: order?.id || null,
          nextTableId: order?.tableId || null,
        });
        return null;
      }
      articleSelection = firstPayableOrderArticleUnit(order);
      if (!articleSelection) {
        await writeEvent({
          event: "payment_article_retry_skip_no_payable_article",
          tableId: lockedTableId,
          orderId: order.id,
        });
        return null;
      }
      amount = resolveAmount();
      result = await request(
        session,
        "POST",
        "/api/payments/free-split",
        buildBody(":article-refresh1"),
        {
          type: `${paymentType}.article_refresh_retry`,
          allow409: true,
          allow428: true,
        },
      );
    }
    if (result.status === 428 && options.retryOnLockLost !== false) {
      let heartbeatProbe = null;
      if (paymentLockDiagnosticsEnabled) {
        heartbeatProbe = await request(
          session,
          "POST",
          "/api/tables/lock/heartbeat",
          {
            tableId: lockedTableId,
            purpose: "payment.free_split.diagnostic",
          },
          {
            type: "payment.lock.diagnostic",
            allow409: true,
            allowStatuses: [403, 428],
            record: false,
          },
        );
      }
      await writeEvent({
        event: "payment_lock_retry",
        tableId: order.tableId,
        orderId: order.id,
        paymentType,
        acquiredLock: lock.body?.lock ?? null,
        paymentError: result.body ?? null,
        heartbeatProbe: heartbeatProbe
          ? { status: heartbeatProbe.status, body: heartbeatProbe.body }
          : null,
      });
      await releaseTable(session, lockedTableId);
      lockHeld = false;
      await sleep(150 + rnd(250));
      const retryLock = await lockTable(
        session,
        lockedTableId,
        "payment.free_split.retry",
      );
      if (!isLockAcquired(retryLock)) return retryLock;
      lockHeld = true;
      order = await refreshOrderById(session, order);
      if (!order?.tableId || order.tableId !== lockedTableId) {
        await writeEvent({
          event: "payment_retry_skip_table_changed",
          tableId: lockedTableId,
          orderId: order?.id || null,
          nextTableId: order?.tableId || null,
        });
        return null;
      }
      if (splitMode === "article") {
        articleSelection = firstPayableOrderArticleUnit(order);
        if (!articleSelection) {
          await writeEvent({
            event: "payment_retry_skip_no_payable_article",
            tableId: lockedTableId,
            orderId: order.id,
          });
          return null;
        }
        amount = resolveAmount();
      }
      result = await request(
        session,
        "POST",
        "/api/payments/free-split",
        buildBody(":retry1"),
        {
          type: `${paymentType}.retry`,
          allow409: true,
        },
      );
      if (paymentLockDiagnosticsEnabled && result.status === 428) {
        await writeEvent({
          event: "payment_lock_retry_failed",
          tableId: lockedTableId,
          orderId: order.id,
          paymentType,
          retryLock: retryLock.body?.lock ?? null,
          paymentError: result.body ?? null,
        });
      }
    }
    if (options.issueFiscal && result.status >= 200 && result.status < 300)
      recorder.rtFiscalSuccess += 1;
    return result;
  } finally {
    if (lockHeld) await releaseTable(session, lockedTableId);
  }
}

async function printOrder(
  session,
  order,
  kind = "preconto",
  printerOverride = null,
) {
  if (!order?.id) return null;
  order = await refreshOrderById(session, order);
  if (!order?.id) return null;
  const printer =
    printerOverride ||
    printerForStationName(
      order.station ||
        order.assignedStationId ||
        order.ownerStation ||
        activeStationNames[rnd(activeStationNames.length)],
    );
  return request(
    session,
    "POST",
    "/api/integration/print",
    {
      kind,
      orderId: order.id,
      tableId: order.tableId,
      roomId: order.roomId,
      printerId: printer.id,
      tablePrecontoMode:
        kind === "preconto" ? (rnd(2) ? "current" : "complete") : undefined,
    },
    { type: `print.${kind}`, allow409: true, allowStatuses: [404] },
  );
}

async function moveTable(session, from, to) {
  if (!from?.id || !to?.id || from.id === to.id) return null;
  let result = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const sourceLock = await lockTable(session, from.id, "table.move_source");
    const targetLock = await lockTable(session, to.id, "table.move_target");
    if (!isLockAcquired(sourceLock) || !isLockAcquired(targetLock)) {
      if (isLockAcquired(sourceLock)) await releaseTable(session, from.id);
      if (isLockAcquired(targetLock)) await releaseTable(session, to.id);
      return isLockAcquired(sourceLock) ? targetLock : sourceLock;
    }
    try {
      result = await request(
        session,
        "POST",
        "/api/integration/layout/table/move",
        {
          fromTableId: from.id,
          toTableId: to.id,
        },
        { type: "table.move", allow409: true },
      );
    } finally {
      await releaseTable(session, from.id);
      await releaseTable(session, to.id);
    }
    const revisionConflict =
      result?.status === 409 &&
      result?.body?.code === "RELATIONAL_TABLE_MOVE_TABLE_REVISION_CONFLICT";
    if (!revisionConflict || attempt >= 4) return result;
    await writeEvent({
      event: "v5bt_table_move_revision_retry",
      attempt,
      fromTableId: from.id,
      toTableId: to.id,
    });
    await sleep(150 + attempt * 150);
  }
  return result;
}

async function roomMoveRequest(session, from, to) {
  return request(
    session,
    "POST",
    "/api/integration/layout/table/room-move/request",
    {
      fromRoomId: from.roomId,
      fromRoomName: from.roomId,
      targetRoomId: to.roomId,
      fromTableId: from.id,
      fromTableLabel: String(from.number),
      targetTableIds: [to.id],
      targetTableLabels: [String(to.number)],
    },
    { type: "table.room_move.request", allow409: true },
  );
}

async function reservationFlow(session, table, options = {}) {
  const requestedReservationAt = Number(options.reservationAt);
  const reservationAt = Number.isFinite(requestedReservationAt)
    ? requestedReservationAt
    : Date.now() + (60 + rnd(240)) * 60_000;
  const serviceDate = localDateKey(new Date(reservationAt));
  const create = await request(
    session,
    "POST",
    "/api/pos/reservations/create",
    {
      roomId: table.roomId,
      serviceDate,
      reservationAt,
      customerName: `Cliente load ${rnd(10000)}`,
      customerPhone: `333${String(rnd(9999999)).padStart(7, "0")}`,
      covers: 1 + rnd(6),
      assignedTableId: table.id,
      assignedTableIds: [table.id],
      note: "prenotazione load",
    },
    { type: "reservation.create", allow409: true },
  );
  const id = create.body?.reservation?.id;
  if (!id) return create;
  const action = pick(["arrived", "no_show", "cancelled"]);
  return request(
    session,
    "POST",
    "/api/pos/reservations/status",
    {
      roomId: table.roomId,
      serviceDate,
      reservationId: id,
      action,
    },
    { type: `reservation.status.${action}`, allow409: true },
  );
}

async function roomChange(session, targetRoomId, options = {}) {
  const result = await request(
    session,
    "POST",
    "/api/pos/room-change/request",
    {
      targetRoomId,
    },
    {
      type: ({ status, body }) =>
        status === 200 && body?.status === "pending"
          ? "room.change.request.pending"
          : status === 200 && body?.direct === true
            ? "room.change.request.direct"
            : "room.change.request.other",
      allow409: true,
      allowStatuses: options.expectDenied ? [403] : [],
    },
  );
  if (options.expectDenied) {
    return {
      ...result,
      businessOk: result.status === 403,
    };
  }
  if (result.body?.status === "pending" && result.body?.requestId) {
    await request(
      session,
      "POST",
      "/api/pos/room-change/approve",
      {
        requestId: result.body.requestId,
        approverUsername: "admin_load",
        approverPin: "1111",
      },
      { type: "room.change.approve", allow409: true },
    );
  }
  return result;
}

async function runRoomChangeBranchProbes(
  session,
  profileStartedAt,
  deadlineAt,
) {
  if (!session || ROOM_CHANGE_BRANCH_PROBES <= 0) return [];
  const outcomes = [];
  for (let index = 0; index < ROOM_CHANGE_BRANCH_PROBES; index += 1) {
    const offsetMs = Math.round(
      (REALISTIC_DURATION_MS * (index + 1)) / (ROOM_CHANGE_BRANCH_PROBES + 1),
    );
    if (!(await waitUntilProfileTime(profileStartedAt, offsetMs, deadlineAt)))
      break;
    const pending = await roomChange(session, "room_sala");
    const direct = await roomChange(session, "room_pedana");
    const ok =
      pending?.body?.status === "pending" && direct?.body?.direct === true;
    outcomes.push({ pending, direct, ok });
    recorder.cover("room.change.branch_probe", ok, {
      index: index + 1,
      pendingStatus: pending?.status ?? null,
      pendingBranch: pending?.body?.status ?? null,
      directStatus: direct?.status ?? null,
      directBranch: direct?.body?.direct === true ? "direct" : null,
    });
  }
  return outcomes;
}

async function waiterPause(session, active, options = {}) {
  return request(
    session,
    "POST",
    active ? "/api/mobile/waiter-pause/start" : "/api/mobile/waiter-pause/stop",
    {
      roomId: session.auth.roomId,
      roomName: session.auth.roomName,
      clientApp: "mobile-frontend",
    },
    {
      type:
        options.type ?? (active ? "waiter.pause.start" : "waiter.pause.stop"),
      allow409: options.allow409 ?? true,
    },
  );
}

async function waiterPauseStatus(session, options = {}) {
  return request(
    session,
    "POST",
    "/api/mobile/waiter-pause/status",
    {
      roomId: session.auth.roomId,
      roomName: session.auth.roomName,
      clientApp: "mobile-frontend",
    },
    { type: options.type ?? "waiter.pause.status" },
  );
}

async function runWaiterPauseProbes(session, profileStartedAt, deadlineAt) {
  if (!session || WAITER_PAUSE_PROBES <= 0) return [];
  const outcomes = [];
  for (let index = 0; index < WAITER_PAUSE_PROBES; index += 1) {
    const offsetMs = Math.round(
      (REALISTIC_DURATION_MS * (index + 1)) / (WAITER_PAUSE_PROBES + 1),
    );
    if (!(await waitUntilProfileTime(profileStartedAt, offsetMs, deadlineAt)))
      break;

    const starts = await Promise.all([
      waiterPause(session, true, { type: "waiter.pause.probe.start" }),
      waiterPause(session, true, { type: "waiter.pause.probe.start" }),
    ]);
    const status = await waiterPauseStatus(session, {
      type: "waiter.pause.probe.status_paused",
    });
    const stops = await Promise.all([
      waiterPause(session, false, { type: "waiter.pause.probe.stop" }),
      waiterPause(session, false, { type: "waiter.pause.probe.stop" }),
    ]);
    const ok =
      starts.every(
        (entry) => entry.status === 200 && entry.body?.pause?.active === true,
      ) &&
      status.status === 200 &&
      status.body?.pause?.active === true &&
      stops.every(
        (entry) => entry.status === 200 && entry.body?.pause?.active === false,
      );
    const outcome = {
      index: index + 1,
      ok,
      startStatuses: starts.map((entry) => entry.status),
      startActive: starts.map((entry) => entry.body?.pause?.active ?? null),
      statusStatus: status.status,
      statusActive: status.body?.pause?.active ?? null,
      stopStatuses: stops.map((entry) => entry.status),
      stopActive: stops.map((entry) => entry.body?.pause?.active ?? null),
      proxyRoles: {
        start: starts.map((entry) => entry.proxyRole || null),
        status: status.proxyRole || null,
        stop: stops.map((entry) => entry.proxyRole || null),
      },
    };
    outcomes.push(outcome);
    recorder.cover("waiter.pause.concurrent_idempotency_probe", ok, outcome);
  }
  return outcomes;
}

async function runPaymentFreeSplitProbes(
  session,
  profileStartedAt,
  deadlineAt,
) {
  if (!session || PAYMENT_FREE_SPLIT_PROBES <= 0) return [];
  const outcomes = [];
  for (let index = 0; index < PAYMENT_FREE_SPLIT_PROBES; index += 1) {
    const offsetMs = Math.round(
      (REALISTIC_DURATION_MS * (index + 1)) / (PAYMENT_FREE_SPLIT_PROBES + 1),
    );
    if (!(await waitUntilProfileTime(profileStartedAt, offsetMs, deadlineAt)))
      break;

    const tableNumber = index + 1;
    const table = {
      id: `room_attesa_virtuale_t${String(tableNumber).padStart(2, "0")}`,
      roomId: "room_attesa_virtuale",
      number: tableNumber,
    };
    const created = await createOrder(session, table, {
      source: "payment-free-split-probe",
      note: `payment free split probe ${index + 1}`,
      lines: [lineFromCatalog((index % 3) + 1)],
    });
    const order = created.body?.order ?? null;
    const station =
      order?.assignedStationId ||
      order?.ownerStation ||
      order?.station ||
      activeStationNames[0];
    const ready = order
      ? await syncOrder(session, order.id, "ready", station)
      : null;
    const delivered = order
      ? await syncOrder(session, order.id, "delivered", station)
      : null;
    const paid = order
      ? await payOrder(session, order, {
          method: "CASH",
          releaseTable: true,
          retryOnLockLost: false,
          type: "payment.free_split.probe",
          idempotencyKey: `payment-free-split-probe-${runId}-${index + 1}`,
        })
      : null;
    const ok =
      created.status === 200 &&
      ready?.status === 200 &&
      delivered?.status === 200 &&
      paid?.status === 200 &&
      paid?.body?.ok === true &&
      paid?.body?.relational?.writePrimary === true;
    const outcome = {
      index: index + 1,
      ok,
      tableId: table.id,
      orderId: order?.id ?? null,
      paymentId: paid?.body?.payment?.id ?? null,
      statuses: {
        create: created.status,
        ready: ready?.status ?? null,
        delivered: delivered?.status ?? null,
        payment: paid?.status ?? null,
      },
      codes: {
        create: created.body?.code ?? null,
        ready: ready?.body?.code ?? null,
        delivered: delivered?.body?.code ?? null,
        payment: paid?.body?.code ?? null,
      },
      station,
      paymentDurationMs: paid?.durationMs ?? null,
      paymentProxyRole: paid?.proxyRole ?? null,
    };
    outcomes.push(outcome);
    recorder.cover("payment.free_split.success_probe", ok, outcome);
    if (!ok) {
      recorder.failures.push({
        at: nowIso(),
        type: "payment.free_split.success_probe",
        status: paid?.status ?? 0,
        detail: outcome,
      });
    }
  }
  return outcomes;
}

async function cancelOrder(session, order) {
  if (!order?.id || !order?.tableId) return null;
  order = await refreshOrderById(session, order);
  if (!order?.id || !order?.tableId) return null;
  const lockedTableId = order.tableId;
  const lock = await lockTableWithRetry(session, lockedTableId, "order.cancel");
  if (!isLockAcquired(lock)) return lock;
  try {
    order = await refreshOrderById(session, order);
    if (!order?.id || !order?.tableId || order.tableId !== lockedTableId) {
      await writeEvent({
        event: "order_cancel_skip_table_changed",
        tableId: lockedTableId,
        orderId: order?.id || null,
        nextTableId: order?.tableId || null,
      });
      return null;
    }
    const result = await request(
      session,
      "POST",
      "/api/integration/orders/cancel",
      {
        tableId: order.tableId,
        roomId: order.roomId,
        orderId: order.id,
        expectedRevision: order.currentRevision || order.revision || 1,
        reason: "Annullamento scenario realistico",
        idempotencyKey: `load-cancel-${order.id}-${Date.now()}-${rnd(100000)}`,
      },
      {
        type: "order.cancel",
        allow409: true,
        allowStatuses: [404],
        allowResponse: ({ status, body: responseBody }) =>
          status === 400 &&
          String(responseBody?.error ?? "").includes(
            "La comanda non appartiene al tavolo indicato",
          ),
      },
    );
    if (result.status === 400 || result.status === 404) {
      await writeEvent({
        event: "order_cancel_skip_table_changed_after_submit",
        tableId: lockedTableId,
        orderId: order.id,
      });
      return null;
    }
    return result;
  } finally {
    await releaseTable(session, lockedTableId);
  }
}

async function syncTableDetails(session, table, options = {}) {
  const lock = await lockTableWithRetry(session, table.id, "table.sync");
  if (!isLockAcquired(lock)) return lock;
  try {
    return request(
      session,
      "POST",
      "/api/integration/layout/table/sync",
      {
        tableId: table.id,
        roomId: table.roomId,
        tableNumber: table.number,
        occupancyState: options.occupancyState || (rnd(2) ? "seated" : "free"),
        covers: options.covers ?? 1 + rnd(8),
        note: options.note || `Nota tavolo ${table.number}`,
        guestName: options.guestName || `Cliente Tavolo ${table.number}`,
        customerName: options.guestName || `Cliente Tavolo ${table.number}`,
        customerPhone: `333${String(rnd(10_000_000)).padStart(7, "0")}`,
      },
      { type: "table.sync", allow409: true },
    );
  } finally {
    await releaseTable(session, table.id);
  }
}

async function saveTableGroup(session, first, second, clear = false) {
  return request(
    session,
    "POST",
    "/api/integration/table-groups/save",
    {
      groups: clear
        ? []
        : [
            {
              id: first.id,
              type: "complex",
              children: [
                { id: first.id, type: "simple" },
                { id: second.id, type: "simple" },
              ],
            },
          ],
    },
    { type: clear ? "table.group.split" : "table.group.merge", allow409: true },
  );
}

async function publishNotification(session, table, kind = "waiter") {
  const ready = kind === "ready";
  return request(
    session,
    "POST",
    "/api/integration/notifications/publish",
    {
      type: ready ? "order_ready" : "waiter",
      title: ready ? "Comanda pronta loadtest" : "Chiamata cameriere loadtest",
      description: ready
        ? `Comanda pronta tavolo ${table.number}`
        : `Chiamata dal tavolo ${table.number}`,
      meta: {
        eventType: ready ? "order_ready" : "waiter_call",
        tableId: table.id,
        roomId: table.roomId,
        tableNumber: table.number,
        targetRoomId: table.roomId,
      },
    },
    {
      type: ready ? "notification.ready" : "notification.waiter",
      allow409: true,
    },
  );
}

async function setMenuItemAvailability(session, itemName, enabled) {
  return request(
    session,
    "POST",
    "/api/actions",
    {
      type: enabled ? "item_enable" : "item_disable",
      itemName,
      scope: "global",
      station: activeStationNames[0],
    },
    {
      type: enabled ? "menu.item.enable" : "menu.item.disable",
      allow409: true,
    },
  );
}

async function readSettingsAndSearch(session, ordinal = 0) {
  const variant = ordinal % 8;
  if (variant === 0)
    return request(
      session,
      "POST",
      "/api/menu/catalog",
      { query: "k " },
      { type: "search.menu.k_space" },
    );
  if (variant === 1)
    return request(
      session,
      "POST",
      "/api/settings/pos",
      {},
      { type: "settings.pos" },
    );
  if (variant === 2)
    return request(
      session,
      "POST",
      "/api/settings/user/payment-preferences",
      {},
      { type: "settings.payment_preferences" },
    );
  if (variant === 3)
    return request(
      session,
      "POST",
      "/api/mobile/radio/config",
      {},
      { type: "settings.radio" },
    );
  if (variant === 4)
    return request(
      session,
      "GET",
      "/api/mobile/battery",
      { deviceUuid: session.deviceUuid },
      { type: "battery.get" },
    );
  if (variant === 5)
    return request(
      session,
      "POST",
      "/api/reports/sales",
      {},
      { type: "history.payments" },
    );
  if (variant === 6)
    return request(
      session,
      "POST",
      "/api/audit/events",
      { limit: 100 },
      { type: "history.station_audit" },
    );
  return request(
    session,
    "GET",
    "/api/integration/orders",
    { includeDone: "1", search: "k " },
    { type: "search.orders" },
  );
}

async function collectCounterOrder(session, ordinal = 0) {
  const amountCents = 130 + (ordinal % 4) * 30;
  const paymentMethod = ordinal % 2 === 0 ? "cash" : "card";
  return request(
    session,
    "POST",
    "/api/tables/counter/orders/collect",
    {
      context: "counter",
      roomId: session.auth.roomId,
      tableId: "counter:banco",
      tableLabel: "Banco",
      idempotencyKey: `load-counter-${session.deviceUuid}-${ordinal}-${Date.now()}`,
      clientPaymentId: `load-counter-${session.deviceUuid}-${ordinal}-${Date.now()}`,
      operator: {
        userId: session.user.id,
        username: session.user.username,
        fullName: session.user.fullName,
        label: session.user.fullName,
      },
      order: {
        id: `counter_load_${session.deviceUuid}_${Date.now()}_${ordinal}`,
        title: "Ordine Banco",
        createdAt: Date.now(),
        totalCents: amountCents,
        lines: [
          {
            lineId: `counter_line_${ordinal}`,
            productId: "menu_caffetteria_caffe",
            name: "Caffe Banco",
            qty: 1,
            unitFinalPrice: amountCents / 100,
            lineTotal: amountCents / 100,
            vatRate: 10,
            vatCode: "10",
            note: "Nota articolo Banco",
          },
        ],
      },
      payment: {
        amountCents,
        method: paymentMethod,
        splitMode: "single",
        receiptType: ordinal % 3 === 0 ? "non_fiscale" : "scontrino",
        note: "Pagamento Banco realistico",
      },
    },
    { type: `counter.collect.${paymentMethod}`, allow409: true },
  );
}

async function forceTransferOrder(session, order, targetStation) {
  if (!order?.id) return null;
  return request(
    session,
    "POST",
    "/api/integration/orders/transfer/force",
    {
      orderId: order.id,
      fromStation: order.station || order.ownerStation || activeStationNames[0],
      toStation: targetStation,
      targetStation,
      reason: "Trasferimento scenario realistico",
    },
    { type: "order.transfer.force", allow409: true, allowStatuses: [404] },
  );
}

async function requestAndResolveOrderTransfer(session, order, targetStation) {
  if (!order?.id) return null;
  order = await refreshOrderById(session, order);
  if (!order?.id) return null;
  const selectTarget = (current) => {
    const owner = currentOrderStation(current, activeStationNames[0]);
    return [targetStation, ...activeStationNames].find(
      (candidate) =>
        String(candidate ?? "").trim() &&
        String(candidate).trim().toLocaleUpperCase("it-IT") !==
          owner.toLocaleUpperCase("it-IT"),
    );
  };
  const idempotencyKey = `load-transfer-request-${order.id}-${Date.now()}-${rnd(100000)}`;
  let safeTarget = selectTarget(order);
  let requestRevision = Number(order.revision ?? order.currentRevision ?? 1);
  if (!safeTarget) return null;
  const sendRequest = (current, expectedRevision) =>
    request(
      session,
      "POST",
      "/api/integration/orders/transfer/request",
      {
        orderId: current.id,
        mode: "transfer",
        requesterStation: safeTarget,
        targetStation: safeTarget,
        requesterOperator: session.user.fullName,
        requesterRole: session.user.roleLabel,
        expectedRevision,
        idempotencyKey,
      },
      {
        type: "order.transfer.request",
        allow409: true,
        allowStatuses: [404],
      },
    );
  let requested = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    requested = await sendRequest(order, requestRevision);
    if (requested?.body?.code !== "REVISION_CONFLICT" || attempt >= 3) break;
    const conflictRevision = Number(requested?.body?.details?.currentRevision);
    order = await refreshOrderById(session, order);
    safeTarget = selectTarget(order);
    if (!safeTarget) return null;
    requestRevision = Number.isFinite(conflictRevision) && conflictRevision > 0
      ? conflictRevision
      : Number(order.revision ?? order.currentRevision ?? requestRevision);
    await sleep(75 * attempt);
  }
  if (!operationSucceeded(requested)) return requested;
  let pendingOrder =
    requested.body?.order ?? (await refreshOrderById(session, order));
  let resolveRevision = Number(
    pendingOrder?.revision ?? pendingOrder?.currentRevision ?? requestRevision + 1,
  );
  const sendResolve = (current, expectedRevision) => {
    const pending = current?.pendingAuthRequest ?? {};
    return request(
      session,
      "POST",
      "/api/integration/orders/transfer/resolve",
      {
        orderId: current?.id ?? order.id,
        approve: true,
        approverStation: pending.fromStation ?? currentOrderStation(order),
        approverOperator: session.user.fullName,
        expectedRevision,
      },
      {
        type: "order.transfer.resolve",
        allow409: true,
        allowStatuses: [404],
      },
    );
  };
  let resolved = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    resolved = await sendResolve(pendingOrder, resolveRevision);
    if (resolved?.body?.code !== "REVISION_CONFLICT" || attempt >= 3) break;
    const conflictRevision = Number(resolved?.body?.details?.currentRevision);
    pendingOrder = await refreshOrderById(session, pendingOrder);
    if (!pendingOrder?.pendingAuthRequest) break;
    resolveRevision = Number.isFinite(conflictRevision) && conflictRevision > 0
      ? conflictRevision
      : Number(pendingOrder.revision ?? pendingOrder.currentRevision ?? resolveRevision);
    await sleep(75 * attempt);
  }
  if (
    !operationSucceeded(resolved) &&
    /Nessuna richiesta di trasferimento pendente/i.test(
      String(resolved?.body?.error ?? resolved?.body?.message ?? ""),
    )
  ) {
    const reconciledOrder = await refreshOrderById(session, pendingOrder);
    if (
      reconciledOrder?.id &&
      currentOrderStation(reconciledOrder).toLocaleUpperCase("it-IT") ===
        safeTarget.toLocaleUpperCase("it-IT")
    ) {
      return { ok: true, requested, resolved, reconciled: true };
    }
  }
  if (!operationSucceeded(resolved)) return resolved;
  return {
    ok: true,
    requested,
    resolved,
  };
}

async function reprintPaymentMovement(session, paymentId) {
  if (!paymentId) return null;
  return request(
    session,
    "POST",
    "/api/reports/payment-movement/reprint",
    {
      type: "payment",
      recordId: `payment:${paymentId}`,
      movementId: paymentId,
      clientApp: "mobile-frontend",
    },
    { type: "payment.reprint", allow409: true, allowStatuses: [404] },
  );
}

async function openHandheldCashSession(session, cashFloat = 10) {
  return request(
    session,
    "POST",
    "/api/reports/handheld-session/cash/open",
    {
      cashFloat,
      posId: "mock-pos-load",
      activityId: "activity_default",
      roomId: session.auth.roomId,
      roomName: session.auth.roomName,
      sessionStartedAt: Date.now(),
    },
    { type: "handheld.cash.open", allow409: true },
  );
}

async function closeHandheldCashSession(session, cashFloat = 10) {
  const completedAtMs = Date.now();
  return request(
    session,
    "POST",
    "/api/reports/handheld-session/cash/close",
    {
      cashFloat,
      posId: "mock-pos-load",
      activityId: "activity_default",
      roomId: session.auth.roomId,
      roomName: session.auth.roomName,
      sessionStartedAt: completedAtMs - REALISTIC_DURATION_MS,
      cutoffMs: completedAtMs - REALISTIC_DURATION_MS,
      generatedAtMs: completedAtMs,
      completedAtMs,
      totals: {
        totalAmount: 0,
        cashTotal: 0,
        posTotal: 0,
        otherTotal: 0,
        paymentCount: 0,
        amountToDeposit: cashFloat,
      },
    },
    { type: "handheld.cash.close", allow409: true },
  );
}

async function generateAutomaticCashFloat(session) {
  const generated = await request(
    session,
    "POST",
    "/api/automatic-cash/cash-float/generate",
    {
      reason: "operator_cash_float",
      activityId: "activity_default",
      roomId: session.auth.roomId,
      preferExistingAssignmentForEvening: true,
    },
    {
      type: "automatic_cash.float.generate",
      allow409: true,
      allowStatuses: [423],
    },
  );
  if (generated.status !== 200 || !generated.body?.cashFloatId)
    return { generated };
  const payload = {
    workflowId: generated.body.workflowId,
    operationId: generated.body.operationId,
    cashFloatId: generated.body.cashFloatId,
  };
  await request(
    session,
    "POST",
    "/api/automatic-cash/cash-float/confirm-removed",
    payload,
    {
      type: "automatic_cash.float.confirm_removed",
      allow409: true,
    },
  );
  await request(
    session,
    "POST",
    "/api/automatic-cash/cash-float/ticket/printed",
    {
      ...payload,
      printJobId: `load-float-ticket-${Date.now()}-${rnd(10000)}`,
    },
    { type: "automatic_cash.float.ticket_printed", allow409: true },
  );
  const completed = await request(
    session,
    "POST",
    "/api/automatic-cash/cash-float/confirm-ticket-in-pouch",
    {
      ...payload,
      loadAsActiveCashFloat: true,
    },
    { type: "automatic_cash.float.confirm_pouch", allow409: true },
  );
  return {
    generated,
    completed,
    cashFloatId: generated.body.cashFloatId,
    totalCents: generated.body.totalCents,
  };
}

async function automaticCashPayment(session, order) {
  if (!order?.id) return null;
  order = await refreshOrderById(session, order);
  if (!order?.id || !order?.tableId) return null;
  const expectedTotalCents = Math.max(
    5,
    Math.min(
      2000,
      Math.round(Number(order.dueAmount || order.total || 1) * 100),
    ),
  );
  let start = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    start = await request(
      session,
      "POST",
      "/api/automatic-cash/payment/start",
      {
        expectedTotalCents,
        activityId: "activity_default",
        roomId: order.roomId,
        note: `Incasso automatico ${order.id}`,
      },
      { type: "automatic_cash.payment.start", allow409: true },
    );
    if (start.body?.operationId) break;
    await sleep(1_000 + attempt * 1_000);
  }
  const operationId = start.body?.operationId;
  if (!operationId) return { start };
  const state = await request(
    session,
    "GET",
    `/api/automatic-cash/payment/${operationId}/state`,
    {},
    {
      type: "automatic_cash.payment.state",
    },
  );
  const complete = await request(
    session,
    "POST",
    `/api/automatic-cash/payment/${operationId}/complete`,
    {
      expectedTotalCents,
      depositedTotalCents: state.body?.depositedTotalCents || 2000,
    },
    { type: "automatic_cash.payment.complete", allow409: true },
  );
  const payment =
    complete.status === 200
      ? await payOrder(session, order, {
          amount: expectedTotalCents / 100,
          partial:
            expectedTotalCents <
            Math.round(Number(order.dueAmount || order.total || 0) * 100),
          method: "CASH",
          splitMode: "amount",
          automaticCashOperationId: operationId,
          note: "Incasso completato da cassa automatica simulata",
        })
      : null;
  return { start, state, complete, payment };
}

async function automaticCashExchange(session) {
  const start = await request(
    session,
    "POST",
    "/api/automatic-cash/exchange/start",
    {
      activityId: "activity_default",
      roomId: session.auth.roomId,
    },
    {
      type: "automatic_cash.exchange.start",
      allow409: true,
      allowStatuses: [423],
    },
  );
  const exchangeId = start.body?.exchangeId;
  if (!exchangeId) return { start };
  await request(
    session,
    "GET",
    `/api/automatic-cash/exchange/${exchangeId}/state`,
    {},
    { type: "automatic_cash.exchange.state" },
  );
  await request(
    session,
    "POST",
    `/api/automatic-cash/exchange/${exchangeId}/confirm-deposit`,
    {
      depositedCents: 2000,
    },
    { type: "automatic_cash.exchange.confirm_deposit", allow409: true },
  );
  await request(
    session,
    "POST",
    `/api/automatic-cash/exchange/${exchangeId}/execute`,
    {
      pieces: { 1000: 2 },
    },
    { type: "automatic_cash.exchange.execute", allow409: true },
  );
  const completed = await request(
    session,
    "POST",
    `/api/automatic-cash/exchange/${exchangeId}/confirm-removed`,
    {},
    {
      type: "automatic_cash.exchange.confirm_removed",
      allow409: true,
    },
  );
  return { start, completed, exchangeId };
}

async function listLayout(session) {
  return request(
    session,
    "GET",
    "/api/integration/layout",
    {},
    { type: "layout.get" },
  );
}

async function pollOrders(session, station = "BAR PRINCIPALE") {
  return request(
    session,
    "GET",
    "/api/integration/orders",
    {
      station,
      includeDone: "1",
      operatorUserId: session.user.id,
      deviceUuid: session.deviceUuid,
    },
    { type: "orders.poll" },
  );
}

async function doublePaymentConflict(sessionA, sessionB, order) {
  if (!order?.tableId) return null;
  const lock = await lockTable(sessionA, order.tableId, "payment.free_split");
  if (!isLockAcquired(lock)) return lock;
  try {
    return await request(
      sessionB,
      "POST",
      "/api/payments/free-split",
      {
        tableId: order.tableId,
        roomId: order.roomId,
        orderId: order.id,
        splitType: "FREE_SPLIT",
        parts: [
          {
            amountDue: 0.5,
            transactions: [{ method: "CASH", amountPaid: 0.5, cashGiven: 0.5 }],
          },
        ],
      },
      {
        type: "payment.conflict.second_operator",
        allow409: true,
        allow428: true,
      },
    );
  } finally {
    await releaseTable(sessionA, order.tableId);
  }
}

async function mysqlConnection() {
  return mysql.createConnection(dbConfig);
}

async function auditStationStateLastWritePersistence(domainsTable) {
  if (!/^[A-Za-z0-9_]+$/.test(String(domainsTable ?? ""))) {
    throw new Error("Tabella domini non valida per audit station lastWriteAt.");
  }
  const connection = await mysqlConnection();
  try {
    const [rows] = await connection.query(
      `SELECT record_id, raw_json FROM \`${domainsTable}\` WHERE domain = ? AND (record_id = ? OR record_id LIKE ?)`,
      ["integration", "lastWriteAt", "stationStates:%"],
    );
    const decode = (value) => {
      if (value && typeof value === "object") return value;
      try {
        return JSON.parse(String(value ?? ""));
      } catch {
        return value;
      }
    };
    let markerMs = 0;
    let stationMaxMs = 0;
    let invalidStationRows = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const value = decode(row?.raw_json);
      if (String(row?.record_id) === "lastWriteAt") {
        const parsed = Date.parse(String(value ?? ""));
        markerMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        continue;
      }
      const updatedAtMs = Number(value?.updatedAtMs);
      if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
        invalidStationRows += 1;
        continue;
      }
      stationMaxMs = Math.max(stationMaxMs, updatedAtMs);
    }
    return {
      schemaVersion: 1,
      ok:
        markerMs > 0 &&
        invalidStationRows === 0 &&
        markerMs >= stationMaxMs,
      markerMs,
      stationMaxMs,
      lagMs: Math.max(0, stationMaxMs - markerMs),
      invalidStationRows,
      stationRows: Math.max(0, rows.length - 1),
    };
  } finally {
    await connection.end();
  }
}

async function mysqlGlobalStatus(connection) {
  try {
    const [rows] = await connection.query("SHOW GLOBAL STATUS");
    const keys = new Set([
      "Bytes_received",
      "Bytes_sent",
      "Uptime",
      "Com_insert",
      "Com_update",
      "Com_delete",
      "Com_select",
      "Questions",
      "Innodb_data_written",
      "Innodb_os_log_written",
      "Innodb_rows_inserted",
      "Innodb_rows_updated",
      "Innodb_rows_deleted",
      "Innodb_rows_read",
      "Innodb_deadlocks",
      "Innodb_row_lock_current_waits",
      "Innodb_row_lock_time",
      "Innodb_row_lock_time_max",
      "Innodb_row_lock_waits",
      "Handler_write",
      "Handler_update",
      "Handler_delete",
      "Handler_read_rnd_next",
    ]);
    return Object.fromEntries(
      rows
        .filter((row) => keys.has(row.Variable_name))
        .map((row) => [row.Variable_name, Number(row.Value) || 0]),
    );
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

async function tableStats(connection) {
  const [rows] = await connection.query(
    `
      SELECT table_name, table_rows, data_length, index_length
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name LIKE ?
      ORDER BY table_name
    `,
    [`${prefix}\\_%`],
  );
  return rows.map((row) => ({
    table: row.TABLE_NAME || row.table_name,
    rows: Number(row.TABLE_ROWS ?? row.table_rows) || 0,
    dataBytes: Number(row.DATA_LENGTH ?? row.data_length) || 0,
    indexBytes: Number(row.INDEX_LENGTH ?? row.index_length) || 0,
  }));
}

async function countLoadRows(connection, tables) {
  const out = {};
  for (const table of Object.values(tables)) {
    try {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS count FROM \`${table}\``,
      );
      out[table] = Number(rows[0]?.count) || 0;
    } catch (error) {
      out[table] = { error: String(error?.message || error) };
    }
  }
  return out;
}

async function psSample(pids) {
  const entries = [];
  for (const pid of pids.filter(Boolean)) {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      const parts = stat.split(" ");
      const utime = Number(parts[13]) || 0;
      const stime = Number(parts[14]) || 0;
      const rssKb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
      entries.push({ pid, cpuTicks: utime + stime, rssKb });
    } catch {
      entries.push({ pid, missing: true });
    }
  }
  return entries;
}

function runtimeProcessEntries(snapshot) {
  const sources = [
    snapshot,
    ...(Array.isArray(snapshot?.workers)
      ? snapshot.workers
          .filter((worker) => worker?.ok === true)
          .map((worker) => worker.runtimeMetrics)
      : []),
  ];
  return sources
    .map((entry) => entry?.process)
    .filter((entry) => Number(entry?.pid) > 0)
    .map((entry) => ({
      pid: Number(entry.pid),
      role: String(entry.role ?? "backend").trim() || "backend",
      sampledAtMs: Number(entry.sampledAtMs) || Date.now(),
      rssBytes: Math.max(0, Number(entry.memory?.rssBytes) || 0),
      cpuMicros: Math.max(0, Number(entry.cpu?.totalMicros) || 0),
    }));
}

async function collectMonitor(
  stopSignal,
  pids,
  tables,
  { getRuntimeSession = () => null, runtimeSampleIntervalMs = 5_000 } = {},
) {
  const mysqlConn = await mysqlConnection();
  const samples = [];
  const startStatus = await mysqlGlobalStatus(mysqlConn);
  const startTables = await tableStats(mysqlConn);
  let previous = await psSample(pids);
  const previousRuntimeProcesses = new Map();
  let lastRuntimeSampleAt = 0;
  while (!stopSignal.done) {
    await sleep(1000);
    const current = await psSample(pids);
    const tableSize = await tableStats(mysqlConn);
    const load = os.loadavg();
    const processSamples = current.map((entry) => {
      const before = previous.find((item) => item.pid === entry.pid);
      return {
        pid: entry.pid,
        rssMb: Math.round((entry.rssKb || 0) / 1024),
        cpuTickDelta:
          before && !before.missing && !entry.missing
            ? (entry.cpuTicks || 0) - (before.cpuTicks || 0)
            : 0,
        cpuPercent: null,
        role: "os-process",
        source: "procfs",
        missing: entry.missing === true,
      };
    });
    const runtimeNow = Date.now();
    if (runtimeNow - lastRuntimeSampleAt >= runtimeSampleIntervalMs) {
      const runtimeSession = getRuntimeSession();
      if (runtimeSession?.token) {
        const runtimeSnapshot = await fetchRuntimeMetrics(
          runtimeSession,
          "snapshot",
          apiBaseUrl,
          { record: false },
        ).catch(() => null);
        for (const entry of runtimeProcessEntries(runtimeSnapshot)) {
          const before = previousRuntimeProcesses.get(entry.pid);
          const elapsedMs = before
            ? Math.max(1, entry.sampledAtMs - before.sampledAtMs)
            : 0;
          const cpuDeltaMicros = before
            ? Math.max(0, entry.cpuMicros - before.cpuMicros)
            : 0;
          const runtimeSample = {
            pid: entry.pid,
            rssMb: Math.round(entry.rssBytes / 1024 / 1024),
            cpuTickDelta: 0,
            cpuPercent:
              elapsedMs > 0
                ? Math.round((cpuDeltaMicros / (elapsedMs * 1_000)) * 10_000) /
                  100
                : null,
            role: entry.role,
            source: "runtime-metrics",
            missing: false,
          };
          const existingIndex = processSamples.findIndex(
            (item) => item.pid === entry.pid,
          );
          if (existingIndex >= 0) processSamples[existingIndex] = runtimeSample;
          else processSamples.push(runtimeSample);
          previousRuntimeProcesses.set(entry.pid, entry);
        }
      }
      lastRuntimeSampleAt = runtimeNow;
    }
    const sample = {
      at: nowIso(),
      load1: load[0],
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      processes: processSamples,
      tableBytes: tableSize.reduce(
        (sum, row) => sum + row.dataBytes + row.indexBytes,
        0,
      ),
    };
    samples.push(sample);
    previous = current;
  }
  const endStatus = await mysqlGlobalStatus(mysqlConn);
  const endTables = await tableStats(mysqlConn);
  const rowCounts = await countLoadRows(mysqlConn, tables);
  await mysqlConn.end();
  return { startStatus, endStatus, startTables, endTables, rowCounts, samples };
}

function summarizeMonitor(monitor) {
  const samples = monitor.samples || [];
  const pids = new Map();
  for (const sample of samples) {
    for (const proc of sample.processes || []) {
      if (proc.missing === true) continue;
      const current = pids.get(proc.pid) || {
        role: proc.role || "os-process",
        sources: new Set(),
        maxRssMb: 0,
        avgRssMb: 0,
        cpuTickDeltas: [],
        cpuPercents: [],
        count: 0,
      };
      current.role = proc.role || current.role;
      current.sources.add(proc.source || "unknown");
      current.maxRssMb = Math.max(current.maxRssMb, proc.rssMb || 0);
      current.avgRssMb += proc.rssMb || 0;
      current.cpuTickDeltas.push(proc.cpuTickDelta || 0);
      if (Number.isFinite(Number(proc.cpuPercent))) {
        current.cpuPercents.push(Number(proc.cpuPercent));
      }
      current.count += 1;
      pids.set(proc.pid, current);
    }
  }
  const mysqlStatus = calculateMysqlStatusDelta(
    monitor.startStatus,
    monitor.endStatus,
  );
  return {
    mysqlStatusDelta: mysqlStatus.delta,
    mysqlStatusResetKeys: mysqlStatus.resetKeys,
    mysqlStatusServerRestarted: mysqlStatus.serverRestarted,
    tableBytesStart: monitor.startTables.reduce(
      (sum, row) => sum + row.dataBytes + row.indexBytes,
      0,
    ),
    tableBytesEnd: monitor.endTables.reduce(
      (sum, row) => sum + row.dataBytes + row.indexBytes,
      0,
    ),
    tableStatsEnd: monitor.endTables,
    rowCounts: monitor.rowCounts,
    samples: samples.length,
    processSummary: Object.fromEntries(
      [...pids.entries()].map(([pid, item]) => [
        pid,
        {
          role: item.role,
          sources: [...item.sources].sort(),
          maxRssMb: item.maxRssMb,
          avgRssMb: item.count ? Math.round(item.avgRssMb / item.count) : 0,
          maxCpuTickDeltaPerSec: Math.max(...item.cpuTickDeltas, 0),
          avgCpuTickDeltaPerSec: item.cpuTickDeltas.length
            ? Math.round(
                item.cpuTickDeltas.reduce((sum, value) => sum + value, 0) /
                  item.cpuTickDeltas.length,
              )
            : 0,
          maxCpuPercent: item.cpuPercents.length
            ? Math.max(...item.cpuPercents)
            : null,
          avgCpuPercent: item.cpuPercents.length
            ? Math.round(
                (item.cpuPercents.reduce((sum, value) => sum + value, 0) /
                  item.cpuPercents.length) *
                  100,
              ) / 100
            : null,
        },
      ]),
    ),
  };
}

function buildTables() {
  const tableList = [];
  for (const room of rooms.filter((room) => !room.virtual)) {
    for (let index = 1; index <= 50; index += 1) {
      tableList.push({
        id: `${room.id}_t${String(index).padStart(2, "0")}`,
        roomId: room.id,
        number: index,
      });
    }
  }
  return tableList;
}

async function handheldWorker(index, sessions, tables, sharedOrders) {
  const session = sessions[index % sessions.length];
  const authorizedTables = tablesAuthorizedForSession(session, tables);
  if (authorizedTables.length === 0) {
    throw new Error(`Nessun tavolo autorizzato per ${session.user.username}.`);
  }
  for (let op = 0; op < OPS_PER_DEVICE; op += 1) {
    const typeRoll = rnd(100);
    const table =
      authorizedTables[(index * OPS_PER_DEVICE + op) % authorizedTables.length];
    recorder.business(`handheld.${index + 1}`);
    try {
      if (typeRoll < 28) {
        const created = await createOrder(session, table, {
          long: typeRoll < 6,
          note: `device ${index + 1} op ${op}`,
        });
        if (created.body?.order) sharedOrders.push(created.body.order);
      } else if (typeRoll < 38) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order)
          await syncOrder(session, order.id, "ready", pick(stationNames));
      } else if (typeRoll < 48) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order)
          await syncOrder(session, order.id, "delivered", pick(stationNames));
      } else if (typeRoll < 56) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order) await correctOrder(session, order);
      } else if (typeRoll < 62) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order) await compOrder(session, order);
      } else if (typeRoll < 73) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order)
          await payOrder(session, order, {
            partial: rnd(3) === 0,
            method: rnd(4) === 0 ? "POS" : "CASH",
          });
      } else if (typeRoll < 78) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order)
          await printOrder(session, order, pick(["order", "preconto"]));
      } else if (typeRoll < 83) {
        await reservationFlow(session, table);
      } else if (typeRoll < 87) {
        await moveTable(
          session,
          table,
          authorizedTables[(index * 17 + op * 7) % authorizedTables.length],
        );
      } else if (typeRoll < 91) {
        const targets = authorizedTables.filter(
          (candidate) => candidate.roomId !== table.roomId,
        );
        if (targets.length > 0) {
          await roomMoveRequest(
            session,
            table,
            targets[(index * 23 + op * 11) % targets.length],
          );
        } else {
          await listLayout(session);
        }
      } else if (typeRoll < 94) {
        await roomChange(
          session,
          pick(rooms.filter((room) => !room.virtual)).id,
        );
      } else if (typeRoll < 97) {
        await waiterPause(session, true);
        await waiterPause(session, false);
      } else {
        await listLayout(session);
      }
    } catch (error) {
      recorder.failures.push({
        at: nowIso(),
        type: "worker.handheld.exception",
        status: 0,
        detail: { message: String(error?.message || error) },
      });
    }
  }
}

function buildPacedHandheldActionPlan() {
  const plan = [];
  let orders = 0;
  let others = 0;
  while (orders < PACED_ORDER_COUNT || others < PACED_OTHER_ACTION_COUNT) {
    for (let slot = 0; slot < 2 && orders < PACED_ORDER_COUNT; slot += 1) {
      plan.push({ kind: "order", ordinal: orders + 1 });
      orders += 1;
    }
    if (others < PACED_OTHER_ACTION_COUNT) {
      plan.push({ kind: "other", ordinal: others + 1 });
      others += 1;
    }
  }
  return plan;
}

async function runPacedOtherAction(session, ordinal, signal) {
  const variant = (ordinal - 1) % 3;
  if (variant === 0) {
    return request(
      session,
      "GET",
      "/api/integration/layout",
      {},
      {
        type: "paced.layout.get",
        signal,
      },
    );
  }
  if (variant === 1) {
    return request(
      session,
      "GET",
      "/api/integration/stations/state",
      {},
      {
        type: "paced.station.states.get",
        signal,
      },
    );
  }
  return request(
    session,
    "POST",
    "/api/mobile/waiter-pause/status",
    {
      roomId: session.auth.roomId,
      roomName: session.auth.roomName,
      clientApp: "mobile-frontend",
    },
    {
      type: "paced.waiter.pause.status",
      signal,
    },
  );
}

async function pacedHandheldWorker(
  index,
  sessions,
  tables,
  profileStartedAt,
  profileDeadlineAt,
) {
  const session = sessions[index % sessions.length];
  const table = tables[index % tables.length];
  const stats = {
    deviceIndex: index + 1,
    deviceUuid: session.deviceUuid,
    tableId: table.id,
    ordersAttempted: 0,
    ordersCreated: 0,
    otherAttempted: 0,
    otherSucceeded: 0,
    spacingViolations: 0,
    startGapsMs: [],
    startedAt: null,
    endedAt: null,
    deadlineReached: false,
  };
  let previousActionStartedAt = 0;
  for (const action of buildPacedHandheldActionPlan()) {
    const earliestStartAt = previousActionStartedAt
      ? previousActionStartedAt + PACED_ACTION_INTERVAL_MS
      : profileStartedAt;
    if (earliestStartAt >= profileDeadlineAt) {
      stats.deadlineReached = true;
      break;
    }
    await sleep(Math.max(0, earliestStartAt - Date.now()));
    if (Date.now() >= profileDeadlineAt) {
      stats.deadlineReached = true;
      break;
    }
    const actionStartedAt = Date.now();
    if (previousActionStartedAt) {
      const gapMs = actionStartedAt - previousActionStartedAt;
      stats.startGapsMs.push(gapMs);
      if (gapMs < PACED_ACTION_INTERVAL_MS - PACED_START_GAP_TOLERANCE_MS)
        stats.spacingViolations += 1;
    }
    previousActionStartedAt = actionStartedAt;
    stats.startedAt ??= new Date(actionStartedAt).toISOString();
    recorder.business(`handheld.${index + 1}`);
    const remainingMs = Math.max(1, profileDeadlineAt - actionStartedAt);
    const signal = AbortSignal.timeout(
      Math.min(PACED_ACTION_TIMEOUT_MS, remainingMs),
    );
    try {
      if (action.kind === "order") {
        stats.ordersAttempted += 1;
        const created = await createOrder(session, table, {
          long: false,
          note: `paced device ${index + 1} order ${action.ordinal}`,
          signal,
        });
        if (created.status === 200 && created.body?.order)
          stats.ordersCreated += 1;
      } else {
        stats.otherAttempted += 1;
        const result = await runPacedOtherAction(
          session,
          action.ordinal,
          signal,
        );
        if (result.ok) stats.otherSucceeded += 1;
      }
    } catch (error) {
      recorder.failures.push({
        at: nowIso(),
        type: "worker.handheld.paced.exception",
        status: 0,
        detail: {
          deviceIndex: index + 1,
          action,
          message: String(error?.message || error),
        },
      });
    }
  }
  stats.endedAt = nowIso();
  return stats;
}

function summarizePacedProfile(
  deviceStats,
  profileStartedAt,
  profileDeadlineAt,
) {
  const gaps = deviceStats.flatMap((stats) => stats.startGapsMs);
  const totals = deviceStats.reduce(
    (acc, stats) => {
      acc.ordersAttempted += stats.ordersAttempted;
      acc.ordersCreated += stats.ordersCreated;
      acc.otherAttempted += stats.otherAttempted;
      acc.otherSucceeded += stats.otherSucceeded;
      acc.spacingViolations += stats.spacingViolations;
      return acc;
    },
    {
      ordersAttempted: 0,
      ordersCreated: 0,
      otherAttempted: 0,
      otherSucceeded: 0,
      spacingViolations: 0,
    },
  );
  const completedTargets = deviceStats.filter(
    (stats) =>
      stats.ordersAttempted >= PACED_ORDER_COUNT &&
      stats.otherAttempted >= PACED_OTHER_ACTION_COUNT,
  ).length;
  const successfulTargets = deviceStats.filter(
    (stats) =>
      stats.ordersCreated >= PACED_ORDER_COUNT &&
      stats.otherSucceeded >= PACED_OTHER_ACTION_COUNT,
  ).length;
  return {
    enabled: true,
    profile: LOADTEST_PROFILE,
    profileStartedAt: new Date(profileStartedAt).toISOString(),
    profileEndedAt: nowIso(),
    activeDurationMs: Date.now() - profileStartedAt,
    deadlineAt: new Date(profileDeadlineAt).toISOString(),
    maxActiveMs: PACED_MAX_ACTIVE_MS,
    actionIntervalMs: PACED_ACTION_INTERVAL_MS,
    actionTimeoutMs: PACED_ACTION_TIMEOUT_MS,
    orderTargetPerDevice: PACED_ORDER_COUNT,
    otherTargetPerDevice: PACED_OTHER_ACTION_COUNT,
    devices: deviceStats.length,
    devicesCompletedTargets: completedTargets,
    devicesSuccessfulTargets: successfulTargets,
    minStartGapMs: gaps.length ? Math.min(...gaps) : null,
    maxStartGapMs: gaps.length ? Math.max(...gaps) : null,
    totals,
    deviceStats,
  };
}

function recordPacedProfileFailures(summary) {
  const detail = {
    devices: summary.devices,
    devicesCompletedTargets: summary.devicesCompletedTargets,
    devicesSuccessfulTargets: summary.devicesSuccessfulTargets,
    devicesMeetingPersistedOrderTarget:
      summary.devicesMeetingPersistedOrderTarget,
    activeDurationMs: summary.activeDurationMs,
    minStartGapMs: summary.minStartGapMs,
    totals: summary.totals,
  };
  const checks = [
    [
      summary.devicesCompletedTargets !== HANDHELD_COUNT,
      "paced.targets.not_attempted",
    ],
    [
      summary.devicesSuccessfulTargets !== HANDHELD_COUNT,
      "paced.targets.not_successful",
    ],
    [
      summary.devicesMeetingPersistedOrderTarget !== HANDHELD_COUNT,
      "paced.orders.not_persisted",
    ],
    [summary.totals.spacingViolations > 0, "paced.spacing.violation"],
    [
      summary.activeDurationMs > PACED_MAX_ACTIVE_MS + 5_000,
      "paced.duration.exceeded",
    ],
  ];
  for (const [failed, type] of checks) {
    if (failed)
      recorder.failures.push({ at: nowIso(), type, status: 0, detail });
  }
}

function realisticEventTimes(count, durationMs, deviceIndex, kind) {
  const slotMs = durationMs / Math.max(1, count);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    let atMs = (index + 0.45) * slotMs;
    const deterministicJitter =
      (((deviceIndex + 1) * 7919 + (index + 1) * 104729 + kind.length * 97) %
        1000) /
      1000;
    atMs += (deterministicJitter - 0.5) * slotMs * 0.7;
    if (kind === "order" && durationMs >= 30 * 60_000) {
      if (index === 0) atMs = 20_000 + deviceIndex * 120;
      if (index === 1) atMs = 60_000 + deviceIndex * 170;
      if (index === 2) atMs = 180_000 + deviceIndex * 210;
    }
    values.push(
      Math.max(1_000, Math.min(durationMs - 2_000, Math.round(atMs))),
    );
  }
  return values.sort((left, right) => left - right);
}

function operationSucceeded(result) {
  if (result == null) return false;
  if (typeof result.businessOk === "boolean") return result.businessOk;
  if (typeof result.status === "number") {
    return (
      result.status >= 200 &&
      result.status < 300 &&
      result.body?.ok !== false
    );
  }
  if (typeof result.ok === "boolean") return result.ok;
  return true;
}

function selectUsableOrder(orders) {
  if (!orders.length) return null;
  const recentWindow = Math.min(10, orders.length);
  return orders[orders.length - 1 - rnd(recentWindow)] || orders.at(-1) || null;
}

async function runRealisticOtherAction(
  index,
  ordinal,
  session,
  ownOrders,
  sharedOrders,
  tables,
) {
  const variant = (index * 7 + ordinal) % 24;
  const order = selectUsableOrder(ownOrders.length ? ownOrders : sharedOrders);
  const authorizedTables = tablesAuthorizedForSession(session, tables);
  if (authorizedTables.length === 0) {
    throw new Error(`Nessun tavolo autorizzato per ${session.user.username}.`);
  }
  const table =
    authorizedTables[(index * 31 + ordinal * 11) % authorizedTables.length];
  let name = "layout.get";
  let result = null;
  if (variant === 0 && order) {
    name = "order.ready";
    result = await syncOrder(
      session,
      order.id,
      "ready",
      activeStationNames[(index + ordinal) % activeStationNames.length],
    );
  } else if (variant === 1 && order) {
    name = "order.delivered";
    result = await syncOrder(
      session,
      order.id,
      "delivered",
      activeStationNames[(index + ordinal) % activeStationNames.length],
    );
  } else if (variant === 2 && order) {
    name = "order.correct_price_variant_notes";
    result = await correctOrder(session, order);
  } else if (variant === 3 && order) {
    name = "order.return_with_or_without_replacement";
    result = await compOrder(session, order);
  } else if (variant === 4 && order) {
    name = "order.cancel";
    result = await cancelOrder(session, order);
  } else if (variant === 5 && order) {
    name = "payment.amount_free";
    result = await payOrder(session, order, {
      partial: true,
      splitMode: "amount",
      method: "CASH",
      note: "Importo libero",
    });
  } else if (variant === 6 && order) {
    name = "payment.roman";
    result = await payOrder(session, order, {
      partial: true,
      splitMode: "roman",
      method: ordinal % 2 ? "POS" : "CASH",
    });
  } else if (variant === 7 && order) {
    name = "payment.article";
    result = await payOrder(session, order, {
      partial: true,
      splitMode: "article",
    });
  } else if (variant === 8 && order) {
    name = "payment.single_pos";
    result = await payOrder(session, order, {
      splitMode: "single",
      method: "POS",
      note: "Pagamento unico carta",
    });
  } else if (variant === 9 && order) {
    name = "print.order_reprint";
    result = await printOrder(session, order, "order");
  } else if (variant === 10 && order) {
    name = "print.preconto_current_total";
    result = await printOrder(session, order, "preconto");
  } else if (variant === 11) {
    name = "table.move";
    result = await moveTable(
      session,
      table,
      authorizedTables[
        (index * 37 + ordinal * 13 + 1) % authorizedTables.length
      ],
    );
  } else if (variant === 12) {
    const targets = authorizedTables.filter(
      (candidate) => candidate.roomId !== table.roomId,
    );
    if (targets.length > 0) {
      name = "table.room_move_request";
      result = await roomMoveRequest(
        session,
        table,
        targets[(index * 41 + ordinal * 17 + 2) % targets.length],
      );
    } else {
      name = "table.room_move_request.not_applicable";
      result = await listLayout(session);
    }
  } else if (variant === 13) {
    name = "table.merge_split";
    result = await saveTableGroup(
      session,
      table,
      authorizedTables[
        (authorizedTables.indexOf(table) + 1) % authorizedTables.length
      ],
      ordinal % 2 === 0,
    );
  } else if (variant === 14) {
    name = "reservation.lifecycle";
    result = await reservationFlow(session, table);
  } else if (variant === 15) {
    name = "notification.waiter_ready";
    result = await publishNotification(
      session,
      table,
      ordinal % 2 === 0 ? "ready" : "waiter",
    );
  } else if (variant === 16) {
    name = "waiter.pause_resume";
    const start = await waiterPause(session, true);
    const stop = await waiterPause(session, false);
    result = stop?.status ? stop : start;
  } else if (variant === 17) {
    name = "settings_search_history_battery";
    result = await readSettingsAndSearch(session, ordinal);
  } else if (variant === 18) {
    name = "table.identity_occupancy";
    result = await syncTableDetails(session, table, {
      occupancyState: ordinal % 2 ? "seated" : "free",
    });
  } else if (variant === 19) {
    name = "counter.collect";
    result = await collectCounterOrder(session, ordinal);
  } else if (variant === 20 && order) {
    name = "order.transfer_station";
    result = await forceTransferOrder(
      session,
      order,
      activeStationNames[(index + ordinal + 1) % activeStationNames.length],
    );
  } else if (variant === 21) {
    name = "room.change";
    const targetRoomId = rooms[(index + ordinal) % (rooms.length - 1)].id;
    const expectDenied =
      session.user.username === "op20" && targetRoomId !== "room_pedana";
    result = await roomChange(session, targetRoomId, { expectDenied });
    if (expectDenied) {
      recorder.cover(
        "room.change.authorization_denied",
        result?.status === 403,
        {
          device: index + 1,
          targetRoomId,
          status: result?.status ?? null,
        },
      );
    }
  } else if (variant === 22) {
    name = "search.all";
    result = await readSettingsAndSearch(session, ordinal + 3);
  } else {
    name = "layout.get";
    result = await listLayout(session);
  }
  recorder.cover(name, operationSucceeded(result), {
    device: index + 1,
    ordinal,
    status: result?.status ?? null,
  });
  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.p5ActionType = name;
  }
  return result;
}

async function realisticHandheldWorker(
  index,
  sessions,
  tables,
  sharedOrders,
  profileStartedAt,
  deadlineAt,
) {
  const session = sessions[index];
  const ownOrders = [];
  const orderTimes = realisticEventTimes(
    REALISTIC_ORDER_COUNT,
    REALISTIC_DURATION_MS,
    index,
    "order",
  );
  const otherTimes = realisticEventTimes(
    REALISTIC_OTHER_ACTION_COUNT,
    REALISTIC_DURATION_MS,
    index,
    "other",
  );
  const events = [
    ...orderTimes.map((atMs, ordinal) => ({
      kind: "order",
      atMs,
      ordinal: ordinal + 1,
    })),
    ...otherTimes.map((atMs, ordinal) => ({
      kind: "other",
      atMs,
      ordinal: ordinal + 1,
    })),
  ].sort(
    (left, right) =>
      left.atMs - right.atMs || left.kind.localeCompare(right.kind),
  );
  const stats = {
    deviceIndex: index + 1,
    deviceUuid: session.deviceUuid,
    ordersAttempted: 0,
    ordersCreated: 0,
    otherAttempted: 0,
    otherCompleted: 0,
    firstOrderAt: null,
    lastOrderAt: null,
  };

  for (const event of events) {
    const dueAt = profileStartedAt + event.atMs;
    if (dueAt >= deadlineAt) break;
    await sleep(Math.max(0, dueAt - Date.now()));
    if (Date.now() >= deadlineAt) break;
    recorder.business(`handheld.${index + 1}.${event.kind}`);
    try {
      if (event.kind === "order") {
        stats.ordersAttempted += 1;
        let created = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const table =
            tables[
              (index * 53 + event.ordinal * 17 + attempt * 73) % tables.length
            ];
          created = await createOrder(session, table, {
            long: event.ordinal % 10 === 0,
            withVariants: event.ordinal % 7 === 0,
            note: `realistic device ${index + 1} order ${event.ordinal}`,
            signal: AbortSignal.timeout(30_000),
          });
          if (created.status === 200 && created.body?.order) break;
          await sleep(250 + attempt * 150);
        }
        if (created?.status === 200 && created.body?.order) {
          const order = created.body.order;
          ownOrders.push(order);
          sharedOrders.push(order);
          stats.ordersCreated += 1;
          stats.firstOrderAt ??= nowIso();
          stats.lastOrderAt = nowIso();
          recorder.cover("orders.50_per_device", true, {
            device: index + 1,
            ordinal: event.ordinal,
          });
        } else {
          recorder.cover("orders.50_per_device", false, {
            device: index + 1,
            ordinal: event.ordinal,
            status: created?.status ?? 0,
            code: created?.body?.code ?? null,
            error: created?.body?.error ?? null,
          });
        }
      } else {
        stats.otherAttempted += 1;
        await runRealisticOtherAction(
          index,
          event.ordinal,
          session,
          ownOrders,
          sharedOrders,
          tables,
        );
        stats.otherCompleted += 1;
      }
    } catch (error) {
      recorder.failures.push({
        at: nowIso(),
        type: `worker.handheld.realistic.${event.kind}`,
        status: 0,
        detail: {
          device: index + 1,
          ordinal: event.ordinal,
          message: String(error?.message || error),
        },
      });
    }
  }
  return stats;
}

function summarizeRealisticProfile(deviceStats, profileStartedAt) {
  const totals = deviceStats.reduce(
    (result, item) => ({
      ordersAttempted: result.ordersAttempted + item.ordersAttempted,
      ordersCreated: result.ordersCreated + item.ordersCreated,
      otherAttempted: result.otherAttempted + item.otherAttempted,
      otherCompleted: result.otherCompleted + item.otherCompleted,
    }),
    {
      ordersAttempted: 0,
      ordersCreated: 0,
      otherAttempted: 0,
      otherCompleted: 0,
    },
  );
  const devicesAtTarget = deviceStats.filter(
    (item) => item.ordersCreated === REALISTIC_ORDER_COUNT,
  ).length;
  return {
    enabled: true,
    profile: LOADTEST_PROFILE,
    profileStartedAt: new Date(profileStartedAt).toISOString(),
    profileEndedAt: nowIso(),
    activeDurationMs: Date.now() - profileStartedAt,
    durationTargetMs: REALISTIC_DURATION_MS,
    orderTargetPerDevice: REALISTIC_ORDER_COUNT,
    otherTargetPerDevice: REALISTIC_OTHER_ACTION_COUNT,
    devices: deviceStats.length,
    devicesAtTarget,
    totals,
    deviceStats,
  };
}

async function realisticStationWorker(
  index,
  session,
  sharedOrders,
  profileStartedAt,
  deadlineAt,
) {
  const station = activeStationNames[index % activeStationNames.length];
  let ordinal = 0;
  while (Date.now() < deadlineAt) {
    const dueAt = profileStartedAt + 5_000 + ordinal * 45_000 + rnd(20_000);
    if (dueAt >= deadlineAt) break;
    await sleep(Math.max(0, dueAt - Date.now()));
    if (Date.now() >= deadlineAt) break;
    ordinal += 1;
    if (suppressedStationIndexes.has(index)) continue;
    const order = selectUsableOrder(sharedOrders);
    const variant = ordinal % 7;
    if (variant === 0) await stationHeartbeat(session, station, true);
    else if (variant === 1) await pollOrders(session, station);
    else if (variant === 2 && order)
      await syncOrder(session, order.id, "ready", station);
    else if (variant === 3 && order)
      await syncOrder(session, order.id, "delivered", station);
    else if (variant === 4)
      await request(
        session,
        "GET",
        "/api/integration/stations/state",
        {},
        { type: "station.states.get" },
      );
    else if (variant === 5 && order)
      await printOrder(
        session,
        order,
        ordinal % 2 ? "order" : "preconto",
        printerForStationIndex(index),
      );
    else if (order)
      await forceTransferOrder(
        session,
        order,
        activeStationNames[(index + 1) % activeStationNames.length],
      );
    recorder.cover("station.realistic_activity", true, { station, ordinal });
  }
}

async function stationWorker(index, session, sharedOrders) {
  const station = stationNames[index % stationNames.length];
  for (let op = 0; op < OPS_PER_DEVICE; op += 1) {
    recorder.business(`station.${index + 1}`);
    try {
      const roll = rnd(100);
      if (roll < 45) {
        await stationHeartbeat(session, station, true);
      } else if (roll < 70) {
        await pollOrders(session, station);
      } else if (roll < 78) {
        await stationHeartbeat(session, station, false, {
          pauseTransferMode: "transfer",
          pauseTransferTargetStation:
            stationNames[(index + 1) % stationNames.length],
        });
        await stationHeartbeat(session, station, true);
      } else if (roll < 86) {
        const order = pick(sharedOrders.length ? sharedOrders : []);
        if (order)
          await syncOrder(
            session,
            order.id,
            pick(["ready", "delivered"]),
            station,
          );
      } else {
        await request(
          session,
          "GET",
          "/api/integration/stations/state",
          {},
          { type: "station.states.get" },
        );
      }
    } catch (error) {
      recorder.failures.push({
        at: nowIso(),
        type: "worker.station.exception",
        status: 0,
        detail: { message: String(error?.message || error) },
      });
    }
  }
}

async function stationPresenceKeeper(sessions, stopSignal) {
  while (!stopSignal.done) {
    await Promise.allSettled(
      sessions.map((session, index) => {
        if (suppressedStationIndexes.has(index)) return null;
        return stationHeartbeat(
          session,
          activeStationNames[index % activeStationNames.length],
          true,
        );
      }),
    );
    await sleep(5000);
  }
}

async function runFiscalSamples(session, sharedOrders, tables) {
  for (let index = 0; index < FISCAL_SAMPLE_LIMIT; index += 1) {
    const table = tables[(index * 13) % tables.length];
    const created = await createOrder(session, table, {
      long: false,
      note: `RT reale sample ${index + 1}`,
    });
    const order = created.body?.order;
    if (!order) continue;
    await syncOrder(session, order.id, "delivered", "BAR PRINCIPALE");
    sharedOrders.push(order);
    await payOrder(session, order, {
      amount: Math.max(0.01, Math.min(Number(order.total || 0.01), 0.01)),
      method: "CASH",
      issueFiscal: true,
      note: `RT reale load sample ${index + 1}`,
    });
  }
}

async function runAdminAdjustmentSamples(session, sharedOrders, tables) {
  for (let index = 0; index < 10; index += 1) {
    const table = tables[(index * 19 + 5) % tables.length];
    const created = await createOrder(session, table, {
      long: false,
      note: `rettifica admin ${index + 1}`,
    });
    const order = created.body?.order;
    if (!order) continue;
    await syncOrder(session, order.id, "delivered", "BAR PRINCIPALE");
    sharedOrders.push(order);
    const original = Number(order.total || 1);
    await payOrder(session, order, {
      amount: money(Math.max(0.5, original - 0.2)),
      method: "CASH",
      note: "nota rettifica pagamento load",
      adminAdjustment: {
        type: index % 2 === 0 ? "discount" : "allowance",
        originalAmount: original,
        adjustedAmount: money(Math.max(0.5, original - 0.2)),
        reason: "load rettifica importo",
      },
    });
  }
}

async function runConflictSamples(sessionA, sessionB, sharedOrders, tables) {
  for (let index = 0; index < 12; index += 1) {
    const table = tables[(index * 29 + 9) % tables.length];
    const created = await createOrder(sessionA, table, {
      long: false,
      note: `conflitto pagamento ${index + 1}`,
    });
    const order = created.body?.order;
    if (!order) continue;
    await syncOrder(sessionA, order.id, "delivered", "BAR PRINCIPALE");
    sharedOrders.push(order);
    await doublePaymentConflict(sessionA, sessionB, order);
  }
}

async function runGui(browser, index, session) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(
    (auth) => {
      window.localStorage.setItem("pos_token", auth.token);
      window.localStorage.setItem("pos_user_id", auth.userId);
      window.localStorage.setItem("pos_user", auth.username);
      window.localStorage.setItem("pos_user_full_name", auth.fullName);
      window.localStorage.setItem("pos_device_uuid", auth.deviceUuid);
      window.localStorage.setItem("pos_selected_room_id", "room_pedana");
      window.localStorage.setItem("pos_selected_room_name", "Pedana");
    },
    {
      token: session.token,
      userId: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      deviceUuid: session.deviceUuid,
    },
  );
  let reqCount = 0;
  let resBytes = 0;
  context.on("request", () => {
    reqCount += 1;
  });
  context.on("response", async (response) => {
    const headers = response.headers();
    resBytes += Number(headers["content-length"] || 0);
  });
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`${frontendBaseUrl}/mobile/`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => undefined);
  for (let op = 0; op < OPS_PER_DEVICE; op += 1) {
    recorder.business(`gui.${index + 1}`);
    if (op % 10 === 0) {
      await page
        .reload({ waitUntil: "domcontentloaded" })
        .catch(() => undefined);
    }
    await page
      .evaluate(async () => {
        const token = window.localStorage.getItem("pos_token") || "";
        const userId = window.localStorage.getItem("pos_user_id") || "";
        const deviceUuid = window.localStorage.getItem("pos_device_uuid") || "";
        const headers = {
          Authorization: `Bearer ${token}`,
          "X-User-Id": userId,
          "X-Device-Uuid": deviceUuid,
        };
        await fetch("/api/integration/layout", { cache: "no-store", headers });
        await fetch("/api/integration/orders?includeDone=1", {
          cache: "no-store",
          headers,
        });
      })
      .catch(() => undefined);
    await sleep(25 + rnd(75));
  }
  const perf = await page
    .evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadEventEnd: nav ? Math.round(nav.loadEventEnd) : null,
        resourceCount: performance.getEntriesByType("resource").length,
        heap: performance.memory
          ? {
              usedJSHeapSize: performance.memory.usedJSHeapSize,
              totalJSHeapSize: performance.memory.totalJSHeapSize,
            }
          : null,
      };
    })
    .catch(() => null);
  recorder.gui.push({
    index,
    durationMs: Date.now() - started,
    requests: reqCount,
    responseHeaderBytes: resBytes,
    perf,
  });
  await context.close();
}

async function runRealisticMobileGui(
  browser,
  index,
  session,
  profileStartedAt,
  deadlineAt,
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(
    (auth) => {
      window.localStorage.setItem("pos_token", auth.token);
      window.localStorage.setItem("pos_user_id", auth.userId);
      window.localStorage.setItem("pos_user", auth.username);
      window.localStorage.setItem("pos_user_full_name", auth.fullName);
      window.localStorage.setItem("pos_device_uuid", auth.deviceUuid);
      window.localStorage.setItem("pos_selected_room_id", "room_pedana");
      window.localStorage.setItem("pos_selected_room_name", "Pedana");
    },
    {
      token: session.token,
      userId: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      deviceUuid: session.deviceUuid,
    },
  );
  const diagnostics = {
    requests: 0,
    responses4xx: 0,
    responses5xx: 0,
    consoleErrors: 0,
    interactions: 0,
    consoleErrorSamples: [],
    responseErrorSamples: [],
  };
  context.on("request", () => {
    diagnostics.requests += 1;
  });
  context.on("response", (response) => {
    if (response.status() >= 500) diagnostics.responses5xx += 1;
    else if (response.status() >= 400) diagnostics.responses4xx += 1;
    if (
      response.status() >= 400 &&
      diagnostics.responseErrorSamples.length < 10
    ) {
      diagnostics.responseErrorSamples.push({
        status: response.status(),
        url: response.url(),
      });
    }
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors += 1;
      if (diagnostics.consoleErrorSamples.length < 10)
        diagnostics.consoleErrorSamples.push(message.text());
    }
  });
  const evidenceDir = path.join(outputDir, "gui-evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const startedAt = Date.now();
  let outageDone = false;
  try {
    await page.goto(`${frontendBaseUrl}/mobile/`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);
    await page
      .locator(".bottom-btn")
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.screenshot({
      path: path.join(evidenceDir, `mobile-${index + 1}-start.png`),
      fullPage: true,
    });
    let iteration = 0;
    while (Date.now() < deadlineAt) {
      const outageAt =
        profileStartedAt + Math.round(REALISTIC_DURATION_MS * 0.62);
      if (!outageDone && Date.now() >= outageAt) {
        outageDone = true;
        const offlineStartedAt = Date.now();
        await context.setOffline(true);
        await sleep(
          Math.min(
            REALISTIC_NETWORK_OUTAGE_MS,
            Math.max(1_000, deadlineAt - Date.now() - 2_000),
          ),
        );
        await context.setOffline(false);
        const recoveryStarted = performance.now();
        await page
          .reload({ waitUntil: "domcontentloaded" })
          .catch(() => undefined);
        await page
          .locator(".bottom-btn")
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .catch(() => undefined);
        const recoveryMs = Math.round(performance.now() - recoveryStarted);
        recorder.cover("network.mobile_disconnect_reconnect", true, {
          device: index + 1,
          offlineMs: Date.now() - offlineStartedAt,
          recoveryMs,
        });
      }
      const tabs = page.locator(".bottom-btn");
      const count = await tabs.count();
      if (count > 0) {
        await tabs
          .nth(iteration % count)
          .click({ timeout: 5_000 })
          .catch(() => undefined);
        diagnostics.interactions += 1;
      }
      const search = page.locator('input[type="search"]:visible').first();
      if (await search.count()) {
        await search
          .fill(iteration % 2 === 0 ? "k " : "prosecco")
          .catch(() => undefined);
        diagnostics.interactions += 1;
      }
      const preferred = page
        .locator(
          'button[aria-label*="prefer" i]:visible, button[title*="prefer" i]:visible',
        )
        .first();
      if (await preferred.count()) {
        await preferred.click({ timeout: 3_000 }).catch(() => undefined);
        diagnostics.interactions += 1;
      }
      iteration += 1;
      await sleep(
        Math.min(20_000 + rnd(25_000), Math.max(500, deadlineAt - Date.now())),
      );
    }
    await page
      .screenshot({
        path: path.join(evidenceDir, `mobile-${index + 1}-end.png`),
        fullPage: true,
      })
      .catch(() => undefined);
  } finally {
    recorder.gui.push({
      kind: "mobile-realistic",
      index,
      deviceUuid: session.deviceUuid,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    });
    recorder.cover(
      "gui.mobile_real_frontend",
      diagnostics.interactions > 0 && diagnostics.responses5xx === 0,
      {
        device: index + 1,
        ...diagnostics,
      },
    );
    await context.close();
  }
}

async function readStationUiAuth(page) {
  return page.evaluate(() => {
    for (const storage of [window.sessionStorage, window.localStorage]) {
      try {
        const parsed = JSON.parse(
          storage.getItem("BAR_OPERATOR_AUTH_V1") || "null",
        );
        if (parsed?.token) return parsed;
      } catch {
        // Prova lo storage successivo.
      }
    }
    return null;
  });
}

function applyStationUiAuth(session, auth) {
  if (!auth?.token) return false;
  session.token = auth.token;
  session.auth = {
    ...session.auth,
    token: auth.token,
    userId: auth.userId || session.user.id,
    username: auth.username || session.user.username,
    fullName: auth.fullName || session.user.fullName,
  };
  return true;
}

async function verifyStationUiAuth(
  session,
  auth,
  type = "station.gui.session.verify",
) {
  if (!auth?.token) return { status: 401, body: { valid: false }, ok: true };
  const probeSession = {
    ...session,
    token: auth.token,
    auth: {
      ...session.auth,
      token: auth.token,
      userId: auth.userId || session.user.id,
      username: auth.username || session.user.username,
      fullName: auth.fullName || session.user.fullName,
    },
  };
  return request(
    probeSession,
    "POST",
    "/api/auth/session/status",
    {
      token: auth.token,
      userId: auth.userId || session.user.id,
      deviceUuid: session.deviceUuid,
      clientApp: "postazione",
    },
    {
      type,
      allowStatuses: [401],
    },
  );
}

async function logoutInvalidStationUiSession(page) {
  const logout = page.locator(".logout-btn");
  if (!(await logout.isVisible().catch(() => false))) return;
  await logout.click();
  const confirm = page.locator('[data-logout-action="confirm"]');
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  await confirm.click();
  await page
    .locator(".launch-btn")
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function loginStationFromRealUi(page, session) {
  const username = page.getByPlaceholder("Utente");
  const logout = page.locator(".logout-btn");
  let loginPayload = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await logout.isVisible().catch(() => false)) {
      const storedAuth = await readStationUiAuth(page);
      const currentSession = await verifyStationUiAuth(
        session,
        storedAuth,
        "station.gui.session.prelogin_verify",
      );
      if (
        currentSession.status === 200 &&
        currentSession.body?.valid === true
      ) {
        applyStationUiAuth(session, storedAuth);
        return currentSession;
      }
      await logoutInvalidStationUiSession(page);
    }
    if (await username.isVisible().catch(() => false)) break;
    let resolvedModals = 0;
    let quietSince = Date.now();
    while (Date.now() - quietSince < 1_500) {
      const pauseChoice = page.locator(
        '.postazione-pause-transfer-btn.keep[data-choice="suspend"]',
      );
      if (await pauseChoice.isVisible().catch(() => false)) {
        await pauseChoice.click();
        resolvedModals += 1;
        quietSince = Date.now();
      } else {
        await sleep(100);
      }
    }
    if (resolvedModals > 0) {
      recorder.cover("gui.station_pause_modal_resolved", true, {
        choice: "suspend",
        count: resolvedModals,
      });
    }
    if (await logout.isVisible().catch(() => false)) {
      const storedAuth = await readStationUiAuth(page);
      const currentSession = await verifyStationUiAuth(
        session,
        storedAuth,
        "station.gui.session.modal_verify",
      );
      if (
        currentSession.status === 200 &&
        currentSession.body?.valid === true
      ) {
        applyStationUiAuth(session, storedAuth);
        return currentSession;
      }
      await logoutInvalidStationUiSession(page);
    }
    const launch = page.locator(".launch-btn");
    await launch.waitFor({ state: "visible", timeout: 15_000 });
    await launch.click({ delay: 2_250 });
    const formVisible = await username
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (formVisible) break;
    await page.reload({ waitUntil: "domcontentloaded" }).catch(async () => {
      await page
        .waitForLoadState("domcontentloaded", { timeout: 5_000 })
        .catch(() => undefined);
    });
  }
  await username.waitFor({ state: "visible", timeout: 10_000 });
  await username.fill(session.user.username);
  await page.getByPlaceholder("PIN").fill("2222");
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/login" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: /^Accedi$/ }).click();
  let loginResponse = null;
  try {
    loginResponse = await loginResponsePromise;
  } catch (responseError) {
    const loginVisible = await logout
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const storedAuth = await readStationUiAuth(page);
    const verification = await verifyStationUiAuth(
      session,
      storedAuth,
      "station.gui.session.login_response_fallback",
    );
    const recovered =
      loginVisible &&
      verification.status === 200 &&
      verification.body?.valid === true;
    recorder.cover("gui.station_login_response_fallback", recovered, {
      loginVisible,
      status: verification.status,
    });
    if (!recovered) throw responseError;
    applyStationUiAuth(session, storedAuth);
    return verification;
  }
  loginPayload = await loginResponse.json().catch(() => null);
  if (
    !loginResponse.ok() ||
    loginPayload?.ok !== true ||
    !loginPayload?.token
  ) {
    throw new Error(
      `Login reale postazione fallito (${loginResponse.status()}): ${loginPayload?.error || "risposta non valida"}.`,
    );
  }
  await logout.waitFor({ state: "visible", timeout: 20_000 });
  await sleep(1_000);
  const storedAuth = await readStationUiAuth(page);
  const auth = loginPayload?.token
    ? {
        token: loginPayload.token,
        userId: loginPayload.user?.id,
        username: loginPayload.user?.username,
        fullName: loginPayload.user?.fullName,
      }
    : storedAuth;
  applyStationUiAuth(session, auth);
  const verification = await verifyStationUiAuth(session, auth);
  if (verification.status !== 200 || verification.body?.valid !== true) {
    throw new Error(
      `Sessione postazione non valida dopo il relogin (${verification.status}).`,
    );
  }
  recorder.cover("gui.station_real_login", true, {
    userId: session.auth.userId,
    deviceUuid: session.deviceUuid,
  });
  return verification;
}

async function runRealisticStationGui(
  browser,
  session,
  profileStartedAt,
  deadlineAt,
) {
  const stationIndex = 0;
  const station = activeStationNames[stationIndex];
  suppressedStationIndexes.add(stationIndex);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(
    ({ apiBase, auth, stationName }) => {
      const authSeedKey = "CASSAV5BT_LOADTEST_POSTAZIONE_AUTH_SEEDED";
      window.localStorage.setItem(
        "postazione_device_uuid",
        JSON.stringify(auth.deviceUuid),
      );
      window.localStorage.setItem(
        "BAR_POSTAZIONE_STATION_V1",
        JSON.stringify(stationName),
      );
      window.localStorage.setItem("BAR_API_BASE_URL", JSON.stringify(apiBase));
      window.API_BASE = apiBase;
      if (!window.localStorage.getItem(authSeedKey)) {
        window.localStorage.setItem(authSeedKey, "1");
        window.localStorage.setItem(
          "BAR_OPERATOR_SESSION_V1",
          JSON.stringify({
            loggedIn: true,
            userName: auth.fullName,
            userRole: auth.roleLabel,
          }),
        );
        window.localStorage.setItem(
          "BAR_OPERATOR_AUTH_V1",
          JSON.stringify({
            token: auth.token,
            userId: auth.userId,
            username: auth.username,
            fullName: auth.fullName,
          }),
        );
      }
    },
    {
      apiBase: frontendBaseUrl,
      stationName: station,
      auth: {
        token: session.token,
        userId: session.user.id,
        username: session.user.username,
        fullName: session.user.fullName,
        roleLabel: session.user.roleLabel,
        deviceUuid: session.deviceUuid,
      },
    },
  );
  const diagnostics = {
    requests: 0,
    responses4xx: 0,
    expected4xx: 0,
    responses5xx: 0,
    consoleErrors: 0,
    interactions: 0,
    consoleErrorSamples: [],
    responseErrorSamples: [],
  };
  let expectedInterruption = false;
  context.on("request", () => {
    diagnostics.requests += 1;
  });
  context.on("response", (response) => {
    const expectedFailure =
      expectedInterruption &&
      response.status() >= 400 &&
      response.status() < 500;
    if (response.status() >= 500) diagnostics.responses5xx += 1;
    else if (expectedFailure) diagnostics.expected4xx += 1;
    else if (response.status() >= 400) diagnostics.responses4xx += 1;
    if (
      response.status() >= 400 &&
      !expectedFailure &&
      diagnostics.responseErrorSamples.length < 10
    ) {
      diagnostics.responseErrorSamples.push({
        status: response.status(),
        url: response.url(),
      });
    }
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors += 1;
      if (diagnostics.consoleErrorSamples.length < 10)
        diagnostics.consoleErrorSamples.push(message.text());
    }
  });
  const evidenceDir = path.join(outputDir, "gui-evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const startedAt = Date.now();
  const logoutAt = profileStartedAt + Math.round(REALISTIC_DURATION_MS * 0.25);
  const outageAt = profileStartedAt + Math.round(REALISTIC_DURATION_MS * 0.62);
  let logoutDone = false;
  let outageDone = false;
  try {
    await page.goto(`${frontendBaseUrl}/postazione/`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(".logout-btn")
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.screenshot({
      path: path.join(evidenceDir, "station-1-start.png"),
      fullPage: true,
    });
    let iteration = 0;
    while (Date.now() < deadlineAt) {
      if (!logoutDone && Date.now() >= logoutAt) {
        logoutDone = true;
        expectedInterruption = true;
        suppressedStationIndexes.add(stationIndex);
        await stationHeartbeat(session, station, false, {
          pauseTransferMode: "transfer",
          pauseTransferTargetStation: activeStationNames[1],
        });
        await page.locator(".logout-btn").click();
        const logoutConfirm = page.locator('[data-logout-action="confirm"]');
        await logoutConfirm.waitFor({ state: "visible", timeout: 10_000 });
        await logoutConfirm.click();
        await page
          .locator(".launch-btn")
          .waitFor({ state: "visible", timeout: 10_000 });
        const authStorageCleared = await page
          .waitForFunction(
            () =>
              !window.localStorage.getItem("BAR_OPERATOR_AUTH_V1") &&
              !window.sessionStorage.getItem("BAR_OPERATOR_AUTH_V1"),
            null,
            { timeout: 5_000 },
          )
          .then(() => true)
          .catch(() => false);
        recorder.cover(
          "gui.station_logout_auth_storage_cleared",
          authStorageCleared,
        );
        if (!authStorageCleared) {
          throw new Error(
            "Il logout postazione non ha rimosso la sessione dagli storage browser.",
          );
        }
        await request(
          session,
          "POST",
          "/api/auth/logout",
          {},
          { type: "station.gui.logout", allowStatuses: [401] },
        );
        const offlineStartedAt = Date.now();
        await sleep(
          Math.min(
            REALISTIC_STATION_LOGOUT_MS,
            Math.max(5_000, deadlineAt - Date.now() - 5_000),
          ),
        );
        await loginStationFromRealUi(page, session);
        await stationHeartbeat(session, station, true);
        expectedInterruption = false;
        recorder.cover("station.logout_10m_relogin", true, {
          station,
          logoutMs: Date.now() - offlineStartedAt,
        });
      }
      if (!outageDone && Date.now() >= outageAt) {
        outageDone = true;
        const offlineStartedAt = Date.now();
        expectedInterruption = true;
        await context.setOffline(true);
        await sleep(
          Math.min(
            REALISTIC_NETWORK_OUTAGE_MS,
            Math.max(1_000, deadlineAt - Date.now() - 2_000),
          ),
        );
        await context.setOffline(false);
        const recoveryStarted = performance.now();
        await page
          .reload({ waitUntil: "domcontentloaded" })
          .catch(() => undefined);
        const recovered = await page
          .locator(".logout-btn")
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        expectedInterruption = false;
        recorder.cover("network.station_disconnect_reconnect", recovered, {
          offlineMs: Date.now() - offlineStartedAt,
          recoveryMs: Math.round(performance.now() - recoveryStarted),
        });
        if (!recovered)
          throw new Error(
            "La postazione non ha ripristinato la sessione dopo il blackout simulato.",
          );
      }
      const history = page.locator("#historyToggle");
      if (await history.count()) {
        await history.click({ force: true }).catch(() => undefined);
        diagnostics.interactions += 1;
      }
      const search = page.locator(".search-input");
      if (await search.count()) {
        await search
          .fill(iteration % 2 ? "#" : "tavolo")
          .catch(() => undefined);
        diagnostics.interactions += 1;
      }
      const menu = page.getByRole("button", { name: /^MENU$/ });
      if (await menu.count()) {
        await menu.click().catch(() => undefined);
        const close = page
          .locator('.modal-card:visible button[aria-label="Chiudi"]')
          .first();
        await close.click({ timeout: 3_000 }).catch(() => undefined);
        diagnostics.interactions += 1;
      }
      iteration += 1;
      await sleep(
        Math.min(25_000 + rnd(25_000), Math.max(500, deadlineAt - Date.now())),
      );
    }
    await page
      .screenshot({
        path: path.join(evidenceDir, "station-1-end.png"),
        fullPage: true,
      })
      .catch(() => undefined);
  } finally {
    suppressedStationIndexes.delete(stationIndex);
    recorder.gui.push({
      kind: "station-realistic",
      index: stationIndex,
      station,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    });
    recorder.cover(
      "gui.station_real_frontend",
      diagnostics.interactions > 0 && diagnostics.responses5xx === 0,
      diagnostics,
    );
    await context.close();
  }
}

async function waitUntilProfileTime(profileStartedAt, offsetMs, deadlineAt) {
  const target = Math.min(deadlineAt, profileStartedAt + offsetMs);
  if (Date.now() < target) await sleep(target - Date.now());
  return Date.now() < deadlineAt;
}

async function runAutomaticCashLifecycle(
  sessions,
  admin,
  sharedOrders,
  profileStartedAt,
  deadlineAt,
) {
  const cashFloats = [];
  const firstAtMs = Math.min(30_000, Math.round(REALISTIC_DURATION_MS * 0.03));
  const spacingMs = Math.max(
    5_000,
    Math.round(
      (REALISTIC_DURATION_MS * 0.82 - firstAtMs) / Math.max(1, sessions.length),
    ),
  );
  for (let index = 0; index < sessions.length; index += 1) {
    if (
      !(await waitUntilProfileTime(
        profileStartedAt,
        firstAtMs + index * spacingMs,
        deadlineAt,
      ))
    )
      break;
    const session = sessions[index];
    try {
      const cashFloat = await generateAutomaticCashFloat(session);
      if (cashFloat.cashFloatId) {
        cashFloats.push({ ...cashFloat, session, index });
        await openHandheldCashSession(
          session,
          Math.max(0.1, Number(cashFloat.totalCents || 1000) / 100),
        );
      }
      recorder.cover(
        "automatic_cash.float_each_handheld",
        Boolean(cashFloat.cashFloatId),
        {
          device: index + 1,
          cashFloatId: cashFloat.cashFloatId ?? null,
          status: cashFloat.generated?.status ?? null,
          code: cashFloat.generated?.body?.code ?? null,
          error: cashFloat.generated?.body?.error ?? null,
        },
      );

      if (index === 3) {
        for (
          let attempt = 0;
          attempt < 15 && sharedOrders.length === 0;
          attempt += 1
        )
          await sleep(1_000);
        const payment = await automaticCashPayment(
          session,
          selectUsableOrder(sharedOrders),
        );
        recorder.cover(
          "automatic_cash.real_payment_with_change",
          payment?.complete?.status === 200 &&
            operationSucceeded(payment.payment),
          {
            operationId: payment?.start?.body?.operationId ?? null,
            depositedTotalCents:
              payment?.state?.body?.depositedTotalCents ?? null,
          },
        );
      }
      if (index === 8) {
        const exchange = await automaticCashExchange(admin);
        recorder.cover(
          "automatic_cash.exchange",
          operationSucceeded(exchange.completed),
          { exchangeId: exchange.exchangeId ?? null },
        );
      }
      if (index === 12) {
        const restart = await request(
          admin,
          "POST",
          "/api/automatic-cash/gateway/restart",
          { reason: "loadtest" },
          {
            type: "automatic_cash.gateway.restart",
            allow409: true,
          },
        );
        const reset = await request(
          admin,
          "POST",
          "/api/automatic-cash/gateway/reset",
          { reason: "loadtest" },
          {
            type: "automatic_cash.gateway.reset",
            allow409: true,
          },
        );
        recorder.cover(
          "automatic_cash.restart_reset",
          operationSucceeded(restart) && operationSucceeded(reset),
          {
            restart: restart.status,
            reset: reset.status,
          },
        );
      }
    } catch (error) {
      recorder.cover("automatic_cash.float_each_handheld", false, {
        device: index + 1,
        error: String(error?.message || error),
      });
      recorder.failures.push({
        at: nowIso(),
        type: "automatic_cash.lifecycle",
        status: 0,
        detail: { device: index + 1, message: String(error?.message || error) },
      });
    }
  }
  return cashFloats;
}

async function settleAutomaticCashLifecycle(cashFloats, sessions, admin) {
  for (const entry of cashFloats) {
    try {
      const start = await request(
        admin,
        "POST",
        "/api/automatic-cash/deposit/start",
        {
          cashFloatId: entry.cashFloatId,
        },
        {
          type: "automatic_cash.deposit.start",
          allow409: true,
          allowStatuses: [400, 404],
        },
      );
      const operationId = start.body?.operationId;
      let close = null;
      if (operationId) {
        close = await request(
          admin,
          "POST",
          "/api/automatic-cash/deposit/close",
          {
            operationId,
            depositedTotalCents: 2000,
          },
          { type: "automatic_cash.deposit.close", allow409: true },
        );
        await request(
          admin,
          "POST",
          "/api/automatic-cash/settlements",
          {
            id: `load-settlement-${entry.cashFloatId}`,
            cashFloatId: entry.cashFloatId,
            operationId,
            expectedDepositTotalCents: entry.totalCents || 0,
            depositedTotalCents: close.body?.depositedTotalCents ?? 2000,
            completedAtMs: Date.now(),
            note: "Scarico finale loadtest realistico",
          },
          { type: "automatic_cash.settlement.save", allow409: true },
        );
      }
      await closeHandheldCashSession(
        entry.session,
        Math.max(0.1, Number(entry.totalCents || 1000) / 100),
      );
      recorder.cover(
        "automatic_cash.unload_each_handheld",
        Boolean(operationId && close?.status === 200),
        {
          device: entry.index + 1,
          cashFloatId: entry.cashFloatId,
          closeStatus: close?.status ?? null,
        },
      );
    } catch (error) {
      recorder.cover("automatic_cash.unload_each_handheld", false, {
        device: entry.index + 1,
        error: String(error?.message || error),
      });
    }
  }
  for (const session of sessions) {
    if (cashFloats.some((entry) => entry.session === session)) continue;
    await closeHandheldCashSession(session, 10).catch(() => undefined);
  }
  await request(
    admin,
    "POST",
    "/api/reports/handheld-session/print",
    {
      date: localDateKey(),
      activityId: "activity_default",
    },
    { type: "handheld.session.print", allow409: true },
  );
}

async function runConcurrentScenarioBatch(
  name,
  admin,
  sessions,
  tables,
  sharedOrders,
) {
  const order = selectUsableOrder(sharedOrders);
  const tasks = [
    listLayout(sessions[0]),
    publishNotification(sessions[1], tables[5], "waiter"),
    syncTableDetails(sessions[2], tables[15], {
      occupancyState: "seated",
      guestName: `Batch ${name}`,
    }),
    reservationFlow(sessions[3], tables[25]),
    readSettingsAndSearch(sessions[4], 2),
    order
      ? printOrder(admin, order, "preconto")
      : request(
          admin,
          "POST",
          "/api/reports/sales",
          {},
          { type: "history.payments" },
        ),
  ];
  const results = await Promise.allSettled(tasks);
  const ok = results.filter((result) => result.status === "fulfilled").length;
  recorder.cover("concurrency.6_different_actions", ok === 6, {
    name,
    fulfilled: ok,
  });
}

async function runVirtualPrinterFanoutProbe(admin, sharedOrders) {
  for (let attempt = 0; attempt < 20 && sharedOrders.length === 0; attempt += 1)
    await sleep(1_000);
  const order = selectUsableOrder(sharedOrders);
  if (!order) {
    recorder.cover("printing.four_station_queues", false, {
      error: "nessuna comanda disponibile",
    });
    return;
  }
  const results = [];
  for (let index = 0; index < VIRTUAL_PRINTERS.length; index += 1) {
    const printer = printerForStationIndex(index);
    const result = await printOrder(
      admin,
      order,
      index % 2 === 0 ? "order" : "preconto",
      printer,
    );
    results.push({
      printerId: printer.id,
      port: printer.port,
      status: result?.status ?? null,
    });
  }
  recorder.cover(
    "printing.four_station_requests",
    results.length === PRINTER_COUNT &&
      results.every((entry) => entry.status >= 200 && entry.status < 300),
    { results },
  );
}

async function runIdenticalScenarioBatch(name, session, table) {
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) =>
      publishNotification(
        session,
        { ...table, number: table.number + index },
        "waiter",
      ),
    ),
  );
  const ok = results.filter((result) => result.status === "fulfilled").length;
  recorder.cover("concurrency.6_identical_actions", ok === 6, {
    name,
    fulfilled: ok,
  });
}

async function runAdvancedReservationScenario(admin, table) {
  const serviceDate = localDateKey(new Date(Date.now() + 2 * 24 * 60 * 60_000));
  const created = await request(
    admin,
    "POST",
    "/api/pos/reservations/create",
    {
      roomId: table.roomId,
      serviceDate,
      reservationAt: Date.now() + 2 * 24 * 60 * 60_000,
      customerName: "Cliente prenotazione avanzata",
      customerPhone: "3331234567",
      covers: 4,
      assignedTableId: table.id,
      assignedTableIds: [table.id],
      intolerances: ["glutine", "lattosio"],
      note: "Prenotazione da modificare",
    },
    { type: "reservation.advanced.create", allow409: true },
  );
  const reservationId = created.body?.reservation?.id;
  if (!reservationId) return created;
  const lock = await request(
    admin,
    "POST",
    "/api/pos/reservations/lock/acquire",
    {
      roomId: table.roomId,
      serviceDate,
      reservationId,
    },
    { type: "reservation.advanced.lock", allow409: true },
  );
  const lockId = lock.body?.lock?.lockId;
  if (lockId) {
    await request(
      admin,
      "POST",
      "/api/pos/reservations/update",
      {
        roomId: table.roomId,
        serviceDate,
        reservationId,
        lockId,
        patch: {
          customerName: "Cliente prenotazione modificata",
          customerPhone: "3331234567",
          covers: 5,
          assignedTableId: table.id,
          assignedTableIds: [table.id],
          intolerances: ["frutta secca"],
          note: "Prenotazione modificata",
        },
      },
      { type: "reservation.advanced.update", allow409: true },
    );
  }
  const statusResults = [];
  for (const action of ["arrived", "no_show", "cancelled"]) {
    statusResults.push(
      await request(
        admin,
        "POST",
        "/api/pos/reservations/status",
        {
          roomId: table.roomId,
          serviceDate,
          reservationId,
          action,
        },
        { type: `reservation.advanced.${action}`, allow409: true },
      ),
    );
  }
  recorder.cover(
    "reservation.create_modify_arrive_no_show_cancel_intolerances",
    true,
    {
      reservationId,
      statuses: statusResults.map((result) => result.status),
    },
  );
  return created;
}

async function runRealisticScenarioEvents(
  admin,
  sessions,
  stationSessions,
  tables,
  sharedOrders,
  profileStartedAt,
  deadlineAt,
) {
  const schedule = async (ratio, name, task) => {
    if (
      !(await waitUntilProfileTime(
        profileStartedAt,
        Math.round(REALISTIC_DURATION_MS * ratio),
        deadlineAt,
      ))
    )
      return;
    try {
      await task();
      await writeEvent({ event: "realistic_scenario", name, ok: true });
    } catch (error) {
      recorder.cover(name, false, { error: String(error?.message || error) });
      recorder.failures.push({
        at: nowIso(),
        type: `scenario.${name}`,
        status: 0,
        detail: { message: String(error?.message || error) },
      });
      await writeEvent({
        event: "realistic_scenario",
        name,
        ok: false,
        error: String(error?.message || error),
      });
    }
  };

  await schedule(0.05, "menu_activation", async () => {
    const disabled = await setMenuItemAvailability(admin, "Mojito", false);
    await sleep(Math.min(10_000, Math.max(1_000, deadlineAt - Date.now())));
    const enabled = await setMenuItemAvailability(admin, "Mojito", true);
    recorder.cover(
      "menu.activate_deactivate",
      operationSucceeded(disabled) && operationSucceeded(enabled),
      {
        disabled: disabled.status,
        enabled: enabled.status,
      },
    );
  });

  await schedule(0.1, "station_pause_during_orders", async () => {
    const index = Math.min(1, stationSessions.length - 1);
    const station = activeStationNames[index];
    suppressedStationIndexes.add(index);
    await stationHeartbeat(stationSessions[index], station, false, {
      pauseTransferMode: "transfer",
      pauseTransferTargetStation:
        activeStationNames[(index + 1) % activeStationNames.length],
    });
    await sleep(
      Math.min(
        120_000,
        Math.max(5_000, Math.round(REALISTIC_DURATION_MS * 0.04)),
      ),
    );
    suppressedStationIndexes.delete(index);
    await stationHeartbeat(stationSessions[index], station, true);
    recorder.cover("station.pause_during_order_flow", true, { station });
  });

  await schedule(0.18, "concurrent_different_1", () =>
    runConcurrentScenarioBatch(
      "batch-1",
      admin,
      sessions,
      tables,
      sharedOrders,
    ),
  );
  await schedule(0.21, "virtual_printer_fanout", () =>
    runVirtualPrinterFanoutProbe(admin, sharedOrders),
  );
  await schedule(0.28, "advanced_reservation", () =>
    runAdvancedReservationScenario(admin, tables[42]),
  );

  await schedule(0.36, "all_stations_pause", async () => {
    const previouslySuppressed = new Set(suppressedStationIndexes);
    for (let index = 0; index < stationSessions.length; index += 1) {
      suppressedStationIndexes.add(index);
      await stationHeartbeat(
        stationSessions[index],
        activeStationNames[index],
        false,
      );
    }
    const created = await createOrder(admin, tables[77], {
      note: "Ordine mentre tutte le postazioni sono in pausa",
      withVariants: true,
    });
    if (created.body?.order) sharedOrders.push(created.body.order);
    await sleep(
      Math.min(
        60_000,
        Math.max(5_000, Math.round(REALISTIC_DURATION_MS * 0.025)),
      ),
    );
    for (let index = 0; index < stationSessions.length; index += 1) {
      if (previouslySuppressed.has(index)) continue;
      suppressedStationIndexes.delete(index);
      await stationHeartbeat(
        stationSessions[index],
        activeStationNames[index],
        true,
      );
    }
    recorder.cover(
      "station.all_paused_order_queued_resume",
      created.status === 200,
      {
        orderId: created.body?.order?.id ?? null,
        warning: created.body?.pausedStationWarning?.code ?? null,
      },
    );
  });

  await schedule(0.44, "room_change_denied_in_preparation", async () => {
    const created = await createOrder(admin, tables[91], {
      note: "Cambio sala negato durante preparazione",
    });
    const order = created.body?.order;
    if (order) {
      sharedOrders.push(order);
      await syncOrder(
        stationSessions[2] || stationSessions[1],
        order.id,
        "prep",
        activeStationNames[2] || activeStationNames[1],
      );
    }
    const restrictedSession = sessions[19];
    const requestResult = await request(
      restrictedSession,
      "POST",
      "/api/pos/room-change/request",
      {
        targetRoomId: "room_sala",
      },
      { type: "room.change.denied.request", allow409: true },
    );
    const requestId = requestResult.body?.requestId;
    const denied = requestId
      ? await request(
          restrictedSession,
          "POST",
          "/api/pos/room-change/approve",
          {
            requestId,
            approverUsername: "admin_load",
            approverPin: "9999",
          },
          {
            type: "room.change.denied.approve",
            allowStatuses: [400, 401, 403, 409],
          },
        )
      : requestResult;
    const authorizationDenied =
      denied.body?.ok === false || [400, 401, 403, 409].includes(denied.status);
    recorder.cover(
      "room_change.authorization_denied_while_preparing",
      authorizationDenied,
      {
        requestStatus: requestResult.status,
        deniedStatus: denied.status,
        requestState: requestResult.body?.status ?? null,
        deniedBody: denied.body ?? null,
      },
    );
  });

  await schedule(0.52, "identical_actions_1", () =>
    runIdenticalScenarioBatch("identical-1", sessions[6], tables[111]),
  );
  await schedule(0.64, "concurrent_different_2", () =>
    runConcurrentScenarioBatch(
      "batch-2",
      admin,
      sessions,
      tables,
      sharedOrders,
    ),
  );
  await schedule(0.72, "identical_actions_2", () =>
    runIdenticalScenarioBatch("identical-2", sessions[7], tables[121]),
  );

  await schedule(0.8, "payment_fiscal_reprint_conflict", async () => {
    const created = await createOrder(admin, tables[141], {
      note: "Pagamento fiscale e ristampa",
    });
    const order = created.body?.order;
    if (!order) return;
    sharedOrders.push(order);
    await syncOrder(
      stationSessions[2] || stationSessions[1],
      order.id,
      "delivered",
      activeStationNames[2] || activeStationNames[1],
    );
    let paid = await payOrder(admin, order, {
      amount: Math.min(Number(order.total || 1), 1),
      partial: true,
      issueFiscal: true,
      method: "POS",
    });
    if (!paid) {
      await sleep(500);
      paid = await payOrder(admin, order, {
        amount: Math.min(Number(order.total || 1), 1),
        partial: true,
        issueFiscal: true,
        method: "POS",
      });
    }
    const paymentId = paid?.body?.payment?.id;
    if (paymentId) await reprintPaymentMovement(admin, paymentId);
    await doublePaymentConflict(admin, sessions[8], order);
    recorder.cover(
      "payment.fiscal_nonfiscal_reprint_double_conflict",
      operationSucceeded(paid) && Boolean(paymentId),
      {
        paymentId: paymentId ?? null,
        paymentStatus: paid?.status ?? null,
      },
    );
  });

  await schedule(0.88, "concurrent_different_3", () =>
    runConcurrentScenarioBatch(
      "batch-3",
      admin,
      sessions,
      tables,
      sharedOrders,
    ),
  );
  await schedule(0.92, "settings_preferences_reports", async () => {
    for (let index = 0; index < Math.min(10, sessions.length); index += 1) {
      await request(
        sessions[index],
        "POST",
        "/api/settings/user/payment-preferences/save",
        {
          preferences: {
            counterCashDefaultSource: index % 2 ? "automatic" : "wallet",
          },
        },
        { type: "settings.payment_preferences.save" },
      );
      await readSettingsAndSearch(sessions[index], index);
    }
    await request(
      admin,
      "POST",
      "/api/reports/sales",
      {},
      { type: "history.payments.final" },
    );
    await request(
      admin,
      "POST",
      "/api/reports/non-fiscalized",
      {},
      { type: "history.non_fiscalized" },
    );
    recorder.cover("settings.searches_history_preferences", true);
  });
}

async function runP5CreateOrderAction(
  device,
  ordinal,
  tables,
  sharedOrders,
  reservedTableIds = null,
  inFlightTableIds = null,
) {
  const idempotencyKey = `load-create-${runId}-${device.session.deviceUuid}-${ordinal}`;
  const authorizedTables = tablesAuthorizedForSession(device.session, tables);
  if (authorizedTables.length === 0) {
    throw new Error(
      `Nessun tavolo autorizzato per ${device.session.user.username}.`,
    );
  }
  const createTableReservations =
    inFlightTableIds instanceof Set ? inFlightTableIds : new Set();
  const created = await runV5btOrderCreateRetry({
    idempotencyKey,
    maxAttempts: 5,
    attempt: async ({ attempt, idempotencyKey: stableKey }) => {
      const acquired = await acquireV5btOrderCreateTable({
        authorizedTables,
        reservedTableIds,
        inFlightTableIds: createTableReservations,
        timeoutMs: V5BT_ORDER_CREATE_TABLE_WAIT_MS,
        selectTable: (availableTables) => {
          return availableTables[
            (device.index * 53 + ordinal * 17 + (attempt - 1) * 73) %
              availableTables.length
          ];
        },
      });
      const { table, tableId } = acquired;
      try {
        return await createOrder(device.session, table, {
          long: ordinal % 100 === 1,
          withVariants: ordinal % 60 === 1,
          note: `P5 ${device.id} comanda ${device.orderCount + 1}: note e commenti`,
          idempotencyKey: stableKey,
          signal: AbortSignal.timeout(30_000),
        });
      } finally {
        createTableReservations.delete(tableId);
      }
    },
    wait: sleep,
    onRetry: (detail) => {
      void writeEvent({
        event: "v5bt_order_create_retry",
        device: device.id,
        ordinal,
        ...detail,
      });
    },
  });
  if (created?.status !== 200 || !created.body?.order) {
    throw new Error(
      `Creazione comanda ${device.id}/${ordinal} fallita (${created?.status ?? 0}, ${created?.body?.code ?? "no-code"}).`,
    );
  }
  const order = created.body.order;
  device.ownOrders.push(order);
  sharedOrders.push(order);
  device.orderCount += 1;
  recorder.cover("p5.orders.50_per_handheld", true, {
    device: device.id,
    ordinal,
    orderId: order.id,
  });
  return created;
}

async function createP5ScenarioOrder(
  session,
  tables,
  {
    seed = 0,
    label = "scenario",
    reservedTableIds = null,
    allowTableReuse = false,
  } = {},
) {
  const authorizedTables = availableV5btFixtureTables(
    tablesAuthorizedForSession(session, tables),
    { reservedTableIds, allowReuse: allowTableReuse },
  );
  if (authorizedTables.length === 0) {
    throw new Error(`Nessun tavolo autorizzato per lo scenario ${label}.`);
  }

  let created = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const table =
      authorizedTables[(seed * 37 + attempt * 73) % authorizedTables.length];
    created = await createOrder(session, table, {
      note: `P5 ${label}: comanda dedicata`,
      signal: AbortSignal.timeout(30_000),
    });
    if (created.status === 200 && created.body?.order) {
      if (reservedTableIds instanceof Set) {
        reservedTableIds.add(String(table.id));
      }
      return { created, order: created.body.order, attempt: attempt + 1 };
    }
    await sleep(200 + attempt * 150);
  }

  throw new Error(
    `Creazione comanda dedicata ${label} fallita (${created?.status ?? 0}, ${created?.body?.code ?? "no-code"}).`,
  );
}

const V5BT_READY_ORDER_ACTION_TYPES = new Set([
  "order.comp",
  "order.storno",
  "payment.amount_free",
  "payment.roman",
  "payment.article",
  "payment.single_cash",
  "payment.single_pos",
]);

function buildV5btTablePools(tables) {
  const byRoom = new Map();
  for (const table of Array.isArray(tables) ? tables : []) {
    const roomId = String(table?.roomId ?? "").trim();
    const roomTables = byRoom.get(roomId) ?? [];
    roomTables.push(table);
    byRoom.set(roomId, roomTables);
  }
  const runtimeTables = [];
  const fixtureTables = [];
  for (const roomTables of byRoom.values()) {
    const runtimeCount = Math.min(
      roomTables.length,
      Math.max(5, Math.min(10, Math.floor(roomTables.length / 4))),
    );
    fixtureTables.push(...roomTables.slice(0, -runtimeCount));
    runtimeTables.push(...roomTables.slice(-runtimeCount));
  }
  return { fixtureTables, runtimeTables };
}

function plannedV5btActions(device, predicate) {
  if (device.kind !== "handheld") return [];
  const planned = [];
  for (let ordinal = 1; ordinal <= V5BT_ACTIONS_PER_DEVICE; ordinal += 1) {
    const actionType = v5btMobileActionType(device.index, ordinal);
    if (predicate(actionType)) planned.push({ actionType, ordinal });
  }
  return planned;
}

async function prepareV5btOperationFixtures(devices, context) {
  const fixtureCounts = { handheld: 0, station: 0 };
  let tableMoveActionCount = 0;
  const dedicatedFixtureTableIds = new Set();
  const handheldsByConstraint = devices
    .filter((device) => device.kind === "handheld")
    .map((device) => ({
      device,
      authorizedTables: tablesAuthorizedForSession(
        device.session,
        context.fixtureTables,
      ),
    }))
    .sort(
      (left, right) =>
        left.authorizedTables.length - right.authorizedTables.length,
    );

  for (const { device, authorizedTables } of handheldsByConstraint) {
    const moveActions = plannedV5btActions(
      device,
      (actionType) => actionType === "table.move",
    );
    if (moveActions.length === 0) continue;
    const available = authorizedTables.filter(
      (table) => !context.reservedTableIds.has(String(table?.id ?? "")),
    );
    if (available.length < 2) {
      throw new Error(`Tavoli fixture insufficienti per ${device.id}.`);
    }
    const first = available[(device.index * 17) % available.length];
    const second = available.find((table) => table.id !== first.id);
    context.reservedTableIds.add(String(first.id));
    context.reservedTableIds.add(String(second.id));
    device.tableMoveFixtures.push(
      ...moveActions.map((_, index) =>
        index % 2 === 0
          ? { from: first, to: second }
          : { from: second, to: first },
      ),
    );
    tableMoveActionCount += moveActions.length;
    const sourcePrepared = await syncTableDetails(device.session, first, {
      occupancyState: "seated",
      covers: 2,
      note: "Fixture spostamento tavolo V5BT",
    });
    const targetPrepared = await syncTableDetails(device.session, second, {
      occupancyState: "free",
      covers: 0,
      note: "Fixture destinazione spostamento V5BT",
    });
    if (
      !operationSucceeded(sourcePrepared) ||
      !operationSucceeded(targetPrepared)
    ) {
      throw new Error(`Preparazione tavoli fixture fallita per ${device.id}.`);
    }
  }

  context.orderTables = context.fixtureTables.filter(
    (table) => !context.reservedTableIds.has(String(table?.id ?? "")),
  );
  const fixtureOrderTableIds = new Set();
  for (const [fixtureIndex, device] of devices.entries()) {
    const authorizedTables = tablesAuthorizedForSession(
      device.session,
      context.orderTables,
    );
    const fixture = await createP5ScenarioOrder(
      context.admin,
      authorizedTables,
      {
        seed: 50_000 + fixtureIndex,
        label: `fixture-${device.kind}-${fixtureIndex + 1}`,
        reservedTableIds: fixtureOrderTableIds,
        allowTableReuse: true,
      },
    );
    device.ownOrders.push(fixture.order);
    context.sharedOrders.push(fixture.order);
    dedicatedFixtureTableIds.add(String(fixture.order.tableId));
    fixtureCounts[device.kind] += 1;
  }

  const pendingReadyFixtures = [];
  for (const device of devices.filter(
    (candidate) => candidate.kind === "handheld",
  )) {
    const readyActions = plannedV5btActions(device, (actionType) =>
      V5BT_READY_ORDER_ACTION_TYPES.has(actionType),
    );
    const authorizedTables = tablesAuthorizedForSession(
      device.session,
      context.orderTables,
    );
    for (const [readyIndex, planned] of readyActions.entries()) {
      const fixture = await createP5ScenarioOrder(
        context.admin,
        authorizedTables,
        {
          seed: 80_000 + device.index * V5BT_ACTIONS_PER_DEVICE + readyIndex,
          label: `ready-${device.index + 1}-${planned.ordinal}-${planned.actionType}`,
          reservedTableIds: fixtureOrderTableIds,
          allowTableReuse: true,
        },
      );
      pendingReadyFixtures.push({ device, order: fixture.order, planned });
      dedicatedFixtureTableIds.add(String(fixture.order.tableId));
    }
  }

  context.orderTables = context.orderTables.filter(
    (table) => !dedicatedFixtureTableIds.has(String(table?.id ?? "")),
  );
  const excludedFixtureTableIds = new Set([
    ...context.reservedTableIds,
    ...dedicatedFixtureTableIds,
  ]);
  const orderTableCapacity = ensureV5btOrderTableCapacity({
    handhelds: devices,
    orderTables: context.orderTables,
    runtimeTables: context.runtimeTables,
    excludedTableIds: excludedFixtureTableIds,
    minimumPerHandheld: V5BT_RUNTIME_LIMITS.maxInFlightPerDevice + 1,
  });
  context.orderTables = orderTableCapacity.orderTables;

  const createdDrain = await waitForRelationalDrain(context.admin);
  if (createdDrain.drained !== true) {
    throw new Error(
      "Le comande fixture V5BT non hanno completato il drain relazionale prima del profilo.",
    );
  }

  for (const [readyIndex, fixture] of pendingReadyFixtures.entries()) {
    const stationIndex = readyIndex % context.stationSessions.length;
    const delivered = await syncOrderAtCurrentStation(
      context.stationSessions[stationIndex],
      fixture.order,
      "delivered",
      activeStationNames[stationIndex % activeStationNames.length],
    );
    if (!operationSucceeded(delivered)) {
      throw new Error(
        `Preparazione comanda pagabile fallita (${fixture.planned.actionType}, status=${delivered?.status ?? 0}, code=${delivered?.body?.code ?? "no-code"}).`,
      );
    }
    fixture.device.readyOrders.push(fixture.order);
  }

  const relationalDrain = await waitForRelationalDrain(context.admin);
  if (relationalDrain.drained !== true) {
    throw new Error(
      "Le comande pagabili V5BT non hanno completato il drain relazionale prima del profilo.",
    );
  }

  return {
    requested: devices.length + pendingReadyFixtures.length,
    created:
      fixtureCounts.handheld +
      fixtureCounts.station +
      pendingReadyFixtures.length,
    baseOrders: fixtureCounts.handheld + fixtureCounts.station,
    workflowReadyOrders: pendingReadyFixtures.length,
    handheldOrders: fixtureCounts.handheld,
    stationOrders: fixtureCounts.station,
    tableMovePairs: devices.filter(
      (device) => device.tableMoveFixtures.length > 0,
    ).length,
    tableMoveActions: tableMoveActionCount,
    dedicatedFixtureTables: dedicatedFixtureTableIds.size,
    runtimeOrderTables: context.orderTables.length,
    runtimeOrderTablesAdded: orderTableCapacity.addedTables.length,
    minimumAuthorizedOrderTables: orderTableCapacity.minimumPerHandheld,
    authorizedOrderTableCapacity: orderTableCapacity.capacityByHandheld,
    adminCreated: true,
    excludedFromExactDevicePersistence: true,
    relationalDrain: {
      drained: true,
      waitedMs: createdDrain.waitedMs + relationalDrain.waitedMs,
    },
  };
}

function runP5AutomaticCashExclusive(context, task) {
  const operation = context.automaticCashTail.then(task, task);
  context.automaticCashTail = operation.catch(() => undefined);
  return operation;
}

async function runP5SpecialHandheldAction(device, ordinal, context) {
  const {
    admin,
    handheldSessions,
    stationSessions,
    tables,
    sharedOrders,
    cashFloats,
  } = context;
  const index = device.index;

  if (ordinal === 2) {
    return runP5AutomaticCashExclusive(context, async () => {
      const cashFloat = await generateAutomaticCashFloat(device.session);
      if (!cashFloat.cashFloatId) {
        throw new Error(`Fondo cassa P5 non generato per ${device.id}.`);
      }
      cashFloats.push({ ...cashFloat, session: device.session, index });
      await openHandheldCashSession(
        device.session,
        Math.max(0.1, Number(cashFloat.totalCents || 1_000) / 100),
      );
      recorder.cover("automatic_cash.float_each_handheld", true, {
        device: index + 1,
        cashFloatId: cashFloat.cashFloatId,
      });
      return cashFloat;
    });
  }

  if (index === 0 && ordinal === 3) {
    const disabled = await setMenuItemAvailability(admin, "Mojito", false);
    const enabled = await setMenuItemAvailability(admin, "Mojito", true);
    recorder.cover(
      "menu.activate_deactivate",
      operationSucceeded(disabled) && operationSucceeded(enabled),
      {
        disabled: disabled.status,
        enabled: enabled.status,
      },
    );
    return enabled;
  }
  if (index === 1 && ordinal === 23) {
    return runAdvancedReservationScenario(admin, tables[42]);
  }
  if (index === 2 && ordinal === 43) {
    return runConcurrentScenarioBatch(
      "p5-different-1",
      admin,
      handheldSessions,
      tables,
      sharedOrders,
    );
  }
  if (index === 3 && ordinal === 63) {
    return runIdenticalScenarioBatch(
      "p5-identical-1",
      device.session,
      tables[111],
    );
  }
  if (index === 4 && ordinal === 83) {
    return runP5AutomaticCashExclusive(context, async () => {
      const scenarioOrder = await createP5ScenarioOrder(
        device.session,
        tables,
        {
          seed: index * 1_000 + ordinal,
          label: "cassa-automatica",
        },
      );
      const payment = await automaticCashPayment(
        device.session,
        scenarioOrder.order,
      );
      const ok =
        payment?.complete?.status === 200 &&
        operationSucceeded(payment.payment);
      const details = {
        orderId: scenarioOrder.order.id,
        createStatus: scenarioOrder.created.status,
        createAttempt: scenarioOrder.attempt,
        startStatus: payment?.start?.status ?? null,
        stateStatus: payment?.state?.status ?? null,
        completeStatus: payment?.complete?.status ?? null,
        paymentStatus: payment?.payment?.status ?? null,
        operationId: payment?.start?.body?.operationId ?? null,
        depositedTotalCents: payment?.state?.body?.depositedTotalCents ?? null,
      };
      recorder.cover("automatic_cash.real_payment_with_change", ok, details);
      if (!ok) {
        throw new Error(
          `Pagamento P5 con cassa automatica non completato (${JSON.stringify(details)}).`,
        );
      }
      return payment;
    });
  }
  if (index === 5 && ordinal === 103) {
    return runP5AutomaticCashExclusive(context, async () => {
      const exchange = await automaticCashExchange(admin);
      const ok = operationSucceeded(exchange.completed);
      recorder.cover("automatic_cash.exchange", ok, {
        exchangeId: exchange.exchangeId ?? null,
      });
      if (!ok)
        throw new Error("Cambio P5 con cassa automatica non completato.");
      return exchange;
    });
  }
  if (index === 6 && ordinal === 123) {
    return runP5AutomaticCashExclusive(context, async () => {
      const restart = await request(
        admin,
        "POST",
        "/api/automatic-cash/gateway/restart",
        { reason: "p5-endurance" },
        {
          type: "automatic_cash.gateway.restart",
          allow409: true,
        },
      );
      const reset = await request(
        admin,
        "POST",
        "/api/automatic-cash/gateway/reset",
        { reason: "p5-endurance" },
        {
          type: "automatic_cash.gateway.reset",
          allow409: true,
        },
      );
      const ok = operationSucceeded(restart) && operationSucceeded(reset);
      recorder.cover("automatic_cash.restart_reset", ok, {
        restart: restart.status,
        reset: reset.status,
      });
      if (!ok)
        throw new Error("Riavvio/reset P5 della cassa automatica fallito.");
      return reset;
    });
  }
  if (index === 7 && ordinal === 143) {
    return runVirtualPrinterFanoutProbe(admin, sharedOrders);
  }
  if (index === 8 && ordinal === 163) {
    return runFiscalSamples(device.session, sharedOrders, tables);
  }
  if (index === 9 && ordinal === 183) {
    return runAdminAdjustmentSamples(admin, sharedOrders, tables);
  }
  if (index === 10 && ordinal === 203) {
    return runConflictSamples(
      admin,
      handheldSessions[11],
      sharedOrders,
      tables,
    );
  }
  if (index === 11 && ordinal === 223) {
    const order = selectUsableOrder(sharedOrders);
    if (!order)
      throw new Error(
        "Nessuna comanda disponibile per il conflitto pagamento P5.",
      );
    return doublePaymentConflict(admin, device.session, order);
  }
  if (index === 12 && ordinal === 243) {
    const result = await request(
      device.session,
      "POST",
      "/api/settings/user/payment-preferences/save",
      {
        preferences: { counterCashDefaultSource: "automatic" },
      },
      { type: "settings.payment_preferences.save" },
    );
    await readSettingsAndSearch(device.session, ordinal);
    recorder.cover(
      "settings.searches_history_preferences",
      operationSucceeded(result),
    );
    return result;
  }
  if (index === 13 && ordinal === 263) {
    const created = await createOrder(admin, tables[91], {
      note: "P5 cambio sala negato durante preparazione",
    });
    const order = created.body?.order;
    if (order) {
      sharedOrders.push(order);
      await syncOrder(
        stationSessions[2] || stationSessions[0],
        order.id,
        "prep",
        activeStationNames[2] || activeStationNames[0],
      );
    }
    const restrictedSession = handheldSessions[19] || device.session;
    const result = await roomChange(restrictedSession, "room_sala", {
      expectDenied: true,
    });
    recorder.cover(
      "room_change.authorization_denied_while_preparing",
      [400, 401, 403, 409].includes(result?.status),
      {
        status: result?.status ?? null,
      },
    );
    return result;
  }
  if (index === 14 && ordinal === 283) {
    return runConcurrentScenarioBatch(
      "p5-different-2",
      admin,
      handheldSessions,
      tables,
      sharedOrders,
    );
  }
  if (index === 15 && ordinal === 303) {
    return runIdenticalScenarioBatch(
      "p5-identical-2",
      device.session,
      tables[121],
    );
  }
  if (index === 16 && ordinal === 323) {
    return request(
      admin,
      "POST",
      "/api/reports/sales",
      {},
      { type: "history.payments.p5" },
    );
  }
  if (index === 17 && ordinal === 343) {
    return request(
      admin,
      "POST",
      "/api/reports/non-fiscalized",
      {},
      { type: "history.non_fiscalized.p5" },
    );
  }
  if (index === 18 && ordinal === 363) {
    return runAdvancedReservationScenario(admin, tables[142]);
  }
  if (index === 19 && ordinal === 383) {
    const result = await roomChange(device.session, "room_sala", {
      expectDenied: true,
    });
    recorder.cover(
      "room.change.authorization_denied",
      [400, 401, 403, 409].includes(result?.status),
      {
        status: result?.status ?? null,
      },
    );
    return result;
  }
  return null;
}

async function runP5HandheldAction(device, ordinal, context) {
  if (device.gui && ordinal % P5_GUI_ACTION_EVERY === 0) {
    const result = await device.gui.performAction(ordinal);
    const actionType = `gui.mobile.${result?.kind ?? "unknown"}`;
    return p5ActionOutcome(
      result,
      actionType,
      isP5DisruptiveActionType(actionType),
    );
  }
  const special = await runP5SpecialHandheldAction(device, ordinal, context);
  if (special !== null) {
    return p5ActionOutcome(
      special,
      special?.p5ActionType ?? special?.kind ?? "handheld.special",
    );
  }
  if (ordinal % 20 === 1) {
    const created = await runP5CreateOrderAction(
      device,
      ordinal,
      context.tables,
      context.sharedOrders,
    );
    return p5ActionOutcome(created, "order.create");
  }
  const result = await runRealisticOtherAction(
    device.index,
    ordinal,
    device.session,
    device.ownOrders,
    context.sharedOrders,
    context.tables,
  );
  return p5ActionOutcome(result, result?.p5ActionType ?? "handheld.other");
}

function v5btOperationOutcome(result, actionType) {
  return {
    ...p5ActionOutcome(result, actionType),
    operationOk: operationSucceeded(result),
  };
}

function v5btOperationFailureDetails(value) {
  const result = value?.result ?? value;
  const candidates = [result, result?.paused, result?.resumed].filter(Boolean);
  const failed =
    candidates.find((candidate) => !operationSucceeded(candidate)) ?? result;
  const safeText = (entry) => {
    const text = String(entry ?? "").trim();
    return text ? text.slice(0, 240) : null;
  };
  return {
    status: Number.isFinite(Number(failed?.status))
      ? Number(failed.status)
      : null,
    businessCode: safeText(failed?.body?.code),
    businessError: safeText(failed?.body?.error),
  };
}

function selectV5btOperationOrder(device, context, actionType) {
  const ownOrders = Array.isArray(device.ownOrders) ? device.ownOrders : [];
  const readyOrders = Array.isArray(device.readyOrders)
    ? device.readyOrders
    : [];
  const sharedOrders = Array.isArray(context.sharedOrders)
    ? context.sharedOrders
    : [];
  const paymentReserved = context.paymentOrderIds;
  const operationReserved = context.operationOrderIds;
  const tableReserved = context.operationTableIds;
  const createTablesInFlight = context.inFlightCreateTableIds;
  if (
    !(paymentReserved instanceof Set) ||
    !(operationReserved instanceof Set) ||
    !(tableReserved instanceof Set) ||
    !(createTablesInFlight instanceof Set)
  ) {
    return selectUsableOrder(ownOrders.length > 0 ? ownOrders : sharedOrders);
  }
  const isAvailable = (candidate) => {
    const id = String(candidate?.id || "").trim();
    const tableId = String(candidate?.tableId || "").trim();
    return (
      id &&
      !paymentReserved.has(id) &&
      !operationReserved.has(id) &&
      (!tableId ||
        (!tableReserved.has(tableId) &&
          !createTablesInFlight.has(tableId)))
    );
  };
  const reserve = (candidate, { payment = false } = {}) => {
    const id = String(candidate?.id || "").trim();
    const tableId = String(candidate?.tableId || "").trim();
    if (id) operationReserved.add(id);
    if (tableId) tableReserved.add(tableId);
    if (payment && id) paymentReserved.add(id);
    return candidate;
  };
  const ownAvailable = ownOrders.filter(isAvailable);
  const sharedAvailable = sharedOrders.filter(isAvailable);
  const pool = ownAvailable.length > 0 ? ownAvailable : sharedAvailable;
  const requiresReadyOrder = V5BT_READY_ORDER_ACTION_TYPES.has(actionType);

  if (requiresReadyOrder) {
    const readyOrder = readyOrders.filter(isAvailable).at(-1) || null;
    return readyOrder
      ? reserve(readyOrder, {
          payment: String(actionType).startsWith("payment."),
        })
      : null;
  }

  if (!String(actionType).startsWith("payment.")) {
    const selected =
      actionType === "order.correct" ? pool[0] || null : pool.at(-1) || null;
    return selected && /^(?:order|print)\./.test(String(actionType))
      ? reserve(selected)
      : selected;
  }

  const uniqueUnreserved = (orders) =>
    orders.filter((candidate, index, all) => {
      const id = String(candidate?.id || "").trim();
      return (
        isAvailable(candidate) &&
        all.findIndex((entry) => String(entry?.id || "").trim() === id) ===
          index
      );
    });
  const uniqueOwnAvailable = uniqueUnreserved(ownOrders);
  const paymentPool =
    uniqueOwnAvailable.length > 0
      ? uniqueOwnAvailable
      : uniqueUnreserved(sharedOrders);
  const paymentOrder = paymentPool.at(-1) || null;
  return paymentOrder ? reserve(paymentOrder, { payment: true }) : null;
}

async function waitForV5btReadyOrder(device, context, actionType) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const order = selectV5btOperationOrder(device, context, actionType);
    if (order) return order;
    if (attempt < 12) await sleep(100 + attempt * 25);
  }
  return null;
}

function nextV5btReservationAt(context, table) {
  const tableId = String(table?.id ?? "").trim();
  const slots = context.reservationSlotsByTableId;
  const firstSlot = Date.now() + 24 * 60 * 60_000;
  if (!tableId || !(slots instanceof Map)) return firstSlot;
  const previousSlot = Number(slots.get(tableId));
  const reservationAt = Number.isFinite(previousSlot)
    ? Math.max(firstSlot, previousSlot + 61 * 60_000)
    : firstSlot;
  slots.set(tableId, reservationAt);
  return reservationAt;
}

async function runV5btOperationsHandheldAction(
  device,
  ordinal,
  actionType,
  context,
) {
  if (actionType === "order.create") {
    const created = await runP5CreateOrderAction(
      device,
      ordinal,
      context.orderTables,
      context.sharedOrders,
      context.operationTableIds,
      context.inFlightCreateTableIds,
    );
    return v5btOperationOutcome(created, actionType);
  }

  const session = device.session;
  const order = V5BT_READY_ORDER_ACTION_TYPES.has(actionType)
    ? await waitForV5btReadyOrder(device, context, actionType)
    : selectV5btOperationOrder(device, context, actionType);
  const reservedOrderTableId = String(order?.tableId || "").trim();
  try {
    if (V5BT_READY_ORDER_ACTION_TYPES.has(actionType) && !order) {
      throw new Error(`Fixture pagabile mancante per ${device.id}/${actionType}.`);
    }
    const authorizedTables = tablesAuthorizedForSession(
      session,
      context.runtimeTables,
    );
    if (authorizedTables.length === 0) {
      throw new Error(`Nessun tavolo autorizzato per ${device.id}.`);
    }
  const table =
    authorizedTables[
      (device.index * 31 + ordinal * 11) % authorizedTables.length
    ];
  const otherTable =
    authorizedTables[
      (device.index * 37 + ordinal * 13 + 1) % authorizedTables.length
    ];
  const targetStation =
    activeStationNames[
      (device.index + ordinal + 1) % activeStationNames.length
    ];
  let result = null;

  if (actionType === "order.sync.ready" && order) {
    result = await syncOrderAtCurrentStation(
      session,
      order,
      "ready",
      targetStation,
    );
  } else if (actionType === "order.sync.delivered" && order) {
    result = await syncOrderAtCurrentStation(
      session,
      order,
      "delivered",
      targetStation,
    );
  } else if (actionType === "order.correct" && order) {
    result = await correctOrder(session, order);
  } else if (actionType === "order.comp" && order) {
    result = await compOrder(session, order);
  } else if (actionType === "order.storno" && order) {
    result = await stornoOrder(session, order);
  } else if (actionType === "order.cancel" && order) {
    result = await cancelOrder(session, order);
  } else if (actionType === "order.line_split" && order) {
    result = await splitOrderLine(session, order);
  } else if (actionType === "order.price_override" && order) {
    result = await overrideOrderLinePrice(session, order, {
      logicalActionId: `${runId}:handheld:${device.index + 1}:${ordinal}:${actionType}`,
    });
  } else if (actionType === "order.bar_replacement" && order) {
    result = await barReplacementOrder(session, order);
  } else if (actionType === "payment.amount_free" && order) {
    result = await payOrder(session, order, {
      partial: true,
      splitMode: "amount",
      method: "CASH",
      note: "Importo libero simulazione V5BT",
    });
  } else if (actionType === "payment.roman" && order) {
    result = await payOrder(session, order, {
      partial: true,
      splitMode: "roman",
      method: "CASH",
    });
  } else if (actionType === "payment.article" && order) {
    result = await payOrder(session, order, {
      partial: true,
      splitMode: "article",
      method: "CASH",
    });
  } else if (actionType === "payment.single_cash" && order) {
    result = await payOrder(session, order, {
      splitMode: "single",
      method: "CASH",
    });
  } else if (actionType === "payment.single_pos" && order) {
    result = await payOrder(session, order, {
      splitMode: "single",
      method: "POS",
    });
  } else if (actionType === "print.order" && order) {
    result = await printOrder(session, order, "order");
  } else if (actionType === "print.preconto" && order) {
    result = await printOrder(session, order, "preconto");
  } else if (actionType === "table.move") {
    const fixture = device.tableMoveFixtures.shift();
    if (!fixture) {
      throw new Error(`Fixture spostamento mancante per ${device.id}.`);
    }
    result = await moveTable(session, fixture.from, fixture.to);
  } else if (actionType === "table.room_move_request") {
    const targets = authorizedTables.filter(
      (candidate) => candidate.roomId !== table.roomId,
    );
    result =
      targets.length > 0
        ? await roomMoveRequest(
            session,
            table,
            targets[(device.index + ordinal) % targets.length],
          )
        : await listLayout(session);
  } else if (actionType === "table.group.merge") {
    result = await saveTableGroup(session, table, otherTable, false);
  } else if (actionType === "table.group.split") {
    result = await saveTableGroup(session, table, otherTable, true);
  } else if (actionType === "reservation.lifecycle") {
    result = await reservationFlow(session, table, {
      reservationAt: nextV5btReservationAt(context, table),
    });
  } else if (actionType === "notification.ready") {
    result = await publishNotification(session, table, "ready");
  } else if (actionType === "notification.waiter") {
    result = await publishNotification(session, table, "waiter");
  } else if (actionType === "waiter.pause_resume") {
    const paused = await waiterPause(session, true);
    const resumed = await waiterPause(session, false);
    result = {
      ok: operationSucceeded(paused) && operationSucceeded(resumed),
      paused,
      resumed,
    };
  } else if (actionType === "settings.search_history_battery") {
    result = await readSettingsAndSearch(session, ordinal);
  } else if (actionType === "table.occupancy") {
    result = await syncTableDetails(session, table, {
      occupancyState: ordinal % 2 ? "seated" : "free",
    });
  } else if (actionType === "workspace.tables_counter_switch") {
    result = device.gui?.performTablesCounterSwitch
      ? await device.gui.performTablesCounterSwitch(ordinal)
      : await listLayout(session);
  } else if (actionType === "counter.collect") {
    result = await collectCounterOrder(session, ordinal);
  } else if (actionType === "order.transfer.force" && order) {
    result = await forceTransferOrder(session, order, targetStation);
  } else if (actionType === "order.transfer.request_resolve" && order) {
    result = await requestAndResolveOrderTransfer(
      session,
      order,
      targetStation,
    );
  } else if (actionType === "room.change") {
    result = await roomChange(
      session,
      rooms[(device.index + ordinal) % (rooms.length - 1)].id,
      {
        expectDenied: session.user.username === "op20",
      },
    );
  } else if (actionType === "search.all") {
    result = await readSettingsAndSearch(session, ordinal + 3);
  } else if (actionType === "layout.get") {
    result = await listLayout(session);
  } else if (actionType === "station.states.get") {
    result = await request(
      session,
      "GET",
      "/api/integration/stations/state",
      {},
      {
        type: "station.states.get.mobile",
      },
    );
  } else {
    throw new Error(`Azione V5BT non gestita: ${actionType}.`);
  }

    recorder.cover(`v5bt.operations.${actionType}`, operationSucceeded(result), {
      device: device.index + 1,
      ordinal,
      status: result?.status ?? null,
    });
    return v5btOperationOutcome(result, actionType);
  } finally {
    if (reservedOrderTableId) {
      context.operationTableIds.delete(reservedOrderTableId);
    }
  }
}

async function runV5btOperationsStationAction(
  device,
  ordinal,
  actionType,
  context,
) {
  if (suppressedStationIndexes.has(device.index)) {
    return v5btOperationOutcome({ ok: true, suppressed: true }, actionType);
  }
  const requiresOrder = /^(?:station\.order|station\.print)\./.test(actionType);
  const availableOrders = (orders) =>
    (Array.isArray(orders) ? orders : []).filter((candidate) => {
      const id = String(candidate?.id || "").trim();
      const tableId = String(candidate?.tableId || "").trim();
      return (
        id &&
        !context.paymentOrderIds.has(id) &&
        !context.operationOrderIds.has(id) &&
        (!tableId ||
          (!context.operationTableIds.has(tableId) &&
            !context.inFlightCreateTableIds.has(tableId)))
      );
    });
  const ownOrders = availableOrders(device.ownOrders);
  const sharedOrders = availableOrders(context.sharedOrders);
  const order = requiresOrder
    ? ownOrders.at(-1) || sharedOrders.at(-1) || null
    : null;
  const eligibleOrderIds = new Set(
    order ? [String(order.id ?? "").trim()].filter(Boolean) : [],
  );
  if (order) {
    context.operationOrderIds.add(String(order.id));
    const tableId = String(order.tableId || "").trim();
    if (tableId) context.operationTableIds.add(tableId);
  }
  const reservedOrderTableId = String(order?.tableId || "").trim();
  try {
    const workflowOptions = {
      reservedOrderIds: context.operationOrderIds,
      eligibleOrderIds,
    };
    let result = null;
    if (actionType === "station.heartbeat") {
      result = await stationHeartbeat(device.session, device.station, true);
    } else if (actionType === "station.orders.poll") {
      result = await pollOrders(device.session, device.station);
    } else if (actionType === "station.order.prep" && order) {
      result = await performStationWorkflowAction(
        device.session,
        order,
        "prep",
        device.station,
        workflowOptions,
      );
    } else if (actionType === "station.order.ready" && order) {
      result = await performStationWorkflowAction(
        device.session,
        order,
        "ready",
        device.station,
        workflowOptions,
      );
    } else if (actionType === "station.order.delivered" && order) {
      result = await performStationWorkflowAction(
        device.session,
        order,
        "delivered",
        device.station,
        workflowOptions,
      );
    } else if (actionType === "station.order.transfer" && order) {
      result = await forceTransferOrder(
        device.session,
        order,
        activeStationNames[(device.index + 1) % activeStationNames.length],
      );
    } else if (actionType === "station.print.virtual" && order) {
      result = await printOrder(
        device.session,
        order,
        ordinal % 2 ? "order" : "preconto",
        printerForStationIndex(device.index),
      );
    } else if (actionType === "station.states.get") {
      result = await request(
        device.session,
        "GET",
        "/api/integration/stations/state",
        {},
        {
          type: actionType,
        },
      );
    }
    recorder.cover(`v5bt.operations.${actionType}`, operationSucceeded(result), {
      station: device.station,
      ordinal,
      status: result?.status ?? null,
    });
    return v5btOperationOutcome(result, actionType);
  } finally {
    if (reservedOrderTableId) {
      context.operationTableIds.delete(reservedOrderTableId);
    }
  }
}

async function runP5StationAction(device, ordinal, context) {
  if (device.gui && ordinal % P5_GUI_ACTION_EVERY === 0) {
    try {
      const result = await device.gui.performAction(ordinal);
      const actionType = `gui.station.${result?.kind ?? "unknown"}`;
      return p5ActionOutcome(
        result,
        actionType,
        isP5DisruptiveActionType(actionType),
      );
    } catch (error) {
      const actionType = `gui.station.${error?.p5ActionKind ?? "unknown"}`;
      throw tagP5ActionError(
        error,
        actionType,
        isP5DisruptiveActionType(actionType),
      );
    }
  }
  if (suppressedStationIndexes.has(device.index)) {
    recorder.cover("station.p5_suppressed_during_logout_or_pause", true, {
      station: device.station,
      ordinal,
    });
    return p5ActionOutcome(
      { ok: true, suppressed: true },
      "station.suppressed",
    );
  }
  const order = selectUsableOrder(context.sharedOrders);
  const variant = (device.index * 3 + ordinal) % 8;
  let name = "station.heartbeat";
  let result;
  if (variant === 0) {
    result = await stationHeartbeat(device.session, device.station, true);
  } else if (variant === 1) {
    name = "station.orders.poll";
    result = await pollOrders(device.session, device.station);
  } else if (variant === 2 && order) {
    name = "station.order.prep";
    result = await performStationWorkflowAction(
      device.session,
      order,
      "prep",
      device.station,
    );
  } else if (variant === 3 && order) {
    name = "station.order.ready";
    result = await performStationWorkflowAction(
      device.session,
      order,
      "ready",
      device.station,
    );
  } else if (variant === 4 && order) {
    name = "station.order.delivered";
    result = await performStationWorkflowAction(
      device.session,
      order,
      "delivered",
      device.station,
    );
  } else if (variant === 5 && order) {
    name = "station.order.transfer";
    result = await forceTransferOrder(
      device.session,
      order,
      activeStationNames[(device.index + 1) % activeStationNames.length],
    );
  } else if (variant === 6 && order) {
    name = "station.print.virtual";
    result = await printOrder(
      device.session,
      order,
      ordinal % 2 ? "order" : "preconto",
      printerForStationIndex(device.index),
    );
  } else {
    name = "station.states.get";
    result = await request(
      device.session,
      "GET",
      "/api/integration/stations/state",
      {},
      { type: name },
    );
  }
  recorder.cover(`p5.${name}`, operationSucceeded(result), {
    station: device.station,
    ordinal,
    status: result?.status ?? null,
  });
  return p5ActionOutcome(result, name);
}

function recordP5ProfileFailures(profile) {
  const quotaFailures = profile.devices.filter(
    (device) =>
      device.started !== P5_ACTIONS_PER_DEVICE ||
      device.completed !== P5_ACTIONS_PER_DEVICE,
  );
  const checks = [
    [profile.totalStarted !== P5_TOTAL_ACTIONS, "p5.actions.total_started"],
    [profile.totalCompleted !== P5_TOTAL_ACTIONS, "p5.actions.total_completed"],
    [profile.totalFailed > 0, "p5.actions.exceptions"],
    [quotaFailures.length > 0, "p5.actions.device_quota"],
    [profile.rate.ok !== true, "p5.actions.rate_limit"],
  ];
  for (const [failed, type] of checks) {
    if (!failed) continue;
    recorder.failures.push({
      at: nowIso(),
      type,
      status: 0,
      detail: {
        expectedTotal: P5_TOTAL_ACTIONS,
        totalStarted: profile.totalStarted,
        totalCompleted: profile.totalCompleted,
        quotaFailures: quotaFailures.map((device) => device.id),
        rate: profile.rate,
      },
    });
  }
}

function recordV5btOperationsProfileFailures(profile, actionSamples) {
  const quotaFailures = profile.devices.filter(
    (device) =>
      device.started !== V5BT_ACTIONS_PER_DEVICE ||
      device.completed !== V5BT_ACTIONS_PER_DEVICE,
  );
  const requiredMobileTypes = ["order.create", ...V5BT_MOBILE_OPERATION_TYPES];
  const mobileSamples = actionSamples.filter(
    (sample) => sample.kind === "handheld",
  );
  const coverage = Object.fromEntries(
    requiredMobileTypes.map((type) => {
      const samples = mobileSamples.filter((sample) => sample.type === type);
      return [
        type,
        {
          attempted: samples.length,
          completed: samples.filter((sample) => sample.ok).length,
          businessSucceeded: samples.filter((sample) => sample.operationOk)
            .length,
          exceptions: samples.filter((sample) => !sample.ok).length,
        },
      ];
    }),
  );
  const missingTypes = requiredMobileTypes.filter(
    (type) => coverage[type].attempted === 0,
  );
  const typesWithoutSuccess = requiredMobileTypes.filter(
    (type) => coverage[type].businessSucceeded === 0,
  );
  profile.requiredMobileActionTypes = requiredMobileTypes;
  profile.mobileActionCoverage = coverage;
  profile.missingMobileActionTypes = missingTypes;
  profile.mobileActionTypesWithoutSuccess = typesWithoutSuccess;
  profile.cadenceGate = {
    basis: profile.cadence?.cadenceBasis ?? null,
    actionIntervalMs: V5BT_DEVICE_ACTION_INTERVAL_MS,
    commandIntervalMinMs: V5BT_COMMAND_INTERVAL_MIN_MS,
    commandIntervalMaxMs: V5BT_COMMAND_INTERVAL_MAX_MS,
    mobileActionCadenceOk: profile.cadence?.mobileActionCadenceOk === true,
    commandCadenceOk: profile.cadence?.commandCadenceOk === true,
    earlyActionGaps: profile.cadence?.earlyActionGaps ?? null,
    earlyDispatchActionGaps:
      profile.cadence?.earlyDispatchActionGaps ?? null,
  };

  const checks = [
    [
      profile.totalStarted !== V5BT_TOTAL_ACTIONS,
      "v5bt.operations.total_started",
    ],
    [
      profile.totalCompleted !== V5BT_TOTAL_ACTIONS,
      "v5bt.operations.total_completed",
    ],
    [profile.totalFailed > 0, "v5bt.operations.action_exceptions"],
    [quotaFailures.length > 0, "v5bt.operations.device_quota"],
    [missingTypes.length > 0, "v5bt.operations.action_coverage_missing"],
    [typesWithoutSuccess.length > 0, "v5bt.operations.action_without_success"],
    [
      profile.cadence?.mobileActionCadenceOk !== true,
      "v5bt.operations.mobile_cadence",
    ],
    [
      profile.cadence?.commandCadenceOk !== true,
      "v5bt.operations.command_cadence",
    ],
    [
      profile.runtimeGate?.checks?.noEarlyActionBursts !== true,
      "v5bt.operations.early_action_burst",
    ],
    [
      profile.runtimeGate?.checks?.noEarlyDispatchActionBursts !== true,
      "v5bt.operations.early_dispatch_action_burst",
    ],
    [
      profile.runtimeGate?.checks?.globalInFlightWithinLimit !== true,
      "v5bt.operations.global_backpressure",
    ],
    [
      profile.runtimeGate?.checks?.perDeviceInFlightWithinLimit !== true,
      "v5bt.operations.device_backpressure",
    ],
    [
      profile.runtimeGate?.checks?.actionP95WithinLimit !== true,
      "v5bt.operations.action_p95",
    ],
    [
      profile.runtimeGate?.checks?.commandP95WithinLimit !== true,
      "v5bt.operations.command_p95",
    ],
    [
      profile.runtimeGate?.checks?.actionMaximumWithinLimit !== true,
      "v5bt.operations.action_timeout",
    ],
    [
      profile.runtimeGate?.checks?.guiRequestBudgetWithinLimit !== true,
      "v5bt.operations.gui_request_amplification",
    ],
  ];
  for (const [failed, type] of checks) {
    if (!failed) continue;
    recorder.failures.push({
      at: nowIso(),
      type,
      status: 0,
      detail: {
        expectedTotal: V5BT_TOTAL_ACTIONS,
        totalStarted: profile.totalStarted,
        totalCompleted: profile.totalCompleted,
        quotaFailures: quotaFailures.map((device) => device.id),
        missingTypes,
        typesWithoutSuccess,
        cadence: profile.cadence,
        runtimeGate: profile.runtimeGate,
      },
    });
  }
}

async function runP5EnduranceProfile({
  browser,
  admin,
  handheldSessions,
  stationSessions,
  tables,
  sharedOrders,
}) {
  if (!browser)
    throw new Error("Il profilo azioni richiede Chrome per le GUI reali.");
  const operationsProfile = V5BT_OPERATIONS_PROFILE;
  const actionsPerDevice = operationsProfile
    ? V5BT_ACTIONS_PER_DEVICE
    : P5_ACTIONS_PER_DEVICE;
  const totalActions = operationsProfile
    ? V5BT_TOTAL_ACTIONS
    : P5_TOTAL_ACTIONS;
  const minimumDurationMs = operationsProfile
    ? V5BT_MINIMUM_DURATION_MS
    : P5_MINIMUM_DURATION_MS;
  const profileEventPrefix = operationsProfile ? "v5bt_operations" : "p5";
  const evidenceDir = path.join(outputDir, "gui-evidence");
  const guiControllers = [];
  const mobileGuiCount = Math.min(2, GUI_COUNT, HANDHELD_COUNT);
  for (let index = 0; index < mobileGuiCount; index += 1) {
    guiControllers.push(
      await createP5MobileGuiController({
        browser,
        index,
        session: handheldSessions[index],
        frontendBaseUrl,
        evidenceDir,
        totalActions: actionsPerDevice,
        longPressMs: P5_LONG_PRESS_MS,
        networkOutageMs: REALISTIC_NETWORK_OUTAGE_MS,
        onCoverage: (...args) => recorder.cover(...args),
        onComplete: (diagnostics) => recorder.gui.push(diagnostics),
      }),
    );
  }

  const stationGui = await createP5StationGuiController({
    browser,
    index: 0,
    session: stationSessions[0],
    stationName: activeStationNames[0],
    frontendBaseUrl,
    evidenceDir,
    totalActions: actionsPerDevice,
    longPressMs: P5_LONG_PRESS_MS,
    networkOutageMs: REALISTIC_NETWORK_OUTAGE_MS,
    logoutMs: REALISTIC_STATION_LOGOUT_MS,
    onCoverage: (...args) => recorder.cover(...args),
    onSessionAuth: (auth) => {
      applyStationUiAuth(stationSessions[0], auth);
    },
    onBeforeLogout: async () => {
      suppressedStationIndexes.add(0);
      await stationHeartbeat(stationSessions[0], activeStationNames[0], false, {
        pauseTransferMode: "transfer",
        pauseTransferTargetStation: activeStationNames[1],
      });
    },
    onAfterLogin: async () => {
      suppressedStationIndexes.delete(0);
      await stationHeartbeat(stationSessions[0], activeStationNames[0], true);
    },
    onComplete: (diagnostics) => recorder.gui.push(diagnostics),
  });
  guiControllers.push(stationGui);

  const tablePools = buildV5btTablePools(tables);
  const devices = [
    ...handheldSessions.slice(0, HANDHELD_COUNT).map((session, index) => ({
      id: `mobile-${index + 1}`,
      kind: "handheld",
      index,
      session,
      persistenceDeviceId: session.deviceUuid,
      ownOrders: [],
      readyOrders: [],
      tableMoveFixtures: [],
      orderCount: 0,
      gui: index < mobileGuiCount ? guiControllers[index] : null,
    })),
    ...stationSessions.slice(0, STATION_COUNT).map((session, index) => ({
      id: `station-${index + 1}`,
      kind: "station",
      index,
      session,
      station: activeStationNames[index % activeStationNames.length],
      ownOrders: [],
      readyOrders: [],
      tableMoveFixtures: [],
      gui: index === 0 ? stationGui : null,
    })),
  ];
  const context = {
    admin,
    handheldSessions,
    stationSessions,
    tables,
    fixtureTables: tablePools.fixtureTables,
    runtimeTables: tablePools.runtimeTables,
    orderTables: tablePools.fixtureTables,
    reservedTableIds: new Set(),
    sharedOrders,
    paymentOrderIds: new Set(),
    operationOrderIds: new Set(),
    operationTableIds: new Set(),
    inFlightCreateTableIds: new Set(),
    reservationSlotsByTableId: new Map(),
    cashFloats: [],
    automaticCashTail: Promise.resolve(),
  };
  const fixtureSummary = operationsProfile
    ? await prepareV5btOperationFixtures(devices, context)
    : null;
  if (operationsProfile) {
    for (const controller of guiControllers) {
      controller.resetRequestTraffic();
    }
  }
  const profileStartedAt = Date.now();
  const radioDeadlineAt = profileStartedAt + minimumDurationMs;
  await writeEvent({
    event: `${profileEventPrefix}_profile_started`,
    profileStartedAt: new Date(profileStartedAt).toISOString(),
    minimumDeadlineAt: new Date(radioDeadlineAt).toISOString(),
    handhelds: HANDHELD_COUNT,
    stations: STATION_COUNT,
    guiMobile: mobileGuiCount,
    guiStation: 1,
    actionsPerDevice,
    totalActions,
    fixtureSummary,
    actionsPerSecond: operationsProfile
      ? ((HANDHELD_COUNT + STATION_COUNT) * 1_000) /
        V5BT_DEVICE_ACTION_INTERVAL_MS
      : P5_ACTIONS_PER_SECOND,
  });
  const radioPromise = startRadioScenario(
    handheldSessions.slice(0, HANDHELD_COUNT),
    radioDeadlineAt,
  ).catch((error) => {
    recorder.failures.push({
      at: nowIso(),
      type: `${profileEventPrefix}.radio.exception`,
      status: 0,
      detail: { message: String(error?.message || error) },
    });
    return null;
  });

  let profile;
  const actionSamples = [];
  const checkpointWriter = createP5LatencyCheckpointWriter({
    filePath: p5LatencyCheckpointsPath,
    getHttpSamples: () => recorder.httpSamples,
    getActionSamples: () => actionSamples,
    intervalMs: P5_LATENCY_CHECKPOINT_INTERVAL_MS,
    onError: (error) => {
      void writeEvent({
        event: "p5_latency_checkpoint_error",
        error: String(error?.message || error),
      });
    },
  });
  activeP5LatencyCheckpointWriter = checkpointWriter;
  checkpointWriter.start();
  try {
    await checkpointWriter.flush("profile-start");
    const schedulerOptions = {
      devices,
      actionsPerDevice,
      runAction: async ({ device, ordinal, actionType }) => {
        if (operationsProfile) {
          if (device.kind === "station") {
            return runV5btOperationsStationAction(
              device,
              ordinal,
              actionType,
              context,
            );
          }
          return runV5btOperationsHandheldAction(
            device,
            ordinal,
            actionType,
            context,
          );
        }
        if (device.kind === "station")
          return runP5StationAction(device, ordinal, context);
        return runP5HandheldAction(device, ordinal, context);
      },
      onActionStarted: ({ device, ordinal }) => {
        recorder.business(
          `${profileEventPrefix}.${device.kind}.${device.index + 1}`,
        );
        if (ordinal === 1 || ordinal % 100 === 0) {
          void writeEvent({
            event: `${profileEventPrefix}_device_progress`,
            device: device.id,
            ordinal,
          });
        }
      },
      onActionCompleted: ({
        device,
        ordinal,
        actionType,
        totalStarted,
        ok,
        error,
        durationMs,
        value,
      }) => {
        const failureDetails = ok
          ? null
          : v5btOperationFailureDetails(value);
        actionSamples.push({
          sequence: totalStarted,
          at: Date.now(),
          type:
            value?.actionType ??
            actionType ??
            error?.p5ActionType ??
            `${device.kind}.unknown`,
          device: device.id,
          kind: device.kind,
          ordinal,
          durationMs,
          ok,
          operationOk: value?.operationOk === true,
          status: failureDetails?.status ?? null,
          businessCode: failureDetails?.businessCode ?? null,
          businessError: failureDetails?.businessError ?? null,
          disruptive:
            value?.disruptive === true || error?.p5Disruptive === true,
        });
        if (ok) return;
        recorder.failures.push({
          at: nowIso(),
          type: `${profileEventPrefix}.${device.kind}.action.exception`,
          status: failureDetails?.status ?? 0,
          detail: {
            device: device.id,
            ordinal,
            durationMs,
            message: String(error?.message || error),
            businessCode: failureDetails?.businessCode ?? null,
            businessError: failureDetails?.businessError ?? null,
          },
        });
      },
      onProgress: ({ totalStarted, totalTarget, elapsedMs, inFlight }) => {
        console.log(
          `[${profileEventPrefix}] progresso ${totalStarted}/${totalTarget} ` +
            `(${((totalStarted / totalTarget) * 100).toFixed(1)}%) ` +
            `elapsedMs=${Math.round(elapsedMs)} inFlight=${inFlight}`,
        );
        void writeEvent({
          event: `${profileEventPrefix}_progress`,
          totalStarted,
          totalTarget,
          elapsedMs,
          inFlight,
        });
        void checkpointWriter.flush("progress").catch(() => undefined);
      },
    };
    profile = operationsProfile
      ? await runV5btOperationsSchedule({
          ...schedulerOptions,
          actionIntervalMs: V5BT_DEVICE_ACTION_INTERVAL_MS,
          maxInFlightPerDevice: V5BT_RUNTIME_LIMITS.maxInFlightPerDevice,
          maxInFlightGlobal: V5BT_RUNTIME_LIMITS.maxInFlightGlobal,
          isActionSuccessful: (value) => value?.operationOk === true,
          resolveActionType: ({ device, ordinal }) =>
            device.kind === "station"
              ? v5btStationActionType(device.index, ordinal)
              : v5btMobileActionType(device.index, ordinal),
        })
      : await runP5ActionSchedule({
          ...schedulerOptions,
          actionsPerSecond: P5_ACTIONS_PER_SECOND,
        });
  } finally {
    await checkpointWriter.close("profile-stop").catch((error) => {
      recorder.failures.push({
        at: nowIso(),
        type: "p5.latency_checkpoint.write_failed",
        status: 0,
        detail: { message: String(error?.message || error) },
      });
    });
    if (activeP5LatencyCheckpointWriter === checkpointWriter) {
      activeP5LatencyCheckpointWriter = null;
    }
    await Promise.allSettled(
      guiControllers.map((controller) => controller.close()),
    );
    suppressedStationIndexes.delete(0);
  }
  await radioPromise;
  profile.profile = LOADTEST_PROFILE;
  if (operationsProfile) {
    profile.schedulerContractVersion =
      V5BT_OPERATIONS_SCHEDULER_CONTRACT_VERSION;
    profile.stage = V5BT_OPERATIONS_STAGE;
  }
  profile.profileStartedAt = new Date(profileStartedAt).toISOString();
  profile.profileEndedAt = nowIso();
  profile.minimumDurationMs = minimumDurationMs;
  profile.latencyCheckpointPath = p5LatencyCheckpointsPath;
  profile.latencyCheckpointIntervalMs = P5_LATENCY_CHECKPOINT_INTERVAL_MS;
  profile.baselineDiagnosticsPaths = listP5BaselineDiagnosticsPaths();
  profile.actionLatencyMs = latencySummary(
    actionSamples.map((sample) => sample.durationMs),
  );
  profile.dispatchLagMs = latencySummary(
    (Array.isArray(profile.samples) ? profile.samples : []).map(
      (sample) => sample.startLagMs,
    ),
  );
  profile.commandLatencyMs = latencySummary(
    actionSamples
      .filter(
        (sample) =>
          sample.kind === "handheld" && sample.type === "order.create",
      )
      .map((sample) => sample.durationMs),
  );
  profile.actionLatencyDrift = latencyDriftSummary(
    actionSamples,
    (sample) => sample.durationMs,
  );
  const steadyActionSamples = actionSamples.filter(
    (sample) => sample.disruptive !== true,
  );
  profile.steadyActionLatencyMs = latencySummary(
    steadyActionSamples.map((sample) => sample.durationMs),
  );
  profile.steadyActionLatencyDrift = latencyDriftSummary(
    steadyActionSamples,
    (sample) => sample.durationMs,
  );
  profile.disruptiveActionCount =
    actionSamples.length - steadyActionSamples.length;
  profile.actionTypes = p5ActionTypeSummaries(actionSamples);
  profile.actionTimeWindows = p5ActionTimeWindows(actionSamples, totalActions);
  profile.guiMobileCount = mobileGuiCount;
  profile.guiStationCount = 1;
  profile.fixtureSummary = fixtureSummary;
  profile.orderTargetPerHandheld = operationsProfile
    ? V5BT_COMMANDS_PER_HANDHELD
    : P5_ALLOW_NONSTANDARD
      ? null
      : 50;
  profile.ordersCreatedPerHandheld = Object.fromEntries(
    profile.devices
      .filter((device) => device.kind === "handheld")
      .map((device) => [device.id, device.orderCount]),
  );
  profile.cashFloatsGenerated = context.cashFloats.length;
  const cashFloatIds = context.cashFloats
    .map((entry) => String(entry?.cashFloatId ?? "").trim())
    .filter(Boolean);
  recorder.cover(
    "automatic_cash.float_ids_unique",
    cashFloatIds.length === new Set(cashFloatIds).size,
    { generated: cashFloatIds.length, unique: new Set(cashFloatIds).size },
  );
  profile.devices = profile.devices.map((device) => {
    const {
      session,
      ownOrders,
      readyOrders,
      tableMoveFixtures,
      gui,
      durationsMs,
      ...serializable
    } = device;
    return {
      ...serializable,
      actionLatencyMs: latencySummary(durationsMs),
    };
  });
  if (operationsProfile) {
    profile.runtimeGate = evaluateV5btOperationsRuntimeGate({
      profile,
      commandLatencyMs: profile.commandLatencyMs,
      guiDiagnostics: recorder.gui,
      actionsPerDevice,
      ...V5BT_RUNTIME_LIMITS,
    });
  }
  await settleAutomaticCashLifecycle(
    context.cashFloats,
    handheldSessions,
    admin,
  );
  if (operationsProfile) {
    recordV5btOperationsProfileFailures(profile, actionSamples);
    delete profile.samples;
  } else {
    recordP5ProfileFailures(profile);
  }
  recorder.cover(
    `${profileEventPrefix}.gui.two_mobile_one_station`,
    recorder.gui.length === 3,
    {
      observed: recorder.gui.map((entry) => entry.kind),
    },
  );
  const guiCoverageNames = operationsProfile
    ? {
        httpClean: "v5bt.operations.gui.http_clean",
        consoleClean: "v5bt.operations.gui.console_clean",
        unexpectedErrors: "v5bt.operations.gui.unexpected_errors",
      }
    : {
        httpClean: "p5.gui.http_clean",
        consoleClean: "p5.gui.console_clean",
        unexpectedErrors: "p5.gui.unexpected_errors",
      };
  const unexpectedGuiResponses = recorder.gui.reduce(
    (total, entry) =>
      total + Number(entry.responses4xx || 0) + Number(entry.responses5xx || 0),
    0,
  );
  const unexpectedGuiRequestFailures = recorder.gui.reduce(
    (total, entry) => total + Number(entry.requestFailures || 0),
    0,
  );
  const unexpectedGuiConsoleErrors = recorder.gui.reduce(
    (total, entry) => total + Number(entry.consoleErrors || 0),
    0,
  );
  recorder.cover(
    guiCoverageNames.httpClean,
    unexpectedGuiResponses === 0 && unexpectedGuiRequestFailures === 0,
    {
      unexpectedResponses: unexpectedGuiResponses,
      unexpectedRequestFailures: unexpectedGuiRequestFailures,
      devices: recorder.gui.map((entry) => ({
        kind: entry.kind,
        index: entry.index,
        responses4xx: entry.responses4xx || 0,
        responses5xx: entry.responses5xx || 0,
        requestFailures: entry.requestFailures || 0,
        expectedConflicts: entry.expectedConflicts || 0,
        requestFailureSamples: entry.requestFailureSamples || [],
        samples: entry.responseErrorSamples || [],
      })),
    },
  );
  recorder.cover(
    guiCoverageNames.consoleClean,
    unexpectedGuiConsoleErrors === 0,
    {
      unexpectedConsoleErrors: unexpectedGuiConsoleErrors,
      devices: recorder.gui.map((entry) => ({
        kind: entry.kind,
        index: entry.index,
        consoleErrors: entry.consoleErrors || 0,
        samples: entry.consoleErrorSamples || [],
      })),
    },
  );
  if (
    unexpectedGuiResponses > 0 ||
    unexpectedGuiRequestFailures > 0 ||
    unexpectedGuiConsoleErrors > 0
  ) {
    recorder.failures.push({
      at: nowIso(),
      type: guiCoverageNames.unexpectedErrors,
      status: 0,
      detail: {
        unexpectedResponses: unexpectedGuiResponses,
        unexpectedRequestFailures: unexpectedGuiRequestFailures,
        unexpectedConsoleErrors: unexpectedGuiConsoleErrors,
        devices: recorder.gui.map((entry) => ({
          kind: entry.kind,
          index: entry.index,
          responses4xx: entry.responses4xx || 0,
          responses5xx: entry.responses5xx || 0,
          requestFailures: entry.requestFailures || 0,
          expectedConflicts: entry.expectedConflicts || 0,
          consoleErrors: entry.consoleErrors || 0,
        })),
      },
    });
  }
  if (operationsProfile) {
    recorder.cover(
      "v5bt.operations.mobile_action_cadence_3s",
      profile.cadence.mobileActionCadenceOk,
      profile.cadence,
    );
    recorder.cover(
      "v5bt.operations.command_cadence_7_8s",
      profile.cadence.commandCadenceOk,
      profile.cadence,
    );
    recorder.cover(
      "v5bt.operations.runtime_limits",
      profile.runtimeGate.ok,
      profile.runtimeGate,
    );
    recorder.cover(
      "v5bt.operations.all_mobile_action_types",
      profile.missingMobileActionTypes.length === 0,
      {
        required: profile.requiredMobileActionTypes,
        missing: profile.missingMobileActionTypes,
      },
    );
  } else {
    recorder.cover(
      "p5.actions.global_rate_max_3",
      profile.rate.ok,
      profile.rate,
    );
    recorder.cover(
      "p5.actions.1000_each_device",
      profile.devices.every(
        (device) =>
          device.started === P5_ACTIONS_PER_DEVICE &&
          device.completed === P5_ACTIONS_PER_DEVICE,
      ),
      {
        devices: profile.devices.length,
        target: P5_ACTIONS_PER_DEVICE,
      },
    );
  }
  return profile;
}

async function main() {
  assertLoadtestIoSafety();
  if (P5_ENDURANCE_PROFILE && !P5_ALLOW_NONSTANDARD) {
    const invalid = [
      [HANDHELD_COUNT !== 20, `palmari=${HANDHELD_COUNT}, attesi 20`],
      [STATION_COUNT !== 5, `postazioni=${STATION_COUNT}, attese 5`],
      [GUI_COUNT !== 2, `GUI mobile=${GUI_COUNT}, attese 2`],
      [
        P5_ACTIONS_PER_DEVICE !== 1_000,
        `azioni/device=${P5_ACTIONS_PER_DEVICE}, attese 1000`,
      ],
      [
        P5_ACTIONS_PER_SECOND !== 3,
        `azioni/s=${P5_ACTIONS_PER_SECOND}, attese 3`,
      ],
      [PRINTER_COUNT !== 5, `stampanti TCP=${PRINTER_COUNT}, attese 5`],
      [!PRINTING_ENABLED, "stampa TCP simulata disabilitata"],
      [!START_MOCK_IO, "mock I/O disabilitati"],
      [ALLOW_NON_LOOPBACK_IO, "I/O non-loopback consentito"],
      [!MULTIPROCESS, "multi-processo disabilitato"],
    ]
      .filter(([failed]) => failed)
      .map(([, message]) => message);
    if (invalid.length > 0) {
      throw new Error(`Configurazione P5 non conforme: ${invalid.join("; ")}.`);
    }
  }
  if (V5BT_OPERATIONS_PROFILE) {
    const invalid = [
      [
        HANDHELD_COUNT < 1 || HANDHELD_COUNT > V5BT_MAX_HANDHELDS,
        `palmari=${HANDHELD_COUNT}, massimo ${V5BT_MAX_HANDHELDS}`,
      ],
      [
        STATION_COUNT < 1 || STATION_COUNT > V5BT_MAX_STATIONS,
        `postazioni=${STATION_COUNT}, massimo ${V5BT_MAX_STATIONS}`,
      ],
      [
        GUI_COUNT < 1 || GUI_COUNT > HANDHELD_COUNT,
        `GUI mobile=${GUI_COUNT}, intervallo valido 1..${HANDHELD_COUNT}`,
      ],
      [
        V5BT_ACTIONS_PER_DEVICE < 10,
        `azioni/device=${V5BT_ACTIONS_PER_DEVICE}, minimo 10`,
      ],
      [PRINTER_COUNT !== 5, `stampanti TCP=${PRINTER_COUNT}, attese 5`],
      [!PRINTING_ENABLED, "stampa TCP simulata disabilitata"],
      [!START_MOCK_IO, "mock I/O disabilitati"],
      [ALLOW_NON_LOOPBACK_IO, "I/O non-loopback consentito"],
      [!MULTIPROCESS, "multi-processo disabilitato"],
    ]
      .filter(([failed]) => failed)
      .map(([, message]) => message);
    if (invalid.length > 0) {
      throw new Error(
        `Configurazione simulazione V5BT non conforme: ${invalid.join("; ")}.`,
      );
    }
  }
  ({ chromium } = await loadPlaywright());
  await writeSeed();
  const mockIo = await startMockIo();
  const backend = await startBackend();
  const frontend = await startFrontend();
  const mysqlConn = await mysqlConnection();
  await writeEvent({
    event: "started",
    prefix,
    outputDir,
    apiBaseUrl,
    frontendBaseUrl,
  });

  const tables = buildTables();
  const sharedOrders = [];
  const handheldSessions = [];
  const stationSessions = [];
  const stopSignal = { done: false };
  let guiHeadless = true;
  let admin = null;
  let realtimeClients = null;
  let realtimeSummary = null;
  let relationalAudit = null;
  let stationStateLastWritePersistenceAudit = null;
  let pacedProfile = null;
  let realisticProfile = null;
  let p5Profile = null;
  let v5btOperationsProfile = null;
  let automaticCashFloats = [];
  let tableLockCanary = null;
  let roomChangeProbeSession = null;
  let waiterPauseProbeSession = null;
  let paymentFreeSplitProbeSession = null;
  const mysqldRows = await mysqlConn
    .query("SELECT CONNECTION_ID() AS id")
    .catch(() => [[{ id: null }]]);
  await mysqlConn.end();
  const mysqldPids = await findProcessIds("mysqld");
  const monitorPromise = collectMonitor(
    stopSignal,
    [
      backend.child.pid,
      ...(backend.siblings ?? []).map((sibling) => sibling.child.pid),
      frontend.child.pid,
      ...mysqldPids,
    ],
    backend.tables,
    { getRuntimeSession: () => admin },
  );

  try {
    const handheldLoginCount = REALISTIC_LOAD_PROFILE
      ? HANDHELD_COUNT
      : HANDHELD_COUNT + GUI_COUNT;
    for (let index = 0; index < handheldLoginCount; index += 1) {
      const userIndex = (index % 40) + 1;
      const session = await login(
        `op${userIndex}`,
        "2222",
        `load-device-${index + 1}`,
        "mobile-frontend",
      );
      handheldSessions.push(session);
      if (index < GUI_COUNT) session.isGui = true;
    }
    for (let index = 0; index < STATION_COUNT; index += 1) {
      const userIndex = 21 + (index % 10);
      const session = await login(
        `op${userIndex}`,
        "2222",
        `load-station-${index + 1}`,
        "postazione",
      );
      stationSessions.push(session);
      await selectLoginWorkstation(
        session,
        `workstation_load_${index + 1}`,
        activeStationNames[index % activeStationNames.length],
      );
      await stationHeartbeat(
        session,
        activeStationNames[index % activeStationNames.length],
        true,
      );
    }
    admin = await login(
      "admin_load",
      "1111",
      "load-admin-device",
      "mobile-frontend",
    );
    if (REALISTIC_HOUR_PROFILE && ROOM_CHANGE_BRANCH_PROBES > 0)
      roomChangeProbeSession = await login(
        "op20",
        "2222",
        "load-room-change-probe",
        "mobile-frontend",
      );
    if (REALISTIC_HOUR_PROFILE && WAITER_PAUSE_PROBES > 0)
      waiterPauseProbeSession = await login(
        "op1",
        "2222",
        "load-waiter-pause-probe",
        "mobile-frontend",
      );
    if (REALISTIC_HOUR_PROFILE && PAYMENT_FREE_SPLIT_PROBES > 0)
      paymentFreeSplitProbeSession = await login(
        "op2",
        "2222",
        "load-payment-free-split-probe",
        "mobile-frontend",
      );
    const lockObserver = MULTIPROCESS
      ? await login(
          "lock_observer",
          "3333",
          "load-lock-observer",
          "mobile-frontend",
        )
      : null;
    tableLockCanary = await verifyMultiprocessTableLockRouting(
      handheldSessions[0],
      handheldSessions[1],
      admin,
      lockObserver,
    );
    if (tableLockCanary) {
      await writeEvent({
        event: "multiprocess_table_lock_canary",
        ...tableLockCanary,
      });
    }
    if (MULTIPROCESS) {
      for (const metricsBaseUrl of [
        apiBaseUrl,
        realtimeBaseUrl,
        ...apiWorkerBaseUrls,
        ...tableLockWorkerBaseUrls,
      ]) {
        await fetchRuntimeMetrics(admin, "reset", metricsBaseUrl);
      }
    } else {
      await fetchRuntimeMetrics(admin, "reset");
    }
    realtimeClients = await startRealtimeClients(handheldSessions);
    await writeEvent({
      event: "realtime_clients_ready",
      ...realtimeClients.summary(),
    });

    const hasDisplay = Boolean(
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
    );
    guiHeadless = process.env.LOADTEST_GUI_HEADLESS
      ? process.env.LOADTEST_GUI_HEADLESS !== "0"
      : !hasDisplay;
    if (P5_ENDURANCE_PROFILE && guiHeadless && !P5_ALLOW_HEADLESS) {
      throw new Error(
        "Il test P5 completo richiede Chrome visibile: DISPLAY/WAYLAND_DISPLAY assente o LOADTEST_GUI_HEADLESS=1.",
      );
    }
    const chromiumLaunchOptions = {
      headless: guiHeadless,
      ...(CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: CHROMIUM_EXECUTABLE_PATH }
        : {}),
      ...(CHROMIUM_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
    };
    let browser = null;
    if (!PACED_HANDHELD_PROFILE && GUI_COUNT > 0) {
      try {
        browser = await chromium.launch(chromiumLaunchOptions);
      } catch (error) {
        if (guiHeadless || (P5_ENDURANCE_PROFILE && !P5_ALLOW_HEADLESS))
          throw error;
        await writeEvent({
          event: "gui_headful_launch_failed",
          error: String(error?.message || error),
        });
        guiHeadless = true;
        browser = await chromium.launch({
          ...chromiumLaunchOptions,
          headless: true,
        });
      }
      activeBrowser = browser;
    }
    const stationPresenceStop = { done: false };
    const stationPresencePromise = stationPresenceKeeper(
      stationSessions,
      stationPresenceStop,
    );
    try {
      if (ACTION_SCHEDULE_PROFILE) {
        const completedActionProfile = await runP5EnduranceProfile({
          browser,
          admin,
          handheldSessions,
          stationSessions,
          tables,
          sharedOrders,
        });
        if (V5BT_OPERATIONS_PROFILE)
          v5btOperationsProfile = completedActionProfile;
        else p5Profile = completedActionProfile;
      } else if (REALISTIC_HOUR_PROFILE) {
        const profileStartedAt = Date.now();
        const profileDeadlineAt = profileStartedAt + REALISTIC_DURATION_MS;
        await writeEvent({
          event: "realistic_profile_started",
          profileStartedAt: new Date(profileStartedAt).toISOString(),
          profileDeadlineAt: new Date(profileDeadlineAt).toISOString(),
          handhelds: HANDHELD_COUNT,
          stations: STATION_COUNT,
          guiMobile: GUI_COUNT,
          guiStation: 1,
          ordersPerDevice: REALISTIC_ORDER_COUNT,
        });
        const deviceStatsPromise = Promise.all(
          Array.from({ length: HANDHELD_COUNT }, (_, index) =>
            realisticHandheldWorker(
              index,
              handheldSessions,
              tables,
              sharedOrders,
              profileStartedAt,
              profileDeadlineAt,
            ),
          ),
        );
        const cashPromise = runAutomaticCashLifecycle(
          handheldSessions,
          admin,
          sharedOrders,
          profileStartedAt,
          profileDeadlineAt,
        );
        const auxiliary = [
          ...Array.from({ length: STATION_COUNT }, (_, index) =>
            realisticStationWorker(
              index,
              stationSessions[index],
              sharedOrders,
              profileStartedAt,
              profileDeadlineAt,
            ),
          ),
          ...Array.from(
            { length: Math.min(GUI_COUNT, HANDHELD_COUNT) },
            (_, index) =>
              runRealisticMobileGui(
                browser,
                index,
                handheldSessions[index],
                profileStartedAt,
                profileDeadlineAt,
              ),
          ),
          runRealisticStationGui(
            browser,
            stationSessions[0],
            profileStartedAt,
            profileDeadlineAt,
          ),
          startRadioScenario(
            handheldSessions.slice(0, HANDHELD_COUNT),
            profileDeadlineAt,
          ),
          runRealisticScenarioEvents(
            admin,
            handheldSessions,
            stationSessions,
            tables,
            sharedOrders,
            profileStartedAt,
            profileDeadlineAt,
          ),
          runRoomChangeBranchProbes(
            roomChangeProbeSession,
            profileStartedAt,
            profileDeadlineAt,
          ),
          runWaiterPauseProbes(
            waiterPauseProbeSession,
            profileStartedAt,
            profileDeadlineAt,
          ),
          runPaymentFreeSplitProbes(
            paymentFreeSplitProbeSession,
            profileStartedAt,
            profileDeadlineAt,
          ),
        ].map((promise, index) =>
          Promise.resolve(promise).catch((error) => {
            recorder.failures.push({
              at: nowIso(),
              type: "realistic.auxiliary.exception",
              status: 0,
              detail: { index, message: String(error?.message || error) },
            });
            return null;
          }),
        );
        const [deviceStats, cashFloats] = await Promise.all([
          deviceStatsPromise,
          cashPromise,
          ...auxiliary,
        ]);
        automaticCashFloats = cashFloats;
        const automaticCashFloatIds = cashFloats
          .map((entry) => String(entry?.cashFloatId ?? "").trim())
          .filter(Boolean);
        recorder.cover(
          "automatic_cash.float_ids_unique",
          automaticCashFloatIds.length === new Set(automaticCashFloatIds).size,
          {
            generated: automaticCashFloatIds.length,
            unique: new Set(automaticCashFloatIds).size,
          },
        );
        realisticProfile = summarizeRealisticProfile(
          deviceStats,
          profileStartedAt,
        );
        if (realisticProfile.devicesAtTarget !== HANDHELD_COUNT) {
          recorder.failures.push({
            at: nowIso(),
            type: "realistic.orders.target_not_met",
            status: 0,
            detail: {
              devicesAtTarget: realisticProfile.devicesAtTarget,
              expected: HANDHELD_COUNT,
              totals: realisticProfile.totals,
            },
          });
        }
        await settleAutomaticCashLifecycle(
          automaticCashFloats,
          handheldSessions,
          admin,
        );
      } else if (PACED_HANDHELD_PROFILE) {
        const profileStartedAt = Date.now();
        const profileDeadlineAt = profileStartedAt + PACED_MAX_ACTIVE_MS;
        const deviceStats = await Promise.all(
          Array.from({ length: HANDHELD_COUNT }, (_, index) =>
            pacedHandheldWorker(
              index,
              handheldSessions,
              tables,
              profileStartedAt,
              profileDeadlineAt,
            ),
          ),
        );
        pacedProfile = summarizePacedProfile(
          deviceStats,
          profileStartedAt,
          profileDeadlineAt,
        );
      } else {
        const workers = [];
        for (let index = 0; index < HANDHELD_COUNT; index += 1) {
          workers.push(
            handheldWorker(index, handheldSessions, tables, sharedOrders),
          );
        }
        for (let index = 0; index < STATION_COUNT; index += 1) {
          workers.push(
            stationWorker(index, stationSessions[index], sharedOrders),
          );
        }
        for (let index = 0; index < GUI_COUNT; index += 1) {
          workers.push(runGui(browser, index, handheldSessions[index]));
        }
        workers.push(
          runFiscalSamples(handheldSessions[0] || admin, sharedOrders, tables),
        );
        workers.push(runAdminAdjustmentSamples(admin, sharedOrders, tables));
        workers.push(
          runConflictSamples(
            admin,
            handheldSessions[GUI_COUNT + 1],
            sharedOrders,
            tables,
          ),
        );
        await Promise.allSettled(workers);
      }
    } finally {
      stationPresenceStop.done = true;
      await stationPresencePromise;
    }
    relationalAudit = await waitForRelationalDrain(admin);
    stationStateLastWritePersistenceAudit =
      await auditStationStateLastWritePersistence(backend.tables.domainsTable);
    recorder.cover(
      "v5bt.operations.station_state_last_write_persistence",
      !V5BT_OPERATIONS_PROFILE || stationStateLastWritePersistenceAudit.ok,
      stationStateLastWritePersistenceAudit,
    );
    if (V5BT_OPERATIONS_PROFILE && !stationStateLastWritePersistenceAudit.ok) {
      recorder.failures.push({
        at: nowIso(),
        type: "v5bt.operations.station_state_last_write_persistence",
        status: 0,
        detail: stationStateLastWritePersistenceAudit,
      });
    }
    activeBrowser = null;
    if (browser) await browser.close();
    if (pacedProfile) {
      pacedProfile.ordersPersisted = relationalAudit.orders;
      pacedProfile.persistedOrdersByDevice =
        relationalAudit.pacedOrdersByDevice;
      pacedProfile.devicesMeetingPersistedOrderTarget =
        relationalAudit.pacedOrderDevicesMeetingTarget;
      pacedProfile.minPersistedOrdersPerPresentDevice =
        relationalAudit.pacedOrderMinPerPresentDevice;
      recordPacedProfileFailures(pacedProfile);
    }
    if (realisticProfile) {
      realisticProfile.ordersPersisted = relationalAudit.orders;
      realisticProfile.persistedOrdersByDevice =
        relationalAudit.pacedOrdersByDevice;
      realisticProfile.devicesMeetingPersistedOrderTarget = Object.values(
        relationalAudit.pacedOrdersByDevice,
      ).filter((count) => count >= REALISTIC_ORDER_COUNT).length;
      realisticProfile.minPersistedOrdersPerPresentDevice =
        relationalAudit.pacedOrderMinPerPresentDevice;
      recorder.cover(
        "orders.persisted_50_per_device",
        realisticProfile.devicesMeetingPersistedOrderTarget === HANDHELD_COUNT,
        {
          devicesMeetingTarget:
            realisticProfile.devicesMeetingPersistedOrderTarget,
          expected: HANDHELD_COUNT,
        },
      );
    }
    if (p5Profile) {
      p5Profile.ordersPersisted = relationalAudit.orders;
      p5Profile.persistedOrdersByDevice = relationalAudit.pacedOrdersByDevice;
      if (p5Profile.orderTargetPerHandheld !== null) {
        p5Profile.devicesMeetingPersistedOrderTarget = Object.values(
          relationalAudit.pacedOrdersByDevice,
        ).filter((count) => count >= p5Profile.orderTargetPerHandheld).length;
        recorder.cover(
          "p5.orders.persisted_50_per_handheld",
          p5Profile.devicesMeetingPersistedOrderTarget === HANDHELD_COUNT,
          {
            devicesMeetingTarget: p5Profile.devicesMeetingPersistedOrderTarget,
            expected: HANDHELD_COUNT,
          },
        );
        if (p5Profile.devicesMeetingPersistedOrderTarget !== HANDHELD_COUNT) {
          recorder.failures.push({
            at: nowIso(),
            type: "p5.orders.persisted_target_not_met",
            status: 0,
            detail: {
              devicesMeetingTarget:
                p5Profile.devicesMeetingPersistedOrderTarget,
              expected: HANDHELD_COUNT,
              targetPerHandheld: p5Profile.orderTargetPerHandheld,
            },
          });
        }
      } else {
        p5Profile.devicesMeetingPersistedOrderTarget = null;
      }
    }
    if (v5btOperationsProfile) {
      v5btOperationsProfile.ordersPersisted = relationalAudit.orders;
      v5btOperationsProfile.persistedOrdersByDevice =
        relationalAudit.pacedOrdersByDevice;
      const persistedOrderGate = evaluateV5btPersistedOrderTarget({
        handheldDeviceIds: v5btOperationsProfile.devices
          .filter((device) => device.kind === "handheld")
          .map((device) => device.persistenceDeviceId),
        persistedOrdersByDevice: relationalAudit.pacedOrdersByDevice,
        targetPerHandheld: v5btOperationsProfile.orderTargetPerHandheld,
      });
      v5btOperationsProfile.persistedOrderGate = persistedOrderGate;
      v5btOperationsProfile.devicesMeetingPersistedOrderTarget =
        persistedOrderGate.devicesMeetingTarget;
      v5btOperationsProfile.persistedOrderTargetOk = persistedOrderGate.ok;
      recorder.cover(
        "v5bt.operations.orders.persisted_per_handheld",
        persistedOrderGate.ok,
        {
          ...persistedOrderGate,
        },
      );
      if (!persistedOrderGate.ok) {
        recorder.failures.push({
          at: nowIso(),
          type: "v5bt.operations.orders.persisted_target_not_met",
          status: 0,
          detail: {
            ...persistedOrderGate,
          },
        });
      }
    }
    recordRelationalAuditFailures(relationalAudit);
    await realtimeClients.close();
    realtimeSummary = realtimeClients.summary();
    realtimeClients = null;
  } finally {
    if (realtimeClients) {
      await realtimeClients.close().catch(() => undefined);
      realtimeSummary = realtimeSummary ?? realtimeClients.summary();
      realtimeClients = null;
    }
    stopSignal.done = true;
  }

  const mockIoMetrics = await fetchMockIoMetrics();
  const rtFiscalProviderMetrics = mockIoMetrics.fiscal;
  const printerRows = mockIoMetrics.printers?.body?.printers ?? [];
  recorder.cover(
    "printing.four_station_queues",
    printerRows.length === PRINTER_COUNT &&
      printerRows.every((entry) => entry.connections > 0 && entry.bytes > 0),
    {
      printers: printerRows.map((entry) => ({
        id: entry.id,
        port: entry.port,
        connections: entry.connections,
        bytes: entry.bytes,
      })),
    },
  );
  recorder.cover(
    "fiscal.virtual_provider_only",
    isLoopbackHostname(new URL(RT_BASE_URL).hostname) &&
      mockIoMetrics.fiscal?.ok === true,
    { baseUrl: RT_BASE_URL, metrics: mockIoMetrics.fiscal?.body ?? null },
  );
  recorder.cover(
    "battery.event_simulator_v5bt_devices",
    mockIoMetrics.battery?.ok === true &&
      mockIoMetrics.battery?.body?.devices?.length === HANDHELD_COUNT &&
      mockIoMetrics.battery?.body?.notificationIntervalMs ===
        V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
    {
      expected: HANDHELD_COUNT,
      observed: mockIoMetrics.battery?.body?.devices?.length ?? null,
      sequence: mockIoMetrics.battery?.body?.sequence ?? null,
      expectedNotificationIntervalMs:
        V5BT_BATTERY_NOTIFICATION_INTERVAL_MS,
      observedNotificationIntervalMs:
        mockIoMetrics.battery?.body?.notificationIntervalMs ?? null,
    },
  );
  recorder.cover(
    "automatic_cash.virtual_gateway_only",
    !REALISTIC_LOAD_PROFILE ||
      (isLoopbackHostname(new URL(AUTOMATIC_CASH_BASE_URL).hostname) &&
        mockIoMetrics.automaticCash?.ok === true),
    {
      baseUrl: AUTOMATIC_CASH_BASE_URL,
      health: mockIoMetrics.automaticCash?.body ?? null,
    },
  );
  const monitor = summarizeMonitor(await monitorPromise);
  recorder.endedAt = Date.now();
  const runtimeMetrics = await fetchRuntimeMetrics(
    admin,
    "snapshot",
    MULTIPROCESS ? apiBaseUrl : undefined,
  );
  const autoPrintOwnerAudit = buildAutoPrintOwnerAudit(runtimeMetrics, {
    applicable: MULTIPROCESS && PRINTING_ENABLED && V5BT_OPERATIONS_PROFILE,
    expectedApiWorkers: apiWorkerCount,
  });
  const stationStateMarkerLockElisionAudit =
    buildStationStateMarkerLockElisionAudit(runtimeMetrics, {
      applicable: V5BT_OPERATIONS_PROFILE,
      enabled: stationStateMarkerLockSkipEnabled,
    });
  const stationStateLastWriteAudit = buildStationStateLastWriteAudit(
    runtimeMetrics,
    {
      applicable: V5BT_OPERATIONS_PROFILE,
      enabled: stationStateLastWriteCoalesceEnabled,
      nowaitEnabled: stationStateLastWriteNowaitEnabled,
    },
  );
  const latencyAttribution = V5BT_OPERATIONS_PROFILE
    ? buildV5btLatencyAttribution(runtimeMetrics)
    : null;
  if (V5BT_OPERATIONS_PROFILE) {
    v5btOperationsProfile.autoPrintOwnerAudit = autoPrintOwnerAudit;
    v5btOperationsProfile.stationStateMarkerLockElisionAudit =
      stationStateMarkerLockElisionAudit;
    v5btOperationsProfile.stationStateLastWriteAudit =
      stationStateLastWriteAudit;
    recorder.cover("v5bt.operations.auto_print_owner_only", autoPrintOwnerAudit.ok, autoPrintOwnerAudit);
    if (!autoPrintOwnerAudit.ok) {
      recorder.failures.push({
        at: nowIso(),
        type: "v5bt.operations.auto_print_owner_only",
        status: 0,
        detail: autoPrintOwnerAudit,
      });
    }
    recorder.cover(
      "v5bt.operations.station_state_marker_lock_elision",
      stationStateMarkerLockElisionAudit.ok,
      stationStateMarkerLockElisionAudit,
    );
    if (!stationStateMarkerLockElisionAudit.ok) {
      recorder.failures.push({
        at: nowIso(),
        type: "v5bt.operations.station_state_marker_lock_elision",
        status: 0,
        detail: stationStateMarkerLockElisionAudit,
      });
    }
    recorder.cover(
      "v5bt.operations.station_state_last_write_coalesce",
      stationStateLastWriteAudit.ok,
      stationStateLastWriteAudit,
    );
    if (!stationStateLastWriteAudit.ok) {
      recorder.failures.push({
        at: nowIso(),
        type: "v5bt.operations.station_state_last_write_coalesce",
        status: 0,
        detail: stationStateLastWriteAudit,
      });
    }
    recorder.cover(
      "v5bt.operations.latency_attribution_complete",
      latencyAttribution.complete,
      {
        schemaVersion: latencyAttribution.schemaVersion,
        status: latencyAttribution.status,
        incompleteCategories: latencyAttribution.incompleteCategories,
      },
    );
    if (!latencyAttribution.complete) {
      recorder.failures.push({
        at: nowIso(),
        type: "v5bt.operations.latency_attribution_incomplete",
        status: 0,
        detail: latencyAttribution,
      });
    }
  }
  const cleanup = await cleanupResources();
  for (const [failed, type, detail] of [
    [cleanup.sessions.ok !== true, "cleanup.sessions.residue", cleanup.sessions],
    [cleanup.processes.verified !== true, "cleanup.processes.residue", cleanup.processes],
    [cleanup.logs.verified !== true, "cleanup.logs.open_handles", cleanup.logs],
    [cleanup.printSpool.verified !== true, "cleanup.print_spool.residue", cleanup.printSpool],
  ]) {
    if (failed) {
      recorder.failures.push({ at: nowIso(), type, status: 0, detail });
    }
  }
  const summary = {
    runId,
    prefix,
    apiBaseUrl,
    frontendBaseUrl,
    config: {
      handHeldCount: HANDHELD_COUNT,
      stationCount: STATION_COUNT,
      guiCount: GUI_COUNT,
      realtimeClientCount: REALTIME_CLIENT_COUNT,
      opsPerDevice: OPS_PER_DEVICE,
      fiscalSampleLimit: FISCAL_SAMPLE_LIMIT,
      rtBaseUrl: RT_BASE_URL,
      printingEnabled: PRINTING_ENABLED,
      printerHost: PRINTER_HOST,
      printerPort: PRINTER_PORT,
      printerCount: PRINTER_COUNT,
      printerPorts: VIRTUAL_PRINTERS.map((printer) => printer.port),
      allowNonLoopbackIo: ALLOW_NON_LOOPBACK_IO,
      backendHost,
      backendLoopbackOnly: isLoopbackHostname(backendHost),
      printSpoolDir,
      multiprocess: MULTIPROCESS,
      apiWorkerCount,
      tableLockWorkerCount,
      tableLockTombstonesEnabled,
      tableLockMysqlConnectionLimit,
      tableLockRedisPoolSize,
      apiWorkerAuthFastPathEnabled,
      apiWorkerRedisPoolSize,
      runtimeMetricsQueueSampleLimit,
      orderCreateTargetedLockRefreshEnabled,
      orderCreateParallelExternalRefreshEnabled,
      laneCrossExclusionOrdersEnabled,
      laneCrossExclusionTablesEnabled,
      laneCrossExclusionPaymentsEnabled,
      laneCrossExclusionPresenceEnabled,
      paymentLaneConcurrency,
      v5btOperationsEvidenceClass: V5BT_OPERATIONS_PROFILE
        ? v5btOperationsEvidenceClass
        : null,
      v5btOperationsPromotionEligibility: V5BT_OPERATIONS_PROFILE
        ? v5btOperationsPromotionEligibility
        : null,
      v5btOperationsDiagnosticPaymentLaneConcurrency: V5BT_OPERATIONS_PROFILE
        ? v5btOperationsDiagnosticPaymentLaneConcurrency
        : null,
      v5btOperationsDiagnosticAutoPrintOwnerIntervalMs:
        V5BT_OPERATIONS_PROFILE
          ? v5btOperationsDiagnosticAutoPrintOwnerIntervalMs
          : null,
      stationStateMarkerLockSkipEnabled,
      v5btOperationsDiagnosticStationStateMarkerLockSkipEnabled:
        V5BT_OPERATIONS_PROFILE
          ? v5btOperationsDiagnosticStationStateMarkerLockSkipEnabled
          : null,
      stationStateLastWriteCoalesceEnabled,
      stationStateLastWriteNowaitEnabled,
      stationStateLastWriteCoalesceIntervalMs,
      v5btOperationsDiagnosticStationStateLastWriteCoalesceEnabled:
        V5BT_OPERATIONS_PROFILE
          ? v5btOperationsDiagnosticStationStateLastWriteCoalesceEnabled
          : null,
      v5btOperationsDiagnostic: V5BT_OPERATIONS_PROFILE
        ? v5btOperationsDiagnostic
        : null,
      printLaneConcurrency,
      printSpoolAutoPrintOwnerIntervalMs,
      ordersAsyncFlushIntervalMs,
      ordersAsyncFlushMysqlNowaitEnabled,
      ordersAsyncFlushDetachLastWriteAtEnabled,
      ordersAsyncFlushDetachSequenceWhenSafeEnabled,
      hostPressurePreflight,
      tableSyncAppStateFastPathEnabled,
      tableRoomMoveRequestAppStateFastPathEnabled,
      waiterPauseSessionAuditFastPathEnabled,
      counterCollectionAtomicFastPathEnabled,
      roomChangeBranchProbes: ROOM_CHANGE_BRANCH_PROBES,
      waiterPauseProbes: WAITER_PAUSE_PROBES,
      paymentFreeSplitProbes: PAYMENT_FREE_SPLIT_PROBES,
      roomLaneConcurrency: ROOM_LANE_CONCURRENCY,
      roomChangeApproveAsyncPinPreLane: ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE,
      paymentLockDiagnosticsEnabled,
      paymentFreeSplitDurableMirror,
      paymentMirrorSkipPosSettingsTables,
      paymentMirrorStatelessConsumer,
      paymentFreeSplitSettingsReuse,
      paymentDomainNamedLockEnabled,
      relationalDbPath,
      appStateSplitDbPath,
      redisKeyPrefix,
      mqttEnabled: false,
      automaticCashEnabled: REALISTIC_LOAD_PROFILE,
      automaticCashBaseUrl: REALISTIC_LOAD_PROFILE
        ? AUTOMATIC_CASH_BASE_URL
        : null,
      batteryServiceUrl: REALISTIC_LOAD_PROFILE ? BATTERY_SERVICE_URL : null,
      batteryNotificationIntervalMs: REALISTIC_LOAD_PROFILE
        ? V5BT_BATTERY_NOTIFICATION_INTERVAL_MS
        : null,
      chromiumExecutablePath: CHROMIUM_EXECUTABLE_PATH || null,
      guiHeadless,
      profile: LOADTEST_PROFILE,
      pacedOrderTarget: PACED_HANDHELD_PROFILE ? PACED_ORDER_COUNT : null,
      pacedOtherActionTarget: PACED_HANDHELD_PROFILE
        ? PACED_OTHER_ACTION_COUNT
        : null,
      pacedActionIntervalMs: PACED_HANDHELD_PROFILE
        ? PACED_ACTION_INTERVAL_MS
        : null,
      pacedMaxActiveMs: PACED_HANDHELD_PROFILE ? PACED_MAX_ACTIVE_MS : null,
      realisticDurationMs: REALISTIC_HOUR_PROFILE
        ? REALISTIC_DURATION_MS
        : null,
      realisticOrderTarget: REALISTIC_HOUR_PROFILE
        ? REALISTIC_ORDER_COUNT
        : null,
      realisticOtherActionTarget: REALISTIC_HOUR_PROFILE
        ? REALISTIC_OTHER_ACTION_COUNT
        : null,
      realisticNetworkOutageMs: REALISTIC_LOAD_PROFILE
        ? REALISTIC_NETWORK_OUTAGE_MS
        : null,
      realisticStationLogoutMs: REALISTIC_LOAD_PROFILE
        ? REALISTIC_STATION_LOGOUT_MS
        : null,
      p5ActionsPerDevice: P5_ENDURANCE_PROFILE ? P5_ACTIONS_PER_DEVICE : null,
      p5ActionsPerSecond: P5_ENDURANCE_PROFILE ? P5_ACTIONS_PER_SECOND : null,
      p5TotalActions: P5_ENDURANCE_PROFILE ? P5_TOTAL_ACTIONS : null,
      p5MinimumDurationMs: P5_ENDURANCE_PROFILE ? P5_MINIMUM_DURATION_MS : null,
      p5LongPressMs: P5_ENDURANCE_PROFILE ? P5_LONG_PRESS_MS : null,
      p5GuiActionEvery: P5_ENDURANCE_PROFILE ? P5_GUI_ACTION_EVERY : null,
      p5AllowHeadless: P5_ENDURANCE_PROFILE ? P5_ALLOW_HEADLESS : null,
      v5btOperationsActionsPerDevice: V5BT_OPERATIONS_PROFILE
        ? V5BT_ACTIONS_PER_DEVICE
        : null,
      v5btSchedulerContractVersion: V5BT_OPERATIONS_PROFILE
        ? V5BT_OPERATIONS_SCHEDULER_CONTRACT_VERSION
        : null,
      v5btOperationsStage: V5BT_OPERATIONS_PROFILE
        ? V5BT_OPERATIONS_STAGE
        : null,
      v5btOperationsTotalActions: V5BT_OPERATIONS_PROFILE
        ? V5BT_TOTAL_ACTIONS
        : null,
      v5btOperationsActionIntervalMs: V5BT_OPERATIONS_PROFILE
        ? V5BT_DEVICE_ACTION_INTERVAL_MS
        : null,
      v5btOperationsCommandsPerHandheld: V5BT_OPERATIONS_PROFILE
        ? V5BT_COMMANDS_PER_HANDHELD
        : null,
      v5btOperationsCommandIntervalMinMs: V5BT_OPERATIONS_PROFILE
        ? V5BT_COMMAND_INTERVAL_MIN_MS
        : null,
      v5btOperationsCommandIntervalMaxMs: V5BT_OPERATIONS_PROFILE
        ? V5BT_COMMAND_INTERVAL_MAX_MS
        : null,
      v5btOperationsMinimumDurationMs: V5BT_OPERATIONS_PROFILE
        ? V5BT_MINIMUM_DURATION_MS
        : null,
      v5btOperationsRuntimeLimits: V5BT_OPERATIONS_PROFILE
        ? V5BT_RUNTIME_LIMITS
        : null,
    },
    backendPid: backend.child.pid,
    frontendPid: frontend.child.pid,
    logs: {
      backend: backend.logPath,
      frontend: frontend.logPath,
      events: eventsPath,
      ...(ACTION_SCHEDULE_PROFILE
        ? { baselineDiagnostics: listP5BaselineDiagnosticsPaths() }
        : {}),
      ...mockIo.logs,
    },
    recorder: recorder.summary(),
    realtime: realtimeSummary,
    pacedProfile,
    realisticProfile,
    p5Profile,
    v5btOperationsProfile,
    tableLockCanary,
    relationalAudit,
    monitor,
    runtimeMetrics,
    latencyAttribution,
    autoPrintOwnerAudit,
    stationStateMarkerLockElisionAudit,
    stationStateLastWriteAudit,
    stationStateLastWritePersistenceAudit,
    rtFiscalProviderMetrics,
    mockIoMetrics,
    cleanup,
  };
  await fs.writeFile(
    reportJsonPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(reportMdPath, renderMarkdown(summary), "utf8");
  await writeEvent({ event: "finished", reportJsonPath, reportMdPath, cleanup });
  await closeEventFile();
  console.log(
    JSON.stringify(
      {
        ok: true,
        reportJsonPath,
        reportMdPath,
        summary: compactConsoleSummary(summary),
      },
      null,
      2,
    ),
  );
}

async function findProcessIds(name) {
  if (process.platform === "win32") return [];
  try {
    const proc = spawn("pgrep", ["-x", name], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    await new Promise((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", resolve);
    });
    return out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function formatMysqlCounterMb(monitor, key) {
  const value = monitor?.mysqlStatusDelta?.[key];
  if (Number.isFinite(value)) return `${money(value / 1024 / 1024)} MB`;
  return monitor?.mysqlStatusResetKeys?.includes(key)
    ? "n/d (contatore resettato)"
    : "n/d";
}

function compactConsoleSummary(summary) {
  const rec = summary.recorder;
  const rtProvider = summary.rtFiscalProviderMetrics?.body || {};
  const innodbDataWritten =
    summary.monitor.mysqlStatusDelta.Innodb_data_written;
  return {
    durationMs: rec.durationMs,
    businessOps: rec.businessOps,
    httpRequests: rec.httpRequests,
    httpRequestMb: money(rec.httpRequestBytes / 1024 / 1024),
    httpResponseMb: money(rec.httpResponseBytes / 1024 / 1024),
    latencyMs: rec.latencyMs,
    failures: rec.failures.length,
    rtFiscalAttempts: rec.rtFiscalAttempts,
    rtFiscalSuccess: rec.rtFiscalSuccess,
    rtFiscalProviderReceipts: rtProvider.receiptRequests ?? null,
    realtimeClients: summary.realtime?.connected ?? 0,
    realtimePayloadEvents: summary.realtime?.payloadEvents ?? 0,
    realtimeDeliveryLagMs: summary.realtime?.deliveryLagMs ?? null,
    relationalDrained: summary.relationalAudit?.drained === true,
    outboxUnpublished: summary.relationalAudit?.eventOutboxUnpublished ?? null,
    printFailedFinal: summary.relationalAudit?.printSpoolFailedFinal ?? null,
    fiscalOutboxProblem: summary.relationalAudit?.fiscalOutboxProblem ?? null,
    paymentMirrorFailed: summary.relationalAudit?.paymentMirrorFailed ?? null,
    pacedProfile: summary.pacedProfile
      ? {
          activeDurationMs: summary.pacedProfile.activeDurationMs,
          devicesCompletedTargets: summary.pacedProfile.devicesCompletedTargets,
          devicesSuccessfulTargets:
            summary.pacedProfile.devicesSuccessfulTargets,
          devicesMeetingPersistedOrderTarget:
            summary.pacedProfile.devicesMeetingPersistedOrderTarget,
          minStartGapMs: summary.pacedProfile.minStartGapMs,
          totals: summary.pacedProfile.totals,
        }
      : null,
    realisticProfile: summary.realisticProfile
      ? {
          activeDurationMs: summary.realisticProfile.activeDurationMs,
          devicesAtTarget: summary.realisticProfile.devicesAtTarget,
          devicesMeetingPersistedOrderTarget:
            summary.realisticProfile.devicesMeetingPersistedOrderTarget,
          totals: summary.realisticProfile.totals,
        }
      : null,
    p5Profile: summary.p5Profile
      ? {
          durationMs: summary.p5Profile.durationMs,
          totalStarted: summary.p5Profile.totalStarted,
          totalCompleted: summary.p5Profile.totalCompleted,
          totalFailed: summary.p5Profile.totalFailed,
          rate: summary.p5Profile.rate,
          actionLatencyMs: summary.p5Profile.actionLatencyMs,
          actionLatencyDrift: summary.p5Profile.actionLatencyDrift,
          steadyActionLatencyMs: summary.p5Profile.steadyActionLatencyMs,
          steadyActionLatencyDrift: summary.p5Profile.steadyActionLatencyDrift,
          disruptiveActionCount: summary.p5Profile.disruptiveActionCount,
        }
      : null,
    v5btOperationsProfile: summary.v5btOperationsProfile
      ? {
          durationMs: summary.v5btOperationsProfile.durationMs,
          totalStarted: summary.v5btOperationsProfile.totalStarted,
          totalCompleted: summary.v5btOperationsProfile.totalCompleted,
          totalFailed: summary.v5btOperationsProfile.totalFailed,
          maximumInFlight: summary.v5btOperationsProfile.maximumInFlight,
          actionsPerDevice: summary.v5btOperationsProfile.actionsPerDevice,
          mobileActionAverageGapMs:
            summary.v5btOperationsProfile.cadence?.mobileActionAverageGapMs ??
            null,
          commandAverageGapMs:
            summary.v5btOperationsProfile.cadence?.commandAverageGapMs ?? null,
          cadenceGate: summary.v5btOperationsProfile.cadenceGate,
          actionLatencyMs: summary.v5btOperationsProfile.actionLatencyMs,
          commandLatencyMs: summary.v5btOperationsProfile.commandLatencyMs,
          runtimeGate: summary.v5btOperationsProfile.runtimeGate,
          fixtureSummary: summary.v5btOperationsProfile.fixtureSummary,
          missingMobileActionTypes:
            summary.v5btOperationsProfile.missingMobileActionTypes,
          mobileActionTypesWithoutSuccess:
            summary.v5btOperationsProfile.mobileActionTypesWithoutSuccess,
          devicesMeetingPersistedOrderTarget:
            summary.v5btOperationsProfile.devicesMeetingPersistedOrderTarget,
          persistedOrderTargetOk:
            summary.v5btOperationsProfile.persistedOrderTargetOk,
          persistedOrderGate: summary.v5btOperationsProfile.persistedOrderGate,
        }
      : null,
    radio: rec.radio,
    printerMetrics: summary.mockIoMetrics?.printers?.body?.totals ?? null,
    dbBytesWrittenApproxMb: Number.isFinite(innodbDataWritten)
      ? money(innodbDataWritten / 1024 / 1024)
      : null,
    mysqlStatusResetKeys: summary.monitor.mysqlStatusResetKeys,
    mysqlStatusServerRestarted: summary.monitor.mysqlStatusServerRestarted,
    dbRowsInserted: summary.monitor.mysqlStatusDelta.Innodb_rows_inserted,
    dbRowsUpdated: summary.monitor.mysqlStatusDelta.Innodb_rows_updated,
    tableBytesMb: money(summary.monitor.tableBytesEnd / 1024 / 1024),
  };
}

function renderMarkdown(summary) {
  const rec = summary.recorder;
  const mon = summary.monitor;
  const rtProvider = summary.rtFiscalProviderMetrics;
  const waiterPauseDeliveryRows = Object.entries(
    summary.realtime?.deliveryLagMsByReason || {},
  ).filter(
    ([reason]) =>
      reason === "waiter_pause_started" || reason === "waiter_pause_stopped",
  );
  const topOps = Object.entries(rec.ops)
    .filter(([key]) => !key.startsWith("business:"))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);
  const failures = rec.failures.slice(-40);
  return `# Load Test ${summary.runId}

## Configurazione
- Backend: ${summary.apiBaseUrl}
- Frontend GUI: ${summary.frontendBaseUrl}
- Palmari API: ${summary.config.handHeldCount}
- Postazioni API: ${summary.config.stationCount}
- GUI reali Playwright: ${summary.config.guiCount} mobile${summary.realisticProfile || summary.p5Profile || summary.v5btOperationsProfile ? " + 1 postazione" : ""}
- Client realtime SSE: ${summary.config.realtimeClientCount}
- Operazioni per device: ${summary.config.opsPerDevice}
- Profilo: ${summary.config.profile}
- Profilo realistico durata/ordini/altre azioni: ${summary.config.realisticDurationMs ?? "n/d"} ms / ${summary.config.realisticOrderTarget ?? "n/d"} / ${summary.config.realisticOtherActionTarget ?? "n/d"}
- Profilo realistico blackout/logout postazione: ${summary.config.realisticNetworkOutageMs ?? "n/d"} / ${summary.config.realisticStationLogoutMs ?? "n/d"} ms
- Profilo P5 azioni/device, totale e rate massimo: ${summary.config.p5ActionsPerDevice ?? "n/d"} / ${summary.config.p5TotalActions ?? "n/d"} / ${summary.config.p5ActionsPerSecond ?? "n/d"} azioni/s
- Profilo P5 durata minima e pressione prolungata: ${summary.config.p5MinimumDurationMs ?? "n/d"} / ${summary.config.p5LongPressMs ?? "n/d"} ms
- Profilo V5BT azioni/device e totale: ${summary.config.v5btOperationsActionsPerDevice ?? "n/d"} / ${summary.config.v5btOperationsTotalActions ?? "n/d"}
- Profilo V5BT intervallo azioni e gate medio comande: ${summary.config.v5btOperationsActionIntervalMs ?? "n/d"} ms / ${summary.config.v5btOperationsCommandIntervalMinMs ?? "n/d"}-${summary.config.v5btOperationsCommandIntervalMaxMs ?? "n/d"} ms
- Profilo V5BT comande per palmare e durata minima: ${summary.config.v5btOperationsCommandsPerHandheld ?? "n/d"} / ${summary.config.v5btOperationsMinimumDurationMs ?? "n/d"} ms
- Multi-processo: ${summary.config.multiprocess ? `si, ${summary.config.apiWorkerCount} api-worker` : "no"}
- Worker lock tavoli dedicati: ${summary.config.tableLockWorkerCount}
- Tombstone lock tavoli: ${summary.config.tableLockTombstonesEnabled ? "attivi" : "disattivi"}
- Pool worker lock MySQL/Redis: ${summary.config.tableLockMysqlConnectionLimit}/${summary.config.tableLockRedisPoolSize}
- Fast auth API worker: ${summary.config.apiWorkerAuthFastPathEnabled ? "attivo" : "disattivo"} (pool Redis ${summary.config.apiWorkerRedisPoolSize})
- Refresh lock target order.create: ${summary.config.orderCreateTargetedLockRefreshEnabled ? "attivo" : "disattivo"}
- Refresh lock/postazioni parallelo order.create: ${summary.config.orderCreateParallelExternalRefreshEnabled ? "attivo" : "disattivo"}
- Write puntuale table.sync: ${summary.config.tableSyncAppStateFastPathEnabled ? "attivo" : "disattivo"}
- Write puntuale table.room-move request: ${summary.config.tableRoomMoveRequestAppStateFastPathEnabled ? "attivo" : "disattivo"}
- Sync sessione/audit puntuale waiter pause: ${summary.config.waiterPauseSessionAuditFastPathEnabled ? "attivo" : "disattivo"}
- Writer atomico puntuale counter collect: ${summary.config.counterCollectionAtomicFastPathEnabled ? "attivo" : "disattivo"}
- Sonde room-change direct/pending: ${summary.config.roomChangeBranchProbes}
- Sonde waiter pause concorrenti: ${summary.config.waiterPauseProbes}
- Sonde payment.free_split completate: ${summary.config.paymentFreeSplitProbes}
- Skip posSettings.tables payment mirror: ${summary.config.paymentMirrorSkipPosSettingsTables ? "attivo" : "disattivo"}
- Consumer payment mirror stateless: ${summary.config.paymentMirrorStatelessConsumer ? "attivo" : "disattivo"}
- Riuso impostazioni POS payment.free_split: ${summary.config.paymentFreeSplitSettingsReuse ? "attivo" : "disattivo"}
- Concorrenza room lane: ${summary.config.roomLaneConcurrency}
- PIN asincrono pre-lane room-change approve: ${summary.config.roomChangeApproveAsyncPinPreLane ? "attivo" : "disattivo"}
- Stampa: ${summary.config.printingEnabled ? `${summary.config.printerCount} mock TCP ${summary.config.printerHost}:${summary.config.printerPorts.join(",")}` : "disabilitata"}
- Intervallo owner auto-print: ${summary.config.printSpoolAutoPrintOwnerIntervalMs} ms${summary.config.profile === "v5bt-operations-30" ? (summary.config.v5btOperationsDiagnosticAutoPrintOwnerIntervalMs === null ? " (profilo certificato)" : " (canary diagnostico NON_GATE)") : ""}
- Skip lock marker station-state: ${summary.config.stationStateMarkerLockSkipEnabled ? "attivo (canary diagnostico NON_GATE/NON_PROMOTABLE)" : "disattivo (profilo ufficiale)"}
- Coalescing lastWriteAt station-state: ${summary.config.stationStateLastWriteCoalesceEnabled ? `attivo ${summary.config.stationStateLastWriteCoalesceIntervalMs} ms (canary diagnostico NON_GATE/NON_PROMOTABLE)` : "disattivo (profilo ufficiale)"}
- Lock flush lastWriteAt station-state: ${summary.config.stationStateLastWriteNowaitEnabled ? "NOWAIT" : "DISABLED"}
- Fiscale: mock ${summary.config.rtBaseUrl}, campioni ${summary.config.fiscalSampleLimit}
- SQLite relazionale isolato: ${summary.config.relationalDbPath}
- SQLite app-state split isolato: ${summary.config.appStateSplitDbPath}
- Spool stampa per-run: ${summary.config.printSpoolDir}
- Cleanup spool stampa: ${summary.cleanup.printSpool.verified ? "verificato" : "fallito"} (rimosso=${summary.cleanup.printSpool.removed ? "si" : "no"}, residuo=${summary.cleanup.printSpool.remaining === false ? "no" : "si"})
- Redis prefix isolato: ${summary.config.redisKeyPrefix}
- MQTT: disabilitato
- Cassa automatica: ${summary.config.automaticCashEnabled ? `mock ${summary.config.automaticCashBaseUrl}` : "disabilitata"}
- Batteria: ${summary.config.batteryServiceUrl ? `mock eventi ${summary.config.batteryServiceUrl}, intervallo ${summary.config.batteryNotificationIntervalMs} ms` : "non simulata"}
- I/O non-loopback consentito: ${summary.config.allowNonLoopbackIo ? "si" : "no"}
- Binding backend solo loopback: ${summary.config.backendLoopbackOnly ? summary.config.backendHost : "no"}
- Canary lock tavolo cross-processo: ${summary.tableLockCanary ? (summary.tableLockCanary.ok ? `verde (${summary.tableLockCanary.steps.length} verifiche)` : "rosso") : "non applicabile"}

## Sintesi
- Durata: ${Math.round(rec.durationMs / 1000)} s
- Operazioni business registrate: ${rec.businessOps}
- Richieste HTTP totali: ${rec.httpRequests}
- Traffico HTTP stimato: request ${money(rec.httpRequestBytes / 1024 / 1024)} MB, response ${money(rec.httpResponseBytes / 1024 / 1024)} MB
- Latenza HTTP globale P50/P95/P98/P99/P99.9/max: ${rec.latencyMs.p50ms} / ${rec.latencyMs.p95ms} / ${rec.latencyMs.p98ms} / ${rec.latencyMs.p99ms} / ${rec.latencyMs.p999ms} / ${rec.latencyMs.maxMs} ms
- Drift HTTP primo/ultimo 10% P50/P95/P99/P99.9: ${rec.latencyDrift?.drift?.p50ms?.percent ?? "n/d"}% / ${rec.latencyDrift?.drift?.p95ms?.percent ?? "n/d"}% / ${rec.latencyDrift?.drift?.p99ms?.percent ?? "n/d"}% / ${rec.latencyDrift?.drift?.p999ms?.percent ?? "n/d"}%
- Errori/risposte non attese campionate: ${rec.failures.length}
- RT fiscale: tentativi ${rec.rtFiscalAttempts}, successi HTTP ${rec.rtFiscalSuccess}
- RT provider metrics: ${rtProvider?.ok ? JSON.stringify(rtProvider.body) : `non disponibili (${rtProvider?.status ?? rtProvider?.error ?? "n/d"})`}
- Realtime SSE connessi: ${summary.realtime?.connected ?? 0}/${summary.realtime?.expected ?? 0}, payload ${summary.realtime?.payloadEvents ?? 0}, lag P50/P95/P99/P99.9 ${summary.realtime?.deliveryLagMs?.p50ms ?? 0} / ${summary.realtime?.deliveryLagMs?.p95ms ?? 0} / ${summary.realtime?.deliveryLagMs?.p99ms ?? 0} / ${summary.realtime?.deliveryLagMs?.p999ms ?? 0} ms
- Radio WS: ${rec.radio ? `${rec.radio.connected}/${rec.radio.expected} connessi, ${rec.radio.transmissions} trasmissioni, ${rec.radio.framesSent} frame TX, ${rec.radio.busyResponses} busy` : "non eseguita"}
- Stampanti virtuali: ${summary.mockIoMetrics?.printers?.body ? `${summary.mockIoMetrics.printers.body.totals.connections} job/connessioni, ${summary.mockIoMetrics.printers.body.totals.bytes} byte` : "metriche non disponibili"}
- Drain relazionale: ${summary.relationalAudit?.drained === true ? "completo" : "incompleto"} in ${summary.relationalAudit?.waitedMs ?? 0} ms; outbox ${summary.relationalAudit?.eventOutboxUnpublished ?? "n/d"}, print pending/failed ${summary.relationalAudit?.printSpoolPending ?? "n/d"}/${summary.relationalAudit?.printSpoolFailedFinal ?? "n/d"}, fiscal pending/problem ${summary.relationalAudit?.fiscalOutboxPending ?? "n/d"}/${summary.relationalAudit?.fiscalOutboxProblem ?? "n/d"}, payment mirror pending/failed ${summary.relationalAudit?.paymentMirrorPending ?? "n/d"}/${summary.relationalAudit?.paymentMirrorFailed ?? "n/d"}

## Realtime waiter pause delivery
| Evento | Count | P50 | P95 | P99 | P99.9 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${waiterPauseDeliveryRows.map(([reason, item]) => `| ${reason} | ${summary.realtime?.eventReasonCounts?.[reason] ?? 0} | ${item.p50ms} | ${item.p95ms} | ${item.p99ms} | ${item.p999ms} | ${item.maxMs} |`).join("\n") || "| n/d | 0 | 0 | 0 | 0 | 0 | 0 |"}

${
  summary.pacedProfile
    ? `## Profilo cadenzato palmari
- Finestra attiva: ${summary.pacedProfile.activeDurationMs} ms su massimo ${summary.pacedProfile.maxActiveMs} ms
- Intervallo minimo richiesto: ${summary.pacedProfile.actionIntervalMs} ms; minimo osservato ${summary.pacedProfile.minStartGapMs} ms; violazioni ${summary.pacedProfile.totals.spacingViolations}
- Target per palmare: ${summary.pacedProfile.orderTargetPerDevice} ordini + ${summary.pacedProfile.otherTargetPerDevice} altre azioni
- Palmari che hanno tentato tutti i target: ${summary.pacedProfile.devicesCompletedTargets}/${summary.pacedProfile.devices}
- Palmari con tutte le risposte applicative positive: ${summary.pacedProfile.devicesSuccessfulTargets}/${summary.pacedProfile.devices}
- Palmari con almeno ${summary.pacedProfile.orderTargetPerDevice} ordini persistiti: ${summary.pacedProfile.devicesMeetingPersistedOrderTarget}/${summary.pacedProfile.devices}
- Totali tentati: ordini ${summary.pacedProfile.totals.ordersAttempted}, altre azioni ${summary.pacedProfile.totals.otherAttempted}
- Totali confermati al client: ordini ${summary.pacedProfile.totals.ordersCreated}, altre azioni ${summary.pacedProfile.totals.otherSucceeded}
- Ordini persistiti nel relazionale: ${summary.pacedProfile.ordersPersisted}; minimo per palmare presente ${summary.pacedProfile.minPersistedOrdersPerPresentDevice}
`
    : ""
}

${
  summary.realisticProfile
    ? `## Profilo realistico 20x4
- Finestra attiva: ${summary.realisticProfile.activeDurationMs} ms su target ${summary.realisticProfile.durationTargetMs} ms
- Target per palmare: ${summary.realisticProfile.orderTargetPerDevice} comande + ${summary.realisticProfile.otherTargetPerDevice} azioni distribuite casualmente
- Palmari con esattamente il target di comande confermate: ${summary.realisticProfile.devicesAtTarget}/${summary.realisticProfile.devices}
- Palmari con almeno il target persistito: ${summary.realisticProfile.devicesMeetingPersistedOrderTarget}/${summary.realisticProfile.devices}
- Totali: ${summary.realisticProfile.totals.ordersCreated}/${summary.realisticProfile.totals.ordersAttempted} comande confermate, ${summary.realisticProfile.totals.otherCompleted}/${summary.realisticProfile.totals.otherAttempted} altre azioni completate
- Ordini relazionali finali: ${summary.realisticProfile.ordersPersisted}; minimo per palmare presente ${summary.realisticProfile.minPersistedOrdersPerPresentDevice}
`
    : ""
}

${
  summary.v5btOperationsProfile
    ? `## Profilo operativo V5BT 25x5
- Finestra attiva: ${Math.round(summary.v5btOperationsProfile.durationMs)} ms; minimo teorico ${Math.round(summary.v5btOperationsProfile.minimumDurationMs)} ms
- Quota: ${summary.v5btOperationsProfile.actionsPerDevice} azioni per ciascuno dei ${summary.v5btOperationsProfile.deviceCount} device, totale ${summary.v5btOperationsProfile.totalStarted}/${summary.v5btOperationsProfile.totalActions}
- Completate/successo/eccezioni: ${summary.v5btOperationsProfile.totalCompleted}/${summary.v5btOperationsProfile.totalSucceeded}/${summary.v5btOperationsProfile.totalFailed}
- Richieste contemporaneamente pendenti, massimo osservato: ${summary.v5btOperationsProfile.maximumInFlight}
- Cadenza mobile media: ${money(summary.v5btOperationsProfile.cadence.mobileActionAverageGapMs)} ms; target ${summary.v5btOperationsProfile.cadence.targetActionIntervalMs} ms; esito ${summary.v5btOperationsProfile.cadence.mobileActionCadenceOk ? "verde" : "rosso"}
- Cadenza comande media per palmare: ${money(summary.v5btOperationsProfile.cadence.commandAverageGapMs)} ms; gate ${summary.v5btOperationsProfile.cadenceGate.commandIntervalMinMs}-${summary.v5btOperationsProfile.cadenceGate.commandIntervalMaxMs} ms; esito ${summary.v5btOperationsProfile.cadence.commandCadenceOk ? "verde" : "rosso"}
- Violazioni per partenza anticipata: ${summary.v5btOperationsProfile.cadence.earlyActionGaps}
- Gate runtime anti-tempesta: ${summary.v5btOperationsProfile.runtimeGate?.ok ? "verde" : "rosso"}; in-flight globale massimo ${summary.v5btOperationsProfile.maximumInFlight}/${summary.v5btOperationsProfile.runtimeGate?.limits?.maxInFlightGlobal ?? "n/d"}
- Latenza comande P95: ${summary.v5btOperationsProfile.commandLatencyMs?.p95ms ?? "n/d"} ms; limite ${summary.v5btOperationsProfile.runtimeGate?.limits?.commandP95MaxMs ?? "n/d"} ms
- Budget letture GUI layout/ordini: ${summary.v5btOperationsProfile.runtimeGate?.guiRequestTraffic?.ok ? "verde" : "rosso"}; limite per route/GUI ${summary.v5btOperationsProfile.runtimeGate?.guiRequestTraffic?.perRoutePerGuiBudget ?? "n/d"}
- Catalogo mobile richiesto: ${summary.v5btOperationsProfile.requiredMobileActionTypes.length} tipi; mancanti ${summary.v5btOperationsProfile.missingMobileActionTypes.length}; senza almeno un successo ${summary.v5btOperationsProfile.mobileActionTypesWithoutSuccess.length}
- GUI reali: ${summary.v5btOperationsProfile.guiMobileCount} mobile + ${summary.v5btOperationsProfile.guiStationCount} postazione; cambio TAVOLI/BANCO incluso
- Ordini persistiti: ${summary.v5btOperationsProfile.ordersPersisted}; palmari con almeno ${summary.v5btOperationsProfile.orderTargetPerHandheld}: ${summary.v5btOperationsProfile.devicesMeetingPersistedOrderTarget}/${summary.config.handHeldCount}; esito ${summary.v5btOperationsProfile.persistedOrderTargetOk ? "verde" : "rosso"}
- Latenza azione P50/P95/P99/P99.9/max: ${summary.v5btOperationsProfile.actionLatencyMs.p50ms} / ${summary.v5btOperationsProfile.actionLatencyMs.p95ms} / ${summary.v5btOperationsProfile.actionLatencyMs.p99ms} / ${summary.v5btOperationsProfile.actionLatencyMs.p999ms} / ${summary.v5btOperationsProfile.actionLatencyMs.maxMs} ms

### Copertura azioni mobile
| Tipo | Tentativi | Completate | Successi business | Eccezioni |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(summary.v5btOperationsProfile.mobileActionCoverage)
  .map(
    ([type, item]) =>
      `| ${type} | ${item.attempted} | ${item.completed} | ${item.businessSucceeded} | ${item.exceptions} |`,
  )
  .join("\n")}

### Quota e cadenza per device
| Device | Ruolo | Azioni | Comande | Gap azioni medio ms | Gap comande medio ms |
| --- | --- | ---: | ---: | ---: | ---: |
${summary.v5btOperationsProfile.cadence.devices.map((device) => `| ${device.deviceId} | ${device.kind} | ${device.actionCount} | ${device.commandCount} | ${device.actionAverageGapMs === null ? "n/d" : money(device.actionAverageGapMs)} | ${device.commandAverageGapMs === null ? "n/d" : money(device.commandAverageGapMs)} |`).join("\n")}
`
    : ""
}

${
  summary.p5Profile
    ? `## Profilo P5 endurance 20x5
- Finestra attiva: ${summary.p5Profile.durationMs} ms; minimo teorico ${summary.p5Profile.minimumDurationMs} ms
- Quota: ${summary.p5Profile.actionsPerDevice} azioni per ciascuno dei ${summary.p5Profile.deviceCount} device, totale ${summary.p5Profile.totalStarted}/${summary.p5Profile.totalActions}
- Completate/successo eccezioni/fallite: ${summary.p5Profile.totalCompleted}/${summary.p5Profile.totalSucceeded}/${summary.p5Profile.totalFailed}
- Rate massimo: ${summary.p5Profile.actionsPerSecond} azioni/s; finestra fissa max ${summary.p5Profile.rate.maxFixedWindow}, finestra mobile max ${summary.p5Profile.rate.maxSlidingWindow}, esito ${summary.p5Profile.rate.ok ? "verde" : "rosso"}
- Rate effettivo: ${money(summary.p5Profile.rate.effectiveActionsPerSecond)} azioni/s; gap minimo ${summary.p5Profile.rate.minimumGapMs} ms; ritardo accumulato controllato ${Math.round(summary.p5Profile.scheduleDelayMs)} ms
- Latenza azione P50/P95/P98/P99/P99.9/max: ${summary.p5Profile.actionLatencyMs.p50ms} / ${summary.p5Profile.actionLatencyMs.p95ms} / ${summary.p5Profile.actionLatencyMs.p98ms} / ${summary.p5Profile.actionLatencyMs.p99ms} / ${summary.p5Profile.actionLatencyMs.p999ms} / ${summary.p5Profile.actionLatencyMs.maxMs} ms
- Latenza azioni steady P50/P95/P98/P99/P99.9/max: ${summary.p5Profile.steadyActionLatencyMs.p50ms} / ${summary.p5Profile.steadyActionLatencyMs.p95ms} / ${summary.p5Profile.steadyActionLatencyMs.p98ms} / ${summary.p5Profile.steadyActionLatencyMs.p99ms} / ${summary.p5Profile.steadyActionLatencyMs.p999ms} / ${summary.p5Profile.steadyActionLatencyMs.maxMs} ms; azioni disruptive escluse ${summary.p5Profile.disruptiveActionCount}
- Checkpoint latenze JSONL: ${summary.p5Profile.latencyCheckpointPath} ogni ${summary.p5Profile.latencyCheckpointIntervalMs} ms
- Diagnostica route/retry JSONL: ${summary.p5Profile.baselineDiagnosticsPaths.join(", ")}
- Drift azioni primo/ultimo 10% P50/P95/P99/P99.9: ${summary.p5Profile.actionLatencyDrift.drift.p50ms.percent ?? "n/d"}% / ${summary.p5Profile.actionLatencyDrift.drift.p95ms.percent ?? "n/d"}% / ${summary.p5Profile.actionLatencyDrift.drift.p99ms.percent ?? "n/d"}% / ${summary.p5Profile.actionLatencyDrift.drift.p999ms.percent ?? "n/d"}%
- Drift azioni steady primo/ultimo 10% P50/P95/P99/P99.9: ${summary.p5Profile.steadyActionLatencyDrift.drift.p50ms.percent ?? "n/d"}% / ${summary.p5Profile.steadyActionLatencyDrift.drift.p95ms.percent ?? "n/d"}% / ${summary.p5Profile.steadyActionLatencyDrift.drift.p99ms.percent ?? "n/d"}% / ${summary.p5Profile.steadyActionLatencyDrift.drift.p999ms.percent ?? "n/d"}%
- GUI reali: ${summary.p5Profile.guiMobileCount} mobile + ${summary.p5Profile.guiStationCount} postazione; fondi cassa mock generati ${summary.p5Profile.cashFloatsGenerated}
- Ordini persistiti: ${summary.p5Profile.ordersPersisted}; palmari con almeno ${summary.p5Profile.orderTargetPerHandheld}: ${summary.p5Profile.devicesMeetingPersistedOrderTarget}/${summary.config.handHeldCount}

### Drift per decile temporale
| Decile | Sequenze | Count | P50 | P95 | P98 | P99 | P99.9 | Max |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${summary.p5Profile.actionTimeWindows.map((window) => `| ${window.index} | ${window.firstSequence}-${window.lastSequence} | ${window.count} | ${window.latencyMs.p50ms} | ${window.latencyMs.p95ms} | ${window.latencyMs.p98ms} | ${window.latencyMs.p99ms} | ${window.latencyMs.p999ms} | ${window.latencyMs.maxMs} |`).join("\n")}

### Tipi azione
| Tipo | Count | Fail | P50 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${Object.entries(summary.p5Profile.actionTypes)
  .map(
    ([type, item]) =>
      `| ${type} | ${item.count} | ${item.failed} | ${item.latencyMs.p50ms} | ${item.latencyMs.p95ms} | ${item.latencyMs.p99ms} | ${item.latencyMs.maxMs} |`,
  )
  .join("\n")}
`
    : ""
}

## DB MySQL
- Bytes InnoDB scritti: ${formatMysqlCounterMb(mon, "Innodb_data_written")}
- Redo log scritto: ${formatMysqlCounterMb(mon, "Innodb_os_log_written")}
- Righe inserite: ${mon.mysqlStatusDelta.Innodb_rows_inserted ?? "n/d"}
- Righe aggiornate: ${mon.mysqlStatusDelta.Innodb_rows_updated ?? "n/d"}
- Righe eliminate: ${mon.mysqlStatusDelta.Innodb_rows_deleted ?? "n/d"}
- Handler write/update/delete: ${mon.mysqlStatusDelta.Handler_write ?? "n/d"} / ${mon.mysqlStatusDelta.Handler_update ?? "n/d"} / ${mon.mysqlStatusDelta.Handler_delete ?? "n/d"}
- Deadlock InnoDB: ${mon.mysqlStatusDelta.Innodb_deadlocks ?? "n/d"}; attese lock: ${mon.mysqlStatusDelta.Innodb_row_lock_waits ?? "n/d"}; tempo lock: ${mon.mysqlStatusDelta.Innodb_row_lock_time ?? "n/d"} ms
- Contatori invalidati da reset/restart: ${mon.mysqlStatusResetKeys?.length ? mon.mysqlStatusResetKeys.join(", ") : "nessuno"}${mon.mysqlStatusServerRestarted ? " (restart MySQL rilevato)" : ""}
- Dimensione finale tabelle load: ${money(mon.tableBytesEnd / 1024 / 1024)} MB
- Righe per tabella: ${JSON.stringify(mon.rowCounts)}

## Backend/Processi
${Object.entries(mon.processSummary)
  .map(
    ([pid, item]) =>
      `- PID ${pid} (${item.role}, ${item.sources.join("+")}): RSS max ${item.maxRssMb} MB, CPU ${item.maxCpuPercent === null ? `tick/sec max ${item.maxCpuTickDeltaPerSec}` : `max ${item.maxCpuPercent}%, media ${item.avgCpuPercent}%`}`,
  )
  .join("\n")}

${renderRuntimeMetricsMarkdown(summary.runtimeMetrics)}

${renderLatencyAttributionMarkdown(summary.latencyAttribution)}

${renderStationStateMarkerLockElisionAuditMarkdown(summary.stationStateMarkerLockElisionAudit)}

${renderStationStateLastWriteAuditMarkdown(summary.stationStateLastWriteAudit, summary.stationStateLastWritePersistenceAudit)}

## Operazioni principali
| Operazione | Count | OK | Fail | P50 | P95 | P98 | P99 | P99.9 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${topOps.map(([key, item]) => `| ${key} | ${item.count} | ${item.ok} | ${item.fail} | ${item.p50ms} | ${item.p95ms} | ${item.p98ms} | ${item.p99ms} | ${item.p999ms} | ${item.maxMs} |`).join("\n")}

## GUI Reali
${rec.gui
  .map(
    (gui) =>
      `- ${gui.kind || "GUI"} ${gui.index + 1}: durata ${Math.round(gui.durationMs / 1000)}s, request ${gui.requests}, request fallite ${gui.requestFailures ?? "n/d"}, interazioni ${gui.interactions ?? "n/d"}, HTTP 4xx/5xx ${gui.responses4xx ?? "n/d"}/${gui.responses5xx ?? "n/d"}, console error ${gui.consoleErrors ?? "n/d"}, resourceCount ${gui.perf?.resourceCount ?? "n/d"}`,
  )
  .join("\n")}

## Copertura Scenario
| Funzione | Tentativi | OK | Fail |
| --- | ---: | ---: | ---: |
${
  Object.entries(rec.coverage || {})
    .map(
      ([name, item]) =>
        `| ${name} | ${item.attempts} | ${item.ok} | ${item.fail} |`,
    )
    .join("\n") || "| n/d | 0 | 0 | 0 |"
}

## Ultimi errori/anomalie
${failures.length ? failures.map((failure) => `- ${failure.type} status ${failure.status}: ${JSON.stringify(failure.detail)}`).join("\n") : "- Nessuna anomalia registrata nel campione finale."}

## File
- Report JSON: ${reportJsonPath}
- Eventi JSONL: ${eventsPath}
- Log backend: ${summary.logs.backend}
- Diagnostica baseline: ${Array.isArray(summary.logs.baselineDiagnostics) ? summary.logs.baselineDiagnostics.join(", ") : "n/d"}
- Log frontend: ${summary.logs.frontend}
`;
}

function renderLatencyAttributionMarkdown(attribution) {
  if (!attribution) return "";
  const rows = Object.entries(attribution.categories || {}).map(
    ([name, category]) =>
      `| ${name} | ${category.status} | ${category.missingMetrics.length} | ${category.cardinalityMismatches.length} | ${category.unstableLabelFamilies.length} |`,
  );
  return `## Attribuzione Latenza V5BT
- Schema/stato: ${attribution.schemaVersion} / ${attribution.status}
- Categorie incomplete: ${attribution.incompleteCategories.join(", ") || "nessuna"}

| Categoria | Stato | Metriche mancanti | Mismatch | Label instabili |
| --- | --- | ---: | ---: | ---: |
${rows.join("\n")}`;
}

function renderStationStateMarkerLockElisionAuditMarkdown(audit) {
  if (!audit) return "";
  return `## Audit Marker Station-State V5BT
- Schema/stato: ${audit.schemaVersion} / ${audit.status}
- Lock flush: ${audit.flushLockMode}
- Flag: ${audit.configuredEnabled ? "ON diagnostico" : "OFF ufficiale"}
- Probe/applicati/fallback: ${audit.counts.probe} / ${audit.counts.applied} / ${audit.counts.canonicalFallback}
- State read count/P95/max: ${audit.stateRead.count} / ${audit.stateRead.p95Ms} ms / ${audit.stateRead.maxMs} ms
- Delta dal riferimento count/P95/max: ${audit.comparison.countDelta} / ${audit.comparison.p95DeltaMs} ms / ${audit.comparison.maxDeltaMs} ms
- Errori o rollback transazionali: ${audit.counts.transactionFailures}
- Controlli falliti: ${audit.failures.join(", ") || "nessuno"}`;
}

function renderStationStateLastWriteAuditMarkdown(audit, persistence) {
  if (!audit) return "";
  return `## Audit LastWriteAt Station-State V5BT
- Schema/stato: ${audit.schemaVersion} / ${audit.status}
- Enqueue/coalesced/in-flight/flushed/batch: ${audit.counts.enqueued} / ${audit.counts.coalesced} / ${audit.counts.covered} / ${audit.counts.flushed} / ${audit.counts.batches}
- Retry/deferral lock/errori/invalidi/futuri/regressioni: ${audit.counts.retries} / ${audit.counts.contentionDeferrals} / ${audit.counts.errors} / ${audit.counts.invalid} / ${audit.counts.future} / ${audit.counts.clockRegression}
- Coda pending/running/eta massima: ${audit.gauges.pending} / ${audit.gauges.running} / ${audit.gauges.oldestAgeMs} ms
- Watermark DB marker/station/lag: ${persistence?.markerMs ?? "n/d"} / ${persistence?.stationMaxMs ?? "n/d"} / ${persistence?.lagMs ?? "n/d"} ms (${persistence?.ok ? "PASS" : "FAIL"})
- Controlli falliti: ${audit.failures.join(", ") || "nessuno"}`;
}

function histogramBucketAt(snapshot, percentile = 0.95) {
  if (!snapshot?.count) return "n/d";
  const target = Math.max(1, Math.ceil(snapshot.count * percentile));
  let running = 0;
  for (const [bucket, count] of Object.entries(snapshot.buckets || {})) {
    running += Number(count) || 0;
    if (running >= target) return `<=${bucket}`;
  }
  return `>${Object.keys(snapshot.buckets || {}).at(-1) || "bucket"}`;
}

function topHistogramRows(map, limit = 8) {
  return Object.entries(map || {})
    .sort((left, right) => (right[1]?.count || 0) - (left[1]?.count || 0))
    .slice(0, limit);
}

function histogramRowsByPrefix(map, prefix) {
  return Object.entries(map || {})
    .filter(([label]) => label.startsWith(prefix))
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function renderRuntimeFeatureProfileMarkdown(profile) {
  const rows = Object.entries(profile?.features || {});
  if (rows.length === 0) {
    return `### Runtime feature profile P4.3
- Non disponibile.`;
  }
  return `### Runtime feature profile P4.3
| Feature | Requested | Effective | Source | Fallback | Prerequisiti mancanti |
| --- | ---: | ---: | --- | --- | --- |
${rows
  .map(([name, entry]) => {
    const unmet =
      Array.isArray(entry?.unmetPrerequisites) &&
      entry.unmetPrerequisites.length > 0
        ? entry.unmetPrerequisites.join(", ")
        : "nessuno";
    return `| ${name} | ${entry?.requested ? "ON" : "OFF"} | ${entry?.effective ? "ON" : "OFF"} | ${entry?.source ?? "default"} | ${entry?.fallback?.active ? entry.fallback.mode : "nessuno"} | ${unmet} |`;
  })
  .join("\n")}`;
}

function renderRuntimeMetricsMarkdown(metrics) {
  if (!metrics) {
    return `## Runtime Metrics
- Non disponibili.`;
  }
  if (metrics.ok === false) {
    return `## Runtime Metrics
- Non disponibili: status ${metrics.status ?? "n/d"} ${metrics.error ?? ""}`;
  }
  const counters = metrics.counters || {};
  const appState = metrics.appState || {};
  const queues = metrics.queues || {};
  const lastQueue = queues.lastSample || {};
  const dbWaitRows = topHistogramRows(queues.dbMutation?.waitMsByLabel);
  const dbRunRows = topHistogramRows(queues.dbMutation?.runMsByLabel);
  const appStateWriteRows = topHistogramRows(appState.writeRunMsByLabel);
  const operationMetrics = metrics.operations?.runMsByLabel || {};
  const operationRows = topHistogramRows(operationMetrics);
  const orderCreateOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "orderCreate",
  );
  const orderCreateReadRows = histogramRowsByPrefix(
    orderCreateOperationMetrics,
    "orderCreateRead:",
  );
  const orderCreateInternalRows = histogramRowsByPrefix(
    orderCreateOperationMetrics,
    "orderCreateInternal:",
  );
  const tableSyncOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "tableSyncWrite:",
  );
  const tableSyncWriteRows = histogramRowsByPrefix(
    tableSyncOperationMetrics,
    "tableSyncWrite:",
  );
  const tableRoomMoveRequestOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "tableRoomMoveRequestWrite:",
  );
  const tableRoomMoveRequestWriteRows = histogramRowsByPrefix(
    tableRoomMoveRequestOperationMetrics,
    "tableRoomMoveRequestWrite:",
  );
  const roomChangeRequestOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "posRoomChangeRequest:",
  );
  const roomChangeRequestRows = histogramRowsByPrefix(
    roomChangeRequestOperationMetrics,
    "posRoomChangeRequest:",
  );
  const roomChangeApproveOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "posRoomChangeApprove:",
  );
  const roomChangeApproveRows = histogramRowsByPrefix(
    roomChangeApproveOperationMetrics,
    "posRoomChangeApprove:",
  );
  const roomChangeApprovePreLaneOperationMetrics =
    collectWorkerOperationHistograms(metrics, "posRoomChangeApprovePreLane:");
  const roomChangeApprovePreLaneRows = histogramRowsByPrefix(
    roomChangeApprovePreLaneOperationMetrics,
    "posRoomChangeApprovePreLane:",
  );
  const waiterPauseOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "waiterPauseWorkflow:",
  );
  const waiterPauseRows = histogramRowsByPrefix(
    waiterPauseOperationMetrics,
    "waiterPauseWorkflow:",
  );
  const paymentFreeSplitOperationMetrics = collectWorkerOperationHistograms(
    metrics,
    "paymentFreeSplitWorkflow:",
  );
  const paymentFreeSplitRows = histogramRowsByPrefix(
    paymentFreeSplitOperationMetrics,
    "paymentFreeSplitWorkflow:",
  );
  const paymentFreeSplitWriteMetrics = collectWorkerOperationHistograms(
    metrics,
    "paymentWorkflowStep:payments.freeSplit.",
  );
  const paymentFreeSplitWriteRows = histogramRowsByPrefix(
    paymentFreeSplitWriteMetrics,
    "paymentWorkflowStep:payments.freeSplit.",
  );
  const readRows = topHistogramRows(metrics.requests?.readDbCountByRoute);
  const writeRows = topHistogramRows(metrics.requests?.writeDbCountByRoute);
  const orderSyncRequests =
    metrics.requests?.runMsByRoute?.["POST /api/integration/orders/sync"]
      ?.count ?? 0;
  const terminalSyncNoops = counters.orderTerminalDuplicateSyncNoops ?? 0;
  const terminalSyncPreLaneNoops =
    counters.orderTerminalDuplicateSyncPreLaneNoops ?? 0;
  const terminalSyncNoopRate = orderSyncRequests
    ? money((terminalSyncNoops / orderSyncRequests) * 100)
    : 0;
  const orderSyncTableStateChanged = counters.orderSyncTableStateChanged ?? 0;
  const orderSyncTableStateNoops = counters.orderSyncTableStateNoops ?? 0;
  const orderSyncTableStateChangeRate = orderSyncRequests
    ? money((orderSyncTableStateChanged / orderSyncRequests) * 100)
    : 0;
  return `## Runtime Metrics
- Abilitate: ${metrics.enabled === true ? "si" : "no"}
- Richieste osservate: ${counters.requests ?? 0}
- readDb/writeDb totali: ${counters.readDb ?? 0} / ${counters.writeDb ?? 0}
- writeDb persistiti/noop comparable/noop persistedComparable/dirty externalized: ${counters.writeDbPersisted ?? 0} / ${counters.writeDbNoopComparable ?? 0} / ${counters.writeDbNoopPersistedComparable ?? 0} / ${counters.writeDbDirtyExternalized ?? 0}
- Sync terminali duplicate no-op: ${terminalSyncNoops} / ${orderSyncRequests} (${terminalSyncNoopRate}%), pre-lane ${terminalSyncPreLaneNoops}
- Sync table-state changed/no-op: ${orderSyncTableStateChanged} / ${orderSyncTableStateNoops} (${orderSyncTableStateChangeRate}% changed)
- Order lane enqueue: ${counters.orderLaneEnqueued ?? 0}
- Counter collect atomici/fallback/errori: ${counters.counterCollectionAtomicWrites ?? 0} / ${counters.counterCollectionAtomicFallbacks ?? 0} / ${counters.counterCollectionAtomicErrors ?? 0}
- Selezioni MySQL atomiche completate/rollback: ${counters.mysqlAtomicSelectionWrites ?? 0} / ${counters.mysqlAtomicSelectionRollbacks ?? 0}
- Mirror transitori payment.free_split differiti: ${counters.paymentFreeSplitTransientMirrorDeferred ?? 0}
- Realtime eventi/eligible/delivered/filtered: ${counters.realtimeBusinessEvents ?? 0} / ${counters.realtimeEligibleRecipients ?? 0} / ${counters.realtimeDeliveredRecipients ?? 0} / ${counters.realtimeFilteredClients ?? 0}
- Realtime frame serializzati/byte consegnati: ${counters.realtimeSseFramesSerialized ?? 0} / ${counters.realtimeDeliveryBytes ?? 0}
- Coda finale dbMutation/orderLane: ${lastQueue.dbDepth ?? 0} / ${lastQueue.orderLaneDepth ?? 0}
- writeDb run p95 bucket: ${histogramBucketAt(appState.writeRunMs)}
- readDb run p95 bucket: ${histogramBucketAt(appState.readRunMs)}
- Byte comparable per write p95 bucket: ${histogramBucketAt(appState.writeComparableBytes)}
- Byte persistiti per write p95 bucket: ${histogramBucketAt(appState.writePersistedBytes)}

${renderRuntimeFeatureProfileMarkdown(metrics.featureProfile)}

### Runtime Metrics - dbMutation wait
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${dbWaitRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - dbMutation run
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${dbRunRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - app-state write per label
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${appStateWriteRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - operations
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${operationRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - order.create read breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${orderCreateReadRows.map(([label, item]) => `| ${label.slice("orderCreateRead:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - order.create internal breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${orderCreateInternalRows.map(([label, item]) => `| ${label.slice("orderCreateInternal:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - table.sync write breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${tableSyncWriteRows.map(([label, item]) => `| ${label.slice("tableSyncWrite:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - table.room-move request write breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${tableRoomMoveRequestWriteRows.map(([label, item]) => `| ${label.slice("tableRoomMoveRequestWrite:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - room-change request branch breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${roomChangeRequestRows.map(([label, item]) => `| ${label.slice("posRoomChangeRequest:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - room-change approve breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${roomChangeApproveRows.map(([label, item]) => `| ${label.slice("posRoomChangeApprove:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - room-change approve pre-lane breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${roomChangeApprovePreLaneRows.map(([label, item]) => `| ${label.slice("posRoomChangeApprovePreLane:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - waiter pause workflow breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${waiterPauseRows.map(([label, item]) => `| ${label.slice("waiterPauseWorkflow:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - payment.free_split workflow breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${paymentFreeSplitRows.map(([label, item]) => `| ${label.slice("paymentFreeSplitWorkflow:".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - payment.free_split write breakdown
| Fase | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${paymentFreeSplitWriteRows.map(([label, item]) => `| ${label.slice("paymentWorkflowStep:payments.freeSplit.".length)} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - readDb per request
| Route | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${readRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - writeDb per request
| Route | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${writeRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}`;
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanupResources().finally(() => process.exit(exitCode));
  });
}

main().catch(async (error) => {
  if (outputDirReserved) {
    try {
      await writeEvent({ event: "fatal", error: String(error?.stack || error) });
    } catch {
      // noop
    }
  }
  await cleanupResources();
  await closeEventFile();
  console.error(error?.stack || error);
  process.exitCode = 1;
});
