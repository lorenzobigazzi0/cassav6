import { apiFetch } from "./baseUrl";
import type { DiningTable, TableSessionRequest } from "./tables";
import { readLocalStorageString, writeLocalStorageString } from "../shared/storage/storageAdapter";

export type TableGroupNode =
  | {
      id: string;
      type: "simple";
    }
  | {
      id: string;
      type: "complex";
      children: TableGroupNode[];
    };

export type TableGroup = Extract<TableGroupNode, { type: "complex" }> & {
  updatedAt: string;
};

export type LogicalTableItem = {
  id: string;
  table: DiningTable;
  node: TableGroupNode;
  isComplex: boolean;
  label: string;
};

const GROUPS_URL = "/api/integration/table-groups";
const SAVE_GROUPS_URL = "/api/integration/table-groups/save";
const TABLE_GROUPS_CACHE_KEY_PREFIX = "pos_table_groups_cache_v1";

function nowIso() {
  return new Date().toISOString();
}

function normalize(value: unknown) {
  return String(value == null ? "" : value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneGroups(groups: TableGroup[]) {
  return JSON.parse(JSON.stringify(groups)) as TableGroup[];
}

function authHeaders(session: TableSessionRequest): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Client-App": "mobile-frontend",
  };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (session.userId) headers["X-User-Id"] = session.userId;
  if (session.activityId) headers["X-Activity-Id"] = session.activityId;
  if (session.username) headers["X-Username"] = session.username;
  if (session.deviceUuid) headers["X-Device-Uuid"] = session.deviceUuid;
  return headers;
}

function normalizeNode(value: unknown): TableGroupNode | null {
  if (!isRecord(value)) return null;
  const id = normalize(value.id || value.tableId);
  if (!id) return null;
  const children = Array.isArray(value.children)
    ? value.children.map(normalizeNode).filter((entry): entry is TableGroupNode => entry !== null)
    : [];
  if (children.length >= 2) {
    return { id, type: "complex", children };
  }
  return { id, type: "simple" };
}

export function flattenTableGroupNodeIds(
  node: TableGroupNode | null | undefined,
  output: string[] = []
) {
  if (!node) return output;
  if (node.type === "complex") {
    node.children.forEach((child) => flattenTableGroupNodeIds(child, output));
    return output;
  }
  if (node.id && !output.includes(node.id)) output.push(node.id);
  return output;
}

export function normalizeTableGroups(value: unknown): TableGroup[] {
  if (!Array.isArray(value)) return [];
  const usedLeaves = new Set<string>();
  const groups: TableGroup[] = [];

  value.forEach((entry) => {
    const node = normalizeNode(entry);
    if (!node || node.type !== "complex") return;
    const leaves = flattenTableGroupNodeIds(node);
    if (leaves.length < 2) return;
    if (leaves.some((id) => usedLeaves.has(id))) return;
    leaves.forEach((id) => usedLeaves.add(id));
    const updatedAt = isRecord(entry) ? normalize(entry.updatedAt) : "";
    groups.push({ ...node, updatedAt: updatedAt || nowIso() });
  });

  return groups;
}

function tableGroupsCacheKey(session: TableSessionRequest) {
  const userId = normalize(session.userId);
  const activityId = normalize(session.activityId);
  const roomId = normalize(session.roomId);
  if (!userId || !activityId || !roomId) return null;
  return [TABLE_GROUPS_CACHE_KEY_PREFIX, userId, activityId, roomId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function readCachedTableGroups(session: TableSessionRequest): TableGroup[] | null {
  const key = tableGroupsCacheKey(session);
  if (!key) return null;
  try {
    const payload = JSON.parse(readLocalStorageString(key) || "null") as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.groups)) return null;
    return normalizeTableGroups(payload.groups);
  } catch {
    return null;
  }
}

function writeCachedTableGroups(session: TableSessionRequest, groups: TableGroup[]) {
  const key = tableGroupsCacheKey(session);
  if (!key) return;
  writeLocalStorageString(
    key,
    JSON.stringify({ savedAt: Date.now(), groups: normalizeTableGroups(groups) })
  );
}

