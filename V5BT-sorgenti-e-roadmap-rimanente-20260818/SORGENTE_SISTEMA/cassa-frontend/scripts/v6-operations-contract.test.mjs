import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  V6_COMMAND_INTERVAL_MAX_MS,
  V6_COMMAND_INTERVAL_MIN_MS,
  V6_DEVICE_ACTION_INTERVAL_MS,
  V6_MAX_HANDHELDS,
  V6_MAX_STATIONS,
  V6_OPERATIONS_SCHEDULER_CONTRACT_VERSION,
} from "./v6-operations-scheduler.mjs";
import { V6_BATTERY_NOTIFICATION_INTERVAL_MS } from "./v6-operations-gates.mjs";
import { availableV6FixtureTables } from "./v6-fixture-table-cycle.mjs";
import { ensureV6OrderTableCapacity } from "./v6-order-table-capacity.mjs";
import { resolvePrintSpoolDir } from "../backend/modules/print-spool/spool-directory.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function source(name) {
  return fs.readFile(path.join(scriptDir, name), "utf8");
}

async function postazioneSource(name) {
  return fs.readFile(
    path.join(scriptDir, "..", "..", "postazione", "src", name),
    "utf8",
  );
}

async function toolSource(name) {
  return fs.readFile(
    path.join(scriptDir, "..", "..", "tools", name),
    "utf8",
  );
}

async function backendSource(name) {
  return fs.readFile(path.join(scriptDir, "..", "backend", name), "utf8");
}

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `Marker iniziale non trovato: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Marker finale non trovato: ${endMarker}`);
  return text.slice(start, end);
}

test("le fixture restano uniche finche il pool dispone di tavoli", () => {
  const tables = [{ id: "table-1" }, { id: "table-2" }];
  const reservedTableIds = new Set(["table-1"]);

  assert.deepEqual(
    availableV6FixtureTables(tables, { reservedTableIds }),
    [{ id: "table-2" }],
  );
  assert.deepEqual([...reservedTableIds], ["table-1"]);
});

test("il riuso fixture riparte solo a pool esaurito e preserva tavoli estranei", () => {
  const tables = [{ id: "table-1" }, { id: "table-2" }];
  const reservedTableIds = new Set(["table-1", "table-2", "table-foreign"]);

  assert.deepEqual(
    availableV6FixtureTables(tables, {
      reservedTableIds,
      allowReuse: true,
    }),
    tables,
  );
  assert.deepEqual([...reservedTableIds], ["table-foreign"]);
});

test("senza autorizzazione il pool fixture esaurito non viene riciclato", () => {
  const tables = [{ id: "table-1" }];
  const reservedTableIds = new Set(["table-1"]);

  assert.deepEqual(
    availableV6FixtureTables(tables, { reservedTableIds }),
    [],
  );
  assert.deepEqual([...reservedTableIds], ["table-1"]);
});

test("il ciclo fixture copre le 651 comande richieste dal profilo lungo", () => {
  const tables = Array.from({ length: 255 }, (_, index) => ({
    id: `table-${index + 1}`,
  }));
  const reservedTableIds = new Set();
  const selectedTableIds = [];

  for (let index = 0; index < 651; index += 1) {
    const available = availableV6FixtureTables(tables, {
      reservedTableIds,
      allowReuse: true,
    });
    assert.ok(available.length > 0);
    const selected = available[(index * 37) % available.length];
    reservedTableIds.add(selected.id);
    selectedTableIds.push(selected.id);
  }

  assert.equal(selectedTableIds.length, 651);
  assert.equal(new Set(selectedTableIds).size, 255);
});

test("il launcher operativo fissa il profilo massimo 25x5 e le durate full/smoke/micro", async () => {
  const launcher = await source("run-v6-operations-30.mjs");

  assert.equal(V6_MAX_HANDHELDS, 25);
  assert.equal(V6_MAX_STATIONS, 5);
  assert.match(launcher, /LOADTEST_PROFILE:\s*"v6-operations-30"/);
  assert.match(launcher, /LOADTEST_HANDHELDS:\s*"25"/);
  assert.match(launcher, /LOADTEST_STATIONS:\s*"5"/);
  assert.match(launcher, /LOADTEST_GUI:\s*"2"/);
  assert.match(
    launcher,
    /LOADTEST_API_WORKERS:[\s\S]+process\.env\.LOADTEST_API_WORKERS \|\| "4"/,
  );
  assert.match(launcher, /(?:FULL|V6_FULL)_ACTIONS_PER_DEVICE\s*=\s*200/);
  assert.match(launcher, /(?:SMOKE|V6_SMOKE)_ACTIONS_PER_DEVICE\s*=\s*40/);
  assert.match(launcher, /V6_MICRO_ACTIONS_PER_DEVICE\s*=\s*10/);
  assert.match(launcher, /const mode = micro \? "micro"/);
  assert.match(
    launcher,
    /LOADTEST_V6_ACTIONS_PER_DEVICE:\s*String\([\s\S]*actionsPerDevice[\s\S]*\)/,
  );
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /V6_ACTIONS_PER_DEVICE < 10/);
  assert.doesNotMatch(runner, /V6_ACTIONS_PER_DEVICE < 40/);
});

