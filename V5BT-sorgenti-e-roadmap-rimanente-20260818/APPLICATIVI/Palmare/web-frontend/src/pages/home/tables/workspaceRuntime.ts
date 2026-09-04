import type {
  DiningTable,
  DiningTableMoveResult,
  DiningTableOrderLine,
  RemovedDiningTableResult,
  TablesSnapshot,
} from "../../../api/tables";
import {
  parseIntegrationLayoutTable,
  parseIntegrationOrder,
  toDiningTableFromLayout,
} from "../../../domain/tables/integrationParsers";
import { toDiningOrderFromIntegration } from "../../../domain/tables/integrationOrderTransforms";
import { normalizeTableCovers } from "../../../domain/tables/capacity";
import type {
  IntegrationLayoutTable,
  IntegrationOrder,
} from "../../../domain/tables/integrationTypes";

export const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const cloneQueryTable = (table: DiningTable): DiningTable => ({
  ...table,
  allergens: [...table.allergens],
  orderHistory: table.orderHistory.map((order) => ({
    ...order,
    paidArticleUnits: [...(order.paidArticleUnits ?? [])],
    lines: order.lines.map((line) => ({ ...line })),
  })),
});

type OptimisticTablePatchResult = {
  snapshot: TablesSnapshot | undefined;
  table: DiningTable | null;
};

export type OptimisticTableMovePair = {
  sourceId: string;
  targetId: string;
};

export type OptimisticTableMoveResult = {
  movedFrom: DiningTable;
  movedTo: DiningTable;
  removedSourceTableId?: string;
};

export const resolveTableMoveLockIds = (
  tables: DiningTable[],
  sourceIds: string[],
  targetIds: string[]
) => {
  const tablesById = new Map(tables.map((table) => [table.id, table]));
  return [
    ...new Set([
      ...sourceIds.filter((tableId) => !tablesById.get(tableId)?.offlineLifecycle),
      ...targetIds,
    ]),
  ];
};

export const upsertSnapshotTable = (
  snapshot: TablesSnapshot | undefined,
  table: DiningTable
): TablesSnapshot | undefined => {
  if (!snapshot) return snapshot;
  const nextTable = cloneQueryTable(table);
  const upsert = (tables: DiningTable[]) => {
    const nextTables = tables.map(cloneQueryTable);
    const index = nextTables.findIndex((entry) => entry.id === nextTable.id);
    if (index >= 0) {
      nextTables[index] = nextTable;
    } else {
      nextTables.push(nextTable);
      nextTables.sort((left, right) => {
        if (left.number !== right.number) return left.number - right.number;
        return left.id.localeCompare(right.id, "it");
      });
    }
    return nextTables;
  };
  return {
    ...snapshot,
    version: snapshot.version + 1,
    tables: upsert(snapshot.tables),
    rawTables: snapshot.rawTables ? upsert(snapshot.rawTables) : undefined,
  };
};

export const removeSnapshotTable = (
  snapshot: TablesSnapshot | undefined,
  tableId: string
): TablesSnapshot | undefined => {
  if (!snapshot) return snapshot;
  const normalizedTableId = tableId.trim();
  if (!normalizedTableId) return snapshot;
  const tables = snapshot.tables.filter((table) => table.id !== normalizedTableId);
  const rawTables = snapshot.rawTables?.filter((table) => table.id !== normalizedTableId);
  if (
    tables.length === snapshot.tables.length &&
    rawTables?.length === snapshot.rawTables?.length
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    version: snapshot.version + 1,
    tables,
    rawTables,
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const unwrapRealtimePayloadDetail = (value: unknown): Record<string, unknown> | null => {
  const outer = asRecord(value);
  if (!outer) return null;
  return asRecord(outer.detail) ?? outer;
};

const collectLayoutTablesFromRealtimeDetail = (
  detail: Record<string, unknown>
): IntegrationLayoutTable[] => {
  const candidates = [
    detail.table,
    detail.fromTable,
    detail.toTable,
    ...(Array.isArray(detail.tables) ? detail.tables : []),
  ];
  return candidates
    .map(parseIntegrationLayoutTable)
    .filter((table): table is IntegrationLayoutTable => table !== null);
};

const collectOrdersFromRealtimeDetail = (detail: Record<string, unknown>): IntegrationOrder[] => {
  const candidates = [detail.order, ...(Array.isArray(detail.orders) ? detail.orders : [])];
  return candidates
    .map(parseIntegrationOrder)
    .filter((order): order is IntegrationOrder => order !== null);
};

const findSnapshotTable = (
  snapshot: TablesSnapshot | undefined,
  tableId: string
): DiningTable | null => {
  if (!snapshot) return null;
  return (
    snapshot.tables.find((table) => table.id === tableId) ??
    snapshot.rawTables?.find((table) => table.id === tableId) ??
    null
  );
};

const cleanShortText = (value: unknown, fallback = "", maxLength = 240) => {
  const normalized = String(value ?? fallback).trim();
  return normalized.slice(0, maxLength);
};

const cleanAllergens = (value: unknown) =>
  Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];

const cleanMoney = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100) / 100;
};

