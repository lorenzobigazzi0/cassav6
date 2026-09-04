import {
  buildSettlementLedgerEntries,
  summarizeSettlementLedger,
} from "./settlement-ledger.js";
import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

const SESSION_START_HOUR = 16;
const SESSION_END_HOUR = 2;
const REPORT_WIDTH = 42;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLookup(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function roundMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad2(value) {
  return String(Math.trunc(Number(value) || 0)).padStart(2, "0");
}

function parseDateKey(value) {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDaysToDateKey(dateKey, days) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const date = new Date(parsed.year, parsed.month - 1, parsed.day + Math.trunc(Number(days) || 0), 12, 0, 0, 0);
  return localDateKey(date);
}

function localDateFromKey(dateKey, hour = 0, minute = 0) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  return new Date(parsed.year, parsed.month - 1, parsed.day, hour, minute, 0, 0);
}

export function resolveHandheldOperationalSessionDateKey(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return localDateKey(new Date());
  if (current.getHours() < SESSION_END_HOUR) {
    return addDaysToDateKey(localDateKey(current), -1) ?? localDateKey(current);
  }
  return localDateKey(current);
}

export function getHandheldSessionWindow(dateKey = resolveHandheldOperationalSessionDateKey()) {
  const safeDateKey = parseDateKey(dateKey) ? dateKey : resolveHandheldOperationalSessionDateKey();
  const nextDateKey = addDaysToDateKey(safeDateKey, 1) ?? safeDateKey;
  const start = localDateFromKey(safeDateKey, SESSION_START_HOUR, 0);
  const end = localDateFromKey(nextDateKey, SESSION_END_HOUR, 0);
  return {
    sessionDate: safeDateKey,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startLabel: `${safeDateKey} ${pad2(SESSION_START_HOUR)}:00`,
    endLabel: `${nextDateKey} ${pad2(SESSION_END_HOUR)}:00`,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function sessionDateKeyFromTimestamp(value) {
  const ts = toTimestamp(value);
  if (!ts) return null;
  const date = new Date(ts);
  if (date.getHours() < SESSION_END_HOUR) {
    return addDaysToDateKey(localDateKey(date), -1);
  }
  return localDateKey(date);
}

function timestampIso(value, fallbackIso = "") {
  const ts = toTimestamp(value);
  if (!ts) return fallbackIso;
  return new Date(ts).toISOString();
}

function sessionRecordDateKey(session) {
  return sessionDateKeyFromTimestamp(session?.openedAtMs ?? session?.openedAt ?? session?.createdAt);
}

function normalizeSessionStatus(value) {
  const raw = normalizeLookup(value);
  if (raw === "closed" || raw === "chiuso" || raw === "scaricato") return "closed";
  return "open";
}

function sessionIdentityPart(value, fallback) {
  const normalized = normalizeLookup(value).replace(/\s+/g, "_");
  return (normalized || fallback).slice(0, 48);
}

function buildHandheldCashSessionId({ userId = "", username = "", deviceUuid = "", openedAtMs = 0 } = {}) {
  return [
    "hcs",
    sessionIdentityPart(userId || username, "user"),
    sessionIdentityPart(deviceUuid, "device"),
    Math.max(0, Math.trunc(Number(openedAtMs) || 0)),
  ].join("_");
}

function normalizeHandheldCashSessionRecord(entry, fallbackIndex = 0) {
  if (!entry || typeof entry !== "object") return null;
  const openedAtMs = toTimestamp(entry.openedAtMs ?? entry.openedAt ?? entry.createdAt);
  if (!openedAtMs) return null;
  const closedAtMs = toTimestamp(entry.closedAtMs ?? entry.closedAt);
  const userId = normalizeId(entry.userId ?? entry.actorUserId);
  const username = normalizeText(entry.username ?? entry.actorUsername);
  const deviceUuid = normalizeId(entry.deviceUuid ?? entry.deviceId);
  const id =
    normalizeId(entry.id) ||
    buildHandheldCashSessionId({ userId, username, deviceUuid, openedAtMs }) ||
    `hcs_${fallbackIndex + 1}`;
  const status = closedAtMs > 0 ? "closed" : normalizeSessionStatus(entry.status);
  return {
    id,
    userId,
    username,
    fullName: normalizeText(entry.fullName ?? entry.displayName),
    deviceUuid,
    posId: normalizeId(entry.posId),
    activityId: normalizeId(entry.activityId),
    roomId: normalizeId(entry.roomId),
    roomName: normalizeText(entry.roomName),
    cashFloat: roundMoney(Math.max(Number(entry.cashFloat) || 0, 0)),
    openedAt: timestampIso(openedAtMs),
    openedAtMs,
    closedAt: closedAtMs > 0 ? timestampIso(closedAtMs) : null,
    closedAtMs: closedAtMs > 0 ? closedAtMs : 0,
    status,
    totals: entry.totals && typeof entry.totals === "object" ? { ...entry.totals } : null,
    source: normalizeText(entry.source) || "backend",
    updatedAt: timestampIso(entry.updatedAt ?? entry.closedAt ?? entry.openedAt ?? openedAtMs),
  };
}

export function collectHandheldCashSessions(db = {}) {
  return asArray(db.handheldCashSessions)
    .map((entry, index) => normalizeHandheldCashSessionRecord(entry, index))
    .filter(Boolean)
    .sort((left, right) => left.openedAtMs - right.openedAtMs);
}

function buildCashSessionGroups(db = {}) {
  const groups = new Map();
  collectHandheldCashSessions(db).forEach((session) => {
    const sessionDate = sessionRecordDateKey(session);
    if (!sessionDate) return;
    const current =
      groups.get(sessionDate) ?? {
        sessionDate,
        sessions: [],
        startMs: Number.POSITIVE_INFINITY,
        endMs: 0,
        allClosed: true,
      };
    current.sessions.push(session);
    current.startMs = Math.min(current.startMs, session.openedAtMs);
    if (session.closedAtMs > 0) current.endMs = Math.max(current.endMs, session.closedAtMs);
    else current.allClosed = false;
    groups.set(sessionDate, current);
  });
  return [...groups.values()].map((group) => {
    const fallback = getHandheldSessionWindow(group.sessionDate);
    const endMs = group.allClosed && group.endMs > 0 ? group.endMs : Math.max(group.endMs, fallback.endMs);
    return {
      ...group,
      startMs: Number.isFinite(group.startMs) ? group.startMs : fallback.startMs,
      endMs,
    };
  });
}

export function resolveHandheldSessionReportWindow(db = {}, options = {}) {
  const requestedDate = parseDateKey(options.date)
    ? options.date
    : resolveHandheldOperationalSessionDateKey(options.now);
  const group = buildCashSessionGroups(db).find((entry) => entry.sessionDate === requestedDate);
  if (!group || group.sessions.length === 0) {
    return {
      ...getHandheldSessionWindow(requestedDate),
      source: "fixed_operational_window",
      allCashSessionsClosed: false,
      cashSessions: [],
      printKey: requestedDate,
    };
  }
  const startAt = new Date(group.startMs).toISOString();
  const endAt = new Date(group.endMs).toISOString();
  const printKey = [
    "cash",
    group.sessionDate,
    Math.trunc(group.startMs),
    group.allClosed ? Math.trunc(group.endMs) : "open",
  ].join(":");
  return {
    sessionDate: group.sessionDate,
    startAt,
    endAt,
    startLabel: formatLocalDateTime(startAt),
    endLabel: formatLocalDateTime(endAt),
    startMs: group.startMs,
    endMs: group.endMs,
    source: "cash_sessions",
    allCashSessionsClosed: group.allClosed,
    cashSessions: group.sessions,
    printKey,
  };
}

export function findNextClosedHandheldSessionReport(db = {}, options = {}) {
  const printed = options.printed && typeof options.printed === "object" ? options.printed : {};
  const groups = buildCashSessionGroups(db)
    .filter((group) => group.sessions.length > 0 && group.allClosed && group.endMs > 0)
    .sort((left, right) => left.endMs - right.endMs);
  for (const group of groups) {
    const window = resolveHandheldSessionReportWindow(db, { date: group.sessionDate });
    if (!window.printKey || printed[window.printKey]?.printedAt) continue;
    return {
      sessionDate: group.sessionDate,
      printKey: window.printKey,
      window,
      sessions: group.sessions,
    };
  }
  return null;
}

export function recordHandheldCashSessionOpen(db = {}, input = {}, options = {}) {
  if (!Array.isArray(db.handheldCashSessions)) db.handheldCashSessions = [];
  const nowIso = typeof options.nowIso === "function" ? options.nowIso() : new Date().toISOString();
  const openedAtMs = toTimestamp(input.openedAtMs ?? input.openedAt ?? input.sessionStartedAt) || toTimestamp(nowIso);
  const userId = normalizeId(input.userId);
  const username = normalizeText(input.username);
  const deviceUuid = normalizeId(input.deviceUuid ?? input.deviceId);
  if (!userId && !username) return null;
  const existingIndex = db.handheldCashSessions.findIndex((entry) => {
    const current = normalizeHandheldCashSessionRecord(entry);
    if (!current || current.closedAtMs > 0) return false;
    if (userId && current.userId && current.userId !== userId) return false;
    if (username && current.username && normalizeLookup(current.username) !== normalizeLookup(username)) return false;
    if (deviceUuid && current.deviceUuid && current.deviceUuid !== deviceUuid) return false;
    return true;
  });
  const current = existingIndex >= 0 ? normalizeHandheldCashSessionRecord(db.handheldCashSessions[existingIndex]) : null;
  const next = {
    ...(current ?? {}),
    id: current?.id || buildHandheldCashSessionId({ userId, username, deviceUuid, openedAtMs }),
    userId: userId || current?.userId || "",
    username: username || current?.username || "",
    fullName: normalizeText(input.fullName) || current?.fullName || "",
    deviceUuid: deviceUuid || current?.deviceUuid || "",
    posId: normalizeId(input.posId) || current?.posId || "",
    activityId: normalizeId(input.activityId) || current?.activityId || "",
    roomId: normalizeId(input.roomId) || current?.roomId || "",
    roomName: normalizeText(input.roomName) || current?.roomName || "",
    cashFloat: roundMoney(Math.max(Number(input.cashFloat ?? current?.cashFloat) || 0, 0)),
    openedAt: current?.openedAt || timestampIso(openedAtMs, nowIso),
    openedAtMs: current?.openedAtMs || openedAtMs,
    closedAt: null,
    closedAtMs: 0,
    status: "open",
    source: "mobile_cash_float",
    updatedAt: nowIso,
  };
  if (existingIndex >= 0) db.handheldCashSessions[existingIndex] = next;
  else db.handheldCashSessions.push(next);
  return normalizeHandheldCashSessionRecord(next);
}

export function recordHandheldCashSessionClose(db = {}, input = {}, options = {}) {
  if (!Array.isArray(db.handheldCashSessions)) db.handheldCashSessions = [];
  const nowIso = typeof options.nowIso === "function" ? options.nowIso() : new Date().toISOString();
  const userId = normalizeId(input.userId);
  const username = normalizeText(input.username);
  const deviceUuid = normalizeId(input.deviceUuid ?? input.deviceId);
  if (!userId && !username) return null;
  const openedAtMs =
    toTimestamp(input.openedAtMs ?? input.openedAt ?? input.sessionStartedAt ?? input.cutoffMs) ||
    toTimestamp(nowIso);
  const closedAtMs = toTimestamp(input.closedAtMs ?? input.closedAt ?? input.completedAtMs) || toTimestamp(nowIso);
  const matching = db.handheldCashSessions
    .map((entry, index) => ({ index, session: normalizeHandheldCashSessionRecord(entry) }))
    .filter(({ session }) => {
      if (!session || session.closedAtMs > 0) return false;
      if (userId && session.userId && session.userId !== userId) return false;
      if (username && session.username && normalizeLookup(session.username) !== normalizeLookup(username)) return false;
      if (deviceUuid && session.deviceUuid && session.deviceUuid !== deviceUuid) return false;
      return true;
    })
    .sort((left, right) => right.session.openedAtMs - left.session.openedAtMs)[0];
  const current = matching?.session ?? null;
  const next = {
    ...(current ?? {}),
    id: current?.id || buildHandheldCashSessionId({ userId, username, deviceUuid, openedAtMs }),
    userId: userId || current?.userId || "",
    username: username || current?.username || "",
    fullName: normalizeText(input.fullName) || current?.fullName || "",
    deviceUuid: deviceUuid || current?.deviceUuid || "",
    posId: normalizeId(input.posId) || current?.posId || "",
    activityId: normalizeId(input.activityId) || current?.activityId || "",
    roomId: normalizeId(input.roomId) || current?.roomId || "",
    roomName: normalizeText(input.roomName) || current?.roomName || "",
    cashFloat: roundMoney(Math.max(Number(input.cashFloat ?? current?.cashFloat) || 0, 0)),
    openedAt: current?.openedAt || timestampIso(openedAtMs, nowIso),
    openedAtMs: current?.openedAtMs || openedAtMs,
    closedAt: timestampIso(closedAtMs, nowIso),
    closedAtMs,
    status: "closed",
    totals: input.totals && typeof input.totals === "object" ? { ...input.totals } : current?.totals ?? null,
    source: current?.source || "mobile_settlement",
    updatedAt: nowIso,
  };
  if (matching) db.handheldCashSessions[matching.index] = next;
  else db.handheldCashSessions.push(next);
  return normalizeHandheldCashSessionRecord(next);
}

function buildUserMaps(db = {}) {
  const usersById = new Map();
  const usersByUsername = new Map();
  asArray(db.users).forEach((user) => {
    const id = normalizeId(user?.id);
    const username = normalizeLookup(user?.username);
    if (id) usersById.set(id, user);
    if (username) usersByUsername.set(username, user);
  });
  return { usersById, usersByUsername };
}

function displayNameForUser(userId, username, userMaps) {
  const id = normalizeId(userId);
  const normalizedUsername = normalizeLookup(username);
  const user = userMaps.usersById.get(id) || userMaps.usersByUsername.get(normalizedUsername) || null;
  if (!user) return normalizeText(username) || id || "Operatore";
  const fullName =
    normalizeText(user.fullName ?? user.displayName ?? user.name) ||
    [user.firstName, user.lastName].map(normalizeText).filter(Boolean).join(" ");
  return fullName || normalizeText(user.username) || id || "Operatore";
}

function collectConfiguredMobileDevices(db = {}) {
  const devices = new Map();
  asArray(db.posSettings?.mobileDevices).forEach((entry) => {
    const deviceId = normalizeId(entry?.deviceId ?? entry?.id ?? entry?.deviceUuid ?? entry?.uuid);
    const deviceUuid = normalizeId(entry?.deviceUuid ?? entry?.uuid);
    const clientIp = normalizeId(entry?.clientIp ?? entry?.ip);
    const deviceName = normalizeText(entry?.deviceName ?? entry?.name ?? entry?.label ?? deviceId ?? deviceUuid);
    [deviceId, deviceUuid, clientIp].filter(Boolean).forEach((key) => {
      devices.set(key, { deviceId: deviceId || key, deviceUuid, clientIp, deviceName: deviceName || key });
    });
  });
  return devices;
}

function collectMobileUserIds(db = {}) {
  const mobileDeviceIds = collectConfiguredMobileDevices(db);
  const userIds = new Set();
  const usernames = new Set();
  asArray(db.sessions).forEach((session) => {
    const clientApp = normalizeLookup(session?.clientApp ?? session?.app);
    const deviceUuid = normalizeId(session?.deviceUuid ?? session?.deviceId);
    if (clientApp.includes("mobile") || mobileDeviceIds.has(deviceUuid)) {
      const userId = normalizeId(session?.userId);
      const username = normalizeLookup(session?.username);
      if (userId) userIds.add(userId);
      if (username) usernames.add(username);
    }
  });
  asArray(db.integration?.orders).forEach((order) => {
    if (!isOrderFromMobileSource(order, mobileDeviceIds, userIds, usernames)) return;
    const userId = normalizeId(order?.createdByUserId ?? order?.userId);
    const username = normalizeLookup(order?.createdByUsername ?? order?.username);
    if (userId) userIds.add(userId);
    if (username) usernames.add(username);
  });
  return { userIds, usernames, mobileDeviceIds };
}

function isOrderFromMobileSource(order, mobileDeviceIds, userIds = new Set(), usernames = new Set()) {
  const source = normalizeLookup(order?.source ?? order?.clientApp ?? order?.app);
  const deviceUuid = normalizeId(order?.deviceUuid ?? order?.createdByDeviceUuid ?? order?.clientDeviceUuid);
  const userId = normalizeId(order?.createdByUserId ?? order?.userId);
  const username = normalizeLookup(order?.createdByUsername ?? order?.username);
  return (
    source.includes("mobile") ||
    mobileDeviceIds.has(deviceUuid) ||
    (userId && userIds.has(userId)) ||
    (username && usernames.has(username))
  );
}

function isPaymentFromMobile(payment, { mobileDeviceIds, mobileOrderIds, userIds, usernames }) {
  const source = normalizeLookup(payment?.source ?? payment?.clientApp ?? payment?.app);
  const deviceUuid = normalizeId(payment?.collectedByDeviceUuid ?? payment?.deviceUuid ?? payment?.createdByDeviceUuid);
  const userId = normalizeId(payment?.collectedByUserId ?? payment?.createdByUserId ?? payment?.userId);
  const username = normalizeLookup(payment?.collectedByUsername ?? payment?.createdByUsername ?? payment?.username);
  const orderIds = asArray(payment?.orderIds).map(normalizeId).filter(Boolean);
  if (source.includes("mobile")) return true;
  if (deviceUuid && mobileDeviceIds.has(deviceUuid)) return true;
  if (userId && userIds.has(userId)) return true;
  if (username && usernames.has(username)) return true;
  return orderIds.some((orderId) => mobileOrderIds.has(orderId));
}

function isCompFromMobile(comp, { mobileDeviceIds, mobileOrderIds, userIds, usernames, paymentIds }) {
  const source = normalizeLookup(comp?.source ?? comp?.clientApp ?? comp?.app);
  const deviceUuid = normalizeId(comp?.createdByDeviceUuid ?? comp?.deviceUuid ?? comp?.clientDeviceUuid);
  const userId = normalizeId(comp?.createdByUserId ?? comp?.userId);
  const username = normalizeLookup(comp?.createdByUsername ?? comp?.username);
  const orderId = normalizeId(comp?.orderId);
  const paymentReferences = asArray(comp?.paymentReferences);
  const allocations = asArray(comp?.refundPlan?.allocations);
  if (source.includes("mobile")) return true;
  if (deviceUuid && mobileDeviceIds.has(deviceUuid)) return true;
  if (userId && userIds.has(userId)) return true;
  if (username && usernames.has(username)) return true;
  if (orderId && mobileOrderIds.has(orderId)) return true;
  return [...paymentReferences, ...allocations].some((reference) => {
    const paymentId = normalizeId(reference?.paymentId ?? reference?.id);
    return paymentId && paymentIds.has(paymentId);
  });
}

function classifyPaymentMethod(payment) {
  const automaticCashOperationId = normalizeId(
    payment?.automaticCashPaymentOperationId ??
      payment?.automaticCashOperationId ??
      payment?.cashOperationId,
  );
  const paymentSource = normalizeLookup(
    `${payment?.paymentSource ?? ""} ${payment?.cashSource ?? ""}`,
  );
  if (
    automaticCashOperationId ||
    paymentSource === "automatic" ||
    paymentSource === "automatic cash" ||
    paymentSource.includes("automatic cash")
  ) {
    return "automatic_cash";
  }
  const haystack = normalizeLookup(
    `${payment?.methodId ?? ""} ${payment?.methodLabel ?? ""} ${payment?.method ?? ""} ${payment?.paymentMethod ?? ""} ${payment?.type ?? ""}`
  );
  if (/\b(pos|card|carta|bancomat|elettron|electronic)\b/.test(haystack)) return "pos";
  if (/\b(cash|contanti|contante)\b/.test(haystack)) return "cash";
  return "other";
}

function paymentCreatedAt(payment) {
  return payment?.createdAt ?? payment?.paidAt ?? payment?.completedAt ?? payment?.updatedAt;
}

function orderCreatedAt(order) {
  return order?.createdAt ?? order?.sentAt ?? order?.updatedAt;
}

function orderAmount(order) {
  return roundMoney(order?.total ?? order?.amount ?? order?.grossTotal ?? 0);
}

function orderDueAmount(order, paymentsByOrderId = new Map()) {
  const explicit = Number(order?.dueAmount ?? order?.amountDue ?? order?.totalDue);
  if (Number.isFinite(explicit)) return roundMoney(Math.max(explicit, 0));
  const status = normalizeLookup(order?.paymentStatus ?? order?.status);
  if (status.includes("paid") || status.includes("pagato")) return 0;
  const total = orderAmount(order);
  const paid = roundMoney(paymentsByOrderId.get(normalizeId(order?.id)) ?? order?.paidAmount ?? 0);
  return roundMoney(Math.max(total - paid, 0));
}

function roomNameMap(db = {}) {
  const map = new Map();
  asArray(db.posSettings?.rooms).forEach((room) => {
    const id = normalizeId(room?.id);
    if (id) map.set(id, normalizeText(room?.name ?? room?.label ?? room?.type) || id);
  });
  asArray(db.posSettings?.areas).forEach((room) => {
    const id = normalizeId(room?.id);
    if (id && !map.has(id)) map.set(id, normalizeText(room?.name ?? room?.label ?? room?.type) || id);
  });
  return map;
}

function tableRoomMap(db = {}) {
  const map = new Map();
  asArray(db.posSettings?.tables).forEach((table) => {
    const id = normalizeId(table?.id);
    const roomId = normalizeId(table?.roomId ?? table?.areaId);
    if (id && roomId) map.set(id, roomId);
  });
  return map;
}

function buildTableSessions(db = {}, window) {
  const sessions = [];
  const openByTableId = new Map();
  const tableRooms = tableRoomMap(db);
  const events = asArray(db.auditEvents)
    .filter((event) => ["table.session_opened", "table.released"].includes(normalizeId(event?.action)))
    .map((event) => ({
      action: normalizeId(event?.action),
      tableId: normalizeId(event?.payload?.tableId ?? event?.entityId),
      roomId: normalizeId(event?.payload?.roomId ?? event?.roomId) || tableRooms.get(normalizeId(event?.payload?.tableId ?? event?.entityId)) || "",
      atMs: toTimestamp(event?.occurredAt ?? event?.timestamp ?? event?.payload?.timestamp),
      raw: event,
    }))
    .filter((event) => event.tableId && event.atMs > 0)
    .sort((left, right) => left.atMs - right.atMs);

  for (const event of events) {
    if (event.action === "table.session_opened") {
      const existing = openByTableId.get(event.tableId);
      if (existing) existing.endMs = event.atMs;
      const session = {
        id: `table-session:${event.tableId}:${event.atMs}`,
        tableId: event.tableId,
        roomId: event.roomId,
        startMs: event.atMs,
        endMs: Number.POSITIVE_INFINITY,
        orderIds: [],
        userIds: new Set(),
        usernames: new Set(),
        covers: 0,
        apericena: 0,
        total: 0,
      };
      sessions.push(session);
      openByTableId.set(event.tableId, session);
      continue;
    }
    const existing = openByTableId.get(event.tableId);
    if (existing) {
      existing.endMs = event.atMs;
      openByTableId.delete(event.tableId);
    }
  }

  return sessions.filter((session) => session.endMs >= window.startMs && session.startMs <= window.endMs);
}

function findTableSessionForOrder(order, sessions, fallbackSessions) {
  const tableId = normalizeId(order?.tableId);
  const roomId = normalizeId(order?.roomId ?? order?.areaId);
  const createdAtMs = toTimestamp(orderCreatedAt(order));
  const match = sessions.find((session) => {
    if (session.tableId !== tableId) return false;
    return createdAtMs >= session.startMs && createdAtMs <= session.endMs;
  });
  if (match) return match;
  const fallbackKey = `fallback:${roomId}:${tableId || "senza_tavolo"}`;
  if (!fallbackSessions.has(fallbackKey)) {
    fallbackSessions.set(fallbackKey, {
      id: fallbackKey,
      tableId,
      roomId,
      startMs: createdAtMs,
      endMs: createdAtMs,
      orderIds: [],
      userIds: new Set(),
      usernames: new Set(),
      covers: 0,
      apericena: 0,
      total: 0,
      fallback: true,
    });
  }
  const fallback = fallbackSessions.get(fallbackKey);
  fallback.startMs = Math.min(fallback.startMs || createdAtMs, createdAtMs);
  fallback.endMs = Math.max(fallback.endMs || createdAtMs, createdAtMs);
  return fallback;
}

function collectPayments(db = {}) {
  const primary = asArray(db.payments);
  const fallback = primary.length > 0 ? [] : asArray(db.paymentContainers);
  const seen = new Set();
  return [...primary, ...fallback].filter((payment, index) => {
    const id = normalizeId(payment?.id) || `payment_${index}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function buildHandheldSessionAvailableDates(db = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const dates = new Set([resolveHandheldOperationalSessionDateKey(now)]);
  collectHandheldCashSessions(db).forEach((session) => {
    const dateKey = sessionRecordDateKey(session);
    if (dateKey) dates.add(dateKey);
  });
  asArray(db.integration?.orders).forEach((order) => {
    const dateKey = sessionDateKeyFromTimestamp(orderCreatedAt(order));
    if (dateKey) dates.add(dateKey);
  });
  collectPayments(db).forEach((payment) => {
    const dateKey = sessionDateKeyFromTimestamp(paymentCreatedAt(payment));
    if (dateKey) dates.add(dateKey);
  });
  asArray(db.auditEvents).forEach((event) => {
    const dateKey = sessionDateKeyFromTimestamp(event?.occurredAt ?? event?.timestamp);
    if (dateKey) dates.add(dateKey);
  });
  return [...dates].filter(Boolean).sort((left, right) => right.localeCompare(left)).slice(0, 180);
}

export function resolveHandheldSessionReportPrinterId(settings = {}, explicitPrinterId = "") {
  const printers = asArray(settings.printers);
  const printersById = new Map(printers.map((printer) => [normalizeId(printer?.id), printer]));
  const isUsable = (printer) => printer && printer.active !== false && normalizeLookup(printer?.purpose) !== "fiscal";
  const explicit = normalizeId(explicitPrinterId);
  if (explicit) {
    const printer = printersById.get(explicit);
    return isUsable(printer) ? explicit : "";
  }
  const activity =
    asArray(settings.activities).find((entry) => normalizeId(entry?.id) === "activity_bar" && entry?.active !== false) ||
    asArray(settings.activities).find((entry) => normalizeLookup(entry?.name) === "bar" && entry?.active !== false) ||
    null;
  const ids = [
    ...asArray(activity?.precontoPrinterIds),
    ...asArray(activity?.printerIds),
  ].map(normalizeId).filter(Boolean);
  return ids.find((id) => isUsable(printersById.get(id))) || "";
}

export function buildHandheldSessionReport(db = {}, options = {}) {
  const window = resolveHandheldSessionReportWindow(db, options);
  const userMaps = buildUserMaps(db);
  const mobileRefs = collectMobileUserIds(db);
  const roomsById = roomNameMap(db);
  const tableRooms = tableRoomMap(db);
  const inWindow = (value) => {
    const ts = toTimestamp(value);
    return ts >= window.startMs && ts < window.endMs;
  };

  const mobileOrders = asArray(db.integration?.orders)
    .filter((order) => inWindow(orderCreatedAt(order)))
    .filter((order) => isOrderFromMobileSource(order, mobileRefs.mobileDeviceIds, mobileRefs.userIds, mobileRefs.usernames));
  const mobileOrderIds = new Set(mobileOrders.map((order) => normalizeId(order?.id)).filter(Boolean));

  const payments = collectPayments(db)
    .filter((payment) => inWindow(paymentCreatedAt(payment)))
    .filter((payment) => isPaymentFromMobile(payment, { ...mobileRefs, mobileOrderIds }));
  const paymentIds = new Set(payments.map((payment) => normalizeId(payment?.id)).filter(Boolean));
  const serviceRecoveryComps = asArray(db.integration?.orderComps)
    .filter((comp) => inWindow(comp?.createdAt ?? comp?.updatedAt))
    .filter((comp) => isCompFromMobile(comp, { ...mobileRefs, mobileOrderIds, paymentIds }));

  const paymentsByOrderId = new Map();
  payments.forEach((payment) => {
    const amount = roundMoney(payment?.amount ?? payment?.total ?? 0);
    asArray(payment?.orderIds).map(normalizeId).filter(Boolean).forEach((orderId) => {
      paymentsByOrderId.set(orderId, roundMoney((paymentsByOrderId.get(orderId) ?? 0) + amount));
    });
  });

  const sessions = buildTableSessions(db, window);
  const fallbackSessions = new Map();
  const users = new Map();
  const rooms = new Map();
  const ensureUser = (userId, username) => {
    const key = normalizeId(userId) || normalizeLookup(username) || "unknown";
    if (!users.has(key)) {
      users.set(key, {
        userId: normalizeId(userId),
        username: normalizeText(username),
        displayName: displayNameForUser(userId, username, userMaps),
        ordersTaken: 0,
        coversManaged: 0,
        apericena: 0,
        paidTotal: 0,
        posTotal: 0,
        cashTotal: 0,
        automaticCashTotal: 0,
        otherTotal: 0,
        unpaidTotal: 0,
        averagePerOrder: 0,
        averagePerCover: 0,
      });
    }
    return users.get(key);
  };
  const ensureRoom = (roomId) => {
    const key = normalizeId(roomId) || "unknown_room";
    if (!rooms.has(key)) {
      rooms.set(key, {
        roomId: key,
        roomName: roomsById.get(key) || key || "Sala n/d",
        orders: 0,
        covers: 0,
        apericena: 0,
        total: 0,
        unpaidTotal: 0,
      });
    }
    return rooms.get(key);
  };

  let unpaidTotal = 0;
  let ordersTotal = 0;
  let apericenaTotal = 0;

  mobileOrders.forEach((order) => {
    const userId = normalizeId(order?.createdByUserId ?? order?.userId);
    const username = normalizeText(order?.createdByUsername ?? order?.username);
    const roomId = normalizeId(order?.roomId ?? order?.areaId) || tableRooms.get(normalizeId(order?.tableId)) || "";
    const session = findTableSessionForOrder({ ...order, roomId }, sessions, fallbackSessions);
    const covers = normalizeTableCovers(order?.covers ?? order?.tableCovers);
    const apericena = Math.max(0, Math.trunc(Number(order?.apericena ?? order?.apericenaCovers) || 0));
    const amount = orderAmount(order);
    const due = orderDueAmount(order, paymentsByOrderId);
    ordersTotal += 1;
    apericenaTotal += apericena;
    unpaidTotal = roundMoney(unpaidTotal + due);

    if (session) {
      session.roomId = session.roomId || roomId;
      session.covers = Math.max(session.covers, covers);
      session.apericena += apericena;
      session.total = roundMoney(session.total + amount);
      const orderId = normalizeId(order?.id);
      if (orderId) session.orderIds.push(orderId);
      if (userId) session.userIds.add(userId);
      if (username) session.usernames.add(normalizeLookup(username));
    }

    const room = ensureRoom(roomId);
    room.orders += 1;
    room.apericena += apericena;
    room.total = roundMoney(room.total + amount);
    room.unpaidTotal = roundMoney(room.unpaidTotal + due);

    const user = ensureUser(userId, username);
    user.ordersTaken += 1;
    user.apericena += apericena;
    user.unpaidTotal = roundMoney(user.unpaidTotal + due);
  });

  const allSessions = [...sessions, ...fallbackSessions.values()]
    .filter((session) => session.orderIds.length > 0 || session.total > 0 || session.covers > 0)
    .map((session) => ({
      ...session,
      userIds: [...session.userIds],
      usernames: [...session.usernames],
    }));

  allSessions.forEach((session) => {
    const room = ensureRoom(session.roomId);
    room.covers += session.covers;
    const ownerUserId = session.userIds[0] || "";
    const ownerUsername = session.usernames[0] || "";
    const user = ensureUser(ownerUserId, ownerUsername);
    user.coversManaged += session.covers;
  });

  const totals = {
    paid: 0,
    pos: 0,
    cash: 0,
    automaticCash: 0,
    other: 0,
    unpaid: roundMoney(unpaidTotal),
    covers: allSessions.reduce((sum, session) => sum + normalizeTableCovers(session.covers), 0),
    apericena: apericenaTotal,
    orders: ordersTotal,
    payments: payments.length,
    averagePerOrder: 0,
    averagePerCover: 0,
  };

  payments.forEach((payment) => {
    const amount = roundMoney(payment?.amount ?? payment?.total ?? 0);
    if (amount <= 0) return;
    const method = classifyPaymentMethod(payment);
    totals.paid = roundMoney(totals.paid + amount);
    if (method === "automatic_cash") {
      totals.automaticCash = roundMoney(totals.automaticCash + amount);
    } else {
      totals[method] = roundMoney(totals[method] + amount);
    }
    const userId = normalizeId(payment?.collectedByUserId ?? payment?.createdByUserId ?? payment?.userId);
    const username = normalizeText(payment?.collectedByUsername ?? payment?.createdByUsername ?? payment?.username);
    const user = ensureUser(userId, username);
    user.paidTotal = roundMoney(user.paidTotal + amount);
    if (method === "pos") user.posTotal = roundMoney(user.posTotal + amount);
    else if (method === "cash") user.cashTotal = roundMoney(user.cashTotal + amount);
    else if (method === "automatic_cash") user.automaticCashTotal = roundMoney(user.automaticCashTotal + amount);
    else user.otherTotal = roundMoney(user.otherTotal + amount);
  });
  const settlementTotals = summarizeSettlementLedger(
    buildSettlementLedgerEntries({
      payments,
      comps: serviceRecoveryComps,
    }),
  );
  totals.grossPaid = settlementTotals.grossTotal;
  totals.refunds = settlementTotals.refundTotal;
  totals.netPaid = settlementTotals.netTotal;
  totals.cashGross = settlementTotals.cashGrossTotal;
  totals.cashRefunds = settlementTotals.cashRefundTotal;
  totals.cashNet = settlementTotals.cashNetTotal;
  totals.posGross = settlementTotals.posGrossTotal;
  totals.posRefunds = settlementTotals.posRefundTotal;
  totals.posRecharges = settlementTotals.posRechargeTotal;
  totals.posNet = settlementTotals.posNetTotal;
  totals.otherGross = settlementTotals.otherGrossTotal;
  totals.otherRefunds = settlementTotals.otherRefundTotal;
  totals.otherNet = settlementTotals.otherNetTotal;

  totals.averagePerOrder = totals.orders > 0 ? roundMoney(totals.paid / totals.orders) : 0;
  totals.averagePerCover = totals.covers > 0 ? roundMoney(totals.paid / totals.covers) : 0;

  const userList = [...users.values()]
    .map((user) => ({
      ...user,
      averagePerOrder: user.ordersTaken > 0 ? roundMoney(user.paidTotal / user.ordersTaken) : 0,
      averagePerCover: user.coversManaged > 0 ? roundMoney(user.paidTotal / user.coversManaged) : 0,
    }))
    .filter((user) =>
      user.ordersTaken > 0 ||
      user.coversManaged > 0 ||
      user.paidTotal > 0 ||
      user.unpaidTotal > 0
    )
    .sort((left, right) => right.paidTotal - left.paidTotal || left.displayName.localeCompare(right.displayName, "it-IT"));

  const roomList = [...rooms.values()]
    .filter((room) => room.orders > 0 || room.covers > 0 || room.total > 0 || room.unpaidTotal > 0)
    .sort((left, right) => right.covers - left.covers || left.roomName.localeCompare(right.roomName, "it-IT"));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sessionDate: window.sessionDate,
    printKey: window.printKey || window.sessionDate,
    window,
    scope: "mobile-handhelds",
    totals,
    settlementTotals,
    users: userList,
    rooms: roomList,
    tableSessions: allSessions.map((session) => ({
      id: session.id,
      tableId: session.tableId,
      roomId: session.roomId,
      roomName: roomsById.get(session.roomId) || session.roomId || "Sala n/d",
      startAt: Number.isFinite(session.startMs) ? new Date(session.startMs).toISOString() : null,
      endAt: Number.isFinite(session.endMs) ? new Date(session.endMs).toISOString() : null,
      covers: session.covers,
      apericena: session.apericena,
      total: session.total,
      orderIds: session.orderIds,
      fallback: session.fallback === true,
    })).sort((left, right) => normalizeText(left.roomName).localeCompare(normalizeText(right.roomName), "it-IT") || normalizeText(left.tableId).localeCompare(normalizeText(right.tableId), "it-IT")),
    cashSessions: asArray(window.cashSessions).map((session) => ({
      id: session.id,
      userId: session.userId,
      username: session.username,
      fullName: session.fullName,
      deviceUuid: session.deviceUuid,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      cashFloat: session.cashFloat,
      status: session.status,
    })),
    availableDates: buildHandheldSessionAvailableDates(db, options),
  };
}

function formatLocalDateTime(value) {
  const ts = toTimestamp(value);
  if (!ts) return "n/d";
  const date = new Date(ts);
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatMoney(value) {
  return `${roundMoney(value).toFixed(2).replace(".", ",")} EUR`;
}

function line(text = "") {
  return normalizeText(text).slice(0, REPORT_WIDTH);
}

function separator(char = "-") {
  return char.repeat(REPORT_WIDTH);
}

function amountLine(label, value) {
  const left = normalizeText(label).slice(0, 24);
  const right = formatMoney(value);
  return `${left}${" ".repeat(Math.max(1, REPORT_WIDTH - left.length - right.length))}${right}`;
}

function countLine(label, value) {
  const left = normalizeText(label).slice(0, 30);
  const right = String(value ?? 0);
  return `${left}${" ".repeat(Math.max(1, REPORT_WIDTH - left.length - right.length))}${right}`;
}

export function formatHandheldSessionReportText(report = {}) {
  const totals = report.totals ?? {};
  const settlementTotals = report.settlementTotals ?? {};
  const hasSettlementTotals = Number.isFinite(Number(settlementTotals.netTotal));
  const lines = [
    separator("="),
    line("RIEPILOGO PALMARI"),
    line(`Sessione ${formatLocalDateTime(report.window?.startAt)}-${formatLocalDateTime(report.window?.endAt).slice(-5)}`),
    line(`Stampato ${formatLocalDateTime(report.generatedAt ?? new Date())}`),
    separator("="),
    amountLine("Incassato lordo", hasSettlementTotals ? settlementTotals.grossTotal : totals.paid),
    amountLine("Resi/Storni", hasSettlementTotals ? -settlementTotals.refundTotal : 0),
    amountLine("Incassato netto", hasSettlementTotals ? settlementTotals.netTotal : totals.paid),
    amountLine("POS lordo", hasSettlementTotals ? settlementTotals.posGrossTotal : totals.pos),
    amountLine("Void/Storni POS", hasSettlementTotals ? -settlementTotals.posRefundTotal : 0),
    amountLine("Riaddebiti POS", hasSettlementTotals ? settlementTotals.posRechargeTotal : 0),
    amountLine("POS netto", hasSettlementTotals ? settlementTotals.posNetTotal : totals.pos),
    amountLine("Contanti netti", hasSettlementTotals ? settlementTotals.cashDepositNetTotal : totals.cash),
    ...(Number(hasSettlementTotals ? settlementTotals.automaticCashTotal : totals.automaticCash) > 0
      ? [
          amountLine(
            "Cassa automatica",
            hasSettlementTotals ? settlementTotals.automaticCashTotal : totals.automaticCash,
          ),
        ]
      : []),
    amountLine("Altri metodi netti", hasSettlementTotals ? settlementTotals.otherNetTotal : totals.other),
    amountLine("Non pagato", totals.unpaid),
    countLine("Ordini presi", totals.orders),
    countLine("Pagamenti", totals.payments),
    countLine("Coperti totali", totals.covers),
    countLine("Apericena segnati", totals.apericena),
    amountLine("Media ordine", totals.averagePerOrder),
    amountLine("Media persona", totals.averagePerCover),
    separator("-"),
    line("COPERTI PER SALA"),
  ];

  asArray(report.rooms).forEach((room) => {
    lines.push(countLine(room.roomName, room.covers));
  });
  if (!asArray(report.rooms).length) lines.push(line("Nessun coperto registrato."));

  lines.push(separator("-"), line("OPERATORI PALMARI"));
  asArray(report.users).forEach((user) => {
    lines.push(line(user.displayName));
    lines.push(countLine("  Ordini", user.ordersTaken));
    lines.push(countLine("  Coperti", user.coversManaged));
    lines.push(amountLine("  POS", user.posTotal));
    lines.push(amountLine("  Contanti", user.cashTotal));
    if (Number(user.automaticCashTotal) > 0) lines.push(amountLine("  Cassa automatica", user.automaticCashTotal));
    lines.push(amountLine("  Altri", user.otherTotal));
    if (Number(user.unpaidTotal) > 0) lines.push(amountLine("  Non pagato", user.unpaidTotal));
  });
  if (!asArray(report.users).length) lines.push(line("Nessun operatore palmare."));

  lines.push(separator("="), "", "", "");
  return `${lines.join("\n")}\n`;
}