export async function fetchTableGroups(session: TableSessionRequest): Promise<TableGroup[]> {
  try {
    const response = await apiFetch(`${GROUPS_URL}?_=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: authHeaders(session),
    });
    if (response.headers.get("X-Palmare-Offline-Cache")?.trim() === "1") {
      return readCachedTableGroups(session) ?? [];
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (
      !response.ok ||
      !isRecord(payload) ||
      payload.ok === false ||
      !Array.isArray(payload.groups)
    ) {
      return readCachedTableGroups(session) ?? [];
    }
    const groups = normalizeTableGroups(payload.groups);
    writeCachedTableGroups(session, groups);
    return groups;
  } catch {
    return readCachedTableGroups(session) ?? [];
  }
}

export async function saveTableGroups(
  session: TableSessionRequest,
  nextGroups: TableGroup[],
  options: { operation?: "merge" | "split" | "move" } = {}
) {
  const groups = normalizeTableGroups(nextGroups);
  const response = await apiFetch(SAVE_GROUPS_URL, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...authHeaders(session),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token: session.token,
      userId: session.userId,
      username: session.username,
      fullName: session.fullName,
      deviceUuid: session.deviceUuid,
      activityId: session.activityId,
      roomId: session.roomId,
      operation: options.operation,
      groups,
    }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || !isRecord(payload) || payload.ok === false) {
    const message = isRecord(payload) ? normalize(payload.error || payload.message) : "";
    throw new Error(message || "Impossibile salvare l'unione tavoli.");
  }
  const savedGroups = Array.isArray(payload.groups) ? normalizeTableGroups(payload.groups) : groups;
  writeCachedTableGroups(session, savedGroups);
  return savedGroups;
}

export function tableGroupByRoot(groups: TableGroup[], rootId: string) {
  const safeRootId = normalize(rootId);
  return groups.find((group) => group.id === safeRootId) ?? null;
}

export function tableGroupContainingId(groups: TableGroup[], tableId: string) {
  const safeTableId = normalize(tableId);
  if (!safeTableId) return null;
  return (
    groups.find(
      (group) => group.id === safeTableId || flattenTableGroupNodeIds(group).includes(safeTableId)
    ) ?? null
  );
}

export function tableGroupDirectNodeKey(node: TableGroupNode, index: number) {
  return `${node.type}:${node.id}:${index}`;
}

export function tableGroupLeafLabels(node: TableGroupNode, tablesById: Map<string, DiningTable>) {
  return flattenTableGroupNodeIds(node)
    .map((id) => {
      const table = tablesById.get(id);
      const number = Math.trunc(Number(table?.number) || 0);
      return {
        sortNumber: number > 0 ? number : Number.MAX_SAFE_INTEGER,
        label: number > 0 ? `Tavolo ${number}` : `Tavolo ${id}`,
      };
    })
    .sort((left, right) => {
      if (left.sortNumber !== right.sortNumber) return left.sortNumber - right.sortNumber;
      return left.label.localeCompare(right.label, "it");
    })
    .map((entry) => entry.label)
    .filter((label, index, list) => list.indexOf(label) === index);
}

export function tableGroupCompositionLabel(
  node: TableGroupNode,
  tablesById: Map<string, DiningTable>
) {
  const numbers = flattenTableGroupNodeIds(node)
    .map((id) => Number(tablesById.get(id)?.number))
    .filter((number) => Number.isFinite(number) && number > 0)
    .sort((left, right) => left - right);
  const unique = Array.from(new Set(numbers));
  if (unique.length === 0) return "?";
  if (unique.length === 1) return String(unique[0]);
  const consecutive = unique.every(
    (number, index) => index === 0 || number === unique[index - 1] + 1
  );
  return consecutive ? `${unique[0]}-${unique[unique.length - 1]}` : unique.join("/");
}

export function tableStatus(table: DiningTable | null | undefined) {
  if (!table) return "libero";
  if (table.amountDue > 0) return "da_pagare";
  if (table.ordersInProgress > 0) return "ordine";
  if (table.occupancyState === "reserved") return "prenotato";
  if (table.occupancyState !== "free") return "occupato";
  return "libero";
}

export function tableStatusLabel(status: string) {
  return (
    {
      libero: "Libero",
      prenotato: "Prenotato",
      occupato: "Occupato",
      ordine: "Ordine",
      da_pagare: "Da pagare",
    }[status] || "Libero"
  );
}

export function getTableGroupActiveLeaves(
  node: TableGroupNode,
  tablesById: Map<string, DiningTable>
) {
  return flattenTableGroupNodeIds(node)
    .map((id) => ({ id, table: tablesById.get(id) ?? null }))
    .map((entry) => ({ ...entry, status: tableStatus(entry.table) }))
    .filter((entry) => entry.status !== "libero");
}

export function canMergeTableGroupNodes(
  nodes: TableGroupNode[],
  tablesById: Map<string, DiningTable>
) {
  const active = nodes.flatMap((node) => getTableGroupActiveLeaves(node, tablesById));
  return active.length <= 1;
}

export function tableGroupLogicalNodeForId(groups: TableGroup[], tableId: string): TableGroupNode {
  return tableGroupByRoot(groups, tableId) ?? { id: tableId, type: "simple" };
}

export function buildTablesById(tables: DiningTable[]) {
  return new Map(tables.map((table) => [table.id, table]));
}

export function topLogicalTableItems(
  tables: DiningTable[],
  groups: TableGroup[]
): LogicalTableItem[] {
  const tablesById = buildTablesById(tables);
  const rootIds = new Set(groups.map((group) => group.id));
  const hiddenIds = new Set<string>();
  groups.forEach((group) => {
    flattenTableGroupNodeIds(group).forEach((id) => {
      if (id !== group.id) hiddenIds.add(id);
    });
  });

  return tables
    .filter((table) => rootIds.has(table.id) || !hiddenIds.has(table.id))
    .map((table) => {
      const group = tableGroupByRoot(groups, table.id);
      return {
        id: table.id,
        table,
        node: group ?? { id: table.id, type: "simple" },
        isComplex: Boolean(group),
        label: group ? tableGroupCompositionLabel(group, tablesById) : String(table.number),
      };
    });
}

export function simpleFreeLogicalTableItems(
  tables: DiningTable[],
  groups: TableGroup[],
  excludedId: string
) {
  return topLogicalTableItems(tables, groups)
    .filter((item) => !item.isComplex)
    .filter((item) => item.id !== excludedId)
    .filter((item) => tableStatus(item.table) === "libero");
}

function aggregateGroupTable(
  group: TableGroup,
  tablesById: Map<string, DiningTable>
): DiningTable | null {
  const root = tablesById.get(group.id);
  if (!root) return null;

  const label = tableGroupCompositionLabel(group, tablesById);
  const leafTables = flattenTableGroupNodeIds(group)
    .map((id) => tablesById.get(id))
    .filter((table): table is DiningTable => Boolean(table));
  const activeLeaves = leafTables
    .map((table) => ({ table, status: tableStatus(table) }))
    .filter((entry) => entry.status !== "libero");
  const active = activeLeaves[0]?.table ?? root;
  const orderHistory = leafTables
    .flatMap((table) => table.orderHistory)
    .filter((order, index, list) => list.findIndex((entry) => entry.id === order.id) === index)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 120);

  return {
    ...root,
    tableName: active.tableName || root.tableName,
    customerPhone: active.customerPhone || root.customerPhone,
    note: active.note || root.note,
    allergens: active.allergens.length > 0 ? active.allergens : root.allergens,
    manualIntolerance: active.manualIntolerance || root.manualIntolerance,
    reservationAt: active.reservationAt ?? root.reservationAt,
    reservationPreview:
      active.reservationPreview ??
      root.reservationPreview ??
      leafTables.find((table) => table.reservationPreview)?.reservationPreview ??
      null,
    offlineLifecycle:
      active.offlineLifecycle ??
      root.offlineLifecycle ??
      leafTables.find((table) => table.offlineLifecycle)?.offlineLifecycle,
    seatedAt: active.seatedAt ?? root.seatedAt,
    occupancyState: active.occupancyState || root.occupancyState,
    amountDue:
      Math.round(leafTables.reduce((sum, table) => sum + Math.max(table.amountDue, 0), 0) * 100) /
      100,
    ordersInProgress: leafTables.reduce(
      (sum, table) => sum + Math.max(Math.trunc(table.ordersInProgress), 0),
      0
    ),
    ordersTaken: leafTables.reduce(
      (sum, table) => sum + Math.max(Math.trunc(table.ordersTaken), 0),
      0
    ),
    covers: leafTables.reduce((sum, table) => sum + Math.max(Math.trunc(table.covers), 0), 0),
    orderHistory,
    mobileComplex: true,
    mobileComplexLabel: label,
    mobileLeafTableIds: flattenTableGroupNodeIds(group),
    mobileActiveTableId: active.id,
    logicalTableId: group.id,
    logicalTableLabel: label,
    tableLabel: label,
  };
}

export function applyTableGroupsToTables(tables: DiningTable[], groups: TableGroup[]) {
  if (groups.length === 0) return tables;
  const normalizedGroups = normalizeTableGroups(groups);
  const tablesById = buildTablesById(tables);
  const hiddenIds = new Set<string>();
  normalizedGroups.forEach((group) => {
    flattenTableGroupNodeIds(group).forEach((id) => {
      if (id !== group.id) hiddenIds.add(id);
    });
  });

  return tables
    .map((table) => {
      const group = tableGroupByRoot(normalizedGroups, table.id);
      return group ? (aggregateGroupTable(group, tablesById) ?? table) : table;
    })
    .filter((table) => !hiddenIds.has(table.id));
}

export function buildMergedTableGroups(
  currentGroups: TableGroup[],
  rootId: string,
  selectedIds: string[],
  tables: DiningTable[],
  options: { allowMultipleActive?: boolean } = {}
) {
  if (selectedIds.length === 0) return currentGroups;
  const tablesById = buildTablesById(tables);
  const groups = cloneGroups(currentGroups);
  const rootIndex = groups.findIndex((group) => group.id === rootId);
  const rootNode: TableGroupNode =
    rootIndex >= 0 ? groups.splice(rootIndex, 1)[0] : { id: rootId, type: "simple" };
  const selectedNodes: TableGroupNode[] = [];

  selectedIds.forEach((id) => {
    const groupIndex = groups.findIndex((group) => group.id === id);
    selectedNodes.push(groupIndex >= 0 ? groups.splice(groupIndex, 1)[0] : { id, type: "simple" });
  });

  if (
    !options.allowMultipleActive &&
    !canMergeTableGroupNodes([rootNode, ...selectedNodes], tablesById)
  ) {
    throw new Error("Stati incompatibili: libera prima uno dei tavoli attivi.");
  }

  const children =
    rootNode.type === "complex"
      ? [...rootNode.children, ...selectedNodes]
      : [rootNode, ...selectedNodes];
  const seen = new Set<string>();
  const nextChildren = children.filter((child) => {
    const key = `${child.type}:${child.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  groups.push({ id: rootId, type: "complex", children: nextChildren, updatedAt: nowIso() });
  return normalizeTableGroups(groups);
}

export function buildSplitTableGroups(
  currentGroups: TableGroup[],
  rootId: string,
  selectedKeys: Set<string>
) {
  const groups = cloneGroups(currentGroups);
  const index = groups.findIndex((group) => group.id === rootId);
  if (index < 0) return groups;
  const group = groups.splice(index, 1)[0];
  const remaining: TableGroupNode[] = [];

  group.children.forEach((child, childIndex) => {
    const key = tableGroupDirectNodeKey(child, childIndex);
    if (!selectedKeys.has(key)) {
      remaining.push(child);
      return;
    }
    if (child.type === "complex") {
      groups.push({ ...child, updatedAt: nowIso() });
    }
  });

  if (remaining.length >= 2) {
    const rootStillInside = flattenTableGroupNodeIds({
      type: "complex",
      id: rootId,
      children: remaining,
    }).includes(rootId);
    const nextRootId = rootStillInside ? rootId : flattenTableGroupNodeIds(remaining[0])[0];
    groups.push({ id: nextRootId, type: "complex", children: remaining, updatedAt: nowIso() });
  } else if (remaining.length === 1 && remaining[0].type === "complex") {
    groups.push({ ...remaining[0], updatedAt: nowIso() });
  }

  return normalizeTableGroups(groups);
}
