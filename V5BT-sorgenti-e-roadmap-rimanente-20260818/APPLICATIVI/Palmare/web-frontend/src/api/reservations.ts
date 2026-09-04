import { sleep } from "../utils/sleep";
import { apiFetch } from "./baseUrl";
import { normalizeTableCovers } from "../domain/tables/capacity";
import { resolveOfflineConfigurationScope } from "./offlineConfigurationScope";
import {
  readOfflineReservations,
  recordOfflineReservations,
} from "../domain/offlineConfiguration/repository";
import {
  normalizeAssignedTableIds,
  parseAvailabilityFromResponse,
  parseBackendError,
  parseLockFromResponse,
  parseLockStateFromResponse,
  parseReservationDeleteResponse,
  parseReservationMutationResponse,
  parseReservationStatusResponse,
  parseReservationSummaryResponse,
  type DiningReservation,
  type ReservationEditLock,
  type ReservationSessionRequest,
  type ReservationStatusAction,
  type ReservationStatusColor,
  type ReservationSummary,
  type TableAvailabilityInfo,
} from "./reservationModel";

export type {
  DiningReservation,
  ReservationEditLock,
  ReservationSessionRequest,
  ReservationStatusAction,
  ReservationStatusColor,
  ReservationStatusUpdateResult,
  ReservationSummary,
  TableAvailabilityInfo,
} from "./reservationModel";

type ReservationState = {
  version: number;
  reservations: DiningReservation[];
};

type LockState = {
  lockId: string;
  reservationId: string;
  userId: string;
  deviceUuid: string;
  expiresAt: number;
};

type SaveReservationInput = {
  reservationAt?: number;
  customerName?: string;
  customerPhone?: string;
  covers?: number;
  intolerances?: string;
  note?: string;
  assignedTableId?: string | null;
  assignedTableIds?: string[];
};

const BACKEND_TIMEOUT_MS = 30000;

type BackendResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; error: string }
  | { kind: "unavailable" };

const reservationStateByDay = new Map<string, ReservationState>();
const lockStateByReservationId = new Map<string, LockState>();

const LOCK_TTL_MS = 90_000;

