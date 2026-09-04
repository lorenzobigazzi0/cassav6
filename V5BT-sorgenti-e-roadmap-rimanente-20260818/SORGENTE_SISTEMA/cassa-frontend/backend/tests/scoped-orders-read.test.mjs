import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRelationalRuntime } from "../db/relational/index.js";
import { createDefaultIntegrationState } from "../modules/app-state/index.js";
import {
  buildIntegrationOrdersFastCacheKey,
  readScopedIntegrationOrdersDb,
} from "../modules/integration/scoped-orders-read.js";
import {
  authHeaders,
  buildTestState,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

function createRepo(calls) {
  return {
    enabled: true,
    async readObjectArrayEntry(domain, fieldName, entryId, fallback) {
      calls.push(["arrayEntry", domain, fieldName, entryId]);
      if (domain !== "integration" || fieldName !== "orders") return fallback;
      if (entryId === "00042") {
        return { id: "00042", total: 12, dueAmount: 12 };
      }
      return fallback;
    },
    async readObjectArrayField(domain, fieldName, fallback) {
      calls.push(["array", domain, fieldName]);
      if (domain === "integration" && fieldName === "orders") {
        return [{ id: "00042", total: 12, dueAmount: 12 }];
      }
      return fallback;
    },
    async readObjectArrayFieldMatchingText(domain, fieldName, searchText, fallback) {
      calls.push(["match", domain, fieldName, searchText]);
      if (domain === "integration" && fieldName === "orders" && searchText === "BAR") {
        return [{ id: "00042", station: "BAR", total: 12, dueAmount: 12 }];
      }
      return fallback;
    },
    async readIntegrationOrdersForStation(station, options = {}) {
      calls.push(["stationIndex", station, options.includeTransferred === true ? "1" : "0"]);
      if (station === "BAR") {
        return [{ id: "00042", station: "BAR", total: 12, dueAmount: 12 }];
      }
      if (station === "BAR_LIMIT") {
        return [
          {
            id: "active",
            station: "BAR_LIMIT",
            workflowStatus: "prep",
            paymentStatus: "unpaid",
            total: 12,
            dueAmount: 12,
            receivedAtMs: 100,
          },
          {
            id: "old",
            station: "BAR_LIMIT",
            workflowStatus: "delivered",
            paymentStatus: "paid",
            total: 8,
            dueAmount: 0,
            receivedAtMs: 200,
          },
          {
            id: "recent_a",
            station: "BAR_LIMIT",
            workflowStatus: "ready",
            paymentStatus: "unpaid",
            total: 6,
            dueAmount: 6,
            receivedAtMs: 300,
          },
          {
            id: "recent_b",
            station: "BAR_LIMIT",
            workflowStatus: "delivered",
            paymentStatus: "paid",
            total: 4,
            dueAmount: 0,
            receivedAtMs: 400,
          },
        ];
      }
      if (station === "BAR_DEFAULT") {
        return [
          {
            id: "active_default",
            station: "BAR_DEFAULT",
            workflowStatus: "prep",
            paymentStatus: "unpaid",
            total: 12,
            dueAmount: 12,
            receivedAtMs: 100,
          },
          ...Array.from({ length: 35 }, (_, index) => {
            const number = index + 1;
            return {
              id: `hist_${String(number).padStart(2, "0")}`,
              station: "BAR_DEFAULT",
              workflowStatus: "delivered",
              paymentStatus: "paid",
              total: 4,
              dueAmount: 0,
              receivedAtMs: 1000 + number,
            };
          }),
        ];
      }
      return options.fallback ?? null;
    },
    async readObjectEntry(domain, fieldName, fallback) {
      calls.push(["entry", domain, fieldName]);
      if (fieldName === "lastWriteAt") return "2026-06-30T12:00:00.000Z";
      if (fieldName === "tableGroups") return [{ id: "group_1", leafIds: ["table_1"] }];
      if (fieldName === "orderComps") return [{ id: "comp_1", orderId: "00042" }];
      if (fieldName === "orderCorrections") return [{ id: "corr_1", orderId: "00042" }];
      return fallback;
    },
    async readDomainValue(domain, fallback) {
      calls.push(["domain", domain]);
      if (domain === "posSettings") return { tables: [{ id: "table_1", number: 1 }] };
      if (domain === "menuItems") return [{ id: "menu_caffe", name: "Caffe", price: 1.3 }];
      if (domain === "users") return [{ id: "u_1", username: "amalia" }];
      return fallback;
    },
  };
}

test("M2 orders fast cache key normalizza richieste station-scoped equivalenti", () => {
  const first = buildIntegrationOrdersFastCacheKey(
    new URL(
      "http://localhost/api/integration/orders?station=BAR&includeDone=1&includeTransferred=1&_=" +
        "123&token=secret&clientApp=postazione&fullName=Lorenzo&historyLimit=30",
    ),
  );
  const second = buildIntegrationOrdersFastCacheKey(
    new URL(
      "http://localhost/api/integration/orders?includeTransferred=1&doneHistoryLimit=30&includeDone=1&station=BAR",
    ),
  );
  const third = buildIntegrationOrdersFastCacheKey(
    new URL(
      "http://localhost/api/integration/orders?station=BAR&includeDone=1&includeTransferred=1",
    ),
  );

  assert.equal(first, second);
  assert.equal(second, third);
  assert.deepEqual(JSON.parse(first), [
    ["doneHistoryLimit", "30"],
    ["includeDone", "1"],
    ["includeTransferred", "1"],
    ["station", "BAR"],
  ]);
});

test("M2 orders fast cache key distingue solo filtri che cambiano risposta", () => {
  const base = "http://localhost/api/integration/orders?station=BAR&includeDone=1";
  assert.notEqual(
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&deviceUuid=a`)),
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&deviceUuid=b`)),
  );
  assert.notEqual(
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&doneHistoryLimit=0`)),
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&doneHistoryLimit=30`)),
  );
  assert.equal(
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&orderId=0001&doneHistoryLimit=0`)),
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&id=0001&historyLimit=30`)),
  );
  assert.equal(
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&operatorUsername=Lorenzo`)),
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&username=lorenzo`)),
  );
  assert.equal(
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&operatorUserId=u1`)),
    buildIntegrationOrdersFastCacheKey(new URL(`${base}&userId=u1`)),
  );
});

test("M2 integration.orders riusa la fast cache per poll station-scoped equivalenti", async (t) => {
  const deviceUuid = "m2-orders-cache-admin";
  const { baseUrl } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
      INTEGRATION_HOT_GET_FAST_CACHE_MS: "10000",
    },
  });
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "cassa-frontend",
  });

  const reset = await fetch(`${baseUrl}/api/monitor/runtime-metrics/reset`, {
    method: "POST",
    headers: authHeaders(admin, deviceUuid),
    body: JSON.stringify({}),
  });
  assert.equal(reset.status, 200);

  const first = await fetch(
    `${baseUrl}/api/integration/orders?station=BAR%20PRINCIPALE&includeDone=1&includeTransferred=1&historyLimit=30&_=1&fullName=Lorenzo&clientApp=postazione`,
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);

  const second = await fetch(
    `${baseUrl}/api/integration/orders?includeTransferred=1&doneHistoryLimit=30&includeDone=1&station=BAR%20PRINCIPALE&_=2&token=ignored`,
  );
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.ok, true);
  assert.deepEqual(secondBody.orders, firstBody.orders);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, deviceUuid),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.integrationOrdersFastCacheMisses, 1);
  assert.equal(metrics.runtimeMetrics.counters.integrationOrdersFastCacheHits, 1);
});

test("scoped orders read costruisce uno snapshot minimale per richieste read-only", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?roomId=sala"),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
  });

  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.equal(db.integration.orders[0].id, "00042");
  assert.equal(db.integration.orderComps[0].id, "comp_1");
  assert.equal(db.posSettings.tables[0].id, "table_1");
  assert.deepEqual(
    calls.map((entry) => entry.join(":")),
    [
      "array:integration:orders",
      "entry:integration:tableGroups",
      "entry:integration:orderComps",
      "entry:integration:orderCorrections",
      "entry:integration:lastWriteAt",
      "domain:posSettings",
      "domain:menuItems",
      "domain:users",
    ],
  );
});

test("scoped orders read riconcilia lookup puntuale dal relazionale write-primary", async () => {
  const calls = [];
  const relationalCalls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?orderId=00042&includeDone=1"),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
    relationalOrdersLookupReadEnabled: true,
    relationalOrdersRepository: {
      async getOrderById(id) {
        relationalCalls.push(id);
        if (id !== "00042") return null;
        return {
          id: "00042",
          station: "BAR",
          workflowStatus: "delivered",
          revision: 2,
          currentRevision: 2,
          total: 12,
          dueAmount: 12,
        };
      },
    },
  });

  assert.deepEqual(relationalCalls, ["00042"]);
  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.equal(db.integration.orders[0].id, "00042");
  assert.equal(db.integration.orders[0].workflowStatus, "delivered");
  assert.equal(db.integration.orders[0].revision, 2);
});

test("lookup puntuale conserva il tavolo operativo a pari revisione", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?orderId=00042&includeDone=1"),
    domainsRepository: {
      ...createRepo(calls),
      async readObjectArrayEntry(_domain, _fieldName, entryId) {
        calls.push(["arrayEntry", "integration", "orders", entryId]);
        return entryId === "00042"
          ? {
              id: "00042",
              revision: 4,
              currentRevision: 4,
              tableId: "table_current",
              roomId: "room_current",
              lastTableTransferAtMs: 200,
              total: 12,
              dueAmount: 8,
              paidArticleUnits: ["00042_0_0"],
            }
          : null;
      },
    },
    createDefaultIntegrationState,
    relationalOrdersLookupReadEnabled: true,
    relationalOrdersRepository: {
      async getOrderById(id) {
        return id === "00042"
          ? {
              id: "00042",
              revision: 4,
              currentRevision: 4,
              tableId: "table_stale",
              roomId: "room_stale",
              lastTableTransferAtMs: 100,
              total: 12,
              dueAmount: 12,
              paidArticleUnits: [],
            }
          : null;
      },
    },
  });

  assert.equal(db.integration.orders.length, 1);
  assert.equal(db.integration.orders[0].tableId, "table_current");
  assert.equal(db.integration.orders[0].roomId, "room_current");
  assert.equal(db.integration.orders[0].dueAmount, 8);
  assert.deepEqual(db.integration.orders[0].paidArticleUnits, ["00042_0_0"]);
  assert.equal(
    calls.some((entry) => entry[0] === "array" && entry[2] === "orders"),
    false,
  );
});

test("lookup puntuale conserva il tavolo operativo anche con revisione relazionale maggiore", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?orderId=00042&includeDone=1"),
    domainsRepository: {
      ...createRepo(calls),
      async readObjectArrayEntry(_domain, _fieldName, entryId) {
        calls.push(["arrayEntry", "integration", "orders", entryId]);
        return entryId === "00042"
          ? {
              id: "00042",
              revision: 1,
              currentRevision: 1,
              tableId: "table_current",
              roomId: "room_current",
              tableNumber: 12,
              tableLabel: "Tavolo 12",
              lastTableTransferAtMs: 300,
              total: 12,
              dueAmount: 12,
            }
          : null;
      },
    },
    createDefaultIntegrationState,
    relationalOrdersLookupReadEnabled: true,
    relationalOrdersRepository: {
      async getOrderById(id) {
        return id === "00042"
          ? {
              id: "00042",
              revision: 5,
              currentRevision: 5,
              tableId: "table_stale",
              roomId: "room_stale",
              tableNumber: 5,
              tableLabel: "Tavolo 5",
              lastTableTransferAtMs: 100,
              workflowStatus: "delivered",
              total: 12,
              dueAmount: 4,
              paidArticleUnits: ["00042_0_0"],
            }
          : null;
      },
    },
  });

  const result = db.integration.orders[0];
  assert.equal(result.revision, 5);
  assert.equal(result.workflowStatus, "delivered");
  assert.equal(result.dueAmount, 4);
  assert.deepEqual(result.paidArticleUnits, ["00042_0_0"]);
  assert.equal(result.tableId, "table_current");
  assert.equal(result.roomId, "room_current");
  assert.equal(result.tableNumber, 12);
  assert.equal(result.tableLabel, "Tavolo 12");
  assert.equal(result.lastTableTransferAtMs, 300);
});

test("P3.68 scoped orders read con orderId evita lo storico relazionale completo", async () => {
  const calls = [];
  const relationalCalls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?orderId=00042&includeDone=1"),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
    relationalOrdersHistoryReadEnabled: true,
    relationalOrdersLookupReadEnabled: true,
    relationalOrdersRepository: {
      async listOrders() {
        relationalCalls.push("listOrders");
        return [{ id: "full_history_should_not_be_used" }];
      },
      async getOrderById(id) {
        relationalCalls.push(`get:${id}`);
        if (id !== "00042") return null;
        return {
          id: "00042",
          station: "BAR",
          workflowStatus: "delivered",
          revision: 3,
          currentRevision: 3,
          total: 12,
          dueAmount: 0,
        };
      },
    },
  });

  assert.deepEqual(relationalCalls, ["get:00042"]);
  assert.equal(
    calls.some((entry) => entry[0] === "array" && entry[1] === "integration" && entry[2] === "orders"),
    false,
  );
  assert.deepEqual(
    db.integration.orders.map((order) => order.id),
    ["00042"],
  );
  assert.equal(db.integration.orders[0].revision, 3);
});

test("MP-4ao scoped orders read usa il read-model correzioni relazionale anche a pari revisione", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?orderId=00077&includeDone=1"),
    domainsRepository: {
      ...createRepo(calls),
      async readObjectArrayField(domain, fieldName, fallback) {
        calls.push(["array", domain, fieldName]);
        if (domain === "integration" && fieldName === "orders") {
          return [
            {
              id: "00077",
              station: "BAR",
              workflowStatus: "prep",
              revision: 2,
              currentRevision: 2,
              items: [{ lineId: "l1", productName: "Caffe" }],
            },
          ];
        }
        return fallback;
      },
    },
    createDefaultIntegrationState,
    relationalOrdersLookupReadEnabled: true,
    relationalOrdersRepository: {
      async getOrderById(id) {
        if (id !== "00077") return null;
        return {
          id: "00077",
          station: "BAR",
          workflowStatus: "prep",
          revision: 2,
          currentRevision: 2,
          lastCorrectionId: "corr_1",
          items: [
            { lineId: "l1", productName: "Caffe" },
            {
              lineId: "l2",
              productName: "Acqua",
              voidedAt: "2026-07-05T01:10:00.000Z",
              correctionStatus: "removed",
              correctionId: "corr_1",
            },
          ],
        };
      },
    },
  });

  const order = db.integration.orders.find((entry) => entry.id === "00077");
  assert.equal(order?.lastCorrectionId, "corr_1");
  assert.equal(order?.items?.[1]?.correctionStatus, "removed");
  assert.equal(order?.items?.[1]?.voidedAt, "2026-07-05T01:10:00.000Z");
});

test("scoped orders read I1 usa relazionale per storico includeDone", async () => {
  const calls = [];
  const relationalCalls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?includeDone=1"),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
    relationalOrdersHistoryReadEnabled: true,
    relationalOrdersRepository: {
      async listOrders() {
        relationalCalls.push("listOrders");
        return [
          {
            id: "rel_old",
            station: "BAR",
            workflowStatus: "delivered",
            paymentStatus: "paid",
            total: 8,
            dueAmount: 0,
          },
        ];
      },
    },
  });

  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.deepEqual(relationalCalls, ["listOrders"]);
  assert.deepEqual(
    db.integration.orders.map((order) => order.id),
    ["rel_old"],
  );
  assert.equal(calls.some((entry) => entry[0] === "array" && entry[2] === "orders"), false);
});

test("scoped orders read I1 usa il runtime relazionale reale", async () => {
  const runDir = await createTempRunDir("scoped-orders-relational-runtime");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: { warn() {} },
    nowIso: () => "2026-07-01T10:00:00.000Z",
  });
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-07-01T10:00:00.000Z";
  state.integration.orders = [
    {
      id: "rel_runtime",
      station: "BAR",
      workflowStatus: "delivered",
      paymentStatus: "paid",
      total: 12,
      dueAmount: 0,
      createdAt: "2026-07-01T09:55:00.000Z",
      updatedAt: "2026-07-01T09:59:00.000Z",
    },
  ];

  try {
    await runtime.syncAfterAppStateWrite(state);
    const db = await readScopedIntegrationOrdersDb({
      enabled: true,
      requestUrl: new URL("http://localhost/api/integration/orders?includeDone=1"),
      domainsRepository: createRepo([]),
      createDefaultIntegrationState,
      relationalOrdersHistoryReadEnabled: true,
      relationalRuntime: runtime,
    });

    assert.deepEqual(
      db.integration.orders.map((order) => order.id),
      ["rel_runtime"],
    );
  } finally {
    runtime.close();
  }
});

test("scoped orders read I1 torna al fallback se il relazionale fallisce", async () => {
  const calls = [];
  const warnings = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?station=BAR&includeDone=1"),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
    relationalOrdersHistoryReadEnabled: true,
    relationalOrdersRepository: {
      async listOrders() {
        throw new Error("sqlite locked");
      },
    },
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
  });

  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.equal(db.integration.orders[0].id, "00042");
  assert.equal(calls.some((entry) => entry.join(":") === "stationIndex:BAR:0"), true);
  assert.equal(warnings.some((message) => /relational integration\.orders fallback/i.test(message)), true);
});

test("scoped orders read resta spento per richieste con side-effect operativi", async () => {
  for (const query of ["currentSessionOnly=1", "includeDone=1&currentSessionOnly=1"]) {
    const calls = [];
    const db = await readScopedIntegrationOrdersDb({
      enabled: true,
      requestUrl: new URL(`http://localhost/api/integration/orders?${query}`),
      domainsRepository: createRepo(calls),
      createDefaultIntegrationState,
    });
    assert.equal(db, null, query);
    assert.equal(calls.length, 0, query);
  }
});