const cloneOrderLine = (line: DiningTableOrderLine): DiningTableOrderLine => ({ ...line });

export const applyOptimisticOccupyTableToSnapshot = (
  snapshot: TablesSnapshot | undefined,
  tableId: string,
  input: {
    tableName?: string;
    customerPhone?: string;
    covers?: number;
    note?: string;
    allergens?: string[];
    manualIntolerance?: string;
    seatedAt?: number;
  },
  now = Date.now()
): OptimisticTablePatchResult => {
  const current = findSnapshotTable(snapshot, tableId);
  if (!current) return { snapshot, table: null };
  const nextTable: DiningTable = {
    ...cloneQueryTable(current),
    tableName: cleanShortText(input.tableName, current.tableName || `Tavolo ${current.number}`, 16),
    customerPhone: cleanShortText(input.customerPhone, current.customerPhone, 24),
    covers: normalizeTableCovers(input.covers, { fallback: current.covers || 2 }),
    note: cleanShortText(input.note, current.note, 240),
    allergens: cleanAllergens(input.allergens ?? current.allergens),
    manualIntolerance: cleanShortText(input.manualIntolerance, current.manualIntolerance, 180),
    occupancyState: "seated",
    reservationAt: null,
    seatedAt: current.seatedAt ?? input.seatedAt ?? now,
  };
  return {
    snapshot: upsertSnapshotTable(snapshot, nextTable),
    table: nextTable,
  };
};

export const applyOptimisticOrderPendingToSnapshot = (
  snapshot: TablesSnapshot | undefined,
  tableId: string,
  input: {
    title?: string;
    total?: number;
    orderNote?: string;
    orderComment?: string;
    lines?: DiningTableOrderLine[];
  },
  now = Date.now()
): OptimisticTablePatchResult => {
  const current = findSnapshotTable(snapshot, tableId);
  if (!current || current.occupancyState !== "seated") return { snapshot, table: null };
  const nextOrderIndex = current.ordersTaken + 1;
  const nextOrder: DiningTable["orderHistory"][number] = {
    id: `optimistic_order_${tableId}_${now}`,
    title: cleanShortText(input.title, `Ordine #${nextOrderIndex}`, 64),
    createdAt: now,
    total: cleanMoney(input.total),
    state: "in_progress" as const,
    workflowStatus: "waiting" as const,
    orderNote: cleanShortText(input.orderNote, "", 200) || undefined,
    orderComment: cleanShortText(input.orderComment, "", 200) || undefined,
    paidArticleUnits: [],
    lines: Array.isArray(input.lines) ? input.lines.map(cloneOrderLine) : [],
  };
  const nextTable: DiningTable = {
    ...cloneQueryTable(current),
    occupancyState: "seated",
    reservationAt: null,
    seatedAt: current.seatedAt ?? now,
    ordersTaken: nextOrderIndex,
    ordersInProgress: current.ordersInProgress + 1,
    orderHistory: [nextOrder, ...current.orderHistory].slice(0, 120),
  };
  return {
    snapshot: upsertSnapshotTable(snapshot, nextTable),
    table: nextTable,
  };
};

export const applyOptimisticFreeTableToSnapshot = (
  snapshot: TablesSnapshot | undefined,
  tableId: string
): OptimisticTablePatchResult => {
  const current = findSnapshotTable(snapshot, tableId);
  if (!current) return { snapshot, table: null };
  if (current.offlineLifecycle) {
    return { snapshot: removeSnapshotTable(snapshot, tableId), table: null };
  }
  const nextTable: DiningTable = {
    ...cloneQueryTable(current),
    tableName: "",
    customerPhone: "",
    covers: 0,
    note: "",
    allergens: [],
    manualIntolerance: "",
    occupancyState: "free",
    reservationAt: null,
    seatedAt: null,
    ordersTaken: 0,
    ordersInProgress: 0,
    amountDue: 0,
    orderHistory: [],
    reservationPreview: null,
  };
  return {
    snapshot: upsertSnapshotTable(snapshot, nextTable),
    table: nextTable,
  };
};