test("il launcher attesta il preflight pressione host e blocca solo dopo il dry-run", async () => {
  const launcher = await source("run-v6-operations-30.mjs");

  assert.match(launcher, /readFileSync\("\/proc\/meminfo", "utf8"\)/);
  assert.match(launcher, /readFileSync\("\/proc\/loadavg", "utf8"\)/);
  assert.match(launcher, /logicalCpuCount:\s*availableParallelism\(\)/);
  assert.match(launcher, /evaluateV6HostPressure\(\{/);
  assert.match(launcher, /overrideValue:\s*process\.env\.LOADTEST_ALLOW_HOST_PRESSURE/);
  assert.match(launcher, /hostPressurePreflight,/);
  assert.match(launcher, /LOADTEST_HOST_PRESSURE_PREFLIGHT_JSON:\s*JSON\.stringify\(hostPressurePreflight\)/);
  assert.ok(
    launcher.indexOf("if (dryRun) process.exit(0)") <
      launcher.indexOf("if (!hostPressurePreflight.launchAllowed)"),
  );
  assert.match(launcher, /LOADTEST_ALLOW_HOST_PRESSURE=1/);
});

test("il runner rende configurabili e attestabili le esclusioni incrociate con default conservativo", async () => {
  const runner = await source("loadtest-full-capacity.mjs");

  for (const [family, property] of [
    ["ORDERS", "Orders"],
    ["TABLES", "Tables"],
    ["PAYMENTS", "Payments"],
    ["PRESENCE", "Presence"],
  ]) {
    assert.match(
      runner,
      new RegExp(
        `process\\.env\\.LANE_CROSS_EXCLUSION_${family} \\?\\? "1"`,
      ),
    );
    assert.match(
      runner,
      new RegExp(`laneCrossExclusion${property}Enabled,`),
    );
  }
});

test("il launcher operativo fissa e verifica il profilo concorrente L1-L4", async () => {
  const launcher = await source("run-v6-operations-30.mjs");

  assert.match(launcher, /requestedDiagnosticLaneMatrix !== V6_DIAGNOSTIC_LANE_MATRIX/);
  assert.match(
    launcher,
    /\? \{ orders: false, tables: true, payments: true, presence: false \}\s*:\s*\{ orders: false, tables: false, payments: false, presence: false \}/,
  );
  for (const family of ["ORDERS", "TABLES", "PAYMENTS", "PRESENCE"]) {
    assert.match(
      launcher,
      new RegExp(`LANE_CROSS_EXCLUSION_${family}: laneCrossExclusions`),
    );
  }
  assert.match(launcher, /laneCrossExclusionsEnabled:\s*\{/);
  assert.match(launcher, /laneMatrixQualificationEligible:\s*!diagnosticLaneMatrixEnabled/);
  assert.match(launcher, /gateFailures\.push\("attestazione matrice lane"\)/);
  assert.match(launcher, /gateFailures\.push\("matrice lane diagnostica non promuovibile"\)/);
  assert.match(launcher, /V6_CERTIFIED_PAYMENT_LANE_CONCURRENCY\s*=\s*2/);
  assert.match(launcher, /V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY\s*=\s*3/);
  assert.match(launcher, /V6_CERTIFIED_AUTO_PRINT_OWNER_INTERVAL_MS\s*=\s*25/);
  assert.match(launcher, /V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS\s*=\s*100/);
  assert.match(
    launcher,
    /LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP=1/,
  );
  assert.match(
    launcher,
    /LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE=1/,
  );
  assert.match(
    launcher,
    /LOADTEST_PAYMENT_LANE_CONCURRENCY:\s*String\(paymentLaneConcurrency\)/,
  );
  assert.match(launcher, /LOADTEST_V6_EVIDENCE_CLASS:\s*v6OperationsEvidenceClass/);
  assert.match(
    launcher,
    /LOADTEST_V6_PROMOTION_ELIGIBILITY:\s*v6OperationsPromotionEligibility/,
  );
  assert.match(launcher, /paymentLaneConcurrencyQualificationEligible:/);
  assert.match(launcher, /qualificationEligible:\s*!diagnosticOverridesEnabled/);
  assert.match(launcher, /gateFailures\.push\("evidenza diagnostica NON_GATE\/NON_PROMOTABLE"\)/);
  assert.match(launcher, /LOADTEST_PRINT_LANE_CONCURRENCY:\s*"1"/);
  assert.match(
    launcher,
    /LOADTEST_PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS:\s*String\(\s*autoPrintOwnerIntervalMs/,
  );
  assert.match(
    launcher,
    /LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS:/,
  );
  assert.match(
    launcher,
    /LOADTEST_STATION_STATE_MARKER_LOCK_SKIP:\s*\n?\s*diagnosticStationStateMarkerLockSkipEnabled \? "1" : "0"/,
  );
  assert.match(
    launcher,
    /LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP:/,
  );
  assert.match(
    launcher,
    /LOADTEST_STATION_STATE_LAST_WRITE_COALESCE:\s*\n?\s*diagnosticStationStateLastWriteCoalesceEnabled \? "1" : "0"/,
  );
  assert.match(
    launcher,
    /LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE:/,
  );
  assert.match(launcher, /stationStateLastWriteCoalesceEnabled:/);
  assert.match(launcher, /stationStateLastWriteNowaitEnabled:/);
  assert.match(
    launcher,
    /stationStateLastWriteCoalesceQualificationEligible:\s*!diagnosticStationStateLastWriteCoalesceEnabled/,
  );
  assert.match(
    launcher,
    /diagnosticStationStateLastWriteCoalesceEnabled:\s*\n?\s*diagnosticStationStateLastWriteCoalesceEnabled \? true : null/,
  );
  assert.match(launcher, /LOADTEST_ORDERS_ASYNC_FLUSH_INTERVAL_MS:\s*"500"/);
  assert.match(launcher, /LOADTEST_ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT:\s*"0"/);
  assert.match(launcher, /LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT:\s*"0"/);
  assert.match(launcher, /LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE:\s*"0"/);
  assert.match(launcher, /paymentLaneConcurrency:\s*Number\(env\.LOADTEST_PAYMENT_LANE_CONCURRENCY\)/);
  assert.match(launcher, /printLaneConcurrency:\s*Number\(env\.LOADTEST_PRINT_LANE_CONCURRENCY\)/);
  assert.match(launcher, /ordersAsyncFlushIntervalMs:\s*Number\(env\.LOADTEST_ORDERS_ASYNC_FLUSH_INTERVAL_MS\)/);
  assert.match(launcher, /ordersAsyncFlushMysqlNowaitEnabled:[\s\S]+LOADTEST_ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT === "1"/);
  assert.match(launcher, /ordersAsyncFlushDetachLastWriteAtEnabled:[\s\S]+LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT === "1"/);
  assert.match(launcher, /ordersAsyncFlushDetachSequenceWhenSafeEnabled:[\s\S]+LOADTEST_ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE === "1"/);
  assert.match(launcher, /completedReport\?\.config\?\.paymentLaneConcurrency !== paymentLaneConcurrency/);
  assert.match(launcher, /completedReport\?\.config\?\.printLaneConcurrency !== 1/);
  assert.match(
    launcher,
    /completedReport\?\.config\?\.printSpoolAutoPrintOwnerIntervalMs !==\s*autoPrintOwnerIntervalMs/,
  );
  assert.match(
    launcher,
    /gateFailures\.push\("intervallo owner auto-print diagnostico non promuovibile"\)/,
  );
  assert.match(
    launcher,
    /gateFailures\.push\("skip lock marker station-state diagnostico non promuovibile"\)/,
  );
  assert.match(
    launcher,
    /coalescing lastWriteAt station-state diagnostico non promuovibile/,
  );
  assert.match(
    launcher,
    /completedReport\?\.config\?\.stationStateLastWriteCoalesceEnabled/,
  );
  assert.match(
    launcher,
    /completedReport\?\.config\?\.stationStateLastWriteNowaitEnabled/,
  );
  assert.match(launcher, /completedReport\?\.config\?\.ordersAsyncFlushIntervalMs !== 500/);
  assert.match(launcher, /completedReport\?\.config\?\.ordersAsyncFlushMysqlNowaitEnabled !== false/);
  assert.match(launcher, /completedReport\?\.config\?\.ordersAsyncFlushDetachLastWriteAtEnabled !== false/);
  assert.match(launcher, /completedReport\?\.config\?\.ordersAsyncFlushDetachSequenceWhenSafeEnabled !== false/);

  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /process\.env\.LOADTEST_HOST_PRESSURE_PREFLIGHT_JSON/);
  assert.match(runner, /hostPressurePreflight,/);
  assert.match(runner, /process\.env\.LOADTEST_PAYMENT_LANE_CONCURRENCY/);
  assert.match(runner, /process\.env\.LOADTEST_V6_EVIDENCE_CLASS/);
  assert.match(runner, /process\.env\.LOADTEST_V6_PROMOTION_ELIGIBILITY/);
  assert.match(runner, /rawV6DiagnosticPaymentLaneConcurrency === "3"/);
  assert.match(runner, /v6OperationsEvidenceClass === "NON_GATE"/);
  assert.match(runner, /v6OperationsPromotionEligibility === "NON_PROMOTABLE"/);
  assert.match(runner, /process\.env\.LOADTEST_PRINT_LANE_CONCURRENCY/);
  assert.match(
    runner,
    /process\.env\.LOADTEST_PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS/,
  );
  assert.match(
    runner,
    /process\.env\.LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS/,
  );
  assert.match(
    runner,
    /process\.env\.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP/,
  );
  assert.match(
    runner,
    /process\.env\.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP \?\? "0"/,
  );
  assert.match(
    runner,
    /process\.env\.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE \?\? "0"/,
  );
  assert.match(
    runner,
    /process\.env\.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE/,
  );
  assert.match(
    runner,
    /Number\(process\.env\.LOADTEST_ORDERS_ASYNC_FLUSH_INTERVAL_MS\) \|\| 500/,
  );
  assert.match(runner, /PAYMENT_LANE_CONCURRENCY:\s*String\(paymentLaneConcurrency\)/);
  assert.match(runner, /PRINT_LANE_CONCURRENCY:\s*String\(printLaneConcurrency\)/);
  assert.match(
    runner,
    /PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS:\s*String\(\s*printSpoolAutoPrintOwnerIntervalMs/,
  );
  assert.match(
    runner,
    /BACKEND_STATION_STATE_MARKER_LOCK_SKIP:\s*\n?\s*stationStateMarkerLockSkipEnabled \? "1" : "0"/,
  );
  assert.match(
    runner,
    /BACKEND_STATION_STATE_LAST_WRITE_COALESCE:\s*\n?\s*stationStateLastWriteCoalesceEnabled \? "1" : "0"/,
  );
  assert.match(runner, /ORDERS_ASYNC_FLUSH_INTERVAL_MS:\s*String\(ordersAsyncFlushIntervalMs\)/);
  assert.match(runner, /ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT:\s*ordersAsyncFlushMysqlNowaitEnabled \? "1" : "0"/);
  assert.match(runner, /ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT:\s*ordersAsyncFlushDetachLastWriteAtEnabled \? "1" : "0"/);
  assert.match(runner, /ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE:\s*ordersAsyncFlushDetachSequenceWhenSafeEnabled \? "1" : "0"/);
  assert.match(runner, /buildAutoPrintOwnerAudit\(runtimeMetrics,\s*\{/);
  assert.match(runner, /v6\.operations\.auto_print_owner_only/);
  const autoPrintOwnerGate = await source("v6-auto-print-owner-gate.mjs");
  assert.match(autoPrintOwnerGate, /export function buildAutoPrintOwnerAudit/);
  assert.match(autoPrintOwnerGate, /enqueueFlushMatch:\s*totals\.enqueued === totals\.flushed/);
  assert.match(autoPrintOwnerGate, /everyErrorRetried:\s*totals\.retries === totals\.errors/);
  assert.match(autoPrintOwnerGate, /remoteTimeoutsOnly:\s*totals\.timeouts === totals\.errors/);
  assert.match(autoPrintOwnerGate, /exactlyOnceOwnerWrites:\s*owner\.handled === totals\.confirmedJobs/);
  assert.match(autoPrintOwnerGate, /noApiWorkerLocalWrites:\s*totals\.localPrintLaneEnqueued === 0/);
  assert.match(launcher, /completedReport\?\.autoPrintOwnerAudit\?\.ok !== true/);
  const stationStateMarkerGate = await source("v6-station-state-marker-gate.mjs");
  assert.match(
    stationStateMarkerGate,
    /export function buildStationStateMarkerLockElisionAudit/,
  );
  assert.match(stationStateMarkerGate, /probeObserved:\s*counts\.probe > 0/);
  assert.match(stationStateMarkerGate, /canonicalMarkerIntact:\s*counts\.canonicalFallback === 0/);
  assert.match(stationStateMarkerGate, /stateReadObserved:\s*stateRead\.count > 0/);
  assert.match(stationStateMarkerGate, /noTransactionFailures:\s*counts\.transactionFailures === 0/);
  assert.match(
    launcher,
    /completedReport\?\.stationStateMarkerLockElisionAudit\?\.ok !== true/,
  );
  assert.match(runner, /paymentLaneConcurrency,/);
  assert.match(runner, /v6OperationsDiagnosticPaymentLaneConcurrency:/);
  assert.match(runner, /v6OperationsDiagnostic:/);
  assert.match(runner, /printLaneConcurrency,/);
  assert.match(runner, /printSpoolAutoPrintOwnerIntervalMs,/);
  assert.match(runner, /v6OperationsDiagnosticAutoPrintOwnerIntervalMs:/);
  assert.match(runner, /stationStateMarkerLockSkipEnabled,/);
  assert.match(
    runner,
    /v6OperationsDiagnosticStationStateMarkerLockSkipEnabled:/,
  );
  assert.match(runner, /Skip lock marker station-state:/);
  assert.match(runner, /ordersAsyncFlushIntervalMs,/);
  assert.match(runner, /ordersAsyncFlushMysqlNowaitEnabled,/);
  assert.match(runner, /ordersAsyncFlushDetachLastWriteAtEnabled,/);
  assert.match(runner, /ordersAsyncFlushDetachSequenceWhenSafeEnabled,/);
});

test("il dry-run classifica l'override payment 3 come NON_GATE e rifiuta altri valori", () => {
  const launcherPath = path.join(scriptDir, "run-v6-operations-30.mjs");
  const cleanEnv = { ...process.env };
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_LANE_MATRIX;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE;
  delete cleanEnv.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE;

  const qualifying = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.equal(qualifying.status, 0, qualifying.stderr);
  const qualifyingManifest = JSON.parse(qualifying.stdout);
  assert.equal(qualifyingManifest.paymentLaneConcurrency, 2);
  assert.equal(qualifyingManifest.diagnosticPaymentLaneConcurrency, null);
  assert.equal(qualifyingManifest.evidenceClass, "QUALIFYING_PROFILE");
  assert.equal(qualifyingManifest.promotionEligibility, "READINESS_ELIGIBLE");
  assert.equal(qualifyingManifest.qualificationEligible, true);

  const diagnostic = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      LOADTEST_V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY: "3",
    },
  });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  const diagnosticManifest = JSON.parse(diagnostic.stdout);
  assert.equal(diagnosticManifest.paymentLaneConcurrency, 3);
  assert.equal(diagnosticManifest.diagnosticPaymentLaneConcurrency, 3);
  assert.equal(diagnosticManifest.paymentLaneConcurrencyQualificationEligible, false);
  assert.equal(diagnosticManifest.evidenceClass, "NON_GATE");
  assert.equal(diagnosticManifest.promotionEligibility, "NON_PROMOTABLE");
  assert.equal(diagnosticManifest.qualificationEligible, false);

  for (const invalidValue of ["1", "2", "03", "4"]) {
    const invalid = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...cleanEnv,
        LOADTEST_V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY: invalidValue,
      },
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Override diagnostico payment lane non riconosciuto/);
  }
});

test("il dry-run fissa owner auto-print a 25 ms e ammette solo il canary NON_GATE da 100 ms", () => {
  const launcherPath = path.join(scriptDir, "run-v6-operations-30.mjs");
  const cleanEnv = { ...process.env };
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_LANE_MATRIX;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE;
  delete cleanEnv.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE;

  const qualifying = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.equal(qualifying.status, 0, qualifying.stderr);
  const qualifyingManifest = JSON.parse(qualifying.stdout);
  assert.equal(qualifyingManifest.autoPrintOwnerIntervalMs, 25);
  assert.equal(qualifyingManifest.diagnosticAutoPrintOwnerIntervalMs, null);
  assert.equal(
    qualifyingManifest.autoPrintOwnerIntervalQualificationEligible,
    true,
  );
  assert.equal(qualifyingManifest.evidenceClass, "QUALIFYING_PROFILE");
  assert.equal(qualifyingManifest.promotionEligibility, "READINESS_ELIGIBLE");

  const diagnostic = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS: "100",
    },
  });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  const diagnosticManifest = JSON.parse(diagnostic.stdout);
  assert.equal(diagnosticManifest.autoPrintOwnerIntervalMs, 100);
  assert.equal(diagnosticManifest.diagnosticAutoPrintOwnerIntervalMs, 100);
  assert.equal(
    diagnosticManifest.autoPrintOwnerIntervalQualificationEligible,
    false,
  );
  assert.equal(diagnosticManifest.evidenceClass, "NON_GATE");
  assert.equal(diagnosticManifest.promotionEligibility, "NON_PROMOTABLE");
  assert.equal(diagnosticManifest.qualificationEligible, false);

  for (const invalidValue of ["10", "25", "0100", "101"]) {
    const invalid = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...cleanEnv,
        LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS: invalidValue,
      },
    });
    assert.notEqual(invalid.status, 0);
    assert.match(
      invalid.stderr,
      /Override diagnostico intervallo owner auto-print non riconosciuto/,
    );
  }
});

