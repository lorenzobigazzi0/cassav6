import type { IntegrationOrderWorkflowStatus, TableOccupancyState } from "./types";

export type IntegrationOrderCreateResult = {
  id: string;
  warningCode?: string;
  warningMessage?: string;
  queued?: boolean;
};

export type IntegrationQueueOwner = {
  userId: string;
  activityId: string;
  deviceUuid: string;
};

export type PendingIntegrationOrderCreate = {
  kind: "order_create";
  owner: IntegrationQueueOwner;
  roomId: string;
  tableId: string;
  localOrderId: string;
  payload: Record<string, unknown>;
  queuedAtMs: number;
};

export type PendingIntegrationOrderSync = {
  kind: "order_sync";
  owner: IntegrationQueueOwner;
  orderId: string;
  payload: Record<string, unknown>;
  queuedAtMs: number;
};

export type PendingIntegrationLayoutSync = {
  kind: "layout_sync";
  owner: IntegrationQueueOwner;
  tableId: string;
  payload: {
    basePayload: Record<string, unknown>;
    payloadWithSession: Record<string, unknown> | null;
  };
  queuedAtMs: number;
};

export type PendingIntegrationAction =
  | PendingIntegrationOrderCreate
  | PendingIntegrationOrderSync
  | PendingIntegrationLayoutSync;

export type IntegrationOrderItem = {
  id: string;
  lineId: string;
  qty: number;
  productId: string;
  name: string;
  variant: string;
  note: string;
  modifiers: Record<string, string>;
  unitPriceApplied: number;
  listPriceAtTime: number;
  vatRate?: number;
  vatCode?: string;
  lineType: string;
  voidedAt: string;
  done: boolean;
};

export type IntegrationOrder = {
  id: string;
  currentRevision: number;
  roomId: string;
  tableId: string;
  tableNumber: number;
  title: string;
  total: number;
  workflowStatus: IntegrationOrderWorkflowStatus;
  paymentStatus: "unpaid" | "partial" | "paid";
  dueAmount: number;
  paidAmount: number;
  paidArticleUnits: string[];
  orderNote: string;
  orderComment: string;
  createdAtMs: number;
  updatedAtMs: number;
  items: IntegrationOrderItem[];
  compAvailability?: {
    byLine?: Record<string, { availableQuantity?: number; compedQuantity?: number }>;
    byProduct?: Record<string, { availableQuantity?: number; compedQuantity?: number }>;
  };
};

export type IntegrationLayoutRoom = {
  id: string;
  name: string;
};

export type IntegrationLayoutOfflineLifecycle = {
  state: "removed_while_active";
  removedAt: number;
  removedFromLayoutVersion: number;
  usableUntil: "released";
  requiresDecision: boolean;
  decision: "pending" | "keep";
};

export type IntegrationLayoutTable = {
  id: string;
  number: number;
  roomId: string;
  roomName: string;
  tableName: string;
  customerPhone: string;
  covers: number;
  occupancyState: TableOccupancyState;
  reservationAt: number | null;
  seatedAt: number | null;
  ordersTaken: number;
  ordersInProgress: number;
  amountDue: number;
  note: string;
  allergens: string[];
  manualIntolerance: string;
  paymentArticleSplitLocked: boolean;
  offlineLifecycle?: IntegrationLayoutOfflineLifecycle;
};
