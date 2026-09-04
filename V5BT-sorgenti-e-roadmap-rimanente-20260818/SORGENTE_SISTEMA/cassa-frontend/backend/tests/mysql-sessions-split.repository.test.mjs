import assert from "node:assert/strict";
import test from "node:test";

import { createMysqlSessionsSplitRepository } from "../db/app-state/index.js";

function createFakeMysqlRepository() {
  const rows = new Map();

  function sortedRows() {
    return [...rows.values()].sort((a, b) => {
      if (a.app_state_position !== b.app_state_position) {
        return a.app_state_position - b.app_state_position;
      }
      return String(a.id).localeCompare(String(b.id));
    });
  }

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      if (/SELECT id,\s*row_hash FROM\s+`app_state_sessions`/s.test(sql)) {
        return [
          sortedRows().map((row) => ({
            id: row.id,
            row_hash: row.row_hash,
          })),
        ];
      }

      if (/DELETE FROM\s+`app_state_sessions`\s+WHERE id = \?/s.test(sql)) {
        rows.delete(String(params[0] ?? ""));
        return [{ affectedRows: 1 }];
      }

      if (/INSERT INTO\s+`app_state_sessions`/s.test(sql)) {
        const [
          id,
          userId,
          username,
          tokenHash,
          deviceUuid,
          clientApp,
          roomId,
          roomName,
          stationName,
          createdAt,
          lastSeenAt,
          expiresAt,
          appStatePosition,
          rowHash,
          rawJson,
        ] = params;
        rows.set(String(id), {
          id: String(id),
          user_id: userId,
          username,
          token_hash: tokenHash,
          device_uuid: deviceUuid,
          client_app: clientApp,
          room_id: roomId,
          room_name: roomName,
          station_name: stationName,
          created_at_value: createdAt,
          last_seen_at: lastSeenAt,
          expires_at: expiresAt,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }

      if (/UPDATE\s+`app_state_sessions`[\s\S]+WHERE id = \?/s.test(sql)) {
        const id = String(params[14] ?? "");
        const current = rows.get(id);
        if (!current) return [{ affectedRows: 0 }];
        const [
          userId,
          username,
          tokenHash,
          deviceUuid,
          clientApp,
          roomId,
          roomName,
          stationName,
          createdAt,
          lastSeenAt,
          expiresAt,
          appStatePosition,
          rowHash,
          rawJson,
        ] = params;
        rows.set(id, {
          ...current,
          user_id: userId,
          username,
          token_hash: tokenHash,
          device_uuid: deviceUuid,
          client_app: clientApp,
          room_id: roomId,
          room_name: roomName,
          station_name: stationName,
          created_at_value: createdAt,
          last_seen_at: lastSeenAt,
          expires_at: expiresAt,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }

      return [[]];
    },
  };

  return {
    rows,
    async query(sql, params = []) {
      if (/WHERE token_hash = \? AND device_uuid = \?/s.test(sql)) {
        return sortedRows().filter(
          (row) =>
            row.token_hash === String(params[0] ?? "") &&
            row.device_uuid === String(params[1] ?? ""),
        ).slice(0, 1);
      }
      if (/SELECT \* FROM\s+`app_state_sessions`/s.test(sql)) {
        return sortedRows();
      }
      return [];
    },
    async getPool() {
      return {
        async getConnection() {
          return connection;
        },
      };
    },
  };
}

function buildSession(id, deviceUuid) {
  return {
    id,
    userId: "u_cashier",
    username: "cashier",
    tokenHash: `hash_${id}`,
    deviceUuid,
    clientApp: "mobile-frontend",
    createdAt: "2026-07-06T09:00:00.000Z",
    lastSeenAt: "2026-07-06T09:00:00.000Z",
    expiresAt: "2026-07-06T19:00:00.000Z",
  };
}

test("[BE][P1] MySQL session split puo aggiungere login concorrenti senza cancellare sessioni esterne allo snapshot", async () => {
  const mysqlRepository = createFakeMysqlRepository();
  const split = createMysqlSessionsSplitRepository({
    enabled: true,
    mysqlRepository,
    logger: { info() {} },
  });

  await split.syncFromAppState({
    sessions: [buildSession("session_a", "device-a")],
  });
  await split.syncFromAppState(
    {
      sessions: [buildSession("session_b", "device-b")],
    },
    { deleteMissing: false },
  );

  const hydrated = await split.hydrateAppState({ sessions: [] });
  assert.deepEqual(
    hydrated.sessions.map((entry) => entry.id).sort(),
    ["session_a", "session_b"],
  );

  await split.syncFromAppState({
    sessions: [buildSession("session_b", "device-b")],
  });
  const pruned = await split.hydrateAppState({ sessions: [] });
  assert.deepEqual(
    pruned.sessions.map((entry) => entry.id).sort(),
    ["session_b"],
  );
});

test("[BE][P3] MySQL session split sincronizza e cancella sessioni puntuali per login/logout", async () => {
  const mysqlRepository = createFakeMysqlRepository();
  const split = createMysqlSessionsSplitRepository({
    enabled: true,
    mysqlRepository,
    logger: { info() {} },
  });

  await split.syncFromAppState({
    sessions: [
      buildSession("session_a", "device-a"),
      buildSession("session_b", "device-b"),
    ],
  });
  await split.syncEntriesFromAppState(
    {
      sessions: [
        buildSession("session_a", "device-a"),
        buildSession("session_c", "device-c"),
      ],
    },
    ["session_c"],
  );
  let hydrated = await split.hydrateAppState({ sessions: [] });
  assert.deepEqual(
    hydrated.sessions.map((entry) => entry.id).sort(),
    ["session_a", "session_b", "session_c"],
  );

  await split.deleteSessions(["session_b"]);
  hydrated = await split.hydrateAppState({ sessions: [] });
  assert.deepEqual(
    hydrated.sessions.map((entry) => entry.id).sort(),
    ["session_a", "session_c"],
  );

  await split.syncFromAppState(
    { sessions: [buildSession("session_a", "device-a")] },
    { deleteMissing: false, deleteSessionIds: ["session_c"] },
  );
  hydrated = await split.hydrateAppState({ sessions: [] });
  assert.deepEqual(
    hydrated.sessions.map((entry) => entry.id).sort(),
    ["session_a"],
  );
});

test("[BE][P4] MySQL session split risolve una sola sessione per token e device", async () => {
  const mysqlRepository = createFakeMysqlRepository();
  const split = createMysqlSessionsSplitRepository({
    enabled: true,
    mysqlRepository,
    logger: { info() {} },
  });
  await split.syncFromAppState({
    sessions: [
      buildSession("session_a", "device-a"),
      buildSession("session_b", "device-b"),
    ],
  });

  const found = await split.findSessionByTokenHash({
    tokenHash: "hash_session_b",
    deviceUuid: "device-b",
  });
  assert.equal(found?.id, "session_b");
  assert.equal(
    await split.findSessionByTokenHash({
      tokenHash: "hash_session_b",
      deviceUuid: "device-a",
    }),
    null,
  );
});

test("[BE][P0] heartbeat sessione usa UPDATE-only e non ricrea una sessione revocata", async () => {
  const mysqlRepository = createFakeMysqlRepository();
  const split = createMysqlSessionsSplitRepository({
    enabled: true,
    mysqlRepository,
    logger: { info() {} },
  });
  const original = buildSession("session_a", "device-a");
  await split.syncFromAppState({ sessions: [original] });

  const refreshed = {
    ...original,
    lastSeenAt: "2026-07-06T09:05:00.000Z",
  };
  assert.equal(
    await split.updateEntriesFromAppState({ sessions: [refreshed] }, ["session_a"]),
    1,
  );
  assert.equal(
    (await split.hydrateAppState({ sessions: [] })).sessions[0]?.lastSeenAt,
    refreshed.lastSeenAt,
  );

  await split.deleteSessions(["session_a"]);
  assert.equal(
    await split.updateEntriesFromAppState({ sessions: [refreshed] }, ["session_a"]),
    0,
  );
  assert.deepEqual(
    (await split.hydrateAppState({ sessions: [] })).sessions,
    [],
  );
});
