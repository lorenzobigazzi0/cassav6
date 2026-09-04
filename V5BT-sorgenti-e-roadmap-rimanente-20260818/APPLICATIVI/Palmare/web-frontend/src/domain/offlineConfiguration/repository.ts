import {
  readStoredConfigurationSnapshot,
  writeStoredConfigurationSnapshot,
  type StoredConfigurationSnapshot,
} from "../../shared/offline/configurationSnapshotStore";
import {
  offlineMenuRoomKey,
  offlineReservationsKey,
  offlineConfigurationSnapshotKey,
} from "./keys";
import {
  applyOfflineTableOperationalState,
  keepRemovedTableInCurrentService,
  reconcileOfflineLayout,
} from "./reconciliation";
import {
  OFFLINE_CONFIGURATION_SCHEMA_VERSION,
  type OfflineConfigurationPayload,
  type OfflineConfigurationScope,
  type OfflineConfigurationSnapshot,
} from "./types";
import type { Room } from "../../api/locations";
import type { MenuCatalogSnapshot } from "../../api/menu";
import type { ReservationSummary } from "../../api/reservations";
import type { DiningTable } from "../tables/types";
import type { OfflineLayoutSnapshot } from "./types";

const updateQueues = new Map<string, Promise<OfflineConfigurationSnapshot | null>>();

const emptyPayload = (scope: OfflineConfigurationScope): OfflineConfigurationPayload => ({
  userId: scope.userId,
  activityId: scope.activityId,
  lastRefreshAttemptAt: 0,
  lastSuccessfulSyncAt: 0,
  rooms: null,
  layout: null,
  menusByRoom: {},
  reservationsByRoomDate: {},
});

const toSnapshot = (
  record: StoredConfigurationSnapshot<OfflineConfigurationPayload>
): OfflineConfigurationSnapshot | null => {
  if (record.schemaVersion !== OFFLINE_CONFIGURATION_SCHEMA_VERSION) return null;
  if (!record.payload || typeof record.payload !== "object") return null;
  if (!record.payload.userId?.trim() || !record.payload.activityId?.trim()) return null;
  return {
    ...record.payload,
    key: record.key,
    schemaVersion: OFFLINE_CONFIGURATION_SCHEMA_VERSION,
    revision: record.revision,
    savedAt: record.savedAt,
  };
};

const payloadOf = (snapshot: OfflineConfigurationSnapshot): OfflineConfigurationPayload => {
  const {
    key: _key,
    schemaVersion: _schemaVersion,
    revision: _revision,
    savedAt: _savedAt,
    ...payload
  } = snapshot;
  return payload;
};

export async function readOfflineConfigurationSnapshot(scope: OfflineConfigurationScope) {
  const key = offlineConfigurationSnapshotKey(scope);
  if (!key) return null;
  const record = await readStoredConfigurationSnapshot<OfflineConfigurationPayload>(key);
  const snapshot = record ? toSnapshot(record) : null;
  if (!snapshot) return null;
  if (snapshot.userId !== scope.userId.trim() || snapshot.activityId !== scope.activityId.trim()) {
    return null;
  }
  return snapshot;
}

export async function updateOfflineConfigurationSnapshot(
  scope: OfflineConfigurationScope,
  updater: (
    current: OfflineConfigurationSnapshot
  ) => OfflineConfigurationSnapshot | Promise<OfflineConfigurationSnapshot>
) {
  const key = offlineConfigurationSnapshotKey(scope);
  if (!key) return null;
  const normalizedScope = { userId: scope.userId.trim(), activityId: scope.activityId.trim() };
  const previousQueue = updateQueues.get(key) ?? Promise.resolve(null);
  const nextQueue = previousQueue
    .catch(() => null)
    .then(async () => {
      const stored = await readOfflineConfigurationSnapshot(normalizedScope);
      const now = Date.now();
      const current: OfflineConfigurationSnapshot = stored ?? {
        ...emptyPayload(normalizedScope),
        key,
        schemaVersion: OFFLINE_CONFIGURATION_SCHEMA_VERSION,
        revision: 0,
        savedAt: 0,
      };
      const updated = await updater(current);
      if (
        updated.userId !== normalizedScope.userId ||
        updated.activityId !== normalizedScope.activityId
      ) {
        return current;
      }
      const record: StoredConfigurationSnapshot<OfflineConfigurationPayload> = {
        key,
        schemaVersion: OFFLINE_CONFIGURATION_SCHEMA_VERSION,
        revision: current.revision + 1,
        savedAt: now,
        payload: payloadOf(updated),
      };
      const saved = await writeStoredConfigurationSnapshot(record);
      return saved ? toSnapshot(record) : current;
    });
  updateQueues.set(key, nextQueue);
  const clearQueue = () => {
    if (updateQueues.get(key) === nextQueue) updateQueues.delete(key);
  };
  void nextQueue.then(clearQueue, clearQueue);
  return nextQueue;
}

export async function readOfflineRooms(scope: OfflineConfigurationScope) {
  return (await readOfflineConfigurationSnapshot(scope))?.rooms?.value ?? null;
}

export async function readOfflineLayout(scope: OfflineConfigurationScope) {
  return (await readOfflineConfigurationSnapshot(scope))?.layout?.value ?? null;
}

export async function readOfflineMenu(scope: OfflineConfigurationScope, roomId: string) {
  const key = offlineMenuRoomKey(roomId);
  if (!key) return null;
  return (await readOfflineConfigurationSnapshot(scope))?.menusByRoom[key]?.value ?? null;
}

