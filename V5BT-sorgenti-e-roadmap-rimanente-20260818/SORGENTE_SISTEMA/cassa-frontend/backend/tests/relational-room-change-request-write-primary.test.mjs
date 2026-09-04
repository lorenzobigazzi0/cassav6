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

function roomChangeEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY: "1",
  };
}

async function startRoomChangeBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-room-change-request");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    env: options.env ?? roomChangeEnv(relationalPath),
    stateOverrides(state) {
      const waiter = state.users.find((entry) => entry.id === "u_waiter");
      waiter.enabledRoomIds = ["room_pedana", "room_sala"];
      waiter.authorizedRoomIds = ["room_pedana"];
      if (typeof options.stateOverrides === "function") options.stateOverrides(state);
    },
  });
  return { ...server, relationalPath, runDir };
}

async function readRelationalRoomChangeRequest(relationalPath, requestId) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db.prepare("SELECT * FROM room_change_requests WHERE request_id = ?").get(requestId);
  } finally {
    closeRelationalConnection(db);
  }
}

async function createPendingRoomChange(baseUrl, session, deviceUuid) {
  const created = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(session, deviceUuid, { targetRoomId: "room_sala" })
  );
  assert.equal(created.response.status, 200);
  assert.equal(created.body.status, "pending");
  assert.match(created.body.requestId, /^room_req_/);
  return created.body.requestId;
}

test("J10 room-change request write-primary crea pending relazionale e mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startRoomChangeBackend(t, {
    prefix: "rel-room-change-primary",
  });
  const deviceUuid = "room-change-primary-device";
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const requestId = await createPendingRoomChange(baseUrl, session, deviceUuid);

  const relational = await readRelationalRoomChangeRequest(relationalPath, requestId);
  assert.equal(relational.user_id, "u_waiter");
  assert.equal(relational.device_uuid, deviceUuid);
  assert.equal(relational.target_room_id, "room_sala");
  assert.equal(relational.status, "pending");
  assert.equal(relational.revision, 1);

  const appState = await readJson(dbPath);
  const request = appState.posRoomChangeRequests.find((entry) => entry.requestId === requestId);
  assert.equal(request.userId, "u_waiter");
  assert.equal(request.targetRoomId, "room_sala");
  assert.equal(request.revision, 1);
});

test("J11 room-change approve write-primary rimuove pending relazionale e mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startRoomChangeBackend(t, {
    prefix: "rel-room-change-approve",
  });
  const deviceUuid = "room-change-approve-device";
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "room-change-approve-manager",
    clientApp: "mobile-frontend",
  });
  const requestId = await createPendingRoomChange(baseUrl, session, deviceUuid);

  const approved = await apiPost(
    baseUrl,
    "/api/pos/room-change/approve",
    authPayload(manager, "room-change-approve-manager", {
      requestId,
      approverUsername: "manager",
      approverPin: "4444",
    })
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.ok, true);
  assert.equal(approved.body.lastSelectedRoomId, "room_sala");
  assert.equal(await readRelationalRoomChangeRequest(relationalPath, requestId), undefined);
  const appState = await readJson(dbPath);
  assert.equal(appState.posRoomChangeRequests.some((entry) => entry.requestId === requestId), false);
});

test("J11 room-change cancel write-primary rimuove pending relazionale e mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startRoomChangeBackend(t, {
    prefix: "rel-room-change-cancel",
  });
  const deviceUuid = "room-change-cancel-device";
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "room-change-cancel-manager",
    clientApp: "mobile-frontend",
  });
  const requestId = await createPendingRoomChange(baseUrl, session, deviceUuid);

  const cancelled = await apiPost(
    baseUrl,
    "/api/pos/room-change/cancel",
    authPayload(manager, "room-change-cancel-manager", { requestId })
  );
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.cancelled, true);
  assert.equal(await readRelationalRoomChangeRequest(relationalPath, requestId), undefined);
  const appState = await readJson(dbPath);
  assert.equal(appState.posRoomChangeRequests.some((entry) => entry.requestId === requestId), false);
});

test("J10 room-change request write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startRoomChangeBackend(t, {
    prefix: "rel-room-change-missing-db",
    env: { BACKEND_RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "room-change-no-db-device";
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(session, deviceUuid, { targetRoomId: "room_sala" })
  );
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});
