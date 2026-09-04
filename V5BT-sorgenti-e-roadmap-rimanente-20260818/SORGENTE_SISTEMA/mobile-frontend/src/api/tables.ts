import {
  appendAnalyticsTransaction,
  readBackendPaymentId,
  type AnalyticsPaymentMethod,
} from "../utils/analyticsTransactions";
import { apiFetch } from "./baseUrl";
import { MOBILE_SESSION_ENDING_EVENT } from "../app/session/sessionLifecycle";
import {
  buildRemovedSourceTableMoveSnapshot,
  fetchIntegrationLayout,
  fetchIntegrationOrders,
  sendIntegrationLayoutMoveRequest,
  sendIntegrationLayoutSyncRequest,
  sendIntegrationOrderCreateRequest,
  sendIntegrationOrderSyncRequest,
  shouldQueueForRetry,
} from "./tables/integrationClient";
import { applyTableGroupsToTables, fetchTableGroups, type TableGroup } from "./tableGroups";
import type { ProductClientPriceSnapshot } from "../shared/pricing/productPricing";
import { expandOrderEmissionUnitAmounts } from "../shared/pricing/orderEmissionPricing";
import {
  applyReservationWindowToSessionTables,
  saveTableReservationPreview,
  shouldReserveTableForReservation,
} from "./tableReservationWindow";
import { derivePosStatusFromDiningTable } from "../domain/tables/derivations";
import { normalizeAllergenList } from "../domain/allergens";
import {
  parseIntegrationWorkflowStatus,
  toDiningTableFromLayout,
} from "../domain/tables/integrationParsers";
import {
  buildIntegrationOrderFingerprint,
  isIntegrationOrderOpen,
  isTerminalIntegrationWorkflowStatus,
  toDiningOrderFromIntegration,
} from "../domain/tables/integrationOrderTransforms";
import type {
  IntegrationOrder,
  IntegrationOrderCreateResult,
  IntegrationQueueOwner,
  PendingIntegrationAction,
} from "../domain/tables/integrationTypes";
import {
  integrationQueueOwnersEqual,
  isIntegrationQueueActionOwnedBy,
  loadIntegrationQueueFromStorage,
  saveIntegrationQueueToStorage,
} from "../domain/tables/integrationQueueStorage";
import {
  sanitizeAllergens,
  sanitizeManualIntolerance,
  sanitizePhone,
  sanitizeTableName,
} from "./tables/inputSanitizers";
import { TABLE_SESSION_HISTORY_GRACE_MS } from "../domain/tables/queryKeys";
import { normalizeTableCovers } from "../domain/tables/capacity";
import { AUTH_STORAGE_KEYS, readAuthStorage } from "../shared/storage/authStorage";
import type {
  DiningOrderPriceChangeReason,
  DiningTable,
  DiningTableOrder,
  DiningTableOrderLine,
  PosTableStatus,
  TablePaymentAdminAdjustment,
  TableCommercialBenefitApplication,
  TablePaymentInvoiceRecipient,
  TablePaymentMethod,
  TablePaymentReceiptType,
  TablePaymentSplitMode,
  TableSessionRequest,
} from "../domain/tables/types";
import { resolveOfflineConfigurationScope } from "./offlineConfigurationScope";
import {
  readOfflineLayout,
  keepOfflineRemovedTable,
  recordOfflineTableState,
  recordOfflineLayout,
  replaceOfflineTableOrderId,
  releaseOfflineRemovedTable,
} from "../domain/offlineConfiguration/repository";

export type {
  DiningOrderPriceChangeReason,
  DiningTable,
  DiningTableOrder,
  DiningTableOrderLine,
  DiningTableVisualState,
  IntegrationOrderWorkflowStatus,
  PosTableStatus,
  TableOccupancyState,
  TableOrderState,
  TablePaymentAdminAdjustment,
  TableCommercialBenefitApplication,
  TablePaymentInvoiceRecipient,
  TablePaymentMethod,
  TablePaymentReceiptType,
  TablePaymentSplitMode,
  TableReservationPreview,
  TableSessionRequest,
} from "../domain/tables/types";
export type {
  TablePaymentAdminAdjustmentType,
  TablePaymentAdminLineAdjustment,
} from "../domain/tables/types";
export { deriveTableVisualState } from "../domain/tables/derivations";
export { buildIntegrationOrderFingerprint } from "../domain/tables/integrationOrderTransforms";
export { tablesQueryKey } from "../domain/tables/queryKeys";

export type TablesSnapshot = {
  version: number;
  tables: DiningTable[];
  rawTables?: DiningTable[];
  tableGroups?: TableGroup[];
};

export type RemovedDiningTableResult = {
  removedFromConfiguration: true;
  removedTableId: string;
};

export type DiningTableMoveResult = {
  movedFrom: DiningTable;
  movedTo: DiningTable;
  removedSourceTableId?: string;
};

type RoomTablesState = {
  version: number;
  tables: DiningTable[];
};

const DEV_ONLY_TABLE_COUNT = 12;

const roomStates = new Map<string, RoomTablesState>();
const roomIntegrationFingerprint = new Map<string, string>();
const roomLayoutFingerprint = new Map<string, string>();
const INTEGRATION_QUEUE_FALLBACK_FLUSH_MS = 90_000;
const REALTIME_TRANSPORT_STATUS_EVENT = "pos:realtime-transport-status";
const integrationQueue: PendingIntegrationAction[] = [];
let integrationQueueInitialized = false;
let integrationQueueFlushRunning = false;
let tablesSessionLifecycleResetInstalled = false;

export const resetTablesSessionMemory = () => {
  roomStates.clear();
  roomIntegrationFingerprint.clear();
  roomLayoutFingerprint.clear();
};

export const installTablesSessionLifecycleReset = () => {
  if (tablesSessionLifecycleResetInstalled || typeof window === "undefined") return;
  tablesSessionLifecycleResetInstalled = true;
  window.addEventListener(MOBILE_SESSION_ENDING_EVENT, resetTablesSessionMemory);
};

installTablesSessionLifecycleReset();

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const asMoney = (value: number) => Math.round(value * 100) / 100;
const isIntegrationOrderId = (value: string) => /^\d{5,}$/.test(value.trim());

const sanitizeOptionalMoney = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return asMoney(parsed);
};

const sanitizeOptionalSignedMoney = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return asMoney(parsed);
};

const sanitizePriceChangeReason = (value: unknown): DiningOrderPriceChangeReason | undefined => {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return undefined;
  if (raw === "variant") return "variant";
  if (raw === "manual") return "manual";
  if (raw === "supplement") return "supplement";
  return "unknown";
};

const sanitizeClientPriceSnapshot = (
  value: ProductClientPriceSnapshot | undefined
): ProductClientPriceSnapshot | undefined => {
  if (!value) return undefined;
  const displayPrice = sanitizeOptionalMoney(value.displayPrice);
  if (displayPrice === undefined) return undefined;
  const basePrice = sanitizeOptionalMoney(value.basePrice) ?? displayPrice;
  return {
    displayPrice,
    basePrice,
    activeScheduleLabel: value.activeScheduleLabel?.trim() || undefined,
    nextPriceChangeAt: value.nextPriceChangeAt,
    hasTimedPricing: value.hasTimedPricing === true,
    isFrontendEstimate: value.isFrontendEstimate === true,
    pricingSource: value.pricingSource,
    capturedAt: value.capturedAt,
  };
};

const persistIntegrationQueue = () => {
  saveIntegrationQueueToStorage(integrationQueue);
};

export const applyIntegrationOrdersToTables = (
  tables: DiningTable[],
  integrationOrders: IntegrationOrder[]
): DiningTable[] => {
  if (integrationOrders.length === 0) return tables;

  const byTableId = new Map<string, IntegrationOrder[]>();
  const byTableNumber = new Map<number, IntegrationOrder[]>();
  integrationOrders.forEach((order) => {
    if (order.tableId) {
      const current = byTableId.get(order.tableId) ?? [];
      current.push(order);
      byTableId.set(order.tableId, current);
    } else if (order.tableNumber > 0) {
      const current = byTableNumber.get(order.tableNumber) ?? [];
      current.push(order);
      byTableNumber.set(order.tableNumber, current);
    }
  });

  const resolveCurrentTableSessionStartMs = (table: DiningTable) => {
    if (table.occupancyState !== "seated") return 0;
    const seatedAt = Number(table.seatedAt);
    return Number.isFinite(seatedAt) && seatedAt > 0 ? Math.trunc(seatedAt) : 0;
  };

  const belongsToCurrentTableSession = (createdAtMs: number, sessionStartMs: number) => {
    if (!sessionStartMs) return true;
    return createdAtMs >= sessionStartMs - TABLE_SESSION_HISTORY_GRACE_MS;
  };

  return tables.map((table) => {
    const currentSessionStartMs = resolveCurrentTableSessionStartMs(table);
    const relatedOrdersForTable = [
      ...(byTableId.get(table.id) ?? []),
      ...(byTableNumber.get(table.number) ?? []),
    ];
    const relatedOrdersRaw = relatedOrdersForTable.filter((order) =>
      currentSessionStartMs
        ? belongsToCurrentTableSession(order.createdAtMs, currentSessionStartMs)
        : true
    );
    if (relatedOrdersRaw.length === 0) {
      const completedIntegrationHistory =
        !currentSessionStartMs && table.orderHistory.length > 0
          ? relatedOrdersForTable
              .filter((order) => !isIntegrationOrderOpen(order))
              .map(toDiningOrderFromIntegration)
          : [];
      const closedLocalHistory =
        !currentSessionStartMs && completedIntegrationHistory.length > 0
          ? table.orderHistory.filter((order) => !isIntegrationOrderId(order.id))
          : [];
      const localHistory = currentSessionStartMs
        ? table.orderHistory
            .filter((order) => !isIntegrationOrderId(order.id))
            .filter((order) => belongsToCurrentTableSession(order.createdAt, currentSessionStartMs))
        : [...completedIntegrationHistory, ...closedLocalHistory]
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, 120);
      if (localHistory.length === table.orderHistory.length && relatedOrdersForTable.length === 0) {
        return table;
      }
      const localInProgress = localHistory.filter((order) => order.state === "in_progress").length;
      const localDue = asMoney(
        localHistory.reduce((sum, order) => {
          if (order.state !== "served") return sum;
          return sum + Math.max(order.total, 0);
        }, 0)
      );
      return {
        ...table,
        ordersTaken: localHistory.length,
        ordersInProgress: localInProgress,
        amountDue: localDue,
        orderHistory: localHistory,
      };
    }

    const relatedOrders = [...relatedOrdersRaw].sort((a, b) => b.createdAtMs - a.createdAtMs);
    const integrationHistory = relatedOrders.map(toDiningOrderFromIntegration);
    const localHistory = currentSessionStartMs
      ? table.orderHistory
          .filter((order) => !isIntegrationOrderId(order.id))
          .filter((order) => belongsToCurrentTableSession(order.createdAt, currentSessionStartMs))
      : [];
    const mergedHistory = [...integrationHistory, ...localHistory]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 120);

    const integrationInProgress = relatedOrders.filter(
      (order) => !isTerminalIntegrationWorkflowStatus(order.workflowStatus)
    ).length;
    const localInProgress = localHistory.filter((order) => order.state === "in_progress").length;
    const ordersInProgress = integrationInProgress + localInProgress;

    const integrationDue = asMoney(
      relatedOrders.reduce((sum, order) => {
        if (order.workflowStatus !== "delivered") return sum;
        if (order.paymentStatus === "paid") return sum;
        return sum + Math.max(order.dueAmount, 0);
      }, 0)
    );
    const localDue = asMoney(
      localHistory.reduce((sum, order) => {
        if (order.state !== "served") return sum;
        return sum + Math.max(order.total, 0);
      }, 0)
    );
    const amountDue = asMoney(integrationDue + localDue);

    const hasActiveIntegration = relatedOrders.some(isIntegrationOrderOpen);
    const nextOccupancy =
      hasActiveIntegration && table.occupancyState !== "seated" ? "seated" : table.occupancyState;
    const nextSeatedAt =
      nextOccupancy === "seated"
        ? (table.seatedAt ??
          relatedOrders.reduce((min, order) => Math.min(min, order.createdAtMs), Date.now()))
        : table.seatedAt;

    return {
      ...table,
      occupancyState: nextOccupancy,
      reservationAt: table.reservationAt,
      seatedAt: nextSeatedAt,
      ordersTaken: mergedHistory.length,
      ordersInProgress,
      amountDue,
      orderHistory: mergedHistory,
    };
  });
};

