import { createHash } from "node:crypto";

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeIdentifier(value, fallback) {
  const identifier = String(value ?? fallback ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(
      `Identificatore MySQL non valido: ${identifier || "(vuoto)"}`,
    );
  }
  return identifier;
}

function quoteIdentifier(identifier) {
  return `\`${identifier}\``;
}

function safeJsonStringify(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeJsonParse(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function lockNameForTable(tableName, tableId) {
  const digest = createHash("sha1")
    .update(`${tableName}:${String(tableId ?? "")}`)
    .digest("hex")
    .slice(0, 40);
  return `table_lock_${digest}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TABLE_LOCK_MUTATION_MAX_ATTEMPTS = 8;

function isRetryableMysqlLockError(error) {
  const code = String(error?.code ?? "");
  const errno = Number(error?.errno ?? error?.number ?? 0);
  return (
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    code === "TABLE_LOCK_SQL_BUSY" ||
    errno === 1205 ||
    errno === 1213
  );
}

function normalizeTableWorkLock(lock, position = 0) {
  if (!lock || typeof lock !== "object") return null;
  const tableId = normalizeNullableString(lock.tableId ?? lock.table_id);
  const userId = normalizeNullableString(lock.userId ?? lock.user_id);
  const expiresAt = normalizeNullableString(lock.expiresAt ?? lock.expires_at);
  const expiresAtMs = Date.parse(String(expiresAt ?? ""));
  if (!tableId || !userId || !expiresAt || !Number.isFinite(expiresAtMs)) {
    return null;
  }
  const normalized = {
    tableId,
    userId,
    username:
      normalizeNullableString(lock.username ?? lock.userName) ?? userId,
    deviceUuid: normalizeNullableString(lock.deviceUuid ?? lock.device_uuid) ?? "",
    sessionId: normalizeNullableString(lock.sessionId ?? lock.session_id) ?? "",
    purpose:
      normalizeNullableString(lock.purpose ?? lock.type) ?? "table_mutation",
    acquiredAt:
      normalizeNullableString(lock.acquiredAt ?? lock.acquired_at) ??
      new Date().toISOString(),
    heartbeatAt:
      normalizeNullableString(
        lock.heartbeatAt ?? lock.heartbeat_at ?? lock.acquiredAt,
      ) ?? new Date().toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  const rawJson = safeJsonStringify(normalized, {});
  return {
    ...normalized,
    appStatePosition: Number.isFinite(Number(position)) ? Number(position) : 0,
    expiresAtMs,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToTableWorkLock(row) {
  if (Number(row?.is_active ?? 1) === 0) return null;
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") {
    return normalizeTableWorkLock(
      {
        ...parsed,
        tableId: parsed.tableId ?? row?.table_id,
      },
      row?.app_state_position,
    );
  }
  return normalizeTableWorkLock(
    {
      tableId: row?.table_id,
      userId: row?.user_id,
      username: row?.username,
      deviceUuid: row?.device_uuid,
      sessionId: row?.session_id,
      purpose: row?.purpose,
      acquiredAt: row?.acquired_at,
      heartbeatAt: row?.heartbeat_at,
      expiresAt: row?.expires_at,
    },
    row?.app_state_position,
  );
}

function normalizeTableSlot(table, position = 0) {
  if (!table || typeof table !== "object") return null;
  const tableId = normalizeNullableString(table.id ?? table.tableId);
  if (!tableId) return null;
  return {
    tableId,
    appStatePosition: Number.isFinite(Number(position)) ? Number(position) : 0,
  };
}

function extractTableSlots(appState) {
  const tables = Array.isArray(appState?.posSettings?.tables)
    ? appState.posSettings.tables
    : [];
  return tables.map(normalizeTableSlot).filter(Boolean);
}

function buildTableLockTombstone(tableId) {
  const normalizedTableId = normalizeNullableString(tableId);
  if (!normalizedTableId) return null;
  const rawJson = safeJsonStringify(
    { tableId: normalizedTableId, tombstone: true },
    {},
  );
  return {
    tableId: normalizedTableId,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function extractWorkLockRows(appState) {
  const tables = Array.isArray(appState?.posSettings?.tables)
    ? appState.posSettings.tables
    : [];
  return tables
    .map((table, index) =>
      normalizeTableWorkLock(
        {
          ...(table?.workLock && typeof table.workLock === "object"
            ? table.workLock
            : null),
          tableId: table?.id ?? table?.tableId,
        },
        index,
      ),
    )
    .filter(Boolean);
}

export function createMysqlTableLocksRepository(options = {}) {
  const enabled = normalizeBoolean(options.enabled, false);
  const tableName = normalizeIdentifier(
    options.tableName,
    "app_table_work_locks",
  );
  const tableSql = quoteIdentifier(tableName);
  const logger = options.logger ?? console;
  const mysqlRepository = options.mysqlRepository;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const namedLocksEnabled = normalizeBoolean(options.namedLocksEnabled, true);
  const tombstonesEnabled = normalizeBoolean(options.tombstonesEnabled, false);
  const runtimeMetrics = options.runtimeMetrics;
  let ensured = false;
  let tombstoneInventorySignature = null;
  let tombstoneInventorySync = null;

  function metric(name) {
    runtimeMetrics?.incrementCounter?.(name);
  }

  function operation(label, startedAt) {
    runtimeMetrics?.recordOperation?.("tableLockMysql", label, Date.now() - startedAt);
  }

  async function query(sql, params = []) {
    if (!mysqlRepository || typeof mysqlRepository.query !== "function") {
      throw new Error("Repository MySQL non disponibile per table locks.");
    }
    return mysqlRepository.query(sql, params);
  }

  async function withConnection(callback) {
    const pool = await mysqlRepository.getPool();
    const waitStartedAt = Date.now();
    const connection = await pool.getConnection();
    operation("connection.wait", waitStartedAt);
    const holdStartedAt = Date.now();
    try {
      return await callback(connection);
    } finally {
      connection.release();
      operation("connection.hold", holdStartedAt);
    }
  }

  async function ensure() {
    if (!enabled || ensured) return;
    await query(`
      CREATE TABLE IF NOT EXISTS ${tableSql} (
        table_id VARCHAR(191) NOT NULL PRIMARY KEY,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        user_id VARCHAR(96) NOT NULL,
        username VARCHAR(160) NULL,
        device_uuid VARCHAR(160) NULL,
        session_id VARCHAR(96) NULL,
        purpose VARCHAR(96) NULL,
        acquired_at VARCHAR(64) NULL,
        heartbeat_at VARCHAR(64) NULL,
        expires_at VARCHAR(64) NULL,
        expires_at_ms BIGINT NULL,
        app_state_position INT NOT NULL DEFAULT 0,
        row_hash CHAR(64) NOT NULL,
        raw_json JSON NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_app_table_work_locks_user (user_id, session_id, device_uuid),
        INDEX idx_app_table_work_locks_expires (expires_at_ms),
        INDEX idx_app_table_work_locks_position (app_state_position)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const activeColumns = await query(
      `SHOW COLUMNS FROM ${tableSql} LIKE 'is_active'`,
    );
    if (!Array.isArray(activeColumns) || activeColumns.length === 0) {
      try {
        await query(
          `ALTER TABLE ${tableSql} ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER table_id`,
        );
      } catch (error) {
        if (
          String(error?.code ?? "") !== "ER_DUP_FIELDNAME" &&
          Number(error?.errno ?? error?.number ?? 0) !== 1060
        ) {
          throw error;
        }
      }
    }
    ensured = true;
  }

  async function upsertLockWithConnection(connection, lock) {
    const row = normalizeTableWorkLock(
      lock,
      lock?.appStatePosition ?? lock?.app_state_position,
    );
    if (!row) return false;
    await connection.query(
      `
        INSERT INTO ${tableSql} (
          table_id, is_active, user_id, username, device_uuid, session_id, purpose,
          acquired_at, heartbeat_at, expires_at, expires_at_ms,
          app_state_position, row_hash, raw_json
        )
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          is_active = 1,
          user_id = VALUES(user_id),
          username = VALUES(username),
          device_uuid = VALUES(device_uuid),
          session_id = VALUES(session_id),
          purpose = VALUES(purpose),
          acquired_at = VALUES(acquired_at),
          heartbeat_at = VALUES(heartbeat_at),
          expires_at = VALUES(expires_at),
          expires_at_ms = VALUES(expires_at_ms),
          app_state_position = VALUES(app_state_position),
          row_hash = VALUES(row_hash),
          raw_json = VALUES(raw_json)
      `,
      [
        row.tableId,
        row.userId,
        row.username,
        row.deviceUuid,
        row.sessionId,
        row.purpose,
        row.acquiredAt,
        row.heartbeatAt,
        row.expiresAt,
        row.expiresAtMs,
        row.appStatePosition,
        row.rowHash,
        row.rawJson,
      ],
    );
    return true;
  }

  async function seedInitialLockWithConnection(connection, lock) {
    const row = normalizeTableWorkLock(
      lock,
      lock?.appStatePosition ?? lock?.app_state_position,
    );
    if (!row) return false;
    await connection.query(
      `
        INSERT INTO ${tableSql} (
          table_id, is_active, user_id, username, device_uuid, session_id, purpose,
          acquired_at, heartbeat_at, expires_at, expires_at_ms,
          app_state_position, row_hash, raw_json
        )
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          app_state_position = VALUES(app_state_position)
      `,
      [
        row.tableId,
        row.userId,
        row.username,
        row.deviceUuid,
        row.sessionId,
        row.purpose,
        row.acquiredAt,
        row.heartbeatAt,
        row.expiresAt,
        row.expiresAtMs,
        row.appStatePosition,
        row.rowHash,
        row.rawJson,
      ],
    );
    return true;
  }

  async function writeTombstoneWithConnection(connection, tableId) {
    const tombstone = buildTableLockTombstone(tableId);
    if (!tombstone) return false;
    await connection.query(
      `
        UPDATE ${tableSql}
        SET is_active = 0,
            user_id = '',
            username = NULL,
            device_uuid = NULL,
            session_id = NULL,
            purpose = NULL,
            acquired_at = NULL,
            heartbeat_at = NULL,
            expires_at = NULL,
            expires_at_ms = 0,
            row_hash = ?,
            raw_json = ?
        WHERE table_id = ?
      `,
      [tombstone.rowHash, tombstone.rawJson, tombstone.tableId],
    );
    metric("tableLockMysqlTombstoneWrites");
    return true;
  }

  async function seedTombstoneWithConnection(connection, slot) {
    const tombstone = buildTableLockTombstone(slot?.tableId);
    if (!tombstone) return false;
    await connection.query(
      `
        INSERT INTO ${tableSql} (
          table_id, is_active, user_id, username, device_uuid, session_id,
          purpose, acquired_at, heartbeat_at, expires_at, expires_at_ms,
          app_state_position, row_hash, raw_json
        )
        VALUES (?, 0, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          app_state_position = VALUES(app_state_position)
      `,
      [
        tombstone.tableId,
        slot.appStatePosition,
        tombstone.rowHash,
        tombstone.rawJson,
      ],
    );
    return true;
  }

  async function expireStaleLocks(execute = query) {
    if (!tombstonesEnabled) return;
    await execute(
      `
        UPDATE ${tableSql}
        SET is_active = 0,
            user_id = '',
            username = NULL,
            device_uuid = NULL,
            session_id = NULL,
            purpose = NULL,
            acquired_at = NULL,
            heartbeat_at = NULL,
            expires_at = NULL,
            expires_at_ms = 0,
            row_hash = REPEAT('0', 64),
            raw_json = JSON_OBJECT('tableId', table_id, 'tombstone', TRUE)
        WHERE is_active = 1
          AND expires_at_ms IS NOT NULL
          AND expires_at_ms <= ?
      `,
      [Date.now()],
    );
  }

  async function listTableWorkLocks() {
    if (!enabled) return [];
    await ensure();
    const rows = await query(
      `
        SELECT *
        FROM ${tableSql}
        WHERE is_active = 1
        ORDER BY app_state_position ASC, table_id ASC
      `,
    );
    return (Array.isArray(rows) ? rows : [])
      .map(rowToTableWorkLock)
      .filter(Boolean);
  }

  async function getLock(tableId) {
    if (!enabled) return null;
    await ensure();
    const rows = await query(
      `SELECT * FROM ${tableSql} WHERE table_id = ? AND is_active = 1`,
      [String(tableId ?? "").trim()],
    );
    return rowToTableWorkLock(Array.isArray(rows) ? rows[0] : null);
  }

  async function syncFromAppState(appState) {
    if (!enabled || !appState || typeof appState !== "object") return null;
    await ensure();
    const rows = extractWorkLockRows(appState);
    const tableSlots = extractTableSlots(appState);
    const summary = () => ({
      table: tableName,
      rowCount: rows.length,
      tombstoneCount: tombstonesEnabled
        ? Math.max(0, tableSlots.length - rows.length)
        : 0,
      syncedAt: nowIso(),
    });
    if (tombstonesEnabled) {
      const inventorySignature = sha256(
        safeJsonStringify(
          tableSlots.map((slot) => [slot.tableId, slot.appStatePosition]),
          [],
        ),
      );
      while (tombstoneInventorySync) await tombstoneInventorySync;
      if (inventorySignature === tombstoneInventorySignature) {
        await expireStaleLocks();
        return summary();
      }
      const rowsByTableId = new Map(rows.map((row) => [row.tableId, row]));
      const syncTask = withConnection(async (connection) => {
        await connection.beginTransaction();
        try {
          for (const slot of tableSlots) {
            const initialLock = rowsByTableId.get(slot.tableId);
            if (initialLock) {
              await seedInitialLockWithConnection(connection, initialLock);
            } else {
              await seedTombstoneWithConnection(connection, slot);
            }
          }
          await expireStaleLocks((sql, params) => connection.query(sql, params));
          await connection.commit();
        } catch (error) {
          try {
            await connection.rollback();
          } catch {
            // noop
          }
          throw error;
        }
      });
      tombstoneInventorySync = syncTask;
      try {
        await syncTask;
        tombstoneInventorySignature = inventorySignature;
      } finally {
        tombstoneInventorySync = null;
      }
      return summary();
    }
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await connection.query(
          `DELETE FROM ${tableSql} WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?`,
          [Date.now()],
        );
        for (const row of rows) {
          await upsertLockWithConnection(connection, row);
        }
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
    return summary();
  }

  async function hydrateAppState(appState) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    await ensure();
    let rows;
    if (tombstonesEnabled) {
      await syncFromAppState(appState);
      rows = await listTableWorkLocks();
    } else {
      rows = await listTableWorkLocks();
    }
    if (!tombstonesEnabled && rows.length === 0) {
      const seedRows = extractWorkLockRows(appState);
      if (seedRows.length > 0) {
        await syncFromAppState(appState);
        rows = seedRows;
      }
    }
    const hydrated = cloneJson(appState, appState);
    if (!hydrated.posSettings || typeof hydrated.posSettings !== "object") {
      hydrated.posSettings = {};
    }
    const locksByTableId = new Map(rows.map((row) => [row.tableId, row]));
    const tables = Array.isArray(hydrated.posSettings.tables)
      ? hydrated.posSettings.tables
      : [];
    hydrated.posSettings.tables = tables.map((table) => {
      if (!table || typeof table !== "object") return table;
      const tableId = String(table.id ?? table.tableId ?? "").trim();
      const lock = tableId ? locksByTableId.get(tableId) : null;
      return {
        ...table,
        workLock: lock
          ? {
              tableId: lock.tableId,
              userId: lock.userId,
              username: lock.username,
              deviceUuid: lock.deviceUuid,
              sessionId: lock.sessionId,
              purpose: lock.purpose,
              acquiredAt: lock.acquiredAt,
              heartbeatAt: lock.heartbeatAt,
              expiresAt: lock.expiresAt,
            }
          : null,
      };
    });
    return hydrated;
  }

  function stripTableLocksFromAppState(appState, options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    const persisted = cloneJson(appState, appState);
    if (persisted.posSettings && typeof persisted.posSettings === "object") {
      persisted.posSettings.tables = Array.isArray(persisted.posSettings.tables)
        ? persisted.posSettings.tables.map((table) =>
            table && typeof table === "object"
              ? {
                  ...table,
                  workLock: null,
                }
              : table,
          )
        : [];
    }
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains &&
        typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        tableLocks: {
          mode: "externalized",
          storage: "mysql",
          table: tableName,
          domains: ["posSettings.tables.workLock"],
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripTableLocksFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripTableLocksFromAppState(appState, { includeUpdatedAt: false });
  }

  async function mutateTableLock(tableId, callback, mutationOptions = {}) {
    if (!enabled) {
      throw new Error("MySQL table locks non attivi.");
    }
    const safeTableId = String(tableId ?? "").trim();
    if (!safeTableId) throw new Error("tableId non valido.");
    await ensure();
    const mutationStartedAt = Date.now();
    const useNamedLock = namedLocksEnabled && mutationOptions.namedLock !== false;
    metric("tableLockMysqlMutations");
    let lastError = null;
    try {
      for (
        let attempt = 0;
        attempt < TABLE_LOCK_MUTATION_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const attemptStartedAt = Date.now();
        try {
          return await withConnection(async (connection) => {
          const namedLock = lockNameForTable(tableName, safeTableId);
          let namedLockAcquired = false;
          if (useNamedLock) {
            const namedLockStartedAt = Date.now();
            const [lockRows] = await connection.query(
              "SELECT GET_LOCK(?, 3) AS acquired",
              [namedLock],
            );
            operation("namedLock.acquire", namedLockStartedAt);
            namedLockAcquired = Number(lockRows?.[0]?.acquired ?? 0) === 1;
            if (!namedLockAcquired) {
              const error = new Error("Timeout lock SQL del tavolo.");
              error.code = "TABLE_LOCK_SQL_BUSY";
              throw error;
            }
          } else {
            metric("tableLockMysqlNamedLockSkips");
          }
          try {
            const transactionStartedAt = Date.now();
            const beginStartedAt = Date.now();
            await connection.beginTransaction();
            operation("transaction.begin", beginStartedAt);
            const selectStartedAt = Date.now();
            const [rows] = await connection.query(
              `SELECT * FROM ${tableSql} WHERE table_id = ? FOR UPDATE`,
              [safeTableId],
            );
            operation("row.selectForUpdate", selectStartedAt);
            const previousLock = rowToTableWorkLock(
              Array.isArray(rows) ? rows[0] : null,
            );
            const callbackStartedAt = Date.now();
            const result = (await callback(previousLock)) ?? {};
            operation("callback", callbackStartedAt);
            const writeStartedAt = Date.now();
            if (result.delete === true) {
              if (tombstonesEnabled) {
                await writeTombstoneWithConnection(connection, safeTableId);
              } else {
                await connection.query(
                  `DELETE FROM ${tableSql} WHERE table_id = ?`,
                  [safeTableId],
                );
              }
            } else if (result.nextLock) {
              await upsertLockWithConnection(connection, result.nextLock);
            }
            operation("row.write", writeStartedAt);
            const commitStartedAt = Date.now();
            await connection.commit();
            operation("transaction.commit", commitStartedAt);
            operation("transaction.total", transactionStartedAt);
            return {
              previousLock,
              ...result,
            };
          } catch (error) {
            try {
              await connection.rollback();
            } catch {
              // noop
            }
            throw error;
          } finally {
            if (namedLockAcquired) {
              const releaseStartedAt = Date.now();
              await connection
                .query("SELECT RELEASE_LOCK(?)", [namedLock])
                .catch(() => undefined);
              operation("namedLock.release", releaseStartedAt);
            }
          }
          });
        } catch (error) {
          lastError = error;
          if (
            !isRetryableMysqlLockError(error) ||
            attempt >= TABLE_LOCK_MUTATION_MAX_ATTEMPTS - 1
          ) {
            metric("tableLockMysqlErrors");
            throw error;
          }
          metric("tableLockMysqlRetries");
          const backoffStartedAt = Date.now();
          await sleep(Math.min(40 * (attempt + 1) * (attempt + 1), 500));
          operation("retry.backoff", backoffStartedAt);
        } finally {
          operation("attempt.total", attemptStartedAt);
        }
      }
      throw lastError;
    } finally {
      operation("mutation.total", mutationStartedAt);
    }
  }

  function logStatus() {
    if (enabled) {
      logger.info?.(
        `[backend] MySQL table locks puntuali attivi: tabella ${tableName}, named-lock=${namedLocksEnabled ? "on" : "off"}, tombstone=${tombstonesEnabled ? "on" : "off"}`,
      );
    }
  }

  return {
    enabled,
    namedLocksEnabled,
    tombstonesEnabled,
    getLock,
    hydrateAppState,
    listTableWorkLocks,
    logStatus,
    mutateTableLock,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncFromAppState,
    tableName,
  };
}
