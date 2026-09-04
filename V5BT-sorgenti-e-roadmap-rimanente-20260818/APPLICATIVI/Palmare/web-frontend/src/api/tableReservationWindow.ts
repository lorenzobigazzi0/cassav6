import {
  createDiningReservation,
  fetchReservationsForDay,
  type ReservationSummary,
} from "./reservations";
import { resolveOfflineConfigurationScope } from "./offlineConfigurationScope";
import { readOfflineReservations } from "../domain/offlineConfiguration/repository";
import type {
  DiningTable,
  TableReservationPreview,
  TableSessionRequest,
} from "../domain/tables/types";
import { normalizeTableCovers } from "../domain/tables/capacity";
import {
  coversForAssignedTable,
  intolerancesToTableAllergens,
  stripAllergyNote,
  tableAllergensToIntolerances,
  withAllergyNote,
} from "../domain/tables/reservationTranslation";
export type { TableReservationPreview } from "../domain/tables/types";

type BackendReservation = {
  id: string;
  status: "booked" | "arrived" | "no_show" | "released" | "cancelled";
  reservationAt: number;
  customerName: string;
  customerPhone: string;
  covers: number;
  note: string;
  intolerances: string;
  assignedTableId: string | null;
  assignedTableIds: string[];
  releasedAt?: number;
};

export const TABLE_RESERVATION_BLOCK_WINDOW_MS = 30 * 60_000;
const TABLE_RESERVATION_LATE_GRACE_MS = 30 * 60_000;
const RESERVATION_CACHE_TTL_MS = 15_000;

const reservationCache = new Map<
  string,
  { expiresAt: number; reservations: BackendReservation[] }
>();

const toLocalDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeComparableText = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const normalizeAssignedTableIds = (value: unknown, fallbackAssignedTableId?: unknown) => {
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

const parseReservation = (source: unknown): BackendReservation | null => {
  if (!source || typeof source !== "object") return null;
  const entry = source as Record<string, unknown>;
  const id = String(entry.id ?? "").trim();
  const reservationAt = Number(entry.reservationAt);
  const customerName = String(entry.customerName ?? "").trim();
  const assignedTableIds = normalizeAssignedTableIds(entry.assignedTableIds, entry.assignedTableId);
  const statusRaw = String(entry.status ?? "")
    .trim()
    .toLowerCase();
  const status: BackendReservation["status"] =
    statusRaw === "arrived" ||
    statusRaw === "no_show" ||
    statusRaw === "released" ||
    statusRaw === "cancelled"
      ? statusRaw
      : "booked";
  const releasedAt = Number(entry.releasedAt);
  const intolerances = String(entry.intolerances ?? "").trim();
  if (!id || !Number.isFinite(reservationAt) || !customerName) return null;
  return {
    id,
    status,
    reservationAt: Math.trunc(reservationAt),
    customerName,
    customerPhone: String(entry.customerPhone ?? "").trim(),
    covers: normalizeTableCovers(entry.covers, { minimum: 0, fallback: 0 }),
    note: String(entry.note ?? "").trim(),
    intolerances,
    assignedTableId: assignedTableIds[0] ?? null,
    assignedTableIds,
    ...(Number.isFinite(releasedAt) && releasedAt > 0
      ? { releasedAt: Math.trunc(releasedAt) }
      : {}),
  };
};

const isReservationTerminal = (reservation: BackendReservation) =>
  reservation.status === "arrived" ||
  reservation.status === "no_show" ||
  reservation.status === "released" ||
  reservation.status === "cancelled" ||
  (Number.isFinite(Number(reservation.releasedAt)) && Number(reservation.releasedAt) > 0);

async function fetchBackendReservations(params: TableSessionRequest, now = Date.now()) {
  const serviceDate = toLocalDateKey(new Date(now));
  const offlineScope = resolveOfflineConfigurationScope(params);
  const cacheKey = JSON.stringify([
    params.userId.trim(),
    offlineScope?.activityId ?? String(params.activityId ?? "").trim(),
    params.roomId.trim(),
    serviceDate,
  ]);
  const cached = reservationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.reservations;

  let summary: ReservationSummary;
  try {
    summary = await fetchReservationsForDay({
      token: params.token,
      userId: params.userId,
      deviceUuid: params.deviceUuid,
      activityId: params.activityId,
      roomId: params.roomId,
      serviceDate,
    });
  } catch (error) {
    const offlineSummary = offlineScope
      ? await readOfflineReservations(offlineScope, params.roomId, serviceDate)
      : null;
    if (!offlineSummary) throw error;
    summary = offlineSummary;
  }
  const reservations = summary.reservations
    .map(parseReservation)
    .filter((item): item is BackendReservation => item !== null);
  reservationCache.set(cacheKey, { expiresAt: now + RESERVATION_CACHE_TTL_MS, reservations });
  return reservations;
}

const tableMatchesReservation = (table: DiningTable, reservation: BackendReservation) => {
  const assignedTableIds = normalizeAssignedTableIds(
    reservation.assignedTableIds,
    reservation.assignedTableId
  );
  if (assignedTableIds.length === 0) return false;
  if (assignedTableIds.includes(table.id)) return true;
  const leafTableIds = Array.isArray(table.mobileLeafTableIds) ? table.mobileLeafTableIds : [];
  return assignedTableIds.some((tableId) => leafTableIds.includes(tableId));
};

const isSameGuest = (table: DiningTable, reservation: BackendReservation) => {
  const tableName = normalizeComparableText(table.tableName);
  const reservationName = normalizeComparableText(reservation.customerName);
  const tablePhone = normalizeComparableText(table.customerPhone);
  const reservationPhone = normalizeComparableText(reservation.customerPhone);
  return Boolean(
    (tableName && tableName === reservationName) || (tablePhone && tablePhone === reservationPhone)
  );
};

/**
 * Svuota la cache della derivazione: va chiamata dopo ogni mutazione di
 * prenotazione, altrimenti il tavolo resta indietro fino alla scadenza.
 */
export function invalidateTableReservationWindowCache() {
  reservationCache.clear();
}

export const shouldReserveTableForReservation = (reservationAt: number, now = Date.now()) =>
  Number.isFinite(reservationAt) &&
  reservationAt - now <= TABLE_RESERVATION_BLOCK_WINDOW_MS &&
  reservationAt >= now - TABLE_RESERVATION_LATE_GRACE_MS;

export const shouldWarnTableReleaseForReservation = (
  table: DiningTable,
  reservationAt: number,
  customerName = "",
  customerPhone = "",
  now = Date.now()
) =>
  table.occupancyState === "seated" &&
  shouldReserveTableForReservation(reservationAt, now) &&
  !isSameGuest(table, {
    id: "candidate",
    status: "booked",
    intolerances: "",
    reservationAt,
    customerName,
    customerPhone,
    covers: 0,
    note: "",
    assignedTableId: table.id,
    assignedTableIds: [table.id],
  });

export function applyReservationWindowToTables(
  tables: DiningTable[],
  reservations: BackendReservation[],
  now = Date.now()
) {
  return tables.map((table) => {
    const upcoming = reservations
      .filter((reservation) => !isReservationTerminal(reservation))
      .filter((reservation) => tableMatchesReservation(table, reservation))
      .filter((reservation) => reservation.reservationAt >= now - TABLE_RESERVATION_LATE_GRACE_MS)
      .sort((left, right) => left.reservationAt - right.reservationAt)[0];
    if (!upcoming) return { ...table, reservationPreview: null };

    const withinBlockWindow = shouldReserveTableForReservation(upcoming.reservationAt, now);
    const shouldWarnRelease =
      table.occupancyState === "seated" && withinBlockWindow && !isSameGuest(table, upcoming);
    const preview: TableReservationPreview = {
      id: upcoming.id,
      reservationAt: upcoming.reservationAt,
      customerName: upcoming.customerName,
      customerPhone: upcoming.customerPhone,
      covers: upcoming.covers,
      note: upcoming.note,
      withinBlockWindow,
      shouldWarnRelease,
    };
    if (table.occupancyState === "free") {
      const { allergens, manualIntolerance } = intolerancesToTableAllergens(upcoming.intolerances);
      return {
        ...table,
        reservationPreview: preview,
        occupancyState: withinBlockWindow ? ("reserved" as const) : table.occupancyState,
        reservationAt: upcoming.reservationAt,
        tableName: upcoming.customerName,
        customerPhone: upcoming.customerPhone,
        covers: coversForAssignedTable(upcoming.covers, upcoming.assignedTableIds, table.id),
        allergens,
        manualIntolerance,
        // Il marcatore si ricalcola dai token, cosi' non si accumula nelle note.
        note: withAllergyNote(
          upcoming.note || table.note,
          allergens.length > 0 || Boolean(manualIntolerance)
        ),
      };
    }
    return { ...table, reservationPreview: preview };
  });
}

export async function applyReservationWindowToSessionTables(
  tables: DiningTable[],
  params: TableSessionRequest,
  now = Date.now()
) {
  const reservations = await fetchBackendReservations(params, now).catch(() => []);
  return applyReservationWindowToTables(tables, reservations, now);
}

/**
 * Crea il record della prenotazione presa dal tavolo. Non va reso silenzioso:
 * senza record la prenotazione non esiste, e resterebbe solo sul tavolo.
 */
export async function saveTableReservationPreview(
  params: TableSessionRequest & {
    tableId: string;
    reservationAt: number;
    tableName: string;
    customerPhone?: string;
    covers?: number;
    note?: string;
    allergens?: readonly string[];
    manualIntolerance?: string;
  }
) {
  const serviceDate = toLocalDateKey(new Date(params.reservationAt));
  const session = {
    token: params.token,
    userId: params.userId,
    deviceUuid: params.deviceUuid,
    activityId: params.activityId,
    roomId: params.roomId,
  };
  await fetchReservationsForDay({ ...session, serviceDate });
  await createDiningReservation({
    ...session,
    serviceDate,
    reservationAt: params.reservationAt,
    customerName: params.tableName,
    customerPhone: params.customerPhone,
    covers: params.covers,
    intolerances: tableAllergensToIntolerances(params.allergens, params.manualIntolerance),
    // Sul record viaggia la nota del cliente: il marcatore e' un fatto del tavolo.
    note: stripAllergyNote(params.note),
    assignedTableId: params.tableId,
    assignedTableIds: [params.tableId],
  });
  reservationCache.clear();
}
