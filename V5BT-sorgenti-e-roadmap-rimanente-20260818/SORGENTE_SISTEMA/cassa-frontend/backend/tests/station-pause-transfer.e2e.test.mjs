import assert from "node:assert/strict";
import test from "node:test";
import {
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { filterStationPauseTransferDestinations } from "../modules/integration/station-pause-transfer.js";

const REAL_BAR_STATION = "BAR-1";

async function postStationState(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/integration/stations/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function selectWorkstation(baseUrl, session, deviceUuid, workstationId, expectedStatus = 200) {
  const result = await apiPost(
    baseUrl,
    "/api/auth/workstation/select",
    authPayload(session, deviceUuid, {
      clientApp: "postazione",
      workstationId,
    }),
  );
  assert.equal(result.response.status, expectedStatus);
  return result.body;
}

function buildStation(overrides = {}) {
  return {
    station: REAL_BAR_STATION,
    active: true,
    autoPrintOrders: false,
    autoPrintPreconto: false,
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    clientApp: "postazione",
    updatedAtMs: Date.now(),
    realStation: true,
    isDemoFallback: false,
    stale: false,
    ...overrides,
  };
}

function buildOrder(overrides = {}) {
  return {
    id: "00081",
    number: "00081",
    tableId: "room_pedana_t05",
    tableNumber: "5",
    roomId: "room_pedana",
    roomName: "Pedana",
    station: REAL_BAR_STATION,
    assignedStationId: REAL_BAR_STATION,
    assignedStationOperatorUserId: "u_cashier",
    assignedStationOperatorUsername: "cashier",
    assignedStationOperatorName: "Cashier Test",
    assignedStationDeviceUuid: "station-a",
    assignedStationClientApp: "postazione",
    assignmentReason: "auto",
    assignmentStatus: "assigned",
    workflowStatus: "waiting",
    paymentStatus: "unpaid",
    total: 5,
    dueAmount: 5,
    items: [
      {
        id: "line_1",
        lineId: "line_1",
        productId: "test_prodotto",
        name: "Prodotto test",
        quantity: 1,
        price: 5,
        unitPrice: 5,
        routeStations: [REAL_BAR_STATION],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("filtro trasferimento pausa mostra solo postazioni reali attive e non in pausa", () => {
  const candidates = filterStationPauseTransferDestinations(
    [
      buildStation({
        station: "BAR-2",
        operatorUserId: "u_manager",
        operatorUsername: "manager",
        operatorName: "Manager Test",
        deviceUuid: "station-b",
      }),
      buildStation({ station: "BAR-3", operatorUserId: "u_paused", onPause: true }),
      buildStation({ station: "BAR-4", operatorUserId: "u_offline", active: false }),
      buildStation({ station: "BAR-5", operatorUserId: "u_stale", stale: true }),
      buildStation({
        station: "BAR-6",
        realStation: false,
        isDemoFallback: true,
        operatorUserId: "u_demo",
      }),
      buildStation({
        station: "BAR-7",
        configuredStation: true,
        realStation: false,
        operatorUserId: "",
        operatorUsername: "",
        operatorName: "Guest",
        deviceUuid: "",
      }),
      buildStation({
        station: "BAR-8",
        operatorUserId: "",
        operatorUsername: "",
        operatorName: "Guest",
        operatorRole: "Non autenticato",
        deviceUuid: "station-device-only",
      }),
      buildStation({
        station: "BAR-9",
        operatorUserId: "",
        operatorUsername: "",
        operatorName: "Manager non loggato",
        operatorRole: "Operatore",
        deviceUuid: "station-name-only",
      }),
    ],
    buildStation()
  );

  assert.deepEqual(
    candidates.map((entry) => entry.station),
    ["BAR-2"]
  );
});

test("heartbeat identico della postazione non rientra nel percorso mutativo completo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.integration.stationStates = [];
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
      ];
    },
  });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "station-fast-heartbeat",
    clientApp: "postazione",
    station: REAL_BAR_STATION,
  });
  await selectWorkstation(baseUrl, session, "station-fast-heartbeat", "workstation_bar_1");
  const payload = {
    token: session.token,
    userId: session.user.id,
    station: REAL_BAR_STATION,
    active: true,
    clientApp: "postazione",
    deviceUuid: "station-fast-heartbeat",
  };

  const first = await postStationState(baseUrl, payload);
  assert.equal(first.heartbeatOnly, true);
  const before = await readJson(dbPath);
  const beforeLastWriteAt = before.meta.lastWriteAt;

  const second = await postStationState(baseUrl, payload);
  assert.equal(second.heartbeatOnly, true);
  const after = await readJson(dbPath);
  assert.equal(after.meta.lastWriteAt, beforeLastWriteAt);
});

