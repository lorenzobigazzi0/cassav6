import { runRelationalTransaction } from "./connection.js";

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function optionalString(value) {
  const normalized = asTrimmedString(value);
  return normalized || null;
}

function arrayFrom(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object")
    : [];
}

function stringListFrom(value, fallback = null) {
  const out = [];
  const seen = new Set();
  const add = (entry) => {
    const normalized = optionalString(entry);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };
  if (Array.isArray(value)) value.forEach(add);
  add(fallback);
  return out;
}

function integerOrNull(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
}

function integerOrDefault(value, fallback = 0) {
  const parsed = integerOrNull(value);
  return parsed === null ? fallback : parsed;
}

function positiveInteger(value, fallback = 1) {
  const parsed = integerOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function normalizeStatus(value, fallback = "active") {
  const normalized = asTrimmedString(value).toLowerCase();
  return normalized || fallback;
}

function reservationStatus(reservation) {
  const explicit = normalizeStatus(reservation?.status, "");
  if (explicit) return explicit;
  if (integerOrNull(reservation?.cancelledAt) > 0) return "cancelled";
  if (integerOrNull(reservation?.noShowAt) > 0) return "no_show";
  if (integerOrNull(reservation?.arrivedAt) > 0) return "arrived";
  if (integerOrNull(reservation?.releasedAt) > 0) return "released";
  return "active";
}

function stateKeyFor(roomId, serviceDate, fallback = null) {
  return optionalString(fallback) ?? `${roomId}:${serviceDate}`;
}

function reservationStateVersion(db, roomId, serviceDate) {
  const stateRow = db
    .prepare(
      "SELECT version FROM reservation_state_versions WHERE room_id = ? AND service_date = ?",
    )
    .get(roomId, serviceDate);
  const persistedVersion = integerOrNull(stateRow?.version);
  if (persistedVersion !== null && persistedVersion > 0)
    return persistedVersion;
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM reservations WHERE room_id = ? AND service_date = ?",
    )
    .get(roomId, serviceDate);
  return Math.max(1, integerOrDefault(row?.revision, 0));
}

function persistReservationStateVersion(db, input = {}) {
  const roomId = optionalString(input.roomId);
  const serviceDate = optionalString(input.serviceDate);
  const version = positiveInteger(input.version, 1);
  if (!roomId || !serviceDate) return false;
  db.prepare(
    `
      INSERT INTO reservation_state_versions (
        room_id, service_date, state_key, version
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id, service_date) DO UPDATE SET
        state_key = COALESCE(excluded.state_key, reservation_state_versions.state_key),
        version = MAX(reservation_state_versions.version, excluded.version)
    `,
  ).run(roomId, serviceDate, optionalString(input.stateKey), version);
  return true;
}

function replayMarkersMatch(current, incoming) {
  const currentRequestId = optionalString(current?.offlineReplay?.requestId);
  const currentIdempotencyKey = optionalString(
    current?.offlineReplay?.idempotencyKey,
  );
  const incomingRequestId = optionalString(incoming?.offlineReplay?.requestId);
  const incomingIdempotencyKey = optionalString(
    incoming?.offlineReplay?.idempotencyKey,
  );
  return Boolean(
    currentRequestId &&
    currentIdempotencyKey &&
    currentRequestId === incomingRequestId &&
    currentIdempotencyKey === incomingIdempotencyKey,
  );
}

function mapReservationToRelationalRows(state, reservation, index = 0) {
  const roomId =
    optionalString(reservation?.roomId) ?? optionalString(state?.roomId);
  const serviceDate =
    optionalString(reservation?.serviceDate) ??
    optionalString(state?.serviceDate);
  if (!roomId || !serviceDate) return null;
  const id =
    optionalString(reservation?.id) ??
    `res_${roomId}_${serviceDate}_${index + 1}`;
  const assignedTableIds = stringListFrom(
    reservation?.assignedTableIds,
    reservation?.assignedTableId,
  );
  const rawReservation = {
    ...reservation,
    roomId,
    serviceDate,
    assignedTableId: assignedTableIds[0] ?? null,
    assignedTableIds,
  };
  const reservationRow = {
    id,
    roomId,
    serviceDate,
    stateKey: stateKeyFor(roomId, serviceDate, state?.key),
    reservationAtMs: integerOrDefault(reservation?.reservationAt, 0),
    customerName: asTrimmedString(reservation?.customerName),
    customerPhone: optionalString(reservation?.customerPhone),
    covers: positiveInteger(reservation?.covers, 0),
    status: reservationStatus(reservation),
    intolerances: optionalString(reservation?.intolerances),
    note: optionalString(reservation?.note),
    assignedTableId: assignedTableIds[0] ?? null,
    createdAtMs: integerOrNull(reservation?.createdAt),
    updatedAtMs: integerOrNull(reservation?.updatedAt),
    releasedAtMs: integerOrNull(reservation?.releasedAt),
    arrivedAtMs: integerOrNull(reservation?.arrivedAt),
    noShowAtMs: integerOrNull(reservation?.noShowAt),
    cancelledAtMs: integerOrNull(reservation?.cancelledAt),
    revision: positiveInteger(reservation?.revision ?? state?.version, 1),
    rawJson: stringifyJson(rawReservation, {}),
  };
  const assignments = assignedTableIds.map((tableId, position) => ({
    reservationId: id,
    tableId,
    position,
    rawJson: stringifyJson({ reservationId: id, tableId, position }, {}),
  }));
  return { reservation: reservationRow, assignments };
}

function mapReservationLockToRelationalRow(lock, knownReservationIds) {
  if (!lock || typeof lock !== "object") return null;
  const reservationId = optionalString(lock.reservationId);
  if (!reservationId || !knownReservationIds.has(reservationId)) return null;
  const lockId = optionalString(lock.lockId);
  const userId = optionalString(lock.userId);
  const deviceUuid = optionalString(lock.deviceUuid);
  if (!lockId || !userId || !deviceUuid) return null;
  const expiresAtMs = integerOrDefault(lock.expiresAt, 0);
  if (expiresAtMs <= 0) return null;
  return {
    reservationId,
    lockId,
    userId,
    deviceUuid,
    expiresAtMs,
    revision: positiveInteger(lock.revision, 1),
    rawJson: stringifyJson(lock, {}),
  };
}

