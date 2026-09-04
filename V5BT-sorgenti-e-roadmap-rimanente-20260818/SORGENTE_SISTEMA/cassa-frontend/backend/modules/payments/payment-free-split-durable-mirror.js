import {
  FiscalOutboxRepository,
  OrdersRelationalRepository,
  PaymentMirrorOutboxRepository,
  PaymentsRelationalRepository,
  TablesBillsRelationalRepository,
} from "../../db/relational/index.js";
import { applyPaymentFreeSplitMirrorPayload } from "./payment-free-split-mirror-payload.js";
import {
  buildPaymentFreeSplitStatelessMirror,
  canUsePaymentFreeSplitStatelessMirror,
} from "./payment-free-split-stateless-mirror.js";
import { createPaymentMirrorWorkerRuntime } from "./payment-mirror-worker.js";

const TERMINAL_FISCAL_STATUSES = new Set([
  "ISSUED",
  "FAILED",
  "MANUAL_REQUIRED",
  "CANCELLED",
  "VOIDED",
]);

export function enqueuePaymentFreeSplitMirror(connection, options = {}) {
  const payload = options.mirrorPayload;
  if (options.enabled !== true || payload?.kind !== "payment.free_split") return null;
  const paymentId = String(options.paymentContainer?.id ?? payload.aggregateId ?? "").trim();
  return new PaymentMirrorOutboxRepository(connection, { nowIso: options.nowIso }).enqueue({
    mirrorId: `payment-free-split:${paymentId}`,
    mirrorKind: "payment.free_split",
    aggregateId: paymentId,
    idempotencyKey: options.idempotencyKey,
    payloadVersion: payload.version,
    payload,
    createdAt: options.occurredAt,
  });
}