const buildFreeMovedSource = (source: DiningTable): DiningTable => ({
  ...cloneQueryTable(source),
  tableName: "",
  customerPhone: "",
  covers: 0,
  note: "",
  allergens: [],
  manualIntolerance: "",
  occupancyState: "free",
  reservationAt: null,
  seatedAt: null,
  ordersTaken: 0,
  ordersInProgress: 0,
  amountDue: 0,
  orderHistory: [],
  reservationPreview: null,
});

export const buildOptimisticTableMove = (
  source: DiningTable | null,
  target: DiningTable | null
): OptimisticTableMoveResult | null => {
  if (!source || !target) return null;
  if (source.id === target.id) return null;
  if (source.occupancyState === "free") return null;
  if (target.occupancyState !== "free") return null;
  const sourceClone = cloneQueryTable(source);
  const targetClone = cloneQueryTable(target);
  return {
    movedFrom: buildFreeMovedSource(sourceClone),
    movedTo: {
      ...targetClone,
      tableName: sourceClone.tableName,
      customerPhone: sourceClone.customerPhone,
      covers: sourceClone.covers,
      occupancyState: sourceClone.occupancyState,
      reservationAt: sourceClone.reservationAt,
      seatedAt: sourceClone.seatedAt,
      ordersTaken: sourceClone.ordersTaken,
      ordersInProgress: sourceClone.ordersInProgress,
      amountDue: sourceClone.amountDue,
      note: sourceClone.note,
      allergens: [...sourceClone.allergens],
      manualIntolerance: sourceClone.manualIntolerance,
      orderHistory: sourceClone.orderHistory.map((order) => ({
        ...order,
        paidArticleUnits: [...(order.paidArticleUnits ?? [])],
        lines: order.lines.map((line) => ({ ...line })),
      })),
    },
    removedSourceTableId: sourceClone.offlineLifecycle ? sourceClone.id : undefined,
  };
};

export const applyOptimisticMoveTablesToSnapshot = (
  snapshot: TablesSnapshot | undefined,
  pairs: OptimisticTableMovePair[]
): { snapshot: TablesSnapshot | undefined; moves: OptimisticTableMoveResult[] } => {
  let nextSnapshot = snapshot;
  const moves: OptimisticTableMoveResult[] = [];
  pairs.forEach((pair) => {
    const source = findSnapshotTable(nextSnapshot, pair.sourceId);
    const target = findSnapshotTable(nextSnapshot, pair.targetId);
    const move = buildOptimisticTableMove(source, target);
    if (!move) return;
    nextSnapshot = upsertSnapshotTable(
      move.removedSourceTableId
        ? removeSnapshotTable(nextSnapshot, move.removedSourceTableId)
        : upsertSnapshotTable(nextSnapshot, move.movedFrom),
      move.movedTo
    );
    moves.push(move);
  });
  return { snapshot: nextSnapshot, moves };
};

export const applyOptimisticMoveTablesBetweenSnapshots = (
  sourceSnapshot: TablesSnapshot | undefined,
  targetSnapshot: TablesSnapshot | undefined,
  pairs: OptimisticTableMovePair[]
): {
  sourceSnapshot: TablesSnapshot | undefined;
  targetSnapshot: TablesSnapshot | undefined;
  moves: OptimisticTableMoveResult[];
} => {
  let nextSourceSnapshot = sourceSnapshot;
  let nextTargetSnapshot = targetSnapshot;
  const moves: OptimisticTableMoveResult[] = [];
  pairs.forEach((pair) => {
    const source = findSnapshotTable(nextSourceSnapshot, pair.sourceId);
    const target = findSnapshotTable(nextTargetSnapshot, pair.targetId);
    const move = buildOptimisticTableMove(source, target);
    if (!move) return;
    nextSourceSnapshot = move.removedSourceTableId
      ? removeSnapshotTable(nextSourceSnapshot, move.removedSourceTableId)
      : upsertSnapshotTable(nextSourceSnapshot, move.movedFrom);
    nextTargetSnapshot = upsertSnapshotTable(nextTargetSnapshot, move.movedTo);
    moves.push(move);
  });
  return {
    sourceSnapshot: nextSourceSnapshot,
    targetSnapshot: nextTargetSnapshot,
    moves,
  };
};