const toOperatorLabel = (params: Pick<TableSessionRequest, "userId" | "username" | "fullName">) => {
  const fullName = String(params.fullName ?? "").trim();
  if (fullName) return fullName;

  const username = String(params.username ?? "").trim();
  if (username) {
    return username
      .replace(/[^a-z0-9]+/gi, " ")
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  const normalized = String(params.userId ?? "")
    .trim()
    .replace(/^u_/, "");
  if (!normalized) return "Operatore";
  const words = normalized
    .replace(/[^a-z0-9]+/gi, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (words.length === 0) return "Operatore";
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
};

const findOrderRefInRoomState = (
  roomId: string,
  tableId: string,
  orderId: string
): DiningTableOrder | null => {
  const roomState = roomStates.get(roomId);
  if (!roomState) return null;
  const table = roomState.tables.find((entry) => entry.id === tableId);
  if (!table) return null;
  return table.orderHistory.find((entry) => entry.id === orderId) ?? null;
};

const replaceOrderIdInRoomState = (
  roomId: string,
  tableId: string,
  fromOrderId: string,
  toOrderId: string
): DiningTableOrder | null => {
  if (!fromOrderId || !toOrderId || fromOrderId === toOrderId) {
    return findOrderRefInRoomState(roomId, tableId, toOrderId || fromOrderId);
  }
  const roomState = roomStates.get(roomId);
  if (!roomState) return null;
  const tableIndex = roomState.tables.findIndex((entry) => entry.id === tableId);
  if (tableIndex < 0) return null;
  const currentTable = roomState.tables[tableIndex];
  const orderIndex = currentTable.orderHistory.findIndex((entry) => entry.id === fromOrderId);
  if (orderIndex < 0) return findOrderRefInRoomState(roomId, tableId, toOrderId);

  const nextOrder = {
    ...currentTable.orderHistory[orderIndex],
    id: toOrderId,
  };
  const nextHistory = [...currentTable.orderHistory];
  nextHistory[orderIndex] = nextOrder;
  roomState.tables[tableIndex] = {
    ...currentTable,
    orderHistory: nextHistory,
  };
  roomState.version += 1;
  persistOfflineTableState(roomState.tables[tableIndex]);
  return nextOrder;
};

const processQueuedIntegrationAction = async (
  action: PendingIntegrationAction
): Promise<boolean> => {
  const session = resolveIntegrationSessionFields();
  const currentOwner = resolveIntegrationQueueOwner(session);
  if (!session || !currentOwner || !isIntegrationQueueActionOwnedBy(action, currentOwner)) {
    return false;
  }

  if (action.kind === "order_create") {
    const result = await sendIntegrationOrderCreateRequest({
      ...action.payload,
      ...session,
    });
    if (!result.ok || !result.id) return false;

    let targetOrder = findOrderRefInRoomState(action.roomId, action.tableId, action.localOrderId);
    if (result.id !== action.localOrderId) {
      await replaceOfflineTableOrderId(
        { userId: action.owner.userId, activityId: action.owner.activityId },
        action.tableId,
        action.localOrderId,
        result.id
      );
      targetOrder =
        replaceOrderIdInRoomState(action.roomId, action.tableId, action.localOrderId, result.id) ??
        findOrderRefInRoomState(action.roomId, action.tableId, result.id);
    }
    roomIntegrationFingerprint.delete(action.roomId);
    if (targetOrder) {
      // La coda gira in background: un rifiuto definitivo non ha una UI a cui risalire.
      try {
        await syncIntegrationOrderFromLocal(targetOrder);
      } catch (error) {
        console.warn("[tables] sync stato ordine accodato non riuscita", error);
      }
    }
    return true;
  }

  if (action.kind === "order_sync") {
    const result = await sendIntegrationOrderSyncRequest({
      ...action.payload,
      ...session,
    });
    return result.ok;
  }

  const result = await sendIntegrationLayoutSyncRequest(
    { ...action.payload.basePayload, activityId: session.activityId },
    { ...action.payload.basePayload, ...session }
  );
  return result.ok;
};

const flushIntegrationQueue = async () => {
  if (integrationQueueFlushRunning) return;
  if (integrationQueue.length === 0) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  integrationQueueFlushRunning = true;
  try {
    const queueBatch = integrationQueue.splice(0, integrationQueue.length);
    const failed: PendingIntegrationAction[] = [];
    for (const action of queueBatch) {
      const ok = await processQueuedIntegrationAction(action);
      if (!ok) failed.push(action);
    }
    if (failed.length > 0) {
      integrationQueue.unshift(...failed);
    }
    persistIntegrationQueue();
  } finally {
    integrationQueueFlushRunning = false;
  }
};

const ensureIntegrationQueueRuntime = () => {
  if (integrationQueueInitialized) return;
  integrationQueueInitialized = true;
  integrationQueue.push(...loadIntegrationQueueFromStorage());
  persistIntegrationQueue();

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      void flushIntegrationQueue();
    });
    window.addEventListener(REALTIME_TRANSPORT_STATUS_EVENT, (event) => {
      const detail = (event as CustomEvent<{ connected?: boolean }>).detail;
      if (detail?.connected === true && navigator.onLine !== false) {
        void flushIntegrationQueue();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && navigator.onLine !== false) {
        void flushIntegrationQueue();
      }
    });
    window.setInterval(() => {
      if (navigator.onLine === false) return;
      void flushIntegrationQueue();
    }, INTEGRATION_QUEUE_FALLBACK_FLUSH_MS);
  }

  void flushIntegrationQueue();
};

const enqueueIntegrationAction = (action: PendingIntegrationAction) => {
  ensureIntegrationQueueRuntime();

  if (action.kind === "order_create") {
    const exists = integrationQueue.some(
      (entry) =>
        entry.kind === "order_create" &&
        integrationQueueOwnersEqual(entry.owner, action.owner) &&
        entry.roomId === action.roomId &&
        entry.tableId === action.tableId &&
        entry.localOrderId === action.localOrderId
    );
    if (!exists) {
      integrationQueue.push(action);
    }
  } else if (action.kind === "order_sync") {
    const filtered = integrationQueue.filter(
      (entry) =>
        !(
          entry.kind === "order_sync" &&
          integrationQueueOwnersEqual(entry.owner, action.owner) &&
          entry.orderId === action.orderId
        )
    );
    integrationQueue.splice(0, integrationQueue.length, ...filtered, action);
  } else {
    const filtered = integrationQueue.filter(
      (entry) =>
        !(
          entry.kind === "layout_sync" &&
          integrationQueueOwnersEqual(entry.owner, action.owner) &&
          entry.tableId === action.tableId
        )
    );
    integrationQueue.splice(0, integrationQueue.length, ...filtered, action);
  }

  persistIntegrationQueue();
  if (navigator.onLine !== false) {
    void flushIntegrationQueue();
  }
};

const syncOrderToIntegration = async (
  params: TableSessionRequest,
  table: DiningTable,
  order: DiningTableOrder
): Promise<IntegrationOrderCreateResult | null> => {
  ensureIntegrationQueueRuntime();
  const activityId = String(params.activityId ?? "").trim();
  if (!activityId) {
    throw new Error(
      "Attivita operativa mancante: impossibile inviare comande senza configurazione backend reale."
    );
  }
  const logicalTableId = String(params.logicalTableId ?? table.logicalTableId ?? "").trim();
  const logicalTableLabel = String(
    params.logicalTableLabel ??
      params.tableLabel ??
      table.logicalTableLabel ??
      table.tableLabel ??
      ""
  ).trim();
  const payload = {
    source: "mobile-frontend",
    operationalSchemaVersion: 2,
    activityId,
    roomId: params.roomId,
    tableId: table.id,
    logicalTableId: logicalTableId || undefined,
    tableLabel: logicalTableLabel || undefined,
    logicalTableLabel: logicalTableLabel || undefined,
    tableNumber: table.number,
    covers: table.covers,
    waiter: toOperatorLabel(params),
    clientOrderId: order.id,
    localOrderId: order.id,
    idempotencyKey: order.id,
    title: order.title,
    total: order.total,
    orderNote: order.orderNote ?? "",
    orderComment: order.orderComment ?? "",
    createdByUserId: params.userId,
    createdByUsername: toOperatorLabel(params),
    token: params.token,
    userId: params.userId,
    deviceUuid: params.deviceUuid,
    broadcastToAllStations: true,
    // Display-only snapshot: the backend remains responsible for validating/repricing the order.
    lines: order.lines.map((line) => ({
      productId: line.productId ?? "",
      name: line.name,
      qty: line.qty,
      note: line.note ?? "",
      variantName: line.variantName ?? "",
      unitBasePrice: line.unitBasePrice,
      unitFinalPrice: line.unitFinalPrice,
      priceDelta: line.priceDelta,
      priceChanged: line.priceChanged,
      priceChangeReason: line.priceChangeReason,
      vatRate: line.vatRate,
      vatCode: line.vatCode,
      clientPriceSnapshot: line.clientPriceSnapshot,
    })),
  };

  const result = await sendIntegrationOrderCreateRequest(payload);
  if (result.ok && result.id) {
    return {
      id: result.id,
      ...(result.order ? { order: result.order } : {}),
      warningCode: result.warningCode,
      warningMessage: result.warningMessage,
    };
  }

  if (shouldQueueForRetry(result.status, result.networkError)) {
    const owner = resolveIntegrationQueueOwner(
      resolveIntegrationSessionFields({
        token: params.token,
        userId: params.userId,
        deviceUuid: params.deviceUuid,
        activityId,
      })
    );
    if (!owner) {
      throw new Error("Sessione operativa incompleta: impossibile accodare la comanda offline.");
    }
    enqueueIntegrationAction({
      kind: "order_create",
      owner,
      roomId: params.roomId,
      tableId: table.id,
      localOrderId: order.id,
      payload,
      queuedAtMs: Date.now(),
    });
    return {
      id: order.id,
      queued: true,
      warningMessage:
        "Backend offline: comanda in coda. Verra inviata automaticamente appena il server torna disponibile.",
    };
  }

  if (result.status > 0) {
    console.warn(`[tables] creazione comanda integrazione fallita (${result.status})`);
  } else {
    console.warn("[tables] sync ordine backend non riuscita");
  }
  return null;
};

