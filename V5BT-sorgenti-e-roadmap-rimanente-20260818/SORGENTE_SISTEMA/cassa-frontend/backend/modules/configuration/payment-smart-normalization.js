export function createPaymentSmartNormalization(dependencies = {}) {
  const {
    DEFAULT_PAYMENT_METHODS,
    DEFAULT_PAYMENT_TERMINALS,
    DEFAULT_SMART_CASH_SETTINGS,
    SMART_CAPABILITY_KEYS,
    normalizeSmartCardCode,
    normalizeUserRole,
    nowIso,
    roundMoney,
  } = dependencies;

  function normalizeSideBarMode(value, fallback = "fixed") {
    return value === "collapse" ? "collapse" : fallback;
  }

  function normalizePaymentMethod(method, fallbackId) {
    const safeId =
      typeof method?.id === "string" && method.id.trim().length > 0
        ? method.id.trim()
        : fallbackId;
    const labelRaw =
      typeof method?.label === "string" && method.label.trim().length > 0
        ? method.label.trim()
        : "Metodo";
    const label = safeId === "pay_chip" ? "MyConto" : labelRaw.slice(0, 36);
    const isSmart =
      method?.isSmart === true || safeId === "pay_smart" || safeId === "pay_chip";
    const isFiscal = isSmart ? false : method?.isFiscal !== false;
    return {
      id: safeId,
      label,
      enabled: method?.enabled !== false,
      isSmart,
      isFiscal,
    };
  }

  function sanitizePaymentMethods(methods) {
    const source = Array.isArray(methods) ? methods : DEFAULT_PAYMENT_METHODS;
    const byId = new Map();
    for (const [index, method] of source.entries()) {
      const normalized = normalizePaymentMethod(
        method,
        `pay_custom_${index + 1}`,
      );
      byId.set(normalized.id, normalized);
    }

    for (const fallback of DEFAULT_PAYMENT_METHODS) {
      if (!byId.has(fallback.id)) {
        byId.set(fallback.id, { ...fallback });
      }
    }

    return [...byId.values()];
  }

  function normalizePaymentTerminal(terminal, fallbackId) {
    const safeId =
      typeof terminal?.id === "string" && terminal.id.trim().length > 0
        ? terminal.id.trim()
        : fallbackId;
    const labelRaw =
      typeof terminal?.label === "string" && terminal.label.trim().length > 0
        ? terminal.label.trim()
        : safeId;
    const protocolRaw =
      typeof terminal?.protocol === "string" && terminal.protocol.trim().length > 0
        ? terminal.protocol.trim()
        : "mock";
    const providerRaw =
      typeof terminal?.provider === "string" && terminal.provider.trim().length > 0
        ? terminal.provider.trim()
        : protocolRaw;
    return {
      id: safeId,
      label: labelRaw.slice(0, 64),
      enabled: terminal?.enabled !== false,
      provider: providerRaw.slice(0, 48),
      protocol: protocolRaw.slice(0, 48),
      terminalId: String(terminal?.terminalId ?? "").trim().slice(0, 80),
      merchantId: String(terminal?.merchantId ?? "").trim().slice(0, 80),
      serialNumber: String(terminal?.serialNumber ?? "").trim().slice(0, 80),
      ipAddress: String(terminal?.ipAddress ?? terminal?.host ?? "")
        .trim()
        .slice(0, 120),
      port: String(terminal?.port ?? "").trim().slice(0, 12),
      workstationId: String(terminal?.workstationId ?? "").trim().slice(0, 80),
      notes: String(terminal?.notes ?? "").trim().slice(0, 160),
    };
  }

  function sanitizePaymentTerminals(terminals) {
    const source = Array.isArray(terminals) ? terminals : DEFAULT_PAYMENT_TERMINALS;
    const byId = new Map();
    for (const [index, terminal] of source.entries()) {
      const normalized = normalizePaymentTerminal(
        terminal,
        `pos_terminal_${index + 1}`,
      );
      byId.set(normalized.id, normalized);
    }

    for (const fallback of DEFAULT_PAYMENT_TERMINALS) {
      if (!byId.has(fallback.id)) {
        byId.set(fallback.id, { ...fallback });
      }
    }

    return [...byId.values()];
  }

  function normalizeSmartCashSettings(value, options = {}) {
    const input = value && typeof value === "object" ? value : {};
    const beachEntryItemIdRaw =
      typeof input.beachEntryItemId === "string"
        ? input.beachEntryItemId.trim()
        : "";
    const menuItems = Array.isArray(options.menuItems) ? options.menuItems : [];
    const knownItemIds = new Set(
      menuItems
        .map((item) =>
          item && typeof item === "object" ? String(item.id ?? "").trim() : "",
        )
        .filter(Boolean),
    );
    const beachEntryItemId =
      beachEntryItemIdRaw &&
      (!knownItemIds.size || knownItemIds.has(beachEntryItemIdRaw))
        ? beachEntryItemIdRaw
        : null;

    const parsedPointsPerEuro = Number(input.pointsPerEuro);
    const pointsPerEuro = Number.isFinite(parsedPointsPerEuro)
      ? Math.min(Math.max(roundMoney(parsedPointsPerEuro), 0.01), 100)
      : DEFAULT_SMART_CASH_SETTINGS.pointsPerEuro;

    return {
      beachEntryItemId,
      pointsPerEuro,
    };
  }

  function normalizeSmartCapabilities(value) {
    const input = value && typeof value === "object" ? value : {};
    const output = {};
    for (const key of SMART_CAPABILITY_KEYS) {
      output[key] = input[key] === true;
    }
    return output;
  }

  function normalizeSmartBalances(value, options = {}) {
    const input = value && typeof value === "object" ? value : {};
    const unifiedCredit = options.unifiedCredit === true;
    const toMoney = (item) =>
      Number.isFinite(item) ? Math.max(roundMoney(Number(item)), 0) : 0;
    const normalized = {
      ingressiSpiaggia: Number.isFinite(input.ingressiSpiaggia)
        ? Math.max(Math.trunc(Number(input.ingressiSpiaggia)), 0)
        : 0,
      barCredit: toMoney(input.barCredit),
      barDiscountPercent: Number.isFinite(input.barDiscountPercent)
        ? Math.min(Math.max(roundMoney(Number(input.barDiscountPercent)), 0), 100)
        : 0,
      restaurantCredit: toMoney(input.restaurantCredit),
      restaurantDiscountPercent: Number.isFinite(
        input.restaurantDiscountPercent,
      )
        ? Math.min(
            Math.max(roundMoney(Number(input.restaurantDiscountPercent)), 0),
            100,
          )
        : 0,
      servicesCredit: toMoney(input.servicesCredit),
      points: Number.isFinite(input.points)
        ? Math.max(Math.trunc(Number(input.points)), 0)
        : 0,
    };
    if (!unifiedCredit) return normalized;

    const unifiedValue = roundMoney(
      Math.max(
        normalized.barCredit,
        normalized.restaurantCredit,
        normalized.servicesCredit,
      ),
    );
    return {
      ...normalized,
      barCredit: unifiedValue,
      restaurantCredit: unifiedValue,
      servicesCredit: unifiedValue,
    };
  }

  function normalizeSmartPass(pass, fallbackId) {
    if (!pass || typeof pass !== "object") return null;
    const type = String(pass.type ?? "").trim();
    if (!type) return null;
    const createdAt = String(pass.createdAt ?? nowIso());
    const expiresAt =
      typeof pass.expiresAt === "string" && pass.expiresAt.trim().length > 0
        ? pass.expiresAt
        : null;
    const months = Array.isArray(pass.months)
      ? pass.months
          .map((item) => Math.trunc(Number(item)))
          .filter((item) => Number.isFinite(item) && item >= 6 && item <= 9)
      : [];
    const weekDays = Array.isArray(pass.weekDays)
      ? pass.weekDays
          .map((item) => Math.trunc(Number(item)))
          .filter((item) => Number.isFinite(item) && item >= 1 && item <= 7)
      : [];
    return {
      id: String(pass.id ?? fallbackId),
      type,
      quantity: Number.isFinite(pass.quantity)
        ? Math.max(Math.trunc(Number(pass.quantity)), 0)
        : 0,
      validityType: String(pass.validityType ?? ""),
      daysValid: Number.isFinite(pass.daysValid)
        ? Math.max(Math.trunc(Number(pass.daysValid)), 0)
        : 0,
      weekDays,
      monthlyMode: String(pass.monthlyMode ?? ""),
      months,
      createdAt,
      expiresAt,
    };
  }

  function normalizeSmartAccessLogEntry(entry, fallbackId) {
    if (!entry || typeof entry !== "object") return null;
    const quantityRaw = Number(entry.quantity);
    const quantity = Number.isFinite(quantityRaw)
      ? Math.max(Math.trunc(quantityRaw), 0)
      : 0;
    if (quantity <= 0) return null;
    return {
      id: String(entry.id ?? fallbackId),
      createdAt: String(entry.createdAt ?? nowIso()),
      quantity,
      source: String(entry.source ?? "ingresso").trim() || "ingresso",
      note: String(entry.note ?? "").trim(),
    };
  }

  function normalizeSmartTransactionEntry(entry, fallbackId) {
    if (!entry || typeof entry !== "object") return null;
    const description = String(entry.description ?? "").trim();
    if (!description) return null;
    const amountRaw = Number(entry.amount);
    const quantityRaw = Number(entry.quantity);
    return {
      id: String(entry.id ?? fallbackId),
      createdAt: String(entry.createdAt ?? nowIso()),
      type: String(entry.type ?? "generic").trim() || "generic",
      description,
      amount: Number.isFinite(amountRaw) ? roundMoney(amountRaw) : 0,
      quantity: Number.isFinite(quantityRaw)
        ? Math.max(Math.trunc(quantityRaw), 0)
        : 0,
      methodLabel: String(entry.methodLabel ?? "").trim(),
    };
  }

  function normalizeSmartCustomer(customer, fallbackId) {
    const firstName = String(customer?.firstName ?? "").trim();
    const lastName = String(customer?.lastName ?? "").trim();
    const unifiedCredit = customer?.unifiedCredit === true;
    return {
      id: String(customer?.id ?? fallbackId),
      firstName,
      lastName,
      phone: String(customer?.phone ?? "").trim(),
      cardCode: normalizeSmartCardCode(customer?.cardCode ?? "") || null,
      active: customer?.active !== false,
      unifiedCredit,
      capabilities: normalizeSmartCapabilities(customer?.capabilities),
      balances: normalizeSmartBalances(customer?.balances, { unifiedCredit }),
      passes: (Array.isArray(customer?.passes) ? customer.passes : [])
        .map((pass, index) =>
          normalizeSmartPass(pass, `${fallbackId}_pass_${index + 1}`),
        )
        .filter((pass) => pass !== null),
      accessLog: (Array.isArray(customer?.accessLog) ? customer.accessLog : [])
        .map((entry, index) =>
          normalizeSmartAccessLogEntry(
            entry,
            `${fallbackId}_access_${index + 1}`,
          ),
        )
        .filter((entry) => entry !== null)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 500),
      transactions: (Array.isArray(customer?.transactions)
        ? customer.transactions
        : []
      )
        .map((entry, index) =>
          normalizeSmartTransactionEntry(
            entry,
            `${fallbackId}_tx_${index + 1}`,
          ),
        )
        .filter((entry) => entry !== null)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 1000),
      createdAt: String(customer?.createdAt ?? nowIso()),
      updatedAt: String(customer?.updatedAt ?? nowIso()),
    };
  }

  function sanitizeSmartCustomer(customer, fallbackId) {
    return normalizeSmartCustomer(customer, fallbackId);
  }

  function sanitizeSmartNonFiscalEntry(entry, fallbackId) {
    if (!entry || typeof entry !== "object") return null;
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      id: String(entry.id ?? fallbackId),
      kind: String(entry.kind ?? "smart"),
      description: String(entry.description ?? "Operazione smart"),
      amount: roundMoney(Math.max(amount, 0)),
      createdAt: String(entry.createdAt ?? nowIso()),
      methodId: String(entry.methodId ?? "pay_smart"),
      methodLabel: String(entry.methodLabel ?? "Smart"),
      customerId: entry.customerId ? String(entry.customerId) : null,
      customerLabel: entry.customerLabel ? String(entry.customerLabel) : null,
    };
  }

  function resolveAuditActorRole(userLike) {
    const role = normalizeUserRole(userLike?.role);
    if (role === "admin") return "ADMIN";
    if (role === "responsabile") return "MANAGER";
    return "OPERATOR";
  }

  return {
    normalizePaymentMethod,
    normalizePaymentTerminal,
    normalizeSideBarMode,
    normalizeSmartAccessLogEntry,
    normalizeSmartBalances,
    normalizeSmartCapabilities,
    normalizeSmartCashSettings,
    normalizeSmartCustomer,
    normalizeSmartPass,
    normalizeSmartTransactionEntry,
    resolveAuditActorRole,
    sanitizePaymentMethods,
    sanitizePaymentTerminals,
    sanitizeSmartCustomer,
    sanitizeSmartNonFiscalEntry,
  };
}
