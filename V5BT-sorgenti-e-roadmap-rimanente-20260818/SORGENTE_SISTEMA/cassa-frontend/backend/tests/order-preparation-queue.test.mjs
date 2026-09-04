import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIntegrationOrderLookupIndex,
  findIntegrationOrderIndexByLookup,
} from "../modules/integration/order-lookup.domain.js";
import {
  applyPreparationQueuePromotionPlan,
  buildActivePreparationQueueLaneKeys,
  buildEmptyPreparationSelectionDemotionPlan,
  buildIntegrationOrderWorkflowApplyPlan,
  buildIntegrationOrderWorkflowSnapshotSource,
  buildIntegrationOrderQueueLaneKey,
  buildIntegrationOrderQueueOperatorKey,
  buildIntegrationStationStateQueueOperatorKey,
  buildIntegrationOrderSyncPreparationPlan,
  buildPreparationQueuePromotionRecord,
  buildPreparationQueueReconciliationApplyPlan,
  buildPreparationQueueReconciliationPlan,
  countPreparingIntegrationOrdersInLane,
  demoteEmptyPreparationOrdersForSelection,
  hasIntegrationOrderPreparationProgress,
  isIntegrationOrderOpenForPreparationQueue as orderOpenForPreparationQueue,
  isIntegrationOrderQueueLaneActive as orderQueueLaneActive,
  mergeIntegrationOrderWorkflowScopedOrders,
  normalizePreparationQueueOrders,
  resolveIntegrationOrderWorkflowTarget,
  resolveIntegrationOrderQueueStation,
  resolvePreparationPromotionActor,
  selectPreparationQueuePromotionIds,
} from "../modules/orders/order-preparation-queue.js";

const dependencies = {
  integrationOrderQueueLaneKey(order) {
    const station = String(order?.assignedStationId ?? order?.station ?? "").trim();
    const operator = String(order?.assignedStationOperatorUserId ?? "").trim();
    return station ? `${station}::${operator}` : "";
  },
  integrationStationStateQueueOperatorKey(stationState) {
    return String(stationState?.operatorUserId ?? stationState?.userId ?? stationState?.deviceUuid ?? "").trim();
  },
  normalizeOptionalIntegrationStationName(value) {
    return String(value ?? "").trim().toUpperCase();
  },
  getActiveStations(state, options = {}) {
    const stations = Array.isArray(state?.integration?.stationStates)
      ? state.integration.stationStates
      : [];
    return stations
      .filter((station) => station?.active !== false)
      .filter((station) => station?.stale !== true)
      .filter((station) => station?.realStation === true || (options.allowDemoStations === true && station?.isDemoFallback === true));
  },
  normalizeIntegrationWorkflowStatus(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "preparing" || raw === "in_preparation") return "prep";
    return raw || "waiting";
  },
  isIntegrationOrderOpenForPreparationQueue(order) {
    return orderOpenForPreparationQueue(order, {
      normalizeIntegrationWorkflowStatus: dependencies.normalizeIntegrationWorkflowStatus,
      roundMoney: (value) => Math.round(value * 100) / 100,
    });
  },
  isIntegrationOrderQueueLaneActive(order, activeQueue) {
    return orderQueueLaneActive(order, activeQueue, {
      integrationOrderQueueLaneKey: dependencies.integrationOrderQueueLaneKey,
      integrationOrderQueueOperatorKey(orderForKey) {
        return String(orderForKey?.assignedStationOperatorUserId ?? "").trim();
      },
      integrationOrderQueueStation(orderForKey) {
        return String(orderForKey?.assignedStationId ?? orderForKey?.station ?? "").trim();
      },
    });
  },
  nowIso() {
    return "2026-06-07T02:15:00.000Z";
  },
  sanitizeIntegrationOrder(entry, fallbackId) {
    return {
      id: String(entry?.id ?? fallbackId).trim(),
      workflowStatus: String(entry?.workflowStatus ?? "waiting").trim(),
      assignedStationId: String(entry?.assignedStationId ?? entry?.station ?? "").trim(),
      assignedStationOperatorUserId: String(entry?.assignedStationOperatorUserId ?? "").trim(),
      station: String(entry?.station ?? entry?.assignedStationId ?? "").trim(),
      paymentStatus: String(entry?.paymentStatus ?? "unpaid").trim(),
      dueAmount: Number(entry?.dueAmount ?? 1),
      receivedAtMs: Number(entry?.receivedAtMs ?? 0),
      items: Array.isArray(entry?.items) ? entry.items : [],
      lineRoutes: Array.isArray(entry?.lineRoutes) ? entry.lineRoutes : [],
    };
  },
};

const queueIdentityDependencies = {
  getStationOperatorAssignmentKey(payload) {
    return String(
      payload.assignedStationOperatorUserId ??
        payload.operatorUserId ??
        payload.assignedStationOperatorUsername ??
        payload.operatorUsername ??
        payload.assignedStationOperatorName ??
        payload.operatorName ??
        payload.assignedStationDeviceUuid ??
        payload.deviceUuid ??
        ""
    ).trim();
  },
  normalizeIntegrationStationName(value) {
    return String(value ?? "").trim().toUpperCase() || "MAIN";
  },
  normalizeOptionalIntegrationStationName(value) {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized || null;
  },
  primaryStation: "bar main",
};

