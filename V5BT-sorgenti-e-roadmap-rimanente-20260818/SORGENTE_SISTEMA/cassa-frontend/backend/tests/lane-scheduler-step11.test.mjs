import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeLaneKeyList,
  resolvePaymentLaneKeyFromRequest,
  resolvePrintLaneKeysFromRequest,
  resolveRoomLaneKeysFromRequest,
} from "../modules/queue/lane-routing.js";
import { createRuntimeMetrics } from "../modules/runtime-metrics.js";

const __filename = fileURLToPath(import.meta.url);
const cassaDir = path.resolve(path.dirname(__filename), "..");

function req(payload) {
  return { __jsonBodyPayload: payload };
}

test("Step 11A risolve chiavi lane print e table in modo deterministico", () => {
  assert.deepEqual(
    normalizeLaneKeyList("table:1", ["table:1", "room:a"], "", null),
    ["table:1", "room:a"],
  );
  assert.deepEqual(
    resolvePrintLaneKeysFromRequest(
      req({ kind: "order", orderId: "ord_1", printerId: "printer_bar" }),
      "/api/integration/print",
    ),
    ["print:printer_bar", "order:ord_1", "/api/integration/print:order"],
  );
  assert.deepEqual(
    resolveRoomLaneKeysFromRequest(
      req({ fromTableId: "t1", toTableId: "t2" }),
      "/api/integration/layout/table/move",
    ),
    ["table:t1", "table:t2"],
  );
});

test("le mutazioni gruppi tavolo e incasso banco usano lane dedicate", () => {
  assert.deepEqual(
    resolveRoomLaneKeysFromRequest(
      req({ groups: [{ id: "table_1" }] }),
      "/api/integration/table-groups/save",
    ),
    ["table-groups:global"],
  );
  assert.equal(
    resolvePaymentLaneKeyFromRequest(
      req({ tableId: "counter:banco", order: { id: "counter_1" } }),
      "/api/tables/counter/orders/collect",
    ),
    "table:counter:banco",
  );

  const serverSource = readFileSync(path.join(cassaDir, "server.js"), "utf8");
  const paymentPaths = serverSource.match(
    /const PAYMENT_LANE_PATHS = new Set\(\[([\s\S]*?)\]\);/,
  )?.[1] ?? "";
  const roomPaths = serverSource.match(
    /const ROOM_LANE_PATHS = new Set\(\[([\s\S]*?)\]\);/,
  )?.[1] ?? "";
  assert.match(paymentPaths, /\/api\/tables\/counter\/orders\/collect/);
  assert.match(roomPaths, /\/api\/integration\/table-groups\/save/);
});

