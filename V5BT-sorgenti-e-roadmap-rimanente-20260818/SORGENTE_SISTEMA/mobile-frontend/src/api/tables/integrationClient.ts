import { apiFetch } from "../baseUrl";
import { normalizeAllergenList } from "../../domain/allergens";
import { normalizeTableCovers } from "../../domain/tables/capacity";
import {
  parseIntegrationLayoutRoom,
  parseIntegrationLayoutTable,
  parseIntegrationOrder,
} from "../../domain/tables/integrationParsers";
import type {
  IntegrationLayoutRoom,
  IntegrationLayoutTable,
  IntegrationOrder,
} from "../../domain/tables/integrationTypes";
import type {
  DiningTable,
  TableOccupancyState,
  TableSessionRequest,
} from "../../domain/tables/types";

export type RemovedSourceTableMoveSnapshot = {
  id: string;
  number: number;
  roomId: string;
  tableName: string;
  customerPhone: string;
  covers: number;
  occupancyState: Exclude<TableOccupancyState, "free">;
  reservationAt: number | null;
  seatedAt: number | null;
  ordersTaken: number;
  ordersInProgress: number;
  amountDue: number;
  note: string;
  allergens: string[];
  manualIntolerance: string;
  offlineLifecycle: NonNullable<DiningTable["offlineLifecycle"]>;
};

export const buildRemovedSourceTableMoveSnapshot = (
  table: DiningTable | null,
  roomId: string
): RemovedSourceTableMoveSnapshot | undefined => {
  if (!table?.offlineLifecycle || table.occupancyState === "free") return undefined;
  return {
    id: table.id,
    number: table.number,
    roomId,
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
    offlineLifecycle: { ...table.offlineLifecycle },
  };
};

export type IntegrationRequestResult = {
  ok: boolean;
  status: number;
  networkError: boolean;
  body: Record<string, unknown> | null;
};

export const shouldQueueForRetry = (status: number, networkError: boolean) => {
  if (networkError) return true;
  if (status === 0) return true;
  if (status >= 500) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return false;
};

export const postIntegrationJson = async (
  path: string,
  payload: unknown
): Promise<IntegrationRequestResult> => {
  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const bodyRaw = (await response.json().catch(() => null)) as unknown;
    const body =
      bodyRaw && typeof bodyRaw === "object" ? (bodyRaw as Record<string, unknown>) : null;
    return {
      ok: response.ok,
      status: response.status,
      networkError: false,
      body,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      networkError: true,
      body: null,
    };
  }
};

const readOrderCreateWarning = (
  body: Record<string, unknown> | null
): { code?: string; message?: string } => {
  if (!body || typeof body !== "object") return {};
  const warningRaw = body.pausedStationWarning;
  if (!warningRaw || typeof warningRaw !== "object") return {};
  const warning = warningRaw as Record<string, unknown>;
  const code = String(warning.code ?? "").trim() || undefined;
  const direct = String(warning.message ?? "").trim();
  if (direct) return { code, message: direct };
  const station = String(warning.station ?? "").trim();
  if (!station) return { code };
  return {
    code,
    message: `L'unica postazione ${station} e in pausa: la comanda restera in attesa fino alla ripresa.`,
  };
};