test("buildIntegrationOrderWorkflowSnapshotSource normalizza sorgenti array, dbcache e read model", () => {
  const orders = [{ id: "001" }];
  assert.equal(buildIntegrationOrderWorkflowSnapshotSource(orders).sourceKind, "array");

  const dbSource = buildIntegrationOrderWorkflowSnapshotSource({ integration: { orders } });
  assert.equal(dbSource.sourceKind, "dbcache");
  assert.equal(dbSource.orderCount, 1);

  const readModelSource = buildIntegrationOrderWorkflowSnapshotSource({
    __scopedReadOnly: "integration.orders",
    integration: { orders },
  });
  assert.equal(readModelSource.sourceKind, "read-model");

  const explicit = buildIntegrationOrderWorkflowSnapshotSource(
    { orders },
    {
      sourceKind: "split-sqlite",
      externalized: true,
      generatedAt: "2026-07-04T17:55:00.000Z",
    }
  );
  assert.equal(explicit.sourceKind, "split-sqlite");
  assert.equal(explicit.externalized, true);
  assert.equal(explicit.generatedAt, "2026-07-04T17:55:00.000Z");
  assert.equal(buildIntegrationOrderWorkflowSnapshotSource({ orders, scoped: true }).scoped, true);
});

test("mergeIntegrationOrderWorkflowScopedOrders fonde snapshot parziali senza perdere altri ordini", () => {
  const merged = mergeIntegrationOrderWorkflowScopedOrders(
    [{ id: "001", workflowStatus: "waiting" }, { id: "002", workflowStatus: "waiting" }],
    [{ id: "002", workflowStatus: "prep" }, { id: "003", workflowStatus: "ready" }],
  );
  assert.deepEqual(merged.map((order) => `${order.id}:${order.workflowStatus}`), ["001:waiting", "002:prep", "003:ready"]);
});

test("mergeIntegrationOrderWorkflowScopedOrders riusa un indice lookup per snapshot scoped", () => {
  let indexBuilds = 0;
  const lookupIndexRefs = [];
  const merged = mergeIntegrationOrderWorkflowScopedOrders(
    [
      { id: "001", workflowStatus: "waiting" },
      { id: "00272", workflowStatus: "waiting" },
      { id: "ABC", workflowStatus: "waiting" },
    ],
    [
      { id: "272", workflowStatus: "prep" },
      { id: "ABC", workflowStatus: "ready" },
    ],
    {
      buildIntegrationOrderLookupIndex(orders) {
        indexBuilds += 1;
        return buildIntegrationOrderLookupIndex(orders);
      },
      findIntegrationOrderIndexByLookup(orders, lookupId, options = {}) {
        lookupIndexRefs.push(options.lookupIndex);
        return findIntegrationOrderIndexByLookup(orders, lookupId, options);
      },
    },
  );

  assert.equal(indexBuilds, 1);
  assert.equal(lookupIndexRefs.length, 2);
  assert.equal(lookupIndexRefs[0], lookupIndexRefs[1]);
  assert.deepEqual(merged.map((order) => `${order.id}:${order.workflowStatus}`), ["001:waiting", "272:prep", "ABC:ready"]);
});

test("mergeIntegrationOrderWorkflowScopedOrders fastScopedMerge evita indice globale e mantiene fallback lookup", () => {
  let indexBuilds = 0;
  let lookupCalls = 0;
  const merged = mergeIntegrationOrderWorkflowScopedOrders(
    [
      { id: "001", workflowStatus: "waiting" },
      { id: "00272", workflowStatus: "waiting" },
      { id: "ABC", workflowStatus: "waiting" },
    ],
    [
      { id: "ABC", workflowStatus: "ready" },
      { id: "272", workflowStatus: "prep" },
      { id: "404", workflowStatus: "waiting" },
    ],
    {
      fastScopedMerge: true,
      buildIntegrationOrderLookupIndex() {
        indexBuilds += 1;
        return null;
      },
      findIntegrationOrderIndexByLookup(orders, lookupId, options = {}) {
        lookupCalls += 1;
        assert.equal(options.lookupIndex, undefined);
        return findIntegrationOrderIndexByLookup(orders, lookupId, options);
      },
    },
  );

  assert.equal(indexBuilds, 0);
  assert.equal(lookupCalls, 2);
  assert.deepEqual(merged.map((order) => `${order.id}:${order.workflowStatus}`), ["001:waiting", "272:prep", "ABC:ready", "404:waiting"]);
});

