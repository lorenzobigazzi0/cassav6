import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireTableLock,
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

const TABLE_ID = "removed_room_sala_t91";
const ROOM_ID = "room_sala";

async function loginManager(baseUrl, deviceUuid) {
  return loginJson(baseUrl, "manager", "4444", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
}

function seedOpenRemovedTable(state, now = Date.now()) {
  state.auditEvents.push({
    id: `removed-operational-open-${now}`,
    occurredAt: new Date(now - 10_000).toISOString(),
    actorUserId: "u_manager",
    actorRole: "MANAGER",
    action: "table.session_opened",
    entityType: "table",
    entityId: TABLE_ID,
    roomId: ROOM_ID,
    payload: {
      tableId: TABLE_ID,
      tableNumber: 91,
      roomId: ROOM_ID,
      seatedAt: now - 10_000,
    },
  });
}

function removeSourceRoomConfiguration(state) {
  state.posSettings.tables = state.posSettings.tables.filter(
    (table) => String(table?.roomId ?? "").trim() !== ROOM_ID,
  );
  state.posSettings.rooms = (state.posSettings.rooms ?? []).filter(
    (room) => String(room?.id ?? room?.roomId ?? "").trim() !== ROOM_ID,
  );
  state.posSettings.areas = (state.posSettings.areas ?? []).filter(
    (room) => String(room?.id ?? room?.roomId ?? "").trim() !== ROOM_ID,
  );
  state.posSettings.activityRoomBindings = (
    state.posSettings.activityRoomBindings ?? []
  ).filter((binding) => String(binding?.roomId ?? "").trim() !== ROOM_ID);

  const manager = state.users.find((user) => user.id === "u_manager");
  manager.role = "operator";
  manager.roleLabel = "Operatore";
  manager.permissions = ["print_orders"];
  manager.enabledRoomIds = [...new Set([...(manager.enabledRoomIds ?? []), ROOM_ID])];
  manager.authorizedRoomIds = [
    ...new Set([...(manager.authorizedRoomIds ?? []), ROOM_ID]),
  ];
}

test("tombstone operativa accetta lock e nuova comanda senza rientrare nel layout", async (t) => {
  const now = Date.now();
  const deviceUuid = "removed-operational-order-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      seedOpenRemovedTable(state, now);
      removeSourceRoomConfiguration(state);
    },
  });
  const session = await loginManager(baseUrl, deviceUuid);

  const locked = await acquireTableLock(baseUrl, session, TABLE_ID, {
    deviceUuid,
    purpose: "mobile:order_composer",
  });
  assert.equal(locked.response.status, 200, JSON.stringify(locked.body));
  assert.equal(locked.body?.removedFromConfiguration, true);
  assert.equal(locked.body?.table?.id, TABLE_ID);

  const created = await apiPost(
    baseUrl,
    "/api/integration/orders/create",
    authPayload(session, deviceUuid, {
      source: "mobile-frontend",
      roomId: ROOM_ID,
      tableId: TABLE_ID,
      tableNumber: 91,
      covers: 2,
      clientOrderId: `removed-operational-order-${now}`,
      idempotencyKey: `removed-operational-order-${now}`,
      total: 4.5,
      lines: [
        {
          productId: "menu_caffetteria_caffe",
          name: "Caffe",
          qty: 1,
          unitPriceApplied: 4.5,
          lineTotal: 4.5,
        },
      ],
    }),
    { headers: authHeaders(session, deviceUuid) },
  );
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body?.ok, true);
  assert.equal(created.body?.order?.tableId, TABLE_ID);
  assert.equal(created.body?.order?.tableNumber, 91);

  const db = await readJson(dbPath);
  assert.equal(
    db.posSettings.tables.some((table) => table.id === TABLE_ID),
    false,
  );
  assert.equal(
    (db.posSettings.rooms ?? []).some(
      (room) => String(room?.id ?? room?.roomId ?? "").trim() === ROOM_ID,
    ),
    false,
  );
  assert.equal(
    db.integration.orders.some((order) => order.tableId === TABLE_ID),
    true,
  );
  assert.equal(
    db.tableLocks.some(
      (entry) =>
        entry.kind === "removed_operational_table" && entry.tableId === TABLE_ID,
    ),
    true,
  );
});

test("liberazione tombstone chiude la sessione e ne impedisce il riuso", async (t) => {
  const now = Date.now();
  const deviceUuid = "removed-operational-release-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      seedOpenRemovedTable(state, now);
      removeSourceRoomConfiguration(state);
    },
  });
  const session = await loginManager(baseUrl, deviceUuid);
  const locked = await acquireTableLock(baseUrl, session, TABLE_ID, {
    deviceUuid,
    purpose: "table.sync",
  });
  assert.equal(locked.response.status, 200, JSON.stringify(locked.body));

  const released = await apiPost(
    baseUrl,
    "/api/integration/layout/table/sync",
    authPayload(session, deviceUuid, {
      roomId: ROOM_ID,
      tableId: TABLE_ID,
      tableNumber: 91,
      status: "free",
      occupancyState: "free",
      covers: 0,
      reservationAt: null,
      seatedAt: null,
    }),
    { headers: authHeaders(session, deviceUuid) },
  );
  assert.equal(released.response.status, 200, JSON.stringify(released.body));
  assert.equal(released.body?.removedFromConfiguration, true);
  assert.equal(released.body?.removedTableId, TABLE_ID);
  assert.equal(released.body?.table, null);

  const db = await readJson(dbPath);
  assert.equal(
    db.posSettings.tables.some((table) => table.id === TABLE_ID),
    false,
  );
  assert.equal(
    db.tableLocks.some(
      (entry) =>
        entry.kind === "removed_operational_table" && entry.tableId === TABLE_ID,
    ),
    false,
  );
  assert.equal(
    db.auditEvents.some(
      (event) =>
        event.action === "table.released" &&
        event.entityId === TABLE_ID &&
        event.payload?.removedFromConfiguration === true,
    ),
    true,
  );

  const relock = await acquireTableLock(baseUrl, session, TABLE_ID, {
    deviceUuid,
    purpose: "mobile:order_composer",
  });
  assert.equal(relock.response.status, 409, JSON.stringify(relock.body));
  assert.equal(
    [
      "REMOVED_SOURCE_ALREADY_RELEASED",
      "REMOVED_SOURCE_OPERATIONAL_EVIDENCE_MISSING",
    ].includes(relock.body?.code),
    true,
  );
});

test("lock di una falsa tombstone senza evidenza server viene respinto", async (t) => {
  const deviceUuid = "removed-operational-fake-device";
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginManager(baseUrl, deviceUuid);

  const rejected = await acquireTableLock(baseUrl, session, TABLE_ID, {
    deviceUuid,
    purpose: "mobile:order_composer",
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(
    rejected.body?.code,
    "REMOVED_SOURCE_OPERATIONAL_EVIDENCE_MISSING",
  );

  const db = await readJson(dbPath);
  assert.equal(
    db.posSettings.tables.some((table) => table.id === TABLE_ID),
    false,
  );
  assert.equal(
    (db.tableLocks ?? []).some((entry) => entry.tableId === TABLE_ID),
    false,
  );
});
