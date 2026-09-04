import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
} from "../db/relational/index.js";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function tableRoomMoveEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY: "1",
  };
}

async function startTableRoomMoveBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-table-room-move-request");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    env: options.env ?? tableRoomMoveEnv(relationalPath),
    stateOverrides(state) {
      const waiter = state.users.find((user) => user.id === "u_waiter");
      waiter.authorizedRoomIds = ["room_pedana", "room_sala"];
      waiter.enabledRoomIds = ["room_pedana", "room_sala"];
      const cashier = state.users.find((user) => user.id === "u_cashier");
      cashier.permissions = [...new Set([...(cashier.permissions ?? []), "approve_room_change"])];
      if (typeof options.stateOverrides === "function") options.stateOverrides(state);
    },
  });
  return { ...server, relationalPath, runDir };
}

async function readRelationalTableRoomMoveRequest(relationalPath, requestId) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db.prepare("SELECT * FROM table_room_move_requests WHERE request_id = ?").get(requestId);
  } finally {
    closeRelationalConnection(db);
  }
}

async function updateRelationalTableRoomMoveRequest(relationalPath, requestId, patch = {}) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    const current = await readRelationalTableRoomMoveRequest(relationalPath, requestId);
    const raw = JSON.parse(current.raw_json);
    const nextRaw = {
      ...raw,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.fromTableLabel ? { fromTableLabel: patch.fromTableLabel } : {}),
      revision: patch.revision ?? current.revision,
    };
    db.prepare(
      `UPDATE table_room_move_requests
       SET status = COALESCE(?, status),
           from_table_label = COALESCE(?, from_table_label),
           approved_at_ms = COALESCE(?, approved_at_ms),
           revision = ?,
           raw_json = ?
       WHERE request_id = ?`
    ).run(
      patch.status ?? null,
      patch.fromTableLabel ?? null,
      patch.approvedAt ?? null,
      patch.revision ?? current.revision,
      JSON.stringify(nextRaw),
      requestId
    );
  } finally {
    closeRelationalConnection(db);
  }
}

async function loginTargetWaiterInRoom(baseUrl) {
  const targetWaiter = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "table-room-move-target",
    clientApp: "mobile-frontend",
  });
  const targetRoomLogin = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(targetWaiter, "table-room-move-target", {
      targetRoomId: "room_sala",
    })
  );
  assert.equal(targetRoomLogin.response.status, 200);
  assert.equal(targetRoomLogin.body.status, "approved");
  return targetWaiter;
}

test("J12 table-room-move request write-primary crea pending relazionale e mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableRoomMoveBackend(t, {
    prefix: "rel-table-room-move-primary",
  });
  await loginTargetWaiterInRoom(baseUrl);
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-room-move-requester",
    clientApp: "mobile-frontend",
  });

  const created = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "table-room-move-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    })
  );
  assert.equal(created.response.status, 200);
  assert.equal(created.body.status, "pending");
  const requestId = created.body.request.requestId;
  assert.match(requestId, /^table_room_req_/);

  const relational = await readRelationalTableRoomMoveRequest(relationalPath, requestId);
  assert.equal(relational.requester_user_id, "u_waiter");
  assert.equal(relational.requester_device_uuid, "table-room-move-requester");
  assert.equal(relational.from_table_id, "room_pedana_t05");
  assert.equal(relational.target_room_id, "room_sala");
  assert.deepEqual(JSON.parse(relational.target_table_ids_json), ["room_sala_t01"]);
  assert.equal(relational.status, "pending");
  assert.equal(relational.revision, 1);

  const appState = await readJson(dbPath);
  const request = appState.posTableRoomMoveRequests.find((entry) => entry.requestId === requestId);
  assert.equal(request.requesterUserId, "u_waiter");
  assert.equal(request.targetRoomId, "room_sala");
  assert.equal(request.revision, 1);
});

test("J12 table-room-move request write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startTableRoomMoveBackend(t, {
    prefix: "rel-table-room-move-missing-db",
    env: { BACKEND_RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY: "1" },
  });
  await loginTargetWaiterInRoom(baseUrl);
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-room-move-no-db",
    clientApp: "mobile-frontend",
  });

  const response = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "table-room-move-no-db", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    })
  );
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});