test("mergeIntegrationOrderWorkflowScopedOrders fastScopedMerge usa hint ordinale verificato per id sequenziali", () => {
  let indexBuilds = 0;
  let lookupCalls = 0;
  const baseOrders = Array.from({ length: 3000 }, (_, index) => ({
    id: String(index + 1).padStart(5, "0"),
    workflowStatus: "waiting",
  }));
  const merged = mergeIntegrationOrderWorkflowScopedOrders(
    baseOrders,
    [{ id: "02353", workflowStatus: "ready" }],
    {
      fastScopedMerge: true,
      buildIntegrationOrderLookupIndex() {
        indexBuilds += 1;
        return null;
      },
      findIntegrationOrderIndexByLookup() {
        lookupCalls += 1;
        return -1;
      },
    },
  );

  assert.equal(indexBuilds, 0);
  assert.equal(lookupCalls, 0);
  assert.equal(merged[2352].workflowStatus, "ready");
  assert.equal(baseOrders[2352].workflowStatus, "waiting");
});

test("mergeIntegrationOrderWorkflowScopedOrders fastScopedMerge usa coda recente verificata se l'array non e ordinale", () => {
  let lookupCalls = 0;
  const baseOrders = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1).padStart(5, "0"),
    workflowStatus: "waiting",
  }));
  baseOrders[97] = { id: "02353", workflowStatus: "waiting" };
  const merged = mergeIntegrationOrderWorkflowScopedOrders(
    baseOrders,
    [{ id: "02353", workflowStatus: "ready" }],
    {
      fastScopedMerge: true,
      scopedMergeTailSize: 8,
      findIntegrationOrderIndexByLookup() {
        lookupCalls += 1;
        return -1;
      },
    },
  );

  assert.equal(lookupCalls, 0);
  assert.equal(merged[97].workflowStatus, "ready");
});

test("resolveIntegrationOrderWorkflowTarget risolve il target ordine da snapshot esplicito", () => {
  const orders = [
    { id: "001", lookupId: "alias-001", workflowStatus: "waiting" },
    { id: "002", workflowStatus: "prep" },
  ];
  const target = resolveIntegrationOrderWorkflowTarget({ orders }, "alias-001", {
    findIntegrationOrderIndexByLookup(sourceOrders, lookupId) {
      return sourceOrders.findIndex(
        (order) => order.id === lookupId || order.lookupId === lookupId
      );
    },
    sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
  });

  assert.equal(target.found, true);
  assert.equal(target.index, 0);
  assert.equal(target.sourceKind, "snapshot");
  assert.equal(target.order.id, "001");

  const missing = resolveIntegrationOrderWorkflowTarget({ orders }, "missing", {
    findIntegrationOrderIndexByLookup() {
      return -1;
    },
    sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
  });
  assert.equal(missing.found, false);
  assert.equal(missing.index, -1);
  assert.equal(missing.order, null);
});

test("buildIntegrationOrderWorkflowApplyPlan applica l'ordine aggiornato senza mutare lo snapshot", () => {
  const orders = [
    { id: "001", workflowStatus: "waiting", assignedStationId: "BAR 1" },
    { id: "002", workflowStatus: "prep", assignedStationId: "BAR 2" },
  ];
  const target = resolveIntegrationOrderWorkflowTarget({ orders }, "001", {
    sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
  });
  const plan = buildIntegrationOrderWorkflowApplyPlan(
    { orders },
    target,
    { ...target.order, workflowStatus: "ready" },
    { sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder }
  );

  assert.equal(plan.found, true);
  assert.equal(plan.index, 0);
  assert.equal(plan.sourceKind, "snapshot");
  assert.equal(plan.order.workflowStatus, "ready");
  assert.equal(plan.orders[0].workflowStatus, "ready");
  assert.equal(orders[0].workflowStatus, "waiting");

  const missingPlan = buildIntegrationOrderWorkflowApplyPlan(
    { orders },
    { index: 99, orderId: "missing" },
    { id: "missing", workflowStatus: "ready" },
    { sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder }
  );
  assert.equal(missingPlan.found, false);
  assert.equal(missingPlan.orders, orders);
});

test("hasIntegrationOrderPreparationProgress rileva item done e quantita parziale", () => {
  assert.equal(hasIntegrationOrderPreparationProgress({ items: [{ done: true }] }), true);
  assert.equal(hasIntegrationOrderPreparationProgress({ items: [{ doneQty: 1 }] }), true);
  assert.equal(hasIntegrationOrderPreparationProgress({ items: [{ doneQty: 0 }] }), false);
});

test("resolveIntegrationOrderQueueStation rispetta priorita e fallback primaria", () => {
  assert.equal(
    resolveIntegrationOrderQueueStation(
      {
        assignedStationId: " bar 1 ",
        ownerStation: "bar 2",
        lockedByStationId: "bar 3",
        station: "bar 4",
      },
      queueIdentityDependencies
    ),
    "BAR 1"
  );
  assert.equal(
    resolveIntegrationOrderQueueStation(
      {
        ownerStation: "bar 2",
        lockedByStationId: "bar 3",
        station: "bar 4",
      },
      queueIdentityDependencies
    ),
    "BAR 2"
  );
  assert.equal(resolveIntegrationOrderQueueStation({}, queueIdentityDependencies), "BAR MAIN");
});