test("il dry-run mantiene OFF lo skip lock marker station-state e ammette solo il canary ON NON_GATE", () => {
  const launcherPath = path.join(scriptDir, "run-v6-operations-30.mjs");
  const cleanEnv = { ...process.env };
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_LANE_MATRIX;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE;
  delete cleanEnv.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE;

  const qualifying = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.equal(qualifying.status, 0, qualifying.stderr);
  const qualifyingManifest = JSON.parse(qualifying.stdout);
  assert.equal(qualifyingManifest.stationStateMarkerLockSkipEnabled, false);
  assert.equal(
    qualifyingManifest.diagnosticStationStateMarkerLockSkipEnabled,
    null,
  );
  assert.equal(
    qualifyingManifest.stationStateMarkerLockSkipQualificationEligible,
    true,
  );
  assert.equal(qualifyingManifest.evidenceClass, "QUALIFYING_PROFILE");
  assert.equal(qualifyingManifest.promotionEligibility, "READINESS_ELIGIBLE");
  assert.equal(qualifyingManifest.qualificationEligible, true);

  const diagnostic = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP: "1",
    },
  });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  const diagnosticManifest = JSON.parse(diagnostic.stdout);
  assert.equal(diagnosticManifest.stationStateMarkerLockSkipEnabled, true);
  assert.equal(
    diagnosticManifest.diagnosticStationStateMarkerLockSkipEnabled,
    true,
  );
  assert.equal(
    diagnosticManifest.stationStateMarkerLockSkipQualificationEligible,
    false,
  );
  assert.equal(diagnosticManifest.evidenceClass, "NON_GATE");
  assert.equal(diagnosticManifest.promotionEligibility, "NON_PROMOTABLE");
  assert.equal(diagnosticManifest.qualificationEligible, false);

  for (const invalidValue of ["0", "true", "01", "ON", "2"]) {
    const invalid = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...cleanEnv,
        LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP: invalidValue,
      },
    });
    assert.notEqual(invalid.status, 0);
    assert.match(
      invalid.stderr,
      /Override diagnostico skip lock marker station-state non riconosciuto/,
    );
  }
});