const syncTableLayoutToIntegration = async (
  params: TableSessionRequest,
  table: DiningTable,
  status?: PosTableStatus
): Promise<void> => {
  ensureIntegrationQueueRuntime();
  const tableId = String(table.id ?? "").trim();
  if (!tableId) return;
  const safeStatus = status ?? derivePosStatusFromDiningTable(table);
  const logicalTableId = String(params.logicalTableId ?? table.logicalTableId ?? "").trim();
  const logicalTableLabel = String(
    params.logicalTableLabel ??
      params.tableLabel ??
      table.logicalTableLabel ??
      table.tableLabel ??
      ""
  ).trim();
  const basePayload: Record<string, unknown> = {
    activityId: String(params.activityId ?? "").trim() || undefined,
    roomId: params.roomId,
    tableId,
    tableNumber: table.number,
    logicalTableId: logicalTableId || undefined,
    tableLabel: logicalTableLabel || undefined,
    logicalTableLabel: logicalTableLabel || undefined,
    status: safeStatus,
    occupancyState: table.occupancyState,
    tableName: table.tableName,
    customerPhone: table.customerPhone,
    covers: table.covers,
    reservationAt: table.reservationAt,
    seatedAt: table.seatedAt,
    note: table.note,
    allergens: table.allergens,
    manualIntolerance: table.manualIntolerance,
  };
  const canUseSession =
    params.token.trim().length > 0 &&
    params.userId.trim().length > 0 &&
    params.deviceUuid.trim().length > 0;
  const payloadWithSession: Record<string, unknown> | null = canUseSession
    ? {
        ...basePayload,
        token: params.token,
        userId: params.userId,
        deviceUuid: params.deviceUuid,
        activityId: String(params.activityId ?? "").trim() || undefined,
      }
    : null;

  const result = await sendIntegrationLayoutSyncRequest(basePayload, payloadWithSession);
  if (result.ok) return;

  if (shouldQueueForRetry(result.status, result.networkError)) {
    const owner = resolveIntegrationQueueOwner(resolveIntegrationSessionFields(params));
    if (!owner) {
      console.warn("[tables] sessione operativa incompleta: sync layout offline non accodato");
      return;
    }
    enqueueIntegrationAction({
      kind: "layout_sync",
      owner,
      tableId,
      payload: {
        basePayload,
        payloadWithSession,
      },
      queuedAtMs: Date.now(),
    });
    return;
  }

  if (result.status > 0) {
    console.warn(`[tables] sync layout tavolo backend non riuscita (${result.status})`);
    return;
  }
  console.warn("[tables] sync layout tavolo backend non riuscita");
};

const computeOrderPaymentTotals = (order: DiningTableOrder) => {
  const units = expandOrderUnitPayments(order);
  if (units.length === 0) {
    const dueAmount = order.state === "paid" ? 0 : Math.max(order.total, 0);
    return {
      paidAmount: asMoney(Math.max(order.total - dueAmount, 0)),
      dueAmount: asMoney(dueAmount),
    };
  }
  const paidUnitSet = new Set(normalizePaidArticleUnits(order));
  const paidAmount = asMoney(
    units.reduce((sum, unit) => sum + (paidUnitSet.has(unit.id) ? unit.amount : 0), 0)
  );
  const dueAmount = asMoney(Math.max(order.total - paidAmount, 0));
  return {
    paidAmount,
    dueAmount,
  };
};

type IntegrationSessionFields = {
  token: string;
  userId: string;
  deviceUuid: string;
  activityId: string;
};

/**
 * `/api/integration/orders/sync` e nell'elenco `shouldForceBodyAuth` del backend: le
 * credenziali devono viaggiare nel body, perche `apiFetch` non allega header di auth ne
 * cookie. Senza queste tre chiavi la richiesta viene respinta con 401.
 */
const resolveIntegrationSessionFields = (
  params?: Partial<
    Pick<TableSessionRequest, "token" | "userId" | "deviceUuid" | "activityId">
  > | null
): IntegrationSessionFields | null => {
  const pick = (
    value: unknown,
    storageKey: (typeof AUTH_STORAGE_KEYS)[keyof typeof AUTH_STORAGE_KEYS]
  ) => String(value ?? "").trim() || String(readAuthStorage(storageKey) ?? "").trim();
  const token = pick(params?.token, AUTH_STORAGE_KEYS.token);
  const userId = pick(params?.userId, AUTH_STORAGE_KEYS.userId);
  const deviceUuid = pick(params?.deviceUuid, AUTH_STORAGE_KEYS.deviceUuid);
  const activityId = pick(params?.activityId, AUTH_STORAGE_KEYS.activityId);
  if (!token || !userId || !deviceUuid) return null;
  return { token, userId, deviceUuid, activityId };
};

const resolveIntegrationQueueOwner = (
  session: IntegrationSessionFields | null
): IntegrationQueueOwner | null => {
  if (!session?.userId || !session.activityId || !session.deviceUuid) return null;
  return {
    userId: session.userId,
    activityId: session.activityId,
    deviceUuid: session.deviceUuid,
  };
};

export class IntegrationOrderSyncError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "IntegrationOrderSyncError";
    this.status = status;
    this.code = code;
  }
}

const describeOrderSyncFailure = (
  status: number,
  code: string,
  body: Record<string, unknown> | null
): string => {
  if (status === 401 || status === 403) return "Sessione scaduta: rifai il login.";
  if (code === "ORDER_NOT_READY_FOR_DELIVERY")
    return "Comanda non pronta: attendi il Pronta della postazione.";
  if (code === "ORDER_CANCELLED") return "Comanda annullata: operazione non consentita.";
  const backendMessage = String(body?.error ?? "").trim();
  if (backendMessage) return backendMessage;
  return status > 0
    ? `Aggiornamento comanda non riuscito (${status}).`
    : "Aggiornamento comanda non riuscito.";
};

const syncIntegrationOrderFromLocal = async (
  order: DiningTableOrder,
  params?: Partial<
    Pick<TableSessionRequest, "token" | "userId" | "deviceUuid" | "activityId">
  > | null
): Promise<void> => {
  ensureIntegrationQueueRuntime();
  if (!isIntegrationOrderId(order.id)) return;
  const { paidAmount, dueAmount } = computeOrderPaymentTotals(order);
  const inProgressWorkflow = parseIntegrationWorkflowStatus(order.workflowStatus ?? "prep");
  const workflowStatus =
    order.state === "in_progress"
      ? inProgressWorkflow === "delivered"
        ? "prep"
        : inProgressWorkflow
      : "delivered";
  const paymentStatus =
    order.state === "paid" ? "paid" : dueAmount < order.total ? "partial" : "unpaid";
  const session = resolveIntegrationSessionFields(params);
  const payload: Record<string, unknown> = {
    id: order.id,
    ...(session ?? {}),
    order: {
      workflowStatus,
      paymentStatus,
      dueAmount,
      paidAmount,
      completedAtMs: order.state === "in_progress" ? null : Date.now(),
    },
  };
  const result = await sendIntegrationOrderSyncRequest(payload);
  if (result.ok) return;

  if (shouldQueueForRetry(result.status, result.networkError)) {
    const owner = resolveIntegrationQueueOwner(session);
    if (!owner) {
      throw new IntegrationOrderSyncError(
        "Sessione operativa incompleta: aggiornamento offline non accodato.",
        result.status
      );
    }
    enqueueIntegrationAction({
      kind: "order_sync",
      owner,
      orderId: order.id,
      payload,
      queuedAtMs: Date.now(),
    });
    return;
  }

  const code = String(result.body?.code ?? "").trim();
  throw new IntegrationOrderSyncError(
    describeOrderSyncFailure(result.status, code, result.body),
    result.status,
    code
  );
};

const cloneOrder = (order: DiningTableOrder): DiningTableOrder => ({
  ...order,
  paidArticleUnits: [...(order.paidArticleUnits ?? [])],
  lines: order.lines.map((line) => ({ ...line })),
});

const cloneTable = (table: DiningTable): DiningTable => ({
  ...table,
  allergens: [...table.allergens],
  orderHistory: table.orderHistory.map(cloneOrder),
});

const cloneTables = (tables: DiningTable[]) => tables.map(cloneTable);

const emptyFreeTableFields = (table: DiningTable): DiningTable => ({
  ...table,
  tableName: "",
  customerPhone: "",
  covers: 0,
  note: "",
  allergens: [],
  manualIntolerance: "",
  reservationAt: null,
  seatedAt: null,
  ordersTaken: 0,
  ordersInProgress: 0,
  amountDue: 0,
  orderHistory: [],
  reservationPreview: null,
});

const toOrderId = (tableId: string, now: number) =>
  `ord_${tableId}_${now}_${Math.random().toString(36).slice(2, 7)}`;

const buildOrderUnitIds = (order: DiningTableOrder) => {
  const ids: string[] = [];
  order.lines.forEach((line, rowIndex) => {
    const qty = Math.max(1, Math.round(line.qty) || 1);
    for (let unitIndex = 0; unitIndex < qty; unitIndex += 1) {
      ids.push(`${order.id}_${rowIndex}_${unitIndex}`);
    }
  });
  return ids;
};

const expandOrderUnitPayments = (order: DiningTableOrder) => {
  return expandOrderEmissionUnitAmounts({
    orderId: order.id,
    total: order.total,
    lines: order.lines.map((line) => ({
      qty: line.qty,
      unitBasePrice: line.unitBasePrice,
      unitFinalPrice: line.unitFinalPrice,
    })),
  });
};

const normalizePaidArticleUnits = (order: DiningTableOrder) => [
  ...new Set((order.paidArticleUnits ?? []).filter((value) => value.trim().length > 0)),
];

const toAnalyticsCustomerName = (tableName: string | undefined) => {
  const normalized = (tableName ?? "").trim();
  return normalized || undefined;
};

const toAnalyticsOperatorName = (
  params: Pick<TableSessionRequest, "userId" | "username" | "fullName">
) => {
  const normalized = toOperatorLabel(params).trim();
  return normalized || "Operatore";
};

const toAnalyticsActorContext = (
  params: Pick<TableSessionRequest, "token" | "userId" | "username" | "fullName">
) => ({
  operatorName: toAnalyticsOperatorName(params),
  operatorId: params.userId,
  shiftToken: params.token,
});

const sanitizeAnalyticsPaymentMethod = (
  value: TablePaymentMethod | undefined
): AnalyticsPaymentMethod | undefined => {
  if (!value) return undefined;
  if (value === "cash") return "cash";
  if (value === "card") return "card";
  if (value === "voucher") return "voucher";
  if (value === "satispay") return "satispay";
  if (value === "suspended") return "suspended";
  if (value === "check") return "check";
  if (value === "wire") return "wire";
  return "unknown";
};

const PAYMENT_METHOD_BACKEND_META: Record<
  TablePaymentMethod,
  { transactionMethod: "CASH" | "POS" | "OTHER"; methodId: string; methodLabel: string }
> = {
  cash: { transactionMethod: "CASH", methodId: "pay_cash", methodLabel: "Contanti" },
  card: { transactionMethod: "POS", methodId: "pay_card", methodLabel: "Carta" },
  voucher: { transactionMethod: "OTHER", methodId: "pay_smart", methodLabel: "Buono pasto" },
  satispay: { transactionMethod: "OTHER", methodId: "pay_smart", methodLabel: "Satispay Business" },
  suspended: { transactionMethod: "OTHER", methodId: "pay_smart", methodLabel: "Conto sospeso" },
  check: { transactionMethod: "OTHER", methodId: "pay_smart", methodLabel: "Assegno" },
  wire: { transactionMethod: "OTHER", methodId: "pay_smart", methodLabel: "Bonifico" },
};

const normalizePaymentSplitModeForBackend = (
  mode: TablePaymentSplitMode | undefined,
  articleUnitIds: string[]
): TablePaymentSplitMode => {
  if (articleUnitIds.length > 0) return "article";
  if (mode === "roman" || mode === "amount" || mode === "article" || mode === "single") {
    return mode;
  }
  return "amount";
};