test("una promozione DB anziana cede un turno alle lane domain", () => {
  const serverSource = readFileSync(path.join(cassaDir, "server.js"), "utf8");
  const dequeueSource = serverSource.match(
    /function dequeueNextDbMutationTask\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  const schedulerSource = serverSource.match(
    /function scheduleNextDbMutationTask\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";

  assert.match(dequeueSource, /selection\.promoted[\s\S]+dbMutationStarvationYieldPending = true/);
  assert.match(schedulerSource, /dbMutationStarvationYieldPending[\s\S]+!hasStrictUrgentDbMutationQueued\(\)[\s\S]+scheduleOneDomainLaneAfterStarvationPromotion\(\)/);
  assert.match(serverSource, /hasStrictUrgentDbMutationTask\(dbMutationQueue/);
});

test("P4.3 room lane concurrency conserva l'esclusione per utente sala e tavolo", () => {
  const sameDeviceFirst = resolveRoomLaneKeysFromRequest(
    req({ targetRoomId: "room_a", deviceUuid: "device_1" }),
    "/api/pos/room-change/request",
  );
  const sameDeviceSecond = resolveRoomLaneKeysFromRequest(
    req({ targetRoomId: "room_b", deviceUuid: "device_1" }),
    "/api/pos/room-change/request",
  );
  const sameRoomOtherDevice = resolveRoomLaneKeysFromRequest(
    req({ targetRoomId: "room_a", deviceUuid: "device_2" }),
    "/api/pos/room-change/request",
  );
  const sameTableFirst = resolveRoomLaneKeysFromRequest(
    req({ tableId: "table_1" }),
    "/api/integration/layout/table/sync",
  );
  const sameTableSecond = resolveRoomLaneKeysFromRequest(
    req({ tableId: "table_1" }),
    "/api/integration/layout/table/sync",
  );
  const overlaps = (left, right) => left.some((key) => right.includes(key));

  assert.equal(overlaps(sameDeviceFirst, sameDeviceSecond), true);
  assert.equal(overlaps(sameDeviceFirst, sameRoomOtherDevice), true);
  assert.equal(overlaps(sameTableFirst, sameTableSecond), true);
  assert.equal(
    overlaps(
      sameDeviceSecond,
      resolveRoomLaneKeysFromRequest(
        req({ targetRoomId: "room_c", deviceUuid: "device_3" }),
        "/api/pos/room-change/request",
      ),
    ),
    false,
  );

  const serverSource = readFileSync(path.join(cassaDir, "server.js"), "utf8");
  assert.match(
    serverSource,
    /ROOM_LANE_CONCURRENCY[\s\S]+parsePositiveInt\(process\.env\.ROOM_LANE_CONCURRENCY, 4\)/,
  );
  assert.match(
    serverSource,
    /candidateKeys\.some\(\(key\) => roomLaneActiveKeys\.has\(key\)\)/,
  );
  assert.match(
    serverSource,
    /taskKeys\.forEach\(\(key\) => roomLaneActiveKeys\.add\(key\)\)/,
  );
  assert.match(
    serverSource,
    /taskKeys\.forEach\(\(key\) => roomLaneActiveKeys\.delete\(key\)\)/,
  );
});

test("le letture layout non entrano nella room mutation lane", () => {
  const serverSource = readFileSync(path.join(cassaDir, "server.js"), "utf8");
  const roomPaths =
    serverSource.match(
      /const ROOM_LANE_PATHS = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1] ?? "";
  const roomPredicate =
    serverSource.match(/function isRoomLaneRequest\([\s\S]*?\n\}/)?.[0] ?? "";

  assert.doesNotMatch(roomPaths, /["']\/api\/integration\/layout["']/);
  assert.match(roomPredicate, /safeMethod === ["']POST["']/);
  assert.doesNotMatch(roomPredicate, /GET|isIntegrationLayoutReadRequest/);
  assert.doesNotMatch(serverSource, /isIntegrationLayoutReadRequest/);
});

test("Step 11A espone metriche print lane senza passare dalla coda globale", () => {
  const metrics = createRuntimeMetrics({ enabled: true });

  metrics.incrementCounter("printLaneEnqueued");
  metrics.recordQueueDepth({ printLaneDepth: 2, printLaneRunning: 1 });
  metrics.recordQueueWait("printLane", "POST /api/integration/print", 60);
  metrics.recordQueueRun("printLane", "POST /api/integration/print", 12);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.printLaneEnqueued, 1);
  assert.equal(snapshot.gauges.printLaneDepth, 2);
  assert.equal(snapshot.gauges.printLaneRunning, 1);
  assert.equal(
    snapshot.queues.printLane.waitMsByLabel["POST /api/integration/print"].p95,
    100,
  );
  assert.equal(
    snapshot.queues.dbMutation.waitMsByLabel["POST /api/integration/print"],
    undefined,
  );
  assert.equal(snapshot.dashboard.lanes.printDepth, 2);
  assert.equal(snapshot.dashboard.lanes.printRunning, 1);
});

test("Step 11A cabla print lane dietro flag e senza bloccare le domain lane", () => {
  const serverSource = readFileSync(path.join(cassaDir, "server.js"), "utf8");
  const domainLaneRunningBody =
    serverSource.match(
      /function domainLaneRunningCount\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";

  assert.match(
    serverSource,
    /PRINT_LANE_STORAGE_READY\s*=\s*PRINT_SPOOL_SQL_PRIMARY/,
  );
  assert.match(
    serverSource,
    /PRINT_LANE_ENABLED[\s\S]+process\.env\.LANE_PRINT === ["']1["']/,
  );
  assert.match(
    serverSource,
    /PRINT_LANE_PATHS = new Set\(\[\s*["']\/api\/integration\/print["']\s*\]\)/,
  );
  assert.match(
    serverSource,
    /printLane = createSerializedMutationLane\(\{[\s\S]+kind: ["']printLane["'][\s\S]+counterName: ["']printLaneEnqueued["']/,
  );
  assert.match(
    serverSource,
    /function isPrintLaneRequest[\s\S]+canUsePrintSpoolFastWorker\(\)[\s\S]+PRINT_LANE_PATHS\.has/,
  );
  assert.match(
    serverSource,
    /resolvePrintLaneKeysFromRequest\(req, pathname\)/,
  );
  assert.doesNotMatch(domainLaneRunningBody, /printLane\.runningCount/);
});
