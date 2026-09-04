/**
 * Modello di `fiscal.command` (P2b, dominio `fiscal`).
 *
 * Possiede l'unico accesso all'app-state della route: il handler resta a
 * leggere il corpo e a inviare la risposta, che e sempre 200.
 *
 * Fra le dipendenze c'e `writePaymentDb`, che **scrive**. Non e `writeDb`,
 * quindi il conteggio di P2b non la vedeva; l'owner della scrittura e
 * comunque questo modello e non il handler.
 *
 * Il ramo della modalita demo e conservato intero: non invia il comando al
 * provider ma registra ugualmente l'evento fiscale e l'audit, ed e quello che
 * rende ispezionabile una sessione dimostrativa.
 */
export function createFiscalModel({
  appendAuditEvent,
  buildAuditActor,
  collectNonFiscalizedFiscalReceiptsForReport,
  ensureRelationalFiscalCommandWritePrimary = null,
  executeFiscalProvider,
  hasPermission,
  HttpError,
  isAdminUser,
  isPosDemoModeEnabled,
  nowIso,
  randomUUID,
  readDb,
  recordRelationalFiscalCommandResult = null,
  relationalFiscalCommandWritePrimary = false,
  sanitizePosSettings,
  validateSessionContext,
  writePaymentDb,
}) {
  const FISCAL_COMMAND_WRITE_SPLIT_DOMAINS = ["fiscalEvents", "auditEvents"];
  async function runFiscalCommand(payload) {
    const command =
      typeof payload.command === "string" ? payload.command.trim() : "";
    if (!command) {
      throw new HttpError(400, "Comando fiscale non valido.");
    }

    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
    });
    if (isPosDemoModeEnabled(settings)) {
      const middleware = {
        ok: true,
        responseCode: "DEMO_MODE",
        responseMessage: "Modalita demo attiva: comando fiscale non inviato.",
        processedAt: nowIso(),
      };
      db.fiscalEvents.push({
        id: `fiscal_evt_${randomUUID().replace(/-/g, "")}`,
        command,
        createdAt: middleware.processedAt,
        createdByUserId: user.id,
        createdByUsername: user.username,
        result: "skipped",
        message: middleware.responseMessage,
        fiscalStatus: "SKIPPED",
        fiscalProvider: "demo-mode",
        fiscalProviderRef: middleware.responseCode,
        fiscalError: null,
        requiresFiscalRetry: false,
      });
      const auditActor = buildAuditActor(user, payload);
      appendAuditEvent(db, {
        ...auditActor,
        action: "fiscal.demo_skipped",
        entityType: "fiscal_command",
        entityId: command,
        payload: {
          command,
          result: "skipped",
          message: middleware.responseMessage,
          fiscalStatus: "SKIPPED",
          fiscalProvider: "demo-mode",
        },
      });
      db.meta.lastWriteAt = nowIso();
      await writePaymentDb(db, {
        metricLabel: "payments.fiscalCommand.demoSkipped.appStateWrite",
        splitDomains: FISCAL_COMMAND_WRITE_SPLIT_DOMAINS,
      });
      return {
        ok: true,
        skipped: true,
        demoMode: true,
        command,
        middleware,
      };
    }

    if (relationalFiscalCommandWritePrimary) {
      if (
        typeof ensureRelationalFiscalCommandWritePrimary !== "function" ||
        typeof recordRelationalFiscalCommandResult !== "function"
      ) {
        throw new HttpError(503, "DB relazionale fiscale non disponibile.", {
          code: "RELATIONAL_FISCAL_DB_UNAVAILABLE",
        });
      }
      await ensureRelationalFiscalCommandWritePrimary();
    }

    const fiscalResult = executeFiscalProvider(command, payload);
    const middleware = fiscalResult.middleware;
    const eventCreatedAt = nowIso();
    let relationalCommandResult = null;
    db.fiscalEvents.push({
      id: `fiscal_evt_${randomUUID().replace(/-/g, "")}`,
      command,
      createdAt: eventCreatedAt,
      createdByUserId: user.id,
      createdByUsername: user.username,
      result: fiscalResult.fiscalStatus === "ISSUED" ? "ok" : "error",
      message: middleware.responseMessage,
      fiscalStatus: fiscalResult.fiscalStatus,
      fiscalProvider: fiscalResult.fiscalProvider,
      fiscalProviderRef: middleware.responseCode ?? null,
      fiscalError:
        fiscalResult.fiscalStatus === "FAILED"
          ? middleware.responseMessage
          : null,
      requiresFiscalRetry: fiscalResult.requiresFiscalRetry,
    });
    const auditActor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...auditActor,
      action: /void|annull|storn/i.test(command)
        ? "fiscal.voided"
        : "fiscal.issued",
      entityType: "fiscal_command",
      entityId: command,
      payload: {
        command,
        result: fiscalResult.fiscalStatus === "ISSUED" ? "ok" : "error",
        message: middleware.responseMessage,
        fiscalStatus: fiscalResult.fiscalStatus,
        fiscalProvider: fiscalResult.fiscalProvider,
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writePaymentDb(db, {
      metricLabel: "payments.fiscalCommand.executed.appStateWrite",
      splitDomains: FISCAL_COMMAND_WRITE_SPLIT_DOMAINS,
    });
    if (relationalFiscalCommandWritePrimary) {
      relationalCommandResult = await recordRelationalFiscalCommandResult({
        command,
        payload,
        fiscalResult,
        middleware,
        user,
        recordedAt: eventCreatedAt,
      });
    }

    return {
      ok: true,
      command,
      middleware,
      relational: relationalCommandResult
        ? {
            writePrimary: true,
            fiscalReceiptId: relationalCommandResult.domainResult?.receipt?.id ?? null,
            paymentTransactionId:
              relationalCommandResult.domainResult?.paymentTransactionId ?? null,
          }
        : undefined,
    };
  }

  async function readNonFiscalizedReportView(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    const requestedUserId = String(payload.userId ?? "").trim();
    const userId =
      payload.allUsers === true &&
      (isAdminUser(user) || hasPermission(user, "view_analytics"))
        ? ""
        : requestedUserId || String(user?.id ?? "").trim();
    const report = collectNonFiscalizedFiscalReceiptsForReport(db, {
      sinceMs: payload.sinceMs ?? payload.cutoffMs ?? payload.sessionStartedAt,
      userId,
      expiredOnly: payload.expiredOnly !== false,
    });
    return {
      ok: true,
      report,
    };
  }

  return {
    readNonFiscalizedReportView,
    runFiscalCommand,
  };
}