const buildPaymentIdempotencyKey = (params: {
  clientPaymentId?: string;
  tableId: string;
  orderId?: string;
}) => {
  const explicit = params.clientPaymentId?.trim();
  if (explicit) return explicit;
  const orderPart = params.orderId?.trim() || "table";
  return `mobile_${params.tableId}_${orderPart}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

const buildPaymentSessionPayload = (params: TableSessionRequest) => ({
  token: params.token,
  userId: params.userId,
  username: params.username,
  fullName: params.fullName,
  deviceUuid: params.deviceUuid,
  activityId: params.activityId,
  roomId: params.roomId,
  clientApp: "mobile-frontend",
});

const paymentRequestHeaders = (params: TableSessionRequest): HeadersInit => {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-User-Id": params.userId,
    "X-Device-Uuid": params.deviceUuid,
    "X-Client-App": "mobile-frontend",
  };
  if (params.token) {
    headers.Authorization = `Bearer ${params.token}`;
  }
  return headers;
};

export function buildBackendFreeSplitPaymentPayload(
  params: TableSessionRequest & {
    tableId: string;
    amount: number;
    paymentMethod?: TablePaymentMethod;
    orderId?: string;
    articleUnitIds?: string[];
    splitMode?: TablePaymentSplitMode;
    cashReceived?: number;
    cashSource?: "wallet" | "automatic";
    automaticCashPaymentOperationId?: string;
    note?: string;
    receiptType?: TablePaymentReceiptType;
    invoiceRecipient?: TablePaymentInvoiceRecipient | null;
    adminAdjustment?: TablePaymentAdminAdjustment;
    commercialBenefitApplications?: TableCommercialBenefitApplication[];
    clientPaymentId?: string;
    romanSharesPaid?: number;
    romanSharesTotal?: number;
  }
) {
  const amount = asMoney(Math.max(Number(params.amount) || 0, 0));
  const paymentMethod = params.paymentMethod ?? "cash";
  const methodMeta = PAYMENT_METHOD_BACKEND_META[paymentMethod];
  const articleUnitIds = [
    ...new Set((params.articleUnitIds ?? []).map((unitId) => unitId.trim()).filter(Boolean)),
  ];
  const splitMode = normalizePaymentSplitModeForBackend(params.splitMode, articleUnitIds);
  const receiptType = params.receiptType ?? "scontrino";
  const idempotencyKey = buildPaymentIdempotencyKey(params);
  const commercialBenefitApplications = (params.commercialBenefitApplications ?? [])
    .map((entry) => ({
      applicationId: entry.applicationId?.trim(),
      benefitAmountCents: entry.benefitAmountCents,
      benefitKind: entry.benefitKind,
      residualPolicy: entry.residualPolicy ?? undefined,
    }))
    .filter((entry) => entry.applicationId);
  const benefitOnly = amount <= 0 && commercialBenefitApplications.length > 0;
  const cashGiven =
    !benefitOnly && methodMeta.transactionMethod === "CASH"
      ? asMoney(Math.max(Number(params.cashReceived) || amount, amount))
      : undefined;
  const automaticCashPaymentOperationId =
    typeof params.automaticCashPaymentOperationId === "string"
      ? params.automaticCashPaymentOperationId.trim()
      : "";
  const isAutomaticCashPayment =
    !benefitOnly &&
    methodMeta.transactionMethod === "CASH" &&
    (params.cashSource === "automatic" || automaticCashPaymentOperationId.length > 0);
  const shouldIssueFiscal =
    !benefitOnly && (receiptType === "scontrino" || receiptType === "fattura");
  const transaction: Record<string, unknown> = {
    method: methodMeta.transactionMethod,
    methodId: methodMeta.methodId,
    methodLabel: methodMeta.methodLabel,
    amountPaid: amount,
    note: params.note?.trim() || undefined,
  };
  if (cashGiven !== undefined) {
    transaction.cashGiven = cashGiven;
  }
  if (isAutomaticCashPayment) {
    transaction.paymentSource = "automatic_cash";
    transaction.cashSource = "automatic";
    transaction.automaticCashPaymentOperationId = automaticCashPaymentOperationId || undefined;
  }
  if (methodMeta.transactionMethod === "POS") {
    transaction.posProvider = "mobile-pos";
  }

  return {
    ...buildPaymentSessionPayload(params),
    tableId: params.tableId,
    roomId: params.roomId,
    orderId: params.orderId?.trim() || undefined,
    splitType: "FREE_SPLIT",
    splitMode,
    articleUnitIds,
    amount,
    idempotencyKey,
    clientPaymentId: idempotencyKey,
    releaseTable: true,
    note: params.note?.trim() || undefined,
    paymentSource: isAutomaticCashPayment ? "automatic_cash" : undefined,
    cashSource: isAutomaticCashPayment ? "automatic" : undefined,
    automaticCashPaymentOperationId:
      isAutomaticCashPayment && automaticCashPaymentOperationId
        ? automaticCashPaymentOperationId
        : undefined,
    paymentMethod: paymentMethod,
    romanSharesPaid:
      params.splitMode === "roman"
        ? Math.max(1, Math.trunc(Number(params.romanSharesPaid) || 1))
        : undefined,
    romanSharesTotal:
      params.splitMode === "roman"
        ? Math.max(1, Math.trunc(Number(params.romanSharesTotal) || 1))
        : undefined,
    receiptType,
    issueFiscal: shouldIssueFiscal,
    fiscalDocType: receiptType === "fattura" ? "INVOICE" : "RECEIPT",
    invoiceRecipient: params.invoiceRecipient ?? undefined,
    adminAdjustment: params.adminAdjustment ?? undefined,
    commercialBenefitApplications:
      commercialBenefitApplications.length > 0 ? commercialBenefitApplications : undefined,
    parts: [
      {
        amountDue: benefitOnly ? 0 : amount,
        transactions: benefitOnly ? [] : [transaction],
      },
    ],
  };
}

const readBackendPaymentError = (status: number, body: Record<string, unknown> | null) => {
  const direct = String(body?.error ?? body?.message ?? "").trim();
  if (direct) return direct;
  if (status === 403) return "Permesso insufficiente per incassare il pagamento.";
  if (status === 409) return "Pagamento non applicabile allo stato corrente del tavolo.";
  if (status > 0) return `Pagamento non riuscito (${status}).`;
  return "Backend pagamenti non raggiungibile.";
};

const sendBackendFreeSplitPaymentRequest = async (
  session: TableSessionRequest,
  payload: ReturnType<typeof buildBackendFreeSplitPaymentPayload>
) => {
  let response: Response;
  try {
    response = await apiFetch("/api/payments/free-split", {
      method: "POST",
      headers: paymentRequestHeaders(session),
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Backend pagamenti non raggiungibile.");
  }

  const bodyRaw = (await response.json().catch(() => null)) as unknown;
  const body = bodyRaw && typeof bodyRaw === "object" ? (bodyRaw as Record<string, unknown>) : null;
  if (!response.ok || body?.ok === false) {
    throw new Error(readBackendPaymentError(response.status, body));
  }
  return body;
};

const positiveTimestampOr = (value: unknown, fallback: number | null): number | null => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  return fallback;
};

const positiveIntOr = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  return fallback;
};

const mergeBackendPaymentTableSnapshot = (
  current: DiningTable,
  raw: unknown
): DiningTable | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  if (!id || id !== current.id) return null;
  const amountDueRaw = Number(source.amountDue ?? source.totalDue ?? source.dueAmount);
  const amountDue = asMoney(
    Math.max(Number.isFinite(amountDueRaw) ? amountDueRaw : current.amountDue, 0)
  );
  const status = String(source.status ?? source.occupancyState ?? "")
    .trim()
    .toLowerCase();
  const occupancyState =
    status === "reserved"
      ? "reserved"
      : status === "free" || status === "no_orders"
        ? amountDue > 0
          ? "seated"
          : "free"
        : status === "seated"
          ? "seated"
          : current.occupancyState;
  const reservation =
    source.reservation && typeof source.reservation === "object"
      ? (source.reservation as Record<string, unknown>)
      : null;

  return {
    ...current,
    tableName: String(
      source.tableName ?? source.guestName ?? reservation?.customerName ?? current.tableName
    ).trim(),
    customerPhone: String(
      source.customerPhone ?? reservation?.customerPhone ?? current.customerPhone
    ).trim(),
    covers: normalizeTableCovers(source.covers ?? reservation?.covers, {
      minimum: 0,
      fallback: current.covers,
    }),
    occupancyState,
    reservationAt: positiveTimestampOr(
      source.reservationAt ?? reservation?.reservationAt,
      current.reservationAt
    ),
    seatedAt:
      occupancyState === "free" ? null : positiveTimestampOr(source.seatedAt, current.seatedAt),
    ordersTaken: positiveIntOr(source.ordersTaken, current.ordersTaken),
    ordersInProgress: positiveIntOr(source.ordersInProgress, current.ordersInProgress),
    amountDue,
    note: String(source.note ?? reservation?.note ?? current.note).trim(),
    allergens: Array.isArray(source.allergens)
      ? normalizeAllergenList(source.allergens)
      : normalizeAllergenList(current.allergens),
    manualIntolerance: String(
      source.manualIntolerance ?? reservation?.intolerances ?? current.manualIntolerance
    ).trim(),
    paymentArticleSplitLocked:
      source.paymentArticleSplitLocked === true
        ? true
        : source.paymentArticleSplitLocked === false
          ? false
          : current.paymentArticleSplitLocked,
    logicalTableId:
      String(source.logicalTableId ?? current.logicalTableId ?? "").trim() || undefined,
    logicalTableLabel:
      String(
        source.logicalTableLabel ?? source.tableLabel ?? current.logicalTableLabel ?? ""
      ).trim() || undefined,
    tableLabel: String(source.tableLabel ?? current.tableLabel ?? "").trim() || undefined,
  };
};

const buildRoomTables = (roomId: string): DiningTable[] => {
  if (!import.meta.env.DEV) return [];
  const tableCount = DEV_ONLY_TABLE_COUNT;
  return Array.from({ length: tableCount }, (_, index) => {
    const number = index + 1;
    const id = `${roomId}_t${number.toString().padStart(2, "0")}`;
    return {
      id,
      number,
      tableName: "",
      customerPhone: "",
      covers: 0,
      occupancyState: "free",
      reservationAt: null,
      seatedAt: null,
      ordersTaken: 0,
      ordersInProgress: 0,
      amountDue: 0,
      note: "",
      allergens: [],
      manualIntolerance: "",
      orderHistory: [],
    };
  });
};

const assertValidSession = (params: TableSessionRequest) => {
  if (!params.token || !params.userId || !params.deviceUuid || !params.roomId) {
    throw new Error("Sessione tavoli non valida.");
  }
};

const persistOfflineTableState = (table: DiningTable) => {
  const userId = String(readAuthStorage(AUTH_STORAGE_KEYS.userId) ?? "").trim();
  const activityId = String(readAuthStorage(AUTH_STORAGE_KEYS.activityId) ?? "").trim();
  const scope = resolveOfflineConfigurationScope({ userId, activityId });
  if (!scope) return;
  void recordOfflineTableState(scope, table).catch(() => undefined);
};

const getRoomState = (roomId: string): RoomTablesState => {
  const current = roomStates.get(roomId);
  if (current) {
    current.tables = current.tables.map((table) => {
      if (table.occupancyState === "free" && Number(table.reservationAt) <= 0) {
        return emptyFreeTableFields(table);
      }
      const normalizedName = `Tavolo ${table.number}`;
      if (!table.tableName.trim() || /^prenotazione\s+\d+$/i.test(table.tableName.trim())) {
        return { ...table, tableName: normalizedName };
      }
      return table;
    });
    return current;
  }
  const created: RoomTablesState = {
    version: 1,
    tables: buildRoomTables(roomId),
  };
  roomStates.set(roomId, created);
  return created;
};

const updateRoomTable = (
  roomId: string,
  tableId: string,
  update: (current: DiningTable) => DiningTable
) => {
  const roomState = getRoomState(roomId);
  const index = roomState.tables.findIndex((table) => table.id === tableId);
  if (index < 0) {
    throw new Error("Tavolo non trovato.");
  }

  const updated = update(cloneTable(roomState.tables[index]));
  roomState.tables[index] = updated;
  roomState.version += 1;
  persistOfflineTableState(updated);
  return cloneTable(updated);
};

const findCachedRoomTable = (roomId: string, tableId: string): DiningTable | null => {
  const roomState = roomStates.get(roomId);
  if (!roomState) return null;
  const table = roomState.tables.find((entry) => entry.id === tableId);
  return table ? cloneTable(table) : null;
};

const upsertRoomTable = (roomId: string, table: DiningTable) => {
  const roomState = getRoomState(roomId);
  const nextTable = cloneTable(table);
  const index = roomState.tables.findIndex((entry) => entry.id === nextTable.id);
  if (index >= 0) {
    roomState.tables[index] = nextTable;
  } else {
    roomState.tables.push(nextTable);
    roomState.tables.sort((left, right) => {
      if (left.number !== right.number) return left.number - right.number;
      return left.id.localeCompare(right.id, "it");
    });
  }
  roomState.version += 1;
  return cloneTable(nextTable);
};

const enrichMovedTargetFromLocalSource = (
  backendTarget: DiningTable,
  sourceBeforeMove: DiningTable | null
): DiningTable => {
  if (!sourceBeforeMove) return cloneTable(backendTarget);
  const sourceHistory = sourceBeforeMove.orderHistory.map(cloneOrder);
  if (sourceHistory.length === 0) return cloneTable(backendTarget);
  const targetHistory =
    backendTarget.orderHistory.length > 0
      ? backendTarget.orderHistory.map(cloneOrder)
      : sourceHistory;
  return {
    ...backendTarget,
    tableName: backendTarget.tableName || sourceBeforeMove.tableName,
    customerPhone: backendTarget.customerPhone || sourceBeforeMove.customerPhone,
    covers: backendTarget.covers || sourceBeforeMove.covers,
    occupancyState:
      backendTarget.occupancyState === "free"
        ? sourceBeforeMove.occupancyState
        : backendTarget.occupancyState,
    seatedAt: backendTarget.seatedAt ?? sourceBeforeMove.seatedAt,
    ordersTaken: Math.max(
      backendTarget.ordersTaken,
      sourceBeforeMove.ordersTaken,
      targetHistory.length
    ),
    ordersInProgress: Math.max(backendTarget.ordersInProgress, sourceBeforeMove.ordersInProgress),
    amountDue: Math.max(backendTarget.amountDue, sourceBeforeMove.amountDue),
    note: backendTarget.note || sourceBeforeMove.note,
    allergens:
      backendTarget.allergens.length > 0
        ? [...backendTarget.allergens]
        : [...sourceBeforeMove.allergens],
    manualIntolerance: backendTarget.manualIntolerance || sourceBeforeMove.manualIntolerance,
    orderHistory: targetHistory,
  };
};

export async function fetchTablesForSession(params: TableSessionRequest): Promise<TablesSnapshot> {
  assertValidSession(params);
  const integrationOrdersPromise = fetchIntegrationOrders(params);
  const tableGroupsPromise = fetchTableGroups(params).catch(() => []);
  const remoteLayout = await fetchIntegrationLayout();
  const offlineScope = resolveOfflineConfigurationScope(params);
  let backendLayout = remoteLayout;
  if (remoteLayout && offlineScope) {
    const recorded = await recordOfflineLayout(offlineScope, remoteLayout);
    backendLayout = recorded?.layout?.value ?? remoteLayout;
  } else if (!remoteLayout && offlineScope) {
    backendLayout = await readOfflineLayout(offlineScope);
  }
  if (backendLayout) {
    const requestedRoomId = params.roomId;
    const roomExists = backendLayout.rooms.some((room) => room.id === requestedRoomId);
    const layoutTables = roomExists
      ? backendLayout.tables
          .filter((table) => table.roomId === requestedRoomId)
          .map(toDiningTableFromLayout)
      : [];

    const layoutFingerprint = JSON.stringify(
      layoutTables.map((table) => ({
        id: table.id,
        number: table.number,
        occupancyState: table.occupancyState,
        reservationAt: table.reservationAt,
        seatedAt: table.seatedAt,
        covers: table.covers,
        ordersTaken: table.ordersTaken,
        ordersInProgress: table.ordersInProgress,
        amountDue: table.amountDue,
        tableName: table.tableName,
        paymentArticleSplitLocked: table.paymentArticleSplitLocked === true,
        offlineLifecycle: table.offlineLifecycle
          ? {
              state: table.offlineLifecycle.state,
              removedAt: table.offlineLifecycle.removedAt,
              removedFromLayoutVersion: table.offlineLifecycle.removedFromLayoutVersion,
              requiresDecision: table.offlineLifecycle.requiresDecision,
              decision: table.offlineLifecycle.decision,
            }
          : null,
      }))
    );

    const targetRoomState = getRoomState(requestedRoomId);
    if (roomLayoutFingerprint.get(requestedRoomId) !== layoutFingerprint) {
      const existingById = new Map(targetRoomState.tables.map((table) => [table.id, table]));
      targetRoomState.tables = layoutTables.map((table) => {
        const existing = existingById.get(table.id);
        if (!existing) return table;
        const localHistory = existing.orderHistory.filter(
          (order) => !isIntegrationOrderId(order.id)
        );
        if (localHistory.length === 0) return table;
        const localInProgress = localHistory.filter(
          (order) => order.state === "in_progress"
        ).length;
        const localDue = asMoney(
          localHistory.reduce((sum, order) => {
            if (order.state !== "served") return sum;
            return sum + Math.max(order.total, 0);
          }, 0)
        );
        return {
          ...table,
          ordersTaken: Math.max(table.ordersTaken, localHistory.length),
          ordersInProgress: table.ordersInProgress + localInProgress,
          amountDue: asMoney(table.amountDue + localDue),
          orderHistory: localHistory,
        };
      });
      targetRoomState.version += 1;
      roomLayoutFingerprint.set(requestedRoomId, layoutFingerprint);
      roomIntegrationFingerprint.delete(requestedRoomId);
    }
  }

  const roomState = getRoomState(params.roomId);
  if (!backendLayout && roomState.tables.length === 0) {
    throw new Error(
      "Backend tavoli non disponibile: modalita offline in sola lettura, nessun tavolo mock generato."
    );
  }
  const integrationOrders = await integrationOrdersPromise;
  if (integrationOrders) {
    const fingerprint = JSON.stringify(integrationOrders.map(buildIntegrationOrderFingerprint));
    if (roomIntegrationFingerprint.get(params.roomId) !== fingerprint) {
      roomState.tables = applyIntegrationOrdersToTables(
        cloneTables(roomState.tables),
        integrationOrders
      );
      roomState.version += 1;
      roomIntegrationFingerprint.set(params.roomId, fingerprint);
    }
  }
  const [sessionTables, tableGroups] = await Promise.all([
    applyReservationWindowToSessionTables(cloneTables(roomState.tables), params),
    tableGroupsPromise,
  ]);
  if (offlineScope) {
    await Promise.allSettled(
      sessionTables.map((table) => recordOfflineTableState(offlineScope, table))
    );
  }
  const rawTables = sessionTables;
  const visibleTables = applyTableGroupsToTables(rawTables, tableGroups);

  return {
    version: roomState.version,
    tables: visibleTables,
    rawTables,
    tableGroups,
  };
}

export async function keepDiningTableAfterConfigurationRemoval(
  params: TableSessionRequest & { tableId: string }
) {
  assertValidSession(params);
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    if (!table.offlineLifecycle) return table;
    return {
      ...table,
      offlineLifecycle: {
        ...table.offlineLifecycle,
        requiresDecision: false,
        decision: "keep",
      },
    };
  });
  const offlineScope = resolveOfflineConfigurationScope(params);
  if (offlineScope) await keepOfflineRemovedTable(offlineScope, params.tableId);
  roomLayoutFingerprint.delete(params.roomId);
  return updatedTable;
}

export async function updateDiningTableMeta(
  params: TableSessionRequest & {
    tableId: string;
    tableName?: string;
    customerPhone?: string;
    covers: number;
    note: string;
    allergens?: string[];
    manualIntolerance?: string;
  }
) {
  assertValidSession(params);
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    if (table.occupancyState === "free") {
      return emptyFreeTableFields(table);
    }
    return {
      ...table,
      tableName: sanitizeTableName(params.tableName, table.tableName),
      customerPhone: sanitizePhone(params.customerPhone ?? table.customerPhone),
      covers: normalizeTableCovers(params.covers),
      note: params.note.trim().slice(0, 240),
      allergens: sanitizeAllergens(params.allergens ?? table.allergens),
      manualIntolerance: sanitizeManualIntolerance(
        params.manualIntolerance ?? table.manualIntolerance
      ),
    };
  });
  await syncTableLayoutToIntegration(params, updatedTable);
  return updatedTable;
}

export async function reserveDiningTable(
  params: TableSessionRequest & {
    tableId: string;
    reservationAt: number;
    tableName: string;
    customerPhone: string;
    covers?: number;
    note?: string;
    allergens?: string[];
    manualIntolerance?: string;
  }
) {
  assertValidSession(params);
  await saveTableReservationPreview(params);
  const blockTableNow = shouldReserveTableForReservation(params.reservationAt);
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => ({
    ...(blockTableNow ? table : emptyFreeTableFields(table)),
    tableName: sanitizeTableName(params.tableName, `Tavolo ${table.number}`),
    customerPhone: sanitizePhone(params.customerPhone),
    covers: normalizeTableCovers(params.covers ?? table.covers),
    note: (params.note ?? table.note).trim().slice(0, 240),
    allergens: sanitizeAllergens(params.allergens),
    manualIntolerance: sanitizeManualIntolerance(params.manualIntolerance),
    occupancyState: blockTableNow ? "reserved" : "free",
    reservationAt: params.reservationAt,
    seatedAt: null,
    ordersTaken: 0,
    ordersInProgress: 0,
    amountDue: 0,
  }));
  await syncTableLayoutToIntegration(params, updatedTable, blockTableNow ? "reserved" : "free");
  return updatedTable;
}

export async function occupyDiningTable(
  params: TableSessionRequest & {
    tableId: string;
    tableName?: string;
    customerPhone?: string;
    covers?: number;
    note?: string;
    allergens?: string[];
    manualIntolerance?: string;
  }
) {
  assertValidSession(params);
  const now = Date.now();
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => ({
    ...table,
    tableName: sanitizeTableName(params.tableName ?? table.tableName, `Tavolo ${table.number}`),
    customerPhone: sanitizePhone(params.customerPhone ?? table.customerPhone),
    covers: normalizeTableCovers(params.covers ?? table.covers),
    note: (params.note ?? table.note).trim().slice(0, 240),
    allergens: sanitizeAllergens(params.allergens ?? table.allergens),
    manualIntolerance: sanitizeManualIntolerance(
      params.manualIntolerance ?? table.manualIntolerance
    ),
    occupancyState: "seated",
    reservationAt: null,
    seatedAt: table.seatedAt ?? now,
  }));
  await syncTableLayoutToIntegration(params, updatedTable);
  appendAnalyticsTransaction({
    kind: "table_occupied",
    tableId: updatedTable.id,
    tableNumber: updatedTable.number,
    customerName: toAnalyticsCustomerName(updatedTable.tableName),
    ...toAnalyticsActorContext(params),
  });
  return updatedTable;
}

export async function markDiningReservationArrived(
  params: TableSessionRequest & {
    tableId: string;
  }
) {
  assertValidSession(params);
  const now = Date.now();
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    if (table.occupancyState === "seated") {
      return table;
    }
    if (table.occupancyState !== "reserved") {
      throw new Error("Arrivo disponibile solo per tavoli prenotati.");
    }
    return {
      ...table,
      occupancyState: "seated",
      reservationAt: null,
      seatedAt: now,
    };
  });
  await syncTableLayoutToIntegration(params, updatedTable);
  appendAnalyticsTransaction({
    kind: "table_occupied",
    tableId: updatedTable.id,
    tableNumber: updatedTable.number,
    customerName: toAnalyticsCustomerName(updatedTable.tableName),
    ...toAnalyticsActorContext(params),
    description: "Arrivo prenotazione",
  });
  return updatedTable;
}

export async function freeDiningTable(
  params: TableSessionRequest & {
    tableId: string;
  }
) {
  assertValidSession(params);
  let releasedTable: DiningTable | null = null;
  let releasedOfflineConfigurationTable = false;
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    if (table.ordersInProgress > 0 || table.amountDue > 0) {
      throw new Error("Non puoi liberare un tavolo in stato ordine o pagare.");
    }
    releasedTable = cloneTable(table);
    releasedOfflineConfigurationTable = Boolean(table.offlineLifecycle);
    return emptyFreeTableFields({
      ...table,
      occupancyState: "free",
    });
  });
  await syncTableLayoutToIntegration(params, updatedTable, "free");
  if (releasedOfflineConfigurationTable) {
    const offlineScope = resolveOfflineConfigurationScope(params);
    if (offlineScope) await releaseOfflineRemovedTable(offlineScope, params.tableId);
    const roomState = roomStates.get(params.roomId);
    if (roomState) {
      roomState.tables = roomState.tables.filter((table) => table.id !== params.tableId);
      roomState.version += 1;
      roomLayoutFingerprint.delete(params.roomId);
      roomIntegrationFingerprint.delete(params.roomId);
    }
  }
  const analyticsSource = releasedTable ?? updatedTable;
  appendAnalyticsTransaction({
    kind: "table_freed",
    tableId: analyticsSource.id,
    tableNumber: analyticsSource.number,
    customerName: toAnalyticsCustomerName(analyticsSource.tableName),
    ...toAnalyticsActorContext(params),
  });
  return releasedOfflineConfigurationTable
    ? ({
        removedFromConfiguration: true,
        removedTableId: params.tableId,
      } satisfies RemovedDiningTableResult)
    : updatedTable;
}

type MonitorControlResponse = {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  result?: unknown;
};

export type AdminCancelDiningTableResult = {
  result?: unknown;
  printWarning?: string;
};

function monitorControlErrorMessage(payload: MonitorControlResponse | null, fallback: string) {
  const message = String(payload?.error ?? payload?.message ?? "").trim();
  return message || fallback;
}

async function postMonitorControl(
  session: TableSessionRequest,
  payload: Record<string, unknown>
): Promise<MonitorControlResponse> {
  const response = await apiFetch("/api/monitor/control", {
    method: "POST",
    credentials: "same-origin",
    headers: paymentRequestHeaders(session),
    body: JSON.stringify({
      ...buildPaymentSessionPayload(session),
      ...payload,
      confirm: true,
    }),
  });
  const body = (await response.json().catch(() => null)) as MonitorControlResponse | null;
  if (!response.ok || body?.ok === false) {
    throw new Error(
      monitorControlErrorMessage(body, `Operazione non riuscita (${response.status}).`)
    );
  }
  return body ?? {};
}

function isUnsupportedMonitorAction(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /azione monitor non supportata|non supportata|unsupported/i.test(message);
}

function isPendingMonitorPayment(record: Record<string, unknown>) {
  const status = String(record.status ?? record.paymentStatus ?? "")
    .trim()
    .toLowerCase();
  if (!status) return true;
  return ![
    "completed",
    "complete",
    "settled",
    "paid",
    "pagato",
    "pagata",
    "failed",
    "cancelled",
    "canceled",
    "voided",
    "deleted",
  ].includes(status);
}

type MonitorPaymentSummary = {
  id: string;
  note: string;
  pending: boolean;
  amount: number;
  methodLabel: string;
};

function parseMonitorPaymentAmount(entry: Record<string, unknown>) {
  const candidates = [
    entry.amount,
    entry.amountPaid,
    entry.paidAmount,
    entry.total,
    entry.totalAmount,
    entry.value,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return asMoney(parsed);
  }
  return 0;
}

function monitorPaymentMethodLabel(entry: Record<string, unknown>) {
  const raw = String(
    entry.methodLabel ?? entry.paymentMethodLabel ?? entry.paymentMethod ?? entry.method ?? ""
  )
    .trim()
    .toLowerCase();
  if (!raw) return "Metodo non indicato";
  if (raw.includes("contant") || raw === "cash") return "Contanti";
  if (raw.includes("carta") || raw.includes("pos") || raw === "card") return "Carta";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatMonitorPaymentAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return "Importo non disponibile";
  return `${asMoney(amount).toFixed(2).replace(".", ",")} EUR`;
}

function formatMonitorPaymentSummary(payment: MonitorPaymentSummary) {
  return `${formatMonitorPaymentAmount(payment.amount)} - ${payment.methodLabel}`;
}

function resolveMonitorPaymentSummaries(paymentIds: string[], payments: MonitorPaymentSummary[]) {
  const byId = new Map(payments.map((payment) => [payment.id, payment]));
  return paymentIds.map(
    (id) =>
      byId.get(id) ?? {
        id,
        note: "",
        pending: false,
        amount: 0,
        methodLabel: "Metodo non indicato",
      }
  );
}

async function fetchMonitorPaymentsForTable(params: {
  tableIds: string[];
  orderIds: string[];
}): Promise<MonitorPaymentSummary[]> {
  const response = await apiFetch(`/api/monitor/overview?_=${Date.now()}`, {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const payments = Array.isArray(body?.payments) ? body.payments : [];
  const tableIds = new Set(params.tableIds);
  const orderIds = new Set(params.orderIds);
  const seen = new Set<string>();
  return payments
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object")
    )
    .filter((entry) => {
      const paymentTableId = String(entry.tableId ?? "").trim();
      const paymentOrderIds = Array.isArray(entry.orderIds)
        ? entry.orderIds.map((value) => String(value).trim()).filter(Boolean)
        : [String(entry.orderId ?? "").trim()].filter(Boolean);
      return (
        tableIds.has(paymentTableId) || paymentOrderIds.some((orderId) => orderIds.has(orderId))
      );
    })
    .map((entry) => ({
      id: String(entry.id ?? entry.paymentId ?? "").trim(),
      note: String(entry.note ?? "").trim(),
      pending: isPendingMonitorPayment(entry),
      amount: parseMonitorPaymentAmount(entry),
      methodLabel: monitorPaymentMethodLabel(entry),
    }))
    .filter((entry) => {
      if (!entry.id || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
}

function appendTableCancellationPaymentNote(note: string, reason: string) {
  const marker = `Cancellazione tavolo: ${reason}`.slice(0, 220);
  if (note.toLowerCase().includes("cancellazione tavolo")) return note.slice(0, 240);
  return [note, marker].filter(Boolean).join(" | ").slice(0, 240);
}

async function markCompletedMonitorPaymentsForTable(
  session: TableSessionRequest,
  params: {
    tableIds: string[];
    orderIds: string[];
    reason: string;
    payments?: MonitorPaymentSummary[];
  }
): Promise<MonitorPaymentSummary[]> {
  const payments = params.payments ?? (await fetchMonitorPaymentsForTable(params).catch(() => []));
  const completed = payments.filter((payment) => !payment.pending);
  const marked: MonitorPaymentSummary[] = [];
  for (const payment of completed) {
    try {
      await postMonitorControl(session, {
        action: "payment_update",
        paymentId: payment.id,
        patch: {
          note: appendTableCancellationPaymentNote(payment.note, params.reason),
        },
        reason: params.reason,
      });
      marked.push(payment);
    } catch {
      // La cancellazione tavolo non deve fallire se un vecchio movimento non consente la nota.
    }
  }
  return marked;
}

function escPosReset() {
  return "\x1b@\x1ba\x00\x1bE\x00\x1d!\x00";
}

function buildAdminTableCancellationTicket(params: {
  table: DiningTable;
  reason: string;
  operatorName?: string;
  roomName?: string;
  orderIds: string[];
  paymentSummaries?: string[];
}) {
  const table = params.table;
  const tableLabel = table.tableLabel || table.logicalTableLabel || String(table.number || "?");
  const roomLabel = params.roomName || "";
  const orderLabel = params.orderIds.length > 0 ? params.orderIds.join(", ") : "Nessuna comanda";
  const paymentLabel =
    params.paymentSummaries && params.paymentSummaries.length > 0
      ? params.paymentSummaries.join(", ")
      : "Nessun movimento collegato";
  const lines = [
    "\x1b@",
    "\x1ba\x01\x1bE\x01\x1d!\x11CANCELLAZIONE TAVOLO",
    escPosReset(),
    "\x1bE\x01TAVOLO\x1bE\x00 " + tableLabel + (roomLabel ? ` - ${roomLabel}` : ""),
    `OPERATORE ${params.operatorName || "Admin"}`,
    `DATA ${new Date().toLocaleString("it-IT")}`,
    "--------------------------------",
    `COMANDE ${orderLabel}`,
    `MOVIMENTI ${paymentLabel}`,
    "--------------------------------",
    "MOTIVO",
    params.reason,
    "",
  ];
  return lines.join("\n");
}

async function printAdminTableCancellationTicket(
  session: TableSessionRequest,
  params: {
    table: DiningTable;
    reason: string;
    roomName?: string;
    orderIds: string[];
    paymentSummaries?: string[];
  }
) {
  const response = await apiFetch("/api/integration/print", {
    method: "POST",
    credentials: "same-origin",
    headers: paymentRequestHeaders(session),
    body: JSON.stringify({
      ...buildPaymentSessionPayload(session),
      kind: "table_cancel",
      operationalSchemaVersion: 2,
      ignoreWorkstationRouting: true,
      activityId: session.activityId,
      tableId: params.table.id,
      tableLabel:
        params.table.tableLabel ||
        params.table.logicalTableLabel ||
        String(params.table.number || ""),
      roomId: session.roomId,
      orderId: `table_cancel_${params.table.id}_${Date.now()}`,
      clientApp: "mobile-admin-table-cancel",
      text: buildAdminTableCancellationTicket({
        ...params,
        operatorName: session.fullName || session.username || "Admin",
      }),
    }),
  });
  const body = (await response.json().catch(() => null)) as MonitorControlResponse | null;
  if (!response.ok || body?.ok === false) {
    throw new Error(monitorControlErrorMessage(body, "Stampa cancellazione tavolo non riuscita."));
  }
}

export async function adminCancelDiningTable(
  params: TableSessionRequest & {
    table: DiningTable;
    reason: string;
    targetTableIds?: string[];
    orderIds?: string[];
    roomName?: string;
  }
): Promise<AdminCancelDiningTableResult> {
  assertValidSession(params);
  const reason = params.reason.trim();
  if (reason.length < 3) {
    throw new Error("Inserisci una motivazione per cancellare il tavolo.");
  }
  const tableIds = [
    ...new Set(
      [params.table.id, ...(params.targetTableIds ?? [])]
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
  const orderIds = [
    ...new Set(
      (params.orderIds ?? params.table.orderHistory.map((order) => order.id))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];

  let result: unknown = null;
  let deletedPendingPaymentIds: string[] = [];
  const monitorPayments = await fetchMonitorPaymentsForTable({
    tableIds,
    orderIds,
  }).catch(() => []);
  const markedCompletedPayments = await markCompletedMonitorPaymentsForTable(params, {
    tableIds,
    orderIds,
    reason,
    payments: monitorPayments,
  });
  const markedCompletedPaymentIds = markedCompletedPayments.map((payment) => payment.id);
  try {
    const nativeResult = await postMonitorControl(params, {
      action: "table_cancel_full",
      tableId: params.table.id,
      tableIds,
      reason,
    });
    result = nativeResult.result;
  } catch (error) {
    if (!isUnsupportedMonitorAction(error)) throw error;
    for (const orderId of orderIds) {
      try {
        await postMonitorControl(params, {
          action: "order_delete",
          orderId,
          reason,
        });
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : "";
        if (!/non trovata|not found/i.test(message)) throw deleteError;
      }
    }
    deletedPendingPaymentIds = monitorPayments
      .filter((payment) => payment.pending)
      .map((payment) => payment.id);
    for (const paymentId of deletedPendingPaymentIds) {
      try {
        await postMonitorControl(params, {
          action: "payment_delete",
          paymentId,
          reason,
        });
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : "";
        if (!/non trovato|not found/i.test(message)) throw deleteError;
      }
    }
    for (const tableId of tableIds) {
      await postMonitorControl(params, {
        action: "table_reset",
        tableId,
        reason,
      });
    }
    result = {
      fallback: true,
      resetTableIds: tableIds,
      deletedOrderIds: orderIds,
      deletedPendingPaymentIds,
      markedCompletedPaymentIds,
    };
  }

  const deletedPaymentIds = Array.isArray(
    (result as { deletedPendingPaymentIds?: unknown[] })?.deletedPendingPaymentIds
  )
    ? ((result as { deletedPendingPaymentIds?: unknown[] }).deletedPendingPaymentIds ?? []).map(
        (value) => String(value)
      )
    : deletedPendingPaymentIds;
  const deletedPaymentSummaries = resolveMonitorPaymentSummaries(
    deletedPaymentIds,
    monitorPayments
  );
  const paymentSummaries = [...deletedPaymentSummaries, ...markedCompletedPayments]
    .filter(
      (payment, index, source) => source.findIndex((entry) => entry.id === payment.id) === index
    )
    .map(formatMonitorPaymentSummary);
  try {
    await printAdminTableCancellationTicket(params, {
      table: params.table,
      reason,
      roomName: params.roomName,
      orderIds,
      paymentSummaries,
    });
  } catch (error) {
    return {
      result,
      printWarning:
        error instanceof Error
          ? `Cancellazione eseguita, ma ticket non stampato: ${error.message}`
          : "Cancellazione eseguita, ma ticket non stampato.",
    };
  }

  return { result };
}

const releaseRemovedSourceAfterMove = async (
  params: TableSessionRequest & { fromTableId: string },
  source: DiningTable | null
) => {
  if (!source?.offlineLifecycle) return;
  const offlineScope = resolveOfflineConfigurationScope(params);
  if (offlineScope) await releaseOfflineRemovedTable(offlineScope, params.fromTableId);
  const roomState = roomStates.get(params.roomId);
  if (roomState) {
    roomState.tables = roomState.tables.filter((table) => table.id !== params.fromTableId);
    roomState.version += 1;
  }
  roomLayoutFingerprint.delete(params.roomId);
  roomIntegrationFingerprint.delete(params.roomId);
};

export async function moveDiningTable(
  params: TableSessionRequest & {
    fromTableId: string;
    toTableId: string;
    targetRoomId?: string;
  }
): Promise<DiningTableMoveResult> {
  assertValidSession(params);
  if (params.fromTableId === params.toTableId) {
    throw new Error("Seleziona un tavolo diverso per lo spostamento.");
  }

  const targetRoomId = String(params.targetRoomId ?? params.roomId).trim() || params.roomId;
  const sourceBeforeMove = findCachedRoomTable(params.roomId, params.fromTableId);
  const removedSourceTableId = sourceBeforeMove?.offlineLifecycle ? params.fromTableId : undefined;
  const backendMove = await sendIntegrationLayoutMoveRequest({
    ...params,
    removedSourceSnapshot: buildRemovedSourceTableMoveSnapshot(sourceBeforeMove, params.roomId),
  });
  if (!backendMove.ok) {
    if (backendMove.networkError) {
      throw new Error(
        "Backend non raggiungibile: spostamento tavolo non eseguito per evitare stampe mancanti."
      );
    }
    throw new Error(backendMove.message || "Spostamento tavolo non riuscito.");
  }

  roomIntegrationFingerprint.delete(params.roomId);
  roomLayoutFingerprint.delete(params.roomId);
  roomIntegrationFingerprint.delete(targetRoomId);
  roomLayoutFingerprint.delete(targetRoomId);

  if (backendMove.fromTable && backendMove.toTable) {
    const movedFrom = upsertRoomTable(params.roomId, backendMove.fromTable);
    const movedTo = upsertRoomTable(
      targetRoomId,
      enrichMovedTargetFromLocalSource(backendMove.toTable, sourceBeforeMove)
    );
    await releaseRemovedSourceAfterMove(params, sourceBeforeMove);
    return { movedFrom, movedTo, removedSourceTableId };
  }

  const refreshed = await fetchTablesForSession(params);
  const targetRefreshed =
    targetRoomId === params.roomId
      ? refreshed
      : await fetchTablesForSession({ ...params, roomId: targetRoomId });
  const backendMovedFrom =
    (refreshed.rawTables ?? refreshed.tables).find((table) => table.id === params.fromTableId) ??
    null;
  const backendMovedTo =
    (targetRefreshed.rawTables ?? targetRefreshed.tables).find(
      (table) => table.id === params.toTableId
    ) ?? null;
  if (backendMovedFrom && backendMovedTo) {
    await releaseRemovedSourceAfterMove(params, sourceBeforeMove);
    return { movedFrom: backendMovedFrom, movedTo: backendMovedTo, removedSourceTableId };
  }

  const sourceRoomState = getRoomState(params.roomId);
  const targetRoomState = getRoomState(targetRoomId);
  const sourceIndex = sourceRoomState.tables.findIndex((table) => table.id === params.fromTableId);
  const targetIndex = targetRoomState.tables.findIndex((table) => table.id === params.toTableId);
  if (sourceIndex < 0 || targetIndex < 0) {
    throw new Error("Tavolo sorgente o destinazione non trovato.");
  }

  const source = cloneTable(sourceRoomState.tables[sourceIndex]);
  const target = cloneTable(targetRoomState.tables[targetIndex]);

  if (source.occupancyState === "free") {
    throw new Error("Il tavolo sorgente e gia libero.");
  }
  if (target.occupancyState !== "free") {
    throw new Error("Il tavolo destinazione deve essere libero.");
  }

  targetRoomState.tables[targetIndex] = {
    ...target,
    tableName: source.tableName,
    customerPhone: source.customerPhone,
    covers: source.covers,
    occupancyState: source.occupancyState,
    reservationAt: source.reservationAt,
    seatedAt: source.seatedAt,
    ordersTaken: source.ordersTaken,
    ordersInProgress: source.ordersInProgress,
    amountDue: source.amountDue,
    note: source.note,
    allergens: [...source.allergens],
    manualIntolerance: source.manualIntolerance,
    orderHistory: source.orderHistory.map(cloneOrder),
  };

  sourceRoomState.tables[sourceIndex] = emptyFreeTableFields({
    ...source,
    occupancyState: "free",
  });

  if (sourceRoomState === targetRoomState) {
    sourceRoomState.version += 1;
  } else {
    sourceRoomState.version += 1;
    targetRoomState.version += 1;
  }
  const movedFrom = cloneTable(sourceRoomState.tables[sourceIndex]);
  const movedTo = cloneTable(targetRoomState.tables[targetIndex]);
  appendAnalyticsTransaction({
    kind: "table_freed",
    tableId: source.id,
    tableNumber: source.number,
    customerName: toAnalyticsCustomerName(source.tableName),
    ...toAnalyticsActorContext(params),
    description: `Spostato su tavolo ${movedTo.number}`,
  });
  appendAnalyticsTransaction({
    kind: "table_occupied",
    tableId: movedTo.id,
    tableNumber: movedTo.number,
    customerName: toAnalyticsCustomerName(movedTo.tableName),
    ...toAnalyticsActorContext(params),
    description: `Arrivo da tavolo ${source.number}`,
  });
  await releaseRemovedSourceAfterMove(params, source);
  return { movedFrom, movedTo, removedSourceTableId };
}

export async function addDiningTableOrder(
  params: TableSessionRequest & {
    tableId: string;
    title?: string;
    total?: number;
    orderNote?: string;
    orderComment?: string;
    lines?: DiningTableOrderLine[];
  }
) {
  assertValidSession(params);
  const now = Date.now();
  let analyticsOrderTotal: number | null = null;
  let analyticsOrderTitle = "";
  let analyticsOrderLines: DiningTableOrderLine[] = [];
  let updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    if (table.occupancyState !== "seated") {
      throw new Error("Puoi ordinare solo su tavolo accomodato.");
    }
    const nextOrderIndex = table.ordersTaken + 1;
    const orderTotal = asMoney(clamp(params.total ?? 11 + (nextOrderIndex % 4) * 6.35, 1, 999));
    const orderLines = Array.isArray(params.lines) ? params.lines : [];
    const nextOrder: DiningTableOrder = {
      id: toOrderId(table.id, now),
      title: (params.title?.trim() || `Ordine #${nextOrderIndex}`).slice(0, 64),
      createdAt: now,
      total: orderTotal,
      state: "in_progress",
      workflowStatus: "waiting",
      orderNote: params.orderNote?.trim().slice(0, 200) || undefined,
      orderComment: params.orderComment?.trim().slice(0, 200) || undefined,
      paidArticleUnits: [],
      lines: orderLines.map((line) => {
        const source =
          line && typeof line === "object"
            ? (line as DiningTableOrderLine)
            : ({} as DiningTableOrderLine);
        const unitBasePrice = sanitizeOptionalMoney(source.unitBasePrice);
        const unitFinalPrice = sanitizeOptionalMoney(source.unitFinalPrice);
        const priceDelta = sanitizeOptionalSignedMoney(source.priceDelta);
        const productId =
          String(source.productId ?? "")
            .trim()
            .slice(0, 64) || undefined;
        const clientPriceSnapshot = sanitizeClientPriceSnapshot(source.clientPriceSnapshot);
        const explicitPriceChanged =
          typeof source.priceChanged === "boolean" ? source.priceChanged : undefined;
        const priceChangeReason = sanitizePriceChangeReason(source.priceChangeReason);
        const vatRateRaw = Number(source.vatRate);
        const vatRate =
          Number.isFinite(vatRateRaw) && vatRateRaw >= 0 && vatRateRaw <= 100
            ? Math.round(vatRateRaw * 1000) / 1000
            : undefined;
        const vatCode =
          String(source.vatCode ?? "")
            .trim()
            .slice(0, 32) || undefined;
        const priceChanged =
          explicitPriceChanged !== undefined
            ? explicitPriceChanged
            : Boolean(
                (priceDelta !== undefined && Math.abs(priceDelta) > 0.0001) || priceChangeReason
              );
        return {
          productId,
          name:
            String(source.name ?? "Articolo")
              .trim()
              .slice(0, 64) || "Articolo",
          qty: clamp(Math.round(Number(source.qty) || 1), 1, 99),
          note:
            String(source.note ?? "")
              .trim()
              .slice(0, 120) || undefined,
          variantName:
            String(source.variantName ?? "")
              .trim()
              .slice(0, 64) || undefined,
          unitBasePrice,
          unitFinalPrice,
          priceDelta,
          priceChanged,
          priceChangeReason,
          vatRate,
          vatCode,
          clientPriceSnapshot,
        };
      }),
    };
    return {
      ...table,
      occupancyState: "seated",
      reservationAt: null,
      seatedAt: table.seatedAt ?? now,
      ordersTaken: nextOrderIndex,
      ordersInProgress: table.ordersInProgress + 1,
      orderHistory: [nextOrder, ...table.orderHistory].slice(0, 120),
    };
  });
  const insertedOrder = updatedTable.orderHistory[0] ?? null;
  if (insertedOrder) {
    analyticsOrderTotal = insertedOrder.total;
    analyticsOrderTitle = insertedOrder.title;
    analyticsOrderLines = insertedOrder.lines.map((line) => ({ ...line }));
  }
  let warningMessage: string | undefined;
  let warningCode: string | undefined;
  if (insertedOrder) {
    const synced = await syncOrderToIntegration(params, updatedTable, insertedOrder);
    warningCode = synced?.warningCode;
    warningMessage = synced?.warningMessage;
    if (!synced || !synced.id) {
      updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
        const hasLocalOrder = table.orderHistory.some((order) => order.id === insertedOrder.id);
        if (!hasLocalOrder) return table;
        return {
          ...table,
          ordersTaken: Math.max(0, table.ordersTaken - 1),
          ordersInProgress: Math.max(0, table.ordersInProgress - 1),
          orderHistory: table.orderHistory.filter((order) => order.id !== insertedOrder.id),
        };
      });
      await syncTableLayoutToIntegration(params, updatedTable);
      throw new Error("Invio comanda non riuscito: backend non raggiungibile.");
    }
    if (synced && synced.id) {
      const canonicalOrder = synced.order
        ? toDiningOrderFromIntegration(synced.order)
        : null;
      updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => ({
        ...table,
        orderHistory: table.orderHistory.map((order) =>
          order.id === insertedOrder.id
            ? (canonicalOrder ?? { ...order, id: synced.id })
            : order
        ),
      }));
    }
    roomIntegrationFingerprint.delete(params.roomId);
  }
  void syncTableLayoutToIntegration(params, updatedTable, "waiting").catch((error) => {
    console.warn("[tables] sync layout post-comanda in background non riuscita", error);
  });
  if (analyticsOrderTotal && analyticsOrderTotal > 0) {
    appendAnalyticsTransaction({
      kind: "consumption",
      tableId: updatedTable.id,
      tableNumber: updatedTable.number,
      customerName: toAnalyticsCustomerName(updatedTable.tableName),
      ...toAnalyticsActorContext(params),
      description: analyticsOrderTitle || "Consumazione registrata",
      amount: analyticsOrderTotal,
      orderLines: analyticsOrderLines.map((line) => ({
        name: line.name,
        qty: line.qty,
        note: line.note,
        variantName: line.variantName,
        unitBasePrice: line.unitBasePrice,
        unitFinalPrice: line.unitFinalPrice,
        priceDelta: line.priceDelta,
        priceChanged: line.priceChanged,
        priceChangeReason: line.priceChangeReason,
      })),
    });
  }
  return {
    table: updatedTable,
    warningCode,
    warningMessage,
  };
}

