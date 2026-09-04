import {
  buildFiscalReceiptPatchFromVerification,
  requestPosFiscalVerification,
} from "./fiscal-verification.js";

export function createPosFiscalIssueVerificationService(options = {}) {
  const {
    appendEvent,
    buildRetryResult,
    ensureFiscalTrackingArrays,
    errorMessage,
    fetchJson,
    linkReceipt,
    logger = console,
    nowIso = () => new Date().toISOString(),
    publishRefresh,
    readDb,
    retryDelayMs,
    updateReceipt,
    withDbMutation,
    writeFiscalDb,
  } = options;

  async function persist(job, verification, attempt, receiptSnapshot) {
    const retryResult =
      verification?.state === "PROCESSING" || verification?.retryable === true
        ? buildRetryResult(job, receiptSnapshot, attempt)
        : null;
    const patch = buildFiscalReceiptPatchFromVerification(verification, {
      nowIso,
    });
    if (!patch) return retryResult;
    if (retryResult?.retry) {
      patch.nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
      patch.requiresFiscalRetry = true;
    }

    const receipt = await withDbMutation(
      `fiscal_pos_verified_${job.paymentId}`,
      async () => {
        const db = await readDb();
        ensureFiscalTrackingArrays(db);
        const updatedReceipt = updateReceipt(db, job.paymentId, patch);
        const issued = verification.state === "ISSUED";
        if (issued) {
          linkReceipt(db, updatedReceipt, {
            paymentId: job.paymentId,
            paymentContainerId: job.paymentContainerId,
            issuedBy: job.issuedBy,
          });
        }
        appendEvent(db, {
          paymentId: job.paymentId,
          orderId: job.orderId,
          result: issued
            ? "issued_reconciled"
            : `verification_${String(
                verification.state ?? "unknown",
              ).toLowerCase()}`,
          message:
            verification.message ||
            (issued
              ? "Documento fiscale riconciliato con il gateway."
              : "Stato fiscale aggiornato dalla verifica autorevole."),
          requiresFiscalRetry: retryResult?.retry === true,
          payload: {
            verification: verification.raw ?? null,
            receiptId: updatedReceipt?.id ?? null,
          },
        });
        db.meta.lastWriteAt = nowIso();
        await writeFiscalDb(
          db,
          issued
            ? "payments.fiscalReceipt.verifiedIssued.appStateWrite"
            : "payments.fiscalReceipt.verificationState.appStateWrite",
        );
        publishRefresh(
          issued
            ? "pos_fiscal_receipt_issued"
            : "pos_fiscal_receipt_retry_pending",
          {
            paymentId: job.paymentId,
            receiptId: updatedReceipt?.id ?? "",
            reconciled: issued,
          },
        );
        return updatedReceipt;
      },
    );

    if (verification.state === "ISSUED") {
      return { issued: true, reconciled: true, receipt };
    }
    return { ...(retryResult ?? {}), verified: true, receipt };
  }

  async function verifyBeforeWrite({
    job,
    fiscalDevice,
    receipt,
    attempt,
  }) {
    let verification = null;
    try {
      verification = await requestPosFiscalVerification({
        fetchJson,
        fiscalDevice,
        operation: "issue",
        paymentId: job.paymentId,
        receiptId: receipt?.id,
        idempotencyKey: job.idempotencyKey,
        fiscalRequestId: receipt?.fiscalRequestId,
        payloadHash: receipt?.payloadHash,
      });
    } catch (error) {
      const fiscalError = errorMessage(error);
      logger.error?.(
        `[fiscal-pos] verifica autorevole fallita: paymentId=${job.paymentId} error=${fiscalError}`,
      );
      return {
        handled: true,
        result: await persist(
          job,
          {
            authoritative: true,
            operation: "issue",
            state: "FAILED",
            retryable: true,
            message: `Verifica gateway non disponibile: ${fiscalError}`,
            raw: null,
          },
          attempt,
          receipt,
        ),
      };
    }

    if (verification.supported === false) {
      const attemptCount = Math.max(
        0,
        Math.trunc(Number(receipt?.attemptCount) || 0),
      );
      if (attemptCount > 1) {
        return {
          handled: true,
          result: await persist(
            job,
            {
              authoritative: true,
              operation: "issue",
              state: "FAILED",
              retryable: true,
              message:
                "Endpoint di verifica fiscale non disponibile: retry sospeso per evitare una doppia emissione.",
              raw: null,
            },
            attempt,
            receipt,
          ),
        };
      }
      logger.warn?.(
        `[fiscal-pos] gateway legacy senza verifica: consentito solo primo invio paymentId=${job.paymentId}`,
      );
      return { handled: false, verification };
    }

    if (
      verification.state === "ISSUED" ||
      verification.state === "PROCESSING" ||
      !verification.canWrite
    ) {
      return {
        handled: true,
        result: await persist(job, verification, attempt, receipt),
      };
    }
    return { handled: false, verification };
  }

  return { verifyBeforeWrite };
}
