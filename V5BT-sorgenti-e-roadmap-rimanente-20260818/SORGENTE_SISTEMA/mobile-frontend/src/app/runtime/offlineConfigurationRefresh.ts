import { fetchAvailableRooms, type Room } from "../../api/locations";
import { fetchMenuCatalogForSession, type MenuCatalogSnapshot } from "../../api/menu";
import {
  fetchReservationsForDay,
  type DiningReservation,
  type ReservationSummary,
} from "../../api/reservations";
import { fetchIntegrationLayout } from "../../api/tables/integrationClient";
import { offlineMenuRoomKey, offlineReservationsKey } from "../../domain/offlineConfiguration/keys";
import { reconcileOfflineLayout } from "../../domain/offlineConfiguration/reconciliation";
import {
  readOfflineConfigurationSnapshot,
  stableOfflineConfigurationVersion,
  updateOfflineConfigurationSnapshot,
} from "../../domain/offlineConfiguration/repository";
import type {
  OfflineConfigurationRefreshResult,
  OfflineConfigurationScope,
  OfflineLayoutSnapshot,
} from "../../domain/offlineConfiguration/types";
import type { UserRole } from "../../types/auth";

export type OfflineConfigurationSyncSession = OfflineConfigurationScope & {
  token: string;
  deviceUuid: string;
  role: UserRole;
  currentRoomId?: string;
};

type RefreshOptions = {
  serviceDates?: string[];
  now?: number;
  isSessionCurrent?: () => boolean;
};

type RoomMenuResult = {
  roomId: string;
  snapshot: MenuCatalogSnapshot;
};

type RoomReservationResult = {
  roomId: string;
  serviceDate: string;
  summary: ReservationSummary;
};

const activeRefreshes = new Map<string, Promise<OfflineConfigurationRefreshResult>>();

const localDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const OFFLINE_RESERVATION_SYNC_WINDOW_DAYS = 8;

export function buildOfflineReservationDateWindow(
  now = Date.now(),
  days = OFFLINE_RESERVATION_SYNC_WINDOW_DAYS
) {
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  return Array.from({ length: Math.max(1, Math.trunc(days)) }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return localDateKey(date);
  });
}

const normalizedServiceDates = (serviceDates: string[] | undefined, now: number) => [
  ...new Set(
    (serviceDates?.length ? serviceDates : buildOfflineReservationDateWindow(now))
      .map((date) => date.trim())
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  ),
];

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>
) => {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, worker)
  );
  return results;
};

const canUseNetwork = () => typeof navigator === "undefined" || navigator.onLine !== false;

const assignedTableIdsFor = (reservation: DiningReservation) => [
  ...new Set(
    [...(reservation.assignedTableIds ?? []), reservation.assignedTableId ?? ""]
      .map((tableId) => tableId.trim())
      .filter(Boolean)
  ),
];

export function projectActiveReservationsOntoLayout(
  layout: OfflineLayoutSnapshot | null,
  reservations: DiningReservation[]
): OfflineLayoutSnapshot | null {
  if (!layout) return null;
  const byTableId = new Map<string, DiningReservation>();
  reservations
    .filter((reservation) => reservation.status === "booked" && reservation.reservationAt > 0)
    .forEach((reservation) => {
      assignedTableIdsFor(reservation).forEach((tableId) => {
        const current = byTableId.get(tableId);
        if (!current || reservation.reservationAt < current.reservationAt) {
          byTableId.set(tableId, reservation);
        }
      });
    });
  if (byTableId.size === 0) return layout;
  return {
    ...layout,
    tables: layout.tables.map((table) => {
      const reservation = byTableId.get(table.id);
      if (!reservation) return table;
      return {
        ...table,
        reservationAt: reservation.reservationAt,
        ...(table.occupancyState === "free"
          ? {
              tableName: reservation.customerName,
              customerPhone: reservation.customerPhone,
              covers: reservation.covers,
              note: reservation.note || table.note,
            }
          : {}),
      };
    }),
  };
}

