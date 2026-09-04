import { normalizeTableCovers } from "../domain/tables/capacity";

export type ReservationStatusColor = "free" | "safe" | "warning" | "danger" | "conflict";

export type DiningReservation = {
  id: string;
  roomId: string;
  serviceDate: string;
  status: "booked" | "arrived" | "no_show" | "released" | "cancelled";
  reservationAt: number;
  customerName: string;
  customerPhone: string;
  covers: number;
  intolerances: string;
  note: string;
  assignedTableId: string | null;
  assignedTableIds: string[];
  createdAt: number;
  updatedAt: number;
  releasedAt?: number;
  arrivedAt?: number;
  noShowAt?: number;
  cancelledAt?: number;
};

export type ReservationStatusAction = "arrived" | "no_show" | "released" | "cancelled";

export type ReservationStatusUpdateResult = {
  reservation: DiningReservation;
  tablesChanged: boolean;
  tableIds: string[];
};

export type ReservationEditLock = {
  reservationId: string;
  lockId: string;
  userId: string;
  deviceUuid: string;
  expiresAt: number;
};

export type ReservationSummary = {
  version: number;
  reservations: DiningReservation[];
};

export type ReservationSessionRequest = {
  token: string;
  userId: string;
  deviceUuid: string;
  roomId: string;
  activityId?: string;
};

export type TableAvailabilityInfo = {
  tableId: string;
  status: ReservationStatusColor;
  nearestReservation: DiningReservation | null;
  minutesDistance: number | null;
  label: string;
};

export const normalizeAssignedTableIds = (
  value: unknown,
  fallbackAssignedTableId?: unknown
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: unknown) => {
    const tableId = String(entry ?? "").trim();
    if (!tableId) return;
    const key = tableId.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tableId);
  };
  if (Array.isArray(value)) value.forEach(add);
  add(fallbackAssignedTableId);
  return out.slice(0, 24);
};

export const parseBackendError = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === "object") {
    const source = payload as Record<string, unknown>;
    const error = String(source.error ?? "").trim();
    if (error) return error;
  }
  return fallback;
};

export const parseReservation = (raw: unknown): DiningReservation | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  const roomId = String(source.roomId ?? "").trim();
  const serviceDate = String(source.serviceDate ?? "").trim();
  const customerName = String(source.customerName ?? "").trim();
  const reservationAt = Number(source.reservationAt);
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  if (!id || !roomId || !serviceDate || !customerName) return null;
  if (!Number.isFinite(reservationAt) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
    return null;
  }
  const assignedTableIds = normalizeAssignedTableIds(
    source.assignedTableIds,
    source.assignedTableId
  );
  const assignedTableId = assignedTableIds[0] ?? null;
  const statusRaw = String(source.status ?? "")
    .trim()
    .toLowerCase();
  const status: DiningReservation["status"] =
    statusRaw === "arrived" ||
    statusRaw === "no_show" ||
    statusRaw === "released" ||
    statusRaw === "cancelled"
      ? statusRaw
      : "booked";
  const releasedAt = Number(source.releasedAt);
  const arrivedAt = Number(source.arrivedAt);
  const noShowAt = Number(source.noShowAt);
  const cancelledAt = Number(source.cancelledAt);
  return {
    id,
    roomId,
    serviceDate,
    status,
    reservationAt: Math.trunc(reservationAt),
    customerName,
    customerPhone: String(source.customerPhone ?? "").trim(),
    covers: normalizeTableCovers(source.covers, { fallback: 2 }),
    intolerances: String(source.intolerances ?? "").trim(),
    note: String(source.note ?? "").trim(),
    assignedTableId,
    assignedTableIds,
    createdAt: Math.trunc(createdAt),
    updatedAt: Math.trunc(updatedAt),
    ...(Number.isFinite(releasedAt) && releasedAt > 0
      ? { releasedAt: Math.trunc(releasedAt) }
      : {}),
    ...(Number.isFinite(arrivedAt) && arrivedAt > 0 ? { arrivedAt: Math.trunc(arrivedAt) } : {}),
    ...(Number.isFinite(noShowAt) && noShowAt > 0 ? { noShowAt: Math.trunc(noShowAt) } : {}),
    ...(Number.isFinite(cancelledAt) && cancelledAt > 0
      ? { cancelledAt: Math.trunc(cancelledAt) }
      : {}),
  };
};