test("J13 table-room-move status legge dal relazionale quando write-primary e attiva", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableRoomMoveBackend(t, {
    prefix: "rel-table-room-move-status-read",
  });
  await loginTargetWaiterInRoom(baseUrl);
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-room-move-status-requester",
    clientApp: "mobile-frontend",
  });
  const created = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "table-room-move-status-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    })
  );
  const requestId = created.body.request.requestId;
  await updateRelationalTableRoomMoveRequest(relationalPath, requestId, {
    status: "approved",
    approvedAt: Date.now(),
    revision: 2,
  });
  const appStateBeforeStatus = await readJson(dbPath);
  assert.equal(
    appStateBeforeStatus.posTableRoomMoveRequests.find((entry) => entry.requestId === requestId).status,
    "pending"
  );

  const status = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/status",
    authPayload(requester, "table-room-move-status-requester", { requestId })
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.status, "approved");
  assert.equal(status.body.request.status, "approved");
});

test("J13 table-room-move pending legge lista dal relazionale quando write-primary e attiva", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableRoomMoveBackend(t, {
    prefix: "rel-table-room-move-pending-read",
  });
  const targetWaiter = await loginTargetWaiterInRoom(baseUrl);
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-room-move-pending-requester",
    clientApp: "mobile-frontend",
  });
  const created = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "table-room-move-pending-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    })
  );
  const requestId = created.body.request.requestId;
  await updateRelationalTableRoomMoveRequest(relationalPath, requestId, {
    fromTableLabel: "REL-9",
    revision: 3,
  });
  const appStateBeforePending = await readJson(dbPath);
  assert.equal(
    appStateBeforePending.posTableRoomMoveRequests.find((entry) => entry.requestId === requestId).fromTableLabel,
    "5"
  );

  const pending = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/pending",
    authPayload(targetWaiter, "table-room-move-target", { roomId: "room_sala" })
  );
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.ok, true);
  assert.equal(pending.body.requests.length, 1);
  assert.equal(pending.body.requests[0].requestId, requestId);
  assert.equal(pending.body.requests[0].fromTableLabel, "REL-9");
});

test("J14 table-room-move resolve approva su relazionale e aggiorna mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableRoomMoveBackend(t, {
    prefix: "rel-table-room-move-resolve-approve",
  });
  const targetWaiter = await loginTargetWaiterInRoom(baseUrl);
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-room-move-resolve-requester",
    clientApp: "mobile-frontend",
  });
  const created = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "table-room-move-resolve-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    })
  );
  const requestId = created.body.request.requestId;

  const resolved = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/resolve",
    authPayload(targetWaiter, "table-room-move-target", {
      requestId,
      approve: true,
      roomId: "room_sala",
    })
  );
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.status, "approved");
  assert.equal(resolved.body.request.approverUsername, targetWaiter.user.username);

  const relational = await readRelationalTableRoomMoveRequest(relationalPath, requestId);
  assert.equal(relational.status, "approved");
  assert.equal(relational.revision, 2);
  assert.equal(relational.resolved_by_user_id, targetWaiter.user.id);
  assert.equal(relational.resolved_by_username, targetWaiter.user.username);
  assert.ok(Number(relational.approved_at_ms) > 0);
  assert.equal(Number(relational.rejected_at_ms) || 0, 0);
  const raw = JSON.parse(relational.raw_json);
  assert.equal(raw.status, "approved");
  assert.equal(raw.approverUsername, targetWaiter.user.username);

  const appState = await readJson(dbPath);
  const request = appState.posTableRoomMoveRequests.find((entry) => entry.requestId === requestId);
  assert.equal(request.status, "approved");
  assert.equal(request.approverUsername, targetWaiter.user.username);
  assert.equal(request.revision, 2);
});

test("J14 table-room-move resolve rifiuta su relazionale e aggiorna mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableRoomMoveBackend(t, {
    prefix: "rel-table-room-move-resolve-reject",
  });
  const targetWaiter = await loginTargetWaiterInRoom(baseUrl);
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-room-move-reject-requester",
    clientApp: "mobile-frontend",
  });
  const created = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "table-room-move-reject-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    })
  );
  const requestId = created.body.request.requestId;

  const resolved = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/resolve",
    authPayload(targetWaiter, "table-room-move-target", {
      requestId,
      approve: false,
      roomId: "room_sala",
    })
  );
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.status, "rejected");

  const relational = await readRelationalTableRoomMoveRequest(relationalPath, requestId);
  assert.equal(relational.status, "rejected");
  assert.equal(relational.revision, 2);
  assert.equal(relational.resolved_by_user_id, targetWaiter.user.id);
  assert.ok(Number(relational.rejected_at_ms) > 0);
  assert.equal(Number(relational.approved_at_ms) || 0, 0);

  const appState = await readJson(dbPath);
  const request = appState.posTableRoomMoveRequests.find((entry) => entry.requestId === requestId);
  assert.equal(request.status, "rejected");
  assert.equal(request.approverUsername, targetWaiter.user.username);
  assert.equal(request.revision, 2);
});