const postBackend = async <T>(
  path: string,
  body: Record<string, unknown>,
  parser: (payload: unknown) => T | null,
  defaultError: string
): Promise<BackendResult<T>> => {
  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (
      response.status === 202 &&
      response.headers.get("X-Palmare-Offline-Queued")?.trim() === "1"
    ) {
      return { kind: "unavailable" };
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      return {
        kind: "error",
        error: parseBackendError(payload, defaultError),
      };
    }
    const parsed = parser(payload);
    if (parsed === null) {
      return {
        kind: "error",
        error: "Risposta backend non valida.",
      };
    }
    return {
      kind: "ok",
      value: parsed,
    };
  } catch {
    return { kind: "unavailable" };
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const toDayStateKey = (roomId: string, serviceDate: string) => `${roomId}__${serviceDate}`;

const asLocalDateKey = (value: string | Date) => {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toClock = (timestamp: number) => {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

const cloneReservation = (reservation: DiningReservation): DiningReservation => ({
  ...reservation,
});

const cloneState = (state: ReservationState): ReservationState => ({
  version: state.version,
  reservations: state.reservations.map(cloneReservation),
});

const findReservationInState = (state: ReservationState, reservationId: string) =>
  state.reservations.find((reservation) => reservation.id === reservationId) ?? null;

const nextReservationUpdatedAt = (reservation: DiningReservation) =>
  Math.max(Date.now(), reservation.updatedAt + 1);

const upsertReservationInState = (state: ReservationState, reservation: DiningReservation) => {
  const index = state.reservations.findIndex((entry) => entry.id === reservation.id);
  if (index >= 0) state.reservations[index] = cloneReservation(reservation);
  else state.reservations.push(cloneReservation(reservation));
  state.reservations.sort((left, right) => left.reservationAt - right.reservationAt);
};

const hydrateReservationState = (
  roomId: string,
  serviceDate: string,
  summary: ReservationSummary
) => {
  const state = cloneState(summary);
  state.reservations.sort((left, right) => left.reservationAt - right.reservationAt);
  reservationStateByDay.set(toDayStateKey(roomId, asLocalDateKey(serviceDate)), state);
  return state;
};

const persistReservationState = async (
  params: ReservationSessionRequest & { serviceDate: string },
  state: ReservationState
) => {
  const offlineScope = resolveOfflineConfigurationScope(params);
  if (!offlineScope) return;
  await recordOfflineReservations(
    offlineScope,
    params.roomId,
    params.serviceDate,
    cloneState(state)
  );
};

const buildMockReservationsForDate = (roomId: string, serviceDate: string): DiningReservation[] => {
  const [year, month, day] = serviceDate.split("-").map((entry) => Number(entry));
  const baseDate = new Date(year, (month || 1) - 1, day || 1, 0, 0, 0, 0);
  const at = (hour: number, minute: number) =>
    new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      hour,
      minute,
      0,
      0
    ).getTime();

  const items: Array<Omit<DiningReservation, "id" | "status" | "createdAt" | "updatedAt">> = [
    {
      roomId,
      serviceDate,
      reservationAt: at(19, 0),
      customerName: "Rossi",
      customerPhone: "+39 333 1200456",
      covers: 4,
      intolerances: "Solfiti",
      note: "Compleanno, tavolo tranquillo",
      assignedTableId: `${roomId}_t02`,
      assignedTableIds: [`${roomId}_t02`],
    },
    {
      roomId,
      serviceDate,
      reservationAt: at(19, 50),
      customerName: "Bianchi",
      customerPhone: "+39 347 4441122",
      covers: 2,
      intolerances: "",
      note: "",
      assignedTableId: `${roomId}_t02`,
      assignedTableIds: [`${roomId}_t02`],
    },
    {
      roomId,
      serviceDate,
      reservationAt: at(20, 20),
      customerName: "Neri",
      customerPhone: "+39 339 8019922",
      covers: 6,
      intolerances: "Lattosio",
      note: "Passeggino",
      assignedTableId: `${roomId}_t05`,
      assignedTableIds: [`${roomId}_t05`],
    },
    {
      roomId,
      serviceDate,
      reservationAt: at(22, 30),
      customerName: "Verdi",
      customerPhone: "",
      covers: 3,
      intolerances: "",
      note: "",
      assignedTableId: `${roomId}_t05`,
      assignedTableIds: [`${roomId}_t05`],
    },
  ];

  return items.map((item, index) => {
    const now = Date.now() - index * 1000;
    return {
      ...item,
      id: `res_${roomId}_${serviceDate}_${index + 1}`,
      status: "booked" as const,
      createdAt: now,
      updatedAt: now,
    };
  });
};

const assertSession = (params: ReservationSessionRequest) => {
  if (!params.token || !params.userId || !params.deviceUuid || !params.roomId) {
    throw new Error("Sessione prenotazioni non valida.");
  }
};

const assertServiceDate = (serviceDate: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    throw new Error("Data prenotazione non valida.");
  }
};

const getOrCreateState = (roomId: string, serviceDate: string) => {
  const normalizedDate = asLocalDateKey(serviceDate);
  const key = toDayStateKey(roomId, normalizedDate);
  const existing = reservationStateByDay.get(key);
  if (existing) return existing;

  const created: ReservationState = {
    version: 1,
    reservations: buildMockReservationsForDate(roomId, normalizedDate),
  };
  reservationStateByDay.set(key, created);
  return created;
};

const dropExpiredLock = (reservationId: string) => {
  const lock = lockStateByReservationId.get(reservationId);
  if (!lock) return;
  if (lock.expiresAt <= Date.now()) {
    lockStateByReservationId.delete(reservationId);
  }
};

const getActiveLock = (reservationId: string): LockState | null => {
  dropExpiredLock(reservationId);
  return lockStateByReservationId.get(reservationId) ?? null;
};

const ensureWritableByLock = (
  reservationId: string,
  lockId: string,
  userId: string,
  deviceUuid: string
) => {
  const lock = getActiveLock(reservationId);
  if (!lock) {
    throw new Error("Blocco modifica scaduto. Riapri la prenotazione.");
  }
  if (lock.lockId !== lockId) {
    throw new Error("Blocco modifica non valido.");
  }
  if (lock.userId !== userId || lock.deviceUuid !== deviceUuid) {
    throw new Error("Prenotazione in modifica da un altro operatore.");
  }
};

const toReservationId = () => `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const toLockId = () => `lock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const MIN_TABLE_RESERVATION_GAP_MINUTES = 60,
  DANGER_TABLE_RESERVATION_GAP_MINUTES = 90,
  WARNING_TABLE_RESERVATION_GAP_MINUTES = 120;
const classifyDistance = (minutesDistance: number | null): ReservationStatusColor => {
  if (minutesDistance === null) return "free";
  if (minutesDistance < MIN_TABLE_RESERVATION_GAP_MINUTES) return "conflict";
  if (minutesDistance < DANGER_TABLE_RESERVATION_GAP_MINUTES) return "danger";
  if (minutesDistance < WARNING_TABLE_RESERVATION_GAP_MINUTES) return "warning";
  return "safe";
};

const getNearestReservation = (
  reservations: DiningReservation[],
  tableId: string,
  reservationAt: number,
  ignoreReservationId?: string
) => {
  let nearest: DiningReservation | null = null;
  let nearestDistance: number | null = null;

  reservations.forEach((reservation) => {
    const assignedTableIds = normalizeAssignedTableIds(
      reservation.assignedTableIds,
      reservation.assignedTableId
    );
    if (!assignedTableIds.includes(tableId)) return;
    if (ignoreReservationId && reservation.id === ignoreReservationId) return;
    const distance = Math.abs(reservation.reservationAt - reservationAt) / 60000;
    if (nearestDistance === null || distance < nearestDistance) {
      nearestDistance = distance;
      nearest = reservation;
    }
  });

  return {
    nearest,
    nearestDistance,
    status: classifyDistance(nearestDistance),
  };
};

const buildAvailabilityLabel = (
  status: ReservationStatusColor,
  nearest: DiningReservation | null,
  minutesDistance: number | null
) => {
  if (!nearest || minutesDistance === null) return "Disponibile";
  const rounded = Math.round(minutesDistance);
  const base = `${nearest.customerName} alle ${toClock(nearest.reservationAt)}`;
  if (status === "conflict") return `Conflitto con ${base}`;
  if (status === "danger") return `Rischio alto (${rounded} min) con ${base}`;
  if (status === "warning") return `Attenzione (${rounded} min) con ${base}`;
  return `Sequenziale (${rounded} min) con ${base}`;
};

const validateAndNormalizeInput = (
  input: SaveReservationInput,
  current?: DiningReservation
): Required<SaveReservationInput> => {
  const reservationAt = input.reservationAt ?? current?.reservationAt ?? Date.now();
  const customerName = (input.customerName ?? current?.customerName ?? "").trim().slice(0, 80);
  const customerPhone = (input.customerPhone ?? current?.customerPhone ?? "").trim().slice(0, 24);
  const covers = normalizeTableCovers(input.covers ?? current?.covers, { fallback: 2 });
  const intolerances = (input.intolerances ?? current?.intolerances ?? "").trim().slice(0, 180);
  const note = (input.note ?? current?.note ?? "").trim().slice(0, 280);
  const hasAssignedTableIds = Object.prototype.hasOwnProperty.call(input, "assignedTableIds");
  const hasAssignedTableId = Object.prototype.hasOwnProperty.call(input, "assignedTableId");
  const assignedTableIds =
    hasAssignedTableIds || hasAssignedTableId
      ? normalizeAssignedTableIds(input.assignedTableIds, input.assignedTableId)
      : normalizeAssignedTableIds(current?.assignedTableIds, current?.assignedTableId);
  const assignedTableId = assignedTableIds[0] ?? null;

  if (!customerName) {
    throw new Error("Nome prenotazione obbligatorio.");
  }
  if (!Number.isFinite(reservationAt)) {
    throw new Error("Orario prenotazione non valido.");
  }

  return {
    reservationAt,
    customerName,
    customerPhone,
    covers,
    intolerances,
    note,
    assignedTableId,
    assignedTableIds,
  };
};

const assertAssignable = (
  reservations: DiningReservation[],
  reservationAt: number,
  tableId: string,
  ignoreReservationId?: string
) => {
  const availability = getNearestReservation(
    reservations,
    tableId,
    reservationAt,
    ignoreReservationId
  );
  if (availability.status === "conflict") {
    throw new Error(
      `Tavolo gia assegnato a meno di ${MIN_TABLE_RESERVATION_GAP_MINUTES} minuti da un'altra prenotazione.`
    );
  }
};

export const reservationsQueryKey = (roomId: string, serviceDate: string) =>
  ["reservations-room", roomId, serviceDate] as const;

export async function fetchReservationsForDay(
  params: ReservationSessionRequest & { serviceDate: string }
): Promise<ReservationSummary> {
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const backend = await postBackend(
    "/api/pos/reservations/list",
    {
      ...params,
      serviceDate: params.serviceDate,
    },
    parseReservationSummaryResponse,
    "Impossibile caricare prenotazioni."
  );
  if (backend.kind === "ok") {
    const state = hydrateReservationState(params.roomId, params.serviceDate, backend.value);
    const offlineScope = resolveOfflineConfigurationScope(params);
    if (offlineScope) {
      await recordOfflineReservations(
        offlineScope,
        params.roomId,
        params.serviceDate,
        cloneState(state)
      );
    }
    return cloneState(state);
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const offlineScope = resolveOfflineConfigurationScope(params);
  const offlineSummary = offlineScope
    ? await readOfflineReservations(offlineScope, params.roomId, params.serviceDate)
    : null;
  if (offlineSummary) {
    return cloneState(hydrateReservationState(params.roomId, params.serviceDate, offlineSummary));
  }
  if (!import.meta.env.DEV) {
    throw new Error("Prenotazioni offline non ancora disponibili per la data selezionata.");
  }

  const state = getOrCreateState(params.roomId, params.serviceDate);
  const sorted = [...state.reservations].sort(
    (left, right) => left.reservationAt - right.reservationAt
  );
  return {
    version: state.version,
    reservations: sorted.map(cloneReservation),
  };
}

export async function createDiningReservation(
  params: ReservationSessionRequest & {
    serviceDate: string;
    reservationAt: number;
    customerName: string;
    customerPhone?: string;
    covers?: number;
    intolerances?: string;
    note?: string;
    assignedTableId?: string | null;
    assignedTableIds?: string[];
  }
) {
  await sleep(160);
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const state = getOrCreateState(params.roomId, params.serviceDate);
  const expectedVersion = state.version;
  const clientReservationId = toReservationId();
  const clientCreatedAt = Date.now();

  const backend = await postBackend(
    "/api/pos/reservations/create",
    {
      ...params,
      serviceDate: params.serviceDate,
      expectedVersion,
      clientReservationId,
      clientCreatedAt,
    },
    parseReservationMutationResponse,
    "Salvataggio prenotazione non riuscito."
  );
  if (backend.kind === "ok") {
    upsertReservationInState(state, backend.value.reservation);
    state.version = backend.value.version;
    await persistReservationState(params, state);
    return backend.value.reservation;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const payload = validateAndNormalizeInput({
    reservationAt: params.reservationAt,
    customerName: params.customerName,
    customerPhone: params.customerPhone,
    covers: params.covers,
    intolerances: params.intolerances,
    note: params.note,
    assignedTableId: params.assignedTableId,
    assignedTableIds: params.assignedTableIds,
  });

  payload.assignedTableIds.forEach((tableId) =>
    assertAssignable(state.reservations, payload.reservationAt, tableId)
  );

  const next: DiningReservation = {
    id: clientReservationId,
    roomId: params.roomId,
    serviceDate: asLocalDateKey(params.serviceDate),
    status: "booked",
    reservationAt: payload.reservationAt,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    covers: payload.covers,
    intolerances: payload.intolerances,
    note: payload.note,
    assignedTableId: payload.assignedTableId,
    assignedTableIds: payload.assignedTableIds,
    createdAt: clientCreatedAt,
    updatedAt: clientCreatedAt,
  };

  state.reservations.push(next);
  state.version += 1;
  await persistReservationState(params, state);
  return cloneReservation(next);
}

export async function acquireReservationEditLock(
  params: ReservationSessionRequest & { serviceDate: string; reservationId: string }
): Promise<ReservationEditLock> {
  await sleep(120);
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const backend = await postBackend(
    "/api/pos/reservations/lock/acquire",
    {
      ...params,
      serviceDate: params.serviceDate,
      reservationId: params.reservationId,
    },
    parseLockFromResponse,
    "Impossibile acquisire il blocco modifica."
  );
  if (backend.kind === "ok") {
    lockStateByReservationId.set(params.reservationId, {
      lockId: backend.value.lockId,
      reservationId: backend.value.reservationId,
      userId: backend.value.userId,
      deviceUuid: backend.value.deviceUuid,
      expiresAt: backend.value.expiresAt,
    });
    return backend.value;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const state = getOrCreateState(params.roomId, params.serviceDate);
  const target = state.reservations.find((reservation) => reservation.id === params.reservationId);
  if (!target) {
    throw new Error("Prenotazione non trovata.");
  }

  const activeLock = getActiveLock(params.reservationId);
  const now = Date.now();

  if (
    activeLock &&
    (activeLock.userId !== params.userId || activeLock.deviceUuid !== params.deviceUuid)
  ) {
    throw new Error("Prenotazione in modifica da un altro operatore.");
  }

  const lockId = activeLock?.lockId ?? toLockId();
  const nextLock: LockState = {
    lockId,
    reservationId: params.reservationId,
    userId: params.userId,
    deviceUuid: params.deviceUuid,
    expiresAt: now + LOCK_TTL_MS,
  };
  lockStateByReservationId.set(params.reservationId, nextLock);

  return {
    reservationId: params.reservationId,
    lockId: nextLock.lockId,
    userId: nextLock.userId,
    deviceUuid: nextLock.deviceUuid,
    expiresAt: nextLock.expiresAt,
  };
}

export async function releaseReservationEditLock(
  params: ReservationSessionRequest & { reservationId: string; lockId: string }
) {
  await sleep(80);
  assertSession(params);

  const backend = await postBackend(
    "/api/pos/reservations/lock/release",
    {
      ...params,
      reservationId: params.reservationId,
      lockId: params.lockId,
    },
    () => ({ ok: true as const }),
    "Impossibile rilasciare il blocco modifica."
  );
  if (backend.kind === "ok") {
    lockStateByReservationId.delete(params.reservationId);
    return;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const activeLock = getActiveLock(params.reservationId);
  if (!activeLock) return;
  if (
    activeLock.lockId !== params.lockId ||
    activeLock.userId !== params.userId ||
    activeLock.deviceUuid !== params.deviceUuid
  ) {
    return;
  }
  lockStateByReservationId.delete(params.reservationId);
}

export async function updateDiningReservation(
  params: ReservationSessionRequest & {
    serviceDate: string;
    reservationId: string;
    lockId: string;
    patch: SaveReservationInput;
  }
) {
  await sleep(160);
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const state = getOrCreateState(params.roomId, params.serviceDate);
  const current = findReservationInState(state, params.reservationId);
  if (!current) {
    throw new Error("Prenotazione non trovata.");
  }
  const expectedVersion = state.version;
  const expectedUpdatedAt = current.updatedAt;
  const resultUpdatedAt = nextReservationUpdatedAt(current);

  const backend = await postBackend(
    "/api/pos/reservations/update",
    {
      ...params,
      serviceDate: params.serviceDate,
      reservationId: params.reservationId,
      lockId: params.lockId,
      patch: params.patch,
      expectedVersion,
      expectedUpdatedAt,
      resultUpdatedAt,
    },
    parseReservationMutationResponse,
    "Salvataggio prenotazione non riuscito."
  );
  if (backend.kind === "ok") {
    upsertReservationInState(state, backend.value.reservation);
    state.version = backend.value.version;
    await persistReservationState(params, state);
    return backend.value.reservation;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  ensureWritableByLock(params.reservationId, params.lockId, params.userId, params.deviceUuid);
  const index = state.reservations.findIndex(
    (reservation) => reservation.id === params.reservationId
  );
  if (index < 0) {
    throw new Error("Prenotazione non trovata.");
  }

  const payload = validateAndNormalizeInput(params.patch, current);
  payload.assignedTableIds.forEach((tableId) =>
    assertAssignable(state.reservations, payload.reservationAt, tableId, current.id)
  );

  const updated: DiningReservation = {
    ...current,
    reservationAt: payload.reservationAt,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    covers: payload.covers,
    intolerances: payload.intolerances,
    note: payload.note,
    assignedTableId: payload.assignedTableId,
    assignedTableIds: payload.assignedTableIds,
    updatedAt: resultUpdatedAt,
  };

  state.reservations[index] = updated;
  state.version += 1;
  await persistReservationState(params, state);
  return cloneReservation(updated);
}

export async function updateDiningReservationStatus(
  params: ReservationSessionRequest & {
    serviceDate: string;
    reservationId: string;
    action: ReservationStatusAction;
  }
) {
  await sleep(120);
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const state = getOrCreateState(params.roomId, params.serviceDate);
  const current = findReservationInState(state, params.reservationId);
  if (!current) {
    throw new Error("Prenotazione non trovata.");
  }
  const expectedVersion = state.version;
  const expectedUpdatedAt = current.updatedAt;
  const resultUpdatedAt = nextReservationUpdatedAt(current);

  const backend = await postBackend(
    "/api/pos/reservations/status",
    {
      ...params,
      serviceDate: params.serviceDate,
      reservationId: params.reservationId,
      action: params.action,
      expectedVersion,
      expectedUpdatedAt,
      resultUpdatedAt,
    },
    parseReservationStatusResponse,
    "Aggiornamento stato prenotazione non riuscito."
  );
  if (backend.kind === "ok") {
    upsertReservationInState(state, backend.value.reservation);
    state.version = backend.value.version;
    lockStateByReservationId.delete(params.reservationId);
    await persistReservationState(params, state);
    return backend.value;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const index = state.reservations.findIndex(
    (reservation) => reservation.id === params.reservationId
  );
  if (index < 0) {
    throw new Error("Prenotazione non trovata.");
  }
  const updated: DiningReservation = {
    ...current,
    status: params.action,
    releasedAt: current.releasedAt ?? resultUpdatedAt,
    updatedAt: resultUpdatedAt,
    ...(params.action === "arrived" ? { arrivedAt: resultUpdatedAt } : {}),
    ...(params.action === "no_show" ? { noShowAt: resultUpdatedAt } : {}),
    ...(params.action === "cancelled" ? { cancelledAt: resultUpdatedAt } : {}),
  };
  state.reservations[index] = updated;
  state.version += 1;
  lockStateByReservationId.delete(params.reservationId);
  await persistReservationState(params, state);
  return {
    reservation: cloneReservation(updated),
    tablesChanged: false,
    tableIds: [],
  };
}

export async function deleteDiningReservation(
  params: ReservationSessionRequest & {
    serviceDate: string;
    reservationId: string;
    lockId: string;
  }
) {
  await sleep(140);
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const state = getOrCreateState(params.roomId, params.serviceDate);
  const current = findReservationInState(state, params.reservationId);
  if (!current) {
    throw new Error("Prenotazione non trovata.");
  }
  const expectedVersion = state.version;
  const expectedUpdatedAt = current.updatedAt;

  const backend = await postBackend(
    "/api/pos/reservations/delete",
    {
      ...params,
      serviceDate: params.serviceDate,
      reservationId: params.reservationId,
      lockId: params.lockId,
      expectedVersion,
      expectedUpdatedAt,
    },
    parseReservationDeleteResponse,
    "Eliminazione non riuscita."
  );
  if (backend.kind === "ok") {
    const index = state.reservations.findIndex(
      (reservation) => reservation.id === params.reservationId
    );
    if (index >= 0) state.reservations.splice(index, 1);
    state.version = backend.value.version;
    lockStateByReservationId.delete(params.reservationId);
    await persistReservationState(params, state);
    return;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  ensureWritableByLock(params.reservationId, params.lockId, params.userId, params.deviceUuid);
  const index = state.reservations.findIndex(
    (reservation) => reservation.id === params.reservationId
  );
  if (index < 0) {
    throw new Error("Prenotazione non trovata.");
  }
  state.reservations.splice(index, 1);
  state.version += 1;
  lockStateByReservationId.delete(params.reservationId);
  await persistReservationState(params, state);
}

export async function fetchReservationTableAvailability(
  params: ReservationSessionRequest & {
    serviceDate: string;
    reservationAt: number;
    tableIds: string[];
    reservationIdToIgnore?: string;
  }
): Promise<TableAvailabilityInfo[]> {
  await sleep(100);
  assertSession(params);
  assertServiceDate(params.serviceDate);

  const backend = await postBackend(
    "/api/pos/reservations/availability",
    {
      ...params,
      serviceDate: params.serviceDate,
      reservationAt: params.reservationAt,
      tableIds: params.tableIds,
      reservationIdToIgnore: params.reservationIdToIgnore,
    },
    parseAvailabilityFromResponse,
    "Impossibile verificare la disponibilita tavoli."
  );
  if (backend.kind === "ok") {
    return backend.value;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const state = getOrCreateState(params.roomId, params.serviceDate);

  return params.tableIds.map((tableId) => {
    const normalizedTableId = tableId.trim();
    if (!normalizedTableId) {
      return {
        tableId,
        status: "conflict",
        nearestReservation: null,
        minutesDistance: 0,
        label: "Tavolo non valido",
      } satisfies TableAvailabilityInfo;
    }

    const { nearest, nearestDistance, status } = getNearestReservation(
      state.reservations,
      normalizedTableId,
      params.reservationAt,
      params.reservationIdToIgnore
    );
    return {
      tableId: normalizedTableId,
      status,
      nearestReservation: nearest ? cloneReservation(nearest) : null,
      minutesDistance: nearestDistance,
      label: buildAvailabilityLabel(status, nearest, nearestDistance),
    } satisfies TableAvailabilityInfo;
  });
}

export async function fetchReservationLockState(
  params: ReservationSessionRequest & { reservationId: string }
) {
  await sleep(60);
  assertSession(params);

  const backend = await postBackend(
    "/api/pos/reservations/lock/state",
    {
      ...params,
      reservationId: params.reservationId,
    },
    parseLockStateFromResponse,
    "Impossibile verificare il blocco prenotazione."
  );
  if (backend.kind === "ok") {
    return backend.value;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const activeLock = getActiveLock(params.reservationId);
  if (!activeLock) {
    return { locked: false as const, byCurrentSession: false };
  }
  const byCurrentSession =
    activeLock.userId === params.userId && activeLock.deviceUuid === params.deviceUuid;
  return {
    locked: true as const,
    byCurrentSession,
    expiresAt: activeLock.expiresAt,
  };
}

export function debugResetReservationMockState() {
  reservationStateByDay.clear();
  lockStateByReservationId.clear();
}