function mapRoomChangeRequestToRelationalRow(entry, index = 0) {
  if (!entry || typeof entry !== "object") return null;
  const requestId =
    optionalString(entry.requestId ?? entry.id) ?? `room_change_${index + 1}`;
  return {
    requestId,
    userId: optionalString(entry.userId),
    sessionId: optionalString(entry.sessionId),
    deviceUuid: optionalString(entry.deviceUuid),
    targetRoomId: optionalString(entry.targetRoomId),
    targetRoomName: optionalString(entry.targetRoomName),
    status: normalizeStatus(entry.status, "pending"),
    createdAtMs: integerOrNull(entry.createdAt),
    expiresAtMs: integerOrNull(entry.expiresAt),
    approvedAtMs: integerOrNull(entry.approvedAt),
    cancelledAtMs: integerOrNull(entry.cancelledAt),
    revision: positiveInteger(entry.revision, 1),
    rawJson: stringifyJson(entry, {}),
  };
}

function mapTableRoomMoveRequestToRelationalRow(entry, index = 0) {
  if (!entry || typeof entry !== "object") return null;
  const requestId =
    optionalString(entry.requestId ?? entry.id) ??
    `table_room_move_${index + 1}`;
  const targetTableIds = stringListFrom(
    entry.targetTableIds ?? entry.toTableIds,
  );
  const targetTableLabels = stringListFrom(entry.targetTableLabels);
  return {
    requestId,
    requesterUserId: optionalString(entry.requesterUserId),
    requesterUsername: optionalString(entry.requesterUsername),
    requesterFullName: optionalString(entry.requesterFullName),
    requesterDeviceUuid: optionalString(entry.requesterDeviceUuid),
    fromRoomId: optionalString(entry.fromRoomId),
    fromRoomName: optionalString(entry.fromRoomName),
    targetRoomId: optionalString(entry.targetRoomId),
    targetRoomName: optionalString(entry.targetRoomName),
    fromTableId: optionalString(entry.fromTableId),
    fromTableLabel: optionalString(entry.fromTableLabel),
    targetTableIdsJson: stringifyJson(targetTableIds, []),
    targetTableLabelsJson: stringifyJson(targetTableLabels, []),
    sourceLeafCount: integerOrNull(entry.sourceLeafCount),
    targetTableCount: integerOrNull(entry.targetTableCount),
    adjustCoversDelta: integerOrNull(entry.adjustCoversDelta),
    status: normalizeStatus(entry.status, "pending"),
    createdAtMs: integerOrNull(entry.createdAt),
    expiresAtMs: integerOrNull(entry.expiresAt),
    approvedAtMs: integerOrNull(entry.approvedAt),
    rejectedAtMs: integerOrNull(entry.rejectedAt),
    resolvedByUserId: optionalString(
      entry.resolvedByUserId ?? entry.approverUserId,
    ),
    resolvedByUsername: optionalString(
      entry.resolvedByUsername ?? entry.approverUsername,
    ),
    revision: positiveInteger(entry.revision, 1),
    rawJson: stringifyJson(entry, {}),
  };
}

export function buildReservationsRelationalRows(appState) {
  const reservations = [];
  const assignments = [];
  const locks = [];
  const reservationStateVersionsByKey = new Map();
  const roomChangeRequests = arrayFrom(appState?.posRoomChangeRequests)
    .map((entry, index) => mapRoomChangeRequestToRelationalRow(entry, index))
    .filter((row) => row !== null);
  const tableRoomMoveRequests = arrayFrom(appState?.posTableRoomMoveRequests)
    .map((entry, index) => mapTableRoomMoveRequestToRelationalRow(entry, index))
    .filter((row) => row !== null);

  const recordStateVersion = (state, minimumVersion = 1) => {
    const roomId = optionalString(state?.roomId);
    const serviceDate = optionalString(state?.serviceDate);
    if (!roomId || !serviceDate) return;
    const key = `${roomId}\u0000${serviceDate}`;
    const current = reservationStateVersionsByKey.get(key);
    const version = Math.max(
      positiveInteger(state?.version, 1),
      positiveInteger(minimumVersion, 1),
      positiveInteger(current?.version, 1),
    );
    reservationStateVersionsByKey.set(key, {
      roomId,
      serviceDate,
      stateKey:
        optionalString(state?.key) ??
        current?.stateKey ??
        stateKeyFor(roomId, serviceDate),
      version,
    });
  };

  arrayFrom(appState?.posReservationStates).forEach((state) => {
    recordStateVersion(state);
    arrayFrom(state?.reservations).forEach((reservation, index) => {
      const mapped = mapReservationToRelationalRows(state, reservation, index);
      if (!mapped) return;
      reservations.push(mapped.reservation);
      assignments.push(...mapped.assignments);
      recordStateVersion(
        {
          roomId: mapped.reservation.roomId,
          serviceDate: mapped.reservation.serviceDate,
          key: mapped.reservation.stateKey,
          version: state?.version,
        },
        mapped.reservation.revision,
      );
    });
  });

  const knownReservationIds = new Set(reservations.map((row) => row.id));
  arrayFrom(appState?.posReservationLocks)
    .map((lock) => mapReservationLockToRelationalRow(lock, knownReservationIds))
    .filter((row) => row !== null)
    .forEach((row) => locks.push(row));

  return {
    reservationStateVersions: [...reservationStateVersionsByKey.values()],
    reservations,
    assignments,
    locks,
    roomChangeRequests,
    tableRoomMoveRequests,
  };
}