test("il dry-run mantiene OFF il coalescing lastWriteAt station-state e ammette solo il canary ON NON_GATE", () => {
  const launcherPath = path.join(scriptDir, "run-v6-operations-30.mjs");
  const cleanEnv = { ...process.env };
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_PAYMENT_LANE_CONCURRENCY;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_LANE_MATRIX;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_AUTO_PRINT_OWNER_INTERVAL_MS;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_STATION_STATE_MARKER_LOCK_SKIP;
  delete cleanEnv.LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE;
  delete cleanEnv.LOADTEST_STATION_STATE_LAST_WRITE_COALESCE;

  const qualifying = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.equal(qualifying.status, 0, qualifying.stderr);
  const qualifyingManifest = JSON.parse(qualifying.stdout);
  assert.equal(qualifyingManifest.stationStateLastWriteCoalesceEnabled, false);
  assert.equal(qualifyingManifest.stationStateLastWriteNowaitEnabled, false);
  assert.equal(
    qualifyingManifest.diagnosticStationStateLastWriteCoalesceEnabled,
    null,
  );
  assert.equal(
    qualifyingManifest.stationStateLastWriteCoalesceQualificationEligible,
    true,
  );
  assert.equal(qualifyingManifest.evidenceClass, "QUALIFYING_PROFILE");
  assert.equal(qualifyingManifest.promotionEligibility, "READINESS_ELIGIBLE");
  assert.equal(qualifyingManifest.qualificationEligible, true);

  const internalOnly = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      LOADTEST_STATION_STATE_LAST_WRITE_COALESCE: "1",
    },
  });
  assert.equal(internalOnly.status, 0, internalOnly.stderr);
  const internalOnlyManifest = JSON.parse(internalOnly.stdout);
  assert.equal(internalOnlyManifest.stationStateLastWriteCoalesceEnabled, false);
  assert.equal(internalOnlyManifest.stationStateLastWriteNowaitEnabled, false);
  assert.equal(internalOnlyManifest.qualificationEligible, true);

  const diagnostic = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE: "1",
    },
  });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  const diagnosticManifest = JSON.parse(diagnostic.stdout);
  assert.equal(diagnosticManifest.stationStateLastWriteCoalesceEnabled, true);
  assert.equal(diagnosticManifest.stationStateLastWriteNowaitEnabled, true);
  assert.equal(
    diagnosticManifest.diagnosticStationStateLastWriteCoalesceEnabled,
    true,
  );
  assert.equal(
    diagnosticManifest.stationStateLastWriteCoalesceQualificationEligible,
    false,
  );
  assert.equal(diagnosticManifest.evidenceClass, "NON_GATE");
  assert.equal(diagnosticManifest.promotionEligibility, "NON_PROMOTABLE");
  assert.equal(diagnosticManifest.qualificationEligible, false);

  for (const invalidValue of ["0", "true", "01", "ON", "2"]) {
    const invalid = spawnSync(process.execPath, [launcherPath, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...cleanEnv,
        LOADTEST_V6_DIAGNOSTIC_STATION_STATE_LAST_WRITE_COALESCE: invalidValue,
      },
    });
    assert.notEqual(invalid.status, 0);
    assert.match(
      invalid.stderr,
      /Override diagnostico coalescing lastWriteAt station-state non riconosciuto/,
    );
  }
});

test("le fixture utenti abilitano esplicitamente i tre frontend e le cinque postazioni", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const fixtureUser = between(runner, "function createUser(", "function buildAutomaticCashGatewayInventory");

  assert.match(
    fixtureUser,
    /enabledAppIds:\s*\["cassa", "postazione", "palmare"\]/,
  );
  assert.match(
    fixtureUser,
    /workstationIds:\s*activeStationNames\.map\([\s\S]+`workstation_load_\$\{index \+ 1\}`/,
  );
});

test("ogni sessione worker Postazione seleziona il target prima del primo heartbeat", async () => {
  const runner = await source("loadtest-full-capacity.mjs");

  assert.match(
    runner,
    /async function selectLoginWorkstation[\s\S]+\/api\/auth\/workstation\/select[\s\S]+selectedWorkstation/,
  );
  assert.match(
    runner,
    /stationSessions\.push\(session\);[\s\S]{0,500}await selectLoginWorkstation\([\s\S]{0,300}await stationHeartbeat\(/,
  );
});

test("gli stream SSE riusano l'istante canonico restituito dal login", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const loginFlow = between(
    runner,
    "async function login(",
    "async function selectLoginWorkstation",
  );
  const realtimeFlow = between(
    runner,
    "async function startRealtimeClients(",
    "function buildRadioFrame",
  );

  assert.match(loginFlow, /const sessionStartedAt = Number\(result\.body\.sessionStartedAt\)/);
  assert.match(loginFlow, /Number\.isSafeInteger\(sessionStartedAt\)/);
  assert.match(loginFlow, /sessionStartedAt,/);
  assert.match(
    realtimeFlow,
    /"X-Session-Started-At": String\(session\.sessionStartedAt\)/,
  );
  assert.match(realtimeFlow, /"X-Client-App": session\.clientApp/);
  assert.match(realtimeFlow, /"X-Username": session\.user\.username/);
  assert.doesNotMatch(realtimeFlow, /NOTIFICATION_NATIVE_SESSION_INVALID/);
});

test("runId e directory del profilo non sono riutilizzabili", async () => {
  const launcher = await source("run-v6-operations-30.mjs");
  const runner = await source("loadtest-full-capacity.mjs");

  assert.match(launcher, /randomUUID\(\)/);
  assert.match(launcher, /existsSync\(reportDir\)/);
  assert.match(launcher, /LOADTEST_RUN_ID gia utilizzato/);
  assert.match(runner, /randomUUID\(\)/);
  assert.match(runner, /fs\.mkdir\(outputDir, \{ recursive: false \}\)/);
  assert.match(runner, /LOADTEST_RUN_ID_ALREADY_USED/);
  assert.match(runner, /if \(outputDirReserved\)/);
});

test("il cleanup effettua logout, chiude processi e log, poi verifica zero sessioni", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const cleanup = between(runner, "async function logoutTrackedSessions", "async function waitForHttp");

  assert.match(runner, /trackedSessions\.add\(session\)/);
  assert.match(cleanup, /\/api\/auth\/logout/);
  assert.match(cleanup, /\/api\/auth\/session\/status/);
  assert.match(cleanup, /response\.status === 200 \|\| response\.status === 401/);
  assert.match(cleanup, /verification\?\.status === 401/);
  assert.match(cleanup, /SELECT COUNT\(\*\) AS count FROM \$\{tableSql\}/);
  assert.doesNotMatch(cleanup, /DELETE FROM/);
  assert.match(cleanup, /await Promise\.all\(children\.map\(\(child\) => terminateChild\(child\)\)\)/);
  assert.match(cleanup, /await Promise\.allSettled\(\[\.\.\.spawnedLogClosures\]\)/);
  assert.match(runner, /child\.once\("close", closeLog\)/);
  assert.match(cleanup, /apiLogout\.failed === 0 && store\.verified === true/);
  assert.match(runner, /cleanup\.sessions\.residue/);
});

