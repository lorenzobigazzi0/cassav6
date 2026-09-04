import { apiFetch } from "./baseUrl";
import {
  withRequiredTableLocks,
  type TableLockConflictDetail,
  type TableLockPurpose,
} from "./tableLocks";
import type {
  DiningTable,
  DiningTableOrder,
  DiningTableOrderLine,
  TablePaymentAdminAdjustment,
  TablePaymentAdminLineAdjustment,
  TableSessionRequest,
} from "./tables";

export const ORDER_SERVICE_CORRECTION_LOCK_PURPOSE = "order.correction";
export const ORDER_SERVICE_CANCEL_LOCK_PURPOSE = "order.cancel";
export const ORDER_SERVICE_REPLACEMENT_LOCK_PURPOSE = "order.comp";

export type OrderServiceRecoveryContext = {
  order: DiningTableOrder;
  table: DiningTable;
  session: TableSessionRequest;
};

export type OrderCorrectionLineDraft = {
  lineKey: string;
  lineId?: string;
  productId?: string;
  productName: string;
  originalQuantity: number;
  nextQuantity: number;
  originalNotes: string;
  nextNotes: string;
  originalVariant: string;
  nextVariant: string;
  originalModifiers: Record<string, string>;
  nextModifiers: Record<string, string>;
  unitPrice: number;
  nextUnitPrice: number;
};

export type OrderCorrectionAddDraft = {
  rowKey: string;
  productId?: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  note: string;
};

export type OrderCorrectionPayload = {
  lineDrafts: OrderCorrectionLineDraft[];
  addedItems: OrderCorrectionAddDraft[];
  orderNote: string;
  orderComment: string;
  reason: string;
};

export type OrderReplacementSelection = {
  lineKey: string;
  lineId?: string;
  productId?: string;
  productName: string;
  quantity: number;
};

export type OrderReplacementPayload = {
  selections: OrderReplacementSelection[];
  reason: string;
  sendReplacement: boolean;
};

const CLIENT_APP = "mobile-frontend";

function normalize(value: unknown) {
  return String(value == null ? "" : value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function slugify(value: string, fallback: string) {
  const slug = normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function clampQuantity(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function money(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : 0;
}

function cleanStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [normalize(key), normalize(entry)])
      .filter(([key, entry]) => Boolean(key && entry))
  );
}

function authHeaders(session: TableSessionRequest): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Client-App": CLIENT_APP,
  };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (session.userId) headers["X-User-Id"] = session.userId;
  if (session.username) headers["X-Username"] = session.username;
  if (session.deviceUuid) headers["X-Device-Uuid"] = session.deviceUuid;
  return headers;
}

function idempotencyKey(prefix: string, orderId: string) {
  return [
    prefix,
    normalize(orderId).replace(/[^a-z0-9_-]+/gi, "_"),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join("_");
}

function tableIdFor(context: OrderServiceRecoveryContext) {
  return context.table.mobileActiveTableId || context.table.id;
}

function tableLabelFor(context: OrderServiceRecoveryContext) {
  return (
    normalize(context.table.tableLabel) ||
    normalize(context.table.logicalTableLabel) ||
    normalize(context.table.mobileComplexLabel) ||
    `Tavolo ${context.table.number}`
  );
}

function basePayload(context: OrderServiceRecoveryContext) {
  const tableId = tableIdFor(context);
  return {
    token: context.session.token,
    userId: context.session.userId,
    username: context.session.username,
    fullName: context.session.fullName,
    deviceUuid: context.session.deviceUuid,
    roomId: context.session.roomId,
    orderId: context.order.id,
    tableId,
    tableLabel: tableLabelFor(context),
    logicalTableId: context.table.logicalTableId,
    logicalTableLabel: context.table.logicalTableLabel,
    clientApp: CLIENT_APP,
  };
}

export function expectedOrderRevisionForServiceRecovery(order: DiningTableOrder) {
  const source = order as DiningTableOrder & { revision?: unknown };
  return clampQuantity(
    source.currentRevision ?? source.revision,
    1,
    1_000_000,
    1
  );
}

async function postJson(
  session: TableSessionRequest,
  path: string,
  payload: Record<string, unknown>
) {
  const response = await apiFetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(session),
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || (isRecord(body) && body.ok === false)) {
    const message = isRecord(body) ? normalize(body.error || body.message || body.code) : "";
    throw new Error(message || "Recupero comanda non riuscito.");
  }
  return body;
}