export async function markDiningOrderServed(
  params: TableSessionRequest & {
    tableId: string;
    orderId?: string;
  }
) {
  assertValidSession(params);
  let servedOrder: DiningTableOrder | null = null;
  const tableSnapshot = findCachedRoomTable(params.roomId, params.tableId);
  const canMarkDelivered = (order: DiningTableOrder) => {
    if (order.state !== "in_progress") return false;
    if (!isIntegrationOrderId(order.id)) return true;
    return parseIntegrationWorkflowStatus(order.workflowStatus ?? "waiting") === "ready";
  };
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    const target = params.orderId
      ? table.orderHistory.find((order) => order.id === params.orderId && canMarkDelivered(order))
      : table.orderHistory.find((order) => canMarkDelivered(order));
    if (!target) return table;
    servedOrder = { ...target, state: "served", workflowStatus: "delivered" };
    return {
      ...table,
      ordersInProgress: Math.max(0, table.ordersInProgress - 1),
      amountDue: asMoney(table.amountDue + target.total),
      orderHistory: table.orderHistory.map((order) =>
        order.id === target.id ? { ...order, state: "served", workflowStatus: "delivered" } : order
      ),
    };
  });
  if (servedOrder) {
    try {
      await syncIntegrationOrderFromLocal(servedOrder, params);
    } catch (error) {
      // Il backend ha rifiutato la consegna: annulla l'aggiornamento ottimistico, altrimenti
      // la comanda resta "Consegnato" a schermo fino al polling successivo.
      if (tableSnapshot) upsertRoomTable(params.roomId, tableSnapshot);
      roomIntegrationFingerprint.delete(params.roomId);
      throw error;
    }
    roomIntegrationFingerprint.delete(params.roomId);
  }
  await syncTableLayoutToIntegration(params, updatedTable);
  return updatedTable;
}