export const parseReservationSummaryResponse = (payload: unknown): ReservationSummary | null => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  const versionRaw = Number(source.version);
  const reservationsRaw = Array.isArray(source.reservations) ? source.reservations : null;
  if (!reservationsRaw) return null;
  const reservations = reservationsRaw
    .map(parseReservation)
    .filter((reservation): reservation is DiningReservation => reservation !== null)
    .sort((left, right) => left.reservationAt - right.reservationAt);
  return {
    version: Number.isFinite(versionRaw) ? Math.max(1, Math.trunc(versionRaw)) : 1,
    reservations,
  };
};

const parseReservationFromResponse = (payload: unknown): DiningReservation | null => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  return parseReservation(source.reservation ?? payload);
};

const parseResponseVersion = (payload: unknown): number | null => {
  if (!payload || typeof payload !== "object") return null;
  const version = Number((payload as Record<string, unknown>).version);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return version;
};

export const parseReservationMutationResponse = (payload: unknown) => {
  const reservation = parseReservationFromResponse(payload);
  const version = parseResponseVersion(payload);
  if (!reservation || version === null) return null;
  return { reservation, version };
};

export const parseReservationStatusResponse = (payload: unknown) => {
  const reservation = parseReservationFromResponse(payload);
  const version = parseResponseVersion(payload);
  if (!reservation || version === null) return null;
  const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    reservation,
    version,
    tablesChanged: source.tablesChanged === true,
    tableIds: normalizeAssignedTableIds(source.tableIds),
  };
};

export const parseReservationDeleteResponse = (payload: unknown) => {
  const version = parseResponseVersion(payload);
  if (version === null) return null;
  return { version };
};

export const parseLockFromResponse = (payload: unknown): ReservationEditLock | null => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  const lockSource =
    source.lock && typeof source.lock === "object"
      ? (source.lock as Record<string, unknown>)
      : source;
  const reservationId = String(lockSource.reservationId ?? "").trim();
  const lockId = String(lockSource.lockId ?? "").trim();
  const userId = String(lockSource.userId ?? "").trim();
  const deviceUuid = String(lockSource.deviceUuid ?? "").trim();
  const expiresAt = Number(lockSource.expiresAt);
  if (!reservationId || !lockId || !userId || !deviceUuid || !Number.isFinite(expiresAt)) {
    return null;
  }
  return {
    reservationId,
    lockId,
    userId,
    deviceUuid,
    expiresAt: Math.trunc(expiresAt),
  };
};

const parseAvailabilityInfo = (raw: unknown): TableAvailabilityInfo | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const tableId = String(source.tableId ?? "").trim();
  const statusRaw = String(source.status ?? "").trim();
  const status: ReservationStatusColor =
    statusRaw === "safe" ||
    statusRaw === "warning" ||
    statusRaw === "danger" ||
    statusRaw === "conflict"
      ? statusRaw
      : "free";
  if (!tableId) return null;
  const nearestReservation = parseReservation(source.nearestReservation);
  const minutesDistanceRaw = Number(source.minutesDistance);
  const minutesDistance = Number.isFinite(minutesDistanceRaw) ? minutesDistanceRaw : null;
  const label = String(source.label ?? "").trim() || "Disponibile";
  return {
    tableId,
    status,
    nearestReservation,
    minutesDistance,
    label,
  };
};

export const parseAvailabilityFromResponse = (payload: unknown): TableAvailabilityInfo[] | null => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  const itemsRaw = Array.isArray(source.items) ? source.items : null;
  if (!itemsRaw) return null;
  return itemsRaw
    .map(parseAvailabilityInfo)
    .filter((item): item is TableAvailabilityInfo => item !== null);
};

export const parseLockStateFromResponse = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  const locked = source.locked === true;
  const byCurrentSession = source.byCurrentSession === true;
  const expiresAtRaw = Number(source.expiresAt);
  const expiresAt = Number.isFinite(expiresAtRaw) ? Math.trunc(expiresAtRaw) : undefined;
  if (locked) {
    return {
      locked: true as const,
      byCurrentSession,
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
    };
  }
  return { locked: false as const, byCurrentSession: false };
};