export const fetchIntegrationLayout = async (): Promise<{
  version: number;
  rooms: IntegrationLayoutRoom[];
  tables: IntegrationLayoutTable[];
} | null> => {
  try {
    const response = await apiFetch("/api/integration/layout", {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (response.headers.get("X-Palmare-Offline-Cache")?.trim() === "1") return null;
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      version?: unknown;
      rooms?: unknown;
      tables?: unknown;
    };
    if (!Array.isArray(payload.rooms) || !Array.isArray(payload.tables)) return null;
    const rooms = payload.rooms
      .map(parseIntegrationLayoutRoom)
      .filter((entry): entry is IntegrationLayoutRoom => entry !== null);
    const tables = payload.tables
      .map(parseIntegrationLayoutTable)
      .filter((entry): entry is IntegrationLayoutTable => entry !== null);
    if (payload.rooms.length > 0 && rooms.length === 0) return null;
    if (payload.tables.length > 0 && tables.length === 0) return null;
    const versionRaw = Number(payload.version);
    const version = Number.isFinite(versionRaw) ? Math.trunc(versionRaw) : Date.now();
    return { version, rooms, tables };
  } catch {
    return null;
  }
};

export const fetchIntegrationOrders = async (
  params: Pick<TableSessionRequest, "roomId">
): Promise<IntegrationOrder[] | null> => {
  try {
    const query = new URLSearchParams({
      includeDone: "1",
      includeTransferred: "1",
      currentSessionOnly: "1",
    });
    const roomId = String(params.roomId ?? "").trim();
    if (roomId) query.set("roomId", roomId);
    const response = await apiFetch(`/api/integration/orders?${query.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { orders?: unknown };
    if (!Array.isArray(payload.orders)) return null;
    return payload.orders
      .map(parseIntegrationOrder)
      .filter((entry): entry is IntegrationOrder => entry !== null)
      .filter((entry) => !entry.roomId || entry.roomId === params.roomId);
  } catch {
    return null;
  }
};

export const sendIntegrationOrderCreateRequest = async (
  payload: Record<string, unknown>
): Promise<{
  ok: boolean;
  status: number;
  networkError: boolean;
  id: string;
  order?: IntegrationOrder;
  warningCode?: string;
  warningMessage?: string;
}> => {
  const result = await postIntegrationJson("/api/integration/orders/create", payload);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      networkError: result.networkError,
      id: "",
    };
  }

  const order = parseIntegrationOrder(result.body?.order);
  const id = String(order?.id ?? "").trim();
  const warning = readOrderCreateWarning(result.body);

  return {
    ok: Boolean(id),
    status: result.status,
    networkError: false,
    id,
    ...(order ? { order } : {}),
    warningCode: warning.code,
    warningMessage: warning.message,
  };
};

export const sendIntegrationOrderSyncRequest = async (
  payload: Record<string, unknown>
): Promise<IntegrationRequestResult> =>
  postIntegrationJson("/api/integration/orders/sync", payload);

export const sendIntegrationLayoutSyncRequest = async (
  basePayload: Record<string, unknown>,
  payloadWithSession: Record<string, unknown> | null
): Promise<{ ok: boolean; status: number; networkError: boolean }> => {
  const result = await postIntegrationJson(
    "/api/integration/layout/table/sync",
    payloadWithSession ?? basePayload
  );
  return {
    ok: result.ok,
    status: result.status,
    networkError: result.networkError,
  };
};

const asMoney = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(Math.max(parsed, 0) * 100) / 100;
};

const asPositiveTimestamp = (value: unknown): number | null => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.trunc(numeric);
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const asStringList = (value: unknown) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        ),
      ]
    : [];

const occupancyFromBackendTable = (
  source: Record<string, unknown>,
  amountDue: number
): TableOccupancyState => {
  const occupancy = String(source.occupancyState ?? "")
    .trim()
    .toLowerCase();
  if (occupancy === "reserved" || occupancy === "seated") return occupancy;
  if (occupancy === "free") return amountDue > 0 ? "seated" : "free";

  const status = String(source.status ?? "")
    .trim()
    .toLowerCase();
  if (status === "reserved") return "reserved";
  if (status === "free") return amountDue > 0 ? "seated" : "free";
  return "seated";
};

const parseMovedDiningTable = (raw: unknown, movedOrdersCount = 0): DiningTable | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  if (!id) return undefined;
  const numberRaw = Number(source.number ?? 0);
  const number = Number.isFinite(numberRaw) ? Math.max(1, Math.trunc(numberRaw)) : 1;
  const amountDue = asMoney(source.amountDue ?? source.totalDue ?? source.dueAmount ?? 0);
  const occupancyState = occupancyFromBackendTable(source, amountDue);
  const pendingBillCount = Array.isArray(source.pendingBills) ? source.pendingBills.length : 0;
  const ordersTakenRaw = Number(source.ordersTaken);
  const ordersInProgressRaw = Number(source.ordersInProgress);
  const ordersTaken = Math.max(
    0,
    Number.isFinite(ordersTakenRaw) ? Math.trunc(ordersTakenRaw) : 0,
    pendingBillCount,
    movedOrdersCount
  );
  const ordersInProgress = Math.max(
    0,
    Number.isFinite(ordersInProgressRaw) ? Math.trunc(ordersInProgressRaw) : 0,
    occupancyState === "seated" && amountDue <= 0 && movedOrdersCount > 0 ? movedOrdersCount : 0
  );
  const reservation =
    source.reservation && typeof source.reservation === "object"
      ? (source.reservation as Record<string, unknown>)
      : null;
  return {
    id,
    number,
    tableName: String(
      source.tableName ?? source.guestName ?? reservation?.customerName ?? ""
    ).trim(),
    customerPhone: String(source.customerPhone ?? reservation?.customerPhone ?? "").trim(),
    covers: normalizeTableCovers(source.covers ?? reservation?.covers, {
      minimum: 0,
      fallback: 0,
    }),
    occupancyState,
    reservationAt: asPositiveTimestamp(source.reservationAt ?? reservation?.reservationAt),
    seatedAt: asPositiveTimestamp(source.seatedAt),
    ordersTaken,
    ordersInProgress,
    amountDue,
    note: String(source.note ?? reservation?.note ?? "").trim(),
    allergens: normalizeAllergenList(asStringList(source.allergens)),
    manualIntolerance: String(source.manualIntolerance ?? reservation?.intolerances ?? "").trim(),
    paymentArticleSplitLocked: source.paymentArticleSplitLocked === true,
    logicalTableId: String(source.logicalTableId ?? "").trim() || undefined,
    logicalTableLabel:
      String(source.logicalTableLabel ?? source.tableLabel ?? "").trim() || undefined,
    tableLabel: String(source.tableLabel ?? "").trim() || undefined,
    orderHistory: [],
  };
};

export const sendIntegrationLayoutMoveRequest = async (
  params: TableSessionRequest & {
    fromTableId: string;
    toTableId: string;
    targetRoomId?: string;
    removedSourceSnapshot?: RemovedSourceTableMoveSnapshot;
  }
): Promise<{
  ok: boolean;
  status: number;
  networkError: boolean;
  message?: string;
  movedOrdersCount?: number;
  fromTable?: DiningTable;
  toTable?: DiningTable;
}> => {
  const result = await postIntegrationJson("/api/integration/layout/table/move", {
    token: params.token,
    userId: params.userId,
    username: params.username ?? "",
    fullName: params.fullName ?? "",
    deviceUuid: params.deviceUuid,
    activityId: params.activityId ?? "",
    roomId: params.roomId,
    targetRoomId: params.targetRoomId ?? params.roomId,
    fromTableId: params.fromTableId,
    toTableId: params.toTableId,
    ...(params.removedSourceSnapshot
      ? { removedSourceSnapshot: params.removedSourceSnapshot }
      : {}),
    clientApp: "mobile-table-move",
  });
  const message = String(result.body?.error ?? result.body?.message ?? "").trim();
  const movedOrdersCountRaw = Number(result.body?.movedOrdersCount);
  const movedOrdersCount =
    Number.isFinite(movedOrdersCountRaw) && movedOrdersCountRaw > 0
      ? Math.trunc(movedOrdersCountRaw)
      : 0;
  return {
    ok: result.ok && result.body?.ok !== false,
    status: result.status,
    networkError: result.networkError,
    message: message || undefined,
    movedOrdersCount,
    fromTable: parseMovedDiningTable(result.body?.fromTable, 0),
    toTable: parseMovedDiningTable(result.body?.toTable, movedOrdersCount),
  };
};

export type IntegrationTableRoomMoveRequestResponse = {
  ok: boolean;
  status: number;
  networkError: boolean;
  approvalStatus?: "approved" | "pending";
  direct?: boolean;
  requestId?: string;
  message?: string;
};

export type IntegrationTableRoomMoveStatusResponse = {
  ok: boolean;
  status: number;
  networkError: boolean;
  approvalStatus?: "approved" | "pending" | "rejected" | "timeout_approved";
  message?: string;
};

export const sendIntegrationTableRoomMoveRequest = async (
  params: TableSessionRequest & {
    fromRoomName?: string;
    targetRoomId: string;
    fromTableId: string;
    fromTableLabel?: string;
    targetTableIds: string[];
    targetTableLabels?: string[];
    sourceLeafCount?: number;
    targetTableCount?: number;
  }
): Promise<IntegrationTableRoomMoveRequestResponse> => {
  const result = await postIntegrationJson("/api/integration/layout/table/room-move/request", {
    token: params.token,
    userId: params.userId,
    username: params.username ?? "",
    fullName: params.fullName ?? "",
    deviceUuid: params.deviceUuid,
    activityId: params.activityId ?? "",
    roomId: params.roomId,
    fromRoomId: params.roomId,
    fromRoomName: params.fromRoomName ?? "",
    targetRoomId: params.targetRoomId,
    fromTableId: params.fromTableId,
    fromTableLabel: params.fromTableLabel ?? "",
    targetTableIds: params.targetTableIds,
    targetTableLabels: params.targetTableLabels ?? [],
    sourceLeafCount: params.sourceLeafCount,
    targetTableCount: params.targetTableCount ?? params.targetTableIds.length,
    clientApp: "mobile-table-room-move",
  });
  const message = String(result.body?.error ?? result.body?.message ?? "").trim();
  const approvalStatusRaw = String(result.body?.status ?? "")
    .trim()
    .toLowerCase();
  const approvalStatus =
    approvalStatusRaw === "approved" || approvalStatusRaw === "pending"
      ? approvalStatusRaw
      : undefined;
  const requestRaw =
    result.body?.request && typeof result.body.request === "object"
      ? (result.body.request as Record<string, unknown>)
      : null;
  const requestId = String(result.body?.requestId ?? requestRaw?.requestId ?? "").trim();
  return {
    ok: result.ok && result.body?.ok !== false,
    status: result.status,
    networkError: result.networkError,
    approvalStatus,
    direct: result.body?.direct === true,
    requestId: requestId || undefined,
    message: message || undefined,
  };
};

export const fetchIntegrationTableRoomMoveStatus = async (
  params: TableSessionRequest & {
    requestId: string;
  }
): Promise<IntegrationTableRoomMoveStatusResponse> => {
  const result = await postIntegrationJson("/api/integration/layout/table/room-move/status", {
    token: params.token,
    userId: params.userId,
    username: params.username ?? "",
    fullName: params.fullName ?? "",
    deviceUuid: params.deviceUuid,
    roomId: params.roomId,
    requestId: params.requestId,
    clientApp: "mobile-table-room-move",
  });
  const message = String(result.body?.error ?? result.body?.message ?? "").trim();
  const approvalStatusRaw = String(result.body?.status ?? "")
    .trim()
    .toLowerCase();
  const approvalStatus =
    approvalStatusRaw === "approved" ||
    approvalStatusRaw === "pending" ||
    approvalStatusRaw === "rejected" ||
    approvalStatusRaw === "timeout_approved"
      ? approvalStatusRaw
      : undefined;
  return {
    ok: result.ok && result.body?.ok !== false,
    status: result.status,
    networkError: result.networkError,
    approvalStatus,
    message: message || undefined,
  };
};