export async function payDiningTable(
  params: TableSessionRequest & {
    tableId: string;
    amount?: number;
    paymentMethod?: TablePaymentMethod;
    orderId?: string;
    articleUnitIds?: string[];
    splitMode?: TablePaymentSplitMode;
    cashReceived?: number;
    cashSource?: "wallet" | "automatic";
    automaticCashPaymentOperationId?: string;
    note?: string;
    receiptType?: TablePaymentReceiptType;
    invoiceRecipient?: TablePaymentInvoiceRecipient | null;
    adminAdjustment?: TablePaymentAdminAdjustment;
    commercialBenefitApplications?: TableCommercialBenefitApplication[];
    clientPaymentId?: string;
    romanSharesPaid?: number;
    romanSharesTotal?: number;
  }
) {
  assertValidSession(params);
  const roomState = getRoomState(params.roomId);
  const currentTable = roomState.tables.find((table) => table.id === params.tableId);
  if (!currentTable) {
    throw new Error("Tavolo non trovato.");
  }
  const requestedBenefitAmount = asMoney(
    (params.commercialBenefitApplications ?? []).reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.benefitAmountCents) || 0) / 100,
      0
    )
  );
  const amountRaw = Number(params.amount);
  const requestedBackendAmount = asMoney(
    Number.isFinite(amountRaw)
      ? Math.max(amountRaw, 0)
      : Math.max(Number(currentTable.amountDue) || 0, 0)
  );
  if (requestedBackendAmount <= 0 && requestedBenefitAmount <= 0) {
    throw new Error("Nessun importo da pagare per il tavolo selezionato.");
  }
  const backendPayment = await sendBackendFreeSplitPaymentRequest(
    params,
    buildBackendFreeSplitPaymentPayload({
      ...params,
      amount: requestedBackendAmount,
    })
  );

  let paidAmountApplied = 0;
  let paidTableSnapshot: DiningTable | null = null;
  const updatedTable = updateRoomTable(params.roomId, params.tableId, (table) => {
    if (table.amountDue <= 0) return table;

    const targetOrder = params.orderId
      ? table.orderHistory.find((order) => order.id === params.orderId && order.state === "served")
      : null;

    const requestedArticleUnits = new Set(
      (params.articleUnitIds ?? []).map((value) => value.trim()).filter((value) => value.length > 0)
    );

    const articleUnitAmountById = new Map<string, number>();
    const articleOrderUnitsByOrderId = new Map<string, string[]>();

    table.orderHistory.forEach((order) => {
      if (order.state !== "served") return;
      const expandedUnits = expandOrderUnitPayments(order);
      const paidUnits = new Set(normalizePaidArticleUnits(order));
      const availableUnitIds: string[] = [];
      expandedUnits.forEach((unit) => {
        if (paidUnits.has(unit.id)) return;
        articleUnitAmountById.set(unit.id, unit.amount);
        availableUnitIds.push(unit.id);
      });
      articleOrderUnitsByOrderId.set(order.id, availableUnitIds);
    });

    const articleMaxPayable = asMoney(
      [...requestedArticleUnits].reduce(
        (sum, unitId) => sum + (articleUnitAmountById.get(unitId) ?? 0),
        0
      )
    );
    const baseMaxPayable = targetOrder
      ? Math.min(table.amountDue, targetOrder.total)
      : table.amountDue;
    const maxPayable =
      requestedArticleUnits.size > 0 ? Math.min(baseMaxPayable, articleMaxPayable) : baseMaxPayable;
    if (maxPayable <= 0) return table;
    const requestedCoveredAmount =
      requestedBackendAmount > 0 || requestedBenefitAmount > 0
        ? requestedBackendAmount + requestedBenefitAmount
        : maxPayable;
    const coveredAmount = clamp(requestedCoveredAmount, 0, maxPayable);
    paidAmountApplied = clamp(requestedBackendAmount, 0, coveredAmount);
    paidTableSnapshot = cloneTable(table);
    const nextDue = asMoney(table.amountDue - coveredAmount);
    const markAllAsPaid = !targetOrder && nextDue <= 0.009;
    const markSingleAsPaid = Boolean(targetOrder && coveredAmount >= targetOrder.total - 0.009);

    return {
      ...table,
      amountDue: nextDue <= 0.009 ? 0 : nextDue,
      orderHistory: table.orderHistory.map((order) => {
        const orderAvailableUnitIds = articleOrderUnitsByOrderId.get(order.id) ?? [];
        const orderAvailableUnitIdSet = new Set(orderAvailableUnitIds);
        const existingPaidUnits = normalizePaidArticleUnits(order);
        const mergedPaidUnits = new Set(existingPaidUnits);
        if (
          order.state === "served" &&
          requestedArticleUnits.size > 0 &&
          orderAvailableUnitIds.length > 0
        ) {
          requestedArticleUnits.forEach((unitId) => {
            if (orderAvailableUnitIdSet.has(unitId)) mergedPaidUnits.add(unitId);
          });
        }
        const nextPaidUnits = [...mergedPaidUnits];
        const orderUnitIds = buildOrderUnitIds(order);
        const orderFullyPaidByUnits =
          orderUnitIds.length > 0 && nextPaidUnits.length >= orderUnitIds.length;

        if (markAllAsPaid && order.state === "served") {
          return { ...order, state: "paid", paidArticleUnits: nextPaidUnits };
        }
        if (markSingleAsPaid && targetOrder && order.id === targetOrder.id) {
          return { ...order, state: "paid", paidArticleUnits: nextPaidUnits };
        }
        if (orderFullyPaidByUnits && order.state === "served") {
          return { ...order, state: "paid", paidArticleUnits: nextPaidUnits };
        }
        if (nextPaidUnits.length !== existingPaidUnits.length) {
          return { ...order, paidArticleUnits: nextPaidUnits };
        }
        return { ...order, paidArticleUnits: existingPaidUnits };
      }),
    };
  });
  roomIntegrationFingerprint.delete(params.roomId);
  const backendTable = mergeBackendPaymentTableSnapshot(updatedTable, backendPayment?.table);
  if (backendTable) {
    upsertRoomTable(params.roomId, backendTable);
  } else {
    await syncTableLayoutToIntegration(params, updatedTable);
  }
  if (paidAmountApplied > 0) {
    const analyticsSource = paidTableSnapshot ?? backendTable ?? updatedTable;
    appendAnalyticsTransaction({
      kind: "payment",
      tableId: analyticsSource.id,
      tableNumber: analyticsSource.number,
      roomId: params.roomId,
      paymentId: readBackendPaymentId(backendPayment),
      customerName: toAnalyticsCustomerName(analyticsSource.tableName),
      ...toAnalyticsActorContext(params),
      amount: paidAmountApplied,
      paymentMethod: sanitizeAnalyticsPaymentMethod(params.paymentMethod),
    });
  }
  if (backendTable) {
    return backendTable;
  }
  return updatedTable;
}
