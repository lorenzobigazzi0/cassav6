import type { IntegrationLayoutTable } from "../tables/integrationTypes";
import type { DiningTableOrder } from "../tables/types";
import type {
  OfflineLayoutRoom,
  OfflineLayoutSnapshot,
  OfflineLayoutTable,
  RemovedActiveTableLifecycle,
} from "./types";

export type OfflineTableOperationalState = Pick<
  IntegrationLayoutTable,
  | "id"
  | "tableName"
  | "customerPhone"
  | "covers"
  | "occupancyState"
  | "reservationAt"
  | "seatedAt"
  | "ordersTaken"
  | "ordersInProgress"
  | "amountDue"
  | "note"
  | "allergens"
  | "manualIntolerance"
  | "offlineLifecycle"
> & {
  paymentArticleSplitLocked?: boolean;
  orderHistory?: DiningTableOrder[];
};

const cloneOfflineOrderHistory = (orders: DiningTableOrder[] | undefined) =>
  Array.isArray(orders)
    ? orders.map((order) => ({
        ...order,
        paidArticleUnits: [...(order.paidArticleUnits ?? [])],
        lines: order.lines.map((line) => ({ ...line })),
      }))
    : [];

export function isConfigurationTableActive(table: IntegrationLayoutTable) {
  return (
    table.occupancyState !== "free" ||
    table.ordersTaken > 0 ||
    table.ordersInProgress > 0 ||
    table.amountDue > 0 ||
    Number(table.reservationAt) > 0 ||
    Number(table.seatedAt) > 0
  );
}

const lifecycleFor = (
  table: IntegrationLayoutTable,
  removedAt: number,
  removedFromLayoutVersion: number
): RemovedActiveTableLifecycle => {
  const requiresDecision = table.occupancyState === "reserved" || Number(table.reservationAt) > 0;
  return {
    state: "removed_while_active",
    removedAt,
    removedFromLayoutVersion,
    usableUntil: "released",
    requiresDecision,
    decision: requiresDecision ? "pending" : "keep",
  };
};

export function tableNeedsConfigurationRemovalDecision(
  table: Pick<IntegrationLayoutTable, "occupancyState" | "reservationAt" | "offlineLifecycle">
) {
  const hasAssignedReservation =
    table.occupancyState === "reserved" || Number(table.reservationAt) > 0;
  return Boolean(
    hasAssignedReservation &&
    table.offlineLifecycle?.state === "removed_while_active" &&
    table.offlineLifecycle.requiresDecision &&
    table.offlineLifecycle.decision === "pending"
  );
}

export function reconcileOfflineLayout(
  previous: OfflineLayoutSnapshot | null,
  incoming: OfflineLayoutSnapshot,
  now = Date.now()
): OfflineLayoutSnapshot {
  if (!previous) {
    return {
      version: incoming.version,
      rooms: incoming.rooms.map(({ offlineLifecycle: _lifecycle, ...room }) => room),
      tables: incoming.tables.map(({ offlineLifecycle: _lifecycle, ...table }) => table),
    };
  }

  const incomingTableIds = new Set(incoming.tables.map((table) => table.id));
  const previousTablesById = new Map(previous.tables.map((table) => [table.id, table]));
  const authoritativeTables = incoming.tables.map(({ offlineLifecycle: _lifecycle, ...table }) => {
    const localOrderHistory = cloneOfflineOrderHistory(
      previousTablesById.get(table.id)?.orderHistory
    );
    return localOrderHistory.length > 0 ? { ...table, orderHistory: localOrderHistory } : table;
  });
  const retainedTables = previous.tables
    .filter((table) => !incomingTableIds.has(table.id))
    .filter(isConfigurationTableActive)
    .map<OfflineLayoutTable>((table) => ({
      ...table,
      offlineLifecycle: table.offlineLifecycle ?? lifecycleFor(table, now, incoming.version),
    }));

  const tables: OfflineLayoutTable[] = [...authoritativeTables, ...retainedTables];
  const requiredRetainedRoomIds = new Set(retainedTables.map((table) => table.roomId));
  const incomingRoomIds = new Set(incoming.rooms.map((room) => room.id));
  const retainedRooms: OfflineLayoutRoom[] = previous.rooms
    .filter((room) => !incomingRoomIds.has(room.id) && requiredRetainedRoomIds.has(room.id))
    .map((room) => ({
      ...room,
      offlineLifecycle: room.offlineLifecycle ?? {
        state: "removed_while_active",
        removedAt: now,
        removedFromLayoutVersion: incoming.version,
        usableUntil: "released",
        requiresDecision: false,
        decision: "keep",
      },
    }));

  return {
    version: incoming.version,
    rooms: [
      ...incoming.rooms.map(({ offlineLifecycle: _lifecycle, ...room }) => room),
      ...retainedRooms,
    ],
    tables,
  };
}

export function keepRemovedTableInCurrentService(
  layout: OfflineLayoutSnapshot,
  tableId: string
): OfflineLayoutSnapshot {
  const normalizedTableId = tableId.trim();
  if (!normalizedTableId) return layout;
  return {
    ...layout,
    tables: layout.tables.map((table) =>
      table.id === normalizedTableId && table.offlineLifecycle
        ? {
            ...table,
            offlineLifecycle: {
              ...table.offlineLifecycle,
              requiresDecision: false,
              decision: "keep",
            },
          }
        : table
    ),
  };
}

export function applyOfflineTableOperationalState(
  layout: OfflineLayoutSnapshot,
  table: OfflineTableOperationalState
): OfflineLayoutSnapshot {
  if (!layout.tables.some((entry) => entry.id === table.id)) return layout;
  return {
    ...layout,
    tables: layout.tables.map((entry) =>
      entry.id === table.id
        ? {
            ...entry,
            tableName: table.tableName,
            customerPhone: table.customerPhone,
            covers: table.covers,
            occupancyState: table.occupancyState,
            reservationAt: table.reservationAt,
            seatedAt: table.seatedAt,
            ordersTaken: table.ordersTaken,
            ordersInProgress: table.ordersInProgress,
            amountDue: table.amountDue,
            note: table.note,
            allergens: [...table.allergens],
            manualIntolerance: table.manualIntolerance,
            paymentArticleSplitLocked: table.paymentArticleSplitLocked === true,
            orderHistory: cloneOfflineOrderHistory(table.orderHistory),
            offlineLifecycle: table.offlineLifecycle
              ? { ...table.offlineLifecycle }
              : entry.offlineLifecycle,
          }
        : entry
    ),
  };
}