test("heartbeat postazione con sessione da rinnovare persiste lastSeenAt", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      INTEGRATION_STATION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "600000",
      SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "1",
    },
    stateOverrides(state) {
      state.integration.stationStates = [];
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
      ];
    },
  });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "station-session-heartbeat",
    clientApp: "postazione",
    station: REAL_BAR_STATION,
  });
  await selectWorkstation(baseUrl, session, "station-session-heartbeat", "workstation_bar_1");
  const payload = {
    token: session.token,
    userId: session.user.id,
    station: REAL_BAR_STATION,
    active: true,
    clientApp: "postazione",
    deviceUuid: "station-session-heartbeat",
  };

  await postStationState(baseUrl, payload);
  const before = await readJson(dbPath);
  const beforeSession = before.sessions.find((entry) => entry.userId === session.user.id);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await postStationState(baseUrl, payload);
  assert.equal(second.heartbeatOnly, undefined);
  const after = await readJson(dbPath);
  const afterSession = after.sessions.find((entry) => entry.userId === session.user.id);
  assert.notEqual(String(afterSession?.lastSeenAt ?? ""), String(beforeSession?.lastSeenAt ?? ""));
});

test("scrittura stato postazione usa la lane dedicata e non la coda globale", async (t) => {
  const deviceUuid = "station-lane-device";
  const { baseUrl } = await startBackend(t, {
    env: { RUNTIME_METRICS: "1", STATION_STATE_FAST_PATH_ENABLED: "0" },
    stateOverrides(state) {
      state.integration.stationStates = [];
      state.posSettings.workstations = [{ id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true }];
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", { deviceUuid, clientApp: "postazione" });
  await selectWorkstation(baseUrl, session, deviceUuid, "workstation_bar_1");
  const reset = await fetch(`${baseUrl}/api/monitor/runtime-metrics/reset`, { method: "POST", headers: authHeaders(session, deviceUuid), body: JSON.stringify({}) });
  assert.equal(reset.status, 200);

  await postStationState(baseUrl, { token: session.token, userId: session.user.id, station: REAL_BAR_STATION, active: true, clientApp: "postazione", deviceUuid });

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, { headers: authHeaders(session, deviceUuid) });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.stationStateLaneEnqueued, 1);
  assert.equal(metrics.runtimeMetrics.counters.dbMutationEnqueued, 0);
});

test("pausa postazione trasferisce solo la coda dell'operatore offline verso una postazione reale attiva", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", enabled: true },
        { id: "workstation_bar_3", name: "BAR-3", stationName: "BAR-3", enabled: true },
      ];
      state.integration.stationStates = [
        buildStation(),
        buildStation({
          operatorUserId: "u_manager",
          operatorUsername: "manager",
          operatorName: "Manager Test",
          deviceUuid: "station-b",
        }),
      ];
      state.integration.orders = [buildOrder()];
    },
  });

  const response = await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    pauseTransferMode: "transfer",
  });

  assert.equal(response.rebalancedOrders?.length, 1);
  assert.equal(response.rebalancedOrders[0].orderId, "00081");
  assert.equal(response.rebalancedOrders[0].operatorUserId, "u_manager");
  assert.equal(response.suspendedOrders, undefined);

  const db = await readJson(dbPath);
  const order = db.integration.orders.find((entry) => entry.id === "00081");
  assert.equal(order.assignedStationId, REAL_BAR_STATION);
  assert.equal(order.assignedStationOperatorUserId, "u_manager");
  assert.equal(order.assignedStationDeviceUuid, "station-b");
  assert.equal(order.assignmentReason, "pause_redistribution");
  assert.equal(order.assignmentStatus, "assigned");
});

