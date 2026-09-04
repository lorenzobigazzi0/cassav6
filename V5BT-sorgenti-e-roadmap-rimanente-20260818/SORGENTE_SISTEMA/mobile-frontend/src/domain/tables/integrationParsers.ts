import type {
  DiningTable,
  DiningTableOrder,
  IntegrationOrderWorkflowStatus,
  TableOccupancyState,
} from "./types";
import type {
  IntegrationLayoutRoom,
  IntegrationLayoutTable,
  IntegrationOrder,
  IntegrationOrderItem,
} from "./integrationTypes";
import { normalizeAllergenList } from "../allergens";
import { normalizeTableCovers } from "./capacity";

const asMoney = (value: number) => Math.round(value * 100) / 100;

const asOrderRevision = (value: unknown) => {
  const parsed = Math.trunc(Number(value) || 0);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 1_000_000)) : 1;
};

const asStringRecord = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, entry]) => [String(key).trim(), String(entry ?? "").trim()])
          .filter(([key, entry]) => key && entry)
      )
    : {};

const asStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        ),
      ]
    : [];

export const parseIntegrationLayoutRoom = (raw: unknown): IntegrationLayoutRoom | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  const name = String(source.name ?? "").trim();
  if (!id || !name) return null;
  return { id, name };
};

export const parseIntegrationLayoutTable = (raw: unknown): IntegrationLayoutTable | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  const roomId = String(source.roomId ?? "").trim();
  const roomName = String(source.roomName ?? "").trim();
  if (!id || !roomId || !roomName) return null;
  const occupancyRaw = String(source.occupancyState ?? "free").trim();
  const occupancyState: TableOccupancyState =
    occupancyRaw === "reserved" || occupancyRaw === "seated" ? occupancyRaw : "free";
  const number = Math.max(0, Math.trunc(Number(source.number ?? 0) || 0));
  const reservationAtRaw = Number(source.reservationAt);
  const seatedAtRaw = Number(source.seatedAt);
  return {
    id,
    number,
    roomId,
    roomName,
    tableName: String(source.tableName ?? "").trim(),
    customerPhone: String(source.customerPhone ?? "").trim(),
    covers: normalizeTableCovers(source.covers, { minimum: 0, fallback: 0 }),
    occupancyState,
    reservationAt:
      Number.isFinite(reservationAtRaw) && reservationAtRaw > 0
        ? Math.trunc(reservationAtRaw)
        : null,
    seatedAt: Number.isFinite(seatedAtRaw) && seatedAtRaw > 0 ? Math.trunc(seatedAtRaw) : null,
    ordersTaken: Math.max(0, Math.trunc(Number(source.ordersTaken ?? 0) || 0)),
    ordersInProgress: Math.max(0, Math.trunc(Number(source.ordersInProgress ?? 0) || 0)),
    amountDue: asMoney(
      Math.max(0, Number(source.amountDue ?? source.totalDue ?? source.dueAmount ?? 0) || 0)
    ),
    note: String(source.note ?? "").trim(),
    allergens: normalizeAllergenList(Array.isArray(source.allergens) ? source.allergens : []),
    manualIntolerance: String(source.manualIntolerance ?? "").trim(),
    paymentArticleSplitLocked: source.paymentArticleSplitLocked === true,
  };
};

type LayoutTableWithOfflineHistory = IntegrationLayoutTable & {
  orderHistory?: DiningTableOrder[];
};

const cloneOfflineOrderHistory = (orders: DiningTableOrder[] | undefined) =>
  Array.isArray(orders)
    ? orders.map((order) => ({
        ...order,
        paidArticleUnits: [...(order.paidArticleUnits ?? [])],
        lines: Array.isArray(order.lines) ? order.lines.map((line) => ({ ...line })) : [],
      }))
    : [];

export const toDiningTableFromLayout = (table: LayoutTableWithOfflineHistory): DiningTable => ({
  id: table.id,
  number: table.number,
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
  paymentArticleSplitLocked: table.paymentArticleSplitLocked,
  offlineLifecycle: table.offlineLifecycle,
  orderHistory: cloneOfflineOrderHistory(table.orderHistory),
});