function hasLineChange(line: OrderCorrectionLineDraft) {
  return (
    line.nextQuantity !== line.originalQuantity ||
    normalize(line.nextNotes) !== normalize(line.originalNotes) ||
    normalize(line.nextVariant) !== normalize(line.originalVariant) ||
    money(line.nextUnitPrice) !== money(line.unitPrice) ||
    JSON.stringify(cleanStringRecord(line.nextModifiers)) !==
      JSON.stringify(cleanStringRecord(line.originalModifiers))
  );
}

function correctionDiff(payload: OrderCorrectionPayload, order: DiningTableOrder) {
  const addedItems: unknown[] = payload.addedItems
    .map((item) => {
      const productName = normalize(item.productName);
      if (!productName) return null;
      return {
        productId: normalize(item.productId) || slugify(productName, "product"),
        productName,
        quantity: clampQuantity(item.quantity, 1, 99, 1),
        unitPrice: money(item.unitPrice),
        note: normalize(item.note),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const removedItems: unknown[] = [];
  const changedItems: unknown[] = [];

  payload.lineDrafts.forEach((line) => {
    if (!hasLineChange(line)) return;
    const lineId = normalize(line.lineId || line.lineKey);
    const productName = normalize(line.productName) || "Articolo";
    const productId = normalize(line.productId) || slugify(productName, "product");
    if (line.nextQuantity <= 0) {
      removedItems.push({
        lineId,
        quantity: line.originalQuantity,
        productId,
        productName,
      });
      return;
    }
    changedItems.push({
      lineId,
      nextQuantity: line.nextQuantity,
      productId,
      productName,
      nextNotes: normalize(line.nextNotes),
      nextVariant: normalize(line.nextVariant),
      nextModifiers: cleanStringRecord(line.nextModifiers),
      nextUnitPrice: money(line.nextUnitPrice),
    });
  });

  const orderUpdates: Record<string, string> = {};
  const nextNote = normalize(payload.orderNote);
  const nextComment = normalize(payload.orderComment);
  if (nextNote !== normalize(order.orderNote)) orderUpdates.note = nextNote;
  if (nextComment !== normalize(order.orderComment)) orderUpdates.communications = nextComment;

  return {
    addedItems,
    removedItems,
    changedItems,
    orderUpdates,
    reason: normalize(payload.reason),
  };
}

export function lineKeyForOrderService(line: DiningTableOrderLine, index: number) {
  const lineId = normalize(line.lineId);
  if (lineId) return lineId;
  const productPart = normalize(line.productId) || slugify(line.name, "line");
  const variantPart = slugify(normalize(line.variantName), "plain");
  const notePart = slugify(normalize(line.note), "no_note");
  return `${productPart}_${variantPart}_${notePart}_${index}`;
}

export function defaultOrderCorrectionDrafts(order: DiningTableOrder): OrderCorrectionLineDraft[] {
  return order.lines.map((line, index) => {
    const quantity = clampQuantity(line.qty, 0, 99, 1);
    const variant = normalize(line.variantName);
    return {
      lineKey: lineKeyForOrderService(line, index),
      lineId: line.lineId,
      productId: line.productId,
      productName: normalize(line.name) || "Articolo",
      originalQuantity: quantity,
      nextQuantity: quantity,
      originalNotes: normalize(line.note),
      nextNotes: normalize(line.note),
      originalVariant: variant,
      nextVariant: variant,
      originalModifiers: cleanStringRecord(line.modifiers),
      nextModifiers: cleanStringRecord(line.modifiers),
      unitPrice: money(line.unitFinalPrice ?? line.unitBasePrice),
      nextUnitPrice: money(line.unitFinalPrice ?? line.unitBasePrice),
    };
  });
}

export function hasOrderCorrectionChanges(
  payload: OrderCorrectionPayload,
  order: DiningTableOrder
) {
  const diff = correctionDiff(payload, order);
  return Boolean(
    diff.addedItems.length ||
    diff.removedItems.length ||
    diff.changedItems.length ||
    Object.keys(diff.orderUpdates).length
  );
}

async function withRecoveryLock<T>(
  context: OrderServiceRecoveryContext,
  purpose: TableLockPurpose,
  operation: () => Promise<T>,
  onConflict?: (detail: TableLockConflictDetail) => void
) {
  return withRequiredTableLocks(context.session, [tableIdFor(context)], purpose, operation, {
    skipIfAlreadyHeld: true,
    onConflict,
  });
}

export async function submitOrderCorrection(
  context: OrderServiceRecoveryContext,
  payload: OrderCorrectionPayload,
  onConflict?: (detail: TableLockConflictDetail) => void
) {
  const diff = correctionDiff(payload, context.order);
  if (!hasOrderCorrectionChanges(payload, context.order)) {
    throw new Error("Nessuna modifica da applicare.");
  }
  return withRecoveryLock(
    context,
    ORDER_SERVICE_CORRECTION_LOCK_PURPOSE,
    () =>
      postJson(context.session, "/api/integration/orders/correct", {
        ...basePayload(context),
        expectedRevision: expectedOrderRevisionForServiceRecovery(context.order),
        addedItems: diff.addedItems,
        removedItems: diff.removedItems,
        changedItems: diff.changedItems,
        orderUpdates: diff.orderUpdates,
        reason: diff.reason,
        requestCashApproval: context.order.workflowStatus === "prep",
        idempotencyKey: idempotencyKey("correction", context.order.id),
      }),
    onConflict
  );
}

export async function persistTablePaymentAdjustment({
  table,
  session,
  targetOrderId,
  adjustment,
}: {
  table: DiningTable;
  session: TableSessionRequest;
  targetOrderId?: string;
  adjustment: TablePaymentAdminAdjustment;
}) {
  const lineAdjustments = (adjustment.lineAdjustments ?? []) as TablePaymentAdminLineAdjustment[];
  if (lineAdjustments.length === 0) {
    throw new Error("Ripartizione articoli mancante.");
  }
  const originalCents = lineAdjustments.reduce(
    (sum, entry) => sum + Math.round(money(entry.originalAmount) * 100),
    0
  );
  const adjustedCents = lineAdjustments.reduce(
    (sum, entry) => sum + Math.round(money(entry.adjustedAmount) * 100),
    0
  );
  const expectedDifferenceCents = Math.round(Number(adjustment.differenceAmount ?? 0) * 100);
  if (adjustedCents - originalCents !== expectedDifferenceCents) {
    throw new Error("La somma delle righe rettificate non coincide con il nuovo totale.");
  }
  const targetOrderIds = new Set(
    lineAdjustments.map((entry) => normalize(entry.orderId)).filter(Boolean)
  );
  const orders = table.orderHistory.filter(
    (order) => targetOrderIds.has(order.id) && (!targetOrderId || order.id === targetOrderId)
  );
  if (orders.length !== targetOrderIds.size) {
    throw new Error("Una o piu comande da rettificare non sono aggiornate.");
  }
  if (orders.length === 0) throw new Error("Nessuna comanda da rettificare.");

  const firstContext: OrderServiceRecoveryContext = { order: orders[0], table, session };
  return withRecoveryLock(firstContext, ORDER_SERVICE_CORRECTION_LOCK_PURPOSE, async () => {
    const results: unknown[] = [];
    for (const order of orders) {
      const orderAdjustments = lineAdjustments.filter((entry) => entry.orderId === order.id);
      const byLineId = new Map<string, TablePaymentAdminLineAdjustment[]>();
      orderAdjustments.forEach((entry) => {
        const lineId = normalize(entry.lineId);
        if (!lineId) throw new Error("Identificativo riga rettifica mancante.");
        const current = byLineId.get(lineId) ?? [];
        current.push(entry);
        byLineId.set(lineId, current);
      });
      const changedItems = [...byLineId.entries()].flatMap(([lineId, entries]) => {
        const matchingLines = order.lines.filter(
          (line, lineIndex) =>
            normalize(line.lineId || lineKeyForOrderService(line, lineIndex)) === lineId
        );
        if (matchingLines.length === 0) {
          throw new Error(`Riga ${lineId} non trovata nella comanda aggiornata.`);
        }
        const indexedPrices = new Map<number, number>();
        let fallbackUnitIndex = 0;
        matchingLines.forEach((line) => {
          const quantity = clampQuantity(line.qty, 1, 999, 1);
          const currentUnitPrice = money(line.unitFinalPrice ?? line.unitBasePrice);
          for (let localIndex = 0; localIndex < quantity; localIndex += 1) {
            const stableId = normalize(line.articleUnitIds?.[localIndex]);
            const stableMatch = /_(\d+)_(\d+)$/.exec(stableId);
            const unitIndex = stableMatch ? Number(stableMatch[2]) : fallbackUnitIndex;
            if (!Number.isInteger(unitIndex) || unitIndex < 0 || indexedPrices.has(unitIndex)) {
              throw new Error(`Identificativo unita non valido per la riga ${line.name}.`);
            }
            indexedPrices.set(unitIndex, currentUnitPrice);
            fallbackUnitIndex += 1;
          }
        });
        const quantity = Math.max(...indexedPrices.keys()) + 1;
        const nextUnitPrices = Array.from({ length: quantity }, (_, unitIndex) => {
          const price = indexedPrices.get(unitIndex);
          if (price === undefined) {
            throw new Error(`Sequenza unita incompleta per la riga ${lineId}.`);
          }
          return price;
        });
        entries.forEach((entry) => {
          const unitIndex = Math.trunc(Number(entry.unitIndex));
          if (!Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex >= quantity) {
            throw new Error(`Unita non valida per la riga ${matchingLines[0].name}.`);
          }
          nextUnitPrices[unitIndex] = money(entry.adjustedAmount);
        });
        const hasPriceChange = entries.some(
          (entry) =>
            Math.round(money(entry.originalAmount) * 100) !==
            Math.round(money(entry.adjustedAmount) * 100)
        );
        if (!hasPriceChange) return [];
        const sample = matchingLines[0];
        return [
          {
            lineId,
            productId: normalize(sample.productId),
            productName: normalize(sample.name) || "Articolo",
            nextQuantity: quantity,
            nextNotes: normalize(sample.note),
            nextVariant: normalize(sample.variantName),
            nextModifiers: cleanStringRecord(sample.modifiers),
            nextUnitPrice: nextUnitPrices[0],
            nextUnitPrices,
          },
        ];
      });
      if (changedItems.length === 0) continue;
      const context: OrderServiceRecoveryContext = { order, table, session };
      results.push(
        await postJson(session, "/api/integration/orders/correct", {
          ...basePayload(context),
          expectedRevision: expectedOrderRevisionForServiceRecovery(order),
          addedItems: [],
          removedItems: [],
          changedItems,
          orderUpdates: {},
          reason: normalize(adjustment.reason) || "Rettifica pagamento admin",
          recoveryMode: "payment_adjustment",
          paymentAdjustment: {
            type: adjustment.type,
            originalAmount: adjustment.originalAmount,
            adjustedAmount: adjustment.adjustedAmount,
            differenceAmount: adjustment.differenceAmount,
          },
          idempotencyKey: idempotencyKey("payment_adjustment", order.id),
        })
      );
    }
    if (results.length === 0) throw new Error("Nessuna modifica da applicare.");
    return { ok: true, results };
  });
}

export async function cancelOrder(
  context: OrderServiceRecoveryContext,
  reason: string,
  onConflict?: (detail: TableLockConflictDetail) => void
) {
  const safeReason = normalize(reason) || "Annullata da operatore mobile";
  return withRecoveryLock(
    context,
    ORDER_SERVICE_CANCEL_LOCK_PURPOSE,
    () =>
      postJson(context.session, "/api/integration/orders/cancel", {
        ...basePayload(context),
        expectedRevision: expectedOrderRevisionForServiceRecovery(context.order),
        reason: safeReason,
        idempotencyKey: idempotencyKey("cancel", context.order.id),
      }),
    onConflict
  );
}

export async function submitOrderReplacement(
  context: OrderServiceRecoveryContext,
  payload: OrderReplacementPayload,
  onConflict?: (detail: TableLockConflictDetail) => void
) {
  const safeReason = normalize(payload.reason);
  if (safeReason.length < 3) {
    throw new Error("Inserisci il motivo del reso.");
  }
  const selections = payload.selections.filter((entry) => entry.quantity > 0);
  if (selections.length === 0) {
    throw new Error("Seleziona almeno un articolo da rendere.");
  }

  const orderAlreadyPaid =
    context.order.paymentStatus === "paid" ||
    (typeof context.order.dueAmount === "number" &&
      context.order.dueAmount <= 0.009 &&
      typeof context.order.paidAmount === "number" &&
      context.order.paidAmount > 0.009);

  if (!payload.sendReplacement && !orderAlreadyPaid) {
    const removedItems = selections
      .map((selection) => {
        const productName = normalize(selection.productName) || "Articolo";
        const lineId = normalize(selection.lineId || selection.lineKey);
        if (!lineId) return null;
        return {
          lineId,
          productId: normalize(selection.productId) || slugify(productName, "product"),
          productName,
          quantity: clampQuantity(selection.quantity, 1, 99, 1),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (removedItems.length === 0) {
      throw new Error("Articolo da rendere non riconosciuto.");
    }

    return withRecoveryLock(
      context,
      ORDER_SERVICE_CORRECTION_LOCK_PURPOSE,
      () =>
        postJson(context.session, "/api/integration/orders/correct", {
          ...basePayload(context),
          expectedRevision: expectedOrderRevisionForServiceRecovery(context.order),
          addedItems: [],
          removedItems,
          changedItems: [],
          orderUpdates: {},
          reason: safeReason,
          preserveRemovedItems: true,
          recoveryMode: "return_without_replacement",
          requestCashApproval: context.order.workflowStatus === "prep",
          idempotencyKey: idempotencyKey("return_without_replacement", context.order.id),
        }),
      onConflict
    );
  }

  const endpoint = payload.sendReplacement
    ? "/api/integration/orders/comp"
    : "/api/integration/orders/storno";
  return withRecoveryLock(
    context,
    ORDER_SERVICE_REPLACEMENT_LOCK_PURPOSE,
    async () => {
      const results: unknown[] = [];
      for (const selection of selections) {
        const productName = normalize(selection.productName) || "Articolo";
        const originalLineId = normalize(selection.lineId || selection.lineKey);
        const result = await postJson(context.session, endpoint, {
          ...basePayload(context),
          productId: normalize(selection.productId) || slugify(productName, "product"),
          productName,
          originalLineId,
          quantity: clampQuantity(selection.quantity, 1, 99, 1),
          reason: safeReason,
          sendReplacement: payload.sendReplacement,
          operationType: payload.sendReplacement ? "zero_cost_replacement" : "storno",
          refundMode: payload.sendReplacement ? "zero_cost_replacement" : "financial_storno",
          idempotencyKey: idempotencyKey(
            `${payload.sendReplacement ? "comp_replacement" : "storno"}_${originalLineId}`,
            context.order.id
          ),
        });
        results.push(result);
      }
      return {
        ok: true,
        results,
      };
    },
    onConflict
  );
}