test("pausa postazione trasferisce la coda verso la postazione scelta dall'operatore", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", enabled: true },
        { id: "workstation_bar_3", name: "BAR-3", stationName: "BAR-3", enabled: true },
      ];
      state.integration.stationStates = [
        buildStation(),
        buildStation({
          station: "BAR-2",
          operatorUserId: "u_manager",
          operatorUsername: "manager",
          operatorName: "Manager Test",
          deviceUuid: "station-b",
        }),
        buildStation({
          station: "BAR-3",
          operatorUserId: "u_backup",
          operatorUsername: "backup",
          operatorName: "Backup Test",
          deviceUuid: "station-c",
        }),
      ];
      state.integration.orders = [buildOrder({ id: "00084", number: "00084" })];
    },
  });

  const response = await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    pauseTransferMode: "transfer",
    pauseTransferTargetStation: "BAR-3",
  });

  assert.equal(response.rebalancedOrders?.length, 1);
  assert.equal(response.rebalancedOrders[0].orderId, "00084");
  assert.equal(response.rebalancedOrders[0].toStation, "BAR-3");
  assert.equal(response.rebalancedOrders[0].operatorUserId, "u_backup");

  const db = await readJson(dbPath);
  const order = db.integration.orders.find((entry) => entry.id === "00084");
  assert.equal(order.assignedStationId, "BAR-3");
  assert.equal(order.assignedStationOperatorUserId, "u_backup");
  assert.equal(order.assignedStationDeviceUuid, "station-c");
});

test("pausa postazione senza destinazioni parcheggia la comanda nella coda virtuale", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.integration.stationStates = [buildStation()];
      state.integration.orders = [buildOrder({ id: "00082", number: "00082" })];
    },
  });

  const response = await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    transferOrders: true,
  });

  assert.equal(response.rebalancedOrders, undefined);
  assert.equal(response.parkedOrders?.length, 1);
  assert.equal(response.parkedOrders[0].orderId, "00082");

  const db = await readJson(dbPath);
  const order = db.integration.orders.find((entry) => entry.id === "00082");
  assert.equal(order.assignedStationId, null);
  assert.equal(order.assignedStationOperatorUserId, "");
  assert.equal(order.assignedStationDeviceUuid, "");
  assert.equal(order.assignmentReason, "pause_virtual_queue");
  assert.equal(order.assignmentStatus, "queued_unassigned");
  assert.equal(order.assignmentReasonDetail, "station_pause_virtual_queue");

  const stationOrdersResponse = await fetch(
    `${baseUrl}/api/integration/orders?station=${encodeURIComponent(REAL_BAR_STATION)}&fresh=1`,
  );
  assert.equal(stationOrdersResponse.status, 200);
  const stationOrders = await stationOrdersResponse.json();
  assert.equal(stationOrders.orders.some((entry) => entry.id === "00082"), false);
});

test("pausa postazione non trasferisce verso postazioni accese ma senza utente loggato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", enabled: true },
      ];
      state.integration.stationStates = [
        buildStation(),
        buildStation({
          station: "BAR-2",
          operatorUserId: "",
          operatorUsername: "",
          operatorName: "Guest",
          operatorRole: "Non autenticato",
          deviceUuid: "station-b",
        }),
      ];
      state.integration.orders = [buildOrder({ id: "00085", number: "00085" })];
    },
  });

  const response = await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    transferOrders: true,
  });

  assert.equal(response.rebalancedOrders, undefined);
  assert.equal(response.availableTransferStations, undefined);
  assert.equal(response.parkedOrders?.length, 1);

  const db = await readJson(dbPath);
  const order = db.integration.orders.find((entry) => entry.id === "00085");
  assert.equal(order.assignedStationId, null);
  assert.equal(order.assignedStationOperatorUserId, "");
  assert.equal(order.assignedStationDeviceUuid, "");
  assert.equal(order.assignmentReason, "pause_virtual_queue");
  assert.equal(order.assignmentStatus, "queued_unassigned");
});