async function performOfflineConfigurationRefresh(
  session: OfflineConfigurationSyncSession,
  options: RefreshOptions
): Promise<OfflineConfigurationRefreshResult> {
  const now = options.now ?? Date.now();
  const scope = { userId: session.userId.trim(), activityId: session.activityId.trim() };
  const previous = await readOfflineConfigurationSnapshot(scope);
  const emptyResult: OfflineConfigurationRefreshResult = {
    snapshot: previous,
    refreshed: { rooms: false, layout: false, menuRoomIds: [], reservationKeys: [] },
  };
  if (
    !session.token.trim() ||
    !session.deviceUuid.trim() ||
    !scope.userId ||
    !scope.activityId ||
    !canUseNetwork() ||
    options.isSessionCurrent?.() === false
  ) {
    return emptyResult;
  }

  let rooms: Room[] | null = null;
  try {
    rooms = await fetchAvailableRooms({
      token: session.token,
      userId: scope.userId,
      role: session.role,
      deviceUuid: session.deviceUuid,
      currentRoomId: session.currentRoomId,
      activityId: scope.activityId,
    });
  } catch {
    const snapshotAfterRoomsAttempt = await readOfflineConfigurationSnapshot(scope);
    const previousRoomsUpdatedAt = previous?.rooms?.updatedAt ?? 0;
    const nextRoomsUpdatedAt = snapshotAfterRoomsAttempt?.rooms?.updatedAt ?? 0;
    rooms =
      nextRoomsUpdatedAt > previousRoomsUpdatedAt
        ? (snapshotAfterRoomsAttempt?.rooms?.value ?? null)
        : null;
  }

  const roomsForRefresh = rooms ?? previous?.rooms?.value ?? [];
  const uniqueRooms = [...new Map(roomsForRefresh.map((room) => [room.id, room])).values()].filter(
    (room) =>
      room.id.trim().length > 0 &&
      (!room.activityId ||
        room.activityId === scope.activityId ||
        room.activityIds?.includes(scope.activityId))
  );
  const layoutPromise = fetchIntegrationLayout().catch(() => null);
  const menuResultsPromise = runWithConcurrency(
    uniqueRooms,
    4,
    async (room): Promise<RoomMenuResult> => ({
      roomId: room.id,
      snapshot: await fetchMenuCatalogForSession({
        token: session.token,
        userId: scope.userId,
        deviceUuid: session.deviceUuid,
        activityId: scope.activityId,
        roomId: room.id,
      }),
    })
  );
  const serviceDates = normalizedServiceDates(options.serviceDates, now);
  const reservationRequests = uniqueRooms.flatMap((room) =>
    serviceDates.map((serviceDate) => ({ room, serviceDate }))
  );
  const reservationResultsPromise = runWithConcurrency(
    reservationRequests,
    4,
    async ({ room, serviceDate }): Promise<RoomReservationResult> => ({
      roomId: room.id,
      serviceDate,
      summary: await fetchReservationsForDay({
        token: session.token,
        userId: scope.userId,
        deviceUuid: session.deviceUuid,
        roomId: room.id,
        activityId: scope.activityId,
        serviceDate,
      }),
    })
  );

  const [incomingLayout, menuResults, reservationResults] = await Promise.all([
    layoutPromise,
    menuResultsPromise,
    reservationResultsPromise,
  ]);
  if (options.isSessionCurrent?.() === false) return emptyResult;

  const successfulMenus = menuResults
    .filter(
      (result): result is PromiseFulfilledResult<RoomMenuResult> => result.status === "fulfilled"
    )
    .map((result) => result.value);
  const successfulReservations = reservationResults
    .filter(
      (result): result is PromiseFulfilledResult<RoomReservationResult> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value);
  const hasSuccessfulRefresh = Boolean(
    rooms || incomingLayout || successfulMenus.length || successfulReservations.length
  );

  const snapshot = await updateOfflineConfigurationSnapshot(scope, (current) => {
    const reservationSlicesForProjection = new Map(
      Object.entries(current.reservationsByRoomDate).map(([key, record]) => [key, record.value])
    );
    successfulReservations.forEach(({ roomId, serviceDate, summary }) => {
      reservationSlicesForProjection.set(offlineReservationsKey(roomId, serviceDate), summary);
    });
    const previousLayoutWithReservations = projectActiveReservationsOntoLayout(
      current.layout?.value ?? null,
      [...reservationSlicesForProjection.values()].flatMap((summary) => summary.reservations)
    );
    const nextLayout: OfflineLayoutSnapshot | null = incomingLayout
      ? reconcileOfflineLayout(previousLayoutWithReservations, incomingLayout, now)
      : previousLayoutWithReservations;
    const menusByRoom = { ...current.menusByRoom };
    successfulMenus.forEach(({ roomId, snapshot: menuSnapshot }) => {
      menusByRoom[offlineMenuRoomKey(roomId)] = {
        serverVersion: menuSnapshot.version,
        updatedAt: now,
        value: menuSnapshot,
      };
    });

    const reservationsByRoomDate = { ...current.reservationsByRoomDate };
    successfulReservations.forEach(({ roomId, serviceDate, summary }) => {
      const key = offlineReservationsKey(roomId, serviceDate);
      reservationsByRoomDate[key] = {
        serverVersion: summary.version,
        updatedAt: now,
        value: summary,
      };
    });

    return {
      ...current,
      lastRefreshAttemptAt: now,
      lastSuccessfulSyncAt: hasSuccessfulRefresh ? now : current.lastSuccessfulSyncAt,
      rooms: rooms
        ? {
            serverVersion: stableOfflineConfigurationVersion(rooms),
            updatedAt: now,
            value: rooms,
          }
        : current.rooms,
      layout: nextLayout
        ? {
            serverVersion: nextLayout.version,
            updatedAt: incomingLayout ? now : (current.layout?.updatedAt ?? now),
            value: nextLayout,
          }
        : null,
      menusByRoom,
      reservationsByRoomDate,
    };
  });

  return {
    snapshot,
    refreshed: {
      rooms: rooms !== null,
      layout: incomingLayout !== null,
      menuRoomIds: successfulMenus.map((result) => result.roomId),
      reservationKeys: successfulReservations.map((result) =>
        offlineReservationsKey(result.roomId, result.serviceDate)
      ),
    },
  };
}

export function refreshOfflineConfiguration(
  session: OfflineConfigurationSyncSession,
  options: RefreshOptions = {}
) {
  const refreshKey = [
    session.userId.trim(),
    session.activityId.trim(),
    session.deviceUuid.trim(),
    session.token,
  ].join("|");
  const current = activeRefreshes.get(refreshKey);
  if (current) return current;
  const next = performOfflineConfigurationRefresh(session, options);
  activeRefreshes.set(refreshKey, next);
  const clearRefresh = () => {
    if (activeRefreshes.get(refreshKey) === next) activeRefreshes.delete(refreshKey);
  };
  void next.then(clearRefresh, clearRefresh);
  return next;
}