export async function readOfflineReservations(
  scope: OfflineConfigurationScope,
  roomId: string,
  serviceDate: string
) {
  const key = offlineReservationsKey(roomId, serviceDate);
  if (!key) return null;
  return (
    (await readOfflineConfigurationSnapshot(scope))?.reservationsByRoomDate[key]?.value ?? null
  );
}

export async function recordOfflineRooms(
  scope: OfflineConfigurationScope,
  rooms: Room[],
  now = Date.now()
) {
  return updateOfflineConfigurationSnapshot(scope, (current) => ({
    ...current,
    lastRefreshAttemptAt: now,
    lastSuccessfulSyncAt: now,
    rooms: {
      serverVersion: stableOfflineConfigurationVersion(rooms),
      updatedAt: now,
      value: rooms,
    },
  }));
}

export async function recordOfflineLayout(
  scope: OfflineConfigurationScope,
  incoming: OfflineLayoutSnapshot,
  now = Date.now()
) {
  return updateOfflineConfigurationSnapshot(scope, (current) => {
    const layout = reconcileOfflineLayout(current.layout?.value ?? null, incoming, now);
    return {
      ...current,
      lastRefreshAttemptAt: now,
      lastSuccessfulSyncAt: now,
      layout: {
        serverVersion: layout.version,
        updatedAt: now,
        value: layout,
      },
    };
  });
}

export async function recordOfflineMenu(
  scope: OfflineConfigurationScope,
  roomId: string,
  menu: MenuCatalogSnapshot,
  now = Date.now()
) {
  const key = offlineMenuRoomKey(roomId);
  if (!key) return null;
  return updateOfflineConfigurationSnapshot(scope, (current) => ({
    ...current,
    lastRefreshAttemptAt: now,
    lastSuccessfulSyncAt: now,
    menusByRoom: {
      ...current.menusByRoom,
      [key]: { serverVersion: menu.version, updatedAt: now, value: menu },
    },
  }));
}

export async function recordOfflineReservations(
  scope: OfflineConfigurationScope,
  roomId: string,
  serviceDate: string,
  incoming: ReservationSummary,
  now = Date.now()
) {
  const key = offlineReservationsKey(roomId, serviceDate);
  if (!key) return null;
  return updateOfflineConfigurationSnapshot(scope, (current) => ({
    ...current,
    lastRefreshAttemptAt: now,
    lastSuccessfulSyncAt: now,
    reservationsByRoomDate: {
      ...current.reservationsByRoomDate,
      [key]: { serverVersion: incoming.version, updatedAt: now, value: incoming },
    },
  }));
}

export async function keepOfflineRemovedTable(scope: OfflineConfigurationScope, tableId: string) {
  const normalizedTableId = tableId.trim();
  if (!normalizedTableId) return null;
  return updateOfflineConfigurationSnapshot(scope, (current) =>
    current.layout
      ? {
          ...current,
          layout: {
            ...current.layout,
            value: keepRemovedTableInCurrentService(current.layout.value, normalizedTableId),
          },
        }
      : current
  );
}

export async function recordOfflineTableState(
  scope: OfflineConfigurationScope,
  table: DiningTable
) {
  return updateOfflineConfigurationSnapshot(scope, (current) => {
    if (!current.layout) return current;
    return {
      ...current,
      layout: {
        ...current.layout,
        value: applyOfflineTableOperationalState(current.layout.value, table),
      },
    };
  });
}

export async function replaceOfflineTableOrderId(
  scope: OfflineConfigurationScope,
  tableId: string,
  fromOrderId: string,
  toOrderId: string
) {
  const normalizedTableId = tableId.trim();
  const normalizedFromOrderId = fromOrderId.trim();
  const normalizedToOrderId = toOrderId.trim();
  if (
    !normalizedTableId ||
    !normalizedFromOrderId ||
    !normalizedToOrderId ||
    normalizedFromOrderId === normalizedToOrderId
  ) {
    return null;
  }
  return updateOfflineConfigurationSnapshot(scope, (current) => {
    if (!current.layout) return current;
    return {
      ...current,
      layout: {
        ...current.layout,
        value: {
          ...current.layout.value,
          tables: current.layout.value.tables.map((table) => {
            if (table.id !== normalizedTableId || !Array.isArray(table.orderHistory)) {
              return table;
            }
            return {
              ...table,
              orderHistory: table.orderHistory.map((order) =>
                order.id === normalizedFromOrderId ? { ...order, id: normalizedToOrderId } : order
              ),
            };
          }),
        },
      },
    };
  });
}

export async function releaseOfflineRemovedTable(
  scope: OfflineConfigurationScope,
  tableId: string
) {
  const normalizedTableId = tableId.trim();
  if (!normalizedTableId) return null;
  return updateOfflineConfigurationSnapshot(scope, (current) => {
    if (!current.layout) return current;
    const nextTables = current.layout.value.tables.filter(
      (table) => table.id !== normalizedTableId || !table.offlineLifecycle
    );
    const retainedRoomIds = new Set(nextTables.map((table) => table.roomId));
    return {
      ...current,
      layout: {
        ...current.layout,
        value: {
          ...current.layout.value,
          tables: nextTables,
          rooms: current.layout.value.rooms.filter(
            (room) => !room.offlineLifecycle || retainedRoomIds.has(room.id)
          ),
        },
      },
    };
  });
}

export function stableOfflineConfigurationVersion(value: unknown) {
  const input = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
