import type { DiningTable, DiningTableOrder, DiningTableOrderLine } from "../../../../api/tables";
import type { TableOrderSubmitPayload } from "../components/TableOrderComposer";

export const COUNTER_TABLE_ID = "counter:banco";
export const COUNTER_TABLE_LABEL = "Banco";

const money = (value: number) => Math.max(0, Math.round(value * 100) / 100);

export function createCounterOrderFromSubmit(
  payload: TableOrderSubmitPayload,
  now = Date.now()
): DiningTableOrder {
  const orderId = `co_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const lines: DiningTableOrderLine[] = payload.lines.map((line, index) => ({
    ...line,
    lineId: line.lineId ?? `${orderId}_line_${index + 1}`,
  }));
  return {
    id: orderId,
    title: payload.title || `Banco ${lines.length} articoli`,
    createdAt: now,
    total: money(payload.total),
    state: "served",
    workflowStatus: "delivered",
    paymentStatus: "unpaid",
    dueAmount: money(payload.total),
    paidAmount: 0,
    orderNote: payload.orderNote,
    orderComment: payload.orderComment,
    paidArticleUnits: [],
    lines,
  };
}

export function createCounterVirtualTable(order: DiningTableOrder | null, amountDue?: number): DiningTable {
  const due = money(amountDue ?? order?.dueAmount ?? order?.total ?? 0);
  return {
    id: COUNTER_TABLE_ID,
    number: 0,
    tableName: COUNTER_TABLE_LABEL,
    tableLabel: COUNTER_TABLE_LABEL,
    customerPhone: "",
    covers: 1,
    occupancyState: "seated",
    reservationAt: null,
    seatedAt: order?.createdAt ?? Date.now(),
    ordersTaken: order ? 1 : 0,
    ordersInProgress: 0,
    amountDue: due,
    note: "",
    allergens: [],
    manualIntolerance: "",
    orderHistory: order ? [{ ...order, total: money(order.total), dueAmount: due }] : [],
    logicalTableId: COUNTER_TABLE_ID,
    logicalTableLabel: COUNTER_TABLE_LABEL,
    mobileActiveTableId: COUNTER_TABLE_ID,
  };
}

export const isCounterTable = (tableId?: string | null) => tableId === COUNTER_TABLE_ID;
