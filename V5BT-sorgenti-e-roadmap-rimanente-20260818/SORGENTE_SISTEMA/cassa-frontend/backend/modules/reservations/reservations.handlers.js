import { ReservationsRelationalRepository } from "../../db/relational/index.js";

export function createReservationsHandlers({
  HttpError,
  POS_RESERVATION_LOCK_TTL_MS,
  applyPosReservationStatusToAssignedTables,
  assertPosReservationAssignable,
  buildPosAvailabilityLabel,
  clonePosReservation,
  findPosRoomById,
  findPosNearestReservation,
  getOrCreatePosReservationState,
  normalizePosReservationSaveInput,
  nowIso,
  pruneExpiredPosReservationLocks,
  readDb,
  readHeaderValue,
  readJsonBody,
  relationalReservationsCreateWritePrimary = false,
  relationalReservationsDeleteWritePrimary = false,
  relationalReservationsLockAcquireWritePrimary = false,
  relationalReservationsLockReleaseWritePrimary = false,
  relationalReservationsReadEnabled = false,
  relationalReservationsStatusWritePrimary = false,
  relationalReservationsUpdateWritePrimary = false,
  relationalRuntime = null,
  requirePosReservationWritableLock,
  resolvePosReservationId,
  resolvePosReservationServiceDate,
  resolvePosRoomSessionContext,
  sendJson,
  toPosReservationId,
  toPosReservationLockId,
  validateSessionContext,
  writeDb,
}) {
  const RESERVATION_STATE_SPLIT_DOMAINS = [
    "posReservationStates",
    "posReservations",
  ];
  const RESERVATION_LOCK_SPLIT_DOMAINS = ["posReservationLocks"];
  const RESERVATION_STATE_LOCK_SPLIT_DOMAINS = [
    "posReservationStates",
    "posReservations",
    "posReservationLocks",
  ];
  const RESERVATION_TABLE_STATUS_SPLIT_DOMAINS = [
    ...RESERVATION_STATE_LOCK_SPLIT_DOMAINS,
    "posSettings",
    "integration",
    "tableLocks",
  ];
  const OFFLINE_REPLAY_CONFLICT_CODE = "RESERVATION_OFFLINE_REPLAY_CONFLICT";

  function normalizedReplayIdentifier(value) {
    return String(value ?? "")
      .trim()
      .slice(0, 160);
  }

  function readDeviceQueueContext(req) {
    const deviceQueue =
      normalizedReplayIdentifier(
        readHeaderValue?.(req, "x-palmare-device-queue"),
      ) === "1";
    const replay =
      normalizedReplayIdentifier(
        readHeaderValue?.(req, "x-palmare-offline-replay"),
      ) === "1";
    if (!deviceQueue) {
      if (replay) {
        throw new HttpError(
          400,
          "Replay offline non autenticato dalla coda dispositivo.",
        );
      }
      return null;
    }
    const requestId = normalizedReplayIdentifier(
      readHeaderValue?.(req, "x-command-request-id"),
    );
    const idempotencyKey = normalizedReplayIdentifier(
      readHeaderValue?.(req, "x-idempotency-key"),
    );
    if (!requestId || !idempotencyKey) {
      if (replay) {
        throw new HttpError(400, "Identita replay offline non valida.");
      }
      return null;
    }
    return { requestId, idempotencyKey, replay };
  }

  function positiveReplayInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function requireOfflineReplayContract(payload, context, options = {}) {
    if (!context?.replay) return null;
    const expectedVersion = positiveReplayInteger(payload.expectedVersion);
    const expectedUpdatedAt = options.requireUpdatedAt
      ? positiveReplayInteger(payload.expectedUpdatedAt)
      : null;
    const resultUpdatedAt = options.requireResultUpdatedAt
      ? positiveReplayInteger(payload.resultUpdatedAt)
      : null;
    const clientCreatedAt = options.requireClientCreatedAt
      ? positiveReplayInteger(payload.clientCreatedAt)
      : null;
    if (
      !expectedVersion ||
      (options.requireUpdatedAt && !expectedUpdatedAt) ||
      (options.requireResultUpdatedAt && !resultUpdatedAt) ||
      (options.requireClientCreatedAt && !clientCreatedAt)
    ) {
      throw new HttpError(
        409,
        "Snapshot prenotazioni offline privo di precondizioni valide.",
        {
          code: OFFLINE_REPLAY_CONFLICT_CODE,
        },
      );
    }
    return {
      expectedVersion,
      expectedUpdatedAt,
      resultUpdatedAt,
      clientCreatedAt,
    };
  }

  function replayMarker(context) {
    return context
      ? { requestId: context.requestId, idempotencyKey: context.idempotencyKey }
      : null;
  }

  function reservationHasReplayMarker(reservation, context) {
    return Boolean(
      context &&
      reservation?.offlineReplay?.requestId === context.requestId &&
      reservation?.offlineReplay?.idempotencyKey === context.idempotencyKey,
    );
  }

  function assertOfflineReplayPreconditions(state, reservation, contract) {
    if (!contract) return;
    if (
      Number(state?.version) !== contract.expectedVersion ||
      (reservation &&
        Number(reservation.updatedAt) !== contract.expectedUpdatedAt)
    ) {
      throw new HttpError(
        409,
        "Prenotazione modificata dopo lo snapshot offline.",
        {
          code: OFFLINE_REPLAY_CONFLICT_CODE,
        },
      );
    }
  }

  function assertNoForeignReservationLock(db, reservationId, user, session) {
    pruneExpiredPosReservationLocks(db);
    const activeLock =
      db.posReservationLocks.find(
        (entry) => entry.reservationId === reservationId,
      ) ?? null;
    if (
      activeLock &&
      (activeLock.userId !== user.id ||
        activeLock.deviceUuid !== session.deviceUuid)
    ) {
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    }
  }

  function reservationWriteOptions(metricLabel, splitDomains, punctual = {}) {
    return { metricLabel, splitDomains, ...punctual };
  }

  function readRelationalReservationState(roomId, serviceDate) {
    if (!relationalReservationsReadEnabled || !relationalRuntime?.db)
      return null;
    try {
      const repository = new ReservationsRelationalRepository(
        relationalRuntime.db,
      );
      const reservations = repository
        .listReservations({ roomId, serviceDate })
        .map(clonePosReservation);
      const version = repository.getReservationStateVersion(
        roomId,
        serviceDate,
      );
      return { roomId, serviceDate, version, reservations };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[reservations] read-primary relazionale fallback: ${message}`,
      );
      return null;
    }
  }

  function readRelationalReservationStateForWrite(roomId, serviceDate) {
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const repository = new ReservationsRelationalRepository(
      relationalRuntime.db,
    );
    const reservations = repository.listReservations({ roomId, serviceDate });
    const version = repository.getReservationStateVersion(roomId, serviceDate);
    return { roomId, serviceDate, version, reservations };
  }

  function readRelationalReservationLock(reservationId) {
    if (!relationalReservationsReadEnabled || !relationalRuntime?.db)
      return null;
    try {
      const lock = new ReservationsRelationalRepository(
        relationalRuntime.db,
      ).getReservationLock(reservationId);
      if (!lock || Number(lock.expiresAt) <= Date.now())
        return { checked: true, lock: null };
      return { checked: true, lock };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[reservations] lock read-primary relazionale fallback: ${message}`,
      );
      return null;
    }
  }

  function createRelationalReservation({
    reservation,
    roomId,
    serviceDate,
    stateKey,
    baseVersion,
    expectedVersion,
  }) {
    if (!relationalReservationsCreateWritePrimary) return null;
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).createReservation({
      reservation,
      roomId,
      serviceDate,
      stateKey,
      baseVersion,
      expectedVersion,
    });
    if (result?.ok) return result;
    if (result?.reason === "exists")
      throw new HttpError(409, "Prenotazione gia presente.");
    if (result?.reason === "version_conflict") {
      throw new HttpError(
        409,
        "Configurazione prenotazioni cambiata dopo lo snapshot offline.",
        {
          code: OFFLINE_REPLAY_CONFLICT_CODE,
        },
      );
    }
    throw new HttpError(400, "Prenotazione non valida.");
  }

  function acquireRelationalReservationLock({
    reservationId,
    user,
    session,
    now,
  }) {
    if (!relationalReservationsLockAcquireWritePrimary) return null;
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).acquireReservationLock({
      reservationId,
      lockId: toPosReservationLockId(),
      userId: user.id,
      deviceUuid: session.deviceUuid,
      nowMs: now,
      expiresAtMs: now + POS_RESERVATION_LOCK_TTL_MS,
    });
    if (result?.ok) {
      return {
        reservationId,
        lockId: result.lock.lockId,
        userId: result.lock.userId,
        deviceUuid: result.lock.deviceUuid,
        expiresAt: result.lock.expiresAt,
      };
    }
    if (result?.reason === "missing") {
      throw new HttpError(404, "Prenotazione non trovata.");
    }
    if (result?.reason === "conflict") {
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    }
    throw new HttpError(400, "Blocco modifica non valido.");
  }

  function mirrorReservationLockToAppState(db, reservationId, lock, now) {
    pruneExpiredPosReservationLocks(db, now);
    const index = db.posReservationLocks.findIndex(
      (entry) => entry.reservationId === reservationId,
    );
    if (index >= 0) db.posReservationLocks[index] = lock;
    else db.posReservationLocks.push(lock);
  }

  function releaseRelationalReservationLock({
    reservationId,
    lockId,
    user,
    session,
  }) {
    if (!relationalReservationsLockReleaseWritePrimary) return null;
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).releaseReservationLock({
      reservationId,
      lockId,
      userId: user.id,
      deviceUuid: session.deviceUuid,
      nowMs: Date.now(),
    });
    if (result?.ok) return result;
    throw new HttpError(400, "Blocco modifica non valido.");
  }

  function deleteRelationalReservationWithLock({
    reservationId,
    lockId,
    user,
    session,
    now,
  }) {
    if (!relationalReservationsDeleteWritePrimary) return null;
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).deleteReservationWithLock({
      reservationId,
      lockId,
      userId: user.id,
      deviceUuid: session.deviceUuid,
      nowMs: now,
    });
    if (result?.ok) return result;
    if (result?.reason === "missing")
      throw new HttpError(404, "Prenotazione non trovata.");
    if (result?.reason === "lock_missing")
      throw new HttpError(
        409,
        "Blocco modifica scaduto. Riapri la prenotazione.",
      );
    if (result?.reason === "lock_conflict")
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    if (result?.reason === "revision_conflict")
      throw new HttpError(
        409,
        "Prenotazione modificata da un altro dispositivo. Riapri e riprova.",
      );
    throw new HttpError(400, "Prenotazione non valida.");
  }

  function updateRelationalReservationWithLock({
    reservation,
    lockId,
    user,
    session,
    now,
  }) {
    if (!relationalReservationsUpdateWritePrimary) return null;
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).updateReservationWithLock({
      reservationId: reservation.id,
      reservation,
      lockId,
      userId: user.id,
      deviceUuid: session.deviceUuid,
      nowMs: now,
    });
    if (result?.ok) return result;
    if (result?.reason === "missing")
      throw new HttpError(404, "Prenotazione non trovata.");
    if (result?.reason === "lock_missing")
      throw new HttpError(
        409,
        "Blocco modifica scaduto. Riapri la prenotazione.",
      );
    if (result?.reason === "lock_conflict")
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    if (result?.reason === "revision_conflict")
      throw new HttpError(
        409,
        "Prenotazione modificata da un altro dispositivo. Riapri e riprova.",
      );
    throw new HttpError(400, "Prenotazione non valida.");
  }

  function updateRelationalReservationStatus({
    reservationId,
    status,
    user,
    session,
    now,
    reservation,
  }) {
    if (!relationalReservationsStatusWritePrimary) return null;
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).updateReservationStatus({
      reservationId,
      status,
      userId: user.id,
      deviceUuid: session.deviceUuid,
      nowMs: now,
      reservation,
    });
    if (result?.ok) return result;
    if (result?.reason === "missing")
      throw new HttpError(404, "Prenotazione non trovata.");
    if (result?.reason === "lock_conflict")
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    if (result?.reason === "revision_conflict")
      throw new HttpError(
        409,
        "Prenotazione modificata da un altro dispositivo. Riapri e riprova.",
      );
    throw new HttpError(400, "Stato prenotazione non valido.");
  }

  function updateRelationalReservationFromOfflineReplay({
    reservation,
    contract,
    user,
    session,
    releaseLock = false,
  }) {
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).updateReservationFromOfflineReplay({
      reservation,
      expectedVersion: contract.expectedVersion,
      expectedUpdatedAt: contract.expectedUpdatedAt,
      userId: user.id,
      deviceUuid: session.deviceUuid,
      releaseLock,
    });
    if (result?.ok) return result;
    if (result?.reason === "missing")
      throw new HttpError(404, "Prenotazione non trovata.");
    if (result?.reason === "lock_conflict") {
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    }
    if (
      result?.reason === "version_conflict" ||
      result?.reason === "precondition_conflict" ||
      result?.reason === "revision_conflict"
    ) {
      throw new HttpError(
        409,
        "Prenotazione modificata dopo lo snapshot offline.",
        {
          code: OFFLINE_REPLAY_CONFLICT_CODE,
        },
      );
    }
    throw new HttpError(400, "Replay prenotazione non valido.");
  }

  function deleteRelationalReservationFromOfflineReplay({
    reservationId,
    contract,
    user,
    session,
  }) {
    if (!relationalRuntime?.db) {
      throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
    }
    const result = new ReservationsRelationalRepository(
      relationalRuntime.db,
    ).deleteReservationFromOfflineReplay({
      reservationId,
      expectedVersion: contract.expectedVersion,
      expectedUpdatedAt: contract.expectedUpdatedAt,
      userId: user.id,
      deviceUuid: session.deviceUuid,
    });
    if (result?.ok) return result;
    if (result?.reason === "missing")
      return { ok: true, deleted: true, replayed: true };
    if (result?.reason === "lock_conflict") {
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    }
    if (
      result?.reason === "version_conflict" ||
      result?.reason === "precondition_conflict" ||
      result?.reason === "revision_conflict"
    ) {
      throw new HttpError(
        409,
        "Prenotazione modificata dopo lo snapshot offline.",
        {
          code: OFFLINE_REPLAY_CONFLICT_CODE,
        },
      );
    }
    throw new HttpError(400, "Replay eliminazione prenotazione non valido.");
  }

  function mirrorReservationWriteToAppState(
    db,
    roomId,
    serviceDate,
    reservation,
    revision,
    baseReservations = [],
  ) {
    const { state } = getOrCreatePosReservationState(db, roomId, serviceDate);
    const upsert = (entry) => {
      if (!entry || typeof entry !== "object") return;
      const mirror = { ...entry };
      delete mirror.revision;
      const index = state.reservations.findIndex(
        (candidate) => candidate.id === mirror.id,
      );
      if (index >= 0) state.reservations[index] = mirror;
      else state.reservations.push(mirror);
    };
    baseReservations.forEach(upsert);
    upsert(reservation);
    state.version = Math.max(
      Number(state.version) || 0,
      Number(revision) || 0,
      (Number(state.version) || 0) + 1,
    );
    return state;
  }

  function mirrorReservationDeleteToAppState(
    db,
    roomId,
    serviceDate,
    reservationId,
    revision,
    baseReservations = [],
  ) {
    const { state } = getOrCreatePosReservationState(db, roomId, serviceDate);
    const base = Array.isArray(baseReservations) ? baseReservations : [];
    if (base.length > 0) {
      state.reservations = base
        .filter((entry) => entry?.id !== reservationId)
        .map((entry) => {
          const mirror = { ...entry };
          delete mirror.revision;
          return mirror;
        });
    } else {
      state.reservations = state.reservations.filter(
        (entry) => entry.id !== reservationId,
      );
    }
    state.version = Math.max(
      Number(state.version) || 0,
      Number(revision) || 0,
      (Number(state.version) || 0) + 1,
    );
    return state;
  }

  async function persistReservationCreate({
    db,
    roomId,
    serviceDate,
    reservation,
    state,
    relationalState,
    replayContract,
  }) {
    if (relationalReservationsCreateWritePrimary) {
      const result = createRelationalReservation({
        reservation,
        roomId,
        serviceDate,
        stateKey: state.key,
        baseVersion: Math.max(
          Number(state.version) || 0,
          Number(relationalState?.version) || 0,
        ),
        expectedVersion: replayContract?.expectedVersion,
      });
      const mirrorState = mirrorReservationWriteToAppState(
        db,
        roomId,
        serviceDate,
        result?.reservation ?? reservation,
        result?.version ?? result?.reservation?.revision,
        relationalState?.reservations ?? [],
      );
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.create.appStateWrite",
          RESERVATION_STATE_SPLIT_DOMAINS,
          { reservationStateKeys: [mirrorState.key] },
        ),
      );
      return {
        version: mirrorState.version,
        reservation: clonePosReservation(result?.reservation ?? reservation),
      };
    }
    state.reservations.push(reservation);
    state.version += 1;
    db.meta.lastWriteAt = nowIso();
    await writeDb(
      db,
      reservationWriteOptions(
        "reservations.create.appStateWrite",
        RESERVATION_STATE_SPLIT_DOMAINS,
        { reservationStateKeys: [state.key] },
      ),
    );
    return {
      version: state.version,
      reservation: clonePosReservation(reservation),
    };
  }

  function resolvePublicReservationRoom(db, payload) {
    const roomId = String(payload.roomId ?? "").trim();
    if (!roomId) {
      throw new HttpError(400, "Sala prenotazione non valida.");
    }
    const room = findPosRoomById(db.posSettings, roomId);
    if (!room) {
      throw new HttpError(404, "Sala non trovata.");
    }
    return { roomId, room };
  }

  function findReservationState(db, roomId, serviceDate) {
    return (
      (Array.isArray(db.posReservationStates)
        ? db.posReservationStates
        : []
      ).find(
        (entry) =>
          String(entry?.roomId ?? "").trim() === roomId &&
          String(entry?.serviceDate ?? "").trim() === serviceDate,
      ) ?? null
    );
  }

  function sortedPublicReservations(state) {
    return [...(Array.isArray(state?.reservations) ? state.reservations : [])]
      .sort(
        (left, right) =>
          Number(left.reservationAt) - Number(right.reservationAt),
      )
      .map(clonePosReservation)
      .filter((entry) => entry !== null);
  }

  async function handlePosReservationsList(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);

    const state =
      readRelationalReservationState(roomId, serviceDate) ??
      findReservationState(db, roomId, serviceDate);
    const sorted = [
      ...(Array.isArray(state?.reservations) ? state.reservations : []),
    ]
      .sort((left, right) => left.reservationAt - right.reservationAt)
      .map(clonePosReservation);

    sendJson(res, 200, {
      ok: true,
      version: Number.isFinite(Number(state?.version))
        ? Number(state.version)
        : 0,
      reservations: sorted,
    });
  }

  async function handlePosReservationsCreate(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);
    const queueContext = readDeviceQueueContext(req);
    const replayContract = requireOfflineReplayContract(payload, queueContext, {
      requireClientCreatedAt: true,
    });
    const { state } = getOrCreatePosReservationState(db, roomId, serviceDate);
    const relationalState = relationalReservationsCreateWritePrimary
      ? readRelationalReservationStateForWrite(roomId, serviceDate)
      : null;
    const validationState = relationalState ?? state;
    const requestedReservationId = String(
      payload.clientReservationId ?? "",
    ).trim();
    const clientReservationId = /^res_[a-zA-Z0-9_-]{8,120}$/.test(
      requestedReservationId,
    )
      ? requestedReservationId
      : "";
    if (queueContext?.replay && !clientReservationId) {
      throw new HttpError(409, "Identita prenotazione offline non valida.", {
        code: OFFLINE_REPLAY_CONFLICT_CODE,
      });
    }
    const existingReservation = clientReservationId
      ? (validationState.reservations.find(
          (entry) => entry.id === clientReservationId,
        ) ?? null)
      : null;
    if (existingReservation) {
      if (reservationHasReplayMarker(existingReservation, queueContext)) {
        sendJson(res, 200, {
          ok: true,
          version: validationState.version,
          reservation: clonePosReservation(existingReservation),
          replayed: true,
        });
        return;
      }
      throw new HttpError(409, "Prenotazione gia presente.");
    }
    assertOfflineReplayPreconditions(validationState, null, replayContract);
    const normalized = normalizePosReservationSaveInput(payload);
    normalized.assignedTableIds.forEach((tableId) => {
      assertPosReservationAssignable(
        validationState.reservations,
        normalized.reservationAt,
        tableId,
      );
    });

    const clientCreatedAt = positiveReplayInteger(payload.clientCreatedAt);
    const now = queueContext && clientCreatedAt ? clientCreatedAt : Date.now();
    const reservation = {
      id: clientReservationId || toPosReservationId(),
      roomId,
      serviceDate,
      reservationAt: normalized.reservationAt,
      customerName: normalized.customerName,
      customerPhone: normalized.customerPhone,
      covers: normalized.covers,
      intolerances: normalized.intolerances,
      note: normalized.note,
      assignedTableId: normalized.assignedTableId,
      assignedTableIds: normalized.assignedTableIds,
      createdAt: now,
      updatedAt: now,
      ...(queueContext ? { offlineReplay: replayMarker(queueContext) } : {}),
    };
    const persisted = await persistReservationCreate({
      db,
      roomId,
      serviceDate,
      reservation,
      state,
      relationalState,
      replayContract,
    });

    sendJson(res, 200, {
      ok: true,
      version: persisted.version,
      reservation: persisted.reservation,
    });
  }

  async function handlePosReservationsLockAcquire(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session, roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);
    const reservationId = resolvePosReservationId(payload);
    const { state, created } = getOrCreatePosReservationState(
      db,
      roomId,
      serviceDate,
    );

    const reservation = state.reservations.find(
      (entry) => entry.id === reservationId,
    );
    if (!reservation) {
      throw new HttpError(404, "Prenotazione non trovata.");
    }

    const now = Date.now();
    const relationalLock = acquireRelationalReservationLock({
      reservationId,
      user,
      session,
      now,
    });
    if (relationalLock) {
      mirrorReservationLockToAppState(db, reservationId, relationalLock, now);
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.lock.appStateWrite",
          RESERVATION_LOCK_SPLIT_DOMAINS,
        ),
      );
      sendJson(res, 200, { ok: true, lock: relationalLock });
      return;
    }

    pruneExpiredPosReservationLocks(db, now);
    const activeLock =
      db.posReservationLocks.find(
        (entry) => entry.reservationId === reservationId,
      ) ?? null;
    if (
      activeLock &&
      (activeLock.userId !== user.id ||
        activeLock.deviceUuid !== session.deviceUuid)
    ) {
      throw new HttpError(
        409,
        "Prenotazione in modifica da un altro operatore.",
      );
    }

    const lock = {
      reservationId,
      lockId: activeLock?.lockId || toPosReservationLockId(),
      userId: user.id,
      deviceUuid: session.deviceUuid,
      expiresAt: now + POS_RESERVATION_LOCK_TTL_MS,
    };
    if (activeLock) {
      const lockIndex = db.posReservationLocks.findIndex(
        (entry) => entry.reservationId === reservationId,
      );
      if (lockIndex >= 0) {
        db.posReservationLocks[lockIndex] = lock;
      }
    } else {
      db.posReservationLocks.push(lock);
    }

    db.meta.lastWriteAt = nowIso();
    await writeDb(
      db,
      reservationWriteOptions(
        "reservations.lock.appStateWrite",
        RESERVATION_LOCK_SPLIT_DOMAINS,
      ),
    );

    sendJson(res, 200, {
      ok: true,
      lock,
    });
  }

  async function handlePosReservationsLockRelease(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    const reservationId = String(payload.reservationId ?? "").trim();
    const lockId = String(payload.lockId ?? "").trim();
    if (!reservationId || !lockId) {
      sendJson(res, 200, { ok: true, released: false });
      return;
    }

    const relationalRelease = releaseRelationalReservationLock({
      reservationId,
      lockId,
      user,
      session,
    });
    if (relationalRelease) {
      db.posReservationLocks = db.posReservationLocks.filter(
        (entry) => entry.reservationId !== reservationId,
      );
      if (relationalRelease.released || relationalRelease.expired) {
        db.meta.lastWriteAt = nowIso();
        await writeDb(
          db,
          reservationWriteOptions(
            "reservations.lock.appStateWrite",
            RESERVATION_LOCK_SPLIT_DOMAINS,
          ),
        );
      }
      sendJson(res, 200, {
        ok: true,
        released: relationalRelease.released === true,
      });
      return;
    }

    const lockPruned = pruneExpiredPosReservationLocks(db);
    const before = db.posReservationLocks.length;
    db.posReservationLocks = db.posReservationLocks.filter((entry) => {
      if (entry.reservationId !== reservationId) return true;
      if (entry.lockId !== lockId) return true;
      if (entry.userId !== user.id) return true;
      if (entry.deviceUuid !== session.deviceUuid) return true;
      return false;
    });
    const released = db.posReservationLocks.length !== before;
    if (lockPruned || released) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.lock.appStateWrite",
          RESERVATION_LOCK_SPLIT_DOMAINS,
        ),
      );
    }
    sendJson(res, 200, {
      ok: true,
      released,
    });
  }

  async function handlePosReservationsUpdate(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session, roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);
    const reservationId = resolvePosReservationId(payload);
    const queueContext = readDeviceQueueContext(req);
    const replayContract = requireOfflineReplayContract(payload, queueContext, {
      requireUpdatedAt: true,
      requireResultUpdatedAt: true,
    });
    const lockId = String(payload.lockId ?? "").trim();
    if (!lockId && !queueContext?.replay) {
      throw new HttpError(400, "Blocco modifica non valido.");
    }

    const relationalState = relationalReservationsUpdateWritePrimary
      ? readRelationalReservationStateForWrite(roomId, serviceDate)
      : null;
    const { state } = relationalState
      ? { state: relationalState }
      : getOrCreatePosReservationState(db, roomId, serviceDate);
    const reservationIndex = state.reservations.findIndex(
      (entry) => entry.id === reservationId,
    );
    if (reservationIndex < 0) {
      throw new HttpError(404, "Prenotazione non trovata.");
    }

    const current = state.reservations[reservationIndex];
    if (reservationHasReplayMarker(current, queueContext)) {
      sendJson(res, 200, {
        ok: true,
        version: state.version,
        reservation: clonePosReservation(current),
        replayed: true,
      });
      return;
    }
    assertOfflineReplayPreconditions(state, current, replayContract);

    if (!relationalReservationsUpdateWritePrimary && queueContext?.replay) {
      assertNoForeignReservationLock(db, reservationId, user, session);
    } else if (!relationalReservationsUpdateWritePrimary) {
      requirePosReservationWritableLock(
        db,
        reservationId,
        lockId,
        user.id,
        session.deviceUuid,
      );
    }
    const normalized = normalizePosReservationSaveInput(payload.patch, current);
    normalized.assignedTableIds.forEach((tableId) => {
      assertPosReservationAssignable(
        state.reservations,
        normalized.reservationAt,
        tableId,
        current.id,
      );
    });

    const requestedResultUpdatedAt = positiveReplayInteger(
      payload.resultUpdatedAt,
    );
    const updated = {
      ...current,
      reservationAt: normalized.reservationAt,
      customerName: normalized.customerName,
      customerPhone: normalized.customerPhone,
      covers: normalized.covers,
      intolerances: normalized.intolerances,
      note: normalized.note,
      assignedTableId: normalized.assignedTableId,
      assignedTableIds: normalized.assignedTableIds,
      updatedAt:
        queueContext && requestedResultUpdatedAt
          ? requestedResultUpdatedAt
          : Date.now(),
      ...(queueContext ? { offlineReplay: replayMarker(queueContext) } : {}),
    };
    if (relationalReservationsUpdateWritePrimary) {
      const result = queueContext?.replay
        ? updateRelationalReservationFromOfflineReplay({
            reservation: updated,
            contract: replayContract,
            user,
            session,
            releaseLock: true,
          })
        : updateRelationalReservationWithLock({
            reservation: updated,
            lockId,
            user,
            session,
            now: updated.updatedAt,
          });
      const persisted = result?.reservation ?? updated;
      const mirrorState = mirrorReservationWriteToAppState(
        db,
        roomId,
        serviceDate,
        persisted,
        result?.version ?? persisted?.revision,
        relationalState?.reservations ?? [],
      );
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.update.appStateWrite",
          RESERVATION_STATE_SPLIT_DOMAINS,
        ),
      );
      sendJson(res, 200, {
        ok: true,
        version: mirrorState.version,
        reservation: clonePosReservation(persisted),
        ...(result?.replayed ? { replayed: true } : {}),
      });
      return;
    }

    state.reservations[reservationIndex] = updated;
    state.version += 1;

    db.meta.lastWriteAt = nowIso();
    await writeDb(
      db,
      reservationWriteOptions(
        "reservations.update.appStateWrite",
        RESERVATION_STATE_SPLIT_DOMAINS,
      ),
    );

    sendJson(res, 200, {
      ok: true,
      version: state.version,
      reservation: clonePosReservation(updated),
    });
  }

  async function handlePosReservationsStatus(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session, roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);
    const reservationId = resolvePosReservationId(payload);
    const queueContext = readDeviceQueueContext(req);
    const replayContract = requireOfflineReplayContract(payload, queueContext, {
      requireUpdatedAt: true,
      requireResultUpdatedAt: true,
    });
    const action = String(payload.action ?? payload.status ?? "")
      .trim()
      .toLowerCase();
    const status =
      action === "arrived" || action === "arrivo"
        ? "arrived"
        : action === "no_show" || action === "noshow" || action === "no-show"
          ? "no_show"
          : action === "released" || action === "release"
            ? "released"
            : action === "cancelled" || action === "annullata"
              ? "cancelled"
              : "";
    if (!status) {
      throw new HttpError(400, "Stato prenotazione non valido.");
    }

    const relationalState = relationalReservationsStatusWritePrimary
      ? readRelationalReservationStateForWrite(roomId, serviceDate)
      : null;
    const { state } = relationalState
      ? { state: relationalState }
      : getOrCreatePosReservationState(db, roomId, serviceDate);
    const reservationIndex = state.reservations.findIndex(
      (entry) => entry.id === reservationId,
    );
    if (reservationIndex < 0) {
      throw new HttpError(404, "Prenotazione non trovata.");
    }

    const current = state.reservations[reservationIndex];
    const appStateLockPresent = db.posReservationLocks.some(
      (entry) => entry.reservationId === reservationId,
    );
    if (reservationHasReplayMarker(current, queueContext)) {
      sendJson(res, 200, {
        ok: true,
        version: state.version,
        reservation: clonePosReservation(current),
        tablesChanged: false,
        tableIds: [],
        replayed: true,
      });
      return;
    }
    assertOfflineReplayPreconditions(state, current, replayContract);

    if (!relationalReservationsStatusWritePrimary && queueContext?.replay) {
      assertNoForeignReservationLock(db, reservationId, user, session);
    } else if (!relationalReservationsStatusWritePrimary) {
      pruneExpiredPosReservationLocks(db);
      const activeLock =
        db.posReservationLocks.find(
          (entry) => entry.reservationId === reservationId,
        ) ?? null;
      if (
        activeLock &&
        (activeLock.userId !== user.id ||
          activeLock.deviceUuid !== session.deviceUuid)
      ) {
        throw new HttpError(
          409,
          "Prenotazione in modifica da un altro operatore.",
        );
      }
    }

    const requestedResultUpdatedAt = positiveReplayInteger(
      payload.resultUpdatedAt,
    );
    const now =
      queueContext && requestedResultUpdatedAt
        ? requestedResultUpdatedAt
        : Date.now();
    const updated = {
      ...current,
      status,
      releasedAt: current.releasedAt || now,
      updatedAt: now,
      ...(status === "arrived" ? { arrivedAt: now } : {}),
      ...(status === "no_show" ? { noShowAt: now } : {}),
      ...(status === "cancelled" ? { cancelledAt: now } : {}),
      ...(queueContext ? { offlineReplay: replayMarker(queueContext) } : {}),
    };
    if (relationalReservationsStatusWritePrimary) {
      const result = queueContext?.replay
        ? updateRelationalReservationFromOfflineReplay({
            reservation: updated,
            contract: replayContract,
            user,
            session,
            releaseLock: true,
          })
        : updateRelationalReservationStatus({
            reservationId,
            status,
            user,
            session,
            now,
            reservation: updated,
          });
      const persisted = result?.reservation ?? updated;
      const mirrorState = mirrorReservationWriteToAppState(
        db,
        roomId,
        serviceDate,
        persisted,
        result?.version ?? persisted?.revision,
        relationalState?.reservations ?? [],
      );
      db.posReservationLocks = db.posReservationLocks.filter(
        (entry) => entry.reservationId !== reservationId,
      );
      const tableUpdate =
        typeof applyPosReservationStatusToAssignedTables === "function"
          ? applyPosReservationStatusToAssignedTables(
              db,
              persisted,
              status,
              now,
            )
          : { changed: false, tableIds: [] };
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.status.appStateWrite",
          tableUpdate.changed === true
            ? RESERVATION_TABLE_STATUS_SPLIT_DOMAINS
            : RESERVATION_STATE_LOCK_SPLIT_DOMAINS,
          {
            reservationStateKeys: [mirrorState.key],
            tableIds: tableUpdate.tableIds,
            integrationTableGroupsChanged: tableUpdate.changed === true,
            requiresFullFallback: appStateLockPresent,
          },
        ),
      );
      sendJson(res, 200, {
        ok: true,
        version: mirrorState.version,
        reservation: clonePosReservation(persisted),
        tablesChanged: tableUpdate.changed === true,
        tableIds: Array.isArray(tableUpdate.tableIds)
          ? tableUpdate.tableIds
          : [],
      });
      return;
    }
    state.reservations[reservationIndex] = updated;
    state.version += 1;
    db.posReservationLocks = db.posReservationLocks.filter(
      (entry) => entry.reservationId !== reservationId,
    );
    const tableUpdate =
      typeof applyPosReservationStatusToAssignedTables === "function"
        ? applyPosReservationStatusToAssignedTables(db, updated, status, now)
        : { changed: false, tableIds: [] };
    db.meta.lastWriteAt = nowIso();
    await writeDb(
      db,
      reservationWriteOptions(
        "reservations.status.appStateWrite",
        tableUpdate.changed === true
          ? RESERVATION_TABLE_STATUS_SPLIT_DOMAINS
          : RESERVATION_STATE_LOCK_SPLIT_DOMAINS,
        {
          reservationStateKeys: [state.key],
          tableIds: tableUpdate.tableIds,
          integrationTableGroupsChanged: tableUpdate.changed === true,
          requiresFullFallback: appStateLockPresent,
        },
      ),
    );

    sendJson(res, 200, {
      ok: true,
      version: state.version,
      reservation: clonePosReservation(updated),
      tablesChanged: tableUpdate.changed === true,
      tableIds: Array.isArray(tableUpdate.tableIds) ? tableUpdate.tableIds : [],
    });
  }

  async function handlePosReservationsDelete(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session, roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);
    const reservationId = resolvePosReservationId(payload);
    const queueContext = readDeviceQueueContext(req);
    const replayContract = requireOfflineReplayContract(payload, queueContext, {
      requireUpdatedAt: true,
    });
    const lockId = String(payload.lockId ?? "").trim();
    if (!lockId && !queueContext?.replay) {
      throw new HttpError(400, "Blocco modifica non valido.");
    }

    const relationalState = relationalReservationsDeleteWritePrimary
      ? readRelationalReservationStateForWrite(roomId, serviceDate)
      : null;
    const { state } = relationalState
      ? { state: relationalState }
      : getOrCreatePosReservationState(db, roomId, serviceDate);
    const reservationIndex = state.reservations.findIndex(
      (entry) => entry.id === reservationId,
    );
    if (reservationIndex < 0 && queueContext?.replay) {
      sendJson(res, 200, {
        ok: true,
        deleted: true,
        version: Math.max(
          Number(state.version) || 1,
          replayContract.expectedVersion + 1,
        ),
        replayed: true,
      });
      return;
    }
    if (reservationIndex < 0) {
      throw new HttpError(404, "Prenotazione non trovata.");
    }
    const current = state.reservations[reservationIndex];
    assertOfflineReplayPreconditions(state, current, replayContract);
    if (!relationalReservationsDeleteWritePrimary && queueContext?.replay) {
      assertNoForeignReservationLock(db, reservationId, user, session);
    } else if (!relationalReservationsDeleteWritePrimary) {
      requirePosReservationWritableLock(
        db,
        reservationId,
        lockId,
        user.id,
        session.deviceUuid,
      );
    }
    if (relationalReservationsDeleteWritePrimary) {
      const result = queueContext?.replay
        ? deleteRelationalReservationFromOfflineReplay({
            reservationId,
            contract: replayContract,
            user,
            session,
          })
        : deleteRelationalReservationWithLock({
            reservationId,
            lockId,
            user,
            session,
            now: Date.now(),
          });
      const mirrorState = mirrorReservationDeleteToAppState(
        db,
        roomId,
        serviceDate,
        reservationId,
        result?.version ??
          (replayContract ? replayContract.expectedVersion + 1 : undefined),
        relationalState?.reservations ?? [],
      );
      db.posReservationLocks = db.posReservationLocks.filter(
        (entry) => entry.reservationId !== reservationId,
      );
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.delete.appStateWrite",
          RESERVATION_STATE_LOCK_SPLIT_DOMAINS,
        ),
      );
      sendJson(res, 200, {
        ok: true,
        deleted: true,
        version: mirrorState.version,
        ...(result?.replayed ? { replayed: true } : {}),
      });
      return;
    }
    state.reservations.splice(reservationIndex, 1);
    state.version += 1;
    db.posReservationLocks = db.posReservationLocks.filter(
      (entry) => entry.reservationId !== reservationId,
    );
    db.meta.lastWriteAt = nowIso();
    await writeDb(
      db,
      reservationWriteOptions(
        "reservations.delete.appStateWrite",
        RESERVATION_STATE_LOCK_SPLIT_DOMAINS,
      ),
    );

    sendJson(res, 200, {
      ok: true,
      deleted: true,
      version: state.version,
    });
  }

  async function handlePosReservationsAvailability(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { roomId } = resolvePosRoomSessionContext(
      db,
      payload,
      req?.__authContext,
    );
    const serviceDate = resolvePosReservationServiceDate(payload);
    const reservationAtRaw = Number(payload.reservationAt);
    if (!Number.isFinite(reservationAtRaw)) {
      throw new HttpError(400, "Orario prenotazione non valido.");
    }

    const state =
      readRelationalReservationState(roomId, serviceDate) ??
      findReservationState(db, roomId, serviceDate);
    const reservations = Array.isArray(state?.reservations)
      ? state.reservations
      : [];
    const reservationIdToIgnore = String(
      payload.reservationIdToIgnore ?? "",
    ).trim();
    const tableIds = Array.isArray(payload.tableIds)
      ? payload.tableIds.map((entry) => String(entry ?? "").trim())
      : [];

    const items = tableIds.map((tableId) => {
      const normalizedTableId = tableId.trim();
      if (!normalizedTableId) {
        return {
          tableId,
          status: "conflict",
          nearestReservation: null,
          minutesDistance: 0,
          label: "Tavolo non valido",
        };
      }
      const { nearest, nearestDistance, status } = findPosNearestReservation(
        reservations,
        normalizedTableId,
        reservationAtRaw,
        reservationIdToIgnore,
      );
      return {
        tableId: normalizedTableId,
        status,
        nearestReservation: nearest ? clonePosReservation(nearest) : null,
        minutesDistance: nearestDistance,
        label: buildPosAvailabilityLabel(status, nearest, nearestDistance),
      };
    });

    sendJson(res, 200, {
      ok: true,
      items,
    });
  }

  async function handlePosReservationsLockState(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    const reservationId = resolvePosReservationId(payload);
    const relationalLock = readRelationalReservationLock(reservationId);
    let lock = relationalLock?.checked ? relationalLock.lock : null;
    const lockPruned = relationalLock?.checked
      ? false
      : pruneExpiredPosReservationLocks(db);
    if (!relationalLock?.checked) {
      lock =
        db.posReservationLocks.find(
          (entry) => entry.reservationId === reservationId,
        ) ?? null;
    }
    if (lockPruned) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(
        db,
        reservationWriteOptions(
          "reservations.lockState.appStateWrite",
          RESERVATION_LOCK_SPLIT_DOMAINS,
        ),
      );
    }

    if (!lock) {
      sendJson(res, 200, {
        ok: true,
        locked: false,
        byCurrentSession: false,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      locked: true,
      byCurrentSession:
        lock.userId === user.id && lock.deviceUuid === session.deviceUuid,
      expiresAt: lock.expiresAt,
    });
  }

  async function handlePublicReservationsList(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { roomId } = resolvePublicReservationRoom(db, payload);
    const serviceDate = resolvePosReservationServiceDate(payload);
    const state =
      readRelationalReservationState(roomId, serviceDate) ??
      findReservationState(db, roomId, serviceDate);
    sendJson(res, 200, {
      ok: true,
      version: Number(state?.version) || 1,
      reservations: sortedPublicReservations(state),
    });
  }

  async function handlePublicReservationsAvailability(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { roomId } = resolvePublicReservationRoom(db, payload);
    const serviceDate = resolvePosReservationServiceDate(payload);
    const reservationAtRaw = Number(payload.reservationAt);
    if (!Number.isFinite(reservationAtRaw)) {
      throw new HttpError(400, "Orario prenotazione non valido.");
    }
    const state =
      readRelationalReservationState(roomId, serviceDate) ??
      findReservationState(db, roomId, serviceDate);
    const tableIds = Array.isArray(payload.tableIds)
      ? payload.tableIds
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : [];
    const items = tableIds.map((tableId) => {
      const { nearest, nearestDistance, status } = findPosNearestReservation(
        Array.isArray(state?.reservations) ? state.reservations : [],
        tableId,
        reservationAtRaw,
        "",
      );
      return {
        tableId,
        status,
        nearestReservation: nearest ? clonePosReservation(nearest) : null,
        minutesDistance: nearestDistance,
        label: buildPosAvailabilityLabel(status, nearest, nearestDistance),
      };
    });
    sendJson(res, 200, { ok: true, items });
  }

  async function handlePublicReservationsCreate(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { roomId } = resolvePublicReservationRoom(db, payload);
    const serviceDate = resolvePosReservationServiceDate(payload);
    const { state } = getOrCreatePosReservationState(db, roomId, serviceDate);
    const relationalState = relationalReservationsCreateWritePrimary
      ? readRelationalReservationStateForWrite(roomId, serviceDate)
      : null;
    const validationState = relationalState ?? state;
    const normalized = normalizePosReservationSaveInput(payload);
    normalized.assignedTableIds.forEach((tableId) => {
      assertPosReservationAssignable(
        validationState.reservations,
        normalized.reservationAt,
        tableId,
      );
    });
    const now = Date.now();
    const reservation = {
      id: toPosReservationId(),
      roomId,
      serviceDate,
      reservationAt: normalized.reservationAt,
      customerName: normalized.customerName,
      customerPhone: normalized.customerPhone,
      covers: normalized.covers,
      intolerances: normalized.intolerances,
      note: normalized.note,
      assignedTableId: normalized.assignedTableId,
      assignedTableIds: normalized.assignedTableIds,
      createdAt: now,
      updatedAt: now,
      source: "public-reservations-frontend",
    };
    const persisted = await persistReservationCreate({
      db,
      roomId,
      serviceDate,
      reservation,
      state,
      relationalState,
    });
    sendJson(res, 200, {
      ok: true,
      version: persisted.version,
      reservation: persisted.reservation,
    });
  }

  return {
    "pos.publicReservationsAvailability": handlePublicReservationsAvailability,
    "pos.publicReservationsCreate": handlePublicReservationsCreate,
    "pos.publicReservationsList": handlePublicReservationsList,
    "pos.reservationsAvailability": handlePosReservationsAvailability,
    "pos.reservationsCreate": handlePosReservationsCreate,
    "pos.reservationsDelete": handlePosReservationsDelete,
    "pos.reservationsList": handlePosReservationsList,
    "pos.reservationsLockAcquire": handlePosReservationsLockAcquire,
    "pos.reservationsLockRelease": handlePosReservationsLockRelease,
    "pos.reservationsLockState": handlePosReservationsLockState,
    "pos.reservationsStatus": handlePosReservationsStatus,
    "pos.reservationsUpdate": handlePosReservationsUpdate,
  };
}