test("coda virtuale viene assegnata quando torna una postazione compatibile", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", enabled: true },
      ];
      state.integration.stationStates = [buildStation()];
      const queuedOrder = buildOrder({
        id: "00086",
        number: "00086",
        workflowStatus: "prep",
        ownerStation: REAL_BAR_STATION,
        ownerOperator: "Cashier Test",
        ownerRole: "Operatore",
        ownerAtMs: Date.now(),
        preparationStartedAt: new Date().toISOString(),
        lockedByStationId: REAL_BAR_STATION,
        lockedByUserId: "u_cashier",
        lockedAt: new Date().toISOString(),
        lockStatus: "locked",
      });
      queuedOrder.items[0].routeStations = [REAL_BAR_STATION, "BAR-2"];
      state.integration.orders = [queuedOrder];
    },
  });

  const paused = await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    pauseTransferMode: "suspend",
  });
  assert.equal(paused.parkedOrders?.length, 1);
  const parkedDb = await readJson(dbPath);
  const parkedOrder = parkedDb.integration.orders.find((entry) => entry.id === "00086");
  assert.equal(parkedOrder.workflowStatus, "waiting");
  assert.equal(parkedOrder.assignedStationId, null);
  assert.equal(parkedOrder.assignmentStatus, "queued_unassigned");
  assert.equal(parkedOrder.lockStatus, "unlocked");
  assert.equal(parkedOrder.lockedByStationId, null);
  assert.equal(parkedOrder.preparationStartedAt, null);

  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "station-b",
    clientApp: "postazione",
  });
  await selectWorkstation(baseUrl, manager, "station-b", "workstation_bar_2");
  const resumed = await postStationState(baseUrl, {
    station: "BAR-2",
    active: true,
    clientApp: "postazione",
    token: manager.token,
    userId: manager.user.id,
    deviceUuid: "station-b",
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.heartbeatOnly, true);
  const reconciled = await fetch(
    `${baseUrl}/api/integration/orders?station=${encodeURIComponent("BAR-2")}&fresh=1`,
  );
  assert.equal(reconciled.status, 200);

  let order = null;
  const reconciliationDeadline = Date.now() + 2_000;
  do {
    const db = await readJson(dbPath);
    order = db.integration.orders.find((entry) => entry.id === "00086");
    if (order?.assignedStationId === "BAR-2") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < reconciliationDeadline);
  assert.equal(order?.station, "BAR-2");
  assert.equal(order.assignedStationId, "BAR-2");
  assert.equal(order.assignedStationOperatorUserId, manager.user.id);
  assert.equal(order.assignmentStatus, "assigned");
  assert.deepEqual(order.items[0].routeStations, ["BAR-2"]);
});

test("destinazione scelta ma inattiva degrada in coda virtuale senza trasferimento forzato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_pizza", name: "PIZZA IN RIVA", stationName: "PIZZA IN RIVA", enabled: true },
      ];
      state.integration.stationStates = [buildStation()];
      state.integration.orders = [buildOrder({ id: "00087", number: "00087" })];
    },
  });

  const response = await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: "u_cashier",
    operatorUsername: "cashier",
    operatorName: "Cashier Test",
    operatorRole: "Operatore",
    deviceUuid: "station-a",
    pauseTransferMode: "transfer",
    pauseTransferTargetStation: "PIZZA IN RIVA",
  });

  assert.equal(response.rebalancedOrders, undefined);
  assert.equal(response.parkedOrders?.length, 1);
  const db = await readJson(dbPath);
  const order = db.integration.orders.find((entry) => entry.id === "00087");
  assert.equal(order.assignedStationId, null);
  assert.equal(order.assignmentStatus, "queued_unassigned");
  assert.notEqual(order.station, "PIZZA IN RIVA");
});

test("pausa esplicita non viene riattivata dal recovery della vecchia sessione", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      INTEGRATION_STATION_STALE_MS: "1000",
      POSTAZIONE_STATION_SESSION_RECOVERY_MS: "600000",
    },
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
      ];
      state.integration.stationStates = [];
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "station-recovery",
    clientApp: "postazione",
    station: REAL_BAR_STATION,
  });
  await selectWorkstation(baseUrl, cashier, "station-recovery", "workstation_bar_1");
  await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: true,
    clientApp: "postazione",
    token: cashier.token,
    userId: cashier.user.id,
    deviceUuid: "station-recovery",
  });
  await postStationState(baseUrl, {
    station: REAL_BAR_STATION,
    active: false,
    clientApp: "postazione",
    operatorUserId: cashier.user.id,
    operatorUsername: cashier.user.username,
    deviceUuid: "station-recovery",
    pauseTransferMode: "suspend",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const activeResponse = await fetch(`${baseUrl}/api/integration/stations/active`);
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json();
  assert.equal(active.stations.some((entry) => entry.station === REAL_BAR_STATION), false);
});