test("operator key e lane key coda preparazione sono deterministici", () => {
  assert.equal(
    buildIntegrationOrderQueueOperatorKey(
      {
        assignedStationOperatorUserId: " roberto ",
        assignedStationOperatorUsername: "rb",
        assignedStationDeviceUuid: "dev-1",
      },
      queueIdentityDependencies
    ),
    "roberto"
  );
  assert.equal(
    buildIntegrationStationStateQueueOperatorKey(
      {
        operatorUsername: " chiara ",
        deviceUuid: "station-device",
      },
      queueIdentityDependencies
    ),
    "chiara"
  );
  assert.equal(
    buildIntegrationOrderQueueLaneKey(
      {
        assignedStationId: "bar 1",
        assignedStationOperatorUserId: "roberto",
      },
      queueIdentityDependencies
    ),
    "BAR 1::roberto"
  );
  assert.equal(buildIntegrationOrderQueueOperatorKey({}, {}), "");
  assert.equal(buildIntegrationStationStateQueueOperatorKey({}, {}), "");
});

test("resolvePreparationPromotionActor privilegia assegnazione e preserva ownerAtMs valido", () => {
  const actor = resolvePreparationPromotionActor(
    {
      assignedStationOperatorUserId: " roberto ",
      assignedStationOperatorUsername: " rb ",
      assignedStationOperatorName: " Roberto Bianchi ",
      ownerOperator: "Owner precedente",
      ownerRole: "Capo banco",
      ownerAtMs: 1234.9,
      lockedByUserId: " lock-user ",
    },
    {
      userId: "context-user",
      username: "context-name",
      ownerRole: "Operatore",
    },
    {
      nowMs: () => 9_999,
    }
  );

  assert.deepEqual(actor, {
    actorUserId: "roberto",
    actorUsername: "rb",
    lockedByUserId: "lock-user",
    ownerOperator: "Roberto Bianchi",
    ownerRole: "Capo banco",
    ownerAtMs: 1234,
  });
});

test("resolvePreparationPromotionActor usa context e fallback deterministici", () => {
  const actorFromContext = resolvePreparationPromotionActor(
    {
      createdByUserId: "created-user",
      createdByUsername: "created-name",
    },
    {
      userId: " context-user ",
      username: " context-name ",
      ownerRole: " Bar ",
    },
    {
      nowMs: () => 5_000,
    }
  );

  assert.deepEqual(actorFromContext, {
    actorUserId: "context-user",
    actorUsername: "context-name",
    lockedByUserId: "context-user",
    ownerOperator: "context-name",
    ownerRole: "Bar",
    ownerAtMs: 5000,
  });

  const actorFallback = resolvePreparationPromotionActor({}, {}, { nowMs: () => 7_000 });
  assert.equal(actorFallback.actorUserId, "");
  assert.equal(actorFallback.actorUsername, "");
  assert.equal(actorFallback.lockedByUserId, "");
  assert.equal(actorFallback.ownerOperator, "Operatore");
  assert.equal(actorFallback.ownerRole, "Operatore");
  assert.equal(actorFallback.ownerAtMs, 7000);
});

test("buildActivePreparationQueueLaneKeys costruisce lane e postazioni dalle postazioni attive", () => {
  const activeQueue = buildActivePreparationQueueLaneKeys(
    [
      {
        station: "bar 1",
        active: true,
        realStation: true,
        operatorUserId: "roberto",
      },
      {
        station: "bar 2",
        active: false,
        realStation: true,
        operatorUserId: "chiara",
      },
      {
        station: "bar demo",
        active: true,
        realStation: false,
        isDemoFallback: true,
        operatorUserId: "demo",
      },
    ],
    {
      allowDemoStations: true,
      getActiveStations: dependencies.getActiveStations,
      integrationStationStateQueueOperatorKey: dependencies.integrationStationStateQueueOperatorKey,
      normalizeOptionalIntegrationStationName: dependencies.normalizeOptionalIntegrationStationName,
    }
  );

  assert.deepEqual([...activeQueue.stations].sort(), ["BAR 1", "BAR DEMO"]);
  assert.deepEqual([...activeQueue.lanes].sort(), ["BAR 1::roberto", "BAR DEMO::demo"]);
});

test("buildActivePreparationQueueLaneKeys esclude demo non abilitate e fallback incompleti", () => {
  const activeQueue = buildActivePreparationQueueLaneKeys(
    [
      {
        station: "bar 1",
        active: true,
        realStation: true,
        deviceUuid: "station-device",
      },
      {
        station: "bar demo",
        active: true,
        realStation: false,
        isDemoFallback: true,
        operatorUserId: "demo",
      },
      {
        station: "",
        active: true,
        realStation: true,
        operatorUserId: "nobody",
      },
    ],
    {
      allowDemoStations: false,
      getActiveStations: dependencies.getActiveStations,
      integrationStationStateQueueOperatorKey: dependencies.integrationStationStateQueueOperatorKey,
      normalizeOptionalIntegrationStationName: dependencies.normalizeOptionalIntegrationStationName,
    }
  );

  assert.deepEqual([...activeQueue.stations], ["BAR 1"]);
  assert.deepEqual([...activeQueue.lanes], ["BAR 1::station-device"]);
  assert.equal(buildActivePreparationQueueLaneKeys([], {}).stations.size, 0);
  assert.equal(buildActivePreparationQueueLaneKeys(null, {}).lanes.size, 0);
});

