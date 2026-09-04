import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function startRoomChangeBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "room-change-async-pin");
  return startBackend(t, {
    runDir,
    env: {
      BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE: "1",
      RUNTIME_METRICS: "1",
      ...options.env,
    },
    stateOverrides(state) {
      const waiter = state.users.find((entry) => entry.id === "u_waiter");
      waiter.enabledRoomIds = ["room_pedana", "room_sala"];
      waiter.authorizedRoomIds = ["room_pedana"];
    },
  });
}

async function createPending(baseUrl, session, deviceUuid) {
  const created = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(session, deviceUuid, { targetRoomId: "room_sala" }),
  );
  assert.equal(created.response.status, 200);
  assert.equal(created.body.status, "pending");
  return created.body.requestId;
}

async function approve(baseUrl, manager, requestId, approverPin = "4444") {
  return apiPost(
    baseUrl,
    "/api/pos/room-change/approve",
    authPayload(manager, "room-change-manager-device", {
      requestId,
      approverUsername: "manager",
      approverPin,
    }),
  );
}

test("P4.3 async PIN pre-lane approva e mantiene generico il rifiuto PIN", async (t) => {
  const { baseUrl, dbPath } = await startRoomChangeBackend(t);
  const waiterDevice = "room-change-waiter-device";
  const waiter = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: waiterDevice,
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "room-change-manager-device",
    clientApp: "mobile-frontend",
  });
  const requestId = await createPending(baseUrl, waiter, waiterDevice);

  const denied = await approve(baseUrl, manager, requestId, "0000");
  assert.equal(denied.response.status, 200);
  assert.equal(denied.body.ok, false);
  assert.equal(denied.body.error, "Credenziali autorizzatore non valide.");
  assert.equal((await readJson(dbPath)).posRoomChangeRequests.some((entry) => entry.requestId === requestId), true);

  const approved = await approve(baseUrl, manager, requestId);
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.ok, true);
  assert.equal(approved.body.lastSelectedRoomId, "room_sala");
  assert.equal((await readJson(dbPath)).posRoomChangeRequests.some((entry) => entry.requestId === requestId), false);
});

test("P4.3 async PIN pre-lane non rende approvabile una richiesta scaduta", async (t) => {
  const { baseUrl } = await startRoomChangeBackend(t, {
    prefix: "room-change-async-pin-expired",
    env: { POS_ROOM_CHANGE_MAX_AGE_MS: "1" },
  });
  const waiterDevice = "room-change-expired-waiter";
  const waiter = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: waiterDevice,
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "room-change-manager-device",
    clientApp: "mobile-frontend",
  });
  const requestId = await createPending(baseUrl, waiter, waiterDevice);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const expired = await approve(baseUrl, manager, requestId);
  assert.equal(expired.response.status, 200);
  assert.equal(expired.body.ok, false);
  assert.equal(expired.body.error, "Richiesta non trovata o scaduta.");
});

test("P4.3 async PIN pre-lane ricostruisce la prova dopo un riavvio backend", async (t) => {
  const first = await startRoomChangeBackend(t, { prefix: "room-change-async-pin-restart" });
  const waiterDevice = "room-change-restart-waiter";
  const waiter = await loginJson(first.baseUrl, "waiter", "3333", {
    deviceUuid: waiterDevice,
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(first.baseUrl, "manager", "4444", {
    deviceUuid: "room-change-manager-device",
    clientApp: "mobile-frontend",
  });
  const requestId = await createPending(first.baseUrl, waiter, waiterDevice);

  first.child.kill();
  await once(first.child, "exit");
  const restarted = await startBackend(t, {
    runDir: first.runDir,
    dbPath: first.dbPath,
    preserveDb: true,
    env: {
      BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE: "1",
      RUNTIME_METRICS: "1",
    },
  });

  const approved = await approve(restarted.baseUrl, manager, requestId);
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.ok, true);
  assert.equal(approved.body.lastSelectedRoomId, "room_sala");
});