test("placeholder UNDEFINED della postazione viene normalizzato sulla prima postazione configurata", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        {
          id: "workstation_test_bar",
          name: REAL_BAR_STATION,
          stationName: REAL_BAR_STATION,
          enabled: true,
        },
      ];
    },
  });

  const upsert = await postStationState(baseUrl, {
    station: "UNDEFINED",
    active: true,
    clientApp: "postazione",
    operatorUserId: "u_roberto",
    operatorUsername: "roberto",
    operatorName: "Roberto Pratesi",
    operatorRole: "Operatore",
    deviceUuid: "station-roberto",
  });
  assert.equal(upsert.station?.station, REAL_BAR_STATION);

  const response = await fetch(`${baseUrl}/api/integration/stations/state`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.configuredStations, [REAL_BAR_STATION]);
  assert.ok(body.stations.some((entry) => entry.station === REAL_BAR_STATION));
});

test("postazione attiva gia occupata da altro utente viene rifiutata", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
      ];
      state.integration.stationStates = [];
    },
  });

  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "station-cashier",
    clientApp: "postazione",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "station-manager",
    clientApp: "postazione",
  });
  await selectWorkstation(baseUrl, cashier, "station-cashier", "workstation_bar_1");

  const first = await postStationState(baseUrl, {
    station: "BAR-1",
    active: true,
    clientApp: "postazione",
    token: cashier.token,
    userId: cashier.user.id,
    deviceUuid: "station-cashier",
  });
  assert.equal(first.station?.active, true);
  assert.equal(first.station?.operatorUserId, cashier.user.id);

  const body = await selectWorkstation(
    baseUrl,
    manager,
    "station-manager",
    "workstation_bar_1",
    409,
  );
  assert.equal(body.code, "WORKSTATION_ALREADY_IN_USE");
  assert.match(body.error, /Postazione gia in uso/);
});

test("postazione attiva accetta cambio utente dallo stesso device e spegne il vecchio stato", async (t) => {
  const sharedDeviceUuid = "station-shared-device";
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
      ];
      state.integration.stationStates = [];
    },
  });

  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: sharedDeviceUuid,
    clientApp: "postazione",
  });
  await selectWorkstation(baseUrl, cashier, sharedDeviceUuid, "workstation_bar_1");
  const first = await postStationState(baseUrl, {
    station: "BAR-1",
    active: true,
    clientApp: "postazione",
    token: cashier.token,
    userId: cashier.user.id,
    deviceUuid: sharedDeviceUuid,
  });
  assert.equal(first.station?.active, true);
  assert.equal(first.station?.operatorUserId, cashier.user.id);

  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: sharedDeviceUuid,
    clientApp: "postazione",
  });
  await selectWorkstation(baseUrl, manager, sharedDeviceUuid, "workstation_bar_1");
  const second = await postStationState(baseUrl, {
    station: "BAR-1",
    active: true,
    clientApp: "postazione",
    token: manager.token,
    userId: manager.user.id,
    deviceUuid: sharedDeviceUuid,
  });
  assert.equal(second.station?.active, true);
  assert.equal(second.station?.operatorUserId, manager.user.id);

  const response = await fetch(`${baseUrl}/api/integration/stations/state`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const realSharedStates = body.stations.filter(
    (entry) =>
      entry.station === "BAR-1" &&
      entry.deviceUuid === sharedDeviceUuid &&
      entry.realStation === true,
  );
  assert.equal(
    realSharedStates.filter((entry) => entry.active !== false).length,
    1,
  );
  assert.equal(
    realSharedStates.some(
      (entry) => entry.operatorUserId === cashier.user.id && entry.active !== false,
    ),
    false,
  );
  assert.ok(
    realSharedStates.some(
      (entry) => entry.operatorUserId === manager.user.id && entry.active === true,
    ),
  );
});

test("postazione attiva accetta cambio postazione dallo stesso device dopo logout", async (t) => {
  const sharedDeviceUuid = "station-shared-device-switch-station";
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", enabled: true },
      ];
      state.integration.stationStates = [];
    },
  });

  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: sharedDeviceUuid,
    clientApp: "postazione",
  });
  await selectWorkstation(baseUrl, cashier, sharedDeviceUuid, "workstation_bar_1");
  const first = await postStationState(baseUrl, {
    station: "BAR-1",
    active: true,
    clientApp: "postazione",
    token: cashier.token,
    userId: cashier.user.id,
    deviceUuid: sharedDeviceUuid,
  });
  assert.equal(first.station?.active, true);
  assert.equal(first.station?.station, "BAR-1");

  const logout = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(cashier, sharedDeviceUuid, { clientApp: "postazione" }),
  );
  assert.equal(logout.response.status, 200);
  const resumedCashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: sharedDeviceUuid,
    clientApp: "postazione",
  });
  await selectWorkstation(baseUrl, resumedCashier, sharedDeviceUuid, "workstation_bar_2");
  const second = await postStationState(baseUrl, {
    station: "BAR-2",
    active: true,
    clientApp: "postazione",
    token: resumedCashier.token,
    userId: resumedCashier.user.id,
    deviceUuid: sharedDeviceUuid,
  });
  assert.equal(second.station?.active, true);
  assert.equal(second.station?.station, "BAR-2");

  const response = await fetch(`${baseUrl}/api/integration/stations/state`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const realSharedStates = body.stations.filter(
    (entry) =>
      entry.deviceUuid === sharedDeviceUuid &&
      entry.realStation === true,
  );
  assert.equal(
    realSharedStates.filter((entry) => entry.active !== false).length,
    1,
  );
  assert.equal(
    realSharedStates.some(
      (entry) => entry.station === "BAR-1" && entry.active !== false,
    ),
    false,
  );
  assert.ok(
    realSharedStates.some(
      (entry) => entry.station === "BAR-2" && entry.active === true,
    ),
  );
});