export class ReservationsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  getRoomChangeRequest(requestId) {
    const row = this.db
      .prepare("SELECT * FROM room_change_requests WHERE request_id = ?")
      .get(asTrimmedString(requestId));
    return row ? this.#hydrateRoomChangeRequest(row) : null;
  }

  listReservations(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "room_id", filters.roomId);
    this.#appendFilter(clauses, params, "service_date", filters.serviceDate);
    this.#appendFilter(clauses, params, "status", filters.status);
    const tableId = optionalString(filters.tableId);
    if (tableId) {
      clauses.push(
        "id IN (SELECT reservation_id FROM reservation_table_assignments WHERE table_id = ?)",
      );
      params.push(tableId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM reservations${where} ORDER BY service_date ASC, room_id ASC, reservation_at_ms ASC, id ASC`,
      )
      .all(...params)
      .map((row) => this.#hydrateReservation(row));
  }

  getReservation(reservationId) {
    const row = this.db
      .prepare("SELECT * FROM reservations WHERE id = ?")
      .get(asTrimmedString(reservationId));
    return row ? this.#hydrateReservation(row) : null;
  }

  getReservationStateVersion(roomId, serviceDate) {
    const normalizedRoomId = optionalString(roomId);
    const normalizedServiceDate = optionalString(serviceDate);
    if (!normalizedRoomId || !normalizedServiceDate) return 1;
    return reservationStateVersion(
      this.db,
      normalizedRoomId,
      normalizedServiceDate,
    );
  }

  listAssignments(reservationId) {
    return this.db
      .prepare(
        "SELECT * FROM reservation_table_assignments WHERE reservation_id = ? ORDER BY position ASC, table_id ASC",
      )
      .all(asTrimmedString(reservationId))
      .map((row) => this.#hydrateAssignment(row));
  }

  getReservationLock(reservationId) {
    const row = this.db
      .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
      .get(asTrimmedString(reservationId));
    return row ? this.#hydrateLock(row) : null;
  }

  createReservation(input = {}) {
    const reservation =
      input.reservation && typeof input.reservation === "object"
        ? input.reservation
        : null;
    const reservationId = optionalString(reservation?.id);
    const roomId = optionalString(input.roomId ?? reservation?.roomId);
    const serviceDate = optionalString(
      input.serviceDate ?? reservation?.serviceDate,
    );
    const expectedVersion =
      input.expectedVersion === undefined || input.expectedVersion === null
        ? null
        : integerOrNull(input.expectedVersion);
    if (!reservation || !reservationId || !roomId || !serviceDate) {
      return { ok: false, reason: "invalid" };
    }
    if (expectedVersion !== null && expectedVersion < 1) {
      return { ok: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT id FROM reservations WHERE id = ?")
        .get(reservationId);
      if (existing) return { ok: false, reason: "exists" };
      const currentVersion = reservationStateVersion(
        this.db,
        roomId,
        serviceDate,
      );
      if (expectedVersion !== null && currentVersion !== expectedVersion) {
        return {
          ok: false,
          reason: "version_conflict",
          version: currentVersion,
        };
      }
      const nextRevision =
        Math.max(currentVersion, integerOrDefault(input.baseVersion, 0)) + 1;
      const mapped = mapReservationToRelationalRows(
        {
          key: input.stateKey,
          roomId,
          serviceDate,
          version: nextRevision,
        },
        {
          ...reservation,
          id: reservationId,
          roomId,
          serviceDate,
          revision: nextRevision,
        },
        0,
      );
      if (!mapped) return { ok: false, reason: "invalid" };
      this.#insertReservation(mapped.reservation);
      for (const assignment of mapped.assignments)
        this.#insertAssignment(assignment);
      persistReservationStateVersion(this.db, {
        roomId,
        serviceDate,
        stateKey: mapped.reservation.stateKey,
        version: nextRevision,
      });
      return {
        ok: true,
        version: nextRevision,
        reservation: this.getReservation(reservationId),
      };
    });
  }

  acquireReservationLock(input = {}) {
    const reservationId = optionalString(input.reservationId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const requestedLockId = optionalString(input.lockId);
    const nowMs = integerOrDefault(input.nowMs, Date.now());
    const expiresAtMs = integerOrDefault(input.expiresAtMs, nowMs);
    if (
      !reservationId ||
      !userId ||
      !deviceUuid ||
      !requestedLockId ||
      expiresAtMs <= nowMs
    ) {
      return { ok: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const reservation = this.db
        .prepare("SELECT id FROM reservations WHERE id = ?")
        .get(reservationId);
      if (!reservation) return { ok: false, reason: "missing" };
      const currentRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const current = currentRow ? this.#hydrateLock(currentRow) : null;
      const active = current && Number(current.expiresAt) > nowMs;
      if (
        active &&
        (current.userId !== userId || current.deviceUuid !== deviceUuid)
      ) {
        return { ok: false, reason: "conflict", lock: current };
      }
      const lock = {
        reservationId,
        lockId: active && current?.lockId ? current.lockId : requestedLockId,
        userId,
        deviceUuid,
        expiresAtMs,
        revision: positiveInteger(current?.revision, 0) + 1,
        rawJson: stringifyJson(
          {
            reservationId,
            lockId:
              active && current?.lockId ? current.lockId : requestedLockId,
            userId,
            deviceUuid,
            expiresAt: expiresAtMs,
          },
          {},
        ),
      };
      this.db
        .prepare(
          `
            INSERT INTO reservation_locks (
              reservation_id, lock_id, user_id, device_uuid, expires_at_ms,
              revision, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(reservation_id) DO UPDATE SET
              lock_id = excluded.lock_id,
              user_id = excluded.user_id,
              device_uuid = excluded.device_uuid,
              expires_at_ms = excluded.expires_at_ms,
              revision = reservation_locks.revision + 1,
              raw_json = excluded.raw_json
          `,
        )
        .run(
          lock.reservationId,
          lock.lockId,
          lock.userId,
          lock.deviceUuid,
          lock.expiresAtMs,
          lock.revision,
          lock.rawJson,
        );
      return { ok: true, lock: this.getReservationLock(reservationId) };
    });
  }

  releaseReservationLock(input = {}) {
    const reservationId = optionalString(input.reservationId);
    const lockId = optionalString(input.lockId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const nowMs = integerOrDefault(input.nowMs, Date.now());
    if (!reservationId || !lockId || !userId || !deviceUuid) {
      return { ok: false, released: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const current = currentRow ? this.#hydrateLock(currentRow) : null;
      if (!current) return { ok: true, released: false };
      if (Number(current.expiresAt) <= nowMs) {
        this.db
          .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
          .run(reservationId);
        return { ok: true, released: false, expired: true };
      }
      const matches =
        current.lockId === lockId &&
        current.userId === userId &&
        current.deviceUuid === deviceUuid;
      if (!matches) return { ok: true, released: false, lock: current };
      this.db
        .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
        .run(reservationId);
      return { ok: true, released: true };
    });
  }

  deleteReservationWithLock(input = {}) {
    const reservationId = optionalString(input.reservationId);
    const lockId = optionalString(input.lockId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const nowMs = integerOrDefault(input.nowMs, Date.now());
    if (!reservationId || !lockId || !userId || !deviceUuid) {
      return { ok: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db
        .prepare("SELECT * FROM reservations WHERE id = ?")
        .get(reservationId);
      if (!currentRow) return { ok: false, reason: "missing" };
      const lockRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const lock = lockRow ? this.#hydrateLock(lockRow) : null;
      if (!lock || Number(lock.expiresAt) <= nowMs) {
        if (lock)
          this.db
            .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
            .run(reservationId);
        return { ok: false, reason: "lock_missing" };
      }
      if (
        lock.lockId !== lockId ||
        lock.userId !== userId ||
        lock.deviceUuid !== deviceUuid
      ) {
        return { ok: false, reason: "lock_conflict", lock };
      }
      const deletedReservation = this.#hydrateReservation(currentRow);
      const nextRevision =
        reservationStateVersion(
          this.db,
          currentRow.room_id,
          currentRow.service_date,
        ) + 1;
      this.db
        .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
        .run(reservationId);
      this.db
        .prepare(
          "DELETE FROM reservation_table_assignments WHERE reservation_id = ?",
        )
        .run(reservationId);
      const deleted = this.db
        .prepare("DELETE FROM reservations WHERE id = ? AND revision = ?")
        .run(reservationId, currentRow.revision);
      if (deleted.changes !== 1)
        return { ok: false, reason: "revision_conflict" };
      persistReservationStateVersion(this.db, {
        roomId: currentRow.room_id,
        serviceDate: currentRow.service_date,
        stateKey: currentRow.state_key,
        version: nextRevision,
      });
      return {
        ok: true,
        deleted: true,
        version: nextRevision,
        reservation: deletedReservation,
      };
    });
  }

  updateReservationWithLock(input = {}) {
    const reservationId = optionalString(
      input.reservationId ?? input.reservation?.id,
    );
    const lockId = optionalString(input.lockId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const nowMs = integerOrDefault(input.nowMs, Date.now());
    if (
      !reservationId ||
      !lockId ||
      !userId ||
      !deviceUuid ||
      !input.reservation
    ) {
      return { ok: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db
        .prepare("SELECT * FROM reservations WHERE id = ?")
        .get(reservationId);
      if (!currentRow) return { ok: false, reason: "missing" };
      const lockRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const lock = lockRow ? this.#hydrateLock(lockRow) : null;
      if (!lock || Number(lock.expiresAt) <= nowMs) {
        if (lock)
          this.db
            .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
            .run(reservationId);
        return { ok: false, reason: "lock_missing" };
      }
      if (
        lock.lockId !== lockId ||
        lock.userId !== userId ||
        lock.deviceUuid !== deviceUuid
      ) {
        return { ok: false, reason: "lock_conflict", lock };
      }
      const nextRevision =
        reservationStateVersion(
          this.db,
          currentRow.room_id,
          currentRow.service_date,
        ) + 1;
      const mapped = mapReservationToRelationalRows(
        {
          key: currentRow.state_key,
          roomId: currentRow.room_id,
          serviceDate: currentRow.service_date,
          version: nextRevision,
        },
        {
          ...input.reservation,
          id: reservationId,
          roomId: currentRow.room_id,
          serviceDate: currentRow.service_date,
          revision: nextRevision,
        },
        0,
      );
      if (!mapped) return { ok: false, reason: "invalid" };
      const row = mapped.reservation;
      const updated = this.db
        .prepare(
          `
            UPDATE reservations SET
              reservation_at_ms = ?,
              customer_name = ?,
              customer_phone = ?,
              covers = ?,
              status = ?,
              intolerances = ?,
              note = ?,
              assigned_table_id = ?,
              updated_at_ms = ?,
              revision = ?,
              raw_json = ?
            WHERE id = ? AND revision = ?
          `,
        )
        .run(
          row.reservationAtMs,
          row.customerName,
          row.customerPhone,
          row.covers,
          row.status,
          row.intolerances,
          row.note,
          row.assignedTableId,
          row.updatedAtMs,
          nextRevision,
          row.rawJson,
          row.id,
          currentRow.revision,
        );
      if (updated.changes !== 1)
        return { ok: false, reason: "revision_conflict" };
      this.db
        .prepare(
          "DELETE FROM reservation_table_assignments WHERE reservation_id = ?",
        )
        .run(reservationId);
      for (const assignment of mapped.assignments)
        this.#insertAssignment(assignment);
      persistReservationStateVersion(this.db, {
        roomId: currentRow.room_id,
        serviceDate: currentRow.service_date,
        stateKey: currentRow.state_key,
        version: nextRevision,
      });
      return {
        ok: true,
        version: nextRevision,
        reservation: this.getReservation(reservationId),
      };
    });
  }

  updateReservationFromOfflineReplay(input = {}) {
    const reservation =
      input.reservation && typeof input.reservation === "object"
        ? input.reservation
        : null;
    const reservationId = optionalString(
      input.reservationId ?? reservation?.id,
    );
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const expectedVersion = integerOrNull(input.expectedVersion);
    const expectedUpdatedAt = integerOrNull(input.expectedUpdatedAt);
    if (
      !reservation ||
      !reservationId ||
      !userId ||
      !deviceUuid ||
      expectedVersion === null ||
      expectedVersion < 1 ||
      expectedUpdatedAt === null ||
      expectedUpdatedAt < 1
    ) {
      return { ok: false, reason: "invalid" };
    }

    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db
        .prepare("SELECT * FROM reservations WHERE id = ?")
        .get(reservationId);
      if (!currentRow) return { ok: false, reason: "missing" };
      const current = this.#hydrateReservation(currentRow);
      const currentVersion = reservationStateVersion(
        this.db,
        currentRow.room_id,
        currentRow.service_date,
      );
      if (replayMarkersMatch(current, reservation)) {
        return {
          ok: true,
          replayed: true,
          version: currentVersion,
          reservation: current,
        };
      }
      if (currentVersion !== expectedVersion) {
        return {
          ok: false,
          reason: "version_conflict",
          version: currentVersion,
        };
      }
      if (Number(currentRow.updated_at_ms) !== expectedUpdatedAt) {
        return {
          ok: false,
          reason: "precondition_conflict",
          reservation: current,
        };
      }
      const lockRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const lock = lockRow ? this.#hydrateLock(lockRow) : null;
      const activeLock = lock && Number(lock.expiresAt) > Date.now();
      if (
        activeLock &&
        (lock.userId !== userId || lock.deviceUuid !== deviceUuid)
      ) {
        return { ok: false, reason: "lock_conflict", lock };
      }

      const nextRevision = expectedVersion + 1;
      const mapped = mapReservationToRelationalRows(
        {
          key: currentRow.state_key,
          roomId: currentRow.room_id,
          serviceDate: currentRow.service_date,
          version: nextRevision,
        },
        {
          ...reservation,
          id: reservationId,
          roomId: currentRow.room_id,
          serviceDate: currentRow.service_date,
          revision: nextRevision,
        },
        0,
      );
      if (!mapped) return { ok: false, reason: "invalid" };
      const row = mapped.reservation;
      const updated = this.db
        .prepare(
          `
            UPDATE reservations SET
              reservation_at_ms = ?,
              customer_name = ?,
              customer_phone = ?,
              covers = ?,
              status = ?,
              intolerances = ?,
              note = ?,
              assigned_table_id = ?,
              updated_at_ms = ?,
              released_at_ms = ?,
              arrived_at_ms = ?,
              no_show_at_ms = ?,
              cancelled_at_ms = ?,
              revision = ?,
              raw_json = ?
            WHERE id = ? AND revision = ? AND updated_at_ms = ?
          `,
        )
        .run(
          row.reservationAtMs,
          row.customerName,
          row.customerPhone,
          row.covers,
          row.status,
          row.intolerances,
          row.note,
          row.assignedTableId,
          row.updatedAtMs,
          row.releasedAtMs,
          row.arrivedAtMs,
          row.noShowAtMs,
          row.cancelledAtMs,
          nextRevision,
          row.rawJson,
          row.id,
          currentRow.revision,
          expectedUpdatedAt,
        );
      if (updated.changes !== 1)
        return { ok: false, reason: "revision_conflict" };
      this.db
        .prepare(
          "DELETE FROM reservation_table_assignments WHERE reservation_id = ?",
        )
        .run(reservationId);
      for (const assignment of mapped.assignments)
        this.#insertAssignment(assignment);
      if (input.releaseLock === true) {
        this.db
          .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
          .run(reservationId);
      }
      persistReservationStateVersion(this.db, {
        roomId: currentRow.room_id,
        serviceDate: currentRow.service_date,
        stateKey: currentRow.state_key,
        version: nextRevision,
      });
      return {
        ok: true,
        version: nextRevision,
        reservation: this.getReservation(reservationId),
      };
    });
  }

  deleteReservationFromOfflineReplay(input = {}) {
    const reservationId = optionalString(input.reservationId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const expectedVersion = integerOrNull(input.expectedVersion);
    const expectedUpdatedAt = integerOrNull(input.expectedUpdatedAt);
    if (
      !reservationId ||
      !userId ||
      !deviceUuid ||
      expectedVersion === null ||
      expectedVersion < 1 ||
      expectedUpdatedAt === null ||
      expectedUpdatedAt < 1
    ) {
      return { ok: false, reason: "invalid" };
    }

    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db
        .prepare("SELECT * FROM reservations WHERE id = ?")
        .get(reservationId);
      if (!currentRow) return { ok: false, reason: "missing" };
      const currentVersion = reservationStateVersion(
        this.db,
        currentRow.room_id,
        currentRow.service_date,
      );
      if (currentVersion !== expectedVersion) {
        return {
          ok: false,
          reason: "version_conflict",
          version: currentVersion,
        };
      }
      if (Number(currentRow.updated_at_ms) !== expectedUpdatedAt) {
        return { ok: false, reason: "precondition_conflict" };
      }
      const lockRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const lock = lockRow ? this.#hydrateLock(lockRow) : null;
      const activeLock = lock && Number(lock.expiresAt) > Date.now();
      if (
        activeLock &&
        (lock.userId !== userId || lock.deviceUuid !== deviceUuid)
      ) {
        return { ok: false, reason: "lock_conflict", lock };
      }
      const deleted = this.db
        .prepare(
          "DELETE FROM reservations WHERE id = ? AND revision = ? AND updated_at_ms = ?",
        )
        .run(reservationId, currentRow.revision, expectedUpdatedAt);
      if (deleted.changes !== 1)
        return { ok: false, reason: "revision_conflict" };
      this.db
        .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
        .run(reservationId);
      this.db
        .prepare(
          "DELETE FROM reservation_table_assignments WHERE reservation_id = ?",
        )
        .run(reservationId);
      const nextRevision = expectedVersion + 1;
      persistReservationStateVersion(this.db, {
        roomId: currentRow.room_id,
        serviceDate: currentRow.service_date,
        stateKey: currentRow.state_key,
        version: nextRevision,
      });
      return {
        ok: true,
        deleted: true,
        version: nextRevision,
      };
    });
  }

  updateReservationStatus(input = {}) {
    const reservationId = optionalString(input.reservationId);
    const status = normalizeStatus(input.status, "");
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const nowMs = integerOrDefault(input.nowMs, Date.now());
    if (
      !reservationId ||
      !userId ||
      !deviceUuid ||
      !["arrived", "no_show", "released", "cancelled"].includes(status)
    ) {
      return { ok: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db
        .prepare("SELECT * FROM reservations WHERE id = ?")
        .get(reservationId);
      if (!currentRow) return { ok: false, reason: "missing" };
      const lockRow = this.db
        .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
        .get(reservationId);
      const lock = lockRow ? this.#hydrateLock(lockRow) : null;
      const activeLock = lock && Number(lock.expiresAt) > nowMs;
      if (
        activeLock &&
        (lock.userId !== userId || lock.deviceUuid !== deviceUuid)
      ) {
        return { ok: false, reason: "lock_conflict", lock };
      }
      const current = this.#hydrateReservation(currentRow);
      const nextRevision =
        reservationStateVersion(
          this.db,
          currentRow.room_id,
          currentRow.service_date,
        ) + 1;
      const mapped = mapReservationToRelationalRows(
        {
          key: currentRow.state_key,
          roomId: currentRow.room_id,
          serviceDate: currentRow.service_date,
          version: nextRevision,
        },
        {
          ...current,
          ...(input.reservation && typeof input.reservation === "object"
            ? input.reservation
            : {}),
          status,
          releasedAt: current.releasedAt || nowMs,
          updatedAt: nowMs,
          ...(status === "arrived" ? { arrivedAt: nowMs } : {}),
          ...(status === "no_show" ? { noShowAt: nowMs } : {}),
          ...(status === "cancelled" ? { cancelledAt: nowMs } : {}),
          revision: nextRevision,
        },
        0,
      );
      if (!mapped) return { ok: false, reason: "invalid" };
      const row = mapped.reservation;
      const updated = this.db
        .prepare(
          `
            UPDATE reservations SET
              status = ?,
              updated_at_ms = ?,
              released_at_ms = ?,
              arrived_at_ms = ?,
              no_show_at_ms = ?,
              cancelled_at_ms = ?,
              revision = ?,
              raw_json = ?
            WHERE id = ? AND revision = ?
          `,
        )
        .run(
          row.status,
          row.updatedAtMs,
          row.releasedAtMs,
          row.arrivedAtMs,
          row.noShowAtMs,
          row.cancelledAtMs,
          nextRevision,
          row.rawJson,
          row.id,
          currentRow.revision,
        );
      if (updated.changes !== 1)
        return { ok: false, reason: "revision_conflict" };
      this.db
        .prepare("DELETE FROM reservation_locks WHERE reservation_id = ?")
        .run(reservationId);
      persistReservationStateVersion(this.db, {
        roomId: currentRow.room_id,
        serviceDate: currentRow.service_date,
        stateKey: currentRow.state_key,
        version: nextRevision,
      });
      return {
        ok: true,
        version: nextRevision,
        reservation: this.getReservation(reservationId),
      };
    });
  }

  transferReservationTableAssignments(input = {}, options = {}) {
    const fromTableId = optionalString(input.fromTableId);
    const toTableId = optionalString(input.toTableId);
    const reservationIds = [
      ...new Set(
        (Array.isArray(input.reservationIds)
          ? input.reservationIds
          : [input.reservationId]
        )
          .map(optionalString)
          .filter(Boolean),
      ),
    ];
    const nowMs = integerOrDefault(input.nowMs, Date.now());
    if (
      !fromTableId ||
      !toTableId ||
      fromTableId === toTableId ||
      reservationIds.length === 0 ||
      nowMs <= 0
    ) {
      return { ok: false, reason: "invalid" };
    }

    const operation = () => {
      const rows = reservationIds.map((reservationId) => ({
        reservationId,
        row: this.db
          .prepare("SELECT * FROM reservations WHERE id = ?")
          .get(reservationId),
      }));
      const missing = rows.find((entry) => !entry.row);
      if (missing) {
        return {
          ok: false,
          reason: "missing",
          reservationId: missing.reservationId,
        };
      }

      const targetConflict = this.db
        .prepare(
          `
            SELECT r.id
            FROM reservations r
            JOIN reservation_table_assignments a
              ON a.reservation_id = r.id
            WHERE a.table_id = ?
              AND r.id NOT IN (${reservationIds.map(() => "?").join(", ")})
              AND LOWER(r.status) NOT IN ('arrived', 'no_show', 'cancelled', 'released')
            LIMIT 1
          `,
        )
        .get(toTableId, ...reservationIds);
      if (targetConflict) {
        return {
          ok: false,
          reason: "target_conflict",
          reservationId: targetConflict.id,
        };
      }

      const plans = [];
      const nextVersionByState = new Map();
      for (const { reservationId, row } of rows) {
        const current = this.#hydrateReservation(row);
        const currentAssignedTableIds = stringListFrom(
          current.assignedTableIds,
          current.assignedTableId,
        );
        if (!currentAssignedTableIds.includes(fromTableId)) {
          return {
            ok: false,
            reason: "source_assignment_missing",
            reservationId,
          };
        }
        const assignedTableIds = stringListFrom(
          currentAssignedTableIds.map((tableId) =>
            tableId === fromTableId ? toTableId : tableId,
          ),
        );
        const stateVersionKey = `${row.room_id}\u0000${row.service_date}`;
        const currentStateVersion =
          nextVersionByState.get(stateVersionKey)?.version ??
          reservationStateVersion(this.db, row.room_id, row.service_date);
        const nextRevision = currentStateVersion + 1;
        nextVersionByState.set(stateVersionKey, {
          roomId: row.room_id,
          serviceDate: row.service_date,
          stateKey: row.state_key,
          version: nextRevision,
        });
        const mapped = mapReservationToRelationalRows(
          {
            key: row.state_key,
            roomId: row.room_id,
            serviceDate: row.service_date,
            version: nextRevision,
          },
          {
            ...current,
            assignedTableId: assignedTableIds[0] ?? null,
            assignedTableIds,
            updatedAt: nowMs,
            revision: nextRevision,
          },
          0,
        );
        if (!mapped) {
          return { ok: false, reason: "invalid", reservationId };
        }
        plans.push({
          reservationId,
          currentRevision: row.revision,
          mapped,
          nextRevision,
        });
      }

      for (const plan of plans) {
        const row = plan.mapped.reservation;
        const updated = this.db
          .prepare(
            `
              UPDATE reservations SET
                assigned_table_id = ?,
                updated_at_ms = ?,
                revision = ?,
                raw_json = ?
              WHERE id = ? AND revision = ?
            `,
          )
          .run(
            row.assignedTableId,
            row.updatedAtMs,
            plan.nextRevision,
            row.rawJson,
            row.id,
            plan.currentRevision,
          );
        if (updated.changes !== 1) {
          const error = new Error("Conflitto revisione prenotazione.");
          error.code = "RESERVATION_ASSIGNMENT_REVISION_CONFLICT";
          error.reservationId = plan.reservationId;
          throw error;
        }
        this.db
          .prepare(
            "DELETE FROM reservation_table_assignments WHERE reservation_id = ?",
          )
          .run(plan.reservationId);
        for (const assignment of plan.mapped.assignments) {
          this.#insertAssignment(assignment);
        }
      }

      for (const stateVersion of nextVersionByState.values()) {
        persistReservationStateVersion(this.db, stateVersion);
      }

      return {
        ok: true,
        stateVersions: [...nextVersionByState.values()],
        reservations: reservationIds.map((reservationId) =>
          this.getReservation(reservationId),
        ),
      };
    };
    try {
      return options.transaction === false
        ? operation()
        : runRelationalTransaction(this.db, operation);
    } catch (error) {
      if (error?.code === "RESERVATION_ASSIGNMENT_REVISION_CONFLICT") {
        return {
          ok: false,
          reason: "revision_conflict",
          reservationId: error.reservationId,
        };
      }
      throw error;
    }
  }

  listRoomChangeRequests(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "user_id", filters.userId);
    this.#appendFilter(clauses, params, "status", filters.status);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM room_change_requests${where} ORDER BY created_at_ms ASC, request_id ASC`,
      )
      .all(...params)
      .map((row) => this.#hydrateRoomChangeRequest(row));
  }

  createRoomChangeRequest(entry = {}, options = {}) {
    const row = mapRoomChangeRequestToRelationalRow(entry);
    if (
      !row?.requestId ||
      !row.userId ||
      !row.deviceUuid ||
      !row.targetRoomId
    ) {
      return { ok: false, reason: "invalid" };
    }
    const operation = () => {
      const current = this.db
        .prepare("SELECT * FROM room_change_requests WHERE request_id = ?")
        .get(row.requestId);
      if (current && options.allowExisting !== true) {
        return {
          ok: false,
          reason: "exists",
          request: this.#hydrateRoomChangeRequest(current),
        };
      }
      this.#insertRoomChangeRequest(row);
      return { ok: true, request: this.getRoomChangeRequest(row.requestId) };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  deleteRoomChangeRequest(input = {}, options = {}) {
    const requestId = optionalString(input.requestId);
    const expectedRevision =
      input.expectedRevision === undefined
        ? null
        : positiveInteger(input.expectedRevision, 1);
    if (!requestId) return { ok: false, reason: "invalid" };
    const operation = () => {
      const current = this.db
        .prepare("SELECT * FROM room_change_requests WHERE request_id = ?")
        .get(requestId);
      if (!current) return { ok: false, reason: "missing" };
      if (
        expectedRevision !== null &&
        positiveInteger(current.revision, 1) !== expectedRevision
      ) {
        return {
          ok: false,
          reason: "revision_conflict",
          request: this.#hydrateRoomChangeRequest(current),
        };
      }
      this.db
        .prepare("DELETE FROM room_change_requests WHERE request_id = ?")
        .run(requestId);
      return { ok: true, request: this.#hydrateRoomChangeRequest(current) };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  listTableRoomMoveRequests(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "target_room_id", filters.targetRoomId);
    this.#appendFilter(clauses, params, "status", filters.status);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM table_room_move_requests${where} ORDER BY created_at_ms ASC, request_id ASC`,
      )
      .all(...params)
      .map((row) => this.#hydrateTableRoomMoveRequest(row));
  }

  getTableRoomMoveRequest(requestId) {
    const row = this.db
      .prepare("SELECT * FROM table_room_move_requests WHERE request_id = ?")
      .get(asTrimmedString(requestId));
    return row ? this.#hydrateTableRoomMoveRequest(row) : null;
  }

  createTableRoomMoveRequest(entry = {}, options = {}) {
    const row = mapTableRoomMoveRequestToRelationalRow(entry);
    if (
      !row?.requestId ||
      !row.requesterUserId ||
      !row.requesterDeviceUuid ||
      !row.targetRoomId ||
      !row.fromTableId
    ) {
      return { ok: false, reason: "invalid" };
    }
    const operation = () => {
      const current = this.db
        .prepare("SELECT * FROM table_room_move_requests WHERE request_id = ?")
        .get(row.requestId);
      if (current && options.allowExisting !== true) {
        return {
          ok: false,
          reason: "exists",
          request: this.#hydrateTableRoomMoveRequest(current),
        };
      }
      this.#insertTableRoomMoveRequest(row);
      return { ok: true, request: this.getTableRoomMoveRequest(row.requestId) };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  resolveTableRoomMoveRequest(input = {}, options = {}) {
    const requestId = optionalString(input.requestId);
    const status = normalizeStatus(input.status, "approved");
    const resolvedAtMs = integerOrDefault(input.resolvedAt, Date.now());
    const resolvedByUserId = optionalString(
      input.resolvedByUserId ?? input.approverUserId,
    );
    const resolvedByUsername = optionalString(
      input.resolvedByUsername ?? input.approverUsername,
    );
    if (
      !requestId ||
      !["approved", "rejected", "timeout_approved"].includes(status)
    )
      return { ok: false, reason: "invalid" };
    const operation = () => {
      const currentRow = this.db
        .prepare("SELECT * FROM table_room_move_requests WHERE request_id = ?")
        .get(requestId);
      if (!currentRow) return { ok: false, reason: "missing" };
      const current = this.#hydrateTableRoomMoveRequest(currentRow);
      if (current.status !== "pending")
        return { ok: true, changed: false, request: current };
      const nextRevision = positiveInteger(currentRow.revision, 1) + 1;
      const row = mapTableRoomMoveRequestToRelationalRow({
        ...current,
        status,
        approvedAt:
          status === "approved" || status === "timeout_approved"
            ? resolvedAtMs
            : current.approvedAt,
        rejectedAt: status === "rejected" ? resolvedAtMs : current.rejectedAt,
        resolvedByUserId,
        resolvedByUsername,
        approverUserId: resolvedByUserId,
        approverUsername: resolvedByUsername,
        revision: nextRevision,
      });
      if (!row) return { ok: false, reason: "invalid" };
      const updated = this.db
        .prepare(
          `
        UPDATE table_room_move_requests SET
          status = ?,
          approved_at_ms = ?,
          rejected_at_ms = ?,
          resolved_by_user_id = ?,
          resolved_by_username = ?,
          revision = revision + 1,
          raw_json = ?
        WHERE request_id = ? AND status = 'pending' AND revision = ?
      `,
        )
        .run(
          row.status,
          row.approvedAtMs,
          row.rejectedAtMs,
          row.resolvedByUserId,
          row.resolvedByUsername,
          row.rawJson,
          row.requestId,
          currentRow.revision,
        );
      if (updated.changes !== 1)
        return {
          ok: false,
          reason: "revision_conflict",
          request: this.getTableRoomMoveRequest(requestId),
        };
      return {
        ok: true,
        changed: true,
        request: this.getTableRoomMoveRequest(requestId),
      };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  replaceAllFromAppState(appState, options = {}) {
    const rows = buildReservationsRelationalRows(appState);
    const operation = () => {
      this.#deleteAll();
      for (const row of rows.reservationStateVersions)
        this.#insertReservationStateVersion(row);
      for (const row of rows.reservations) this.#insertReservation(row);
      for (const row of rows.assignments) this.#insertAssignment(row);
      for (const row of rows.locks) this.#insertLock(row);
      for (const row of rows.roomChangeRequests)
        this.#insertRoomChangeRequest(row);
      for (const row of rows.tableRoomMoveRequests)
        this.#insertTableRoomMoveRequest(row);
      return rows;
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  #appendFilter(clauses, params, columnName, value) {
    const normalized = optionalString(value);
    if (!normalized) return;
    clauses.push(`${columnName} = ?`);
    params.push(normalized);
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM reservation_locks").run();
    this.db.prepare("DELETE FROM reservation_table_assignments").run();
    this.db.prepare("DELETE FROM reservations").run();
    this.db.prepare("DELETE FROM reservation_state_versions").run();
    this.db.prepare("DELETE FROM room_change_requests").run();
    this.db.prepare("DELETE FROM table_room_move_requests").run();
  }

  #insertReservationStateVersion(row) {
    this.db
      .prepare(
        `
          INSERT INTO reservation_state_versions (
            room_id, service_date, state_key, version
          ) VALUES (?, ?, ?, ?)
        `,
      )
      .run(row.roomId, row.serviceDate, row.stateKey, row.version);
  }

  #insertReservation(row) {
    this.db
      .prepare(
        `
          INSERT INTO reservations (
            id, room_id, service_date, state_key, reservation_at_ms,
            customer_name, customer_phone, covers, status, intolerances, note,
            assigned_table_id, created_at_ms, updated_at_ms, released_at_ms,
            arrived_at_ms, no_show_at_ms, cancelled_at_ms, revision, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        row.id,
        row.roomId,
        row.serviceDate,
        row.stateKey,
        row.reservationAtMs,
        row.customerName,
        row.customerPhone,
        row.covers,
        row.status,
        row.intolerances,
        row.note,
        row.assignedTableId,
        row.createdAtMs,
        row.updatedAtMs,
        row.releasedAtMs,
        row.arrivedAtMs,
        row.noShowAtMs,
        row.cancelledAtMs,
        row.revision,
        row.rawJson,
      );
  }

  #insertAssignment(row) {
    this.db
      .prepare(
        `
          INSERT INTO reservation_table_assignments (
            reservation_id, table_id, position, raw_json
          ) VALUES (?, ?, ?, ?)
        `,
      )
      .run(row.reservationId, row.tableId, row.position, row.rawJson);
  }

  #insertLock(row) {
    this.db
      .prepare(
        `
          INSERT INTO reservation_locks (
            reservation_id, lock_id, user_id, device_uuid, expires_at_ms,
            revision, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        row.reservationId,
        row.lockId,
        row.userId,
        row.deviceUuid,
        row.expiresAtMs,
        row.revision,
        row.rawJson,
      );
  }

  #insertRoomChangeRequest(row) {
    this.db
      .prepare(
        `
          INSERT INTO room_change_requests (
            request_id, user_id, session_id, device_uuid, target_room_id,
            target_room_name, status, created_at_ms, expires_at_ms,
            approved_at_ms, cancelled_at_ms, revision, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        row.requestId,
        row.userId,
        row.sessionId,
        row.deviceUuid,
        row.targetRoomId,
        row.targetRoomName,
        row.status,
        row.createdAtMs,
        row.expiresAtMs,
        row.approvedAtMs,
        row.cancelledAtMs,
        row.revision,
        row.rawJson,
      );
  }

  #insertTableRoomMoveRequest(row) {
    this.db
      .prepare(
        `
          INSERT INTO table_room_move_requests (
            request_id, requester_user_id, requester_username,
            requester_full_name, requester_device_uuid, from_room_id,
            from_room_name, target_room_id, target_room_name, from_table_id,
            from_table_label, target_table_ids_json, target_table_labels_json,
            source_leaf_count, target_table_count, adjust_covers_delta, status,
            created_at_ms, expires_at_ms, approved_at_ms, rejected_at_ms,
            resolved_by_user_id, resolved_by_username, revision, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        row.requestId,
        row.requesterUserId,
        row.requesterUsername,
        row.requesterFullName,
        row.requesterDeviceUuid,
        row.fromRoomId,
        row.fromRoomName,
        row.targetRoomId,
        row.targetRoomName,
        row.fromTableId,
        row.fromTableLabel,
        row.targetTableIdsJson,
        row.targetTableLabelsJson,
        row.sourceLeafCount,
        row.targetTableCount,
        row.adjustCoversDelta,
        row.status,
        row.createdAtMs,
        row.expiresAtMs,
        row.approvedAtMs,
        row.rejectedAtMs,
        row.resolvedByUserId,
        row.resolvedByUsername,
        row.revision,
        row.rawJson,
      );
  }

  #hydrateReservation(row) {
    const raw = safeJsonParse(row.raw_json, {});
    const assignmentIds = this.listAssignments(row.id).map(
      (entry) => entry.tableId,
    );
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      roomId: row.room_id,
      serviceDate: row.service_date,
      reservationAt: row.reservation_at_ms,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      covers: row.covers,
      status: row.status,
      intolerances: row.intolerances,
      note: row.note,
      assignedTableId: row.assigned_table_id,
      assignedTableIds: assignmentIds,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
      releasedAt: row.released_at_ms,
      arrivedAt: row.arrived_at_ms,
      noShowAt: row.no_show_at_ms,
      cancelledAt: row.cancelled_at_ms,
      revision: row.revision,
    };
  }

  #hydrateAssignment(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      reservationId: row.reservation_id,
      tableId: row.table_id,
      position: row.position,
    };
  }

  #hydrateLock(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      reservationId: row.reservation_id,
      lockId: row.lock_id,
      userId: row.user_id,
      deviceUuid: row.device_uuid,
      expiresAt: row.expires_at_ms,
      revision: row.revision,
    };
  }

  #hydrateRoomChangeRequest(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      requestId: row.request_id,
      userId: row.user_id,
      sessionId: row.session_id,
      deviceUuid: row.device_uuid,
      targetRoomId: row.target_room_id,
      targetRoomName: row.target_room_name,
      status: row.status,
      createdAt: row.created_at_ms,
      expiresAt: row.expires_at_ms,
      approvedAt: row.approved_at_ms,
      cancelledAt: row.cancelled_at_ms,
      revision: row.revision,
    };
  }

  #hydrateTableRoomMoveRequest(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      requestId: row.request_id,
      requesterUserId: row.requester_user_id,
      requesterUsername: row.requester_username,
      requesterFullName: row.requester_full_name,
      requesterDeviceUuid: row.requester_device_uuid,
      fromRoomId: row.from_room_id,
      fromRoomName: row.from_room_name,
      targetRoomId: row.target_room_id,
      targetRoomName: row.target_room_name,
      fromTableId: row.from_table_id,
      fromTableLabel: row.from_table_label,
      targetTableIds: safeJsonParse(row.target_table_ids_json, []),
      targetTableLabels: safeJsonParse(row.target_table_labels_json, []),
      sourceLeafCount: row.source_leaf_count,
      targetTableCount: row.target_table_count,
      adjustCoversDelta: row.adjust_covers_delta,
      status: row.status,
      createdAt: row.created_at_ms,
      expiresAt: row.expires_at_ms,
      approvedAt: row.approved_at_ms,
      rejectedAt: row.rejected_at_ms,
      resolvedByUserId: row.resolved_by_user_id,
      resolvedByUsername: row.resolved_by_username,
      approverUserId: row.resolved_by_user_id,
      approverUsername: row.resolved_by_username,
      revision: row.revision,
    };
  }
}