test("scoped orders read resta attivo per la vista postazione riconciliata async", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL("http://localhost/api/integration/orders?station=BAR&includeDone=1&includeTransferred=1"),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
  });

  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.equal(db.integration.orders[0].id, "00042");
  assert.deepEqual(
    calls.map((entry) => entry.join(":")),
    [
      "stationIndex:BAR:1",
      "entry:integration:tableGroups",
      "entry:integration:orderComps",
      "entry:integration:orderCorrections",
      "entry:integration:lastWriteAt",
      "domain:posSettings",
      "domain:menuItems",
      "domain:users",
    ],
  );
});

test("scoped orders read pre-limita lo storico postazione prima dello snapshot", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL(
      "http://localhost/api/integration/orders?station=BAR_LIMIT&includeDone=1&includeTransferred=1&doneHistoryLimit=2",
    ),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
  });

  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.deepEqual(
    db.integration.orders.map((order) => order.id),
    ["active", "recent_a", "recent_b"],
  );
});

test("scoped orders read non pre-limita quando si cerca una comanda specifica", async () => {
  const calls = [];
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl: new URL(
      "http://localhost/api/integration/orders?station=BAR_LIMIT&includeDone=1&includeTransferred=1&doneHistoryLimit=1&orderId=old",
    ),
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
  });

  assert.equal(db.__scopedReadOnly, "integration.orders");
  assert.deepEqual(
    db.integration.orders.map((order) => order.id),
    ["active", "old", "recent_a", "recent_b"],
  );
});

test("scoped orders read usa il default storico postazione quando il client non passa limite", async () => {
  const calls = [];
  const requestUrl = new URL(
    "http://localhost/api/integration/orders?station=BAR_DEFAULT&includeDone=1&includeTransferred=1",
  );
  const db = await readScopedIntegrationOrdersDb({
    enabled: true,
    requestUrl,
    domainsRepository: createRepo(calls),
    createDefaultIntegrationState,
  });

  const ids = db.integration.orders.map((order) => order.id);
  assert.equal(ids.length, 31);
  assert.equal(ids[0], "active_default");
  assert.equal(ids[1], "hist_06");
  assert.equal(ids.at(-1), "hist_35");
  assert.equal(requestUrl.searchParams.get("doneHistoryLimit"), "30");
});