test("lo spool stampa V6 e per-run, validato e rimosso senza usare quello storico", async () => {
  const backend = await backendSource("server.js");
  const spoolDirectory = await backendSource("modules/print-spool/spool-directory.js");
  const launcher = await source("run-v6-operations-30.mjs");
  const runner = await source("loadtest-full-capacity.mjs");
  const cleanup = between(runner, "async function cleanupRunPrintSpool", "async function waitForHttp");

  assert.match(backend, /process\.env\.BACKEND_PRINT_SPOOL_DIR/);
  assert.match(backend, /resolvePrintSpoolDir\(process\.env\.BACKEND_PRINT_SPOOL_DIR, currentDir\)/);
  assert.match(spoolDirectory, /defaultDir = path\.join\(safeBackendDir, "\.print-spool"\)/);
  assert.match(spoolDirectory, /!path\.isAbsolute\(raw\) \|\| path\.resolve\(raw\) !== raw/);
  assert.match(spoolDirectory, /raw === path\.parse\(raw\)\.root \|\| containsBackend/);
  assert.equal(resolvePrintSpoolDir("", "/tmp/v6-backend"), "/tmp/v6-backend/.print-spool");
  assert.equal(
    resolvePrintSpoolDir("/tmp/v6-report/runtime/print-spool", "/tmp/v6-backend"),
    "/tmp/v6-report/runtime/print-spool",
  );
  assert.throws(() => resolvePrintSpoolDir("relative", "/tmp/v6-backend"));
  assert.throws(() => resolvePrintSpoolDir("/", "/tmp/v6-backend"));
  assert.throws(() => resolvePrintSpoolDir("/tmp", "/tmp/v6-backend"));
  assert.match(launcher, /printSpoolDir = path\.join\(reportDir, "runtime", "print-spool"\)/);
  assert.match(runner, /printSpoolDir = path\.join\(outputDir, "runtime", "print-spool"\)/);
  assert.match(runner, /BACKEND_PRINT_SPOOL_DIR: printSpoolDir/);
  assert.doesNotMatch(runner, /process\.env\.(?:BACKEND_PRINT_SPOOL_DIR|LOADTEST_PRINT_SPOOL_DIR)/);
  assert.ok(
    cleanup.indexOf("if (!outputDirReserved)") <
      cleanup.indexOf("fs.lstat(printSpoolDir)"),
  );
  assert.match(cleanup, /stat\.isSymbolicLink\(\) \|\| !stat\.isDirectory\(\)/);
  assert.match(cleanup, /fs\.realpath\(outputDir\)/);
  assert.match(cleanup, /fs\.rm\(printSpoolDir, \{ recursive: true, force: false \}\)/);
  assert.doesNotMatch(cleanup, /backend[\\/]\.print-spool|DEFAULT_PRINT_SPOOL_DIR/);
  assert.match(runner, /cleanup\.print_spool\.residue/);
  assert.match(runner, /Cleanup spool stampa:/);
  assert.match(launcher, /cleanup spool stampa per-run/);
});

test("tutti i backend dello smoke sono vincolati al loopback e il report lo attesta", async () => {
  const launcher = await source("run-v6-operations-30.mjs");
  const runner = await source("loadtest-full-capacity.mjs");

  assert.match(runner, /const backendHost = "127\.0\.0\.1"/);
  assert.match(runner, /BACKEND_HOST: backendHost/);
  assert.match(runner, /backendLoopbackOnly: isLoopbackHostname\(backendHost\)/);
  assert.match(launcher, /const backendHost = "127\.0\.0\.1"/);
  assert.match(launcher, /backendLoopbackOnly: true/);
  assert.match(launcher, /binding backend loopback/);
});

test("il launcher operativo usa solo I/O simulato su loopback", async () => {
  const launcher = await source("run-v6-operations-30.mjs");

  assert.match(launcher, /LOADTEST_START_MOCK_IO:\s*"1"/);
  assert.match(launcher, /LOADTEST_PRINTER_COUNT:\s*"5"/);
  assert.match(launcher, /LOADTEST_PRINTER_HOST:\s*"127\.0\.0\.1"/);
  assert.match(
    launcher,
    /POS_FISCAL_API_BASE_URL:\s*"http:\/\/127\.0\.0\.1:\d+"/,
  );
  assert.match(
    launcher,
    /LOADTEST_AUTOMATIC_CASH_BASE_URL:\s*"http:\/\/127\.0\.0\.1:\d+"/,
  );
  assert.match(
    launcher,
    /LOADTEST_BATTERY_SERVICE_URL:\s*"http:\/\/127\.0\.0\.1:\d+(?:\/[^"\s]+)?"/,
  );
  assert.match(launcher, /LOADTEST_ALLOW_NON_LOOPBACK_IO:\s*"0"/);
  assert.doesNotMatch(launcher, /192\.168\./);
});

test("il profilo operativo usa il mirror durevole e stateless dei pagamenti", async () => {
  const launcher = await source("run-v6-operations-30.mjs");
  const runner = await source("loadtest-full-capacity.mjs");

  assert.match(launcher, /BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR:\s*"1"/);
  assert.match(launcher, /BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES:\s*"1"/);
  assert.match(launcher, /BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER:\s*"1"/);
  assert.match(launcher, /BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE:\s*"1"/);
  assert.match(launcher, /BACKEND_PAYMENT_DOMAIN_NAMED_LOCK:\s*"1"/);
  assert.match(runner, /BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR:[\s\S]+paymentFreeSplitDurableMirror \? "1" : "0"/);
  assert.match(runner, /BACKEND_PAYMENT_DOMAIN_NAMED_LOCK:[\s\S]+paymentDomainNamedLockEnabled/);
  assert.match(runner, /paymentDomainNamedLockEnabled,/);
});

test("lo scheduler e il load test bloccano 3 secondi per azione e 7-8 per comanda", async () => {
  const runner = await source("loadtest-full-capacity.mjs");

  assert.equal(V6_DEVICE_ACTION_INTERVAL_MS, 3_000);
  assert.equal(V6_COMMAND_INTERVAL_MIN_MS, 7_000);
  assert.equal(V6_COMMAND_INTERVAL_MAX_MS, 8_000);
  assert.match(runner, /actionIntervalMs:\s*V6_DEVICE_ACTION_INTERVAL_MS/);
  assert.match(runner, /commandIntervalMinMs:\s*V6_COMMAND_INTERVAL_MIN_MS/);
  assert.match(runner, /commandIntervalMaxMs:\s*V6_COMMAND_INTERVAL_MAX_MS/);
  assert.match(runner, /v6\.operations\.mobile_action_cadence_3s/);
  assert.match(runner, /v6\.operations\.command_cadence_7_8s/);
  assert.match(runner, /v6\.operations\.early_dispatch_action_burst/);
  assert.match(runner, /noEarlyDispatchActionBursts/);
});

test("report e manifest attestano scheduler dispatch v2 e batteria ogni 120 secondi", async () => {
  const launcher = await source("run-v6-operations-30.mjs");
  const runner = await source("loadtest-full-capacity.mjs");
  const batteryMock = await toolSource("mock-battery-service.mjs");

  assert.equal(V6_OPERATIONS_SCHEDULER_CONTRACT_VERSION, 2);
  assert.equal(V6_BATTERY_NOTIFICATION_INTERVAL_MS, 120_000);
  assert.match(launcher, /schedulerContractVersion:\s*V6_OPERATIONS_SCHEDULER_CONTRACT_VERSION/);
  assert.match(launcher, /batteryNotificationIntervalMs:\s*V6_BATTERY_NOTIFICATION_INTERVAL_MS/);
  assert.match(runner, /v6SchedulerContractVersion:\s*V6_OPERATIONS_PROFILE/);
  assert.match(runner, /v6OperationsStage:\s*V6_OPERATIONS_PROFILE/);
  assert.match(runner, /batteryNotificationIntervalMs:\s*REALISTIC_LOAD_PROFILE/);
  assert.match(runner, /MOCK_BATTERY_CHANGE_INTERVAL_MS:\s*String\([\s\S]{0,100}V6_BATTERY_NOTIFICATION_INTERVAL_MS/);
  assert.match(runner, /notificationIntervalMs ===[\s\S]{0,100}V6_BATTERY_NOTIFICATION_INTERVAL_MS/);
  assert.match(batteryMock, /MOCK_BATTERY_CHANGE_INTERVAL_MS \|\| 120_000/);
  assert.match(batteryMock, /notificationIntervalMs:\s*changeIntervalMs/);
});

test("il profilo include una Postazione reale Playwright nel conteggio GUI", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const profile = between(
    runner,
    "async function runP5EnduranceProfile",
    "async function findProcessIds",
  );

  assert.match(
    profile,
    /const stationGui = await createP5StationGuiController/,
  );
  assert.match(profile, /guiControllers\.push\(stationGui\)/);
  assert.match(profile, /gui:\s*index === 0 \? stationGui : null/);
  assert.match(profile, /guiStation:\s*1/);
  assert.match(profile, /profile\.guiStationCount\s*=\s*1/);
  assert.match(
    profile,
    /gui\.two_mobile_one_station[\s\S]+recorder\.gui\.length === 3/,
  );
});