export const parseIntegrationWorkflowStatus = (value: unknown): IntegrationOrderWorkflowStatus => {
  const raw = String(value ?? "waiting")
    .trim()
    .toLowerCase();
  if (raw === "cancelled" || raw === "annullata" || raw === "voided") return "cancelled";
  if (raw === "done" || raw === "delivered" || raw === "consegnato") return "delivered";
  if (
    raw === "ready" ||
    raw === "da consegnare" ||
    raw === "da_consegnare" ||
    raw === "pronto" ||
    raw === "pronta"
  ) {
    return "ready";
  }
  if (raw === "prep" || raw === "in preparazione" || raw === "in_preparazione") return "prep";
  return "waiting";
};

export const parseIntegrationOrder = (raw: unknown): IntegrationOrder | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  if (!id) return null;

  const workflowStatus = parseIntegrationWorkflowStatus(source.workflowStatus);

  const paymentStatusRaw = String(source.paymentStatus ?? "unpaid").trim();
  const paymentStatus =
    paymentStatusRaw === "paid" || paymentStatusRaw === "partial" ? paymentStatusRaw : "unpaid";

  const total = asMoney(Math.max(0, Number(source.total ?? 0) || 0));
  const dueAmount = asMoney(Math.max(0, Number(source.dueAmount ?? total) || 0));
  const paidAmount = asMoney(Math.max(0, Number(source.paidAmount ?? 0) || 0));
  const createdAtMs = new Date(String(source.createdAt ?? Date.now())).getTime();
  const parsedCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  const updatedAtMs = new Date(
    String(
      source.updatedAt ?? source.updatedAtMs ?? source.updated ?? source.createdAt ?? Date.now()
    )
  ).getTime();
  const parsedUpdatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : parsedCreatedAtMs;

  const itemsRaw = Array.isArray(source.items) ? source.items : [];
  const items: IntegrationOrderItem[] = itemsRaw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      id: String(item.id ?? `oi_${index + 1}`).trim() || `oi_${index + 1}`,
      lineId: String(item.lineId ?? item.id ?? `line_${index + 1}`).trim() || `line_${index + 1}`,
      qty: Math.max(1, Math.trunc(Number(item.qty) || 1)),
      productId: String(item.productId ?? "").trim(),
      name: String(item.name ?? "").trim() || "Articolo",
      variant: String(item.variant ?? "").trim(),
      note: String(item.note ?? "").trim(),
      modifiers: asStringRecord(item.variants),
      unitPriceApplied: asMoney(
        Math.max(0, Number(item.unitPriceApplied ?? item.unitPrice ?? 0) || 0)
      ),
      listPriceAtTime: asMoney(
        Math.max(
          0,
          Number(item.listPriceAtTime ?? item.unitPriceApplied ?? item.unitPrice ?? 0) || 0
        )
      ),
      vatRate:
        Number.isFinite(Number(item.vatRate)) && Number(item.vatRate) >= 0
          ? Number(item.vatRate)
          : undefined,
      vatCode: String(item.vatCode ?? "").trim() || undefined,
      lineType: String(item.lineType ?? "").trim(),
      voidedAt: String(item.voidedAt ?? "").trim(),
      done: item.done === true,
    }));

  return {
    id,
    currentRevision: asOrderRevision(source.currentRevision ?? source.revision),
    roomId: String(source.roomId ?? "").trim(),
    tableId: String(source.tableId ?? "").trim(),
    tableNumber: Math.max(0, Math.trunc(Number(source.tableNumber ?? source.table ?? 0) || 0)),
    title: String(source.title ?? "").trim(),
    total,
    workflowStatus,
    paymentStatus,
    dueAmount,
    paidAmount,
    paidArticleUnits: asStringList(source.paidArticleUnits),
    orderNote: String(source.orderNote ?? source.note ?? "").trim(),
    orderComment: String(source.orderComment ?? source.communications ?? "").trim(),
    createdAtMs: parsedCreatedAtMs,
    updatedAtMs: parsedUpdatedAtMs,
    items,
  };
};
