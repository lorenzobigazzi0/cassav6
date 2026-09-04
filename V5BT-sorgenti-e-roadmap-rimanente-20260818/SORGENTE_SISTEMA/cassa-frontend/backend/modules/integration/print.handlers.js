/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationPrintHandlers({
  buildIntegrationPrecontoPrintTextWithOptions,
  buildIntegrationOrderPrintText,
  HttpError,
  INTEGRATION_PRINT_MAX_TEXT_LEN,
  PRINTING_DISABLED_MESSAGE,
  PRINTING_ENABLED,
  applyIntegrationOrderCompsToPrintableOrder,
  applyIntegrationPrintTarget,
  buildTablePrecontoPrintableOrder,
  canUsePrintSpoolFastWorker,
  collectIntegrationOrdersForTablePreconto,
  enqueuePrintSpoolJob,
  enqueuePrintSpoolJobFast,
  enqueueRealtimePilotEvent,
  findIntegrationOrderForPrint,
  findIntegrationOrderIndexByLookup,
  findLatestIntegrationPrintTarget,
  findLegacyTablePrecontoPrintTarget,
  findRelationalOrderById,
  hasOperationalPrintRouting,
  normalizeTablePrecontoMode,
  readDb,
  readJsonBody,
  RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY,
  RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY,
  relationalRuntime,
  resolveIntegrationLogicalTableLabel,
  resolveIntegrationOrderPrintStation,
  resolvePrinterFromSettings,
  runtimeMetrics,
  sanitizeIntegrationOrder,
  sanitizeIntegrationTableLabel,
  sanitizePosSettings,
  sendJson,
  shouldEngageIntegrationPrintCommand,
  supportsLocalDefaultPrintFallback,
  validateSessionContext,
  withOrderOperationalRoutingPayload,
  withOrderPrintOperationalRoutingPayload,
}) {
  async function handleIntegrationPrint(req, res) {
    req.__preserveIntegrationHotCaches = true;
    const payload = await readJsonBody(req);
    const db = await readDb();
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    const kind = String(payload?.kind ?? "")
      .trim()
      .toLowerCase();
    let effectivePayload =
      payload && typeof payload === "object"
        ? {
            ...payload,
            userId: user?.id ?? payload.userId,
            username: user?.username ?? payload.username,
            deviceUuid: session?.deviceUuid ?? payload.deviceUuid,
            clientApp: session?.clientApp ?? payload.clientApp,
            sessionId: session?.id ?? payload.sessionId,
          }
        : {};
    // Bootstrap cross-processo: con write-primary relazionale l'ordine puo' essere
    // stato creato/aggiornato su un altro processo e non essere ancora nel mirror
    // locale dell'owner; prima del 404 di ristampa reidrata dal relazionale
    // (stesso pattern MP-4ae di orders/cancel).
    const printBootstrapOrderId = String(payload?.orderId ?? "").trim();
    if (printBootstrapOrderId && findIntegrationOrderIndexByLookup(db.integration?.orders ?? [], printBootstrapOrderId) < 0) {
      const relationalPrintOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY || RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY, orderId: printBootstrapOrderId, relationalRuntime, runtimeMetrics });
      if (relationalPrintOrder && Array.isArray(db.integration?.orders)) {
        db.integration.orders.push(sanitizeIntegrationOrder(relationalPrintOrder, String(relationalPrintOrder.id ?? printBootstrapOrderId).trim() || printBootstrapOrderId));
      }
    }
    const hydrateOrderForCurrentPrintLayout = (order, fallbackId) => {
      const safeOrder = sanitizeIntegrationOrder(order, fallbackId);
      const liveTableLabel =
        resolveIntegrationLogicalTableLabel(
          settings,
          db.integration,
          safeOrder.tableId,
          safeOrder.tableNumber,
        ) ||
        sanitizeIntegrationTableLabel(
          safeOrder.tableLabel ?? safeOrder.logicalTableLabel,
        );
      return liveTableLabel
        ? sanitizeIntegrationOrder(
            {
              ...safeOrder,
              tableLabel: liveTableLabel,
              logicalTableLabel: liveTableLabel,
            },
            safeOrder.id,
          )
        : safeOrder;
    };
  
    // Step 5 — evento pilota durabile: una ristampa comanda/preconto legata a un
    // ordine esistente e' stata richiesta. Emesso una sola volta, dopo che
    // l'ordine risulta presente (coerente con la guardia 404 dei rami sotto).
    if (shouldEngageIntegrationPrintCommand(payload)) {
      const printRequestOrderId = String(payload?.orderId ?? "").trim();
      if (printRequestOrderId && findIntegrationOrderForPrint(db, printRequestOrderId)) {
        enqueueRealtimePilotEvent({
          eventType: "print.requested",
          aggregateType: "order",
          aggregateId: printRequestOrderId,
          scope: printRequestOrderId,
          payload: { kind, orderId: printRequestOrderId },
        });
      }
    }
  
    if (kind === "order") {
      const orderId = String(payload?.orderId ?? "").trim();
      const currentOrder = findIntegrationOrderForPrint(db, orderId);
      if (orderId && !currentOrder) {
        throw new HttpError(404, "Comanda non trovata per la ristampa.");
      }
      if (currentOrder) {
        const safeOrder = hydrateOrderForCurrentPrintLayout(
          applyIntegrationOrderCompsToPrintableOrder(currentOrder, db),
          currentOrder.id || orderId,
        );
        const printStation = resolveIntegrationOrderPrintStation(
          safeOrder,
          payload,
        );
        const previousTarget = findLatestIntegrationPrintTarget(
          db,
          safeOrder.id,
          ["order"],
        );
        const orderPrintPayload = withOrderPrintOperationalRoutingPayload(
          settings,
          safeOrder,
          {
            ...effectivePayload,
            orderId: safeOrder.id,
            kind: "order",
            text: buildIntegrationOrderPrintText(
              safeOrder,
              printStation,
              settings.printPreferences?.order,
              db.posSettings,
            ),
          },
        );
        effectivePayload = applyIntegrationPrintTarget(
          orderPrintPayload,
          hasOperationalPrintRouting(orderPrintPayload) ? null : previousTarget,
          printStation,
        );
      }
    }
  
    if (kind === "preconto") {
      if (payload?.tablePreconto === true) {
        const tablePrecontoMode = normalizeTablePrecontoMode(
          payload?.tablePrecontoMode ?? payload?.mode,
        );
        const tableOrders = collectIntegrationOrdersForTablePreconto(db, payload);
        const printableOrder = buildTablePrecontoPrintableOrder(
          tableOrders,
          payload,
          settings,
        );
        const printStation = resolveIntegrationOrderPrintStation(
          printableOrder,
          payload,
        );
        const tablePrecontoPayload = withOrderOperationalRoutingPayload(
          printableOrder,
          {
            ...effectivePayload,
            orderId: printableOrder.id,
            kind: "preconto",
            precontoProfile: "cash",
            ignoreWorkstationRouting: true,
            station: "",
            fallbackStation: "",
            workstationId: "",
            stationId: "",
            text: buildIntegrationPrecontoPrintTextWithOptions(
              printableOrder,
              settings.printPreferences,
              db.posSettings,
              {
                profile: "cash",
                paymentSummary:
                  tablePrecontoMode === "current"
                    ? {
                        paidAmount: printableOrder.paidAmount,
                        dueAmount: printableOrder.dueAmount,
                      }
                    : null,
              },
            ),
          },
        );
        const hasOperationalRouting =
          hasOperationalPrintRouting(tablePrecontoPayload);
        const legacyTarget = hasOperationalRouting
          ? null
          : findLegacyTablePrecontoPrintTarget(db, tableOrders);
        effectivePayload = hasOperationalRouting
          ? tablePrecontoPayload
          : applyIntegrationPrintTarget(
              tablePrecontoPayload,
              legacyTarget,
              printStation,
            );
      } else {
        const orderId = String(payload?.orderId ?? "").trim();
        const currentOrder = findIntegrationOrderForPrint(db, orderId);
        if (orderId && !currentOrder) {
          throw new HttpError(404, "Comanda non trovata per la ristampa.");
        }
        if (currentOrder) {
          const safeOrder = hydrateOrderForCurrentPrintLayout(
            applyIntegrationOrderCompsToPrintableOrder(currentOrder, db),
            currentOrder.id || orderId,
          );
          const printStation = resolveIntegrationOrderPrintStation(
            safeOrder,
            payload,
          );
          const previousTarget =
            findLatestIntegrationPrintTarget(db, safeOrder.id, ["order"]) ??
            findLatestIntegrationPrintTarget(db, safeOrder.id, ["preconto"]);
          const precontoPrintPayload = withOrderPrintOperationalRoutingPayload(
            settings,
            safeOrder,
            {
              ...effectivePayload,
              orderId: safeOrder.id,
              kind: "preconto",
              precontoProfile: "cash",
              text: buildIntegrationPrecontoPrintTextWithOptions(
                safeOrder,
                settings.printPreferences,
                db.posSettings,
                { profile: "cash" },
              ),
            },
          );
          effectivePayload = applyIntegrationPrintTarget(
            precontoPrintPayload,
            hasOperationalPrintRouting(precontoPrintPayload)
              ? null
              : previousTarget,
            printStation,
          );
        }
      }
    }
  
    const textRaw = String(effectivePayload?.text ?? "").replace(/\r\n?/g, "\n");
    const text = textRaw.trim();
    if (!text) {
      throw new HttpError(400, "Contenuto stampa mancante.");
    }
    if (text.length > INTEGRATION_PRINT_MAX_TEXT_LEN) {
      throw new HttpError(413, "Contenuto stampa troppo lungo.");
    }
  
    effectivePayload.text = text;
    const resolvedTarget = resolvePrinterFromSettings(settings, effectivePayload);
    if (
      !canUsePrintSpoolFastWorker() &&
      PRINTING_ENABLED &&
      !resolvedTarget &&
      !supportsLocalDefaultPrintFallback()
    ) {
      throw new HttpError(
        400,
        "Stampante non disponibile per la configurazione indicata.",
        {
          code: "PRINTER_NOT_AVAILABLE",
          kind: String(effectivePayload?.kind ?? "").trim() || null,
          printerId: String(effectivePayload?.printerId ?? "").trim() || null,
          activityId:
            String(
              effectivePayload?.activityId ??
                effectivePayload?.operationalActivityId ??
                "",
            ).trim() || null,
          roomId:
            String(
              effectivePayload?.roomId ??
                effectivePayload?.areaId ??
                effectivePayload?.operationalRoomId ??
                "",
            ).trim() || null,
          workstationId:
            String(
              effectivePayload?.workstationId ??
                effectivePayload?.stationId ??
                "",
            ).trim() || null,
        },
      );
    }
  
    const queuedJob = canUsePrintSpoolFastWorker()
      ? await enqueuePrintSpoolJobFast(effectivePayload)
      : await enqueuePrintSpoolJob(effectivePayload);
    const queued = queuedJob.status === "queued";
    const disabled = queuedJob.status === "disabled";
    const configurationError = queuedJob.status === "failed_configuration";
  
    sendJson(res, 202, {
      ok: queued,
      accepted: true,
      async: true,
      status: queuedJob.status,
      disabled: disabled || undefined,
      ...(disabled
        ? {
            code: "PRINTING_DISABLED",
            error: PRINTING_DISABLED_MESSAGE,
          }
        : configurationError
          ? {
              code: "PRINTER_NOT_AVAILABLE",
              error:
                queuedJob.errorMessage ||
                "Stampante non disponibile per la configurazione indicata.",
            }
          : {}),
      queued,
      printer:
        queuedJob.printerName || (resolvedTarget?.printer?.name ?? "default"),
      printerId: queuedJob.printerId,
      fileName: queuedJob.fileName,
      jobId: queuedJob.id,
    });
  }
  
  // Step 5 — Event Outbox autoritativa: mappa una riga outbox all'envelope evento
  // del contratto (contracts/event-envelope.schema.json).

  return {
    handleIntegrationPrint,
  };
}
