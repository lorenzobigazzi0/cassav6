import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  apiPost,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

test("[BE][P1] cambio sala diretto persiste sessione e preferenza utente dopo restart", async (t) => {
  const first = await startBackend(t);
  const deviceUuid = "room-change-direct-restart-device";
  const cashier = await loginJson(first.baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const changed = await apiPost(
    first.baseUrl,
    "/api/pos/room-change/request",
    authPayload(cashier, deviceUuid, { targetRoomId: "room_sala" }),
  );
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.ok, true);
  assert.equal(changed.body.direct, true);
  assert.equal(changed.body.lastSelectedRoomId, "room_sala");

  first.child.kill();
  await once(first.child, "exit");

  const persistedBeforeRestart = await readJson(first.dbPath);
  const persistedUser = persistedBeforeRestart.users.find(
    (entry) => entry.id === cashier.user.id,
  );
  const persistedSession = persistedBeforeRestart.sessions.find(
    (entry) => entry.userId === cashier.user.id && entry.deviceUuid === deviceUuid,
  );
  assert.equal(persistedUser?.lastSelectedRoomId, "room_sala");
  assert.equal(persistedUser?.lastSelectedRoomName, "Sala");
  assert.equal(persistedSession?.roomId, "room_sala");
  assert.equal(persistedSession?.roomName, "Sala");

  const restarted = await startBackend(t, {
    runDir: first.runDir,
    dbPath: first.dbPath,
    preserveDb: true,
  });
  const rooms = await apiPost(
    restarted.baseUrl,
    "/api/pos/rooms",
    authPayload(cashier, deviceUuid),
  );
  assert.equal(rooms.response.status, 200);
  assert.equal(rooms.body.lastSelectedRoomId, "room_sala");
  assert.equal(rooms.body.initialRoom.roomId, "room_sala");

  const persistedAfterRestart = await readJson(first.dbPath);
  assert.equal(
    persistedAfterRestart.users.find((entry) => entry.id === cashier.user.id)
      ?.lastSelectedRoomId,
    "room_sala",
  );
  assert.equal(
    persistedAfterRestart.sessions.find(
      (entry) => entry.userId === cashier.user.id && entry.deviceUuid === deviceUuid,
    )?.roomId,
    "room_sala",
  );
});