test("trasferimento manuale riallinea postazione operativa, route e lock della comanda", async (t) => {
  const now = new Date().toISOString();
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.workstations = [
        { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", enabled: true },
        { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", enabled: true },
      ];
      state.integration.stationStates = [
        buildStation(),
        buildStation({
          station: "BAR-2",
          operatorUserId: "u_manager",
          operatorUsername: "manager",
          operatorName: "Manager Test",
          deviceUuid: "station-b",
        }),
      ];
      state.integration.orders = [
        buildOrder({
          id: "00090",
          number: "00090",
          workflowStatus: "prep",
          ownerStation: "BAR-1",
          lockedByStationId: "BAR-1",
          lockedByUserId: "u_cashier",
          lockedAt: now,
          preparationStartedAt: now,
          lockStatus: "locked",
          items: [
            {
              id: "line_1",
              lineId: "line_1",
              productId: "test_prodotto",
              name: "Prodotto test",
              quantity: 1,
              price: 5,
              unitPrice: 5,
              routeStations: ["BAR-1"],
            },
          ],
          tickets: [
            {
              id: "tkt_00090_1",
              orderId: "00090",
              roomId: "room_pedana",
              stationId: "BAR-1",
              createdAt: now,
              createdByUserId: "u_cashier",
              createdByUsername: "cashier",
              ticketStatus: "SENT",
            },
          ],
          lineRoutes: [
            {
              id: "route_00090_1",
              orderId: "00090",
              ticketId: "tkt_00090_1",
              lineId: "line_1",
              stationId: "BAR-1",
              sentAt: now,
              sentByUserId: "u_cashier",
              sentByUsername: "cashier",
            },
          ],
        }),
      ];
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "transfer-mobile",
    clientApp: "mobile-frontend",
  });
  const auth = {
    token: manager.token,
    userId: manager.user.id,
    deviceUuid: "transfer-mobile",
    clientApp: "mobile-frontend",
  };

  let response = await fetch(`${baseUrl}/api/integration/orders/transfer/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...auth,
      orderId: "00090",
      mode: "transfer",
      requesterStation: "BAR-2",
      targetStation: "BAR-2",
      requesterOperator: "Manager Test",
      requesterRole: "Responsabile",
    }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/integration/orders/transfer/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...auth,
      orderId: "00090",
      approve: true,
      approverStation: "BAR-1",
      approverOperator: "Cashier Test",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.order.station, "BAR-2");
  assert.equal(body.order.assignedStationId, "BAR-2");
  assert.equal(body.order.ownerStation, null);
  assert.equal(body.order.assignmentReason, "manual_transfer");
  assert.equal(body.order.workflowStatus, "waiting");
  assert.equal(body.order.lockStatus, "unlocked");
  assert.equal(body.order.pendingAuthRequest, null);
  assert.deepEqual(body.order.items[0].routeStations, ["BAR-2"]);
  assert.equal(body.order.tickets[0].stationId, "BAR-2");
  assert.equal(body.order.lineRoutes[0].stationId, "BAR-2");

  const db = await readJson(dbPath);
  const order = db.integration.orders.find((entry) => entry.id === "00090");
  assert.equal(order.station, "BAR-2");
  assert.equal(order.assignedStationId, "BAR-2");
  assert.equal(order.tickets[0].stationId, "BAR-2");
  assert.equal(order.lineRoutes[0].stationId, "BAR-2");
});
