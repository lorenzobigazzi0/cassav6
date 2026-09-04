export function createSmartHandlers(deps = {}) {
  const {
    HttpError,
    SMART_CARD_ALLOW_MOCK_FALLBACK,
    SMART_CARD_READ_TIMEOUT_MS,
    assertUserPaymentMethodAllowed,
    clampSmartCardReadTimeout,
    computeDaysUntilDate,
    computeSmartPassExpiry,
    executeFiscalProvider,
    findPaymentMethod,
    formatDateIt,
    isPosDemoModeEnabled,
    normalizeSmartCardCode,
    normalizeSmartPass,
    nowIso,
    randomUUID,
    readDb,
    readJsonBody,
    resolveSmartBeachPassCandidates,
    roundMoney,
    sanitizeFiscalReceipt,
    sanitizePaymentRecord,
    sanitizePosSettings,
    sanitizeSmartCustomer,
    sanitizeSmartCustomerForResponse,
    sanitizeSmartNonFiscalEntry,
    sendJson,
    validateSessionContext,
    waitForSmartCardDetection,
    writeDb,
  } = deps;

  function ensureSmartCollections(db) {
    if (!Array.isArray(db.smartCustomers)) db.smartCustomers = [];
    if (!Array.isArray(db.smartNonFiscal)) db.smartNonFiscal = [];
    if (!Array.isArray(db.fiscalReceipts)) db.fiscalReceipts = [];
    if (!Array.isArray(db.payments)) db.payments = [];
  }

  async function handleSmartCustomers(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    ensureSmartCollections(db);
    validateSessionContext(db, payload);
    sendJson(res, 200, {
      ok: true,
      customers: [...db.smartCustomers]
        .map((customer) => sanitizeSmartCustomerForResponse(customer))
        .sort((a, b) =>
          `${a.lastName} ${a.firstName}`.trim().localeCompare(
            `${b.lastName} ${b.firstName}`.trim(),
            "it-IT",
          ),
        ),
    });
  }

  async function handleSmartCustomerUpsert(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    ensureSmartCollections(db);
    const { user } = validateSessionContext(db, payload);
    const input = payload.customer;
    if (!input || typeof input !== "object") {
      throw new HttpError(400, "Cliente smart non valido.");
    }
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    const phone = String(input.phone ?? "").trim();
    if (!firstName || !lastName) {
      throw new HttpError(400, "Nome e cognome sono obbligatori.");
    }
    if (!phone) throw new HttpError(400, "Numero di telefono obbligatorio.");

    const candidateId =
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id.trim()
        : `smart_cli_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const existingIndex = db.smartCustomers.findIndex(
      (item) => item.id === candidateId,
    );
    const existing = existingIndex >= 0 ? db.smartCustomers[existingIndex] : null;
    const normalized = sanitizeSmartCustomer(
      {
        ...existing,
        ...input,
        id: candidateId,
        firstName,
        lastName,
        phone,
        updatedAt: nowIso(),
        createdAt: existing?.createdAt ?? nowIso(),
      },
      candidateId,
    );

    if (existingIndex >= 0) db.smartCustomers[existingIndex] = normalized;
    else db.smartCustomers.push(normalized);
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    sendJson(res, 200, {
      ok: true,
      customer: sanitizeSmartCustomerForResponse(normalized),
      updatedBy: user.username,
    });
  }

  async function handleSmartCustomerDelete(req, res) {
    const payload = await readJsonBody(req);
    const customerId = String(payload.customerId ?? "").trim();
    if (!customerId) throw new HttpError(400, "Cliente non valido.");
    const db = await readDb();
    ensureSmartCollections(db);
    validateSessionContext(db, payload);
    const next = db.smartCustomers.filter((customer) => customer.id !== customerId);
    if (next.length === db.smartCustomers.length) {
      throw new HttpError(404, "Cliente non trovato.");
    }
    db.smartCustomers = next;
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    sendJson(res, 200, { ok: true, customerId });
  }

  async function handleSmartCardRead(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    validateSessionContext(db, payload);
    const requestedWaitMs = Number(payload.waitMs);
    const waitMs = clampSmartCardReadTimeout(
      Number.isFinite(requestedWaitMs)
        ? Math.trunc(requestedWaitMs)
        : SMART_CARD_READ_TIMEOUT_MS,
    );
    try {
      const detection = await waitForSmartCardDetection(waitMs);
      if (!detection) {
        throw new HttpError(
          408,
          `Nessun chip rilevato entro ${Math.round(waitMs / 1000)} secondi.`,
        );
      }
      sendJson(res, 200, {
        ok: true,
        chipCode: detection.chipCode,
        detectedAt: detection.detectedAt,
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (SMART_CARD_ALLOW_MOCK_FALLBACK) {
        sendJson(res, 200, {
          ok: true,
          chipCode: `SMART-${Date.now().toString().slice(-6)}`,
          detectedAt: nowIso(),
        });
        return;
      }
      throw new HttpError(
        503,
        error instanceof Error ? error.message : "Lettore smart card non disponibile.",
      );
    }
  }

  async function handleSmartCashBeachEntryConsume(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    ensureSmartCollections(db);
    validateSessionContext(db, payload);
    const customerId = String(payload.customerId ?? "").trim();
    const chipCode = normalizeSmartCardCode(payload.chipCode ?? payload.cardCode ?? "");
    const requestedEntries = Number(payload.entries);
    const entries = Number.isFinite(requestedEntries)
      ? Math.max(Math.trunc(requestedEntries), 1)
      : 1;
    const customerIndex = customerId
      ? db.smartCustomers.findIndex((customer) => customer.id === customerId)
      : chipCode
        ? db.smartCustomers.findIndex(
            (customer) => normalizeSmartCardCode(customer.cardCode ?? "") === chipCode,
          )
        : -1;
    if (customerIndex < 0) {
      throw new HttpError(404, "Cliente MyConto non trovato per il chip selezionato.");
    }

    const customer = db.smartCustomers[customerIndex];
    const nextCustomer = sanitizeSmartCustomer(
      {
        ...customer,
        updatedAt: nowIso(),
        balances: { ...customer.balances },
        passes: [...customer.passes],
      },
      customer.id,
    );
    if (nextCustomer.active === false) {
      throw new HttpError(409, "Conto MyConto disattivato: accesso non consentito.");
    }
    if (!nextCustomer.capabilities.ingressi_spiaggia) {
      throw new HttpError(400, "Questo conto non e abilitato agli ingressi spiaggia.");
    }
    if (nextCustomer.balances.ingressiSpiaggia <= 0) {
      throw new HttpError(409, "Non e possibile procedere: ingressi esauriti.");
    }
    if (nextCustomer.balances.ingressiSpiaggia < entries) {
      throw new HttpError(
        409,
        `Ingressi insufficienti: disponibili ${nextCustomer.balances.ingressiSpiaggia}, richiesti ${entries}.`,
      );
    }

    const nowDate = new Date();
    let remainingToConsume = entries;
    const consumedExpiryDates = [];
    while (remainingToConsume > 0) {
      const state = resolveSmartBeachPassCandidates(nextCustomer, nowDate);
      if (!state.candidates.length) {
        if (state.hasInvalidWeekday || state.hasInvalidSeason) {
          throw new HttpError(
            409,
            "Abbonamento valido solo in certi giorni: accesso non consentito oggi.",
          );
        }
        if (state.latestExpiredDate) {
          throw new HttpError(
            409,
            `Periodo di validita terminato: ${formatDateIt(state.latestExpiredDate)}.`,
          );
        }
        throw new HttpError(409, "Non e possibile procedere: ingressi esauriti.");
      }
      const candidate = state.candidates[0];
      const currentPass = nextCustomer.passes[candidate.index];
      const safeQuantity = Number.isFinite(currentPass?.quantity)
        ? Math.max(Math.trunc(Number(currentPass.quantity)), 0)
        : 0;
      if (safeQuantity <= 0) continue;
      const consumed = Math.min(safeQuantity, remainingToConsume);
      nextCustomer.passes[candidate.index] = {
        ...currentPass,
        quantity: safeQuantity - consumed,
      };
      remainingToConsume -= consumed;
      if (candidate.expiresAtDate) consumedExpiryDates.push(candidate.expiresAtDate);
    }

    nextCustomer.passes = nextCustomer.passes
      .map((pass, index) => normalizeSmartPass(pass, `pass_${index + 1}`))
      .filter((pass) => pass !== null)
      .filter((pass) => !(pass.type === "ingressi_spiaggia" && pass.quantity <= 0));
    nextCustomer.balances.ingressiSpiaggia = Math.max(
      nextCustomer.balances.ingressiSpiaggia - entries,
      0,
    );
    const accessAt = nowIso();
    nextCustomer.accessLog.unshift({
      id: `acc_${randomUUID().replace(/-/g, "")}`,
      createdAt: accessAt,
      quantity: entries,
      source: "myconto",
      note: `Ingresso spiaggia scalato (${entries})`,
    });
    nextCustomer.transactions.unshift({
      id: `tx_${randomUUID().replace(/-/g, "")}`,
      createdAt: accessAt,
      type: "beach_entry_consume",
      description: `Ingresso spiaggia -${entries}`,
      amount: 0,
      quantity: entries,
      methodLabel: "MyConto",
    });

    const warnings = [];
    const remainingEntries = nextCustomer.balances.ingressiSpiaggia;
    if (remainingEntries <= 1) {
      warnings.push({
        code: "LOW_ENTRIES",
        message:
          remainingEntries === 0
            ? "Ingressi residui: 0. Avvisa il cliente."
            : "Ingresso residuo: 1. Avvisa il cliente.",
      });
    }
    const nearestExpiry = consumedExpiryDates
      .filter((date) => {
        const days = computeDaysUntilDate(date, nowDate);
        return days >= 0 && days <= 3;
      })
      .sort((left, right) => left.getTime() - right.getTime())[0];
    if (nearestExpiry) {
      warnings.push({
        code: "EXPIRY_SOON",
        message: `Abbonamento in scadenza il ${formatDateIt(nearestExpiry)}. Avvisa il cliente.`,
        expiresAt: nearestExpiry.toISOString(),
      });
    }

    db.smartCustomers[customerIndex] = nextCustomer;
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    sendJson(res, 200, {
      ok: true,
      customer: sanitizeSmartCustomerForResponse(nextCustomer),
      consumedEntries: entries,
      remainingEntries,
      warnings,
    });
  }

  async function handleSmartCustomerRecharge(req, res) {
    const payload = await readJsonBody(req);
    const customerId = String(payload.customerId ?? "").trim();
    if (!customerId) throw new HttpError(400, "Cliente non valido.");
    const db = await readDb();
    ensureSmartCollections(db);
    const { user } = validateSessionContext(db, payload);
    const customerIndex = db.smartCustomers.findIndex(
      (customer) => customer.id === customerId,
    );
    if (customerIndex < 0) throw new HttpError(404, "Cliente non trovato.");

    const customer = db.smartCustomers[customerIndex];
    const target = String(payload.target ?? "").trim();
    const mode = String(payload.mode ?? "").trim();
    const nextCustomer = sanitizeSmartCustomer(
      {
        ...customer,
        updatedAt: nowIso(),
        balances: { ...customer.balances },
        passes: [...customer.passes],
      },
      customer.id,
    );
    const amount = Number(payload.amount);
    const percent = Number(payload.percent);
    const quantity = Number(payload.quantity);
    const paymentMethodId = String(payload.paymentMethodId ?? "").trim();
    let paymentRecord = null;
    let middleware = null;

    if (target === "ingressi_spiaggia") {
      const entries = Number.isFinite(quantity) ? Math.max(Math.trunc(quantity), 0) : 0;
      if (entries <= 0) throw new HttpError(400, "Quantita ingressi non valida.");
      const validityType = String(payload.validityType ?? "giorni");
      const safeWeekDays = Array.isArray(payload.weekDays)
        ? payload.weekDays
            .map((item) => Math.trunc(Number(item)))
            .filter((item) => Number.isFinite(item) && item >= 1 && item <= 7)
        : [];
      const resolvedWeekDays =
        validityType === "giorni" ? (safeWeekDays.length ? safeWeekDays : [1, 2, 3, 4, 5, 6]) : [];
      const resolvedMonths = Array.isArray(payload.seasonMonths)
        ? payload.seasonMonths
            .map((item) => Math.trunc(Number(item)))
            .filter((item) => Number.isFinite(item) && item >= 6 && item <= 9)
        : [];
      const createdAt = nowIso();
      nextCustomer.balances.ingressiSpiaggia += entries;
      nextCustomer.passes.push({
        id: `pass_${randomUUID().replace(/-/g, "")}`,
        type: "ingressi_spiaggia",
        quantity: entries,
        validityType,
        daysValid: Number.isFinite(payload.daysValid)
          ? Math.max(Math.trunc(Number(payload.daysValid)), 0)
          : validityType === "giorni"
            ? resolvedWeekDays.length
            : 0,
        weekDays: resolvedWeekDays,
        monthlyMode: String(payload.monthlyMode ?? ""),
        months: resolvedMonths,
        createdAt,
        expiresAt: computeSmartPassExpiry(validityType, {
          monthlyMode: String(payload.monthlyMode ?? ""),
          months: resolvedMonths,
        }),
      });
      nextCustomer.transactions.unshift({
        id: `tx_${randomUUID().replace(/-/g, "")}`,
        createdAt,
        type: "entries_recharge",
        description: `Ricarica ingressi spiaggia +${entries}`,
        amount: 0,
        quantity: entries,
        methodLabel: "",
      });
    } else if (mode === "amount") {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, "Importo ricarica non valido.");
      }
      if (!paymentMethodId) throw new HttpError(400, "Seleziona metodo di pagamento.");
      const settings = sanitizePosSettings(db.posSettings, { menuItems: db.menuItems });
      const method = findPaymentMethod(settings, paymentMethodId);
      if (!method) throw new HttpError(400, "Metodo di pagamento non disponibile.");
      assertUserPaymentMethodAllowed(user, method.id, settings);

      const paymentId = `pay_${randomUUID().replace(/-/g, "")}`;
      const demoMode = isPosDemoModeEnabled(settings);
      if (method.isFiscal && !demoMode) {
        const fiscalResult = executeFiscalProvider("smart_recharge", {
          customerId: customer.id,
          amount,
        });
        middleware = fiscalResult.middleware;
        const receipt = sanitizeFiscalReceipt(
          {
            id: `fiscal_${randomUUID().replace(/-/g, "")}`,
            paymentId,
            command: "smart_recharge",
            status: fiscalResult.fiscalStatus,
            responseCode: middleware.responseCode,
            responseMessage: middleware.responseMessage,
            createdAt: middleware.processedAt,
            fiscalProvider: fiscalResult.fiscalProvider,
            requiresFiscalRetry: fiscalResult.requiresFiscalRetry,
          },
          `fiscal_${Date.now()}`,
        );
        if (receipt) db.fiscalReceipts.push(receipt);
      } else {
        middleware = {
          ok: true,
          responseCode: demoMode && method.isFiscal ? "DEMO_MODE" : "SMART_OK",
          responseMessage:
            demoMode && method.isFiscal
              ? "Modalita demo attiva: ricarica smart registrata senza emissione fiscale."
              : "Ricarica smart non fiscale registrata.",
        };
        const nonFiscalRecord = sanitizeSmartNonFiscalEntry(
          {
            id: `smart_nf_${randomUUID().replace(/-/g, "")}`,
            kind: "smart_recharge",
            description: `Ricarica smart ${customer.lastName} ${customer.firstName}`,
            amount,
            createdAt: nowIso(),
            methodId: method.id,
            methodLabel: method.label,
            customerId: customer.id,
            customerLabel: `${customer.lastName} ${customer.firstName}`.trim(),
          },
          `smart_nf_${Date.now()}`,
        );
        if (nonFiscalRecord) db.smartNonFiscal.push(nonFiscalRecord);
      }

      paymentRecord = sanitizePaymentRecord(
        {
          id: paymentId,
          tableId: null,
          amount,
          methodId: method.id,
          methodLabel: method.label,
          fiscal: method.isFiscal && !demoMode,
          source: "smart_recharge",
          customerId: customer.id,
          createdAt: nowIso(),
          createdByUserId: user.id,
          createdByUsername: user.username,
          items: [],
        },
        paymentId,
      );
      if (paymentRecord) db.payments.push(paymentRecord);

      if (!["pagamenti_bar", "pagamenti_ristorante", "servizi"].includes(target)) {
        throw new HttpError(400, "Target ricarica non supportato.");
      }
      if (nextCustomer.unifiedCredit === true) {
        const nextUnified = roundMoney(
          Math.max(
            nextCustomer.balances.barCredit,
            nextCustomer.balances.restaurantCredit,
            nextCustomer.balances.servicesCredit,
          ) + amount,
        );
        nextCustomer.balances.barCredit = nextUnified;
        nextCustomer.balances.restaurantCredit = nextUnified;
        nextCustomer.balances.servicesCredit = nextUnified;
      } else if (target === "pagamenti_bar") {
        nextCustomer.balances.barCredit = roundMoney(nextCustomer.balances.barCredit + amount);
      } else if (target === "pagamenti_ristorante") {
        nextCustomer.balances.restaurantCredit = roundMoney(
          nextCustomer.balances.restaurantCredit + amount,
        );
      } else {
        nextCustomer.balances.servicesCredit = roundMoney(
          nextCustomer.balances.servicesCredit + amount,
        );
      }
      nextCustomer.transactions.unshift({
        id: `tx_${randomUUID().replace(/-/g, "")}`,
        createdAt: nowIso(),
        type: "credit_recharge",
        description: `Ricarica ${target.replace(/_/g, " ")} +${roundMoney(amount)}`,
        amount: roundMoney(amount),
        quantity: 0,
        methodLabel: paymentRecord?.methodLabel ?? "",
      });
    } else if (mode === "discount") {
      if (!Number.isFinite(percent) || percent <= 0) {
        throw new HttpError(400, "Percentuale sconto non valida.");
      }
      const safePercent = Math.min(roundMoney(percent), 100);
      if (target === "sconto_bar") {
        nextCustomer.balances.barDiscountPercent = safePercent;
      } else if (target === "sconto_ristorante") {
        nextCustomer.balances.restaurantDiscountPercent = safePercent;
      } else {
        throw new HttpError(400, "Target sconto non supportato.");
      }
      nextCustomer.transactions.unshift({
        id: `tx_${randomUUID().replace(/-/g, "")}`,
        createdAt: nowIso(),
        type: "discount_update",
        description: `Aggiornato ${target.replace(/_/g, " ")} a ${safePercent}%`,
        amount: 0,
        quantity: 0,
        methodLabel: "",
      });
    } else {
      throw new HttpError(400, "Modalita ricarica non supportata.");
    }

    db.smartCustomers[customerIndex] = nextCustomer;
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    sendJson(res, 200, {
      ok: true,
      customer: sanitizeSmartCustomerForResponse(nextCustomer),
      payment: paymentRecord,
      middleware,
    });
  }

  async function handleSmartNonFiscal(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    ensureSmartCollections(db);
    validateSessionContext(db, payload);
    sendJson(res, 200, {
      ok: true,
      entries: [...db.smartNonFiscal]
        .map((entry) =>
          sanitizeSmartNonFiscalEntry(entry, `smart_nf_${entry?.id ?? Date.now()}`),
        )
        .filter((entry) => entry !== null)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 200),
    });
  }

  return {
    handleSmartCardRead,
    handleSmartCashBeachEntryConsume,
    handleSmartCustomerDelete,
    handleSmartCustomerRecharge,
    handleSmartCustomerUpsert,
    handleSmartCustomers,
    handleSmartNonFiscal,
  };
}