export function createPaymentFreeSplitDurableMirrorRuntime(options = {}) {
  function incompleteSnapshotError(code, message, missingCount, metricName) {
    options.runtimeMetrics?.incrementCounter?.(metricName, missingCount);
    const error = new Error(`${message}: mancanti=${missingCount}.`);
    error.code = code;
    error.retryable = true;
    return error;
  }

  function latestOrders(payload, relationalDb) {
    const ordersRepo = new OrdersRelationalRepository(relationalDb);
    const orderIds = [
      ...new Set(
        (Array.isArray(payload.orderIds) ? payload.orderIds : [])
          .map((orderId) => String(orderId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const orders = orderIds.map((orderId) => ordersRepo.getOrderById(orderId));
    const missingCount = orders.filter((order) => !order).length;
    if (missingCount > 0) {
      throw incompleteSnapshotError(
        "PAYMENT_MIRROR_RELATIONAL_ORDER_SNAPSHOT_INCOMPLETE",
        "Snapshot relazionale ordini incompleto per payment mirror",
        missingCount,
        "paymentMirrorRelationalOrderSnapshotMisses",
      );
    }
    return orders;
  }

  function payloadCollectionEntries(payload, collection) {
    return (Array.isArray(payload?.collections?.[collection])
      ? payload.collections[collection]
      : []
    ).filter(
      (entry) =>
        String(entry?.id ?? "").trim() &&
        entry?.value &&
        typeof entry.value === "object",
    );
  }

  function fiscalStatusFromOutbox(status) {
    return String(status ?? "")
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toUpperCase();
  }

  function latestFiscalStatus(receipt, outbox) {
    const receiptStatus = fiscalStatusFromOutbox(
      receipt?.fiscalStatus ?? receipt?.status,
    );
    const outboxStatus = fiscalStatusFromOutbox(outbox?.status);
    const receiptWins =
      TERMINAL_FISCAL_STATUSES.has(receiptStatus) &&
      !TERMINAL_FISCAL_STATUSES.has(outboxStatus);
    if (receiptWins) {
      options.runtimeMetrics?.incrementCounter?.(
        "paymentMirrorFiscalReceiptTerminalPrecedence",
      );
    }
    return {
      status: receiptWins ? receiptStatus : outboxStatus || receiptStatus,
      receiptWins,
    };
  }

  function latestMutableCollections(payload, relationalDb) {
    const paymentsRepo = new PaymentsRelationalRepository(relationalDb);
    const fiscalOutboxRepo = new FiscalOutboxRepository(relationalDb, {
      nowIso: options.nowIso,
    });
    const result = {};
    const fiscalEntries = payloadCollectionEntries(payload, "fiscalReceipts");
    if (fiscalEntries.length > 0) {
      const fiscalSnapshots = fiscalEntries.map((entry) => {
        const id = String(entry.id).trim();
        const receipt = paymentsRepo.getFiscalReceiptById(id);
        if (!receipt) return null;
        const outbox = fiscalOutboxRepo.getByAggregate("fiscal_receipt", id);
        const attemptCount = Math.max(
          0,
          Math.trunc(Number(receipt.attemptCount) || 0),
          Math.trunc(Number(outbox?.attemptCount) || 0),
        );
        const latestStatus = latestFiscalStatus(receipt, outbox);
        return {
          ...entry.value,
          ...receipt,
          ...(latestStatus.status
            ? { status: latestStatus.status, fiscalStatus: latestStatus.status }
            : {}),
          attemptCount,
          updatedAt: latestStatus.receiptWins
            ? receipt.updatedAt ?? outbox?.updatedAt ?? entry.value?.updatedAt
            : outbox?.updatedAt ?? receipt.updatedAt ?? entry.value?.updatedAt,
          issuedAt: latestStatus.receiptWins
            ? receipt.issuedAt ?? outbox?.issuedAt ?? entry.value?.issuedAt
            : outbox?.issuedAt ?? receipt.issuedAt ?? entry.value?.issuedAt,
        };
      });
      const missingCount = fiscalSnapshots.filter((entry) => !entry).length;
      if (missingCount > 0) {
        throw incompleteSnapshotError(
          "PAYMENT_MIRROR_RELATIONAL_FISCAL_SNAPSHOT_INCOMPLETE",
          "Snapshot relazionale fiscale incompleto per payment mirror",
          missingCount,
          "paymentMirrorRelationalRecordSnapshotMisses",
        );
      }
      result.fiscalReceipts = fiscalSnapshots;
    }
    return result;
  }

  async function processStateless(payload, relationalDb) {
    const authoritativeOrders = latestOrders(payload, relationalDb);
    const latestCollections = latestMutableCollections(payload, relationalDb);
    const mirror = buildPaymentFreeSplitStatelessMirror(payload, {
      latestOrders: authoritativeOrders,
      latestCollections,
    });
    await options.writePaymentFreeSplitDb(mirror.appState, mirror.mirrorOptions);
  }

  async function processLegacy(payload, relationalDb) {
    const tablesRepo = new TablesBillsRelationalRepository(relationalDb);
    const authoritativeOrders = latestOrders(payload, relationalDb);
    const latestCollections = latestMutableCollections(payload, relationalDb);
    const latestTables = (Array.isArray(payload.tableIds) ? payload.tableIds : [])
      .map((tableId) => {
        const table = tablesRepo.getTableState(tableId);
        return table ? { ...table, pendingBills: tablesRepo.listBillsByTable(tableId) } : null;
      })
      .filter(Boolean);
    const db = await options.readDb({ preferCache: true });
    const applied = applyPaymentFreeSplitMirrorPayload(db, payload, {
      latestOrders: authoritativeOrders,
      latestTables,
      latestCollections,
    });
    await options.writePaymentFreeSplitDb(applied.appState, {
      ...applied.mirrorOptions,
      skipPosSettingsTables: options.skipPosSettingsTables === true,
      namedLockPriority: "background",
    });
  }

  async function processClaim(entry) {
    if (entry?.mirrorKind !== "payment.free_split") {
      throw new Error(`Tipo mirror pagamento non supportato: ${entry?.mirrorKind ?? "missing"}.`);
    }
    await options.relationalRuntime?.initialize?.();
    const relationalDb = options.relationalRuntime?.db;
    if (!relationalDb) throw new Error("DB relazionale non disponibile per payment mirror.");
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    if (options.stateless === true && canUsePaymentFreeSplitStatelessMirror(payload)) {
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorStatelessClaims");
      await processStateless(payload, relationalDb);
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorStatelessWrites");
      return;
    }
    if (options.stateless === true) {
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorStatelessFallbacks");
    }
    options.runtimeMetrics?.incrementCounter?.("paymentMirrorLegacyClaims");
    const action = () => processLegacy(payload, relationalDb);
    if (typeof options.withPaymentLaneMutation !== "function") return action();
    return options.withPaymentLaneMutation(
      "payment.freeSplit durable mirror legacy",
      payload?.tableIds?.[0] ?? entry?.aggregateId,
      action,
      {
        namedLockPriority: "background",
        shouldPreserveHotCaches: () => true,
      },
    );
  }

  return createPaymentMirrorWorkerRuntime({
    ...options,
    PaymentMirrorOutboxRepository,
    processClaim,
    workerId: options.workerId ?? `backend-owner-payment-mirror:${process.pid}`,
  });
}