test("countPreparingIntegrationOrdersInLane conta solo le prep della stessa lane", () => {
  const orders = [
    {
      id: "001",
      workflowStatus: "prep",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "002",
      workflowStatus: "preparing",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "003",
      workflowStatus: "waiting",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "004",
      workflowStatus: "prep",
      assignedStationId: "BAR 2",
      assignedStationOperatorUserId: "roberto",
    },
  ];

  assert.equal(
    countPreparingIntegrationOrdersInLane(
      { integration: { orders } },
      { assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
      {},
      dependencies
    ),
    2
  );
  assert.equal(
    countPreparingIntegrationOrdersInLane(
      { orders },
      { assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
      { excludeOrderId: "001" },
      dependencies
    ),
    1
  );
  assert.equal(
    countPreparingIntegrationOrdersInLane(
      orders,
      { assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
      {},
      dependencies
    ),
    2
  );
});

test("countPreparingIntegrationOrdersInLane torna zero se mancano dipendenze o lane", () => {
  assert.equal(countPreparingIntegrationOrdersInLane({}, {}, {}, dependencies), 0);
  assert.equal(
    countPreparingIntegrationOrdersInLane(
      { integration: { orders: [{ id: "001", workflowStatus: "prep" }] } },
      {},
      {},
      dependencies
    ),
    0
  );
  assert.equal(
    countPreparingIntegrationOrdersInLane(
      { integration: { orders: [{ id: "001", workflowStatus: "prep" }] } },
      { assignedStationId: "BAR 1" },
      {}
    ),
    0
  );
});

test("isIntegrationOrderOpenForPreparationQueue considera solo ordini waiting/prep non pagati con residuo", () => {
  const base = {
    workflowStatus: "waiting",
    paymentStatus: "unpaid",
    dueAmount: 1,
  };
  const adapter = {
    normalizeIntegrationWorkflowStatus: dependencies.normalizeIntegrationWorkflowStatus,
    roundMoney: (value) => Math.round(value * 100) / 100,
  };

  assert.equal(orderOpenForPreparationQueue(base, adapter), true);
  assert.equal(orderOpenForPreparationQueue({ ...base, workflowStatus: "prep" }, adapter), true);
  assert.equal(orderOpenForPreparationQueue({ ...base, workflowStatus: "ready" }, adapter), false);
  assert.equal(orderOpenForPreparationQueue({ ...base, paymentStatus: "paid" }, adapter), false);
  assert.equal(orderOpenForPreparationQueue({ ...base, dueAmount: 0 }, adapter), false);
  assert.equal(orderOpenForPreparationQueue(base), false);
});

test("isIntegrationOrderQueueLaneActive richiede postazione attiva e lane operatore quando presente", () => {
  const adapter = {
    integrationOrderQueueLaneKey: dependencies.integrationOrderQueueLaneKey,
    integrationOrderQueueOperatorKey(order) {
      return String(order?.assignedStationOperatorUserId ?? "").trim();
    },
    integrationOrderQueueStation(order) {
      return String(order?.assignedStationId ?? order?.station ?? "").trim();
    },
  };
  const activeQueue = {
    stations: new Set(["BAR 1", "BAR 2"]),
    lanes: new Set(["BAR 1::roberto"]),
  };

  assert.equal(
    orderQueueLaneActive(
      { assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
      activeQueue,
      adapter
    ),
    true
  );
  assert.equal(
    orderQueueLaneActive(
      { assignedStationId: "BAR 1", assignedStationOperatorUserId: "chiara" },
      activeQueue,
      adapter
    ),
    false
  );
  assert.equal(
    orderQueueLaneActive({ assignedStationId: "BAR 2" }, activeQueue, adapter),
    true
  );
  assert.equal(
    orderQueueLaneActive({ assignedStationId: "BAR 3" }, activeQueue, adapter),
    false
  );
  assert.equal(orderQueueLaneActive({ assignedStationId: "BAR 1" }, activeQueue), false);
});

test("buildEmptyPreparationSelectionDemotionPlan retrocede solo prep vuote della stessa lane", () => {
  const orders = [
    {
      id: "001",
      workflowStatus: "prep",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
      lineRoutes: [{ id: "route-1", receivedAt: "x", receivedByUserId: "u1" }],
      items: [],
    },
    {
      id: "002",
      workflowStatus: "prep",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
      items: [{ doneQty: 1 }],
    },
    {
      id: "003",
      workflowStatus: "prep",
      assignedStationId: "BAR 2",
      assignedStationOperatorUserId: "roberto",
      items: [],
    },
  ];

  const plan = buildEmptyPreparationSelectionDemotionPlan(
    orders,
    { id: "999", assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
    dependencies
  );

  assert.equal(plan.demotions.length, 1);
  assert.equal(plan.demotions[0].orderId, "001");
  assert.equal(plan.orders[0].workflowStatus, "waiting");
  assert.equal(plan.orders[0].lineRoutes[0].receivedAt, undefined);
  assert.equal(plan.orders[1].workflowStatus, "prep");
  assert.equal(plan.orders[2].workflowStatus, "prep");
  assert.equal(orders[0].workflowStatus, "prep");

  const objectPlan = buildEmptyPreparationSelectionDemotionPlan(
    { orders },
    { id: "999", assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
    dependencies
  );
  assert.deepEqual(objectPlan.demotions.map((entry) => entry.orderId), ["001"]);
});

test("demoteEmptyPreparationOrdersForSelection mantiene il wrapper compatibile con db", () => {
  const db = {
    integration: {
      orders: [
        {
          id: "001",
          workflowStatus: "prep",
          assignedStationId: "BAR 1",
          assignedStationOperatorUserId: "roberto",
          lineRoutes: [{ id: "route-1", receivedAt: "x", receivedByUserId: "u1" }],
          items: [],
        },
      ],
    },
  };

  const demotions = demoteEmptyPreparationOrdersForSelection(
    db,
    { id: "999", assignedStationId: "BAR 1", assignedStationOperatorUserId: "roberto" },
    dependencies
  );

  assert.equal(demotions.length, 1);
  assert.equal(demotions[0].orderId, "001");
  assert.equal(db.integration.orders[0].workflowStatus, "waiting");
  assert.equal(db.integration.orders[0].lineRoutes[0].receivedAt, undefined);
});

test("buildIntegrationOrderSyncPreparationPlan calcola handoff e limite coda da snapshot", () => {
  const orders = [
    {
      id: "001",
      workflowStatus: "prep",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
      lineRoutes: [{ id: "route-1", receivedAt: "x" }],
      items: [],
    },
    {
      id: "002",
      workflowStatus: "prep",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
      items: [{ doneQty: 1 }],
    },
    {
      id: "003",
      workflowStatus: "prep",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
      items: [{ doneQty: 2 }],
    },
    {
      id: "999",
      workflowStatus: "waiting",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
      items: [],
    },
  ];

  const plan = buildIntegrationOrderSyncPreparationPlan(
    { orders },
    orders[3],
    { ...orders[3], workflowStatus: "prep" },
    {
      workflowSyncReason: "selected_order",
      selectionReasons: new Set(["selected_order"]),
      maxPreparingOrdersPerLane: 2,
      excludeOrderId: "999",
    },
    dependencies
  );

  assert.equal(plan.currentWorkflow, "waiting");
  assert.equal(plan.nextWorkflow, "prep");
  assert.equal(plan.entersPreparation, true);
  assert.equal(plan.usedSelectionDemotionPlan, true);
  assert.equal(plan.snapshotSourceKind, "snapshot");
  assert.deepEqual(plan.selectionHandoffDemotions.map((entry) => entry.orderId), ["001"]);
  assert.equal(plan.orders[0].workflowStatus, "waiting");
  assert.equal(plan.orders[0].lineRoutes[0].receivedAt, undefined);
  assert.equal(plan.preparingInLane, 2);
  assert.equal(plan.preparationQueueFull, true);
  assert.equal(orders[0].workflowStatus, "prep");
});

test("buildIntegrationOrderSyncPreparationPlan resta no-op fuori ingresso prep", () => {
  const plan = buildIntegrationOrderSyncPreparationPlan(
    [{ id: "001", workflowStatus: "waiting", assignedStationId: "BAR 1" }],
    { id: "001", workflowStatus: "waiting", assignedStationId: "BAR 1" },
    { id: "001", workflowStatus: "ready", assignedStationId: "BAR 1" },
    {
      workflowSyncReason: "selected_order",
      selectionReasons: new Set(["selected_order"]),
      maxPreparingOrdersPerLane: 1,
    },
    dependencies
  );

  assert.equal(plan.currentWorkflow, "waiting");
  assert.equal(plan.nextWorkflow, "ready");
  assert.equal(plan.entersPreparation, false);
  assert.equal(plan.usedSelectionDemotionPlan, false);
  assert.deepEqual(plan.selectionHandoffDemotions, []);
  assert.equal(plan.preparingInLane, 0);
  assert.equal(plan.preparationQueueFull, false);
});

test("buildIntegrationOrderSyncPreparationPlan salta il piano profondo se workflow canonico invariato", () => {
  let normalizeCalls = 0;
  const plan = buildIntegrationOrderSyncPreparationPlan(
    [{ id: "001", workflowStatus: "prep", assignedStationId: "BAR 1" }],
    { id: "001", workflowStatus: "prep", assignedStationId: "BAR 1" },
    { id: "001", workflowStatus: "prep", assignedStationId: "BAR 1" },
    {
      workflowSyncReason: "mp4_order_worker_sync_e2e_canary",
      selectionReasons: new Set(["selected_order"]),
      maxPreparingOrdersPerLane: 3,
    },
    {
      ...dependencies,
      normalizeIntegrationWorkflowStatus() {
        normalizeCalls += 1;
        return "prep";
      },
    }
  );

  assert.equal(plan.currentWorkflow, "prep");
  assert.equal(plan.nextWorkflow, "prep");
  assert.equal(plan.fastNoop, true);
  assert.equal(plan.entersPreparation, false);
  assert.equal(plan.usedSelectionDemotionPlan, false);
  assert.deepEqual(plan.selectionHandoffDemotions, []);
  assert.equal(plan.preparingInLane, 0);
  assert.equal(plan.maxPreparingOrdersPerLane, 3);
  assert.equal(normalizeCalls, 0);
});

test("buildIntegrationOrderSyncPreparationPlan considera prep veloce uno stato aperto con ownerStation", () => {
  let normalizeCalls = 0;
  const plan = buildIntegrationOrderSyncPreparationPlan(
    [{ id: "001", workflowStatus: "waiting", ownerStation: "BAR 1" }],
    { id: "001", workflowStatus: "waiting", ownerStation: "BAR 1" },
    { id: "001", workflowStatus: "prep", ownerStation: "BAR 1" },
    {
      workflowSyncReason: "mp4_order_worker_sync_e2e_canary",
      selectionReasons: new Set(["selected_order"]),
      maxPreparingOrdersPerLane: 3,
    },
    {
      ...dependencies,
      normalizeIntegrationWorkflowStatus() {
        normalizeCalls += 1;
        return "prep";
      },
    }
  );

  assert.equal(plan.currentWorkflow, "prep");
  assert.equal(plan.nextWorkflow, "prep");
  assert.equal(plan.fastNoop, true);
  assert.equal(plan.entersPreparation, false);
  assert.equal(plan.preparingInLane, 0);
  assert.equal(normalizeCalls, 0);
});

test("selectPreparationQueuePromotionIds promuove il waiting piu vecchio per lane senza prep", () => {
  const orders = [
    {
      id: "003",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 300,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "001",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 100,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "002",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 100,
      assignedStationId: "BAR 2",
      assignedStationOperatorUserId: "chiara",
    },
  ];

  assert.deepEqual(
    selectPreparationQueuePromotionIds(
      orders,
      {
        stations: new Set(["BAR 1", "BAR 2"]),
        lanes: new Set(["BAR 1::roberto", "BAR 2::chiara"]),
      },
      dependencies
    ),
    ["001", "002"]
  );
});

test("selectPreparationQueuePromotionIds non promuove lane con prep o non attive", () => {
  const orders = [
    {
      id: "001",
      workflowStatus: "prep",
      dueAmount: 1,
      receivedAtMs: 100,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "002",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 110,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "003",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 120,
      assignedStationId: "BAR 2",
      assignedStationOperatorUserId: "chiara",
    },
    {
      id: "004",
      workflowStatus: "waiting",
      paymentStatus: "paid",
      dueAmount: 8,
      receivedAtMs: 90,
      assignedStationId: "BAR 3",
      assignedStationOperatorUserId: "giada",
    },
  ];

  assert.deepEqual(
    selectPreparationQueuePromotionIds(
      orders,
      {
        stations: new Set(["BAR 1", "BAR 3"]),
        lanes: new Set(["BAR 1::roberto", "BAR 3::giada"]),
      },
      dependencies
    ),
    []
  );
});

test("buildPreparationQueuePromotionRecord normalizza il record di promozione", () => {
  const promoted = buildPreparationQueuePromotionRecord(
    {
      id: " 001 ",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: " roberto ",
      assignedStationOperatorUsername: " rb ",
      assignedStationOperatorName: " Roberto ",
    },
    {
      integrationOrderQueueStation(order) {
        return String(order?.assignedStationId ?? "").trim();
      },
    }
  );

  assert.deepEqual(promoted, {
    orderId: "001",
    station: "BAR 1",
    operatorUserId: "roberto",
    operatorUsername: "rb",
    operatorName: "Roberto",
  });
  assert.equal(buildPreparationQueuePromotionRecord({ id: "001" }), null);
  assert.equal(
    buildPreparationQueuePromotionRecord(
      {},
      {
        integrationOrderQueueStation() {
          return "BAR 1";
        },
      }
    ),
    null
  );
});

test("normalizePreparationQueueOrders applica sanitize e fallback id deterministici", () => {
  const normalized = normalizePreparationQueueOrders(
    [
      {
        id: " ORD-1 ",
        workflowStatus: "prep",
        assignedStationId: "BAR 1",
      },
      {
        workflowStatus: "waiting",
        assignedStationId: "BAR 2",
      },
    ],
    {
      sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
    }
  );

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].id, "ORD-1");
  assert.equal(normalized[1].id, "00002");
  assert.equal(normalized[1].assignedStationId, "BAR 2");
  assert.deepEqual(normalizePreparationQueueOrders(null, { sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder }), []);
  assert.deepEqual(normalizePreparationQueueOrders([{ id: "001" }], {}), []);
});

test("buildPreparationQueueReconciliationPlan normalizza ordini e seleziona promozioni", () => {
  const orders = [
    {
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 200,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "ORD-2",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 100,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "ORD-3",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 100,
      assignedStationId: "BAR 2",
      assignedStationOperatorUserId: "chiara",
    },
  ];
  const plan = buildPreparationQueueReconciliationPlan(
    { orders },
    {
      stations: new Set(["BAR 1", "BAR 2"]),
      lanes: new Set(["BAR 1::roberto", "BAR 2::chiara"]),
    },
    {
      ...dependencies,
      sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
    }
  );

  assert.equal(plan.orders.length, 3);
  assert.equal(plan.orders[0].id, "00001");
  assert.deepEqual(plan.promoteIds, ["ORD-2", "ORD-3"]);

  const arrayPlan = buildPreparationQueueReconciliationPlan(
    orders,
    {
      stations: new Set(["BAR 1"]),
      lanes: new Set(["BAR 1::roberto"]),
    },
    {
      ...dependencies,
      sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
    }
  );
  assert.deepEqual(arrayPlan.promoteIds, ["ORD-2"]);
});

test("buildPreparationQueueReconciliationPlan torna piano vuoto con input non valido", () => {
  assert.deepEqual(buildPreparationQueueReconciliationPlan(null, {}, dependencies), {
    orders: [],
    promoteIds: [],
  });
  assert.deepEqual(buildPreparationQueueReconciliationPlan([{ id: "001" }], {}, {}), {
    orders: [],
    promoteIds: [],
  });
});

test("applyPreparationQueuePromotionPlan applica promozioni e record in modo puro", () => {
  const orders = [
    {
      id: "001",
      workflowStatus: "waiting",
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "002",
      workflowStatus: "waiting",
      assignedStationId: "BAR 2",
      assignedStationOperatorUserId: "chiara",
    },
  ];
  const result = applyPreparationQueuePromotionPlan(
    orders,
    new Set(["001"]),
    {
      promoteOrder(order) {
        return {
          ...order,
          workflowStatus: "prep",
          preparationStartedAt: "2026-06-07T04:05:00.000Z",
        };
      },
      buildPromotionRecord(order) {
        return {
          orderId: order.id,
          station: order.assignedStationId,
        };
      },
    }
  );

  assert.equal(result.orders[0].workflowStatus, "prep");
  assert.equal(result.orders[1], orders[1]);
  assert.deepEqual(result.promoted, [{ orderId: "001", station: "BAR 1" }]);
  assert.equal(orders[0].workflowStatus, "waiting");
});

test("buildPreparationQueueReconciliationApplyPlan compone selezione e promozione da snapshot", () => {
  const orders = [
    {
      id: "001",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 200,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
    {
      id: "002",
      workflowStatus: "waiting",
      dueAmount: 1,
      receivedAtMs: 100,
      assignedStationId: "BAR 1",
      assignedStationOperatorUserId: "roberto",
    },
  ];

  const plan = buildPreparationQueueReconciliationApplyPlan(
    { orders },
    {
      stations: new Set(["BAR 1"]),
      lanes: new Set(["BAR 1::roberto"]),
    },
    {
      ...dependencies,
      sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
      promoteOrder(order) {
        return {
          ...order,
          workflowStatus: "prep",
          lockStatus: "locked",
        };
      },
      buildPromotionRecord(order) {
        return {
          orderId: order.id,
          station: order.assignedStationId,
        };
      },
    }
  );

  assert.equal(plan.changed, true);
  assert.deepEqual(plan.promoteIds, ["002"]);
  assert.deepEqual(plan.promoted, [{ orderId: "002", station: "BAR 1" }]);
  assert.equal(plan.orders[0].workflowStatus, "waiting");
  assert.equal(plan.orders[1].workflowStatus, "prep");
  assert.equal(orders[1].workflowStatus, "waiting");
});

test("buildPreparationQueueReconciliationApplyPlan resta no-op senza promozioni", () => {
  const plan = buildPreparationQueueReconciliationApplyPlan(
    [
      {
        id: "001",
        workflowStatus: "prep",
        dueAmount: 1,
        assignedStationId: "BAR 1",
        assignedStationOperatorUserId: "roberto",
      },
      {
        id: "002",
        workflowStatus: "waiting",
        dueAmount: 1,
        assignedStationId: "BAR 1",
        assignedStationOperatorUserId: "roberto",
      },
    ],
    {
      stations: new Set(["BAR 1"]),
      lanes: new Set(["BAR 1::roberto"]),
    },
    {
      ...dependencies,
      sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
      promoteOrder(order) {
        return { ...order, workflowStatus: "prep" };
      },
    }
  );

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.promoteIds, []);
  assert.deepEqual(plan.promoted, []);
  assert.equal(plan.orders.length, 2);
});

test("applyPreparationQueuePromotionPlan non promuove senza ids o adapter", () => {
  const orders = [{ id: "001", workflowStatus: "waiting" }];

  assert.deepEqual(applyPreparationQueuePromotionPlan(null, ["001"], {}).orders, []);
  assert.deepEqual(applyPreparationQueuePromotionPlan(orders, [], {}).promoted, []);
  assert.deepEqual(applyPreparationQueuePromotionPlan(orders, ["001"], {}).orders, orders);
});

test("applyPreparationQueuePromotionPlan mantiene ordine originale se promoteOrder fallisce", () => {
  const order = { id: "001", workflowStatus: "waiting" };
  const result = applyPreparationQueuePromotionPlan(
    [order],
    ["001"],
    {
      promoteOrder() {
        return null;
      },
      buildPromotionRecord() {
        return { orderId: "001" };
      },
    }
  );

  assert.equal(result.orders[0], order);
  assert.deepEqual(result.promoted, []);
});
