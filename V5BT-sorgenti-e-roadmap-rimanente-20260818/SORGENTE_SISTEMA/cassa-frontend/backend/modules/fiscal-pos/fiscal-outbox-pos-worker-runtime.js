import { buildPosFiscalJobFromFiscalOutboxEntry, mapPosFiscalReceiptToOutboxWorkerResult } from "./fiscal-outbox-pos-job.js";
import { createFiscalOutboxWorker } from "./fiscal-outbox-worker.js";

function normalizePositiveInt(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function createFiscalOutboxPosWorkerRuntime(options = {}) {
  const enabled = options.enabled === true;
  const logger = options.logger ?? console;
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  const provider = String(options.provider ?? "pos-fiscal-api").trim() || "pos-fiscal-api";
  const intervalMs = normalizePositiveInt(options.intervalMs, 1_000, { min: 250 });
  const batchSize = normalizePositiveInt(options.batchSize, 5, { min: 1, max: 50 });
  const leaseMs = normalizePositiveInt(options.leaseMs, 30_000, { min: 5_000 });
  const retryDelayMs = normalizePositiveInt(options.retryDelayMs, 30_000, { min: 0 });
  const maxAttempts = normalizePositiveInt(options.maxAttempts, 6, { min: 1, max: 100 });
  let timer = null;
  let running = false;

  async function repository() {
    await options.relationalRuntime?.initialize?.();
    if (!options.relationalRuntime?.db) {
      throw new Error("DB relazionale non disponibile per fiscal_outbox worker.");
    }
    return new options.FiscalOutboxRepository(options.relationalRuntime.db, { nowIso });
  }

  function fiscalReceiptPatch(receipt, workerResult) {
    const fiscalStatus = String(
      receipt?.fiscalStatus ?? receipt?.status ?? workerResult?.status ?? "",
    ).trim().toUpperCase();
    const isIssued = fiscalStatus === "ISSUED" || workerResult?.status === "issued";
    const fiscalDocumentNumber =
      String(
        receipt?.fiscalDocumentNumber ??
          receipt?.fiscalProviderRef ??
          receipt?.fiscalMovementId ??
          "",
      ).trim() || null;
    return {
      fiscalProvider: receipt?.fiscalProvider ?? provider,
      fiscalStatus:
        fiscalStatus ||
        (workerResult?.status === "manual_required"
          ? "MANUAL_REQUIRED"
          : workerResult?.status === "retrying"
            ? "FAILED"
            : "FAILED"),
      fiscalDocumentNumber,
      issuedAt: isIssued ? String(receipt?.issuedAt ?? receipt?.createdAt ?? nowIso()) : undefined,
      payloadJson:
        receipt?.payloadSnapshot && typeof receipt.payloadSnapshot === "object"
          ? receipt.payloadSnapshot
          : workerResult?.payload ?? {},
      rawJson:
        receipt && typeof receipt === "object"
          ? receipt
          : {
              fiscalStatus: workerResult?.status ?? "unknown",
              fiscalError: workerResult?.errorMessage ?? null,
            },
    };
  }

  async function syncReceipt(entry, workerResult, receipt) {
    const receiptId = String(
      entry?.aggregateId ??
        entry?.payload?.receiptId ??
        workerResult?.payload?.receipt?.id ??
        "",
    ).trim();
    if (!receiptId) return null;
    await options.relationalRuntime?.initialize?.();
    if (!options.relationalRuntime?.db) return null;
    const paymentsRepo = new options.PaymentsRelationalRepository(options.relationalRuntime.db);
    return paymentsRepo.updateFiscalReceipt(receiptId, fiscalReceiptPatch(receipt, workerResult));
  }

  async function processClaim(entry) {
    const built = buildPosFiscalJobFromFiscalOutboxEntry(entry);
    if (!built.ok) {
      const result = {
        status: "manual_required",
        errorCode: built.errorCode,
        errorMessage: built.errorMessage,
        payload: {
          ...entry.payload,
          worker: {
            provider,
            unsupported: true,
            reason: built.reason,
            updatedAt: nowIso(),
          },
        },
      };
      await syncReceipt(entry, result, null);
      return result;
    }

    const issueResult = await options.issueQueuedPosFiscalReceipt(built.job);
    const db = await options.readDb();
    options.ensureFiscalTrackingArrays(db);
    // L'emissione avviene nello stesso owner, ma readDb puo' reidratare subito
    // dopo da un mirror app-state ancora PENDING. Il risultato dell'emissione e'
    // quindi la fonte piu' recente per questo claim.
    const receipt = issueResult?.receipt ??
      options.findPosFiscalReceiptByPaymentId(db, built.job.paymentId);
    const workerResult = mapPosFiscalReceiptToOutboxWorkerResult({
      entry,
      job: built.job,
      issueResult,
      receipt,
    });
    await syncReceipt(entry, workerResult, receipt);
    return workerResult;
  }

  async function runBatch(reason = "scheduled") {
    if (!enabled || running) return { processed: 0, skipped: true };
    running = true;
    try {
      const worker = createFiscalOutboxWorker({
        repository: await repository(),
        workerId: "backend-owner-fiscal-outbox",
        leaseMs,
        retryDelayMs,
        maxAttempts,
        nowIso,
        processClaim,
      });
      const summary = await worker.runBatch({ limit: batchSize });
      if (summary.processed > 0) {
        logger.info?.(`[fiscal-outbox] worker ${reason}: processati=${summary.processed}`);
      }
      return summary;
    } catch (error) {
      logger.error?.(
        `[fiscal-outbox] worker ${reason} fallito: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { processed: 0, error };
    } finally {
      running = false;
    }
  }

  async function reclaimStartup() {
    if (!enabled) return 0;
    try {
      const reclaimed = (await repository()).reclaimAllProcessing(nowIso());
      if (reclaimed > 0) {
        logger.info?.(`[fiscal-outbox] reclaim job processing all'avvio: ${reclaimed}`);
      }
      return reclaimed;
    } catch (error) {
      logger.error?.(
        `[fiscal-outbox] reclaim all'avvio fallito: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  function start() {
    if (!enabled || timer) return false;
    timer = setInterval(() => {
      void runBatch("scheduled");
    }, intervalMs);
    timer.unref?.();
    void reclaimStartup().finally(() => {
      void runBatch("startup");
    });
    logger.info?.(`[fiscal-outbox] worker abilitato: interval=${intervalMs}ms batch=${batchSize}`);
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return {
    enabled,
    processClaim,
    runBatch,
    start,
    stop,
  };
}
