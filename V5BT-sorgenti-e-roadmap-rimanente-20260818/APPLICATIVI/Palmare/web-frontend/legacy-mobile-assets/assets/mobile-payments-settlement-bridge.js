(function () {
  if (window.__mobilePaymentsSettlementBridgeInstalled === true) return;
  window.__mobilePaymentsSettlementBridgeInstalled = true;

  const SECTION_ID = "mobile-payments-settlement-section";
  const MODAL_ID = "mobile-payments-settlement-modal";
  const PRIMARY_STATION = "BAR PRINCIPALE";
  const ANALYTICS_KEY = "pos_analytics_transactions_v1";
  const POS_ID_KEY = "payment_pos_id";
  const CASH_FLOAT_KEY = "payment_cash_float";
  const CASH_FLOAT_LOCKED_KEY = "payment_cash_float_locked";
  const TOKEN_KEY = "pos_token";
  const USER_ID_KEY = "pos_user_id";
  const USERNAME_KEY = "pos_user";
  const FULL_NAME_KEY = "pos_full_name";
  const ROOM_ID_KEY = "pos_room_id";
  const ROOM_NAME_KEY = "pos_room_name";
  const SESSION_STARTED_AT_KEY = "pos_session_started_at";
  const DEVICE_UUID_KEY = "pos_device_uuid";
  const SETTLEMENT_CUTOFF_PREFIX = "payment_settlement_cutoff_v1";
  const SETTLEMENT_SUMMARY_PREFIX = "payment_settlement_summary_v1";
  const RESET_KEYS = [POS_ID_KEY, CASH_FLOAT_KEY, CASH_FLOAT_LOCKED_KEY];
  const POS_LABELS = {
    pos_main: "POS Cassa Principale",
    pos_terrace: "POS Terrazza",
    pos_mobile: "POS Mobile",
  };

  let started = false;
  let queued = false;
  let modalState = {
    open: false,
    phase: "confirm",
    printing: false,
    finishing: false,
    error: "",
    printedAtLabel: "",
    completedAtLabel: "",
    authRequestId: "",
    authUsername: "",
    authPin: "",
    authBusy: false,
    snapshot: null,
  };
  const MutationObserverCtor = typeof window.MutationObserver === "function" ? window.MutationObserver : null;

  function safeAnimationFrame(callback) {
    if (typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(callback);
    }
    return window.setTimeout(() => callback(Date.now()), 16);
  }

  function readStorageValue(key) {
    try {
      const localValue = window.localStorage.getItem(key);
      if (localValue !== null) return localValue;
    } catch {
      // noop
    }
    try {
      const sessionValue = window.sessionStorage.getItem(key);
      if (sessionValue !== null) return sessionValue;
    } catch {
      // noop
    }
    return null;
  }

  function writeStorageValue(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // noop
    }
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // noop
    }
  }

  function removeStorageValue(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // noop
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // noop
    }
  }

  function emitEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      // noop
    }
  }

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function sanitizeTokenPart(value, fallback) {
    const normalized = normalizeText(value).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    if (!normalized) return fallback;
    return normalized.slice(0, 40);
  }

  function parseMoney(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : NaN;
    }
    if (typeof value !== "string") return NaN;
    const trimmed = value.trim();
    if (!trimmed) return NaN;
    const compact = trimmed.replace(/\s+/g, "").replace(/[^\d,.-]/g, "");
    let normalized = compact;
    if (compact.includes(",") && compact.includes(".")) {
      normalized = compact.replace(/\./g, "").replace(/,/g, ".");
    } else if (compact.includes(",")) {
      normalized = compact.replace(/,/g, ".");
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function money(value) {
    const safe = roundMoney(value);
    try {
      return new Intl.NumberFormat("it-IT", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(safe);
    } catch {
      return `${safe.toFixed(2)} EUR`;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function dateTimeLabel(timestampMs) {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "--";
    try {
      return new Intl.DateTimeFormat("it-IT", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(timestampMs);
    } catch {
      return new Date(timestampMs).toLocaleString("it-IT");
    }
  }

  function resolveTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 1e12) return Math.trunc(value);
      if (value > 1e9) return Math.trunc(value * 1000);
      return NaN;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return NaN;
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return resolveTimestamp(numeric);
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
  }

  function parseJsonArray(rawValue) {
    if (!rawValue) return [];
    try {
      const parsed = JSON.parse(rawValue);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function normalizeMethod(value) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return "other";
    if (normalized === "cash" || normalized.includes("contant") || normalized.includes("cash")) {
      return "cash";
    }
    if (
      normalized === "card" ||
      normalized === "pos" ||
      normalized.includes("carta") ||
      normalized.includes("card") ||
      normalized.includes("bancomat") ||
      normalized.includes("pos")
    ) {
      return "pos";
    }
    return "other";
  }

  function resolveRecordMethod(record) {
    return normalizeMethod(
      record?.paymentMethod ??
        record?.method ??
        record?.paymentType ??
        record?.receiptType ??
        record?.tenderType ??
        record?.kind ??
        record?.type ??
        ""
    );
  }

  function resolveRecordAmount(record) {
    const candidates = [
      record?.amount,
      record?.total,
      record?.paidAmount,
      record?.totalAmount,
      record?.netAmount,
      record?.finalAmount,
      record?.value,
      record?.paymentAmount,
    ];
    for (const candidate of candidates) {
      const parsed = parseMoney(candidate);
      if (Number.isFinite(parsed)) return Math.max(0, roundMoney(parsed));
    }
    return 0;
  }

  function resolveRecordTimestamp(record) {
    const candidates = [
      record?.createdAt,
      record?.timestamp,
      record?.paidAt,
      record?.updatedAt,
      record?.dateTime,
      record?.at,
    ];
    for (const candidate of candidates) {
      const parsed = resolveTimestamp(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
    return NaN;
  }

  function normalizeComparableName(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function resolveRecordKind(record) {
    return normalizeText(record?.kind ?? record?.type ?? record?.eventType ?? record?.action).toLowerCase();
  }

  function resolveRecordStatus(record) {
    return normalizeText(record?.status ?? record?.paymentStatus ?? record?.state).toLowerCase();
  }

  function isPaymentRecord(record, context, cutoffMs) {
    if (!record || typeof record !== "object") return false;

    const kind = resolveRecordKind(record);
    const status = resolveRecordStatus(record);
    const amount = resolveRecordAmount(record);

    if (!amount || amount <= 0) return false;
    if (kind.includes("cash_float")) return false;
    if (kind.includes("float_locked")) return false;

    if (status) {
      const failed =
        status.includes("cancel") ||
        status.includes("annull") ||
        status.includes("void") ||
        status.includes("fail") ||
        status.includes("error") ||
        status.includes("deleted") ||
        status.includes("draft");
      const successful =
        status.includes("paid") ||
        status.includes("success") ||
        status.includes("complete") ||
        status.includes("ok");
      if (failed && !successful) return false;
    }

    const operatorId = normalizeText(record?.operatorId ?? record?.userId ?? record?.cashierId);
    if (context.userId && operatorId && operatorId !== context.userId) return false;

    if (!operatorId && (context.fullName || context.username)) {
      const recordName = normalizeComparableName(
        record?.operatorName ?? record?.cashierName ?? record?.userName ?? record?.username
      );
      if (recordName) {
        const ctxFullName = normalizeComparableName(context.fullName);
        const ctxUsername = normalizeComparableName(context.username);
        if (recordName !== ctxFullName && recordName !== ctxUsername) return false;
      }
    }

    // Il token cambia a ogni logout/login, ma lo scarico operativo resta lo stesso
    // finche non viene terminato: utente e cutoff temporale sono il perimetro corretto.
    const shiftToken = normalizeText(record?.shiftToken ?? record?.sessionToken ?? record?.posToken ?? record?.token);
    if (context.token && shiftToken && shiftToken !== context.token) {
      const hasOperatorIdentity =
        Boolean(operatorId) ||
        normalizeText(record?.operatorName ?? record?.cashierName ?? record?.userName ?? record?.username).length > 0;
      if (!hasOperatorIdentity) return false;
    }

    const timestampMs = resolveRecordTimestamp(record);
    if (Number.isFinite(timestampMs) && Number.isFinite(cutoffMs) && timestampMs < cutoffMs) {
      return false;
    }

    const hasPaymentSignals =
      kind.includes("payment") ||
      kind.includes("checkout") ||
      kind.includes("collect") ||
      kind.includes("charge") ||
      normalizeText(record?.paymentMethod ?? record?.method ?? record?.paymentType).length > 0;

    return hasPaymentSignals;
  }

  function resolvePosLabel(posId) {
    const normalized = normalizeText(posId);
    if (!normalized) return "Nessun POS";
    return POS_LABELS[normalized] || normalized;
  }

  function buildContext() {
    const token = normalizeText(readStorageValue(TOKEN_KEY));
    const userId = normalizeText(readStorageValue(USER_ID_KEY));
    const username = normalizeText(readStorageValue(USERNAME_KEY));
    const fullName = normalizeText(readStorageValue(FULL_NAME_KEY)) || username || "Operatore";
    const roomId = normalizeText(readStorageValue(ROOM_ID_KEY));
    const roomName = normalizeText(readStorageValue(ROOM_NAME_KEY));
    const sessionStartedAt = resolveTimestamp(readStorageValue(SESSION_STARTED_AT_KEY));
    const deviceUuid = normalizeText(readStorageValue(DEVICE_UUID_KEY));
    const posId = normalizeText(readStorageValue(POS_ID_KEY));
    const cashFloat = Math.max(0, roundMoney(parseMoney(readStorageValue(CASH_FLOAT_KEY))));
    const cashFloatLocked = normalizeText(readStorageValue(CASH_FLOAT_LOCKED_KEY)) === "1";
    return {
      token,
      userId,
      username,
      fullName,
      roomId,
      roomName,
      sessionStartedAt: Number.isFinite(sessionStartedAt) ? sessionStartedAt : 0,
      deviceUuid,
      posId,
      cashFloat,
      cashFloatLocked,
    };
  }

  function getSettlementCutoffKey(context) {
    const userPart = sanitizeTokenPart(context.userId, "anon");
    const tokenPart = sanitizeTokenPart(context.token, "session");
    return `${SETTLEMENT_CUTOFF_PREFIX}:${userPart}:${tokenPart}`;
  }

  function getSettlementSummaryKey(context) {
    const userPart = sanitizeTokenPart(context.userId || context.username, "anon");
    const devicePart = sanitizeTokenPart(context.deviceUuid, "device");
    return `${SETTLEMENT_SUMMARY_PREFIX}:${userPart}:${devicePart}`;
  }

  function readSettlementSummary(context) {
    const rawValue = readStorageValue(getSettlementSummaryKey(context));
    if (!rawValue) return null;
    try {
      const parsed = JSON.parse(rawValue);
      if (!parsed || typeof parsed !== "object") return null;
      const completedAtMs = resolveTimestamp(parsed.completedAtMs);
      return {
        completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : 0,
        generatedAtMs: resolveTimestamp(parsed.generatedAtMs),
        posLabel: normalizeText(parsed.posLabel) || "Nessun POS",
        paymentCount: Math.max(0, Math.trunc(Number(parsed.paymentCount) || 0)),
        cashFloat: roundMoney(Math.max(Number(parsed.cashFloat) || 0, 0)),
        cashTotal: roundMoney(Math.max(Number(parsed.cashTotal) || 0, 0)),
        posTotal: roundMoney(Math.max(Number(parsed.posTotal) || 0, 0)),
        otherTotal: roundMoney(Math.max(Number(parsed.otherTotal) || 0, 0)),
        totalAmount: roundMoney(Math.max(Number(parsed.totalAmount) || 0, 0)),
        drawerGross: roundMoney(Math.max(Number(parsed.drawerGross) || 0, 0)),
        amountToDeposit: roundMoney(Math.max(Number(parsed.amountToDeposit) || 0, 0)),
        authorizationRequired: parsed.authorizationRequired === true,
        authorizationApprover: normalizeText(parsed.authorizationApprover),
        authorizationRoomName: normalizeText(parsed.authorizationRoomName),
        authorizationPendingCount: Math.max(0, Math.trunc(Number(parsed.authorizationPendingCount) || 0)),
        authorizationPendingTotal: roundMoney(Math.max(Number(parsed.authorizationPendingTotal) || 0, 0)),
      };
    } catch {
      return null;
    }
  }

  function persistSettlementSummary(snapshot, completedAtMs) {
    if (!snapshot || !snapshot.context) return;
    const safeCompletedAtMs = Number.isFinite(completedAtMs) && completedAtMs > 0 ? completedAtMs : Date.now();
    writeStorageValue(
      getSettlementSummaryKey(snapshot.context),
      JSON.stringify({
        completedAtMs: safeCompletedAtMs,
        generatedAtMs: snapshot.generatedAtMs,
        posLabel: snapshot.posLabel,
        paymentCount: snapshot.paymentCount,
        cashFloat: snapshot.cashFloat,
        cashTotal: snapshot.cashTotal,
        posTotal: snapshot.posTotal,
        otherTotal: snapshot.otherTotal,
        totalAmount: snapshot.totalAmount,
        drawerGross: snapshot.drawerGross,
        amountToDeposit: snapshot.amountToDeposit,
        authorizationRequired: !!snapshot.authorization?.approved,
        authorizationApprover: normalizeText(snapshot.authorization?.approverLabel),
        authorizationRoomName: normalizeText(snapshot.pendingRoomBills?.roomName),
        authorizationPendingCount: Math.max(0, Math.trunc(Number(snapshot.pendingRoomBills?.count) || 0)),
        authorizationPendingTotal: roundMoney(Math.max(Number(snapshot.pendingRoomBills?.totalDue) || 0, 0)),
      })
    );
  }

  function clearSettlementSummary(context) {
    if (!context) return false;
    const key = getSettlementSummaryKey(context);
    const existing = readStorageValue(key);
    if (!existing) return false;
    removeStorageValue(key);
    return true;
  }

  function getCashFloatDraftValue() {
    const input = document.getElementById("cash-float-input");
    if (!(input instanceof HTMLInputElement)) return "";
    return normalizeText(input.value);
  }

  function shouldHideSettlementSummary(context) {
    if (!readSettlementSummary(context)) return false;
    if (normalizeText(context?.posId)) return true;
    if (context?.cashFloatLocked && Number(context?.cashFloat) > 0) return true;
    return getCashFloatDraftValue().length > 0;
  }

  function buildSettlementSnapshot() {
    const context = buildContext();
    const cutoffKey = getSettlementCutoffKey(context);
    const storedCutoff = resolveTimestamp(readStorageValue(cutoffKey));
    const cutoffMs = Math.max(context.sessionStartedAt || 0, Number.isFinite(storedCutoff) ? storedCutoff : 0);
    const records = parseJsonArray(readStorageValue(ANALYTICS_KEY)).filter((record) =>
      isPaymentRecord(record, context, cutoffMs)
    );

    let cashTotal = 0;
    let posTotal = 0;
    let otherTotal = 0;
    let lastPaymentAt = 0;

    records.forEach((record) => {
      const amount = resolveRecordAmount(record);
      const method = resolveRecordMethod(record);
      const timestampMs = resolveRecordTimestamp(record);
      if (Number.isFinite(timestampMs) && timestampMs > lastPaymentAt) {
        lastPaymentAt = timestampMs;
      }
      if (method === "cash") {
        cashTotal += amount;
        return;
      }
      if (method === "pos") {
        posTotal += amount;
        return;
      }
      otherTotal += amount;
    });

    cashTotal = roundMoney(cashTotal);
    posTotal = roundMoney(posTotal);
    otherTotal = roundMoney(otherTotal);

    const totalAmount = roundMoney(cashTotal + posTotal + otherTotal);
    const cashFloat = roundMoney(context.cashFloat);
    const drawerGross = roundMoney(cashFloat + cashTotal);
    const amountToDeposit = roundMoney(Math.max(drawerGross - cashFloat, 0));
    const generatedAtMs = Date.now();

    return {
      context,
      cutoffKey,
      cutoffMs,
      generatedAtMs,
      paymentCount: records.length,
      lastPaymentAt,
      posLabel: resolvePosLabel(context.posId),
      cashFloat,
      cashFloatLocked: context.cashFloatLocked,
      cashTotal,
      posTotal,
      otherTotal,
      totalAmount,
      drawerGross,
      amountToDeposit,
      station: PRIMARY_STATION,
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || payload.ok === false) {
      throw new Error(normalizeText(payload.error) || "Operazione non riuscita.");
    }
    return payload;
  }

  function summarizePendingRoomBills(context, layoutPayload) {
    const rooms = Array.isArray(layoutPayload?.rooms) ? layoutPayload.rooms : [];
    const tables = Array.isArray(layoutPayload?.tables) ? layoutPayload.tables : [];
    const room =
      rooms.find((entry) => normalizeText(entry?.id) === context.roomId) ||
      rooms.find((entry) => normalizeText(entry?.name) === context.roomName) ||
      null;
    const roomId = normalizeText(room?.id) || context.roomId;
    const roomName = normalizeText(room?.name) || context.roomName || "Sala";
    if (!roomId) {
      return {
        roomId: "",
        roomName,
        count: 0,
        totalDue: 0,
        tables: [],
      };
    }

    const pendingTables = tables
      .filter((entry) => normalizeText(entry?.roomId) === roomId)
      .map((entry) => ({
        id: normalizeText(entry?.id),
        number: Math.max(Math.trunc(Number(entry?.number) || 0), 0),
        amountDue: roundMoney(Math.max(Number(entry?.amountDue) || 0, 0)),
      }))
      .filter((entry) => entry.amountDue > 0);

    return {
      roomId,
      roomName,
      count: pendingTables.length,
      totalDue: roundMoney(pendingTables.reduce((sum, entry) => sum + entry.amountDue, 0)),
      tables: pendingTables,
    };
  }

  async function fetchPendingRoomBills(context) {
    const layoutPayload = await fetchJson(`/api/integration/layout?_=${Date.now()}`, {
      headers: {
        Accept: "application/json",
      },
    });
    return summarizePendingRoomBills(context, layoutPayload);
  }

  async function requestSettlementAuthorization(snapshot) {
    const context = snapshot?.context;
    if (!context?.token || !context?.userId || !context?.deviceUuid || !context?.roomId) {
      throw new Error("Sessione sala non valida per l'autorizzazione dello scarico.");
    }

    const payload = await fetchJson("/api/pos/room-change/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        token: context.token,
        userId: context.userId,
        deviceUuid: context.deviceUuid,
        targetRoomId: context.roomId,
      }),
    });

    if (payload.status === "approved") {
      return {
        status: "approved",
        requestId: "",
        approver: {
          username: context.username || context.fullName || "operatore",
          role: "privileged",
          label: context.fullName || context.username || "Operatore autorizzato",
        },
      };
    }

    if (payload.status === "pending" && normalizeText(payload.requestId)) {
      return {
        status: "pending",
        requestId: normalizeText(payload.requestId),
      };
    }

    throw new Error("Autorizzazione scarico non disponibile.");
  }

  async function approveSettlementAuthorization(requestId, context, approverUsername, approverPin) {
    return fetchJson("/api/pos/room-change/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        requestId,
        approverUsername,
        approverPin,
        deviceUuid: context.deviceUuid,
      }),
    });
  }

  async function cancelSettlementAuthorization(requestId) {
    const safeRequestId = normalizeText(requestId);
    if (!safeRequestId) return;
    try {
      await fetchJson("/api/pos/room-change/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          requestId: safeRequestId,
        }),
      });
    } catch {
      // noop
    }
  }

  function withSettlementAuthorization(snapshot, approval) {
    return {
      ...snapshot,
      authorization: {
        approved: true,
        approverUsername: normalizeText(approval?.username),
        approverRole: normalizeText(approval?.role),
        approverLabel: normalizeText(approval?.label) || normalizeText(approval?.username) || "Autorizzatore",
        approvedAtMs: Date.now(),
      },
    };
  }

  function padLine(left, right, width) {
    const safeLeft = normalizeText(left);
    const safeRight = normalizeText(right);
    const minGap = 2;
    if (!safeRight) {
      return safeLeft.slice(0, width);
    }
    const maxLeft = Math.max(0, width - safeRight.length - minGap);
    const finalLeft = safeLeft.length > maxLeft ? safeLeft.slice(0, maxLeft) : safeLeft;
    const spaces = Math.max(minGap, width - finalLeft.length - safeRight.length);
    return `${finalLeft}${" ".repeat(spaces)}${safeRight}`;
  }

  function centerLine(value, width) {
    const safe = normalizeText(value).slice(0, width);
    const leftPad = Math.max(0, Math.floor((width - safe.length) / 2));
    return `${" ".repeat(leftPad)}${safe}`;
  }

  function buildPrintText(snapshot) {
    const width = 42;
    const divider = "-".repeat(width);
    const lines = [
      centerLine("SCARICO CASSA", width),
      "",
      padLine(snapshot.context.fullName || "Operatore", snapshot.posLabel, width),
      dateTimeLabel(snapshot.generatedAtMs),
      divider,
      padLine("TOTALE INCASSATO", money(snapshot.totalAmount), width),
      padLine("CONTANTI", money(snapshot.cashTotal), width),
      padLine("POS", money(snapshot.posTotal), width),
      padLine("ALTRE FORME", money(snapshot.otherTotal), width),
      divider,
      padLine("FONDO CASSA", money(snapshot.cashFloat), width),
      padLine("CASSA LORDA", money(snapshot.drawerGross), width),
      padLine("DA VERSARE", money(snapshot.amountToDeposit), width),
      divider,
      padLine("MOVIMENTI", String(snapshot.paymentCount), width),
    ];

    if (Number.isFinite(snapshot.lastPaymentAt) && snapshot.lastPaymentAt > 0) {
      lines.push(padLine("ULTIMO INCASSO", dateTimeLabel(snapshot.lastPaymentAt), width));
    }

    if (snapshot.authorization?.approved && Number(snapshot.pendingRoomBills?.count) > 0) {
      const pendingTables = Array.isArray(snapshot.pendingRoomBills?.tables)
        ? snapshot.pendingRoomBills.tables
        : [];
      const tableList = pendingTables
        .slice(0, 8)
        .map((entry) => {
          const tableNumber = Math.max(Math.trunc(Number(entry?.number) || 0), 0);
          return tableNumber > 0 ? String(tableNumber) : "?";
        })
        .join(", ");
      lines.push(
        divider,
        "AUTORIZZAZIONE SCARICO",
        padLine("SALA", snapshot.pendingRoomBills.roomName || snapshot.context.roomName || "Sala", width),
        padLine("TAVOLI DA PAGARE", String(snapshot.pendingRoomBills.count), width),
        padLine("TOTALE CONTI SALA", money(snapshot.pendingRoomBills.totalDue), width),
        `TAVOLI: ${tableList}${pendingTables.length > 8 ? ", ..." : ""}`.slice(0, width),
        `APPROVATO DA: ${normalizeText(snapshot.authorization.approverLabel) || "Autorizzatore"}`.slice(0, width)
      );
    }

    lines.push("", "Stampante: BAR PRINCIPALE");
    return lines.join("\n").trim();
  }

  function ensureModalRoot() {
    let root = document.getElementById(MODAL_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = MODAL_ID;
    document.body.appendChild(root);
    return root;
  }

  function closeModal() {
    if (modalState.printing || modalState.finishing || modalState.authBusy) return;
    const requestId = modalState.authRequestId;
    modalState = {
      open: false,
      phase: "confirm",
      printing: false,
      finishing: false,
      error: "",
      printedAtLabel: "",
      completedAtLabel: "",
      authRequestId: "",
      authUsername: "",
      authPin: "",
      authBusy: false,
      snapshot: null,
    };
    renderModal();
    if (requestId) {
      void cancelSettlementAuthorization(requestId);
    }
  }

  function setModalState(nextState) {
    modalState = {
      ...modalState,
      ...nextState,
    };
    renderModal();
  }

  async function printSettlement(snapshot) {
    const headers = {
      "Content-Type": "application/json",
    };

    if (snapshot.context.token) {
      headers.Authorization = `Bearer ${snapshot.context.token}`;
    }

    const response = await fetch("/api/integration/print", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        kind: "preconto",
        clientApp: "mobile-frontend",
        token: snapshot.context.token,
        userId: snapshot.context.userId,
        deviceUuid: snapshot.context.deviceUuid,
        station: PRIMARY_STATION,
        preferredStation: PRIMARY_STATION,
        fallbackStation: PRIMARY_STATION,
        precontoProfile: "cash",
        text: buildPrintText(snapshot),
      }),
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || payload.ok === false) {
      throw new Error(normalizeText(payload.error) || "Stampa scarico non riuscita.");
    }

    return payload;
  }

  async function handlePrint() {
    if (!modalState.snapshot || modalState.printing || modalState.finishing) return;

    setModalState({
      printing: true,
      error: "",
    });

    try {
      await printSettlement(modalState.snapshot);
      setModalState({
        printing: false,
        error: "",
        printedAtLabel: dateTimeLabel(Date.now()),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stampa scarico non riuscita.";
      setModalState({
        printing: false,
        error: message,
      });
    }
  }

  async function completeSettlement(snapshot) {
    const completedSnapshot = snapshot || modalState.snapshot;
    if (!completedSnapshot) return;

    setModalState({
      finishing: true,
      error: "",
      snapshot: completedSnapshot,
    });

    try {
      await printSettlement(completedSnapshot);
      const printedAtMs = Date.now();
      const completedAtMs = printedAtMs;
      persistSettlementSummary(completedSnapshot, completedAtMs);
      writeStorageValue(
        completedSnapshot.cutoffKey,
        String(Math.max(completedSnapshot.generatedAtMs, completedAtMs))
      );
      RESET_KEYS.forEach(removeStorageValue);

      emitEvent("mobile:payment-config-reset", {
        source: "mobile-payments-settlement",
        keys: [...RESET_KEYS],
      });
      emitEvent("mobile:payments:settlement-completed", {
        generatedAtMs: completedSnapshot.generatedAtMs,
        completedAtMs,
        amountToDeposit: completedSnapshot.amountToDeposit,
        totalAmount: completedSnapshot.totalAmount,
      });
      setModalState({
        phase: "completed",
        printing: false,
        finishing: false,
        authBusy: false,
        authRequestId: "",
        authUsername: "",
        authPin: "",
        error: "",
        printedAtLabel: dateTimeLabel(printedAtMs),
        completedAtLabel: dateTimeLabel(completedAtMs),
        snapshot: completedSnapshot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Termina scarico non riuscito.";
      setModalState({
        printing: false,
        finishing: false,
        authBusy: false,
        error: message,
        snapshot: completedSnapshot,
      });
    }
  }

  async function handleFinish() {
    if (!modalState.snapshot || modalState.printing || modalState.finishing || modalState.authBusy) return;
    let snapshot = modalState.snapshot;

    if (!snapshot.authorization?.approved) {
      setModalState({
        finishing: true,
        error: "",
      });

      try {
        const pendingRoomBills = await fetchPendingRoomBills(snapshot.context);
        snapshot = {
          ...snapshot,
          pendingRoomBills,
        };

        if (pendingRoomBills.count > 0) {
          const authorizationRequest = await requestSettlementAuthorization(snapshot);
          if (authorizationRequest.status === "pending") {
            setModalState({
              phase: "authorize",
              printing: false,
              finishing: false,
              authBusy: false,
              authRequestId: authorizationRequest.requestId,
              authUsername: "",
              authPin: "",
              error: "",
              snapshot,
            });
            return;
          }

          snapshot = withSettlementAuthorization(snapshot, authorizationRequest.approver);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Impossibile verificare i tavoli aperti della sala.";
        setModalState({
          printing: false,
          finishing: false,
          authBusy: false,
          error: message,
          snapshot,
        });
        return;
      }
    }

    await completeSettlement(snapshot);
  }

  async function handleAuthorizeAndFinish() {
    if (
      !modalState.snapshot ||
      !modalState.authRequestId ||
      modalState.printing ||
      modalState.finishing ||
      modalState.authBusy
    ) {
      return;
    }

    const approverUsername = normalizeText(modalState.authUsername);
    const approverPin = normalizeText(modalState.authPin);
    if (!approverUsername || !approverPin) {
      setModalState({
        error: "Inserisci utente e PIN dell'autorizzatore.",
      });
      return;
    }

    setModalState({
      authBusy: true,
      error: "",
    });

    try {
      const approvalPayload = await approveSettlementAuthorization(
        modalState.authRequestId,
        modalState.snapshot.context,
        approverUsername,
        approverPin
      );
      const approval = approvalPayload?.approver || {};
      const approvedSnapshot = withSettlementAuthorization(modalState.snapshot, {
        username: approval.username || approverUsername,
        role: approval.role || "",
        label: approval.username || approverUsername,
      });
      setModalState({
        phase: "confirm",
        authBusy: false,
        authRequestId: "",
        authUsername: "",
        authPin: "",
        error: "",
        snapshot: approvedSnapshot,
      });
      await completeSettlement(approvedSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Autorizzazione scarico non riuscita.";
      setModalState({
        authBusy: false,
        error: message,
      });
    }
  }

  function renderModal() {
    const existingRoot = document.getElementById(MODAL_ID);
    if (!modalState.open) {
      if (existingRoot) existingRoot.remove();
      return;
    }

    const snapshot = modalState.snapshot || buildSettlementSnapshot();
    const root = ensureModalRoot();
    const completed = modalState.phase === "completed";
    const authorizing = modalState.phase === "authorize";
    const pendingRoomBills = snapshot.pendingRoomBills || {
      count: 0,
      totalDue: 0,
      tables: [],
      roomName: snapshot.context.roomName || "Sala",
    };
    const pendingTableLabels = Array.isArray(pendingRoomBills.tables)
      ? pendingRoomBills.tables
          .map((entry) => {
            const tableNumber = Math.max(Math.trunc(Number(entry?.number) || 0), 0);
            return tableNumber > 0 ? `Tavolo ${tableNumber}` : "";
          })
          .filter(Boolean)
          .join(", ")
      : "";
    const authorizationLabel = normalizeText(snapshot.authorization?.approverLabel);

    const nextHtml = [
      '<div class="mobile-payments-settlement-backdrop" data-role="backdrop">',
      '  <div class="mobile-payments-settlement-dialog" role="dialog" aria-modal="true" aria-label="Scarico cassa">',
      '    <div class="mobile-payments-settlement-head">',
      `      <strong>${completed ? "Report scarico" : authorizing ? "Autorizzazione scarico" : "Conferma scarico"}</strong>`,
      '      <button type="button" class="smallbtn mobile-payments-settlement-close" data-role="close" aria-label="Chiudi">Chiudi</button>',
      "    </div>",
      '    <div class="mobile-payments-settlement-body">',
      '      <div class="mobile-payments-settlement-meta">',
      `        <span>Operatore: ${snapshot.context.fullName || "Operatore"}</span>`,
      `        <span>POS: ${snapshot.posLabel}</span>`,
      `        <span>Ora: ${dateTimeLabel(snapshot.generatedAtMs)}</span>`,
      "      </div>",
      authorizing
        ? '      <div class="mobile-payments-settlement-summary">'
        : "",
      authorizing
        ? `        <div class="mobile-payments-settlement-row"><span>Sala</span><strong>${escapeHtml(
            pendingRoomBills.roomName || snapshot.context.roomName || "Sala"
          )}</strong></div>`
        : "",
      authorizing
        ? `        <div class="mobile-payments-settlement-row"><span>Tavoli da pagare</span><strong>${pendingRoomBills.count}</strong></div>`
        : "",
      authorizing
        ? `        <div class="mobile-payments-settlement-row"><span>Totale conti aperti</span><strong>${money(
            pendingRoomBills.totalDue
          )}</strong></div>`
        : "",
      authorizing ? "      </div>" : "",
      authorizing && pendingTableLabels
        ? `      <div class="mobile-payments-settlement-note is-warning">Tavoli con conto aperto: ${escapeHtml(
            pendingTableLabels
          )}.</div>`
        : "",
      authorizing
        ? '      <div class="mobile-payments-settlement-note">Per terminare lo scarico con conti ancora aperti in sala serve l&apos;autorizzazione di un responsabile o amministratore. Questo verra segnalato sul report stampato.</div>'
        : "",
      authorizing
        ? '      <div class="mobile-payments-settlement-auth-grid">'
        : "",
      authorizing
        ? `        <label class="mobile-payments-settlement-field"><span>Utente autorizzatore</span><input type="text" data-role="auth-username" autocomplete="username" value="${escapeHtml(
            modalState.authUsername
          )}" placeholder="Username autorizzatore"></label>`
        : "",
      authorizing
        ? `        <label class="mobile-payments-settlement-field"><span>PIN autorizzatore</span><input type="password" data-role="auth-pin" inputmode="numeric" autocomplete="current-password" value="${escapeHtml(
            modalState.authPin
          )}" placeholder="PIN autorizzatore"></label>`
        : "",
      authorizing ? "      </div>" : "",
      completed
        ? '      <div class="mobile-payments-settlement-summary">'
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row"><span>Totale incassato</span><strong>${money(snapshot.totalAmount)}</strong></div>`
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row"><span>Contanti</span><strong>${money(snapshot.cashTotal)}</strong></div>`
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row"><span>POS</span><strong>${money(snapshot.posTotal)}</strong></div>`
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row"><span>Altre forme</span><strong>${money(snapshot.otherTotal)}</strong></div>`
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row"><span>Fondo cassa</span><strong>${money(snapshot.cashFloat)}</strong></div>`
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row"><span>Cassa lorda</span><strong>${money(snapshot.drawerGross)}</strong></div>`
        : "",
      completed
        ? `        <div class="mobile-payments-settlement-row is-highlight"><span>Da versare in cassa</span><strong>${money(snapshot.amountToDeposit)}</strong></div>`
        : "",
      completed ? "      </div>" : "",
      completed && snapshot.authorization?.approved
        ? `      <div class="mobile-payments-settlement-note is-warning">Scarico autorizzato per ${escapeHtml(
            snapshot.pendingRoomBills?.roomName || snapshot.context.roomName || "sala"
          )} con ${Number(snapshot.pendingRoomBills?.count) || 0} tavoli ancora da pagare. Approvato da ${escapeHtml(
            authorizationLabel || "autorizzatore"
          )}.</div>`
        : "",
      completed && modalState.printedAtLabel
        ? `      <div class="mobile-payments-settlement-note is-success">Scarico terminato alle ${modalState.completedAtLabel || modalState.printedAtLabel} e stampato alle ${modalState.printedAtLabel}.</div>`
        : authorizing
          ? ""
          : snapshot.authorization?.approved
            ? `      <div class="mobile-payments-settlement-note is-success">Autorizzazione registrata per la sala ${escapeHtml(
                snapshot.pendingRoomBills?.roomName || snapshot.context.roomName || "Sala"
              )}. Termina per stampare il report e chiudere il turno.</div>`
            : '      <div class="mobile-payments-settlement-note">Premendo Termina lo scarico viene stampato automaticamente su BAR PRINCIPALE, poi azzera fondo cassa e POS usato. Il report completo compare solo dopo il completamento.</div>',
      modalState.error
        ? `      <div class="mobile-payments-settlement-note is-error">${modalState.error}</div>`
        : "",
      "    </div>",
      '    <div class="mobile-payments-settlement-actions">',
      completed
        ? `      <button type="button" class="smallbtn mobile-payments-settlement-btn" data-role="reprint" ${
            modalState.printing || modalState.finishing || modalState.authBusy ? "disabled" : ""
          }>${modalState.printing ? "Ristampa..." : "Ristampa"}</button>`
      : `      <button type="button" class="smallbtn mobile-payments-settlement-btn is-secondary" data-role="cancel" ${
            modalState.printing || modalState.finishing || modalState.authBusy ? "disabled" : ""
          }>Annulla</button>`,
      completed
        ? `      <button type="button" class="smallbtn mobile-payments-settlement-btn is-primary" data-role="close-complete" ${
            modalState.printing || modalState.finishing || modalState.authBusy ? "disabled" : ""
          }>Chiudi</button>`
        : authorizing
          ? `      <button type="button" class="smallbtn mobile-payments-settlement-btn is-primary" data-role="authorize-finish" ${
              modalState.printing || modalState.finishing || modalState.authBusy ? "disabled" : ""
            }>${modalState.authBusy ? "Verifica..." : "Autorizza e termina"}</button>`
          : `      <button type="button" class="smallbtn mobile-payments-settlement-btn is-primary" data-role="finish" ${
              modalState.printing || modalState.finishing || modalState.authBusy ? "disabled" : ""
            }>${modalState.finishing ? "Termina..." : "Termina"}</button>`,
      "    </div>",
      "  </div>",
      "</div>",
    ].join("");
    if (root.__mobilePaymentsSettlementHtml === nextHtml) return;
    root.__mobilePaymentsSettlementHtml = nextHtml;
    root.innerHTML = nextHtml;

    const backdrop = root.querySelector('[data-role="backdrop"]');
    const closeButton = root.querySelector('[data-role="close"]');
    const cancelButton = root.querySelector('[data-role="cancel"]');
    const reprintButton = root.querySelector('[data-role="reprint"]');
    const finishButton = root.querySelector('[data-role="finish"]');
    const closeCompleteButton = root.querySelector('[data-role="close-complete"]');
    const authorizeFinishButton = root.querySelector('[data-role="authorize-finish"]');
    const authUsernameInput = root.querySelector('[data-role="auth-username"]');
    const authPinInput = root.querySelector('[data-role="auth-pin"]');

    if (backdrop instanceof HTMLElement) {
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) closeModal();
      });
    }

    if (closeButton instanceof HTMLButtonElement) {
      closeButton.addEventListener("click", closeModal);
    }

    if (cancelButton instanceof HTMLButtonElement) {
      cancelButton.addEventListener("click", closeModal);
    }

    if (reprintButton instanceof HTMLButtonElement) {
      reprintButton.addEventListener("click", () => {
        void handlePrint();
      });
    }

    if (finishButton instanceof HTMLButtonElement) {
      finishButton.addEventListener("click", () => {
        void handleFinish();
      });
    }

    if (authorizeFinishButton instanceof HTMLButtonElement) {
      authorizeFinishButton.addEventListener("click", () => {
        void handleAuthorizeAndFinish();
      });
    }

    if (authUsernameInput instanceof HTMLInputElement) {
      authUsernameInput.addEventListener("input", (event) => {
        setModalState({
          authUsername: event.currentTarget.value,
          error: "",
        });
      });
    }

    if (authPinInput instanceof HTMLInputElement) {
      authPinInput.addEventListener("input", (event) => {
        setModalState({
          authPin: event.currentTarget.value,
          error: "",
        });
      });
      authPinInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void handleAuthorizeAndFinish();
        }
      });
    }

    if (closeCompleteButton instanceof HTMLButtonElement) {
      closeCompleteButton.addEventListener("click", closeModal);
    }
  }

  function openSettlementModal() {
    modalState = {
      open: true,
      phase: "confirm",
      printing: false,
      finishing: false,
      error: "",
      printedAtLabel: "",
      completedAtLabel: "",
      authRequestId: "",
      authUsername: "",
      authPin: "",
      authBusy: false,
      snapshot: buildSettlementSnapshot(),
    };
    renderModal();
  }

  function ensureSettlementSection() {
    const paymentsScroll = document.querySelector(".payments-scroll");
    if (!(paymentsScroll instanceof HTMLElement)) return;

    const context = buildContext();
    shouldHideSettlementSummary(context) && clearSettlementSummary(context);

    let section = document.getElementById(SECTION_ID);
    if (!(section instanceof HTMLElement)) {
      section = document.createElement("div");
      section.id = SECTION_ID;
      section.className = "payments-section mobile-payments-settlement-section";
      paymentsScroll.appendChild(section);
    }

    const summary = readSettlementSummary(context);
    const nextHtml = [
      '<div class="payments-section-title">Scarico cassa</div>',
      '<div class="mobile-payments-settlement-copy">',
      "  Chiude il turno corrente, stampa il riepilogo su BAR PRINCIPALE e poi azzera POS e fondo cassa.",
      "</div>",
      summary
        ? '<div class="payments-section-title mobile-payments-settlement-history-title">Ultimo scarico completato</div>'
        : "",
      summary
        ? '<div class="mobile-payments-settlement-preview">'
        : "",
      summary
        ? `  <div class="mobile-payments-settlement-preview-card"><span>Da versare</span><strong>${money(summary.amountToDeposit)}</strong></div>`
        : "",
      summary
        ? `  <div class="mobile-payments-settlement-preview-card"><span>Contanti</span><strong>${money(summary.cashTotal)}</strong></div>`
        : "",
      summary
        ? `  <div class="mobile-payments-settlement-preview-card"><span>POS</span><strong>${money(summary.posTotal)}</strong></div>`
        : "",
      summary ? "</div>" : "",
      summary
        ? '<div class="mobile-payments-settlement-meta-line">'
        : "",
      summary
        ? `  <span>Completato: ${dateTimeLabel(summary.completedAtMs)}</span>`
        : "",
      summary
        ? `  <span>POS usato: ${summary.posLabel}</span>`
        : "",
      summary
        ? `  <span>Movimenti: ${summary.paymentCount}</span>`
        : "",
      summary ? "</div>" : "",
      summary && summary.authorizationRequired
        ? `  <div class="mobile-payments-settlement-note is-warning">Scarico autorizzato per ${escapeHtml(
            summary.authorizationRoomName || "sala"
          )} con ${summary.authorizationPendingCount} tavoli da pagare. Approvato da ${escapeHtml(
            summary.authorizationApprover || "autorizzatore"
          )}.</div>`
        : "",
      '<div class="payments-actions mobile-payments-settlement-section-actions">',
      '  <button type="button" class="smallbtn mobile-payments-settlement-launch">Effettua scarico</button>',
      "</div>",
    ].join("");
    if (section.__mobilePaymentsSettlementHtml === nextHtml) return;
    section.__mobilePaymentsSettlementHtml = nextHtml;
    section.innerHTML = nextHtml;

    const button = section.querySelector(".mobile-payments-settlement-launch");
    if (button instanceof HTMLButtonElement) {
      button.addEventListener("click", openSettlementModal);
    }
  }

  function syncPage() {
    const onPaymentsPage = /\/payments\/?$/.test(window.location.pathname);
    if (!onPaymentsPage) {
      if (modalState.open) {
        closeModal();
      }
      const section = document.getElementById(SECTION_ID);
      if (section) section.remove();
      return;
    }
    ensureSettlementSection();
    renderModal();
  }

  function handlePaymentConfigDraftChange() {
    if (!/\/payments\/?$/.test(window.location.pathname)) return;
    const context = buildContext();
    if (!shouldHideSettlementSummary(context)) {
      scheduleSync();
      return;
    }
    clearSettlementSummary(context);
    scheduleSync();
  }

  function scheduleSync() {
    if (queued) return;
    queued = true;
    safeAnimationFrame(() => {
      queued = false;
      syncPage();
    });
  }

  function start() {
    if (started) return;
    started = true;

    if (MutationObserverCtor && document.body) {
      const observer = new MutationObserverCtor(() => {
        scheduleSync();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    if (typeof window.addEventListener === "function") {
      window.addEventListener("popstate", scheduleSync);
      window.addEventListener("hashchange", scheduleSync);
      window.addEventListener("storage", scheduleSync);
      window.addEventListener("mobile:payment-config-reset", scheduleSync);
      window.addEventListener("mobile:payments:settlement-completed", scheduleSync);
      window.addEventListener("input", handlePaymentConfigDraftChange, true);
      window.addEventListener("change", handlePaymentConfigDraftChange, true);
    }
    scheduleSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
