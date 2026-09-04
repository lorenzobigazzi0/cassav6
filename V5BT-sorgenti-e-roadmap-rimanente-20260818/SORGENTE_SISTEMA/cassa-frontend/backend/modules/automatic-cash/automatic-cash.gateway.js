const DEFAULT_TIMEOUT_MS = 120_000;

function normalizeText(value, limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function joinUrl(baseUrl, path) {
  const base = normalizeText(baseUrl).replace(/\/+$/, "");
  const suffix = normalizeText(path).replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function isFalseFlag(value) {
  return value === false || value === 0 || String(value).trim().toLowerCase() === "false";
}

function isTrueFlag(value) {
  return value === true || value === 1 || String(value).trim().toLowerCase() === "true";
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function centsFromValue(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  return Math.max(0, Math.round(Number(fallback) || 0));
}

function paymentAmountPayload({
  expectedTotalCents = 0,
  depositedTotalCents = 0,
  changeDueCents = 0,
} = {}) {
  const expected = centsFromValue(expectedTotalCents, 0);
  const deposited = centsFromValue(depositedTotalCents, 0);
  const change = centsFromValue(
    changeDueCents,
    Math.max(0, deposited - expected),
  );
  return {
    currency: "EUR",
    expectedTotalCents: expected,
    totalDueCents: expected,
    amountDueCents: expected,
    totalToPayCents: expected,
    TotalToPay: expected,
    TotalToPayCents: expected,
    depositedTotalCents: deposited,
    totalInsertedCents: deposited,
    TotalInserted: deposited,
    TotalInsertedCents: deposited,
    changeDueCents: change,
    totalChangeCents: change,
    ChangeDue: change,
    ChangeDueCents: change,
  };
}

function normalizeInventoryRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Inventario gateway mancante o non valido.");
  }
  const byCents = new Map();
  const listCassette = [];
  for (const raw of rows) {
    const row = raw && typeof raw === "object" ? raw : {};
    const cents = Number(row.Value_Money ?? row.ValueMoney ?? row.Value ?? row.value ?? row.denominationCents);
    const stock = Number(row.Stock ?? row.stock ?? row.pieces);
    const exists = row.IsExist === undefined ? true : !isFalseFlag(row.IsExist);
    const empty = row.IsEmpty === undefined ? false : isTrueFlag(row.IsEmpty);
    if (!Number.isInteger(cents) || cents <= 0) continue;
    if (!Number.isInteger(stock) || stock < 0) continue;
    const safeStock = exists && !empty ? stock : 0;
    if (safeStock > 0) {
      byCents.set(cents, (byCents.get(cents) ?? 0) + safeStock);
    }
    listCassette.push({
      Value_Money: cents,
      Stock: safeStock,
      IsExist: exists,
      IsEmpty: empty || safeStock === 0,
    });
  }
  return {
    byCents,
    listCassette,
  };
}

function normalizeGatewayState(rawState) {
  const state = rawState && typeof rawState === "object" ? rawState : {};
  const inventory = state.inventory && typeof state.inventory === "object" ? state.inventory : {};
  const rows = Array.isArray(inventory.listCassette)
    ? inventory.listCassette
    : Array.isArray(inventory.cassettes)
      ? inventory.cassettes
      : [];
  const normalized = normalizeInventoryRows(rows);
  return {
    ok: true,
    mode: normalizeText(state.mode, 40).toUpperCase() || null,
    inventory: {
      ok: inventory.ok !== false,
      error: normalizeText(inventory.error) || null,
      listCassette: normalized.listCassette,
    },
    activeOperation: state.activeOperation ?? null,
    deposit: state.deposit ?? null,
    raw: state,
    updatedAtMs: Date.now(),
  };
}

function toGatewayListCassette(pieces = {}) {
  return Object.entries(pieces)
    .map(([rawCents, rawQuantity]) => {
      const cents = toInteger(rawCents);
      const quantity = toInteger(rawQuantity);
      if (cents === null || quantity === null || cents <= 0 || quantity <= 0) {
        return null;
      }
      return {
        Value_Money: cents,
        Stock: quantity,
      };
    })
    .filter(Boolean);
}

function normalizeChangeAvailabilityRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((raw) => {
      const row = raw && typeof raw === "object" ? raw : {};
      const cents = toInteger(
        row.cents ??
          row.Value_Money ??
          row.ValueMoney ??
          row.Value ??
          row.value ??
          row.denominationCents,
      );
      const availablePieces = toInteger(
        row.availablePieces ??
          row.Stock ??
          row.stock ??
          row.pieces ??
          row.Quantity ??
          row.quantity ??
          row.Count ??
          row.count,
      );
      if (cents === null || availablePieces === null || cents <= 0 || availablePieces < 0) {
        return null;
      }
      return {
        cents,
        availablePieces,
        label: normalizeText(row.label, 80) || undefined,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.cents - left.cents);
}

function normalizeChangeAvailabilityPayload(payload = {}) {
  const roots = [
    payload.availableDenominations,
    payload.listCassette,
    payload.listCassetteGive,
    payload.cassettesMonitor,
    payload.cassettes,
    payload.Give,
    payload.give,
    payload?.raw?.resultTransaction?.Give,
    payload?.raw?.resultTransaction?.give,
  ];
  for (const rows of roots) {
    const normalized = normalizeChangeAvailabilityRows(rows);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text().catch(() => "");
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    const message = normalizeText(body?.message ?? body?.error ?? text) || fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body ?? {};
}

function isNoActiveRealOperationError(error) {
  const status = Number(error?.status);
  if (status !== 409 && status !== 404) return false;
  const message = normalizeText(
    error?.body?.message ?? error?.body?.error ?? error?.message,
    500,
  ).toLowerCase();
  return (
    message.includes("nessuna operazione reale attiva") ||
    message.includes("nessuna operazione attiva") ||
    message.includes("no active operation")
  );
}

function isEndpointNotFoundError(error) {
  return Number(error?.status) === 404;
}

function hasHeader(headers, name) {
  const expected = String(name ?? "").trim().toLowerCase();
  if (!expected || !headers || typeof headers !== "object") return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function buildRequestHeaders(options = {}) {
  const hasBody = options.body !== undefined && options.body !== null;
  const method = normalizeText(options.method || "GET", 20).toUpperCase();
  const headers = {
    Accept: "application/json",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };
  if (
    !hasBody &&
    ["POST", "PUT", "PATCH"].includes(method) &&
    !hasHeader(headers, "Content-Length")
  ) {
    headers["Content-Length"] = "0";
  }
  return headers;
}

export function createAutomaticCashGatewayClient({
  baseUrl = "",
  username = "",
  password = "",
  fetchWithTimeout = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  enabled = false,
  requireRealMode = false,
  logger = console,
} = {}) {
  let cachedToken = "";
  let cachedTokenAtMs = 0;
  const configured = enabled === true && Boolean(normalizeText(baseUrl));

  async function request(path, options = {}) {
    if (!configured) {
      throw new Error("Gateway cassa automatica non configurato.");
    }
    const response = await fetchWithTimeout(joinUrl(baseUrl, path), {
      timeoutMs,
      ...options,
      headers: buildRequestHeaders(options),
    });
    return readJsonResponse(response, `Richiesta gateway non riuscita: ${path}`);
  }

  async function login() {
    if (cachedToken && Date.now() - cachedTokenAtMs < 20 * 60_000) {
      return cachedToken;
    }
    const payload = await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: {},
    });
    const token = normalizeText(payload.token ?? payload.sessionToken ?? payload.session_token);
    if (!token) {
      throw new Error("Login gateway riuscito senza token sessione.");
    }
    cachedToken = token;
    cachedTokenAtMs = Date.now();
    return token;
  }

  async function authenticatedUnchecked(path, options = {}) {
    const token = await login();
    try {
      return await request(path, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          "X-Session-Token": token,
        },
      });
    } catch (error) {
      if (Number(error?.status) === 401 || Number(error?.status) === 403) {
        cachedToken = "";
        cachedTokenAtMs = 0;
        const nextToken = await login();
        return request(path, {
          ...options,
          headers: {
            ...(options.headers ?? {}),
            "X-Session-Token": nextToken,
          },
        });
      }
      throw error;
    }
  }

  async function assertRealGatewayMode() {
    if (requireRealMode !== true) return;
    const state = await authenticatedUnchecked("/api/state", {
      method: "GET",
      cache: "no-store",
    });
    const reportedMode = normalizeText(state?.mode, 40).toUpperCase();
    if (reportedMode === "REAL") return;

    const error = new Error(
      `Gateway cassa automatica non in modalita REAL (mode: ${reportedMode || "mancante"}).`,
    );
    error.code = "AUTOMATIC_CASH_REAL_MODE_REQUIRED";
    error.status = 503;
    error.statusCode = 503;
    error.details = {
      expectedMode: "REAL",
      reportedMode: reportedMode || null,
    };
    throw error;
  }

  async function authenticated(path, options = {}) {
    const method = normalizeText(options.method || "GET", 20).toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      await assertRealGatewayMode();
    }
    return authenticatedUnchecked(path, options);
  }

  async function authenticatedFirstAvailable(paths, options = {}) {
    let lastEndpointError = null;
    for (const path of paths) {
      try {
        return await authenticated(path, options);
      } catch (error) {
        if (!isEndpointNotFoundError(error)) {
          throw error;
        }
        lastEndpointError = error;
      }
    }
    throw lastEndpointError ?? new Error("Endpoint gateway non trovato.");
  }

  async function refreshInventory() {
    await authenticated("/api/inventory/refresh", { method: "POST" });
    const state = await authenticated("/api/state", { method: "GET", cache: "no-store" });
    return normalizeGatewayState(state);
  }

  async function getState() {
    const state = await authenticated("/api/state", { method: "GET", cache: "no-store" });
    return normalizeGatewayState(state);
  }

  async function executeWithdrawal({ pieces = {}, note = "" } = {}) {
    return authenticated("/api/withdrawal/execute", {
      method: "POST",
      body: JSON.stringify({
        pieces,
        note,
        confirm: "PRELEVA_REALE",
      }),
    });
  }

  async function confirmWithdrawalRemoved() {
    try {
      return await authenticated("/api/withdrawal/remove", { method: "POST" });
    } catch (error) {
      if (isNoActiveRealOperationError(error)) {
        return {
          ok: true,
          alreadyClosed: true,
          message: "Nessuna operazione reale attiva: ritiro gia confermato dal gateway.",
        };
      }
      throw error;
    }
  }

  async function startReplenishment() {
    return authenticated("/api/replenishment/start", {
      method: "POST",
      body: JSON.stringify({ source: "entrance" }),
    });
  }

  async function closeReplenishment() {
    const payload = await authenticated("/api/replenishment/close", { method: "POST" });
    const state = await getState().catch((error) => {
      logger?.warn?.("[automatic-cash] lettura stato deposito dopo close fallita", error?.message ?? error);
      return null;
    });
    return { payload, state };
  }

  async function startCashinChange({ operationId = "", userId = "", note = "" } = {}) {
    return authenticated("/api/cashin/start", {
      method: "POST",
      body: JSON.stringify({
        typeOperation: "Cambio",
        operationId,
        userId,
        note,
      }),
    });
  }

  async function startCashinPayment({
    operationId = "",
    userId = "",
    note = "",
    expectedTotalCents = 0,
    activityId = "",
    roomId = "",
  } = {}) {
    return authenticated("/api/cashin/start", {
      method: "POST",
      body: JSON.stringify({
        typeOperation: "Pagamento",
        operationKind: "payment",
        operationId,
        userId,
        note,
        activityId,
        roomId,
        ...paymentAmountPayload({ expectedTotalCents }),
      }),
    });
  }

  async function getCashinDeposit({ operationId = "" } = {}) {
    const query = operationId ? `?operationId=${encodeURIComponent(operationId)}` : "";
    const payload = await authenticated(`/api/cashin/deposit${query}`, {
      method: "GET",
      cache: "no-store",
    });
    const state = await getState().catch((error) => {
      logger?.warn?.("[automatic-cash] lettura stato deposito cambio fallita", error?.message ?? error);
      return null;
    });
    return { payload, state };
  }

  async function getReturnChange({ totalToChangeCents = 0, operationId = "" } = {}) {
    const payload = await authenticated("/api/change/return-change", {
      method: "POST",
      body: JSON.stringify({
        TotalToChange: totalToChangeCents,
        totalToChangeCents,
        operationId,
      }),
    });
    return {
      ...payload,
      availableDenominations: normalizeChangeAvailabilityPayload(payload),
    };
  }

  async function executeNativeChange({ pieces = {}, operationId = "", note = "" } = {}) {
    const listCassette = toGatewayListCassette(pieces);
    return authenticated("/api/change/execute", {
      method: "POST",
      body: JSON.stringify({
        operationId,
        note,
        pieces,
        listCassette,
        listCassetteGive: listCassette,
      }),
    });
  }

  async function getChangeRemoved({ operationId = "" } = {}) {
    try {
      return await authenticated("/api/change/removed", {
        method: "POST",
        body: JSON.stringify({ operationId }),
      });
    } catch (error) {
      if (isNoActiveRealOperationError(error)) {
        return {
          ok: true,
          alreadyClosed: true,
          message: "Nessuna operazione reale attiva: cambio gia confermato dal gateway.",
        };
      }
      throw error;
    }
  }

  async function cancelCashinChange({ operationId = "" } = {}) {
    try {
      return await authenticated("/api/cashin/cancel", {
        method: "POST",
        body: JSON.stringify({
          typeOperation: "Cambio",
          operationId,
        }),
      });
    } catch (error) {
      if (isNoActiveRealOperationError(error)) {
        return {
          ok: true,
          alreadyClosed: true,
          message: "Nessuna operazione reale attiva: cambio gia chiuso dal gateway.",
        };
      }
      throw error;
    }
  }

  async function cancelCashinPayment({ operationId = "" } = {}) {
    try {
      return await authenticated("/api/cashin/cancel", {
        method: "POST",
        body: JSON.stringify({
          typeOperation: "Pagamento",
          operationId,
        }),
      });
    } catch (error) {
      if (isNoActiveRealOperationError(error)) {
        return {
          ok: true,
          alreadyClosed: true,
          message: "Nessuna operazione reale attiva: pagamento contanti gia chiuso dal gateway.",
        };
      }
      throw error;
    }
  }

  async function completeCashinPayment({
    operationId = "",
    expectedTotalCents = 0,
    depositedTotalCents = 0,
    changeDueCents = 0,
  } = {}) {
    try {
      return await authenticatedFirstAvailable(
        [
          "/api/cashin/complete",
          "/api/cashin/close",
          "/api/cashin/confirm",
          "/api/cashin/end",
        ],
        {
          method: "POST",
          body: JSON.stringify({
            typeOperation: "Pagamento",
            operationKind: "payment",
            operationId,
            ...paymentAmountPayload({
              expectedTotalCents,
              depositedTotalCents,
              changeDueCents,
            }),
          }),
        },
      );
    } catch (error) {
      if (isNoActiveRealOperationError(error)) {
        return {
          ok: true,
          alreadyClosed: true,
          message: "Nessuna operazione reale attiva: pagamento contanti gia chiuso dal gateway.",
        };
      }
      throw error;
    }
  }

  async function cancelReplenishment() {
    try {
      return await authenticated("/api/replenishment/cancel", { method: "POST" });
    } catch (error) {
      if (isNoActiveRealOperationError(error)) {
        return {
          ok: true,
          alreadyClosed: true,
          message: "Nessuna operazione reale attiva: deposito gia chiuso dal gateway.",
        };
      }
      throw error;
    }
  }

  async function restartMachine({ reason = "", requestedBy = "" } = {}) {
    return authenticatedFirstAvailable(
      ["/api/machine/restart", "/api/machine/reboot", "/api/system/restart", "/api/restart"],
      {
        method: "POST",
        body: JSON.stringify({
          reason: normalizeText(reason, 160),
          requestedBy: normalizeText(requestedBy, 120),
          source: "cassa-v4",
        }),
      },
    );
  }

  async function resetMachine({ reason = "", requestedBy = "" } = {}) {
    return authenticatedFirstAvailable(
      ["/api/machine/reset", "/api/system/reset", "/api/reset"],
      {
        method: "POST",
        body: JSON.stringify({
          reason: normalizeText(reason, 160),
          requestedBy: normalizeText(requestedBy, 120),
          source: "cassa-v4",
        }),
      },
    );
  }

  return {
    configured,
    requireRealMode: requireRealMode === true,
    refreshInventory,
    getState,
    executeWithdrawal,
    confirmWithdrawalRemoved,
    startReplenishment,
    closeReplenishment,
    startCashinChange,
    startCashinPayment,
    getCashinDeposit,
    getReturnChange,
    executeNativeChange,
    getChangeRemoved,
    cancelCashinChange,
    cancelCashinPayment,
    completeCashinPayment,
    cancelReplenishment,
    restartMachine,
    resetMachine,
  };
}