const mergeRealtimeLayoutTable = (
  snapshot: TablesSnapshot,
  layoutTable: IntegrationLayoutTable,
  orders: IntegrationOrder[]
) => {
  const baseTable = toDiningTableFromLayout(layoutTable);
  const existingTable = findSnapshotTable(snapshot, baseTable.id);
  const existingHistory = existingTable ? cloneQueryTable(existingTable).orderHistory : [];
  const matchingOrders = orders.filter(
    (order) =>
      order.tableId === baseTable.id ||
      (order.tableNumber > 0 && order.tableNumber === baseTable.number)
  );
  if (matchingOrders.length === 0) {
    return {
      ...baseTable,
      orderHistory: existingHistory,
    };
  }
  const nextHistory = [...existingHistory];
  matchingOrders.map(toDiningOrderFromIntegration).forEach((order) => {
    const index = nextHistory.findIndex((entry) => entry.id === order.id);
    if (index >= 0) {
      nextHistory[index] = order;
    } else {
      nextHistory.push(order);
    }
  });
  nextHistory.sort((left, right) => right.createdAt - left.createdAt);
  return {
    ...baseTable,
    orderHistory: nextHistory.slice(0, 120),
  };
};

export const applyRealtimeTablesPayloadToSnapshot = (
  snapshot: TablesSnapshot | undefined,
  eventDetail: unknown,
  currentRoomId: string
): TablesSnapshot | undefined => {
  if (!snapshot) return snapshot;
  const detail = unwrapRealtimePayloadDetail(eventDetail);
  if (!detail) return snapshot;
  const layoutTables = collectLayoutTablesFromRealtimeDetail(detail);
  if (layoutTables.length === 0) return snapshot;
  const normalizedRoomId = String(currentRoomId ?? "").trim();
  const orders = collectOrdersFromRealtimeDetail(detail);
  let nextSnapshot = snapshot;
  let applied = false;
  layoutTables.forEach((layoutTable) => {
    if (normalizedRoomId && layoutTable.roomId !== normalizedRoomId) return;
    const mergedTable = mergeRealtimeLayoutTable(
      nextSnapshot as TablesSnapshot,
      layoutTable,
      orders
    );
    const updatedSnapshot = upsertSnapshotTable(nextSnapshot, mergedTable);
    if (updatedSnapshot && updatedSnapshot !== nextSnapshot) {
      nextSnapshot = updatedSnapshot;
      applied = true;
    }
  });
  return applied ? nextSnapshot : snapshot;
};

export const isDiningTableValue = (value: unknown): value is DiningTable =>
  Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as DiningTable).id === "string" &&
    Array.isArray((value as DiningTable).orderHistory)
  );

export const isRemovedDiningTableResult = (value: unknown): value is RemovedDiningTableResult =>
  Boolean(
    value &&
    typeof value === "object" &&
    (value as RemovedDiningTableResult).removedFromConfiguration === true &&
    typeof (value as RemovedDiningTableResult).removedTableId === "string"
  );

export const isTableMoveResult = (value: unknown): value is DiningTableMoveResult =>
  Boolean(
    value &&
    typeof value === "object" &&
    isDiningTableValue((value as { movedFrom?: unknown }).movedFrom) &&
    isDiningTableValue((value as { movedTo?: unknown }).movedTo)
  );

export const applyResolvedTableMoveToSnapshot = (
  snapshot: TablesSnapshot | undefined,
  result: DiningTableMoveResult
) =>
  upsertSnapshotTable(
    result.removedSourceTableId
      ? removeSnapshotTable(snapshot, result.removedSourceTableId)
      : upsertSnapshotTable(snapshot, result.movedFrom),
    result.movedTo
  );

export const shouldRefreshTablesForServerEvent = (reason: unknown) => {
  const normalized = String(reason ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("monitor_") ||
    normalized.startsWith("table_") ||
    normalized.startsWith("order_") ||
    normalized.startsWith("reservation_") ||
    normalized.includes("layout")
  );
};