test("la diagnostica GUI conta route calde e request fallite senza dati privati", async () => {
  const gui = await source("p5-headed-gui.mjs");
  assert.match(gui, /requestsByRoute:\s*\{\}/);
  assert.match(gui, /requestFailures:\s*0/);
  assert.match(
    gui,
    /const route = `\$\{request\.method\(\)\.toUpperCase\(\)\} \$\{pathname\}`/,
  );
  assert.match(gui, /diagnostics\.requestFailures \+= 1/);
  assert.match(gui, /requestFailureSamples\.push\(\{/);
  assert.doesNotMatch(
    gui,
    /requestFailureSamples\.push\([\s\S]{0,300}(authorization|deviceUuid|userId)/,
  );
});

test("il budget GUI V6 misura soltanto la finestra azioni dopo le fixture", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const profile = between(
    runner,
    "async function runP5EnduranceProfile",
    "async function findProcessIds",
  );
  const fixturesAt = profile.indexOf("await prepareV6OperationFixtures");
  const resetAt = profile.indexOf("controller.resetRequestTraffic()");
  const profileStartAt = profile.indexOf("const profileStartedAt = Date.now()");

  assert.ok(fixturesAt >= 0);
  assert.ok(resetAt > fixturesAt);
  assert.ok(profileStartAt > resetAt);
});

test("il dispatcher mobile copre storno, spostamenti, BANCO e trasferimenti", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const dispatcher = between(
    runner,
    "async function runV6OperationsHandheldAction",
    "async function runV6OperationsStationAction",
  );

  assert.match(
    dispatcher,
    /actionType === "order\.storno"[\s\S]+stornoOrder\(session, order\)/,
  );
  assert.match(
    dispatcher,
    /actionType === "table\.move"[\s\S]+device\.tableMoveFixtures\.shift\(\)[\s\S]+moveTable\(session, fixture\.from, fixture\.to\)/,
  );
  assert.match(
    dispatcher,
    /actionType === "workspace\.tables_counter_switch"[\s\S]+performTablesCounterSwitch\(ordinal\)/,
  );
  assert.match(
    dispatcher,
    /actionType === "counter\.collect"[\s\S]+collectCounterOrder\(session, ordinal\)/,
  );
  assert.match(
    dispatcher,
    /actionType === "order\.transfer\.force"[\s\S]+forceTransferOrder\(session, order, targetStation\)/,
  );
  assert.match(
    dispatcher,
    /actionType === "order\.transfer\.request_resolve"[\s\S]+requestAndResolveOrderTransfer\(\s*session,\s*order,\s*targetStation,?\s*\)/,
  );
  assert.match(dispatcher, /Azione V6 non gestita/);
});

test("il cambio TAVOLI/BANCO usa click, pressione lunga e verifica il titolo", async () => {
  const gui = await source("p5-headed-gui.mjs");
  const operation = between(
    gui,
    "async performTablesCounterSwitch",
    "async performAction",
  );

  assert.match(operation, /clickFirstVisible/);
  assert.match(operation, /aria-label="TAVOLI"/);
  assert.match(operation, /aria-label="BANCO"/);
  assert.match(operation, /topbar-title\.is-long-pressable/);
  assert.match(operation, /longPressLocator\(title, longPressMs\)/);
  assert.match(operation, /page\.waitForFunction/);
  assert.match(operation, /value === "TAVOLI" \|\| value === "BANCO"/);
  assert.match(operation, /before !== after/);
  assert.match(operation, /gui\.mobile\.tables_counter_switch/);
  assert.match(operation, /Cambio TAVOLI\/BANCO non riuscito/);
});

test("la Postazione usa soltanto l'API configurata senza fallback HTTP", async () => {
  const app = await postazioneSource("App.jsx");
  assert.doesNotMatch(app, /fallbackBases|apiFallbackRef/);
  assert.doesNotMatch(app, /localhost:5381|127\.0\.0\.1:5381/);
  assert.match(app, /const bases = \[apiRef\.current\]\.filter\(Boolean\)/);
  assert.match(app, /The configured API is the only allowed transport/);
});

test("report e gate rendono bloccanti quota, copertura, successo e cadenza", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const launcher = await source("run-v6-operations-30.mjs");
  const gate = between(
    runner,
    "function recordV6OperationsProfileFailures",
    "async function runP5EnduranceProfile",
  );

  assert.match(
    gate,
    /requiredMobileTypes\s*=\s*\["order\.create", \.\.\.V6_MOBILE_OPERATION_TYPES\]/,
  );
  assert.match(gate, /missingMobileActionTypes/);
  assert.match(gate, /mobileActionTypesWithoutSuccess/);
  assert.match(gate, /profile\.cadenceGate/);
  assert.match(gate, /v6\.operations\.total_started/);
  assert.match(gate, /v6\.operations\.total_completed/);
  assert.match(gate, /v6\.operations\.action_coverage_missing/);
  assert.match(gate, /v6\.operations\.action_without_success/);
  assert.match(gate, /v6\.operations\.mobile_cadence/);
  assert.match(gate, /v6\.operations\.command_cadence/);
  assert.match(gate, /v6\.operations\.early_action_burst/);
  assert.match(gate, /v6\.operations\.early_dispatch_action_burst/);
  assert.match(gate, /v6\.operations\.global_backpressure/);
  assert.match(gate, /v6\.operations\.device_backpressure/);
  assert.match(gate, /v6\.operations\.gui_request_amplification/);
  assert.match(gate, /v6\.operations\.action_p95/);
  assert.match(gate, /v6\.operations\.command_p95/);
  assert.match(runner, /v6OperationsProfile,/);
  assert.match(launcher, /completedReport\?\.v6OperationsProfile/);
  assert.match(launcher, /profile\?\.cadence\?\.mobileActionCadenceOk/);
  assert.match(launcher, /profile\?\.cadence\?\.commandCadenceOk/);
  assert.match(launcher, /profile\?\.missingMobileActionTypes/);
  assert.match(launcher, /profile\?\.mobileActionTypesWithoutSuccess/);
  assert.match(launcher, /profile\?\.runtimeGate\?\.ok/);
  assert.match(launcher, /completedReport\?\.config\?\.v6SchedulerContractVersion/);
  assert.match(launcher, /completedReport\?\.config\?\.v6OperationsStage/);
});

test("il report V6 rende bloccante l'attribuzione latenza schema v1", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /import \{ buildV6LatencyAttribution \}/);
  assert.match(runner, /v6\.operations\.latency_attribution_complete/);
  assert.match(runner, /v6\.operations\.latency_attribution_incomplete/);
  assert.match(runner, /latencyAttribution,/);
  assert.match(runner, /renderLatencyAttributionMarkdown/);
});

test("i retry della stessa comanda mantengono una chiave idempotente stabile", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const createAction = between(
    runner,
    "async function runP5CreateOrderAction",
    "async function createP5ScenarioOrder",
  );
  assert.match(
    createAction,
    /const idempotencyKey = `load-create-\$\{runId\}-\$\{device\.session\.deviceUuid\}-\$\{ordinal\}`/,
  );
  assert.match(createAction, /runV6OrderCreateRetry\(\{/);
  assert.match(createAction, /maxAttempts:\s*5/);
  assert.match(createAction, /idempotencyKey:\s*stableKey/);
  assert.match(createAction, /acquireV6OrderCreateTable\(\{/);
  assert.match(createAction, /timeoutMs:\s*V6_ORDER_CREATE_TABLE_WAIT_MS/);
  assert.match(createAction, /createTableReservations\.delete\(tableId\)/);
  assert.ok(
    createAction.indexOf("const idempotencyKey") <
      createAction.indexOf("acquireV6OrderCreateTable"),
  );
});

test("il successo business non promuove gli HTTP ammessi fuori dai 2xx", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const successPolicy = between(
    runner,
    "function operationSucceeded",
    "function selectUsableOrder",
  );
  const roomChange = between(
    runner,
    "async function roomChange",
    "async function runRoomChangeBranchProbes",
  );

  assert.match(successPolicy, /typeof result\.businessOk === "boolean"/);
  assert.match(successPolicy, /result\.status >= 200/);
  assert.match(successPolicy, /result\.status < 300/);
  assert.match(successPolicy, /result\.body\?\.ok !== false/);
  assert.ok(
    successPolicy.indexOf("result.status") < successPolicy.indexOf("result.ok"),
  );
  assert.match(roomChange, /if \(options\.expectDenied\)/);
  assert.match(roomChange, /businessOk:\s*result\.status === 403/);
});

test("le fixture 25+5 sono admin-created, drenate e fuori dal conteggio esatto", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const fixtures = between(
    runner,
    "async function prepareV6OperationFixtures",
    "function runP5AutomaticCashExclusive",
  );
  const profile = between(
    runner,
    "async function runP5EnduranceProfile",
    "async function findProcessIds",
  );

  assert.match(fixtures, /for \(const \[fixtureIndex, device\] of devices\.entries\(\)\)/);
  assert.match(fixtures, /createP5ScenarioOrder\(\s*context\.admin/);
  assert.match(fixtures, /device\.ownOrders\.push\(fixture\.order\)/);
  assert.match(fixtures, /context\.sharedOrders\.push\(fixture\.order\)/);
  assert.match(fixtures, /V6_READY_ORDER_ACTION_TYPES\.has\(actionType\)/);
  assert.match(fixtures, /pendingReadyFixtures\.push/);
  assert.match(fixtures, /syncOrderAtCurrentStation\([\s\S]+"delivered"/);
  assert.match(fixtures, /const fixtureOrderTableIds = new Set\(\)/);
  assert.match(fixtures, /reservedTableIds:\s*fixtureOrderTableIds/);
  assert.equal(
    fixtures.match(/allowTableReuse:\s*true/g)?.length,
    2,
  );
  assert.match(fixtures, /fixture\.device\.readyOrders\.push\(fixture\.order\)/);
  assert.match(fixtures, /workflowReadyOrders:\s*pendingReadyFixtures\.length/);
  assert.match(fixtures, /device\.tableMoveFixtures\.push/);
  assert.match(fixtures, /occupancyState:\s*"seated"/);
  assert.match(fixtures, /occupancyState:\s*"free"/);
  assert.match(fixtures, /tableMoveActions:\s*tableMoveActionCount/);
  assert.match(fixtures, /waitForRelationalDrain\(context\.admin\)/);
  assert.match(fixtures, /relationalDrain\.drained !== true/);
  assert.match(fixtures, /excludedFromExactDevicePersistence:\s*true/);
  assert.match(profile, /kind:\s*"station"[\s\S]+ownOrders:\s*\[\]/);
  assert.match(
    profile,
    /const fixtureSummary = operationsProfile[\s\S]+prepareV6OperationFixtures\(devices, context\)/,
  );
  assert.ok(
    profile.indexOf("const fixtureSummary") <
      profile.indexOf("const profileStartedAt = Date.now()"),
  );
  assert.match(profile, /profile\.fixtureSummary = fixtureSummary/);
  assert.match(
    runner,
    /fixtureSummary:\s*summary\.v6OperationsProfile\.fixtureSummary/,
  );
  assert.match(runner, /waiterPauseSettings:\s*{\s*enabled:\s*true/);
  assert.match(profile, /fixtureTables:\s*tablePools\.fixtureTables/);
  assert.match(profile, /runtimeTables:\s*tablePools\.runtimeTables/);
});

test("le operazioni distruttive usano prerequisiti dedicati e diagnostica redatta", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const selector = between(
    runner,
    "function selectV6OperationOrder",
    "async function runV6OperationsHandheldAction",
  );
  const dispatcher = between(
    runner,
    "async function runV6OperationsHandheldAction",
    "async function runV6OperationsStationAction",
  );
  const diagnostics = between(
    runner,
    "function v6OperationFailureDetails",
    "function selectV6OperationOrder",
  );

  assert.match(selector, /const readyOrders = Array\.isArray\(device\.readyOrders\)/);
  assert.match(selector, /V6_READY_ORDER_ACTION_TYPES\.has\(actionType\)/);
  assert.match(selector, /readyOrders\.filter\(isAvailable\)\.at\(-1\)/);
  assert.match(selector, /const tableReserved = context\.operationTableIds/);
  assert.match(selector, /const createTablesInFlight = context\.inFlightCreateTableIds/);
  assert.match(selector, /!tableReserved\.has\(tableId\)/);
  assert.match(selector, /!createTablesInFlight\.has\(tableId\)/);
  assert.match(selector, /if \(tableId\) tableReserved\.add\(tableId\)/);
  assert.match(
    selector,
    /actionType === "order\.correct" \? pool\[0\] \|\| null : pool\.at\(-1\) \|\| null/,
  );
  assert.match(selector, /async function waitForV6ReadyOrder/);
  assert.match(selector, /attempt <= 12/);
  assert.match(selector, /await sleep\(100 \+ attempt \* 25\)/);
  assert.match(selector, /\^\(\?:order\|print\)\\\./);
  assert.match(dispatcher, /Fixture pagabile mancante/);
  assert.match(
    dispatcher,
    /V6_READY_ORDER_ACTION_TYPES\.has\(actionType\)[\s\S]+await waitForV6ReadyOrder/,
  );
  assert.match(dispatcher, /context\.operationTableIds,[\s\S]+context\.inFlightCreateTableIds/);
  assert.match(dispatcher, /finally \{[\s\S]+context\.operationTableIds\.delete\(reservedOrderTableId\)/);
  assert.match(dispatcher, /device\.tableMoveFixtures\.shift\(\)/);
  assert.match(dispatcher, /moveTable\(session, fixture\.from, fixture\.to\)/);
  assert.match(diagnostics, /result\?\.paused/);
  assert.match(diagnostics, /businessCode:/);
  assert.match(diagnostics, /businessError:/);
  assert.doesNotMatch(diagnostics, /deviceUuid|orderId|serial/);
  assert.match(runner, /status:\s*failureDetails\?\.status \?\? 0/);
  assert.match(runner, /businessCode:\s*failureDetails\?\.businessCode/);
  assert.match(runner, /businessError:\s*failureDetails\?\.businessError/);
});

test("i conflitti transitori usano retry limitati e mantengono proprietario e revisione correnti", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const tableAcquisition = await source("v6-order-table-acquisition.mjs");
  const lockRetry = between(
    runner,
    "function isTransientTableLockConflict",
    "async function releaseTable",
  );
  const transfer = between(
    runner,
    "async function requestAndResolveOrderTransfer",
    "async function reprintPaymentMovement",
  );
  const barReplacement = between(
    runner,
    "async function barReplacementOrder",
    "async function splitOrderLine",
  );
  const lineSplit = between(
    runner,
    "async function splitOrderLine",
    "async function overrideOrderLinePrice",
  );
  const correction = between(
    runner,
    "async function correctOrder",
    "async function compOrder",
  );
  const tableMove = between(
    runner,
    "async function moveTable",
    "async function roomMoveRequest",
  );
  const createOrderAction = between(
    runner,
    "async function runP5CreateOrderAction",
    "async function createP5ScenarioOrder",
  );
  const fixtures = between(
    runner,
    "async function prepareV6OperationFixtures",
    "function runP5AutomaticCashExclusive",
  );
  const stationAction = between(
    runner,
    "async function runV6OperationsStationAction",
    "async function runP5StationAction",
  );

  assert.match(lockRetry, /body\?\.code[^\n]+TABLE_LOCKED/);
  assert.match(lockRetry, /Math\.min\(Number\(options\.attempts\) \|\| 4, 6\)/);
  assert.match(lockRetry, /if \(isLockAcquired\(result\) \|\| !isTransientTableLockConflict\(result\)\)/);
  assert.match(transfer, /const idempotencyKey = `load-transfer-request-/);
  assert.match(transfer, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(transfer, /requested\?\.body\?\.code !== "REVISION_CONFLICT"/);
  assert.match(transfer, /requested\?\.body\?\.details\?\.currentRevision/);
  assert.match(transfer, /resolved\?\.body\?\.code !== "REVISION_CONFLICT"/);
  assert.match(transfer, /resolved\?\.body\?\.details\?\.currentRevision/);
  assert.match(transfer, /safeTarget = selectTarget\(order\)/);
  assert.match(transfer, /pendingOrder\?\.pendingAuthRequest/);
  assert.match(transfer, /Nessuna richiesta di trasferimento pendente/);
  assert.match(transfer, /reconciled:\s*true/);
  assert.match(barReplacement, /const idempotencyKey = `load-bar-replacement-/);
  assert.match(barReplacement, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(barReplacement, /idempotencyKey,/);
  assert.match(barReplacement, /isTransientTableLockConflict\(result\)/);
  assert.match(lineSplit, /for \(let attempt = 1; attempt <= 5; attempt \+= 1\)/);
  assert.match(lineSplit, /lockTableWithRetry\([\s\S]+attempts:\s*6/);
  assert.match(lineSplit, /result\?\.body\?\.code === "REVISION_CONFLICT"/);
  assert.match(lineSplit, /isTransientTableLockConflict\(result\)/);
  assert.match(lineSplit, /await sleep\(attempt \* 250\)/);
  assert.match(correction, /lockTableWithRetry\([\s\S]+attempts:\s*6/);
  assert.match(tableMove, /for \(let attempt = 1; attempt <= 4; attempt \+= 1\)/);
  assert.match(
    tableMove,
    /result\?\.body\?\.code === "RELATIONAL_TABLE_MOVE_TABLE_REVISION_CONFLICT"/,
  );
  assert.match(tableMove, /event:\s*"v6_table_move_revision_retry"/);
  assert.match(tableMove, /finally \{[\s\S]+releaseTable\(session, from\.id\)[\s\S]+releaseTable\(session, to\.id\)/);
  assert.match(fixtures, /const dedicatedFixtureTableIds = new Set\(\)/);
  assert.match(
    fixtures,
    /dedicatedFixtureTableIds\.add\(String\(fixture\.order\.tableId\)\)/,
  );
  assert.match(
    fixtures,
    /context\.orderTables = context\.orderTables\.filter\([\s\S]+!dedicatedFixtureTableIds\.has/,
  );
  assert.match(fixtures, /ensureV6OrderTableCapacity\(\{/);
  assert.match(
    fixtures,
    /minimumPerHandheld:\s*V6_RUNTIME_LIMITS\.maxInFlightPerDevice \+ 1/,
  );
  assert.match(fixtures, /excludedTableIds:\s*excludedFixtureTableIds/);
  assert.match(createOrderAction, /acquireV6OrderCreateTable\(\{/);
  assert.match(createOrderAction, /timeoutMs:\s*V6_ORDER_CREATE_TABLE_WAIT_MS/);
  assert.match(
    createOrderAction,
    /finally \{[\s\S]+createTableReservations\.delete\(tableId\)/,
  );
  assert.match(tableAcquisition, /!reservedTableIds\.has\(tableId\)/);
  assert.match(tableAcquisition, /!inFlightTableIds\.has\(tableId\)/);
  assert.match(tableAcquisition, /inFlightTableIds\.add\(selectedId\)/);
  assert.match(tableAcquisition, /V6OrderTableAvailabilityTimeoutError/);
  assert.match(tableAcquisition, /await wait\(Math\.min\(poll, remainingMs\)\)/);
  assert.match(stationAction, /performStationWorkflowAction/);
  assert.match(stationAction, /!context\.operationTableIds\.has\(tableId\)/);
  assert.match(stationAction, /!context\.inFlightCreateTableIds\.has\(tableId\)/);
  assert.match(stationAction, /context\.operationTableIds\.add\(tableId\)/);
  assert.match(stationAction, /order \? \[String\(order\.id \?\? ""\)\.trim\(\)\]/);
  assert.match(stationAction, /finally \{[\s\S]+context\.operationTableIds\.delete\(reservedOrderTableId\)/);
  assert.match(runner, /operationTableIds:\s*new Set\(\)/);
  assert.match(runner, /inFlightCreateTableIds:\s*new Set\(\)/);
  assert.match(runner, /async function pollStationWorkflowOrders/);
  assert.match(runner, /operatorUserId:\s*session\.user\.id/);
  assert.match(runner, /operatorUsername:\s*session\.user\.username/);
  assert.match(runner, /deviceUuid:\s*session\.deviceUuid/);
  assert.match(runner, /fresh:\s*String\(Date\.now\(\)\)/);
  assert.match(runner, /function stationWorkflowOrderMatchesSession/);
  assert.match(runner, /assignedStationOperatorUserId/);
  assert.match(runner, /assignedStationOperatorUsername/);
  assert.match(runner, /assignedStationDeviceUuid/);
  assert.match(runner, /assignedStationOperatorName/);
  assert.match(runner, /\.filter\(\(candidate\) => stationWorkflowOrderMatchesSession\(candidate, session\)\)/);
  assert.match(runner, /reservedOrderIds instanceof Set/);
  assert.match(runner, /eligibleOrderIds instanceof Set/);
  assert.match(runner, /filterV6StationWorkflowCandidates/);
  assert.match(runner, /claimV6StationWorkflowTarget\(target, reservedOrderIds\)/);
  assert.match(runner, /preparation_capacity_preserved/);
  assert.match(runner, /preparation_capacity_race/);
});

test("l'override prezzo mobile ritenta solo TABLE_LOCKED con payload e identita stabili", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const retry = await source("v6-mobile-action-retry.mjs");
  const priceOverride = between(
    runner,
    "async function overrideOrderLinePrice",
    "async function payOrder",
  );
  const dispatcher = between(
    runner,
    "async function runV6OperationsHandheldAction",
    "async function runV6OperationsStationAction",
  );

  assert.match(
    runner,
    /import \{ runV6MobileBusinessActionRetry \} from "\.\/v6-mobile-action-retry\.mjs"/,
  );
  assert.match(retry, /V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS = 2/);
  assert.match(retry, /Number\(result\?\.status \?\? 0\) === 409/);
  assert.match(
    retry,
    /String\(result\?\.body\?\.code \?\? ""\)\.trim\(\) === "TABLE_LOCKED"/,
  );
  assert.match(
    retry,
    /Math\.min\([\s\S]+V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS/,
  );
  assert.doesNotMatch(retry, /REVISION_CONFLICT|TABLE_LOCK_REQUIRED|status === 0/);
  assert.match(priceOverride, /const requestBody = Object\.freeze\(\{/);
  assert.match(priceOverride, /expectedRevision,/);
  assert.match(priceOverride, /idempotencyKey,/);
  assert.match(priceOverride, /runV6MobileBusinessActionRetry\(\{/);
  assert.match(priceOverride, /actionType:\s*"order\.price_override"/);
  assert.match(priceOverride, /attempt:\s*async \(\{ idempotencyKey: stableIdempotencyKey \}\)/);
  assert.match(priceOverride, /lockTableWithRetry\([\s\S]+requestBody,[\s\S]+finally \{[\s\S]+releaseTable/);
  assert.match(
    dispatcher,
    /overrideOrderLinePrice\(session, order, \{[\s\S]+logicalActionId: `\$\{runId\}:handheld:\$\{device\.index \+ 1\}:\$\{ordinal\}:\$\{actionType\}`/,
  );
});

test("le prenotazioni operative riservano slot non confliggenti per tavolo", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const reservation = between(
    runner,
    "async function reservationFlow",
    "async function roomChange",
  );
  const reservationSlot = between(
    runner,
    "function nextV6ReservationAt",
    "async function runV6OperationsHandheldAction",
  );
  const dispatcher = between(
    runner,
    "async function runV6OperationsHandheldAction",
    "async function runV6OperationsStationAction",
  );

  assert.match(reservation, /Number\(options\.reservationAt\)/);
  assert.match(reservation, /localDateKey\(new Date\(reservationAt\)\)/);
  assert.match(reservationSlot, /context\.reservationSlotsByTableId/);
  assert.match(reservationSlot, /previousSlot \+ 61 \* 60_000/);
  assert.match(reservationSlot, /slots\.set\(tableId, reservationAt\)/);
  assert.match(
    dispatcher,
    /reservationFlow\(session, table, \{[\s\S]+nextV6ReservationAt\(context, table\)/,
  );
  assert.match(runner, /reservationSlotsByTableId:\s*new Map\(\)/);
});

test("le azioni ordine e stampa della Postazione preferiscono fixture proprie libere", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const stationAction = between(
    runner,
    "async function runV6OperationsStationAction",
    "async function runP5StationAction",
  );

  assert.match(stationAction, /\^\(\?:station\\\.order\|station\\\.print\)\\\./);
  assert.match(stationAction, /availableOrders\(device\.ownOrders\)/);
  assert.match(stationAction, /availableOrders\(context\.sharedOrders\)/);
  assert.match(stationAction, /const eligibleOrderIds = new Set/);
  assert.match(stationAction, /eligibleOrderIds,/);
  assert.match(
    stationAction,
    /ownOrders\.at\(-1\) \|\| sharedOrders\.at\(-1\) \|\| null/,
  );
  assert.match(stationAction, /context\.operationOrderIds\.add\(String\(order\.id\)\)/);
  assert.match(stationAction, /context\.operationTableIds\.add\(tableId\)/);
  assert.match(stationAction, /context\.operationTableIds\.delete\(reservedOrderTableId\)/);
});
