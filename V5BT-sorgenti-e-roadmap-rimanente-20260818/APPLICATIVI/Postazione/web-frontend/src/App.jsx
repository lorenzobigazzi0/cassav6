import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BluetoothDiagnosticBadge } from "./BluetoothDiagnosticBadge.jsx";
import {
  clearNativeNotificationSession,
  updateNativeNotificationSession,
} from "./nativeNotificationSession.js";
import {
  canStartPostazioneLogin,
  isAuthenticatedPostazioneSession,
  isCurrentPostazioneSession,
  performPostazioneLogout,
} from "./logoutSession.js";
import { ownerDisplayLabel } from "./personDisplay.js";
import {
  configuredStationsFromPayload,
  formatDurationHHMMSS,
  isHistoricalOrder,
  isRealActiveStation,
  normalizeActiveStationsPayload,
  normalizeStationSession,
  normalizeStationName as normalizeRuntimeStationName,
  stationSessionMatchesIdentity,
  sortOrdersOperationalFirst,
  tableLabelForOrder,
} from "./stationRuntime.js";
import { resolveOrderWaiterAvailability } from "./waiterAvailability.js";
import {
  createPostazioneSyncCoordinator,
  createSingleFlight,
} from "./postazioneSyncCoordinator.js";
import { shouldPullStationNotificationsForReason } from "./postazioneRealtimePolicy.js";
import {
  findAvailableWorkstation,
  normalizeAvailableWorkstations,
  normalizeSelectedWorkstation,
} from "./workstationSelection.js";

const STATIONS = [
  "BAR-1",
  "PIZZA IN RIVA",
  "BAR-2",
  "CHIRINGUITO-1",
  "CHIRINGUITO-2",
  "MOBILE",
];
const MONTHS = [
  "GENNAIO",
  "FEBBRAIO",
  "MARZO",
  "APRILE",
  "MAGGIO",
  "GIUGNO",
  "LUGLIO",
  "AGOSTO",
  "SETTEMBRE",
  "OTTOBRE",
  "NOVEMBRE",
  "DICEMBRE",
];

const QUICK_USERS = ["gianluca", "lorenzo", "admin"];
const HOLD_DURATION_MS = 2000;
const WATCH_TICK_COUNT = 60;
const USERNAME_MAX_LEN = 24;
const WAITER_ACTIVE_MS = 90000;
const WAITER_ACK_VISIBLE_MS = 5000;
const NOTIFICATION_STREAM_RECONNECT_BASE_MS = 1000;
const NOTIFICATION_STREAM_RECONNECT_MAX_MS = 30000;
const POSTAZIONE_HEARTBEAT_MS = 15000;
const POSTAZIONE_CONNECTED_SYNC_MS = 90000;
const POSTAZIONE_DISCONNECTED_SYNC_MS = 15000;
const POSTAZIONE_FULL_SYNC_COOLDOWN_MS = 3000;
const POSTAZIONE_ORDER_DONE_HISTORY_LIMIT = 8;
const POSTAZIONE_SESSION_ACTIVE_EVENT = "postazione:session-active";
const POSTAZIONE_SESSION_CLEARED_EVENT = "postazione:session-cleared";

const LS = {
  station: "BAR_POSTAZIONE_STATION_V1",
  operator: "BAR_OPERATOR_SESSION_V1",
  auth: "BAR_OPERATOR_AUTH_V1",
  notifyDevice: "BAR_NOTIFY_DEVICE_V1",
  loginDevice: "postazione_device_uuid",
  apiBase: "BAR_API_BASE_URL",
  rememberUser: "postazione_remember_username",
  lastUser: "postazione_last_username",
  tempItems: "BAR_TEMP_MENU_V1",
  disabledGlobal: "BAR_DISABLED_GLOBAL_V1",
  disabledLocal: "BAR_DISABLED_LOCAL_V1",
  actionQueue: "BAR_ACTION_QUEUE_V1",
  cancelledDismissals: "postazione_cancelled_order_dismissals_v1",
  settingsVersion: "pos:settings-version",
};

const readJson = (k, d) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : d;
  } catch {
    return d;
  }
};
const writeJson = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // noop
  }
};
const removeKey = (k) => {
  try {
    localStorage.removeItem(k);
  } catch {
    // noop
  }
};
const removeAuthKey = (k) => {
  removeKey(k);
  try {
    sessionStorage.removeItem(k);
  } catch {
    // noop
  }
};

const dispatchPostazioneSessionEvent = (eventName) => {
  try {
    window.dispatchEvent(new Event(eventName));
  } catch {
    // noop
  }
};

const normalizeName = (value) => String(value || "").trim();
const keyName = (value) => normalizeName(value).toLowerCase();
const personKey = (value) =>
  normalizeName(value).toLowerCase().replace(/\s+/g, " ");
const stationLookupKey = (value) =>
  normalizeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
const canonicalStationName = (value) => {
  const normalized = normalizeRuntimeStationName(value);
  if (!normalized) return "";
  const key = stationLookupKey(normalized);
  return (
    STATIONS.find((station) => stationLookupKey(station) === key) || normalized
  );
};
const sameStationName = (left, right) => {
  const leftStation = canonicalStationName(left);
  const rightStation = canonicalStationName(right);
  return Boolean(leftStation && rightStation && leftStation === rightStation);
};

const pad2 = (n) => String(n).padStart(2, "0");
const waitMs = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const fmtMMSS = (ms) => {
  return formatDurationHHMMSS(ms);
};
const fmtPrice = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(2);
};
const parsePriceInput = (raw) => {
  const clean = String(raw || "")
    .trim()
    .replace(",", ".");
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};
const parseQtyInput = (raw) => {
  const clean = String(raw || "").trim();
  if (!clean) return null;
  const n = Math.floor(Number(clean));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

const normalizeVariants = (rawVariants) => {
  if (!Array.isArray(rawVariants)) return [];
  const normalized = rawVariants
    .map((variant) => {
      if (variant && typeof variant === "object") {
        return String(variant.name || variant.label || "").trim();
      }
      return String(variant || "").trim();
    })
    .filter(Boolean);
  return [...new Set(normalized)];
};

const resolveStationsForCategory = (categoryRaw) => {
  const category = String(categoryRaw || "")
    .trim()
    .toLowerCase();
  if (!category) return [STATIONS[0]];
  if (category.includes("caffe")) return ["BAR-1"];
  if (
    category.includes("bevande") ||
    category.includes("drink") ||
    category.includes("birra") ||
    category.includes("cocktail")
  ) {
    return ["BAR-1", "BAR-2", "CHIRINGUITO-1", "CHIRINGUITO-2"];
  }
  return [STATIONS[0]];
};

function uuid() {
  try {
    if (crypto && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
  } catch {
    // noop
  }
  return `u_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function getOrCreateId(key) {
  const val = String(readJson(key, "") || "").trim();
  if (val) return val;
  const id = uuid();
  writeJson(key, id);
  return id;
}

function resolveApiBase() {
  try {
    if (typeof window.API_BASE === "string" && window.API_BASE.trim())
      return window.API_BASE.trim();
    const qs = new URLSearchParams(window.location.search || "");
    const q = String(qs.get("apiBase") || "").trim();
    if (q) return q;
    const s = String(readJson(LS.apiBase, "") || "").trim();
    if (s) return s;
    if (window.location?.origin) return window.location.origin;
  } catch {
    // noop
  }
  return "";
}

const normStation = (v) => {
  const station = canonicalStationName(v);
  return station || STATIONS[0];
};
function buildPostazioneOrdersPath(stationName, auth = {}) {
  const params = new URLSearchParams({
    includeDone: "1",
    includeTransferred: "1",
    doneHistoryLimit: String(POSTAZIONE_ORDER_DONE_HISTORY_LIMIT),
    station: normStation(stationName),
    clientApp: "postazione",
  });
  const deviceUuid = String(auth?.deviceUuid || "").trim();
  const userId = String(auth?.userId || "").trim();
  const username = String(auth?.username || "").trim();
  const fullName = String(auth?.fullName || auth?.userName || "").trim();
  if (deviceUuid) params.set("deviceUuid", deviceUuid);
  if (userId) params.set("userId", userId);
  if (username) params.set("username", username);
  if (fullName) params.set("fullName", fullName);
  return `/api/integration/orders?${params.toString()}`;
}
const wf = (v) => {
  const x = String(v || "")
    .trim()
    .toLowerCase();
  if (["cancelled", "annullata", "voided"].includes(x)) return "cancelled";
  if (["done", "delivered", "consegnato"].includes(x)) return "delivered";
  if (["ready", "da consegnare", "da_consegnare"].includes(x)) return "ready";
  if (["prep", "in preparazione", "in_preparazione"].includes(x)) return "prep";
  return "waiting";
};
const msOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};
const itemQty = (item) => {
  const qty = Math.trunc(Number(item?.qty ?? item?.quantity ?? 1));
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
};

const correctionRecords = (order) => {
  if (Array.isArray(order?.corrections) && order.corrections.length)
    return order.corrections;
  if (order?.latestCorrection && typeof order.latestCorrection === "object")
    return [order.latestCorrection];
  return [];
};

const hasCorrections = (order) =>
  Boolean(
    order?.hasCorrections ||
    order?.latestCorrection ||
    correctionRecords(order).length,
  );
const itemLineId = (item) => String(item?.lineId || item?.id || "").trim();
const correctionItemNameKey = (value) => normalizeToken(value || "");
const isCorrectionRemovedItem = (item) =>
  Boolean(
    item?.voidedAt ||
    String(item?.correctionStatus || "")
      .trim()
      .toLowerCase() === "removed",
  );

const correctionStateForOrder = (order) => {
  const changedByLineId = new Map();
  const changedByName = new Map();
  const removedByLineId = new Map();
  correctionRecords(order).forEach((record) => {
    (Array.isArray(record?.changedItems) ? record.changedItems : []).forEach(
      (item) => {
        const lineId = String(item?.lineId || "").trim();
        if (lineId) changedByLineId.set(lineId, item);
        const name = correctionItemNameKey(
          item?.productName || item?.productId || lineId,
        );
        if (name) changedByName.set(name, item);
      },
    );
    (Array.isArray(record?.removedItems) ? record.removedItems : []).forEach(
      (item) => {
        const lineId = String(item?.lineId || "").trim();
        if (lineId) removedByLineId.set(lineId, item);
      },
    );
  });
  return { changedByLineId, changedByName, removedByLineId };
};

const correctionChangeForGroup = (state, group) => {
  if (!state || !group || group.removed) return null;
  const lineId = String(group.lineId || "").trim();
  if (lineId && state.changedByLineId.has(lineId))
    return state.changedByLineId.get(lineId);
  const name = correctionItemNameKey(group.name || lineId);
  return name ? state.changedByName.get(name) || null : null;
};

const isCancelledOrder = (order) =>
  wf(order?.workflowStatus || order?.status) === "cancelled";
const isTerminalStatus = (value) =>
  ["done", "cancelled"].includes(String(value || ""));
const normalizeToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

const waiterKey = (waiter) =>
  personKey(waiter?.userId) ||
  personKey(waiter?.username) ||
  personKey(waiter?.name) ||
  personKey(waiter?.fullName);

const isWaiterPaused = (waiter) => {
  const pause =
    waiter?.pauseStatus && typeof waiter.pauseStatus === "object"
      ? waiter.pauseStatus
      : null;
  return Boolean(
    waiter?.onPause === true ||
    pause?.active === true ||
    pause?.graceActive === true,
  );
};

const formatPauseRemaining = (waiter) => {
  const pause =
    waiter?.pauseStatus && typeof waiter.pauseStatus === "object"
      ? waiter.pauseStatus
      : {};
  let remaining = Number(pause.remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    const endsAt = Number(pause.endsAtMs);
    remaining =
      Number.isFinite(endsAt) && endsAt > Date.now() ? endsAt - Date.now() : 0;
  }
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
};

const splitName = (rawValue) => {
  const parts = normalizeName(rawValue).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstLine: parts[0] || "", secondLine: "" };
  return { firstLine: parts[0], secondLine: parts.slice(1).join(" ") };
};

function status(order) {
  if (isCancelledOrder(order)) return "cancelled";
  const w = wf(order.workflowStatus);
  if (msOrNull(order.completedAtMs) || w === "delivered") return "done";
  if (w === "ready") return "ready";
  if (w === "prep") return "prep";
  const effectiveItems = Array.isArray(order.items)
    ? order.items.filter((item) => !isCorrectionRemovedItem(item))
    : [];
  const effectiveTotal = effectiveItems.reduce((sum, x) => sum + itemQty(x), 0);
  const effectiveDone = effectiveItems.reduce(
    (sum, x) => sum + (x.done ? itemQty(x) : 0),
    0,
  );
  if (effectiveTotal > 0 && effectiveDone === effectiveTotal) return "ready";
  if (effectiveDone > 0) return "prep";
  return "new";
}

const statusLabel = (s) =>
  s === "cancelled"
    ? "ANNULLATA"
    : s === "new"
      ? "INVIATO"
      : s === "prep"
        ? "IN PREPARAZIONE"
        : s === "ready"
          ? "DA RITIRARE"
          : "CONSEGNATO";
const hideIfNoHistory = (s) => s === "ready";

const tableLabel = (order) => tableLabelForOrder(order);

const roomLabel = (o) => {
  const rn = String(o?.roomName || "").trim();
  if (rn) return rn;
  const rid = String(o?.roomId || "").trim();
  if (!rid) return "";
  const c = rid
    .replace(/^sala[_-]?/i, "")
    .replace(/^room[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return c ? `Sala ${c}` : "";
};

function isVisibleForStation(order, stationName) {
  if (!order) return false;
  if (order.broadcastToAllStations === true) return true;
  const station = canonicalStationName(stationName);
  if (!station) return false;
  if (sameStationName(order.station, station)) return true;
  if (sameStationName(order.ownerStation, station)) return true;
  if (sameStationName(order.transferredFromStation, station)) return true;
  return false;
}

function normalizeOrder(raw, byId, byNum) {
  if (!raw || typeof raw !== "object") return null;
  const tableId = String(raw.tableId || "").trim();
  let tableNumber = Number(raw.tableNumber ?? raw.table);
  tableNumber = Number.isFinite(tableNumber)
    ? Math.max(0, Math.trunc(tableNumber))
    : 0;
  let roomId = String(raw.roomId || "").trim();
  let roomName = String(raw.roomName || "").trim();

  const tById = tableId ? byId.get(tableId) : null;
  if (tById) {
    if (tableNumber <= 0 && tById.number > 0) tableNumber = tById.number;
    if (!roomId && tById.roomId) roomId = tById.roomId;
    if (!roomName && tById.roomName) roomName = tById.roomName;
  }
  if (tableNumber > 0) {
    const bucket = byNum.get(tableNumber) || [];
    if (!roomId && bucket[0]?.roomId) roomId = bucket[0].roomId;
    if (!roomName && bucket[0]?.roomName) roomName = bucket[0].roomName;
  }

  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((x) => x && typeof x === "object")
        .map((x, i) => ({
          id: String(x.id || x.lineId || `i${i + 1}`),
          lineId: String(x.lineId || x.id || `i${i + 1}`),
          productId: String(x.productId || ""),
          productNameSnapshot: String(
            x.productNameSnapshot || x.productName || x.name || "Articolo",
          ),
          name: String(
            x.name || x.productNameSnapshot || x.productName || "Articolo",
          ),
          variant: String(
            x.variant || x.variantName || x.selectedVariantName || "",
          ),
          note: String(x.note ?? x.notes ?? ""),
          qty: itemQty(x),
          done: x.done === true,
          lineType: String(x.lineType || ""),
          voidedAt: x.voidedAt || null,
          correctionStatus: String(x.correctionStatus || ""),
          ignoreDisabled: x.ignoreDisabled === true,
        }))
    : [];

  const src = String(raw.source || "")
    .trim()
    .toLowerCase();
  const corrections = Array.isArray(raw.corrections) ? raw.corrections : [];
  return {
    id: String(raw.id || uuid()),
    table: tableNumber,
    tableNumber,
    tableId,
    roomId,
    roomName,
    tableLabel: String(raw.tableLabel || ""),
    logicalTableLabel: String(raw.logicalTableLabel || ""),
    waiter: String(raw.waiter || "Cameriere"),
    waiterUserId: String(raw.waiterUserId || ""),
    waiterUsername: String(raw.waiterUsername || ""),
    createdByUserId: String(raw.createdByUserId || ""),
    createdByUsername: String(raw.createdByUsername || ""),
    createdByFullName: String(raw.createdByFullName || ""),
    ownerUserId: String(raw.ownerUserId || ""),
    ownerUsername: String(raw.ownerUsername || ""),
    operatorUserId: String(raw.operatorUserId || ""),
    operatorUsername: String(raw.operatorUsername || ""),
    operatorName: String(raw.operatorName || ""),
    targetUserId: String(raw.targetUserId || ""),
    targetUsername: String(raw.targetUsername || ""),
    targetFullName: String(raw.targetFullName || ""),
    covers: Number.isFinite(Number(raw.covers))
      ? Math.max(0, Math.floor(Number(raw.covers)))
      : 0,
    apericena: Number.isFinite(Number(raw.apericena))
      ? Math.max(0, Math.floor(Number(raw.apericena)))
      : 0,
    note: String(raw.note || ""),
    communications: String(raw.communications || ""),
    paymentStatus: String(raw.paymentStatus || ""),
    paidAmount: Number.isFinite(Number(raw.paidAmount))
      ? Number(raw.paidAmount)
      : 0,
    dueAmount:
      raw.dueAmount !== null &&
      raw.dueAmount !== undefined &&
      raw.dueAmount !== "" &&
      Number.isFinite(Number(raw.dueAmount))
        ? Number(raw.dueAmount)
        : null,
    total: Number.isFinite(Number(raw.total)) ? Number(raw.total) : 0,
    receivedAtMs: msOrNull(raw.receivedAtMs) ?? Date.now(),
    readyAtMs: msOrNull(raw.readyAtMs),
    completedAtMs: msOrNull(raw.completedAtMs),
    station: String(raw.station || STATIONS[0]),
    ownerStation: raw.ownerStation ? String(raw.ownerStation) : null,
    ownerOperator: raw.ownerOperator ? String(raw.ownerOperator) : null,
    ownerRole: raw.ownerRole ? String(raw.ownerRole) : null,
    ownerAtMs: msOrNull(raw.ownerAtMs),
    workflowStatus: wf(raw.workflowStatus),
    status: String(raw.status || ""),
    revision: Number.isFinite(Number(raw.revision))
      ? Number(raw.revision)
      : null,
    hasCorrections:
      raw.hasCorrections === true ||
      corrections.length > 0 ||
      !!raw.latestCorrection,
    latestCorrection:
      raw.latestCorrection && typeof raw.latestCorrection === "object"
        ? raw.latestCorrection
        : null,
    corrections,
    items,
    source: src,
    broadcastToAllStations: raw.broadcastToAllStations === true,
    pendingAuthRequest:
      raw.pendingAuthRequest && typeof raw.pendingAuthRequest === "object"
        ? {
            orderId: String(
              raw.pendingAuthRequest.orderId || String(raw.id || ""),
            ),
            fromStation: String(raw.pendingAuthRequest.fromStation || ""),
            toStation: String(raw.pendingAuthRequest.toStation || ""),
            toOperator: String(raw.pendingAuthRequest.toOperator || ""),
            toOperatorRole: String(raw.pendingAuthRequest.toOperatorRole || ""),
            requestedAtMs:
              msOrNull(raw.pendingAuthRequest.requestedAtMs) || Date.now(),
            mode:
              String(raw.pendingAuthRequest.mode || "takeover")
                .trim()
                .toLowerCase() === "transfer"
                ? "transfer"
                : "takeover",
            shownToOwner: raw.pendingAuthRequest.shownToOwner === true,
          }
        : null,
  };
}

const orderFingerprintList = (orders) =>
  JSON.stringify(
    (Array.isArray(orders) ? orders : []).map((o) => ({
      id: o.id,
      s: o.workflowStatus,
      st: o.station,
      rev: o.revision,
      paymentStatus: o.paymentStatus,
      dueAmount: o.dueAmount,
      hasCorrections: hasCorrections(o),
      corrections: correctionRecords(o).map((record) => ({
        id: record?.id || record?.correctionId || "",
        changed: Array.isArray(record?.changedItems)
          ? record.changedItems.length
          : 0,
        removed: Array.isArray(record?.removedItems)
          ? record.removedItems.length
          : 0,
      })),
      d: o.items.map((i) => ({
        id: i.id,
        lineId: i.lineId,
        done: i.done,
        qty: i.qty,
        correctionStatus: i.correctionStatus,
      })),
    })),
  );

const unwrapRealtimePayloadDetail = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const detail =
    payload.detail && typeof payload.detail === "object"
      ? payload.detail
      : payload;
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail
    : null;
};

const realtimePayloadKey = (payload) => {
  const reason = String(payload?.reason ?? "refresh").trim() || "refresh";
  const atMs = Number(payload?.atMs ?? 0) || 0;
  return `${reason}:${atMs}`;
};

const collectRealtimeOrders = (detail) => {
  if (!detail || typeof detail !== "object") return [];
  return [
    detail.order,
    ...(Array.isArray(detail.orders) ? detail.orders : []),
    ...(Array.isArray(detail.rebalancedOrders) ? detail.rebalancedOrders : []),
    ...(Array.isArray(detail.restoredOrders) ? detail.restoredOrders : []),
    ...(Array.isArray(detail.assignedPendingOrders)
      ? detail.assignedPendingOrders
      : []),
    ...(Array.isArray(detail.assignedOperatorOrders)
      ? detail.assignedOperatorOrders
      : []),
  ].filter((entry) => entry && typeof entry === "object");
};

const normalizeStationStateEntry = (entry) => {
  const normalized = normalizeStationSession(entry);
  if (!normalized) return null;
  return {
    ...normalized,
    operatorName: normalized.operatorName || "Guest",
    operatorRole: normalized.operatorRole || "Non autenticato",
    updatedAtMs: normalized.updatedAtMs || Date.now(),
  };
};

const stationStatesFingerprint = (states) =>
  JSON.stringify(Array.isArray(states) ? states : []);

function groupItems(order) {
  const map = new Map();
  const list = Array.isArray(order?.items) ? order.items : [];
  for (const item of list) {
    const removed = isCorrectionRemovedItem(item);
    const lineId = itemLineId(item);
    const key = `${removed ? "removed" : "active"}|${lineId || String(item.name || "").toLowerCase()}|${String(item.variant || "").toLowerCase()}|${String(item.note || "").toLowerCase()}`;
    const g = map.get(key) || {
      key,
      lineId,
      name: item.name || "Articolo",
      variant: item.variant || "",
      note: item.note || "",
      removed,
      items: [],
      quantity: 0,
      doneQuantity: 0,
    };
    const qty = itemQty(item);
    g.quantity += qty;
    if (!removed && item.done === true) g.doneQuantity += qty;
    g.items.push(item);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => {
    if (a.removed !== b.removed) return a.removed ? 1 : -1;
    return a.name.localeCompare(b.name, "it", { sensitivity: "base" });
  });
}

export default function App() {
  const initApi = resolveApiBase();
  const apiRef = useRef(initApi);

  const persistedOperator = readJson(LS.operator, null);
  const persistedAuth = readJson(LS.auth, null);

  const [stationName, setStationName] = useState(
    normStation(readJson(LS.station, STATIONS[0])),
  );
  const [stationActive, setStationActive] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [search, setSearch] = useState("");

  const [orders, setOrders] = useState([]);
  const [waiters, setWaiters] = useState([]);
  const [waiterCallStates, setWaiterCallStates] = useState({});
  const [menu, setMenu] = useState([]);
  const [menuCatalog, setMenuCatalog] = useState(() => ({
    categories: [],
    products: [],
  }));
  const [tempItems, setTempItems] = useState(() => {
    const raw = readJson(LS.tempItems, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: String(item.id || uuid()),
        name: normalizeName(item.name),
        stations: Array.isArray(item.stations)
          ? item.stations.map(normStation)
          : [...STATIONS],
        price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
        qtyRemaining:
          item.qtyRemaining == null || item.qtyRemaining === ""
            ? null
            : Math.max(0, Math.floor(Number(item.qtyRemaining) || 0)),
        createdAtMs: Number(item.createdAtMs || Date.now()),
      }))
      .filter((item) => item.name.length > 0);
  });
  const [disabledGlobal, setDisabledGlobal] = useState(() => {
    const raw = readJson(LS.disabledGlobal, []);
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((item) => keyName(item)).filter(Boolean))];
  });
  const [disabledLocal, setDisabledLocal] = useState(() => {
    const raw = readJson(LS.disabledLocal, {});
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    Object.keys(raw).forEach((station) => {
      const values = raw[station];
      if (!Array.isArray(values)) return;
      out[normStation(station)] = [
        ...new Set(values.map((item) => keyName(item)).filter(Boolean)),
      ];
    });
    return out;
  });
  const [selectedId, setSelectedId] = useState(null);
  const [dismissedCancelledOrderIds, setDismissedCancelledOrderIds] = useState(
    () => {
      const raw = readJson(LS.cancelledDismissals, []);
      return new Set(
        (Array.isArray(raw) ? raw : [])
          .map((entry) => String(entry || "").trim())
          .filter(Boolean),
      );
    },
  );
  const [stationStates, setStationStates] = useState(() =>
    STATIONS.map((station) => ({
      station,
      active: true,
      realStation: false,
      configuredStation: true,
      operatorName: "Guest",
      operatorRole: "Non autenticato",
      updatedAtMs: Date.now(),
    })),
  );
  const [configuredStations, setConfiguredStations] = useState([...STATIONS]);
  const [activeStationSessions, setActiveStationSessions] = useState([]);
  const [nowMs, setNowMs] = useState(Date.now());
  const [online, setOnline] = useState(navigator.onLine !== false);

  const [syncInfo, setSyncInfo] = useState({ ok: true, apiBase: initApi });
  const [allowTransferWaiting, setAllowTransferWaiting] = useState(false);
  const [modal, setModal] = useState({
    login: false,
    transfer: false,
    auth: false,
    catalog: false,
    scope: false,
    tempItem: false,
    print: false,
    notify: false,
    pauseTransfer: false,
    logoutConfirm: false,
  });
  const [toast, setToast] = useState({ show: false, text: "" });
  const [transferTarget, setTransferTarget] = useState("");
  const [pauseTransferTarget, setPauseTransferTarget] = useState("");
  const [pauseTransferCandidates, setPauseTransferCandidates] = useState([]);
  const [pendingLogoutOptions, setPendingLogoutOptions] = useState(null);
  const [pendingAuth, setPendingAuth] = useState(null);
  const [pendingDisableItem, setPendingDisableItem] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogOpenCats, setCatalogOpenCats] = useState({});
  const [editingTempName, setEditingTempName] = useState("");
  const [pendingNotify, setPendingNotify] = useState("");
  const [tempDraft, setTempDraft] = useState(() => ({
    name: "",
    price: "",
    qty: "",
    stations: [...STATIONS],
  }));

  const [auth, setAuth] = useState(() => {
    const loggedIn = persistedOperator?.loggedIn === true;
    const userName = loggedIn
      ? String(persistedOperator?.userName || "Guest")
      : "Guest";
    const userRole = loggedIn
      ? String(persistedOperator?.userRole || "Operatore")
      : "Non autenticato";
    return {
      loggedIn,
      userName,
      userRole,
      token: String(persistedAuth?.token || ""),
      userId: String(persistedAuth?.userId || ""),
      username: String(persistedAuth?.username || ""),
      fullName: String(persistedAuth?.fullName || userName),
      deviceUuid: getOrCreateId(LS.loginDevice),
    };
  });
  const [pendingLoginAuth, setPendingLoginAuth] = useState(null);
  const [loginWorkstations, setLoginWorkstations] = useState([]);
  const [workstationSelection, setWorkstationSelection] = useState({
    pendingId: "",
    error: "",
  });

  const [login, setLogin] = useState(() => ({
    username: "",
    pin: "",
    remember: false,
    showPin: false,
    pending: false,
    error: "",
    backendStatus: "checking",
  }));
  const [managedUsers, setManagedUsers] = useState([]);
  const [managedUsersLoading, setManagedUsersLoading] = useState(false);
  const [managedUsersError, setManagedUsersError] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [entryStage, setEntryStage] = useState("launcher");
  const [holdProgress, setHoldProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const holdStartRef = useRef(null);
  const holdRafRef = useRef(null);

  const initialActionQueue = useMemo(() => {
    const raw = readJson(LS.actionQueue, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry) => entry && typeof entry === "object");
  }, []);

  const toastTimerRef = useRef(null);
  const ordersRef = useRef(orders);
  const stationRef = useRef(stationName);
  const authRef = useRef(auth);
  const stationStatesRef = useRef(stationStates);
  const waiterCallStatesRef = useRef(waiterCallStates);
  const prevStationActiveRef = useRef(stationActive);
  const pauseNotificationsRef = useRef({});
  const actionQueueRef = useRef(initialActionQueue);
  const flushingActionsRef = useRef(false);
  const notificationPullInflightRef = useRef(false);
  const notificationPullQueuedRef = useRef(false);
  const notificationSessionGenerationRef = useRef(0);
  const recentRealtimePayloadKeysRef = useRef([]);
  const notificationStreamConnectedRef = useRef(false);
  const notificationStreamHandlersRef = useRef({
    applyRealtimePayload: () => false,
    getWaiterAckConsumer: () => "",
    pullStationNotifications: () => Promise.resolve(false),
    runSync: () => Promise.resolve(false),
  });
  const fullSyncCoordinatorRef = useRef(null);
  const fullSyncExecutorRef = useRef(null);
  const layoutSyncExecutorRef = useRef(null);
  const layoutSingleFlightRef = useRef(null);
  const stationHeartbeatInflightRef = useRef(false);
  const logoutInflightRef = useRef(false);
  const orderSyncInflightRef = useRef(new Map());
  const activeApiControllersRef = useRef(new Set());
  const settingsVersionRef = useRef(
    Number(readJson(LS.settingsVersion, 0)) || 0,
  );

  const layoutByIdRef = useRef(new Map());
  const layoutByNumRef = useRef(new Map());
  const orderFpRef = useRef("");
  const waiterFpRef = useRef("");
  const menuFpRef = useRef("");
  const stationFpRef = useRef("");

  if (!layoutSingleFlightRef.current) {
    layoutSingleFlightRef.current = createSingleFlight(() =>
      layoutSyncExecutorRef.current ? layoutSyncExecutorRef.current() : false,
    );
  }

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  useEffect(() => {
    stationRef.current = stationName;
  }, [stationName]);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  useEffect(() => {
    stationStatesRef.current = stationStates;
  }, [stationStates]);
  useEffect(() => {
    waiterCallStatesRef.current = waiterCallStates;
  }, [waiterCallStates]);

  const pushToast = useCallback((text, ms = 1600) => {
    if (!authRef.current?.loggedIn) return false;
    setToast({ show: true, text: String(text || "") });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(
      () => setToast((x) => ({ ...x, show: false })),
      Math.max(400, Math.trunc(ms)),
    );
    return true;
  }, []);

  useEffect(
    () => () => toastTimerRef.current && clearTimeout(toastTimerRef.current),
    [],
  );

  const getWaiterAckConsumer = useCallback((stationNameForConsumer) => {
    const stationToken =
      normalizeToken(stationNameForConsumer || stationRef.current) || "station";
    const deviceToken =
      normalizeToken(
        authRef.current?.deviceUuid || getOrCreateId(LS.loginDevice),
      ) || "device";
    return `postazione-waiter-call-feedback:${stationToken.slice(0, 48)}:${deviceToken.slice(0, 64)}`;
  }, []);

  const clearWaiterCallStateByKey = useCallback((key) => {
    const safeKey = personKey(key);
    if (!safeKey) return;
    setWaiterCallStates((prev) => {
      if (!prev || !prev[safeKey]) return prev;
      const next = { ...prev };
      delete next[safeKey];
      return next;
    });
  }, []);

  const setWaiterCallState = useCallback((waiter, patch = {}) => {
    const key = waiterKey(waiter);
    if (!key) return "";
    setWaiterCallStates((prev) => {
      const current = prev?.[key] || {};
      return {
        ...prev,
        [key]: {
          key,
          waiterName: normalizeName(
            waiter?.name || waiter?.fullName || current.waiterName,
          ),
          username: normalizeName(waiter?.username || current.username),
          userId: normalizeName(waiter?.userId || current.userId),
          station: normStation(stationRef.current),
          startedAt: current.startedAt || Date.now(),
          notificationId: normalizeName(
            patch.notificationId || current.notificationId,
          ),
          sending: Object.prototype.hasOwnProperty.call(patch, "sending")
            ? patch.sending === true
            : current.sending === true,
          acknowledged: Object.prototype.hasOwnProperty.call(
            patch,
            "acknowledged",
          )
            ? patch.acknowledged === true
            : current.acknowledged === true,
          acknowledgedAt:
            patch.acknowledged === true
              ? Date.now()
              : Number(current.acknowledgedAt) || 0,
        },
      };
    });
    return key;
  }, []);

  const acknowledgeWaiterCallFeedback = useCallback(
    (meta = {}) => {
      const sourceNotificationId = normalizeName(meta.sourceNotificationId);
      const waiterName = normalizeName(
        meta.waiter ||
          meta.targetFullName ||
          meta.targetUsername ||
          meta.username,
      );
      let foundKey = "";
      setWaiterCallStates((prev) => {
        const entries = Object.entries(prev || {});
        const found =
          entries.find(
            ([, entry]) =>
              sourceNotificationId &&
              normalizeName(entry?.notificationId) === sourceNotificationId,
          ) ||
          entries.find(
            ([, entry]) =>
              waiterName &&
              personKey(entry?.waiterName) === personKey(waiterName),
          );
        if (!found) return prev;
        foundKey = found[0];
        return {
          ...prev,
          [foundKey]: {
            ...found[1],
            sending: false,
            acknowledged: true,
            acknowledgedAt: Date.now(),
          },
        };
      });
      if (foundKey) {
        window.setTimeout(
          () => clearWaiterCallStateByKey(foundKey),
          WAITER_ACK_VISIBLE_MS,
        );
      }
    },
    [clearWaiterCallStateByKey],
  );

  useEffect(
    () => writeJson(LS.station, normStation(stationName)),
    [stationName],
  );
  useEffect(() => {
    writeJson(LS.operator, {
      loggedIn: auth.loggedIn,
      userName: auth.userName,
      userRole: auth.userRole,
    });
    if (auth.loggedIn) {
      writeJson(LS.auth, {
        token: auth.token,
        userId: auth.userId,
        username: auth.username,
        fullName: auth.fullName,
      });
      updateNativeNotificationSession({
        token: auth.token,
        userId: auth.userId,
        username: auth.username,
        fullName: auth.fullName,
        deviceUuid: auth.deviceUuid,
        roomId: "",
        roomName: normStation(stationName),
      });
      dispatchPostazioneSessionEvent(POSTAZIONE_SESSION_ACTIVE_EVENT);
    } else {
      removeAuthKey(LS.auth);
      clearNativeNotificationSession();
      dispatchPostazioneSessionEvent(POSTAZIONE_SESSION_CLEARED_EVENT);
    }
  }, [auth, stationName]);
  useEffect(() => {
    writeJson(LS.tempItems, tempItems);
  }, [tempItems]);
  useEffect(() => {
    writeJson(LS.disabledGlobal, disabledGlobal);
  }, [disabledGlobal]);
  useEffect(() => {
    writeJson(LS.disabledLocal, disabledLocal);
  }, [disabledLocal]);
  useEffect(() => {
    writeJson(LS.cancelledDismissals, [...dismissedCancelledOrderIds]);
  }, [dismissedCancelledOrderIds]);

  useEffect(
    () => document.body.setAttribute("data-theme", darkMode ? "dark" : "light"),
    [darkMode],
  );
  useEffect(() => {
    document.body.classList.toggle("is-paused", !stationActive);
    return () => document.body.classList.remove("is-paused");
  }, [stationActive]);

  useEffect(() => {
    const onUp = () => {
      setOnline(true);
      pushToast("ONLINE");
    };
    const onDown = () => {
      setOnline(false);
      pushToast("OFFLINE: backend non raggiungibile");
    };
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    return () => {
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, [pushToast]);

  const stationStateMap = useMemo(() => {
    const map = new Map();
    stationStates.forEach((entry) => {
      if (!entry?.station) return;
      map.set(normStation(entry.station), entry);
    });
    return map;
  }, [stationStates]);

  const currentStationIdentity = useMemo(
    () => ({
      userId: auth.userId,
      username: auth.username,
      fullName: auth.fullName || auth.userName,
      deviceUuid: auth.deviceUuid,
    }),
    [auth.deviceUuid, auth.fullName, auth.userId, auth.userName, auth.username],
  );

  const transferTargetAvailable = useMemo(() => {
    const target = normStation(transferTarget);
    if (!target || target === normStation(stationName)) return false;
    return stationStates.some(
      (entry) =>
        normStation(entry?.station) === target && isRealActiveStation(entry),
    );
  }, [stationName, stationStates, transferTarget]);

  const disabledGlobalSet = useMemo(
    () => new Set(disabledGlobal),
    [disabledGlobal],
  );

  const menuCatalogByName = useMemo(() => {
    const map = new Map();
    const products = Array.isArray(menuCatalog.products)
      ? menuCatalog.products
      : [];
    products.forEach((product) => {
      const name = String(product?.name || "").trim();
      const key = keyName(name);
      if (!key || map.has(key)) return;
      map.set(key, {
        category: String(product?.category || "").trim(),
        variants: normalizeVariants(product?.variants),
      });
    });
    return map;
  }, [menuCatalog.products]);

  const menuCategoryOrder = useMemo(
    () =>
      (Array.isArray(menuCatalog.categories) ? menuCatalog.categories : [])
        .map((category) => String(category?.name || "").trim())
        .filter(Boolean),
    [menuCatalog.categories],
  );

  const menuWithTemp = useMemo(() => {
    const base = menu.map((item) => {
      const name = String(item?.name || "").trim();
      const linked = menuCatalogByName.get(keyName(name));
      const variants = [
        ...normalizeVariants(linked?.variants),
        ...normalizeVariants(item?.variants),
      ];
      return {
        name,
        price: Number.isFinite(Number(item?.price)) ? Number(item.price) : null,
        stations: Array.isArray(item?.stations)
          ? item.stations.map(normStation)
          : [...STATIONS],
        variants: [...new Set(variants)],
        category: String(item?.category || linked?.category || "").trim(),
        isTemp: false,
        qtyRemaining: null,
        id: "",
        createdAtMs: 0,
      };
    });
    const temp = tempItems.map((item) => ({
      name: String(item?.name || "").trim(),
      price: Number.isFinite(Number(item?.price)) ? Number(item.price) : null,
      stations: Array.isArray(item?.stations)
        ? item.stations.map(normStation)
        : [...STATIONS],
      variants: normalizeVariants(item?.variants),
      category: "Temporanei",
      isTemp: true,
      qtyRemaining:
        item.qtyRemaining == null || item.qtyRemaining === ""
          ? null
          : Math.max(0, Math.floor(Number(item.qtyRemaining) || 0)),
      id: String(item?.id || ""),
      createdAtMs: Number(item?.createdAtMs || 0),
    }));
    return [...base, ...temp]
      .filter((item) => item.name)
      .sort((left, right) =>
        left.name.localeCompare(right.name, "it", { sensitivity: "base" }),
      );
  }, [menu, menuCatalogByName, tempItems]);

  const findMenuItemByName = useCallback(
    (name) => {
      const key = keyName(name);
      if (!key) return null;
      return menuWithTemp.find((item) => keyName(item.name) === key) || null;
    },
    [menuWithTemp],
  );

  const menuStationsFor = useCallback(
    (name) => {
      const hit = findMenuItemByName(name);
      if (!hit || !Array.isArray(hit.stations) || hit.stations.length === 0)
        return [...STATIONS];
      return hit.stations.map(normStation);
    },
    [findMenuItemByName],
  );

  const menuPriceFor = useCallback(
    (name) => {
      const hit = findMenuItemByName(name);
      if (!hit) return null;
      return Number.isFinite(Number(hit.price)) ? Number(hit.price) : null;
    },
    [findMenuItemByName],
  );

  const getTempItemByName = useCallback(
    (name) => {
      const key = keyName(name);
      if (!key) return null;
      return tempItems.find((item) => keyName(item.name) === key) || null;
    },
    [tempItems],
  );

  const isItemSoldOutByQty = useCallback(
    (name) => {
      const hit = getTempItemByName(name);
      if (!hit) return false;
      if (hit.qtyRemaining == null || hit.qtyRemaining === "") return false;
      const qty = Number(hit.qtyRemaining);
      return Number.isFinite(qty) && qty <= 0;
    },
    [getTempItemByName],
  );

  const isItemDisabledForStation = useCallback(
    (name, station) => {
      const key = keyName(name);
      if (!key) return false;
      if (disabledGlobalSet.has(key)) return true;
      if (isItemSoldOutByQty(name)) return true;
      const stationKey = normStation(station || stationRef.current);
      const localList = Array.isArray(disabledLocal[stationKey])
        ? disabledLocal[stationKey]
        : [];
      return localList.includes(key);
    },
    [disabledGlobalSet, disabledLocal, isItemSoldOutByQty],
  );

  const isOrderItemDisabled = useCallback(
    (item, station) => {
      if (!item) return true;
      if (item.ignoreDisabled === true) return false;
      return isItemDisabledForStation(item.name, station);
    },
    [isItemDisabledForStation],
  );

  const computeStatus = useCallback(
    (order) => {
      if (!order || typeof order !== "object") return "new";
      if (isCancelledOrder(order)) return "cancelled";
      const workflow = wf(order.workflowStatus);
      const completed = msOrNull(order.completedAtMs);
      if (completed || workflow === "delivered") return "done";
      if (workflow === "ready") return "ready";
      const station = normStation(order.station || stationRef.current);
      const items = Array.isArray(order.items) ? order.items : [];
      const effective = items.filter(
        (item) =>
          !isCorrectionRemovedItem(item) && !isOrderItemDisabled(item, station),
      );
      const total = effective.reduce((sum, item) => sum + itemQty(item), 0);
      const done = effective.reduce(
        (sum, item) => sum + (item.done === true ? itemQty(item) : 0),
        0,
      );
      if (workflow === "prep") return "prep";
      if (total > 0 && done === total) return "ready";
      if (done > 0) return "prep";
      return "new";
    },
    [isOrderItemDisabled],
  );

  const assignOwner = useCallback((order, ownerStation) => {
    const authLocal = authRef.current;
    const station = normStation(ownerStation || stationRef.current);
    return {
      ...order,
      ownerStation: station,
      ownerOperator: authLocal.loggedIn ? authLocal.userName : "Guest",
      ownerRole: authLocal.loggedIn ? authLocal.userRole : "Non autenticato",
      ownerAtMs: Date.now(),
    };
  }, []);

  const releaseOwner = useCallback(
    (order) => ({
      ...order,
      ownerStation: null,
      ownerOperator: null,
      ownerRole: null,
      ownerAtMs: null,
    }),
    [],
  );

  const isStationOnline = useCallback(
    (station) => {
      const key = normStation(station);
      if (!key) return true;
      const hit = stationStateMap.get(key);
      if (!hit) return true;
      return isRealActiveStation(hit);
    },
    [stationStateMap],
  );

  const isTransferredOutForStation = useCallback((order, station) => {
    if (!order) return false;
    const currentStation = normStation(station || stationRef.current);
    const ownerStationRaw = String(order.ownerStation || "").trim();
    if (ownerStationRaw && normStation(ownerStationRaw) === currentStation)
      return false;

    const orderStationRaw = String(order.station || "").trim();
    const transferredFromRaw = String(
      order.transferredFromStation || "",
    ).trim();
    if (!orderStationRaw || !transferredFromRaw) return false;

    const orderStation = normStation(orderStationRaw);
    const transferredFrom = normStation(transferredFromRaw);
    return (
      orderStation !== currentStation && transferredFrom === currentStation
    );
  }, []);

  const apiFetchJson = useCallback(async (path, opts = {}) => {
    const method = String(opts.method || "GET").toUpperCase();
    const bases = [apiRef.current].filter(Boolean);
    const sessionGeneration = Number.isFinite(Number(opts.sessionGeneration))
      ? Number(opts.sessionGeneration)
      : null;
    const isSessionCurrent = () =>
      sessionGeneration === null ||
      (sessionGeneration === notificationSessionGenerationRef.current &&
        isAuthenticatedPostazioneSession(authRef.current));
    for (const base of bases) {
      if (!isSessionCurrent()) return null;
      const ctrl = new AbortController();
      activeApiControllersRef.current.add(ctrl);
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const authLocal = authRef.current || {};
        const res = await fetch(`${base}${path}`, {
          method,
          body: opts.body,
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
            "X-Client-App": "postazione",
            ...(String(authLocal.token || "").trim()
              ? { Authorization: `Bearer ${String(authLocal.token).trim()}` }
              : {}),
            ...(String(authLocal.userId || "").trim()
              ? { "X-User-Id": String(authLocal.userId).trim() }
              : {}),
            ...(String(authLocal.deviceUuid || "").trim()
              ? { "X-Device-Uuid": String(authLocal.deviceUuid).trim() }
              : {}),
            ...(opts.headers || {}),
          },
          signal: ctrl.signal,
        });
        if (!isSessionCurrent()) return null;
        if (!res.ok) continue;
        const json = await res.json().catch(() => null);
        if (!isSessionCurrent()) return null;
        return json;
      } catch {
        // The configured API is the only allowed transport.
      } finally {
        clearTimeout(timer);
        activeApiControllersRef.current.delete(ctrl);
      }
    }
    return null;
  }, []);

  const persistActionQueue = useCallback(() => {
    writeJson(LS.actionQueue, actionQueueRef.current);
  }, []);

  const trySendAction = useCallback(
    async (action) => {
      if (!apiRef.current) return true;
      const res = await apiFetchJson("/api/actions", {
        method: "POST",
        body: JSON.stringify(action),
      });
      return !!res;
    },
    [apiFetchJson],
  );

  const flushActionQueue = useCallback(async () => {
    if (flushingActionsRef.current) return;
    if (navigator.onLine === false) return;
    if (
      !Array.isArray(actionQueueRef.current) ||
      actionQueueRef.current.length === 0
    )
      return;
    flushingActionsRef.current = true;
    try {
      const remaining = [];
      for (const action of actionQueueRef.current) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await trySendAction(action);
        if (!ok) remaining.push(action);
      }
      actionQueueRef.current = remaining;
      persistActionQueue();
    } finally {
      flushingActionsRef.current = false;
    }
  }, [persistActionQueue, trySendAction]);

  const queueAction = useCallback(
    (action) => {
      if (!action || typeof action !== "object") return;
      actionQueueRef.current.push({
        ...action,
        queuedAtMs: Date.now(),
      });
      persistActionQueue();
      if (navigator.onLine !== false) {
        void flushActionQueue();
      }
    },
    [flushActionQueue, persistActionQueue],
  );

  useEffect(() => {
    void flushActionQueue();
  }, [flushActionQueue]);

  useEffect(() => {
    const onOnline = () => {
      void flushActionQueue();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushActionQueue]);

  const syncFlags = useCallback(async () => {
    const payload = await apiFetchJson("/api/flags", { method: "GET" });
    if (!payload || typeof payload !== "object") return false;
    const enabled = payload.allowTransferWaiting === true;
    setAllowTransferWaiting(enabled);
    return true;
  }, [apiFetchJson]);

  const syncOrder = useCallback(
    async (order) => {
      const orderId = String(order?.id || "").trim();
      if (!orderId) return false;
      const pending = orderSyncInflightRef.current.get(orderId);
      if (pending) return pending;
      const request = (async () => {
        const res = await apiFetchJson("/api/integration/orders/sync", {
          method: "POST",
          body: JSON.stringify({ id: orderId, order }),
        });
        return !!res;
      })();
      orderSyncInflightRef.current.set(orderId, request);
      try {
        return await request;
      } finally {
        if (orderSyncInflightRef.current.get(orderId) === request) {
          orderSyncInflightRef.current.delete(orderId);
        }
      }
    },
    [apiFetchJson],
  );

  const syncOrderReliably = useCallback(
    async (order) => {
      const sessionGeneration = notificationSessionGenerationRef.current;
      const delays = [0, 350, 900, 1800];
      for (const delay of delays) {
        if (
          !isCurrentPostazioneSession(
            sessionGeneration,
            notificationSessionGenerationRef.current,
            authRef.current,
          )
        )
          return false;
        if (delay > 0) await waitMs(delay);
        if (await syncOrder(order)) return true;
      }
      return false;
    },
    [syncOrder],
  );

  const publishNotif = useCallback(
    async (type, title, description, meta = {}) => {
      const safeType = ["waiter", "bell", "general"].includes(String(type))
        ? String(type)
        : "general";
      const res = await apiFetchJson("/api/integration/notifications/publish", {
        method: "POST",
        body: JSON.stringify({
          type: safeType,
          title: String(title || ""),
          description: String(description || ""),
          meta,
        }),
      });
      return res || null;
    },
    [apiFetchJson],
  );

  const performLayoutSync = useCallback(async () => {
    const payload = await apiFetchJson("/api/integration/layout", {
      method: "GET",
    });
    if (!payload?.tables || !Array.isArray(payload.tables)) return false;
    const byId = new Map();
    const byNum = new Map();
    for (const t of payload.tables) {
      const id = String(t?.id || "").trim();
      if (!id) continue;
      const number = Number.isFinite(Number(t?.number))
        ? Math.max(0, Math.trunc(Number(t.number)))
        : 0;
      const row = {
        id,
        number,
        roomId: String(t?.roomId || ""),
        roomName: String(t?.roomName || ""),
      };
      byId.set(id, row);
      const bucket = byNum.get(number) || [];
      bucket.push(row);
      byNum.set(number, bucket);
    }
    layoutByIdRef.current = byId;
    layoutByNumRef.current = byNum;
    return true;
  }, [apiFetchJson]);

  layoutSyncExecutorRef.current = performLayoutSync;
  const syncLayout = useCallback(() => layoutSingleFlightRef.current.run(), []);

  const syncMenu = useCallback(async () => {
    const payload = await apiFetchJson("/api/integration/menu", {
      method: "GET",
    });
    if (!payload || typeof payload !== "object") return false;
    const categories = Array.isArray(payload.categories)
      ? payload.categories
          .map((entry) => ({
            id: String(entry?.id || "").trim(),
            name: String(entry?.name || "").trim(),
          }))
          .filter((entry) => entry.id && entry.name)
      : [];
    const categoryNameById = new Map(
      categories.map((entry) => [entry.id, entry.name]),
    );
    const products = Array.isArray(payload.products)
      ? payload.products
          .map((entry) => ({
            id: String(entry?.id || "").trim(),
            name: String(entry?.name || "").trim(),
            categoryId: String(entry?.categoryId || "").trim(),
            category: String(
              categoryNameById.get(String(entry?.categoryId || "").trim()) ||
                "",
            ).trim(),
            price: Number.isFinite(Number(entry?.price))
              ? Number(entry.price)
              : 0,
            variants: normalizeVariants(entry?.variants),
          }))
          .filter((entry) => entry.id && entry.name)
      : [];

    const productMetaByName = new Map();
    products.forEach((product) => {
      const key = keyName(product.name);
      if (!key || productMetaByName.has(key)) return;
      productMetaByName.set(key, product);
    });

    const postazioneItems = Array.isArray(payload.postazioneItems)
      ? payload.postazioneItems
      : [];
    const nextRaw = postazioneItems.length
      ? postazioneItems.map((entry) => {
          const name = String(entry?.name || "").trim();
          const linked = productMetaByName.get(keyName(name));
          const localVariants = normalizeVariants(entry?.variants);
          const linkedVariants = normalizeVariants(linked?.variants);
          const category = String(
            linked?.category || entry?.category || "",
          ).trim();
          const stations = Array.isArray(entry?.stations)
            ? entry.stations
                .map((station) => String(station).trim())
                .filter(Boolean)
            : resolveStationsForCategory(category);
          return {
            name,
            price: Number.isFinite(Number(entry?.price))
              ? Number(entry.price)
              : Number.isFinite(Number(linked?.price))
                ? Number(linked.price)
                : 0,
            stations,
            variants: [...new Set([...linkedVariants, ...localVariants])],
            category,
          };
        })
      : products.map((product) => ({
          name: String(product.name || "").trim(),
          price: Number.isFinite(Number(product.price))
            ? Number(product.price)
            : 0,
          stations: resolveStationsForCategory(product.category),
          variants: normalizeVariants(product.variants),
          category: String(product.category || "").trim(),
        }));

    const next = nextRaw.filter((entry) => entry.name);
    const fp = JSON.stringify({
      menu: next,
      categories,
      products,
    });
    if (fp === menuFpRef.current) return true;
    menuFpRef.current = fp;
    setMenu(next);
    setMenuCatalog({ categories, products });
    return true;
  }, [apiFetchJson]);

  const syncWaiters = useCallback(async () => {
    const payload = await apiFetchJson(
      `/api/integration/waiters?source=mobile-frontend&activeMs=${WAITER_ACTIVE_MS}`,
      { method: "GET" },
    );
    if (!payload?.waiters || !Array.isArray(payload.waiters)) return false;
    const authLocal = authRef.current || {};
    const selfUserId = String(authLocal.userId || "").trim();
    const selfUsername = personKey(authLocal.username || "");
    const selfFullName = personKey(
      authLocal.fullName || authLocal.userName || "",
    );
    const next = payload.waiters
      .map((x, i) => {
        const name = String(x?.fullName || x?.name || x?.username || "").trim();
        if (!name) return null;
        return {
          id:
            name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((p) => p[0] || "")
              .join("")
              .toUpperCase() || String(i + 1),
          name,
          username: String(x?.username || ""),
          userId: String(x?.userId || ""),
          clientApp: String(x?.clientApp || "")
            .trim()
            .toLowerCase(),
          roomId: String(x?.roomId || ""),
          roomName: String(x?.roomName || ""),
          assignedRoomIds: Array.isArray(x?.assignedRoomIds)
            ? x.assignedRoomIds
                .map((entry) => String(entry || "").trim())
                .filter(Boolean)
            : [],
          online: x?.online !== false && x?.activeNow !== false,
          activeNow: x?.activeNow !== false && x?.online !== false,
          onPause:
            x?.onPause === true ||
            x?.pauseStatus?.active === true ||
            x?.pauseStatus?.graceActive === true,
          pauseStatus:
            x?.pauseStatus && typeof x.pauseStatus === "object"
              ? x.pauseStatus
              : null,
        };
      })
      .filter(Boolean)
      .filter((entry) => entry.clientApp === "mobile-frontend")
      .filter((entry) => entry.online && entry.activeNow)
      .filter((entry) => {
        if (selfUserId && String(entry.userId || "").trim() === selfUserId)
          return false;
        if (selfUsername && personKey(entry.username) === selfUsername)
          return false;
        if (selfFullName && personKey(entry.name) === selfFullName)
          return false;
        return true;
      });
    const fp = JSON.stringify(next);
    if (fp === waiterFpRef.current) return true;
    waiterFpRef.current = fp;
    setWaiters(next);
    window.__postazioneActiveMobileWaiters = next.slice();
    try {
      window.dispatchEvent(
        new CustomEvent("postazione:waiters-updated", {
          detail: { waiters: next.slice() },
        }),
      );
    } catch {
      // noop
    }
    return true;
  }, [apiFetchJson]);

  const syncStationStates = useCallback(async () => {
    const payload = await apiFetchJson("/api/integration/stations/active", {
      method: "GET",
    });
    if (!payload?.stations || !Array.isArray(payload.stations)) return false;
    const normalized = normalizeActiveStationsPayload(payload);
    const nextConfigured = configuredStationsFromPayload(payload, [
      stationRef.current,
    ]);
    const stationNames =
      nextConfigured.length > 0 ? nextConfigured : [...STATIONS];
    const sessionsByStation = new Map();
    normalized.sessions.forEach((entry) => {
      const station = normStation(entry.station);
      const bucket = sessionsByStation.get(station) || [];
      bucket.push(entry);
      sessionsByStation.set(station, bucket);
    });
    const next = stationNames.map((station) => {
      const sessions = sessionsByStation.get(station) || [];
      const hit = sessions.find(isRealActiveStation) || sessions[0] || null;
      return (
        hit || {
          station,
          active: false,
          realStation: false,
          configuredStation: true,
          stale: false,
          paused: false,
          operatorName: "Guest",
          operatorRole: "Non autenticato",
          updatedAtMs: Date.now(),
        }
      );
    });
    setConfiguredStations(stationNames);
    setActiveStationSessions(normalized.activeSessions);
    const fp = stationStatesFingerprint(next);
    if (fp === stationFpRef.current) return true;
    stationFpRef.current = fp;
    stationStatesRef.current = next;
    setStationStates(next);
    return true;
  }, [apiFetchJson]);

  const pushStationHeartbeat = useCallback(
    async (overrides = {}) => {
      if (stationHeartbeatInflightRef.current) return false;
      const sessionGeneration = notificationSessionGenerationRef.current;
      const authLocal = authRef.current;
      if (!isAuthenticatedPostazioneSession(authLocal)) return false;
      stationHeartbeatInflightRef.current = true;
      try {
        const payload = {
          station: normStation(overrides.station || stationRef.current),
          active:
            typeof overrides.active === "boolean"
              ? overrides.active
              : stationActive,
          token: String(authLocal.token || "").trim(),
          userId: String(authLocal.userId || "").trim(),
          username: String(authLocal.username || "").trim(),
          fullName:
            String(
              authLocal.fullName ||
                authLocal.userName ||
                authLocal.username ||
                "Guest",
            ).trim() || "Guest",
          operatorName:
            String(
              overrides.operatorName ||
                authLocal.fullName ||
                authLocal.userName ||
                authLocal.username ||
                "Guest",
            ).trim() || "Guest",
          operatorUsername: String(authLocal.username || "").trim(),
          operatorUserId: String(authLocal.userId || "").trim(),
          operatorRole:
            String(
              overrides.operatorRole ||
                (authLocal.loggedIn ? authLocal.userRole : "Non autenticato"),
            ).trim() || "Non autenticato",
          deviceUuid: String(authLocal.deviceUuid || ""),
          clientApp: "postazione",
          ...(String(overrides.pauseTransferMode || "").trim()
            ? { pauseTransferMode: String(overrides.pauseTransferMode).trim() }
            : {}),
          ...(overrides.transferOrders === true
            ? { transferOrders: true }
            : {}),
          ...(String(overrides.pauseTransferTargetStation || "").trim()
            ? {
                pauseTransferTargetStation: normStation(
                  overrides.pauseTransferTargetStation,
                ),
                targetStation: normStation(
                  overrides.pauseTransferTargetStation,
                ),
              }
            : {}),
        };
        const res = await apiFetchJson("/api/integration/stations/state", {
          method: "POST",
          body: JSON.stringify(payload),
          sessionGeneration,
        });
        return !!res;
      } finally {
        stationHeartbeatInflightRef.current = false;
      }
    },
    [apiFetchJson, stationActive],
  );

  const syncOrders = useCallback(async () => {
    await syncLayout();
    const payload = await apiFetchJson(
      buildPostazioneOrdersPath(stationRef.current, authRef.current),
      { method: "GET" },
    );
    if (!payload?.orders || !Array.isArray(payload.orders)) {
      setSyncInfo({
        ok: false,
        apiBase: apiRef.current,
        lastError: "sync ordini non disponibile",
      });
      return false;
    }
    const next = payload.orders
      .map((o) =>
        normalizeOrder(o, layoutByIdRef.current, layoutByNumRef.current),
      )
      .filter(Boolean)
      .sort((a, b) => a.receivedAtMs - b.receivedAtMs);

    const fp = orderFingerprintList(next);
    if (fp !== orderFpRef.current) {
      orderFpRef.current = fp;
      ordersRef.current = next;
      setOrders(next);
    }

    setSyncInfo({ ok: true, apiBase: apiRef.current, lastError: "" });
    setSelectedId((prev) => {
      const candidates = next
        .filter((o) => isVisibleForStation(o, stationRef.current))
        .filter(
          (o) =>
            !(
              isCancelledOrder(o) &&
              dismissedCancelledOrderIds.has(String(o.id || "").trim())
            ),
        )
        .filter(
          (o) =>
            showHistory ||
            (!isHistoricalOrder(o) && !hideIfNoHistory(computeStatus(o))),
        );
      const base = showHistory
        ? sortOrdersOperationalFirst(candidates)
        : candidates;
      if (prev && base.some((o) => o.id === prev)) return prev;
      return base[0]?.id || null;
    });
    return true;
  }, [
    apiFetchJson,
    computeStatus,
    dismissedCancelledOrderIds,
    showHistory,
    syncLayout,
  ]);

  const applyRealtimeStationState = useCallback(
    (rawEntry) => {
      const byStation = new Map(
        (Array.isArray(stationStatesRef.current)
          ? stationStatesRef.current
          : []
        ).map((entry) => [normStation(entry?.station), entry]),
      );
      const station = canonicalStationName(rawEntry?.station);
      if (!station) return false;
      const safe = normalizeStationStateEntry({
        ...(byStation.get(station) || {}),
        ...(rawEntry || {}),
        station,
      });
      if (!safe?.station) return false;
      byStation.set(safe.station, safe);
      const stationNames = configuredStationsFromPayload(
        { stations: [...byStation.values()] },
        configuredStations,
      );
      const next = stationNames.map((stationName) => {
        const hit = byStation.get(stationName);
        return (
          hit || {
            station: stationName,
            active: false,
            realStation: false,
            configuredStation: true,
            operatorName: "Guest",
            operatorRole: "Non autenticato",
            updatedAtMs: Date.now(),
          }
        );
      });
      const fp = stationStatesFingerprint(next);
      if (fp === stationFpRef.current) return true;
      stationFpRef.current = fp;
      stationStatesRef.current = next;
      setStationStates(next);
      return true;
    },
    [configuredStations],
  );

  const applyRealtimeOrders = useCallback(
    (rawOrders) => {
      const normalized = (Array.isArray(rawOrders) ? rawOrders : [])
        .map((entry) =>
          normalizeOrder(entry, layoutByIdRef.current, layoutByNumRef.current),
        )
        .filter(Boolean);
      if (!normalized.length) return false;
      const byId = new Map(
        (Array.isArray(ordersRef.current) ? ordersRef.current : []).map(
          (entry) => [String(entry.id), entry],
        ),
      );
      normalized.forEach((order) => byId.set(String(order.id), order));
      const next = [...byId.values()].sort(
        (a, b) => a.receivedAtMs - b.receivedAtMs,
      );
      const fp = orderFingerprintList(next);
      if (fp === orderFpRef.current) return true;
      orderFpRef.current = fp;
      ordersRef.current = next;
      setOrders(next);
      setSyncInfo({ ok: true, apiBase: apiRef.current, lastError: "" });
      setSelectedId((prevSelected) => {
        const candidates = next
          .filter((o) => isVisibleForStation(o, stationRef.current))
          .filter(
            (o) =>
              !(
                isCancelledOrder(o) &&
                dismissedCancelledOrderIds.has(String(o.id || "").trim())
              ),
          )
          .filter(
            (o) =>
              showHistory ||
              (!isHistoricalOrder(o) && !hideIfNoHistory(computeStatus(o))),
          );
        const base = showHistory
          ? sortOrdersOperationalFirst(candidates)
          : candidates;
        if (prevSelected && base.some((o) => o.id === prevSelected))
          return prevSelected;
        return base[0]?.id || null;
      });
      return true;
    },
    [computeStatus, dismissedCancelledOrderIds, showHistory],
  );

  const applyRealtimePayload = useCallback(
    (payload) => {
      const detail = unwrapRealtimePayloadDetail(payload);
      if (!detail) return false;
      let applied = false;
      const rawOrders = collectRealtimeOrders(detail);
      if (rawOrders.length > 0) {
        applied = applyRealtimeOrders(rawOrders) || applied;
      }
      const stationEntries = [
        detail.stationState,
        ...(Array.isArray(detail.stationStates) ? detail.stationStates : []),
      ].filter(Boolean);
      if (
        stationEntries.length === 0 &&
        typeof detail.station === "string" &&
        Object.prototype.hasOwnProperty.call(detail, "active")
      ) {
        stationEntries.push({
          station: detail.station,
          active: detail.active,
          updatedAtMs: payload?.atMs,
        });
      }
      stationEntries.forEach((entry) => {
        applied = applyRealtimeStationState(entry) || applied;
      });
      return applied;
    },
    [applyRealtimeOrders, applyRealtimeStationState],
  );

  const pullStationNotifications = useCallback(async () => {
    const authAtStart = authRef.current;
    if (!isAuthenticatedPostazioneSession(authAtStart)) {
      notificationPullQueuedRef.current = false;
      return false;
    }
    if (notificationPullInflightRef.current) {
      notificationPullQueuedRef.current = true;
      return false;
    }
    const sessionGeneration = notificationSessionGenerationRef.current;
    notificationPullInflightRef.current = true;
    try {
      const station = stationRef.current;
      const authLocal = authAtStart;
      const defaultConsumer = `postazione:${station.toLowerCase().replace(/[^a-z0-9]+/g, "_")}:${getOrCreateId(LS.notifyDevice).slice(0, 12).toLowerCase()}`;
      const consumers = [defaultConsumer];
      if (Object.keys(waiterCallStatesRef.current || {}).length > 0) {
        consumers.push(getWaiterAckConsumer(station));
      }
      let handled = false;
      for (const consumer of [...new Set(consumers.filter(Boolean))]) {
        const params = new URLSearchParams({
          consumer,
          ackConsumer: consumer,
          clientApp: "postazione",
          station,
          userId: String(authLocal.userId || ""),
          username: String(authLocal.username || ""),
          fullName: String(authLocal.fullName || ""),
          deviceUuid: String(authLocal.deviceUuid || ""),
        });
        const payload = await apiFetchJson(
          `/api/integration/notifications/pull?${params.toString()}`,
          { method: "GET" },
        );
        if (
          !isCurrentPostazioneSession(
            sessionGeneration,
            notificationSessionGenerationRef.current,
            authRef.current,
          )
        )
          return false;
        if (
          !payload?.items ||
          !Array.isArray(payload.items) ||
          payload.items.length === 0
        )
          continue;

        for (const raw of payload.items) {
          if (
            !isCurrentPostazioneSession(
              sessionGeneration,
              notificationSessionGenerationRef.current,
              authRef.current,
            )
          )
            return false;
          const id = String(raw?.id || "").trim();
          const meta =
            raw?.meta && typeof raw.meta === "object" ? raw.meta : {};
          const et = String(meta.eventType || "")
            .trim()
            .toLowerCase();
          if (et === "waiter_ack") {
            const w = String(meta.waiter || "").trim();
            acknowledgeWaiterCallFeedback(meta);
            pushToast(
              w ? `${w} sta arrivando...` : "Il cameriere sta arrivando...",
              3200,
            );
          }
          if (et === "bell_ack_pickup") {
            const w = String(meta.waiter || "").trim();
            const o = String(meta.orderId || "").trim();
            pushToast(
              w && o
                ? `${w} ritira ${o}`
                : w
                  ? `${w} ritira la comanda`
                  : o
                    ? `Comanda ${o} ritirata`
                    : "Comanda ritirata",
              3200,
            );
          }
          if (id) {
            await apiFetchJson("/api/integration/notifications/ack", {
              method: "POST",
              body: JSON.stringify({
                id,
                consumer,
                action: "delete",
                clientApp: "postazione",
                station,
                userId: String(authLocal.userId || ""),
                username: String(authLocal.username || ""),
                fullName: String(authLocal.fullName || ""),
                deviceUuid: String(authLocal.deviceUuid || ""),
              }),
            });
            if (
              !isCurrentPostazioneSession(
                sessionGeneration,
                notificationSessionGenerationRef.current,
                authRef.current,
              )
            )
              return false;
          }
          handled = true;
        }
      }
      return handled;
    } finally {
      notificationPullInflightRef.current = false;
      const runQueuedPull =
        notificationPullQueuedRef.current && authRef.current?.loggedIn === true;
      notificationPullQueuedRef.current = false;
      if (runQueuedPull) {
        window.setTimeout(() => void pullStationNotifications(), 0);
      }
    }
  }, [
    acknowledgeWaiterCallFeedback,
    apiFetchJson,
    getWaiterAckConsumer,
    pushToast,
  ]);

  const performFullSync = useCallback(
    async (context) => {
      const canContinue = () =>
        context?.isCancelled?.() !== true &&
        isAuthenticatedPostazioneSession(authRef.current);
      if (!canContinue()) return false;
      await pushStationHeartbeat();
      if (!canContinue()) return false;
      await syncFlags();
      if (!canContinue()) return false;
      await syncStationStates();
      if (!canContinue()) return false;
      await syncMenu();
      if (!canContinue()) return false;
      await syncOrders();
      if (!canContinue()) return false;
      await syncWaiters();
      if (!canContinue()) return false;
      await pullStationNotifications();
      return canContinue();
    },
    [
      pullStationNotifications,
      pushStationHeartbeat,
      syncFlags,
      syncMenu,
      syncOrders,
      syncStationStates,
      syncWaiters,
    ],
  );

  fullSyncExecutorRef.current = performFullSync;
  const runSync = useCallback(() => {
    const coordinator = fullSyncCoordinatorRef.current;
    return coordinator ? coordinator.trigger() : Promise.resolve(false);
  }, []);
  notificationStreamHandlersRef.current = {
    applyRealtimePayload,
    getWaiterAckConsumer,
    pullStationNotifications,
    runSync,
  };

  useEffect(() => {
    if (!auth.loggedIn) {
      fullSyncCoordinatorRef.current?.cancel();
      fullSyncCoordinatorRef.current = null;
      return undefined;
    }

    const coordinator = createPostazioneSyncCoordinator({
      canRun: () => isAuthenticatedPostazioneSession(authRef.current),
      cooldownMs: POSTAZIONE_FULL_SYNC_COOLDOWN_MS,
      execute: (context) =>
        fullSyncExecutorRef.current
          ? fullSyncExecutorRef.current(context)
          : false,
    });
    fullSyncCoordinatorRef.current = coordinator;
    return () => {
      coordinator.cancel();
      if (fullSyncCoordinatorRef.current === coordinator) {
        fullSyncCoordinatorRef.current = null;
      }
    };
  }, [auth.loggedIn]);

  useEffect(() => {
    if (!auth.loggedIn) return undefined;
    let disposed = false;
    let inFlight = false;

    const applySettingsVersion = async (rawVersion) => {
      const version = Number(rawVersion);
      if (!Number.isFinite(version) || version <= 0) return;
      if (settingsVersionRef.current <= 0) {
        settingsVersionRef.current = version;
        writeJson(LS.settingsVersion, version);
        return;
      }
      if (version <= settingsVersionRef.current) return;
      settingsVersionRef.current = version;
      writeJson(LS.settingsVersion, version);
      await runSync();
    };

    const pollSettingsVersion = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const payload = await apiFetchJson(`/api/health?_=${Date.now()}`, {
          method: "GET",
        });
        if (!disposed) {
          await applySettingsVersion(
            payload?.settingsVersion ?? payload?.version,
          );
        }
      } finally {
        inFlight = false;
      }
    };

    const onStorage = (event) => {
      if (event.key !== LS.settingsVersion) return;
      void applySettingsVersion(event.newValue);
    };
    const onFocus = () => void pollSettingsVersion();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    void pollSettingsVersion();
    const timer = window.setInterval(pollSettingsVersion, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [apiFetchJson, auth.loggedIn, runSync]);

  useEffect(() => {
    const c = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(c);
  }, []);

  useEffect(() => {
    if (!auth.loggedIn) return undefined;
    let lastFullSyncAt = 0;
    const pushHeartbeatOnly = () =>
      pushStationHeartbeat({
        station: stationRef.current,
        active: stationActive,
        operatorName: authRef.current.loggedIn
          ? authRef.current.userName
          : "Guest",
        operatorRole: authRef.current.loggedIn
          ? authRef.current.userRole
          : "Non autenticato",
      });
    const runFullSync = () => {
      lastFullSyncAt = Date.now();
      void runSync();
    };
    const tick = () => {
      const now = Date.now();
      const streamConnected = notificationStreamConnectedRef.current;
      const intervalMs = streamConnected
        ? POSTAZIONE_CONNECTED_SYNC_MS
        : POSTAZIONE_DISCONNECTED_SYNC_MS;
      if (now - lastFullSyncAt >= intervalMs) {
        runFullSync();
        return;
      }
      void pushHeartbeatOnly();
    };
    void runSync();
    lastFullSyncAt = Date.now();
    const p = setInterval(tick, POSTAZIONE_HEARTBEAT_MS);
    return () => clearInterval(p);
  }, [auth.loggedIn, pushStationHeartbeat, runSync, stationActive]);

  useEffect(() => {
    if (!auth.loggedIn || typeof window.EventSource !== "function")
      return undefined;

    let active = true;
    let source = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;

    const closeSource = () => {
      if (!source) return;
      source.close();
      source = null;
    };

    const buildStreamUrl = () => {
      const station = stationRef.current;
      const authLocal = authRef.current;
      const consumer = `postazione:${station.toLowerCase().replace(/[^a-z0-9]+/g, "_")}:${getOrCreateId(LS.notifyDevice).slice(0, 12).toLowerCase()}`;
      const params = new URLSearchParams({
        consumer,
        ackConsumer:
          notificationStreamHandlersRef.current.getWaiterAckConsumer(station),
        clientApp: "postazione",
        station,
        userId: String(authLocal.userId || ""),
        username: String(authLocal.username || ""),
        fullName: String(authLocal.fullName || ""),
        deviceUuid: String(authLocal.deviceUuid || ""),
      });
      return `${apiRef.current}/api/integration/notifications/stream?${params.toString()}`;
    };

    const scheduleReconnect = () => {
      if (!active || reconnectTimer !== null) return;
      const delay = Math.min(
        NOTIFICATION_STREAM_RECONNECT_MAX_MS,
        NOTIFICATION_STREAM_RECONNECT_BASE_MS *
          2 ** Math.min(reconnectAttempt, 5),
      );
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempt += 1;
        connect();
      }, delay);
    };

    const parseStreamPayload = (event) => {
      try {
        return JSON.parse(String(event?.data || "{}"));
      } catch {
        return null;
      }
    };

    const rememberRealtimePayload = (payload) => {
      const key = realtimePayloadKey(payload);
      recentRealtimePayloadKeysRef.current = [
        key,
        ...recentRealtimePayloadKeysRef.current.filter(
          (entry) => entry !== key,
        ),
      ].slice(0, 20);
    };

    const hasRecentRealtimePayload = (payload) =>
      recentRealtimePayloadKeysRef.current.includes(
        realtimePayloadKey(payload),
      );

    const shouldSyncForReason = (reason) => {
      const value = String(reason || "")
        .trim()
        .toLowerCase();
      return (
        value.startsWith("order_") ||
        value.startsWith("station_") ||
        value.startsWith("waiter_") ||
        value.startsWith("table_") ||
        value.includes("layout")
      );
    };

    const markStreamConnected = () => {
      const wasConnected = notificationStreamConnectedRef.current === true;
      notificationStreamConnectedRef.current = true;
      reconnectAttempt = 0;
      if (!wasConnected) {
        void notificationStreamHandlersRef.current.runSync();
      }
      return !wasConnected;
    };

    const handleReady = () => {
      const reconciled = markStreamConnected();
      if (!reconciled) {
        void notificationStreamHandlersRef.current.pullStationNotifications();
      }
    };

    const handlePayload = (event) => {
      const reconciled = markStreamConnected();
      const payload = parseStreamPayload(event);
      if (!payload) return;
      rememberRealtimePayload(payload);
      const applied =
        notificationStreamHandlersRef.current.applyRealtimePayload(payload);
      if (
        !reconciled &&
        !applied &&
        shouldPullStationNotificationsForReason(payload.reason)
      ) {
        void notificationStreamHandlersRef.current.pullStationNotifications();
      }
      if (!applied && shouldSyncForReason(payload.reason)) {
        void notificationStreamHandlersRef.current.runSync();
      }
    };

    const handleRefresh = (event) => {
      const reconciled = markStreamConnected();
      const payload = parseStreamPayload(event);
      if (payload && hasRecentRealtimePayload(payload)) {
        return;
      }
      if (payload && shouldSyncForReason(payload.reason)) {
        void notificationStreamHandlersRef.current.runSync();
        return;
      }
      if (
        !reconciled &&
        payload &&
        shouldPullStationNotificationsForReason(payload.reason)
      ) {
        void notificationStreamHandlersRef.current.pullStationNotifications();
      }
    };

    const connect = () => {
      if (!active) return;
      closeSource();
      try {
        source = new window.EventSource(buildStreamUrl(), {
          withCredentials: true,
        });
      } catch {
        scheduleReconnect();
        return;
      }
      source.addEventListener("ready", handleReady);
      source.addEventListener("payload", handlePayload);
      source.addEventListener("refresh", handleRefresh);
      source.onmessage = handleRefresh;
      source.onerror = () => {
        notificationStreamConnectedRef.current = false;
        closeSource();
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      active = false;
      notificationStreamConnectedRef.current = false;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      closeSource();
    };
  }, [
    auth.loggedIn,
    auth.userId,
    auth.username,
    auth.fullName,
    auth.deviceUuid,
    stationName,
  ]);

  useEffect(() => {
    if (!auth.loggedIn) return undefined;
    void pushStationHeartbeat({
      station: stationName,
      active: stationActive,
      operatorName: auth.loggedIn ? auth.userName : "Guest",
      operatorRole: auth.loggedIn ? auth.userRole : "Non autenticato",
    });
    return undefined;
  }, [
    auth.loggedIn,
    auth.userName,
    auth.userRole,
    pushStationHeartbeat,
    stationActive,
    stationName,
  ]);

  useEffect(() => {
    if (modal.auth) return;
    const candidate = orders.find((order) => {
      const request = order?.pendingAuthRequest;
      if (!request) return false;
      if (request.shownToOwner === true) return false;
      const fromStation = normStation(
        request.fromStation || order.ownerStation || order.station,
      );
      return fromStation === stationName;
    });
    if (!candidate || !candidate.pendingAuthRequest) return;
    const request = candidate.pendingAuthRequest;
    const payload = {
      orderId: String(candidate.id),
      fromStation: normStation(
        request.fromStation || candidate.ownerStation || candidate.station,
      ),
      toStation: normStation(request.toStation || stationName),
      toOperator: String(request.toOperator || "Operatore"),
      toOperatorRole: String(request.toOperatorRole || "Operatore"),
      mode: request.mode === "transfer" ? "transfer" : "takeover",
      requestedAtMs: msOrNull(request.requestedAtMs) || Date.now(),
    };
    setPendingAuth(payload);
    setModal((m) => ({ ...m, auth: true }));

    const updatedOrder = {
      ...candidate,
      pendingAuthRequest: {
        ...request,
        shownToOwner: true,
      },
    };
    setOrders((prev) =>
      prev.map((entry) => (entry.id === candidate.id ? updatedOrder : entry)),
    );
    void syncOrder(updatedOrder);
  }, [modal.auth, orders, stationName, syncOrder]);

  const visibleOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = orders
      .filter((o) => isVisibleForStation(o, stationName))
      .filter(
        (o) =>
          !(
            isCancelledOrder(o) &&
            dismissedCancelledOrderIds.has(String(o.id || "").trim())
          ),
      )
      .filter(
        (o) =>
          showHistory ||
          (!isHistoricalOrder(o) && !hideIfNoHistory(computeStatus(o))),
      )
      .filter((o) => {
        if (!q) return true;
        const a = tableLabel(o).toLowerCase();
        const b = String(o.waiter || "").toLowerCase();
        const c = String(o.id || "").toLowerCase();
        const d = roomLabel(o).toLowerCase();
        return (
          a.includes(q) ||
          b.includes(q) ||
          c.includes(q) ||
          d.includes(q) ||
          `#${c}`.includes(q)
        );
      });
    return showHistory
      ? sortOrdersOperationalFirst(filtered)
      : filtered.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  }, [
    computeStatus,
    dismissedCancelledOrderIds,
    orders,
    search,
    showHistory,
    stationName,
  ]);

  useEffect(() => {
    setSelectedId((prev) => {
      if (prev && visibleOrders.some((order) => order.id === prev)) return prev;
      return visibleOrders[0]?.id || null;
    });
  }, [visibleOrders]);

  const selected = useMemo(
    () => visibleOrders.find((order) => order.id === selectedId) || null,
    [selectedId, visibleOrders],
  );
  const selectedHistorical = !!selected && isHistoricalOrder(selected);
  const selectedGroups = useMemo(() => groupItems(selected), [selected]);
  const selectedCorrectionState = useMemo(
    () => correctionStateForOrder(selected),
    [selected],
  );

  const completeStationPause = useCallback(
    async (mode, targetStation = "") => {
      const sessionGeneration = notificationSessionGenerationRef.current;
      if (
        !isCurrentPostazioneSession(
          sessionGeneration,
          notificationSessionGenerationRef.current,
          authRef.current,
        )
      )
        return false;
      const transferMode = mode === "transfer" ? "transfer" : "suspend";
      const safeTarget =
        transferMode === "transfer" ? normStation(targetStation) : "";
      setModal((current) => ({ ...current, pauseTransfer: false }));
      setPauseTransferCandidates([]);
      setPauseTransferTarget("");
      const synced = await pushStationHeartbeat({
        active: false,
        pauseTransferMode: transferMode,
        transferOrders: transferMode === "transfer",
        pauseTransferTargetStation: safeTarget,
      });
      if (
        !isCurrentPostazioneSession(
          sessionGeneration,
          notificationSessionGenerationRef.current,
          authRef.current,
        )
      )
        return false;
      setStationActive(false);
      pushToast(
        transferMode === "transfer"
          ? `Postazione in pausa: coda trasferita a ${safeTarget}`
          : synced
            ? "Postazione in pausa: coda virtuale attiva"
            : "Postazione in pausa: sincronizzazione in attesa",
        synced ? 2200 : 4200,
      );
      return synced;
    },
    [pushStationHeartbeat, pushToast],
  );

  const handleStationActiveChange = useCallback(
    async (nextActive) => {
      if (nextActive) {
        setStationActive(true);
        pushToast("Postazione attiva");
        void pushStationHeartbeat({ active: true });
        return;
      }
      if (!isAuthenticatedPostazioneSession(authRef.current)) return;

      const currentStation = normStation(stationRef.current);
      const hasTransferableQueue = ordersRef.current.some((order) => {
        if (!isVisibleForStation(order, currentStation)) return false;
        if (computeStatus(order) !== "new") return false;
        if (
          order?.lockStatus === "locked" ||
          order?.preparationStartedAt ||
          order?.lockedAt
        )
          return false;
        return !(
          order?.manuallyTransferredAt ||
          order?.assignmentReason === "manual_transfer"
        );
      });
      const byStation = new Map();
      activeStationSessions
        .filter(isRealActiveStation)
        .filter((entry) => normStation(entry.station) !== currentStation)
        .filter(
          (entry) =>
            !stationSessionMatchesIdentity(entry, currentStationIdentity),
        )
        .forEach((entry) => {
          const station = normStation(entry.station);
          if (!byStation.has(station)) byStation.set(station, entry);
        });
      const candidates = [...byStation.values()];
      if (!hasTransferableQueue || candidates.length === 0) {
        await completeStationPause("suspend");
        return;
      }
      setPauseTransferCandidates(candidates);
      setPauseTransferTarget(normStation(candidates[0].station));
      setModal((current) => ({ ...current, pauseTransfer: true }));
    },
    [
      activeStationSessions,
      completeStationPause,
      computeStatus,
      currentStationIdentity,
      pushStationHeartbeat,
      pushToast,
    ],
  );

  useEffect(() => {
    if (!stationActive) return;
    const prep = orders.find((order) => {
      if (!isVisibleForStation(order, stationName)) return false;
      if (wf(order.workflowStatus) !== "prep") return false;
      const current = computeStatus(order);
      return current !== "ready" && !isTerminalStatus(current);
    });
    if (prep) return;

    const candidates = orders
      .filter((order) => isVisibleForStation(order, stationName))
      .filter((order) => {
        const current = computeStatus(order);
        if (current === "ready" || isTerminalStatus(current)) return false;
        return wf(order.workflowStatus) === "waiting";
      });
    if (!candidates.length) return;

    const pick = [...candidates].sort(
      (left, right) => (right.receivedAtMs || 0) - (left.receivedAtMs || 0),
    )[0];
    let updated = null;
    setOrders((prev) => {
      const index = prev.findIndex((order) => order.id === pick.id);
      if (index < 0) return prev;
      const next = [...prev];
      const row = next[index];
      updated = assignOwner(
        { ...row, workflowStatus: "prep" },
        stationRef.current,
      );
      next[index] = updated;
      return next;
    });
    if (updated) {
      void syncOrder(updated);
    }
  }, [
    assignOwner,
    computeStatus,
    orders,
    stationActive,
    stationName,
    syncOrder,
  ]);

  const queuePauseNotification = useCallback((station, message) => {
    const key = normStation(station);
    const safeMessage = String(message || "").trim();
    if (!safeMessage) return;
    const bag = pauseNotificationsRef.current;
    if (!bag[key]) bag[key] = [];
    bag[key].push({
      message: safeMessage,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      shown: false,
    });
  }, []);

  const popPauseNotification = useCallback((station) => {
    const key = normStation(station || stationRef.current);
    const bag = pauseNotificationsRef.current;
    const items = Array.isArray(bag[key]) ? bag[key] : [];
    const now = Date.now();
    const candidate = items.find(
      (item) => item && item.shown !== true && Number(item.expiresAtMs) > now,
    );
    if (!candidate) return null;
    candidate.shown = true;
    return String(candidate.message || "");
  }, []);

  const openNotifyModal = useCallback((message) => {
    const safe = String(message || "").trim();
    if (!safe) return;
    setPendingNotify(safe);
    setModal((prev) => ({ ...prev, notify: true }));
  }, []);

  const closeNotifyModal = useCallback(() => {
    setModal((prev) => ({ ...prev, notify: false }));
  }, []);

  const ackNotify = useCallback(() => {
    setPendingNotify("");
    setModal((prev) => ({ ...prev, notify: false }));
  }, []);

  useEffect(() => {
    const prev = prevStationActiveRef.current;
    prevStationActiveRef.current = stationActive;
    if (prev !== stationActive) {
      const station = normStation(stationName || stationRef.current);
      const description = stationActive
        ? `La postazione ${station} e tornata disponibile.`
        : `La postazione ${station} e in pausa.`;
      void publishNotif("general", station, description, {
        station,
        active: stationActive,
        targetClientApp: "pos-frontend",
      });
    }
    if (!prev && stationActive) {
      const message = popPauseNotification(stationName);
      if (message) openNotifyModal(message);
    }
  }, [
    openNotifyModal,
    popPauseNotification,
    publishNotif,
    stationActive,
    stationName,
  ]);

  const protectExistingOrderLinesFromDisable = useCallback(
    (itemName, stationOrNull = null) => {
      const key = keyName(itemName);
      if (!key) return;
      setOrders((prev) =>
        prev.map((order) => {
          const stationMatch =
            !stationOrNull ||
            normStation(order.station) === normStation(stationOrNull);
          if (!stationMatch || !Array.isArray(order.items)) return order;
          let changed = false;
          const nextItems = order.items.map((item) => {
            if (
              !item ||
              keyName(item.name) !== key ||
              item.ignoreDisabled === true
            )
              return item;
            changed = true;
            return { ...item, ignoreDisabled: true };
          });
          return changed ? { ...order, items: nextItems } : order;
        }),
      );
    },
    [],
  );

  const catalogItemsForStation = useMemo(() => {
    const names = new Set();
    menuWithTemp.forEach((item) => {
      if (!item?.name) return;
      const stations = Array.isArray(item.stations)
        ? item.stations.map(normStation)
        : [...STATIONS];
      if (stations.includes(stationName)) names.add(item.name);
    });
    orders.forEach((order) => {
      if (normStation(order.station) !== stationName) return;
      (order.items || []).forEach((item) => {
        const name = String(item?.name || "").trim();
        if (!name) return;
        const stations = menuStationsFor(name);
        if (stations.includes(stationName)) names.add(name);
      });
    });
    return [...names].sort((left, right) =>
      left.localeCompare(right, "it", { sensitivity: "base" }),
    );
  }, [menuStationsFor, menuWithTemp, orders, stationName]);

  const categoryForCatalogItem = useCallback(
    (name, meta) => {
      if (meta?.isTemp) return "Temporanei";
      const directCategory = String(meta?.category || "").trim();
      if (directCategory) return directCategory;
      const linked = menuCatalogByName.get(keyName(name));
      const linkedCategory = String(linked?.category || "").trim();
      if (linkedCategory) return linkedCategory;
      const stations = menuStationsFor(name);
      const normalized = keyName(name);
      if (
        normalized.includes("caffe") ||
        normalized.includes("cappu") ||
        normalized.includes("cornetto")
      ) {
        return "Caffetteria";
      }
      if (normalized.includes("birra")) return "Birre";
      if (normalized.includes("analcol")) return "Analcolici";
      return "Cocktail / Drink";
    },
    [menuCatalogByName, menuStationsFor],
  );

  const catalogGroups = useMemo(() => {
    const q = keyName(catalogQuery);
    const grouped = {};
    catalogItemsForStation
      .filter((name) => !q || keyName(name).includes(q))
      .forEach((name) => {
        const meta = findMenuItemByName(name);
        const category = categoryForCatalogItem(name, meta);
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push(name);
      });
    const order = [
      "Temporanei",
      ...menuCategoryOrder,
      "Cocktail / Drink",
      "Analcolici",
      "Birre",
      "Caffetteria",
    ];
    const categories = Object.keys(grouped).sort((left, right) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      const a = leftIndex === -1 ? 999 : leftIndex;
      const b = rightIndex === -1 ? 999 : rightIndex;
      if (a !== b) return a - b;
      return left.localeCompare(right, "it", { sensitivity: "base" });
    });
    return { grouped, categories };
  }, [
    catalogItemsForStation,
    catalogQuery,
    categoryForCatalogItem,
    findMenuItemByName,
    menuCategoryOrder,
  ]);

  const toggleCatalogCategory = useCallback((category) => {
    setCatalogOpenCats((prev) => ({
      ...prev,
      [category]: prev[category] !== true,
    }));
  }, []);

  const closeScopeModal = useCallback(() => {
    setPendingDisableItem("");
    setModal((prev) => ({ ...prev, scope: false }));
  }, []);

  const forwardPartialOrdersForLocalOutOfStock = useCallback(
    async (itemName) => {
      const safeName = String(itemName || "").trim();
      if (!safeName) return false;
      const key = keyName(safeName);
      const sourceStation = normStation(stationRef.current);
      const targets = menuStationsFor(safeName)
        .filter((station) => station !== sourceStation)
        .filter((station) => isStationOnline(station))
        .filter((station) => !isItemDisabledForStation(safeName, station));
      if (!targets.length) {
        queueAction({
          type: "notify_waiters_item_out",
          itemName: safeName,
          station: sourceStation,
          scope: "station",
        });
        return false;
      }

      const current = [...ordersRef.current];
      const next = [];
      const changed = [];
      let movedTotal = 0;
      let targetIndex = 0;
      const now = Date.now();

      for (const order of current) {
        if (
          !order ||
          normStation(order.station) !== sourceStation ||
          isTerminalStatus(computeStatus(order))
        ) {
          next.push(order);
          continue;
        }
        const items = Array.isArray(order.items) ? order.items : [];
        const movedItems = items.filter(
          (item) => keyName(item.name) === key && item.done !== true,
        );
        if (!movedItems.length) {
          next.push(order);
          continue;
        }

        const target = targets[targetIndex % targets.length];
        targetIndex += 1;

        const parent = {
          ...order,
          items: items.filter(
            (item) => !(keyName(item.name) === key && item.done !== true),
          ),
        };
        next.push(parent);
        changed.push(parent);

        const partial = {
          ...order,
          id: `${order.id}P${Math.floor(100 + Math.random() * 900)}`,
          station: target,
          ownerStation: null,
          ownerOperator: null,
          ownerRole: null,
          ownerAtMs: null,
          completedAtMs: null,
          workflowStatus: "waiting",
          receivedAtMs: now,
          parentOrderId: String(order.id),
          isPartial: true,
          transferredFromStation: sourceStation,
          transferredToStation: target,
          transferredAtMs: now,
          items: movedItems.map((item, index) => ({
            ...item,
            id: String(item.id || item.lineId || `i${index + 1}`),
            lineId: String(item.lineId || item.id || `i${index + 1}`),
            name: String(item.name || "Articolo"),
            variant: String(item.variant || ""),
            note: String(item.note || ""),
            qty: itemQty(item),
            done: false,
          })),
        };
        next.push(partial);
        changed.push(partial);
        movedTotal += movedItems.reduce((sum, item) => sum + itemQty(item), 0);
        queueAction({
          type: "order_partial_transfer",
          fromStation: sourceStation,
          toStation: target,
          parentOrderId: order.id,
          orderId: partial.id,
          itemName: safeName,
          itemsCount: movedItems.length,
        });
      }

      if (movedTotal === 0) return false;
      next.sort(
        (left, right) => (left.receivedAtMs || 0) - (right.receivedAtMs || 0),
      );
      setOrders(next);
      pushToast(`Parziale inoltrato: ${safeName} -> ${targets.join(", ")}`);

      for (const order of changed) {
        // non blocco la UI in caso di errore sync su singolo ordine
        // eslint-disable-next-line no-await-in-loop
        await syncOrder(order);
      }
      return true;
    },
    [
      computeStatus,
      isItemDisabledForStation,
      isStationOnline,
      menuStationsFor,
      pushToast,
      queueAction,
      syncOrder,
    ],
  );

  const disableItemScope = useCallback(
    (scope) => {
      const safeName = String(pendingDisableItem || "").trim();
      if (!safeName) {
        closeScopeModal();
        return;
      }
      const key = keyName(safeName);
      if (!key) {
        closeScopeModal();
        return;
      }
      if (scope === "global") {
        setDisabledGlobal((prev) => [...new Set([...prev, key])]);
        queueAction({
          type: "item_disable",
          itemName: safeName,
          scope: "global",
        });
        protectExistingOrderLinesFromDisable(safeName, null);
        pushToast(`Terminato per tutte: ${safeName}`);
      } else {
        const stationKey = normStation(stationRef.current);
        setDisabledLocal((prev) => {
          const current = Array.isArray(prev[stationKey])
            ? prev[stationKey]
            : [];
          return {
            ...prev,
            [stationKey]: [...new Set([...current, key])],
          };
        });
        queueAction({
          type: "item_disable",
          itemName: safeName,
          scope: "station",
          station: stationKey,
        });
        protectExistingOrderLinesFromDisable(safeName, stationRef.current);
        pushToast(`Terminato qui: ${safeName}`);
        void forwardPartialOrdersForLocalOutOfStock(safeName);
      }
      closeScopeModal();
    },
    [
      closeScopeModal,
      forwardPartialOrdersForLocalOutOfStock,
      pendingDisableItem,
      protectExistingOrderLinesFromDisable,
      pushToast,
      queueAction,
    ],
  );

  const toggleCatalogItem = useCallback(
    (itemName) => {
      const safeName = String(itemName || "").trim();
      if (!safeName) return;
      const key = keyName(safeName);
      if (!key) return;
      const disabledHere = isItemDisabledForStation(
        safeName,
        stationRef.current,
      );
      const disabledEverywhere = disabledGlobalSet.has(key);
      const stations = menuStationsFor(safeName);
      const multi = stations.length > 1;

      if (disabledHere || disabledEverywhere) {
        const stationKey = normStation(stationRef.current);
        setDisabledGlobal((prev) => prev.filter((entry) => entry !== key));
        setDisabledLocal((prev) => {
          const current = Array.isArray(prev[stationKey])
            ? prev[stationKey]
            : [];
          const nextStation = current.filter((entry) => entry !== key);
          return {
            ...prev,
            [stationKey]: nextStation,
          };
        });
        queueAction({
          type: "item_enable",
          itemName: safeName,
          scope: "station",
          station: stationKey,
        });
        pushToast(`Articolo attivo: ${safeName}`);
        return;
      }

      if (multi) {
        setPendingDisableItem(safeName);
        setModal((prev) => ({ ...prev, scope: true }));
        return;
      }

      setDisabledLocal((prev) => {
        const stationKey = normStation(stationRef.current);
        const current = Array.isArray(prev[stationKey]) ? prev[stationKey] : [];
        return {
          ...prev,
          [stationKey]: [...new Set([...current, key])],
        };
      });
      queueAction({
        type: "item_disable",
        itemName: safeName,
        scope: "station",
        station: normStation(stationRef.current),
      });
      protectExistingOrderLinesFromDisable(safeName, stationRef.current);
      pushToast(`Terminato: ${safeName}`);
      void forwardPartialOrdersForLocalOutOfStock(safeName);
    },
    [
      disabledGlobalSet,
      forwardPartialOrdersForLocalOutOfStock,
      isItemDisabledForStation,
      menuStationsFor,
      protectExistingOrderLinesFromDisable,
      pushToast,
      queueAction,
    ],
  );

  const openTempItemModal = useCallback(
    (name = "") => {
      const safeName = String(name || "").trim();
      setEditingTempName(safeName);
      const hit = safeName
        ? tempItems.find((item) => keyName(item.name) === keyName(safeName))
        : null;
      setTempDraft({
        name: hit ? String(hit.name || "") : "",
        price:
          hit && Number.isFinite(Number(hit.price))
            ? Number(hit.price).toFixed(2)
            : "",
        qty:
          hit && hit.qtyRemaining != null && hit.qtyRemaining !== ""
            ? String(hit.qtyRemaining)
            : "",
        stations:
          hit && Array.isArray(hit.stations) && hit.stations.length > 0
            ? hit.stations.map(normStation)
            : [...configuredStations],
      });
      setModal((prev) => ({ ...prev, tempItem: true }));
    },
    [configuredStations, tempItems],
  );

  const closeTempItemModal = useCallback(() => {
    setEditingTempName("");
    setModal((prev) => ({ ...prev, tempItem: false }));
  }, []);

  const saveTempItem = useCallback(() => {
    const name = normalizeName(tempDraft.name);
    if (!name) {
      pushToast("Inserisci un nome articolo");
      return;
    }
    const price = parsePriceInput(tempDraft.price);
    if (price == null) {
      pushToast("Inserisci un prezzo valido");
      return;
    }
    const rawQty = String(tempDraft.qty || "").trim();
    const qty = rawQty ? parseQtyInput(rawQty) : null;
    if (rawQty && qty == null) {
      pushToast("Quantita non valida");
      return;
    }
    const stations = Array.isArray(tempDraft.stations)
      ? [...new Set(tempDraft.stations.map(normStation))]
      : [];
    if (!stations.length) {
      pushToast("Seleziona almeno una postazione");
      return;
    }

    const baseHit = menu.find((item) => keyName(item.name) === keyName(name));
    if (
      baseHit &&
      (!editingTempName || keyName(editingTempName) !== keyName(name))
    ) {
      pushToast("Esiste gia un articolo nel listino con questo nome");
      return;
    }

    if (editingTempName) {
      const current = tempItems.find(
        (item) => keyName(item.name) === keyName(editingTempName),
      );
      if (!current) {
        pushToast("Articolo temporaneo non trovato");
        return;
      }
      const inActiveOrder = orders.some(
        (order) =>
          !isTerminalStatus(computeStatus(order)) &&
          (order.items || []).some(
            (item) => keyName(item.name) === keyName(current.name),
          ),
      );
      if (inActiveOrder && keyName(current.name) !== keyName(name)) {
        pushToast(
          "Non puoi rinominare: articolo presente in una comanda non terminata",
        );
        return;
      }
      setTempItems((prev) =>
        prev.map((item) =>
          item.id === current.id
            ? {
                ...item,
                name,
                price,
                stations,
                qtyRemaining: qty,
              }
            : item,
        ),
      );
      queueAction({
        type: "temp_item_update",
        item: {
          id: current.id,
          name,
          price,
          stations,
          qtyRemaining: qty,
        },
      });
      pushToast("Articolo temporaneo aggiornato");
      closeTempItemModal();
      return;
    }

    const tempItem = {
      id: uuid(),
      name,
      price,
      qtyRemaining: qty,
      stations,
      createdAtMs: Date.now(),
    };
    setTempItems((prev) => [...prev, tempItem]);
    queueAction({ type: "temp_item_add", item: tempItem });
    pushToast("Articolo temporaneo aggiunto");
    closeTempItemModal();
  }, [
    closeTempItemModal,
    computeStatus,
    editingTempName,
    menu,
    orders,
    pushToast,
    queueAction,
    tempDraft,
    tempItems,
  ]);

  const deleteTempItem = useCallback(
    (nameOverride = "") => {
      const safeName = String(nameOverride || editingTempName || "").trim();
      if (!safeName) return;
      const hit = tempItems.find(
        (item) => keyName(item.name) === keyName(safeName),
      );
      if (!hit) {
        pushToast("Articolo temporaneo non trovato");
        return;
      }
      const inActiveOrder = orders.some(
        (order) =>
          !isTerminalStatus(computeStatus(order)) &&
          (order.items || []).some(
            (item) => keyName(item.name) === keyName(hit.name),
          ),
      );
      if (inActiveOrder) {
        pushToast(
          "Non puoi rimuovere: articolo presente in una comanda non terminata",
        );
        return;
      }
      if (!window.confirm(`Rimuovere l'articolo temporaneo "${hit.name}"?`))
        return;
      setTempItems((prev) => prev.filter((item) => item.id !== hit.id));
      queueAction({ type: "temp_item_delete", itemId: hit.id, name: hit.name });
      pushToast("Articolo temporaneo rimosso");
      closeTempItemModal();
    },
    [
      closeTempItemModal,
      computeStatus,
      editingTempName,
      orders,
      pushToast,
      queueAction,
      tempItems,
    ],
  );

  const applyTempQtyDeltas = useCallback((deltas) => {
    if (!deltas || typeof deltas.forEach !== "function") return;
    setTempItems((prev) =>
      prev.map((item) => {
        if (item.qtyRemaining == null || item.qtyRemaining === "") return item;
        const delta = Number(deltas.get(keyName(item.name)) || 0);
        if (!Number.isFinite(delta) || delta === 0) return item;
        const current = Number(item.qtyRemaining) || 0;
        return {
          ...item,
          qtyRemaining: Math.max(0, current + delta),
        };
      }),
    );
  }, []);

  const requestOrForceTransfer = useCallback(
    async (order, targetStation, mode = "transfer", options = {}) => {
      const transferSessionGeneration =
        notificationSessionGenerationRef.current;
      if (!isAuthenticatedPostazioneSession(authRef.current)) return false;
      if (!order?.id) return false;
      const currentStatus = computeStatus(order);
      const allowWaitingOverride = options?.allowWaitingOverride === true;
      if (currentStatus === "ready" || isTerminalStatus(currentStatus)) {
        pushToast("Trasferimento non consentito su comanda chiusa");
        return false;
      }
      if (
        currentStatus === "new" &&
        !allowTransferWaiting &&
        !allowWaitingOverride
      ) {
        pushToast("Trasferimento non abilitato per comande in attesa");
        return false;
      }
      const target = normStation(targetStation || stationRef.current);
      const authLocal = authRef.current;
      const requesterStation = stationRef.current;
      const requesterOperator = authLocal.loggedIn
        ? authLocal.userName
        : "Guest";
      const requesterRole = authLocal.loggedIn
        ? authLocal.userRole
        : "Non autenticato";
      const ownerStation = normStation(
        order.ownerStation || order.station || requesterStation,
      );
      const ownerOnline = isStationOnline(ownerStation);
      const requestMode = mode === "takeover" ? "takeover" : "transfer";

      if (ownerStation !== requesterStation && ownerOnline) {
        const req = await apiFetchJson(
          "/api/integration/orders/transfer/request",
          {
            method: "POST",
            body: JSON.stringify({
              orderId: order.id,
              requesterStation,
              requesterOperator,
              requesterRole,
              mode: requestMode,
              targetStation:
                requestMode === "transfer" ? target : requesterStation,
            }),
          },
        );
        if (
          !isCurrentPostazioneSession(
            transferSessionGeneration,
            notificationSessionGenerationRef.current,
            authRef.current,
          )
        )
          return false;
        if (req?.order) {
          pushToast(`Richiesta inviata a ${ownerStation} (#${order.id})`);
          await syncOrders();
          return true;
        }
        pushToast("Richiesta trasferimento non riuscita");
        return false;
      }

      const forced = await apiFetchJson(
        "/api/integration/orders/transfer/force",
        {
          method: "POST",
          body: JSON.stringify({
            orderId: order.id,
            fromStation: requesterStation,
            toStation: target,
            operatorName: requesterOperator,
            operatorRole: requesterRole,
          }),
        },
      );
      if (
        !isCurrentPostazioneSession(
          transferSessionGeneration,
          notificationSessionGenerationRef.current,
          authRef.current,
        )
      )
        return false;
      if (!forced?.order) {
        pushToast("Trasferimento non riuscito");
        return false;
      }
      pushToast(`Comanda #${order.id} trasferita a ${target}`);
      await syncOrders();
      return true;
    },
    [
      allowTransferWaiting,
      apiFetchJson,
      computeStatus,
      isStationOnline,
      pushToast,
      syncOrders,
    ],
  );

  const requestRecallForSelected = useCallback(
    async (orderInput) => {
      const order = orderInput?.id
        ? orderInput
        : ordersRef.current.find((entry) => entry.id === selectedId) || null;
      if (!order) {
        pushToast("Seleziona una comanda");
        return false;
      }
      if (!stationActive) {
        pushToast("Postazione in pausa");
        return false;
      }
      if (!isTransferredOutForStation(order, stationRef.current)) {
        pushToast("Comanda non trasferita da questa postazione");
        return false;
      }
      const currentStatus = computeStatus(order);
      if (currentStatus !== "new") {
        pushToast("Rientro consentito solo su comande in attesa");
        return false;
      }
      return requestOrForceTransfer(order, stationRef.current, "transfer", {
        allowWaitingOverride: true,
      });
    },
    [
      computeStatus,
      isTransferredOutForStation,
      pushToast,
      requestOrForceTransfer,
      selectedId,
      stationActive,
    ],
  );

  const resolvePendingTransfer = useCallback(
    async (approve) => {
      if (!pendingAuth?.orderId) {
        setModal((m) => ({ ...m, auth: false }));
        setPendingAuth(null);
        return;
      }
      const transferSessionGeneration =
        notificationSessionGenerationRef.current;
      if (!isAuthenticatedPostazioneSession(authRef.current)) return;
      const pendingOrderId = pendingAuth.orderId;
      const authLocal = authRef.current;
      const res = await apiFetchJson(
        "/api/integration/orders/transfer/resolve",
        {
          method: "POST",
          body: JSON.stringify({
            orderId: pendingOrderId,
            approverStation: stationRef.current,
            approverOperator: authLocal.loggedIn ? authLocal.userName : "Guest",
            approve: approve === true,
          }),
        },
      );
      if (
        !isCurrentPostazioneSession(
          transferSessionGeneration,
          notificationSessionGenerationRef.current,
          authRef.current,
        )
      )
        return;
      setModal((m) => ({ ...m, auth: false }));
      setPendingAuth(null);
      if (!res?.ok) {
        pushToast("Risoluzione trasferimento non riuscita");
        return;
      }
      pushToast(
        approve
          ? `Trasferimento #${pendingOrderId} approvato`
          : `Trasferimento #${pendingOrderId} negato`,
      );
      await syncOrders();
    },
    [apiFetchJson, pendingAuth, pushToast, syncOrders],
  );

  const selectOrder = useCallback(
    (orderId) => {
      const order = ordersRef.current.find((entry) => entry.id === orderId);
      if (!order) return;
      if (!stationActive) {
        pushToast("Postazione in pausa");
        return;
      }
      setSelectedId(orderId);

      const currentStatus = computeStatus(order);
      if (currentStatus === "ready" || isTerminalStatus(currentStatus)) return;
      if (isTransferredOutForStation(order, stationRef.current)) return;

      const owner = String(order.ownerStation || "").trim();
      if (owner && owner !== stationRef.current) {
        if (currentStatus === "new" && !allowTransferWaiting) {
          pushToast("Trasferimento non consentito per comande in attesa");
          return;
        }
        void requestOrForceTransfer(order, stationRef.current, "takeover");
        return;
      }

      let blockedMessage = "";
      const changedOrders = [];
      setOrders((prev) => {
        const index = prev.findIndex((entry) => entry.id === orderId);
        if (index < 0) return prev;
        const target = prev[index];
        const targetStatus = computeStatus(target);
        if (targetStatus === "ready" || isTerminalStatus(targetStatus))
          return prev;

        const currentPrep =
          prev.find((entry) => {
            if (!entry || entry.id === target.id) return false;
            if (!isVisibleForStation(entry, stationRef.current)) return false;
            if (wf(entry.workflowStatus) !== "prep") return false;
            const prepStatus = computeStatus(entry);
            return prepStatus !== "ready" && !isTerminalStatus(prepStatus);
          }) || null;

        const clone = [...prev];
        if (!currentPrep) {
          const nextTarget = assignOwner(
            { ...target, workflowStatus: "prep" },
            stationRef.current,
          );
          clone[index] = nextTarget;
          changedOrders.push(nextTarget);
          return clone;
        }

        if (currentPrep.id === target.id) return prev;

        const prepDone = (currentPrep.items || []).filter(
          (item) => item.done === true,
        ).length;
        if (prepDone === 0) {
          const prepIndex = clone.findIndex(
            (entry) => entry.id === currentPrep.id,
          );
          if (prepIndex >= 0) {
            const released = releaseOwner({
              ...clone[prepIndex],
              workflowStatus: "waiting",
            });
            clone[prepIndex] = released;
            changedOrders.push(released);
          }
          const nextTarget = assignOwner(
            { ...target, workflowStatus: "prep" },
            stationRef.current,
          );
          clone[index] = nextTarget;
          changedOrders.push(nextTarget);
          return clone;
        }

        blockedMessage = `Comanda #${currentPrep.id} gia in preparazione (con spunte)`;
        return prev;
      });

      if (blockedMessage) {
        pushToast(blockedMessage);
        return;
      }
      changedOrders.forEach((entry) => {
        void syncOrder(entry);
      });
    },
    [
      allowTransferWaiting,
      assignOwner,
      computeStatus,
      pushToast,
      releaseOwner,
      requestOrForceTransfer,
      isTransferredOutForStation,
      stationActive,
      syncOrder,
    ],
  );

  const callWaiter = useCallback(
    async (waiterRef) => {
      const waiterSessionGeneration = notificationSessionGenerationRef.current;
      const authAtStart = authRef.current;
      if (!isAuthenticatedPostazioneSession(authAtStart)) return;
      const order = ordersRef.current.find((o) => o.id === selectedId) || null;
      if (
        String(order?.source || "")
          .trim()
          .toLowerCase() === "cassa-frontend"
      ) {
        const station = stationRef.current;
        const response = await publishNotif(
          "general",
          "Richiesta supporto postazione",
          [
            `La postazione ${station} richiede supporto`,
            order?.id ? `per la comanda #${order.id}` : "",
            tableLabel(order) !== "-" ? `del tavolo ${tableLabel(order)}` : "",
          ]
            .filter(Boolean)
            .join(" "),
          {
            eventType: "station_support_request",
            sourceApp: "postazione",
            targetClientApp: "cassa-frontend",
            station,
            sourceStation: station,
            pickupStation: station,
            requestedBy: authAtStart.userName || "Operatore",
            orderId: String(order?.id || ""),
            tableId: String(order?.tableId || ""),
            tableNumber: tableLabel(order) === "-" ? "" : tableLabel(order),
            roomId: String(order?.roomId || ""),
            roomName: roomLabel(order),
            waiter: String(order?.waiter || ""),
            orderSource: "cassa-frontend",
          },
        );
        if (
          !isCurrentPostazioneSession(
            waiterSessionGeneration,
            notificationSessionGenerationRef.current,
            authRef.current,
          )
        )
          return;
        pushToast(
          response
            ? "Richiesta supporto inviata alla cassa"
            : "Richiesta supporto non riuscita",
        );
        return;
      }
      const waiter =
        typeof waiterRef === "object"
          ? {
              name: String(waiterRef?.name || waiterRef?.fullName || "").trim(),
              username: String(waiterRef?.username || "").trim(),
              userId: String(waiterRef?.userId || "").trim(),
              clientApp: String(waiterRef?.clientApp || "mobile-frontend")
                .trim()
                .toLowerCase(),
              online:
                waiterRef?.online !== false && waiterRef?.activeNow !== false,
              activeNow:
                waiterRef?.activeNow !== false && waiterRef?.online !== false,
              onPause: waiterRef?.onPause === true,
              pauseStatus:
                waiterRef?.pauseStatus &&
                typeof waiterRef.pauseStatus === "object"
                  ? waiterRef.pauseStatus
                  : null,
            }
          : (() => {
              const hint = personKey(waiterRef);
              const byName = waiters.find((w) => {
                const full = personKey(w?.name);
                const username = personKey(w?.username);
                const firstName = personKey(
                  String(w?.name || "")
                    .split(/\s+/)
                    .filter(Boolean)[0] || "",
                );
                return (
                  hint &&
                  (full === hint || username === hint || firstName === hint)
                );
              });
              return byName
                ? {
                    name: byName.name,
                    username: byName.username,
                    userId: byName.userId,
                    clientApp: byName.clientApp || "mobile-frontend",
                    online:
                      byName.online !== false && byName.activeNow !== false,
                    activeNow:
                      byName.activeNow !== false && byName.online !== false,
                    onPause: byName.onPause === true,
                    pauseStatus: byName.pauseStatus || null,
                  }
                : {
                    name: String(waiterRef || "").trim(),
                    username: "",
                    userId: "",
                    clientApp: "mobile-frontend",
                    online: true,
                    activeNow: true,
                    onPause: false,
                    pauseStatus: null,
                  };
            })();

      const key = waiterKey(waiter);
      const existing = key ? waiterCallStatesRef.current?.[key] : null;
      if (existing && existing.acknowledged !== true) {
        pushToast(
          waiter.name
            ? `Chiamata gia inviata a ${waiter.name}`
            : "Chiamata gia inviata",
        );
        return;
      }
      if (waiter.online === false || waiter.activeNow === false) {
        pushToast("Cameriere offline: chiamata non disponibile");
        return;
      }

      const operator = authAtStart.userName || "Guest";
      const station = stationRef.current;
      const paused = isWaiterPaused(waiter);
      const orderRoom = order ? roomLabel(order) : "";
      const desc = `Chiamata da ${operator} alla postazione ${station}`;
      setWaiterCallState(waiter, { sending: true });
      pushToast(
        paused
          ? `Cameriere in pausa: chiamo ${waiter.name || "cameriere"}`
          : waiter.name
            ? `Chiamo ${waiter.name}`
            : "Chiamo cameriere",
      );
      const response = await publishNotif("waiter", station, desc, {
        station,
        requestedBy: operator,
        requesterDeviceUuid: String(authAtStart.deviceUuid || ""),
        requesterFeedbackConsumer: getWaiterAckConsumer(station),
        waiter: waiter.name,
        targetUsername: waiter.username,
        targetUserId: waiter.userId,
        targetFullName: waiter.name,
        targetClientApp: waiter.clientApp || "mobile-frontend",
        urgent: paused,
        forcePausedDelivery: paused,
        ...(order
          ? {
              orderId: order.id,
              table: order.table,
              tableNumber: order.tableNumber || order.table,
              tableId: order.tableId || "",
              roomId: order.roomId || "",
              roomName: orderRoom,
            }
          : {}),
      });
      if (
        !isCurrentPostazioneSession(
          waiterSessionGeneration,
          notificationSessionGenerationRef.current,
          authRef.current,
        )
      )
        return;
      const notification = response?.notification || response;
      if (!notification) {
        clearWaiterCallStateByKey(key);
        pushToast("Chiamata cameriere non riuscita");
        return;
      }
      setWaiterCallState(waiter, {
        sending: false,
        notificationId: String(notification?.id || ""),
      });
    },
    [
      clearWaiterCallStateByKey,
      getWaiterAckConsumer,
      publishNotif,
      pushToast,
      selectedId,
      setWaiterCallState,
      waiters,
    ],
  );

  const markReady = useCallback(async () => {
    const order = ordersRef.current.find((o) => o.id === selectedId);
    if (!order) return;
    if (!stationActive) {
      pushToast("Postazione in pausa");
      return;
    }
    const owner = String(order.ownerStation || "").trim();
    if (owner && owner !== stationRef.current && isStationOnline(owner)) {
      pushToast(
        `Comanda in carico a ${owner}: richiesta presa in carico inviata`,
      );
      await requestOrForceTransfer(order, stationRef.current, "takeover");
      return;
    }
    const s = computeStatus(order);
    if (s === "ready") {
      pushToast("Comanda gia da ritirare");
      return;
    }
    if (isTerminalStatus(s)) {
      pushToast(
        s === "cancelled" ? "Comanda annullata" : "Comanda gia consegnata",
      );
      return;
    }

    const qtyDeltas = new Map();
    const readyAtMs = msOrNull(order.readyAtMs) || Date.now();
    const updated = {
      ...order,
      items: order.items.map((item) => {
        const nextItem = { ...item, done: true };
        const temp = getTempItemByName(item.name);
        if (
          temp &&
          temp.qtyRemaining != null &&
          nextItem.stockDebited !== true
        ) {
          const key = keyName(item.name);
          qtyDeltas.set(key, (qtyDeltas.get(key) || 0) - itemQty(item));
          nextItem.stockDebited = true;
        }
        return nextItem;
      }),
      workflowStatus: "ready",
      readyAtMs,
      completedAtMs: null,
    };

    const nextOrders = ordersRef.current.map((entry) =>
      entry.id === updated.id ? updated : entry,
    );
    ordersRef.current = nextOrders;
    setOrders(nextOrders);
    applyTempQtyDeltas(qtyDeltas);
    pushToast(`Comanda #${updated.id} da ritirare`);
    const synced = await syncOrderReliably(updated);
    if (!synced) {
      pushToast(
        `Comanda #${updated.id} pronta: sincronizzazione in attesa`,
        4200,
      );
      return;
    }
    await syncOrders();
  }, [
    applyTempQtyDeltas,
    computeStatus,
    getTempItemByName,
    isStationOnline,
    pushToast,
    requestOrForceTransfer,
    selectedId,
    stationActive,
    syncOrderReliably,
    syncOrders,
  ]);

  const toggleGroup = useCallback(
    (groupKey, checked) => {
      if (!selectedId || !stationActive) return;
      let updated = null;
      let transitionedToReady = false;
      const qtyDeltas = new Map();
      setOrders((prev) => {
        const idx = prev.findIndex((o) => o.id === selectedId);
        if (idx < 0) return prev;
        const cur = prev[idx];
        const previousStatus = computeStatus(cur);
        if (previousStatus === "ready" || isTerminalStatus(previousStatus))
          return prev;
        const stationKey = normStation(cur.station || stationRef.current);
        const next = {
          ...cur,
          items: cur.items.map((it) => {
            const removed = isCorrectionRemovedItem(it);
            const lineId = itemLineId(it);
            const key = `${removed ? "removed" : "active"}|${lineId || String(it.name || "").toLowerCase()}|${String(it.variant || "").toLowerCase()}|${String(it.note || "").toLowerCase()}`;
            if (key !== groupKey) return it;
            if (removed || isOrderItemDisabled(it, stationKey)) return it;
            const wasDone = it.done === true;
            const nextDone = checked === true;
            const nextItem = { ...it, done: nextDone };
            const temp = getTempItemByName(it.name);
            if (temp && temp.qtyRemaining != null) {
              const qtyKey = keyName(it.name);
              if (nextDone && !wasDone && nextItem.stockDebited !== true) {
                qtyDeltas.set(
                  qtyKey,
                  (qtyDeltas.get(qtyKey) || 0) - itemQty(it),
                );
                nextItem.stockDebited = true;
              }
              if (!nextDone && wasDone && nextItem.stockDebited === true) {
                qtyDeltas.set(
                  qtyKey,
                  (qtyDeltas.get(qtyKey) || 0) + itemQty(it),
                );
                nextItem.stockDebited = false;
              }
            }
            return nextItem;
          }),
        };
        const effectiveItems = next.items.filter(
          (item) =>
            !isCorrectionRemovedItem(item) &&
            !isOrderItemDisabled(item, stationKey),
        );
        const total = effectiveItems.reduce(
          (sum, item) => sum + itemQty(item),
          0,
        );
        const done = effectiveItems.reduce(
          (sum, item) => sum + (item.done === true ? itemQty(item) : 0),
          0,
        );
        if (total > 0 && done === total) next.workflowStatus = "ready";
        else if (done > 0) next.workflowStatus = "prep";
        else next.workflowStatus = "waiting";
        const nextStatus =
          next.workflowStatus === "ready"
            ? "ready"
            : next.workflowStatus === "prep"
              ? "prep"
              : "new";
        const nextReadyAtMs =
          nextStatus === "ready"
            ? previousStatus === "ready"
              ? msOrNull(cur.readyAtMs) || Date.now()
              : Date.now()
            : null;
        transitionedToReady =
          previousStatus !== "ready" && nextStatus === "ready";
        updated = { ...next, readyAtMs: nextReadyAtMs, completedAtMs: null };
        const clone = [...prev];
        clone[idx] = updated;
        ordersRef.current = clone;
        return clone;
      });
      if (updated) {
        applyTempQtyDeltas(qtyDeltas);
        const currentStatus = computeStatus(updated);
        if (currentStatus === "ready")
          pushToast(`Comanda #${updated.id} da ritirare`);
        void (async () => {
          const synced = transitionedToReady
            ? await syncOrderReliably(updated)
            : await syncOrder(updated);
          if (transitionedToReady && synced) {
            await syncOrders();
          } else if (transitionedToReady && !synced) {
            pushToast(
              `Comanda #${updated.id} pronta: sincronizzazione in attesa`,
              4200,
            );
          }
        })();
      }
    },
    [
      applyTempQtyDeltas,
      computeStatus,
      getTempItemByName,
      isOrderItemDisabled,
      pushToast,
      selectedId,
      stationActive,
      syncOrder,
      syncOrderReliably,
      syncOrders,
    ],
  );

  const checkBackendStatus = useCallback(async () => {
    setLogin((p) => ({ ...p, backendStatus: "checking" }));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2200);
    try {
      const res = await fetch(`${apiRef.current}/api/health`, {
        method: "GET",
        signal: ctrl.signal,
      });
      setLogin((p) => ({ ...p, backendStatus: res.ok ? "online" : "offline" }));
    } catch {
      setLogin((p) => ({ ...p, backendStatus: "offline" }));
    } finally {
      clearTimeout(t);
    }
  }, []);

  const loadManagedUsers = useCallback(async () => {
    const authLocal = authRef.current;
    if (!authLocal?.loggedIn) {
      setManagedUsers([]);
      setManagedUsersError("");
      return false;
    }

    const payloadBase = {
      token: String(authLocal.token || "").trim(),
      userId: String(authLocal.userId || "").trim(),
      username: String(authLocal.username || "").trim(),
      fullName: String(authLocal.fullName || "").trim(),
      deviceUuid: String(authLocal.deviceUuid || "").trim(),
      clientApp: "postazione",
    };
    if (!payloadBase.token || !payloadBase.userId || !payloadBase.deviceUuid) {
      setManagedUsers([]);
      setManagedUsersError("Sessione non valida.");
      return false;
    }

    setManagedUsersLoading(true);
    setManagedUsersError("");
    let fail = "Lista utenti non disponibile.";

    try {
      const bases = [apiRef.current].filter(Boolean);
      for (const base of bases) {
        try {
          const res = await fetch(`${base}/api/settings/pos/users`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Client-App": "postazione",
            },
            body: JSON.stringify(payloadBase),
          });
          const body = await res.json().catch(() => null);
          if (res.ok && body?.ok && Array.isArray(body.users)) {
            const next = body.users
              .map((entry) => ({
                id: String(entry?.id || "").trim(),
                username: String(entry?.username || "").trim(),
                fullName: String(
                  entry?.fullName || entry?.username || "",
                ).trim(),
                roleLabel: String(
                  entry?.roleLabel || entry?.role || "Operatore",
                ).trim(),
              }))
              .filter(
                (entry) =>
                  entry.fullName.length > 0 || entry.username.length > 0,
              )
              .sort((left, right) =>
                left.fullName.localeCompare(right.fullName, "it", {
                  sensitivity: "base",
                }),
              );

            setManagedUsers(next);
            setManagedUsersError("");
            return true;
          }
          if (res.status === 403) {
            fail = "Utente non autorizzato alla gestione utenti.";
            break;
          }
          if (res.status === 401) {
            fail = "Sessione scaduta. Riesegui il login.";
            break;
          }
          fail =
            (body && typeof body.error === "string" && body.error.trim()) ||
            `Errore utenti (${res.status})`;
        } catch {
          // try next base
        }
      }

      setManagedUsers([]);
      setManagedUsersError(fail);
      return false;
    } finally {
      setManagedUsersLoading(false);
    }
  }, []);

  const checkAuthSessionStatus = useCallback(async () => {
    const authLocal = authRef.current;
    if (!authLocal?.loggedIn) return "unknown";

    const token = String(authLocal.token || "").trim();
    const userId = String(authLocal.userId || "").trim();
    const deviceUuid = String(authLocal.deviceUuid || "").trim();
    if (!token || !userId || !deviceUuid) return "invalid";

    const payload = {
      token,
      userId,
      deviceUuid,
      clientApp: "postazione",
    };

    for (const base of [apiRef.current].filter(Boolean)) {
      try {
        const res = await fetch(`${base}/api/auth/session/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-App": "postazione",
          },
          body: JSON.stringify(payload),
        });

        if (res.status === 401 || res.status === 400) {
          return "invalid";
        }
        if (!res.ok) {
          continue;
        }

        const body = await res.json().catch(() => null);
        if (!body || body.ok !== true || body.valid !== true) {
          continue;
        }

        return "valid";
      } catch {
        // The configured API is temporarily unavailable.
      }
    }

    return "unknown";
  }, []);

  useEffect(() => {
    if (auth.loggedIn) return undefined;
    void checkBackendStatus();
    const timer = setInterval(() => void checkBackendStatus(), 8000);
    return () => clearInterval(timer);
  }, [auth.loggedIn, checkBackendStatus]);

  useEffect(() => {
    if (entryStage !== "workstation") return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const page = document.querySelector(".prelogin-page");
    if (page) {
      page.scrollLeft = 0;
      page.scrollTop = 0;
    }
  }, [entryStage]);

  useEffect(() => {
    if (!modal.login || !auth.loggedIn) return;
    void loadManagedUsers();
  }, [auth.loggedIn, loadManagedUsers, modal.login]);

  function stopHoldLoop() {
    if (holdRafRef.current !== null) {
      window.cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
  }

  function resetHoldProgress() {
    stopHoldLoop();
    holdStartRef.current = null;
    setHoldProgress(0);
    setIsHolding(false);
  }

  function runHoldFrame(timestamp) {
    if (holdStartRef.current === null) {
      holdStartRef.current = timestamp;
    }
    const elapsed = timestamp - holdStartRef.current;
    const progress = Math.min(elapsed / HOLD_DURATION_MS, 1);
    setHoldProgress(progress);
    if (progress >= 1) {
      stopHoldLoop();
      holdStartRef.current = null;
      setIsHolding(false);
      setEntryStage("form");
      return;
    }
    holdRafRef.current = window.requestAnimationFrame(runHoldFrame);
  }

  function startHold() {
    if (
      entryStage !== "launcher" ||
      isHolding ||
      login.pending ||
      logoutPending
    )
      return;
    setIsHolding(true);
    setHoldProgress(0);
    holdStartRef.current = null;
    stopHoldLoop();
    holdRafRef.current = window.requestAnimationFrame(runHoldFrame);
  }

  function cancelHold() {
    if (entryStage !== "launcher") return;
    if (holdProgress >= 1) return;
    resetHoldProgress();
  }

  useEffect(
    () => () => {
      stopHoldLoop();
    },
    [],
  );

  const doLogin = useCallback(
    async (event) => {
      event.preventDefault();
      if (!canStartPostazioneLogin(logoutInflightRef.current)) {
        setLogin((p) => ({
          ...p,
          error: "Logout in completamento. Attendi un momento.",
        }));
        return;
      }
      const username = String(login.username || "").trim();
      const pin = String(login.pin || "").trim();
      if (!username) {
        setLogin((p) => ({ ...p, error: "Inserisci username." }));
        return;
      }
      if (!/^\d{4,6}$/.test(pin)) {
        setLogin((p) => ({ ...p, error: "PIN non valido (4-6 cifre)." }));
        return;
      }

      setLogin((p) => ({ ...p, pending: true, error: "" }));
      let fail = "Errore di rete.";
      for (const base of [apiRef.current].filter(Boolean)) {
        try {
          const res = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Client-App": "postazione",
            },
            body: JSON.stringify({
              username,
              pin,
              deviceUuid: auth.deviceUuid,
              clientApp: "postazione",
            }),
          });
          const payload = await res.json().catch(() => null);
          if (!res.ok || !payload?.ok) {
            fail = payload?.error || `Errore login (${res.status})`;
            if (res.status === 400 || res.status === 401) break;
            continue;
          }

          if (login.remember) {
            localStorage.setItem(LS.lastUser, username);
            localStorage.setItem(LS.rememberUser, "1");
          } else {
            localStorage.removeItem(LS.lastUser);
            localStorage.setItem(LS.rememberUser, "0");
          }

          const user =
            payload.user && typeof payload.user === "object"
              ? payload.user
              : {};
          const fullName =
            String(user.fullName || user.username || username).trim() ||
            username;
          const roleLabel =
            String(user.roleLabel || user.role || "").trim() || "Operatore";
          const token = String(payload.token || "").trim();
          const userId = String(user.id || "").trim();
          if (!token || !userId) {
            fail = "Risposta di login incompleta. Riprova.";
            continue;
          }
          const nextPendingAuth = {
            ...authRef.current,
            loggedIn: false,
            token,
            userId,
            username: String(user.username || username),
            fullName,
            userName: fullName,
            userRole: roleLabel,
          };
          setPendingLoginAuth(nextPendingAuth);
          setLoginWorkstations(normalizeAvailableWorkstations(payload));
          setWorkstationSelection({ pendingId: "", error: "" });
          setLogin((p) => ({
            ...p,
            pending: false,
            pin: "",
            error: "",
            backendStatus: "online",
          }));
          setEntryStage("workstation");
          return;
        } catch {
          // try fallback
        }
      }
      setLogin((p) => ({
        ...p,
        pending: false,
        error: fail,
        backendStatus: "offline",
      }));
    },
    [
      auth.deviceUuid,
      login.pin,
      login.remember,
      login.username,
    ],
  );

  const completeLocalLogout = useCallback((reason = "") => {
    const message = typeof reason === "string" ? reason.trim() : "";
    const loggedOutAuth = {
      ...authRef.current,
      loggedIn: false,
      userName: "Guest",
      userRole: "Non autenticato",
      token: "",
      userId: "",
      username: "",
      fullName: "Guest",
    };
    notificationSessionGenerationRef.current += 1;
    notificationPullQueuedRef.current = false;
    fullSyncCoordinatorRef.current?.cancel();
    authRef.current = loggedOutAuth;
    activeApiControllersRef.current.forEach((controller) => controller.abort());
    activeApiControllersRef.current.clear();
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    removeAuthKey(LS.auth);
    writeJson(LS.operator, {
      loggedIn: false,
      userName: "Guest",
      userRole: "Non autenticato",
    });
    clearNativeNotificationSession();
    dispatchPostazioneSessionEvent(POSTAZIONE_SESSION_CLEARED_EVENT);
    if (holdRafRef.current !== null) {
      window.cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    holdStartRef.current = null;
    setIsHolding(false);
    setHoldProgress(0);
    setEntryStage("launcher");
    setPendingLoginAuth(null);
    setLoginWorkstations([]);
    setWorkstationSelection({ pendingId: "", error: "" });
    setLogin((p) => ({
      ...p,
      username: "",
      pin: "",
      showPin: false,
      pending: false,
      error: message,
    }));
    setAuth(loggedOutAuth);
    ordersRef.current = [];
    waiterCallStatesRef.current = {};
    orderFpRef.current = "";
    waiterFpRef.current = "";
    setOrders([]);
    setWaiters([]);
    setWaiterCallStates({});
    setSelectedId(null);
    setPendingAuth(null);
    setPendingDisableItem("");
    setPendingNotify("");
    setTransferTarget("");
    setPauseTransferTarget("");
    setPauseTransferCandidates([]);
    setPendingLogoutOptions(null);
    setToast({ show: false, text: "" });
    setModal({
      login: false,
      transfer: false,
      auth: false,
      catalog: false,
      scope: false,
      tempItem: false,
      print: false,
      notify: false,
      pauseTransfer: false,
      logoutConfirm: false,
    });
    window.__postazioneActiveMobileWaiters = [];
    try {
      window.dispatchEvent(
        new CustomEvent("postazione:waiters-updated", {
          detail: { waiters: [] },
        }),
      );
    } catch {
      // noop
    }
    setManagedUsers([]);
    setManagedUsersError("");
    setManagedUsersLoading(false);
  }, []);

  const requestBackendLogout = useCallback(async (authSnapshot, station) => {
    const body = JSON.stringify({
      token: String(authSnapshot?.token || "").trim(),
      userId: String(authSnapshot?.userId || "").trim(),
      deviceUuid: String(authSnapshot?.deviceUuid || "").trim(),
      clientApp: "postazione",
      station,
      stationName: station,
    });
    let error = "Backend non raggiungibile: logout non eseguito.";
    for (const base of [apiRef.current].filter(Boolean)) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(`${base}/api/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-App": "postazione",
          },
          body,
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (response.ok && payload?.ok === true) {
          return { ok: true };
        }
        if (response.status === 401) return { ok: true, sessionInvalid: true };
        error = String(
          payload?.error || `Logout non riuscito (${response.status}).`,
        ).trim();
        if (response.status >= 400 && response.status < 500) break;
      } catch {
        // The configured API is temporarily unavailable.
      } finally {
        window.clearTimeout(timer);
      }
    }
    return { ok: false, error };
  }, []);

  const confirmLoginWorkstation = useCallback(
    async (workstationId) => {
      const pendingAuth = pendingLoginAuth;
      const workstation = findAvailableWorkstation(
        loginWorkstations,
        workstationId,
      );
      if (!pendingAuth || !workstation || workstationSelection.pendingId) {
        return;
      }

      setWorkstationSelection({ pendingId: workstation.id, error: "" });
      let fail = "Backend non raggiungibile. Riprova.";
      for (const base of [apiRef.current].filter(Boolean)) {
        try {
          const response = await fetch(`${base}/api/auth/workstation/select`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${pendingAuth.token}`,
              "X-Client-App": "postazione",
            },
            body: JSON.stringify({
              token: pendingAuth.token,
              userId: pendingAuth.userId,
              deviceUuid: pendingAuth.deviceUuid,
              clientApp: "postazione",
              workstationId: workstation.id,
              stationName: workstation.stationName,
            }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || payload?.ok !== true) {
            fail =
              String(payload?.error || "").trim() ||
              `Selezione non riuscita (${response.status}).`;
            if (response.status === 401) {
              setPendingLoginAuth(null);
              setLoginWorkstations([]);
              setEntryStage("form");
              setLogin((current) => ({
                ...current,
                pin: "",
                error: "Sessione scaduta. Ripeti il login.",
              }));
              setWorkstationSelection({ pendingId: "", error: "" });
              return;
            }
            if (response.status >= 400 && response.status < 500) break;
            continue;
          }

          const selected = normalizeSelectedWorkstation(payload);
          if (
            !selected ||
            selected.id !== workstation.id ||
            !sameStationName(selected.stationName, workstation.stationName) ||
            !findAvailableWorkstation(loginWorkstations, selected.id)
          ) {
            fail = "Il server ha restituito una postazione non valida.";
            break;
          }

          const selectedStationName = normStation(selected.stationName);
          const nextAuth = { ...pendingAuth, loggedIn: true };
          stationRef.current = selectedStationName;
          notificationSessionGenerationRef.current += 1;
          authRef.current = nextAuth;
          setStationName(selectedStationName);
          setPendingLoginAuth(null);
          setLoginWorkstations([]);
          setWorkstationSelection({ pendingId: "", error: "" });
          setAuth(nextAuth);
          setEntryStage("launcher");
          setLogin((current) => ({
            ...current,
            pending: false,
            pin: "",
            error: "",
            backendStatus: "online",
          }));
          pushToast(`Login: ${nextAuth.fullName}`);
          void syncWaiters();
          return;
        } catch {
          // The configured API is temporarily unavailable.
        }
      }

      setWorkstationSelection({ pendingId: "", error: fail });
    },
    [
      loginWorkstations,
      pendingLoginAuth,
      pushToast,
      syncWaiters,
      workstationSelection.pendingId,
    ],
  );

  const cancelLoginWorkstationSelection = useCallback(async () => {
    if (workstationSelection.pendingId) return;
    const pendingAuth = pendingLoginAuth;
    setWorkstationSelection({ pendingId: "__cancel__", error: "" });
    const result = pendingAuth
      ? await requestBackendLogout(pendingAuth, "")
      : { ok: true };
    setPendingLoginAuth(null);
    setLoginWorkstations([]);
    setWorkstationSelection({ pendingId: "", error: "" });
    setEntryStage("form");
    setLogin((current) => ({
      ...current,
      pin: "",
      pending: false,
      error: result.ok
        ? ""
        : "Sessione chiusa sul dispositivo; il backend non era raggiungibile.",
    }));
  }, [pendingLoginAuth, requestBackendLogout, workstationSelection.pendingId]);

  const requestStationOffline = useCallback(
    (authSnapshot, station) =>
      apiFetchJson("/api/integration/stations/state", {
        method: "POST",
        headers: { "X-Postazione-Session-Cleanup": "logout" },
        body: JSON.stringify({
          station,
          active: false,
          clientApp: "postazione",
          deviceUuid: String(authSnapshot?.deviceUuid || "").trim(),
          operatorUserId: String(authSnapshot?.userId || "").trim(),
          operatorUsername: String(authSnapshot?.username || "").trim(),
          operatorName: String(
            authSnapshot?.fullName || authSnapshot?.userName || "",
          ).trim(),
        }),
      }),
    [apiFetchJson],
  );

  const doLogout = useCallback(
    async (options = {}) => {
      if (logoutInflightRef.current) return;
      const reason =
        typeof options?.reason === "string" ? options.reason.trim() : "";
      const sessionInvalid = options?.sessionInvalid === true;
      if (!sessionInvalid && options?.confirmed !== true) {
        setPendingLogoutOptions({ reason, sessionInvalid: false });
        setModal((current) => ({ ...current, logoutConfirm: true }));
        return;
      }
      setModal((current) => ({ ...current, logoutConfirm: false }));
      setPendingLogoutOptions(null);
      const authSnapshot = authRef.current;
      const station = normStation(stationRef.current);
      logoutInflightRef.current = true;
      setLogoutPending(true);
      try {
        await performPostazioneLogout({
          authSnapshot,
          station,
          reason,
          sessionInvalid,
          completeLocalLogout,
          requestBackendLogout,
          requestStationOffline,
          onBackendUnavailable: () => {
            pushToast(
              "Logout locale completato; server non raggiungibile.",
              4200,
            );
          },
        });
      } finally {
        logoutInflightRef.current = false;
        setLogoutPending(false);
      }
    },
    [
      completeLocalLogout,
      pushToast,
      requestBackendLogout,
      requestStationOffline,
    ],
  );

  useEffect(() => {
    if (!auth.loggedIn) return undefined;

    let disposed = false;
    let inFlight = false;
    const runSessionCheck = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const status = await checkAuthSessionStatus();
        if (!disposed && status === "invalid") {
          doLogout({
            reason:
              "Sessione terminata: accesso effettuato su un'altra app o postazione.",
            sessionInvalid: true,
          });
        }
      } finally {
        inFlight = false;
      }
    };

    void runSessionCheck();
    const timer = setInterval(() => {
      void runSessionCheck();
    }, 3000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [auth.loggedIn, checkAuthSessionStatus, doLogout]);

  const dateText = useMemo(() => {
    const d = new Date(nowMs);
    return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }, [nowMs]);

  const timeText = useMemo(() => {
    const d = new Date(nowMs);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }, [nowMs]);

  const initials = auth.loggedIn
    ? String(auth.userName || "")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((x) => x[0] || "")
        .join("")
        .toUpperCase()
    : "G";

  const systemText = !online ? "OFFLINE" : stationActive ? "ONLINE" : "PAUSA";

  const selectedStatus = selected ? computeStatus(selected) : "";
  const selectedReadyAtMs = selected ? msOrNull(selected.readyAtMs) : null;
  const selectedPrepStopMs =
    selected && (selectedStatus === "ready" || isTerminalStatus(selectedStatus))
      ? selectedReadyAtMs || nowMs
      : nowMs;
  const selectedPrepTimer = selected
    ? fmtMMSS(selectedPrepStopMs - selected.receivedAtMs)
    : "-";
  const selectedReadyTimer =
    selected && selectedStatus === "ready" && selectedReadyAtMs
      ? fmtMMSS(nowMs - selectedReadyAtMs)
      : "";
  const selectedTransferredOut =
    !!selected && isTransferredOutForStation(selected, stationName);
  const selectedCancelled = selectedStatus === "cancelled";
  const selectedCorrected =
    !!selected && !selectedCancelled && hasCorrections(selected);
  const selectedDetailWatermark = selectedCancelled
    ? "ANNULLATO"
    : selectedCorrected
      ? "MODIFICATO"
      : undefined;
  const canAct =
    !!selected &&
    stationActive &&
    !selectedTransferredOut &&
    selectedStatus !== "ready" &&
    !isTerminalStatus(selectedStatus);
  const canTransfer =
    !!selected &&
    stationActive &&
    !selectedTransferredOut &&
    selectedStatus !== "ready" &&
    !isTerminalStatus(selectedStatus) &&
    (selectedStatus !== "new" || allowTransferWaiting);
  const canRecall =
    !!selected &&
    stationActive &&
    selectedTransferredOut &&
    selectedStatus === "new";
  const selectedWaiterAvailability = useMemo(
    () => resolveOrderWaiterAvailability(selected, waiters),
    [selected, waiters],
  );
  const selectedWaiterUnavailable =
    !!selected &&
    !selectedTransferredOut &&
    String(selected?.source || "")
      .trim()
      .toLowerCase() !== "cassa-frontend" &&
    selectedWaiterAvailability.required &&
    !selectedWaiterAvailability.available;
  const callBtnDisabled = selectedTransferredOut
    ? !canRecall
    : !(!!selected && stationActive) ||
      selectedHistorical ||
      selectedWaiterUnavailable;
  const callBtnAccessibleLabel = selectedTransferredOut
    ? "Richiedi indietro la comanda"
    : String(selected?.source || "")
          .trim()
          .toLowerCase() === "cassa-frontend"
      ? "Richiedi supporto alla cassa"
      : "Chiama cameriere";
  const dismissSelectedCancelled = useCallback(() => {
    const orderId = String(selectedId || "").trim();
    if (!orderId) return;
    const order = ordersRef.current.find(
      (entry) => String(entry?.id || "") === orderId,
    );
    if (!isCancelledOrder(order)) return;
    setDismissedCancelledOrderIds((prev) => {
      const next = new Set(prev);
      next.add(orderId);
      return next;
    });
    setSelectedId(null);
    pushToast(`Comanda #${orderId} archiviata`);
  }, [pushToast, selectedId]);
  const menuPriceMap = useMemo(
    () =>
      new Map(
        menuWithTemp.map((item) => [
          String(item.name || "")
            .trim()
            .toLowerCase(),
          Number.isFinite(Number(item.price)) ? Number(item.price) : 0,
        ]),
      ),
    [menuWithTemp],
  );

  const printFallback = useCallback((value, emptyLabel) => {
    const normalized = String(value ?? "").trim();
    return normalized || emptyLabel;
  }, []);

  const printSelected = useCallback(
    async (kind) => {
      if (!selected) {
        pushToast("Seleziona una comanda");
        return;
      }
      if (!isAuthenticatedPostazioneSession(authRef.current)) return;
      const printSessionGeneration = notificationSessionGenerationRef.current;

      const elapsed = fmtMMSS(
        (msOrNull(selected.completedAtMs) || Date.now()) -
          selected.receivedAtMs,
      );
      const table = tableLabel(selected);
      const room = printFallback(roomLabel(selected), "Sala non indicata");
      const isPreconto = kind === "preconto";

      let text = "";
      if (isPreconto) {
        const rows = selected.items.map((it) => {
          const price = menuPriceMap.get(
            String(it.name || "")
              .trim()
              .toLowerCase(),
          );
          return {
            name: String(it?.name || "Articolo"),
            price: Number.isFinite(Number(price)) ? Number(price) : null,
          };
        });
        const total = rows.reduce((sum, row) => sum + (row.price || 0), 0);
        const body = rows
          .map(
            (row) =>
              `${row.name}\t${row.price == null ? "-" : `${row.price.toFixed(2)} EUR`}`,
          )
          .join("\n");
        text = [
          "PRECONTO",
          "",
          `POSTAZIONE: ${stationRef.current}`,
          `TAVOLO: ${table}`,
          `SALA: ${room}`,
          `CAMERIERE: ${selected.waiter}`,
          `COMANDA: #${selected.id}`,
          "",
          body,
          "",
          `TOTALE: ${total.toFixed(2)} EUR`,
        ].join("\n");
      } else {
        const lines = selected.items
          .map(
            (it) =>
              `${it.name}${it.variant ? ` - ${it.variant}` : ""}\t${printFallback(it.note, "Nessuna nota")}`,
          )
          .join("\n");
        text = [
          `POSTAZIONE: ${stationRef.current}`,
          `TAVOLO: ${table}`,
          `SALA: ${room}`,
          `CAMERIERE: ${selected.waiter}`,
          `COMANDA: #${selected.id}`,
          `TIMER: ${elapsed}`,
          "",
          lines,
          "",
          `NOTE: ${printFallback(selected.note, "Nessuna nota")}`,
          "",
          `COMUNICAZIONI: ${printFallback(selected.communications, "Nessuna comunicazione")}`,
        ].join("\n");
      }

      const printed = await apiFetchJson("/api/integration/print", {
        method: "POST",
        body: JSON.stringify({
          kind: isPreconto ? "preconto" : "order",
          orderId: String(selected.id || ""),
          station: String(stationRef.current || ""),
          text,
        }),
      });
      if (
        !isCurrentPostazioneSession(
          printSessionGeneration,
          notificationSessionGenerationRef.current,
          authRef.current,
        )
      )
        return;
      if (printed?.ok) {
        pushToast(
          isPreconto
            ? "Preconto inviato in stampa"
            : "Comanda inviata in stampa",
        );
        return;
      }

      const popup = window.open("", "_blank");
      if (!popup) {
        pushToast("Impossibile aprire la finestra di stampa");
        return;
      }
      popup.document.open();
      popup.document.write(
        `<!doctype html><html><body><pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; padding:18px; white-space:pre-wrap;"></pre></body></html>`,
      );
      popup.document.close();
      const pre = popup.document.querySelector("pre");
      if (pre) pre.textContent = text;
      popup.focus();
      setTimeout(() => {
        if (
          !isCurrentPostazioneSession(
            printSessionGeneration,
            notificationSessionGenerationRef.current,
            authRef.current,
          )
        ) {
          popup.close();
          return;
        }
        try {
          popup.print();
          popup.close();
        } catch {
          // noop
        }
      }, 60);
      pushToast(isPreconto ? "Preconto pronto" : "Comanda pronta");
    },
    [apiFetchJson, menuPriceMap, printFallback, pushToast, selected],
  );

  if (!auth.loggedIn) {
    const backendLabel =
      login.backendStatus === "online"
        ? "Backend online"
        : login.backendStatus === "offline"
          ? "Backend offline"
          : "Verifica backend";
    const canSubmitLogin =
      !login.pending &&
      !logoutPending &&
      String(login.username || "").trim().length > 0 &&
      /^\d{4,6}$/.test(String(login.pin || ""));

    return (
      <>
        <div className="prelogin-page">
          <div className="hud-bar">
            <div className="hud-time">{timeText}</div>
            <div className="hud-system" aria-label={backendLabel}>
              <span
                className={`hud-led is-${
                  login.backendStatus === "offline"
                    ? "offline"
                    : login.backendStatus === "checking"
                      ? "checking"
                      : "online"
                }`}
                aria-hidden="true"
              />
            </div>
          </div>

          {entryStage === "launcher" ? (
            <div className="launcher-wrap">
              <button
                type="button"
                className={`launch-btn${isHolding ? " is-holding" : ""}`}
                onPointerDown={startHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                onPointerCancel={cancelHold}
                disabled={logoutPending}
              >
                <span className="launch-core">
                  {logoutPending
                    ? "Attendi"
                    : isHolding
                      ? "Tieni premuto"
                      : "Accedi"}
                </span>
                <span
                  className={`watch-loader${isHolding ? " is-active" : ""}`}
                  aria-hidden="true"
                >
                  {Array.from({ length: WATCH_TICK_COUNT }).map((_, i) => {
                    const isOn = holdProgress * WATCH_TICK_COUNT >= i + 1;
                    return (
                      <span
                        key={`tick-${i}`}
                        className={`watch-tick${isOn ? " is-on" : ""}`}
                        style={{ "--i": String(i) }}
                      />
                    );
                  })}
                </span>
              </button>
            </div>
          ) : entryStage === "form" ? (
            <div className="login-shell login-shell-raised login-shell-enter">
              <div className="logo-wrap">
                <div className="logo-mark" aria-label="Logo Postazione">
                  <span className="logo-mark-inner">P</span>
                </div>
                <div className="logo-label">Postazione</div>
              </div>

              <div className="login-card-wide">
                <div className="login-card-body">
                  <form className="login-grid" onSubmit={doLogin}>
                    <div className="user-panel">
                      <input
                        type="text"
                        className="username-input"
                        value={login.username}
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={USERNAME_MAX_LEN}
                        placeholder="Utente"
                        onChange={(e) =>
                          setLogin((p) => ({
                            ...p,
                            username: e.target.value,
                            error: "",
                          }))
                        }
                        disabled={login.pending || logoutPending}
                      />

                      {login.error ? (
                        <div className="login-react-error" role="alert">
                          {login.error}
                        </div>
                      ) : null}

                      <div className="prelogin-pin-wrap">
                        <input
                          type="tel"
                          className={`pin-input${login.showPin ? "" : " pin-input-masked"}`}
                          inputMode="numeric"
                          enterKeyHint="done"
                          pattern="[0-9]*"
                          maxLength={6}
                          value={login.pin}
                          autoComplete="one-time-code"
                          placeholder="PIN"
                          onChange={(e) =>
                            setLogin((p) => ({
                              ...p,
                              pin: String(e.target.value || "").replace(
                                /\D/g,
                                "",
                              ),
                              error: "",
                            }))
                          }
                          disabled={login.pending || logoutPending}
                        />
                        <button
                          className="prelogin-pin-toggle"
                          type="button"
                          onClick={() =>
                            setLogin((p) => ({ ...p, showPin: !p.showPin }))
                          }
                          aria-label={
                            login.showPin ? "Nascondi PIN" : "Mostra PIN"
                          }
                          title={login.showPin ? "Nascondi PIN" : "Mostra PIN"}
                          disabled={login.pending || logoutPending}
                        >
                          <i
                            className={`fa-solid ${login.showPin ? "fa-eye-slash" : "fa-eye"}`}
                          />
                        </button>
                      </div>

                      <div className="prelogin-actions">
                        <button
                          className="modal-btn primary prelogin-submit"
                          type="submit"
                          disabled={!canSubmitLogin}
                        >
                          {login.pending ? "Accesso..." : "Accedi"}
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          ) : (
            <div
              className="modal-backdrop show workstation-login-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby="workstation-login-title"
            >
              <div className="modal-card workstation-login-modal">
                <div className="modal-head">
                  <div className="modal-title" id="workstation-login-title">
                    <i className="fa-solid fa-store" aria-hidden="true" />
                    Scegli postazione
                  </div>
                  <div className="workstation-login-user">
                    {pendingLoginAuth?.fullName || pendingLoginAuth?.username}
                  </div>
                </div>
                <div className="modal-body workstation-login-body">
                  {loginWorkstations.length > 0 ? (
                    <div className="workstation-login-list">
                      {loginWorkstations.map((workstation) => {
                        const pending =
                          workstationSelection.pendingId === workstation.id;
                        return (
                          <button
                            className="workstation-login-option"
                            type="button"
                            key={workstation.id}
                            disabled={Boolean(workstationSelection.pendingId)}
                            aria-busy={pending ? "true" : "false"}
                            onClick={() =>
                              void confirmLoginWorkstation(workstation.id)
                            }
                          >
                            <span className="workstation-login-icon">
                              <i
                                className={`fa-solid ${pending ? "fa-spinner fa-spin" : "fa-cash-register"}`}
                                aria-hidden="true"
                              />
                            </span>
                            <span className="workstation-login-option-copy">
                              <strong>{workstation.name}</strong>
                              {workstation.name !== workstation.stationName ? (
                                <span>{workstation.stationName}</span>
                              ) : null}
                            </span>
                            <i
                              className="fa-solid fa-chevron-right workstation-login-chevron"
                              aria-hidden="true"
                            />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="workstation-login-empty" role="alert">
                      Nessuna postazione abilitata per questo utente.
                    </div>
                  )}

                  {workstationSelection.error ? (
                    <div className="login-react-error" role="alert">
                      {workstationSelection.error}
                    </div>
                  ) : null}
                </div>
                <div className="modal-actions workstation-login-actions">
                  <button
                    className="modal-btn"
                    type="button"
                    disabled={Boolean(workstationSelection.pendingId)}
                    onClick={() => void cancelLoginWorkstationSelection()}
                  >
                    <i className="fa-solid fa-arrow-left" aria-hidden="true" />
                    {workstationSelection.pendingId === "__cancel__"
                      ? "Uscita..."
                      : "Cambia utente"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div
          className={`toast${toast.show ? " show" : ""}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {toast.text}
        </div>
      </>
    );
  }

  return (
    <>
      <header>
        <div className="station-status-wrapper">
          <span className="station-label">POSTAZIONE</span>
          <label className="toggle-switch">
            <input
              id="stationToggle"
              className="toggle-checkbox"
              type="checkbox"
              checked={stationActive}
              onChange={(event) =>
                void handleStationActiveChange(event.target.checked)
              }
            />
            <span className="toggle-slider">
              <i className="fa-solid fa-play icon-play" />
              <i className="fa-solid fa-pause icon-pause" />
            </span>
          </label>
        </div>

        <div className="header-mini-actions">
          <label className="toggle-switch" title="Storico comande">
            <input
              id="historyToggle"
              className="toggle-checkbox"
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            <span className="toggle-slider">
              <i className="fa-solid fa-clock-rotate-left icon-play" />
              <i className="fa-solid fa-ban icon-pause" />
            </span>
          </label>
          <button
            className="menu-btn"
            type="button"
            onClick={() => setModal((m) => ({ ...m, catalog: true }))}
          >
            MENU
          </button>
        </div>

        <div className="header-center">
          <span className="date-display">{dateText}</span>
          <span className="time-display">{timeText}</span>
        </div>

        <div className="header-right">
          <BluetoothDiagnosticBadge />
          <div className={`system-pill${!online ? " offline" : ""}`}>
            <div
              className="blink-dot"
              style={{
                animationPlayState: stationActive ? "running" : "paused",
              }}
            />
            <span>{systemText}</span>
          </div>

          <div className="station-selector station-selector-static">
            <span className="ss-label">POSTAZIONE ATTIVA</span>
            <span className="ss-value">{stationName}</span>
          </div>

          <div
            className="user-profile"
            onClick={() => {
              setModal((m) => ({ ...m, login: true }));
              setLogin((p) => ({ ...p, pin: "", showPin: false, error: "" }));
              void checkBackendStatus();
            }}
          >
            <div className="avatar-circle">{initials || "G"}</div>
            <div className="user-info">
              <span className="user-name">
                {auth.loggedIn ? auth.userName : "Guest"}
              </span>
              <span className="user-role">
                {auth.loggedIn ? auth.userRole : "Non autenticato"}
              </span>
            </div>
          </div>

          <label className="theme-switch" title="Tema chiaro/scuro">
            <input
              className="theme-checkbox"
              type="checkbox"
              checked={darkMode}
              onChange={(e) => setDarkMode(e.target.checked)}
            />
            <span className="theme-slider">
              <i className="fa-solid fa-moon icon-moon" />
              <i className="fa-solid fa-sun icon-sun" />
            </span>
          </label>

          <button
            className="logout-btn"
            type="button"
            title="Logout"
            onClick={doLogout}
          >
            <i className="fa-solid fa-right-from-bracket logout-icon" />
          </button>
        </div>
      </header>

      <div
        className="pause-overlay"
        style={{ display: stationActive ? "none" : "flex" }}
        aria-hidden={stationActive ? "true" : "false"}
      >
        <div className="pause-card">
          <div className="pause-title">
            <i className="fa-solid fa-circle-pause" /> Postazione in pausa
          </div>
          <div className="pause-sub">
            La postazione e disabilitata. Riattivala dallo switch in alto.
          </div>
        </div>
      </div>

      <main
        className={
          selectedCancelled ? "postazione-cancelled-layout" : undefined
        }
      >
        <div className="sidebar" id="ordersSidebar">
          <div className="orders-controls">
            <div className="search-wrap">
              <i className="fa-solid fa-magnifying-glass" />
              <input
                className="search-input"
                placeholder="Cerca: tavolo, cameriere, #comanda"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="orders-list">
            {visibleOrders.length === 0 ? (
              <div
                className="order-card"
                style={{
                  padding: "12px",
                  color: "var(--text-secondary)",
                  fontWeight: 800,
                  border: "1px dashed rgba(255,255,255,.16)",
                }}
              >
                {orders.length > 0
                  ? "Nessuna comanda visibile con i filtri correnti."
                  : syncInfo.ok
                    ? "Nessuna comanda in arrivo."
                    : "Sync backend non disponibile."}
              </div>
            ) : (
              visibleOrders.map((o) => {
                const s = computeStatus(o);
                const cancelled = s === "cancelled";
                const historical = isHistoricalOrder(o);
                const corrected = !cancelled && hasCorrections(o);
                const strip = cancelled
                  ? "st-cancelled"
                  : s === "new"
                    ? "st-new"
                    : s === "prep"
                      ? "st-prep"
                      : s === "ready"
                        ? "st-ready"
                        : "st-done";
                const badge = cancelled
                  ? "bg-cancelled"
                  : s === "new"
                    ? "bg-new"
                    : s === "prep"
                      ? "bg-prep"
                      : s === "ready"
                        ? "bg-ready"
                        : "bg-done";
                const readyAtMs = msOrNull(o.readyAtMs);
                const prepStopMs =
                  s === "ready" || isTerminalStatus(s)
                    ? readyAtMs || nowMs
                    : nowMs;
                const prepTimer = fmtMMSS(prepStopMs - o.receivedAtMs);
                const readyTimer =
                  s === "ready" && readyAtMs ? fmtMMSS(nowMs - readyAtMs) : "";
                const lockedByOther =
                  !!o.ownerStation &&
                  o.ownerStation !== stationName &&
                  isStationOnline(o.ownerStation);
                return (
                  <div
                    key={o.id}
                    className={`order-card${o.id === selectedId ? " selected" : ""}${o.id === selectedId && showHistory ? " history-selected" : ""}${historical ? " history-card" : ""}${lockedByOther ? " locked" : ""}${corrected ? " postazione-correction-card" : ""}${cancelled ? " postazione-cancelled-card" : ""}`}
                    onClick={() => selectOrder(o.id)}
                  >
                    <div className={`status-strip ${strip}`} />
                    <div className="card-header">
                      <span className="card-table-label">
                        TAVOLO: {tableLabel(o)}
                      </span>
                      {cancelled ? (
                        <span
                          className="postazione-correction-alert-badge postazione-cancelled-alert-badge"
                          title="Comanda annullata"
                          aria-label="Comanda annullata"
                        >
                          <i className="fa-solid fa-ban" aria-hidden="true" />
                          <span>ANNULLATA</span>
                        </span>
                      ) : corrected ? (
                        <span
                          className="postazione-correction-alert-badge"
                          title="Comanda modificata"
                          aria-label="Comanda modificata"
                        >
                          <i
                            className="fa-solid fa-triangle-exclamation"
                            aria-hidden="true"
                          />
                          <span>MODIFICATA</span>
                        </span>
                      ) : null}
                      <span className="card-right">
                        {lockedByOther ? (
                          <i
                            className="fa-solid fa-lock"
                            title="In carico ad altra postazione"
                          />
                        ) : null}
                        #{o.id}
                      </span>
                    </div>
                    <div className="card-body">
                      <div>Sala: {roomLabel(o) || "-"}</div>
                      <div>Cam: {o.waiter}</div>
                      <div style={{ marginTop: "2px" }}>
                        In carico: <strong>{ownerDisplayLabel(o)}</strong>
                      </div>
                      <span className={`status-badge ${badge}`}>
                        {statusLabel(s)}
                      </span>
                      {historical ? (
                        <span className="history-badge">STORICO</span>
                      ) : null}
                      <span className="timer">{prepTimer}</span>
                      {readyTimer ? (
                        <div className="timer-ready">
                          Pronta da {readyTimer}
                        </div>
                      ) : null}
                      <div>
                        Coperti: {o.covers} | Apericena: {o.apericena}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div
          className={`detail-view${selectedCancelled ? " postazione-cancelled-detail" : ""}${selectedCorrected ? " postazione-correction-detail" : ""}${selectedHistorical ? " history-readonly-mode" : ""}`}
        >
          <div
            className="detail-header"
            data-state-watermark={selectedDetailWatermark}
          >
            <div>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.9rem",
                  fontWeight: 800,
                }}
              >
                TAVOLO
              </span>
              <br />
              <span style={{ fontSize: "1.5rem", fontWeight: 950 }}>
                {selected ? tableLabel(selected) : "-"}
              </span>
            </div>
            <div>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.9rem",
                  fontWeight: 800,
                }}
              >
                SALA
              </span>
              <br />
              <span>{selected ? roomLabel(selected) || "-" : "-"}</span>
            </div>
            <div>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.9rem",
                  fontWeight: 800,
                }}
              >
                CAMERIERE
              </span>
              <br />
              <span>{selected ? selected.waiter : "-"}</span>
            </div>
            <div>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.9rem",
                  fontWeight: 800,
                }}
              >
                COMANDA
              </span>
              <br />
              <span>{selected ? `#${selected.id}` : "-"}</span>
            </div>
            <div>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.9rem",
                  fontWeight: 800,
                }}
              >
                TIMER
              </span>
              <br />
              <span style={{ color: "#d32f2f" }}>{selectedPrepTimer}</span>
              {selectedReadyTimer ? (
                <div className="timer-ready">
                  Pronta da {selectedReadyTimer}
                </div>
              ) : null}
            </div>
          </div>

          <div className="item-list">
            {!selected ? (
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontWeight: 850,
                  padding: "10px 0",
                }}
              >
                Seleziona una comanda a sinistra.
              </div>
            ) : (
              selectedGroups.map((g) => {
                const qty = g.quantity;
                const done = g.doneQuantity;
                const allDone = qty > 0 && done === qty;
                const someDone = done > 0 && !allDone;
                const outOfStock = g.items.some((item) =>
                  isOrderItemDisabled(item, stationName),
                );
                const quantityChange = correctionChangeForGroup(
                  selectedCorrectionState,
                  g,
                );
                const previousQuantity = Number(
                  quantityChange?.previousQuantity,
                );
                const nextQuantity = Number(quantityChange?.nextQuantity);
                const quantityChanged =
                  Number.isFinite(previousQuantity) &&
                  Number.isFinite(nextQuantity) &&
                  previousQuantity !== nextQuantity;
                const removed = g.removed === true;
                const disabled = !canAct || outOfStock || removed;
                return (
                  <div
                    className={`order-item${outOfStock ? " out-of-stock" : ""}${removed ? " postazione-correction-removed-item is-single" : ""}${quantityChanged ? " postazione-correction-qty-changed" : ""}${selectedCancelled ? " postazione-cancelled-item" : ""}`}
                    key={g.key}
                  >
                    <label
                      className="check-container"
                      style={
                        disabled
                          ? { opacity: 0.65, cursor: "not-allowed" }
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={allDone}
                        ref={(el) => {
                          if (el) el.indeterminate = someDone;
                        }}
                        disabled={disabled}
                        onChange={(e) => toggleGroup(g.key, e.target.checked)}
                      />
                      <span className="checkmark" />
                    </label>
                    <div
                      className={`item-qty${quantityChanged ? " postazione-correction-qty-flash" : ""}`}
                    >
                      {qty}
                      {quantityChanged ? (
                        <span className="postazione-correction-qty-badge">
                          {previousQuantity} -&gt; {nextQuantity}
                        </span>
                      ) : null}
                    </div>
                    <div className="item-name">
                      {String(g.name || "").toUpperCase()}
                      {outOfStock ? (
                        <span className="tag-ooo">TERMINATO</span>
                      ) : null}
                    </div>
                    <div className="item-variant">
                      {g.variant ? (
                        <span className="variant-pill">
                          <em>{g.variant}</em>
                        </span>
                      ) : (
                        "-"
                      )}
                    </div>
                    <div className="item-notes">
                      {g.note ? String(g.note).toUpperCase() : "NESSUNA NOTA"}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="summary-section">
            <div className="stats-row">
              <span>
                COPERTI: <span>{selected ? selected.covers : "-"}</span>
              </span>
              <span>
                APERICENA: <span>{selected ? selected.apericena : "-"}</span>
              </span>
              <span>
                ARTICOLI: <span>{selected ? selected.items.length : "-"}</span>
              </span>
            </div>
            {selected && String(selected.note || "").trim() ? (
              <div className="notes-box">
                <strong>NOTE:</strong>{" "}
                <span>{selected.note.toUpperCase()}</span>
              </div>
            ) : null}
            {selected && String(selected.communications || "").trim() ? (
              <div className="notes-box">
                <strong>COMUNICAZIONI:</strong>{" "}
                <span>{selected.communications.toUpperCase()}</span>
              </div>
            ) : null}
          </div>

          <div
            className={`action-bar${selectedHistorical ? " is-history-readonly" : ""}`}
          >
            <button
              className={`btn btn-call${selectedWaiterUnavailable ? " is-waiter-offline" : ""}${
                selectedTransferredOut ? "" : " btn-icon-only"
              }`}
              type="button"
              disabled={callBtnDisabled}
              aria-disabled={callBtnDisabled ? "true" : undefined}
              aria-label={callBtnAccessibleLabel}
              title={
                selectedWaiterUnavailable
                  ? "Cameriere offline: chiamata non disponibile"
                  : callBtnAccessibleLabel
              }
              onClick={() => {
                if (!selected) {
                  pushToast("Seleziona una comanda");
                  return;
                }
                if (selectedTransferredOut) {
                  void requestRecallForSelected(selected);
                  return;
                }
                void callWaiter(selected.waiter);
              }}
            >
              <i
                className={
                  selectedTransferredOut
                    ? "fa-solid fa-rotate-left"
                    : "fa-regular fa-bell"
                }
                aria-hidden="true"
              />
              {selectedTransferredOut ? <span>RICHIEDI INDIETRO</span> : null}
            </button>
            <button
              className="btn btn-print btn-icon-only"
              type="button"
              disabled={selectedCancelled || selectedHistorical}
              style={{ display: selectedCancelled ? "none" : "flex" }}
              aria-label="Stampa"
              title="Stampa"
              onClick={() => {
                if (!selected) {
                  pushToast("Seleziona una comanda");
                  return;
                }
                setModal((m) => ({ ...m, print: true }));
              }}
            >
              <i className="fa-solid fa-print" aria-hidden="true" />
            </button>
            <button
              className="btn btn-transfer btn-icon-only"
              type="button"
              disabled={!canTransfer}
              style={{
                display: canTransfer && !selectedCancelled ? "flex" : "none",
              }}
              aria-label="Trasferisci"
              title="Trasferisci"
              onClick={() => {
                if (!selected) {
                  pushToast("Seleziona una comanda");
                  return;
                }
                if (!stationActive) {
                  pushToast("Postazione in pausa");
                  return;
                }
                if (selectedStatus === "new" && !allowTransferWaiting) {
                  pushToast(
                    "Trasferimento non abilitato per comande in attesa",
                  );
                  return;
                }
                const candidates = stationStates
                  .filter((entry) => entry.station !== stationName)
                  .filter(isRealActiveStation);
                const first = candidates[0]?.station || "";
                if (!first) {
                  setTransferTarget("");
                  pushToast("Nessuna postazione attiva disponibile");
                  return;
                }
                setTransferTarget(normStation(first));
                setModal((m) => ({ ...m, transfer: true }));
              }}
            >
              <i
                className="fa-solid fa-arrow-right-arrow-left"
                aria-hidden="true"
              />
            </button>
            <button
              className={`btn btn-done${selectedCancelled ? " postazione-cancelled-ok" : ""}`}
              type="button"
              disabled={!canAct && !selectedCancelled}
              style={{ display: canAct || selectedCancelled ? "flex" : "none" }}
              onClick={() => {
                if (selectedCancelled) {
                  dismissSelectedCancelled();
                  return;
                }
                void markReady();
              }}
            >
              {selectedCancelled ? "OK" : "PRONTA"}
            </button>
          </div>
        </div>

        <div className="sidebar">
          <div className="waiter-label">CHIAMA CAMERIERI</div>
          <div className="waiter-buttons">
            {waiters.length === 0 ? (
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontWeight: 800,
                  padding: "8px 0",
                }}
              >
                Nessun cameriere loggato
              </div>
            ) : (
              waiters.map((w) => {
                const key = waiterKey(w);
                const callState = key ? waiterCallStates[key] : null;
                const paused = isWaiterPaused(w);
                const offline = w.online === false || w.activeNow === false;
                const nameLines = splitName(w.name);
                const callStateText = callState
                  ? callState.acknowledged === true
                    ? "HA RISPOSTO - STA ARRIVANDO"
                    : callState.sending === true
                      ? "INVIO CHIAMATA..."
                      : "CHIAMATO - IN ATTESA RISPOSTA"
                  : "";
                return (
                  <div
                    key={`${w.userId || w.username || w.name}`}
                    className={`waiter-circle${callState ? " is-waiter-call-pending" : ""}${callState?.sending ? " is-waiter-call-sending" : ""}${callState?.acknowledged ? " is-waiter-call-acknowledged" : ""}${paused ? " is-waiter-paused" : ""}${offline ? " is-waiter-offline" : ""}`}
                    data-waiter-call-key={key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={callState ? "true" : "false"}
                    aria-busy={callState ? "true" : "false"}
                    onClick={() => void callWaiter(w)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      void callWaiter(w);
                    }}
                  >
                    <div className="waiter-left">
                      <div className="waiter-badge">{w.id}</div>
                      <div
                        className="waiter-name"
                        data-raw-waiter-name={w.name}
                      >
                        <span className="waiter-name-line waiter-name-line-first">
                          {nameLines.firstLine}
                        </span>
                        {nameLines.secondLine ? (
                          <span className="waiter-name-line waiter-name-line-second">
                            {nameLines.secondLine}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {w.roomName ? (
                      <div className="waiter-room-chip">{w.roomName}</div>
                    ) : null}
                    {paused ? (
                      <div className="waiter-pause-chip">
                        PAUSA {formatPauseRemaining(w)}
                      </div>
                    ) : null}
                    {!paused && offline ? (
                      <div className="waiter-offline-chip">NON ONLINE</div>
                    ) : null}
                    {callState ? (
                      <span className="waiter-call-state">{callStateText}</span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </main>

      {modal.login ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) =>
            e.target === e.currentTarget &&
            setModal((m) => ({ ...m, login: false }))
          }
        >
          <div className="modal-card login-react-card">
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-user-lock" /> Accesso postazione
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() => setModal((m) => ({ ...m, login: false }))}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body login-react-body">
              <div className="login-react-meta">
                <span className={`login-react-pill is-${login.backendStatus}`}>
                  {login.backendStatus === "online"
                    ? "Backend online"
                    : login.backendStatus === "offline"
                      ? "Backend offline"
                      : "Verifica backend"}
                </span>
                <span className="login-react-device">
                  Device: {String(auth.deviceUuid || "").slice(0, 12)}...
                </span>
              </div>

              {auth.loggedIn ? (
                <div className="login-react-session">
                  <div className="login-react-session-title">
                    Sessione attiva
                  </div>
                  <div className="login-react-session-name">
                    {auth.userName}
                  </div>
                  <div className="login-react-session-role">
                    {auth.userRole}
                  </div>
                  <div className="login-react-actions">
                    <button
                      className="modal-btn"
                      type="button"
                      onClick={() => setModal((m) => ({ ...m, login: false }))}
                    >
                      Chiudi
                    </button>
                    <button
                      className="modal-btn danger"
                      type="button"
                      onClick={doLogout}
                    >
                      Logout
                    </button>
                  </div>

                  <div className="login-react-users">
                    <div className="login-react-users-head">
                      <div className="login-react-session-title">
                        Utenti creati (gestione)
                      </div>
                      <button
                        className="login-react-users-refresh"
                        type="button"
                        onClick={() => void loadManagedUsers()}
                        disabled={managedUsersLoading}
                      >
                        {managedUsersLoading ? "Aggiorno..." : "Aggiorna"}
                      </button>
                    </div>

                    {managedUsersError ? (
                      <div className="login-react-users-empty">
                        {managedUsersError}
                      </div>
                    ) : managedUsersLoading ? (
                      <div className="login-react-users-empty">
                        Caricamento utenti...
                      </div>
                    ) : managedUsers.length === 0 ? (
                      <div className="login-react-users-empty">
                        Nessun utente trovato.
                      </div>
                    ) : (
                      <div className="login-react-users-list">
                        {managedUsers.map((entry) => (
                          <div
                            key={entry.id || entry.username || entry.fullName}
                            className="login-react-user-row"
                          >
                            <div className="login-react-user-main">
                              <strong>
                                {entry.fullName || entry.username || "Utente"}
                              </strong>
                              <span>@{entry.username || "-"}</span>
                            </div>
                            <div className="login-react-user-role">
                              {entry.roleLabel || "Operatore"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <form className="login-react-form" onSubmit={doLogin}>
                  <div className="login-react-presets">
                    {QUICK_USERS.map((u) => (
                      <button
                        key={u}
                        type="button"
                        className={`login-react-preset${login.username.trim().toLowerCase() === u ? " is-active" : ""}`}
                        onClick={() =>
                          setLogin((p) => ({ ...p, username: u, error: "" }))
                        }
                      >
                        <strong>{u}</strong>
                        <span>Utente</span>
                      </button>
                    ))}
                  </div>
                  <label className="modal-row login-react-field">
                    <span className="modal-label">Username</span>
                    <input
                      className="modal-input"
                      value={login.username}
                      onChange={(e) =>
                        setLogin((p) => ({
                          ...p,
                          username: e.target.value,
                          error: "",
                        }))
                      }
                      placeholder="Es: gianluca"
                    />
                  </label>
                  <label className="modal-row login-react-field">
                    <span className="modal-label">PIN</span>
                    <div className="login-react-pin-wrap">
                      <input
                        className={`modal-input login-react-pin-input${login.showPin ? "" : " is-masked"}`}
                        type="tel"
                        inputMode="numeric"
                        enterKeyHint="done"
                        maxLength={6}
                        pattern="[0-9]*"
                        value={login.pin}
                        onChange={(e) =>
                          setLogin((p) => ({
                            ...p,
                            pin: String(e.target.value || "").replace(
                              /\D/g,
                              "",
                            ),
                            error: "",
                          }))
                        }
                        placeholder="4-6 cifre"
                        autoComplete="one-time-code"
                      />
                      <button
                        className="login-react-pin-toggle"
                        type="button"
                        onClick={() =>
                          setLogin((p) => ({ ...p, showPin: !p.showPin }))
                        }
                        aria-label={
                          login.showPin ? "Nascondi PIN" : "Mostra PIN"
                        }
                        title={login.showPin ? "Nascondi PIN" : "Mostra PIN"}
                      >
                        <i
                          className={`fa-solid ${login.showPin ? "fa-eye-slash" : "fa-eye"}`}
                        />
                      </button>
                    </div>
                  </label>
                  {login.error ? (
                    <div className="login-react-error" role="alert">
                      {login.error}
                    </div>
                  ) : null}
                  <div className="login-react-actions">
                    <button
                      className="modal-btn"
                      type="button"
                      onClick={() => setModal((m) => ({ ...m, login: false }))}
                    >
                      Annulla
                    </button>
                    <button
                      className="modal-btn primary"
                      type="submit"
                      disabled={
                        logoutPending ||
                        login.pending ||
                        !String(login.username || "").trim() ||
                        !/^\d{4,6}$/.test(String(login.pin || ""))
                      }
                    >
                      {logoutPending
                        ? "Attendi..."
                        : login.pending
                          ? "Accesso..."
                          : "Accedi"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {modal.transfer ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) =>
            e.target === e.currentTarget &&
            setModal((m) => ({ ...m, transfer: false }))
          }
        >
          <div className="modal-card modal-transfer is-scroll">
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-arrow-right-arrow-left" /> Trasferisci
                comanda
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() => setModal((m) => ({ ...m, transfer: false }))}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-hint" style={{ marginBottom: "12px" }}>
                Scegli la postazione di destinazione. Le postazioni in pausa non
                sono selezionabili.
              </div>
              <div className="station-grid">
                {stationStates
                  .filter((entry) => entry.station !== stationName)
                  .filter(isRealActiveStation)
                  .map((entry) => {
                    const disabled = !isRealActiveStation(entry);
                    const selectedTile = transferTarget === entry.station;
                    return (
                      <button
                        key={entry.station}
                        type="button"
                        className={`station-tile${selectedTile ? " selected" : ""}`}
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          setTransferTarget(entry.station);
                        }}
                      >
                        <div className="tile-name">{entry.station}</div>
                        <div className="tile-sub">
                          Operatore:{" "}
                          <strong>{entry.operatorName || "Guest"}</strong>
                        </div>
                        <div className="tile-sub">
                          Stato:{" "}
                          <strong>{disabled ? "PAUSA" : "ONLINE"}</strong>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => setModal((m) => ({ ...m, transfer: false }))}
              >
                Annulla
              </button>
              <button
                className="modal-btn primary"
                type="button"
                disabled={!transferTargetAvailable || !selected}
                onClick={async () => {
                  if (!selected || !transferTargetAvailable) {
                    pushToast("La postazione di destinazione non e attiva");
                    return;
                  }
                  const ok = await requestOrForceTransfer(
                    selected,
                    transferTarget,
                    "transfer",
                  );
                  if (ok) {
                    setModal((m) => ({ ...m, transfer: false }));
                  }
                }}
              >
                Trasferisci
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.logoutConfirm ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            setPendingLogoutOptions(null);
            setModal((current) => ({ ...current, logoutConfirm: false }));
          }}
        >
          <div className="modal-card" style={{ width: "min(500px, 94vw)" }}>
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-right-from-bracket" /> Conferma logout
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() => {
                  setPendingLogoutOptions(null);
                  setModal((current) => ({ ...current, logoutConfirm: false }));
                }}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-hint">
                Vuoi disconnettere completamente questa postazione?
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => {
                  setPendingLogoutOptions(null);
                  setModal((current) => ({ ...current, logoutConfirm: false }));
                }}
              >
                Annulla
              </button>
              <button
                className="modal-btn danger"
                type="button"
                onClick={() =>
                  void doLogout({
                    ...(pendingLogoutOptions || {}),
                    confirmed: true,
                  })
                }
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.pauseTransfer ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            setModal((current) => ({ ...current, pauseTransfer: false }));
          }}
        >
          <div className="modal-card modal-pause-transfer">
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-circle-pause" /> Metti in pausa
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() =>
                  setModal((current) => ({ ...current, pauseTransfer: false }))
                }
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-hint" style={{ marginBottom: "12px" }}>
                Ci sono comande ancora in coda. Scegli dove trasferirle oppure
                mantienile nella coda virtuale.
              </div>
              <div className="station-grid">
                {pauseTransferCandidates.map((entry) => {
                  const station = normStation(entry.station);
                  const selectedTarget = station === pauseTransferTarget;
                  return (
                    <button
                      key={`${station}:${entry.deviceUuid || entry.operatorUserId || "session"}`}
                      type="button"
                      className={`station-tile${selectedTarget ? " selected" : ""}`}
                      onClick={() => setPauseTransferTarget(station)}
                    >
                      <div className="tile-name">{station}</div>
                      <div className="tile-sub">
                        Operatore:{" "}
                        <strong>
                          {entry.operatorName ||
                            entry.operatorUsername ||
                            "Operatore"}
                        </strong>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => void completeStationPause("suspend")}
              >
                Coda virtuale
              </button>
              <button
                className="modal-btn primary"
                type="button"
                disabled={
                  !pauseTransferCandidates.some(
                    (entry) =>
                      normStation(entry.station) === pauseTransferTarget,
                  )
                }
                onClick={() =>
                  void completeStationPause("transfer", pauseTransferTarget)
                }
              >
                Trasferisci coda
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.auth && pendingAuth ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) =>
            e.target === e.currentTarget &&
            setModal((m) => ({ ...m, auth: false }))
          }
        >
          <div className="modal-card" style={{ width: "min(560px,94vw)" }}>
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-shield-halved" /> Autorizzazione
                trasferimento
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() => setModal((m) => ({ ...m, auth: false }))}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-hint">
                La postazione <strong>{pendingAuth.toStation}</strong>{" "}
                (operatore: <strong>{pendingAuth.toOperator}</strong>) richiede
                la comanda <strong>#{pendingAuth.orderId}</strong>. Vuoi
                autorizzare il trasferimento?
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => void resolvePendingTransfer(false)}
              >
                Nega
              </button>
              <button
                className="modal-btn primary"
                type="button"
                onClick={() => void resolvePendingTransfer(true)}
              >
                Autorizza
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.print ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) =>
            e.target === e.currentTarget &&
            setModal((m) => ({ ...m, print: false }))
          }
        >
          <div className="modal-card modal-print">
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-print" /> Stampa
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() => setModal((m) => ({ ...m, print: false }))}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-hint" style={{ marginBottom: "12px" }}>
                Scegli cosa stampare per la comanda selezionata.
              </div>
              <div className="print-choice">
                <button
                  className="modal-btn primary"
                  type="button"
                  onClick={() => {
                    void printSelected("order");
                    setModal((m) => ({ ...m, print: false }));
                  }}
                >
                  Comanda
                </button>
                <button
                  className="modal-btn"
                  type="button"
                  onClick={() => {
                    void printSelected("preconto");
                    setModal((m) => ({ ...m, print: false }));
                  }}
                >
                  Preconto
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => setModal((m) => ({ ...m, print: false }))}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.catalog ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) =>
            e.target === e.currentTarget &&
            setModal((m) => ({ ...m, catalog: false }))
          }
        >
          <div className="modal-card modal-catalog is-scroll">
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-box" /> Articoli disponibili
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={() => setModal((m) => ({ ...m, catalog: false }))}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="catalog-tools">
                <div className="catalog-tools-row">
                  <div className="search-wrap compact">
                    <i className="fa-solid fa-magnifying-glass" />
                    <input
                      className="search-input"
                      placeholder="Cerca articolo..."
                      value={catalogQuery}
                      onChange={(event) => setCatalogQuery(event.target.value)}
                    />
                  </div>
                  <button
                    className="mini-btn catalog-temp-btn"
                    type="button"
                    onClick={() => openTempItemModal("")}
                  >
                    <i className="fa-solid fa-plus" /> Aggiungi temporaneo
                  </button>
                </div>
                <div className="modal-hint" style={{ margin: 0 }}>
                  Disabilita un articolo per comunicare ai camerieri che non e
                  ordinabile. Se l&apos;articolo e disponibile su piu postazioni
                  puoi scegliere se terminarlo solo qui o ovunque.
                </div>
              </div>

              <div className="catalog-header">
                <div>ARTICOLO</div>
                <div>DISPONIBILITA</div>
                <div>PREZZO</div>
                <div>STATO</div>
                <div>AZIONI</div>
              </div>

              <div className="catalog-list">
                {catalogGroups.categories.length === 0 ? (
                  <div className="modal-hint">Nessun articolo disponibile.</div>
                ) : (
                  catalogGroups.categories.map((category) => {
                    const rows = [
                      ...(catalogGroups.grouped[category] || []),
                    ].sort((left, right) =>
                      left.localeCompare(right, "it", { sensitivity: "base" }),
                    );
                    const isOpen =
                      catalogOpenCats[category] ??
                      keyName(catalogQuery).length > 0;
                    return (
                      <div
                        key={category}
                        className={`cat-block${isOpen ? " open" : ""}`}
                      >
                        <div
                          className="cat-head"
                          onClick={() => toggleCatalogCategory(category)}
                        >
                          <div className="cat-title">{category}</div>
                          <div className="cat-meta">
                            <span>{rows.length} articoli</span>
                            <i className="fa-solid fa-chevron-down" />
                          </div>
                        </div>
                        <div className="cat-items">
                          {rows.map((name) => {
                            const meta = findMenuItemByName(name);
                            const variants = Array.isArray(meta?.variants)
                              ? meta.variants
                                  .map((variant) => String(variant).trim())
                                  .filter(Boolean)
                              : [];
                            const variantsLabel = variants.length
                              ? variants.join(" / ")
                              : "";
                            const stations = menuStationsFor(name);
                            const isTemp = meta?.isTemp === true;
                            const disabledHere = isItemDisabledForStation(
                              name,
                              stationName,
                            );
                            const disabledEverywhere = disabledGlobalSet.has(
                              keyName(name),
                            );
                            const disabled = disabledHere || disabledEverywhere;
                            const statusLabel = disabled
                              ? "DISATTIVATO"
                              : "ATTIVO";
                            const qtyLabel =
                              isTemp &&
                              meta?.qtyRemaining != null &&
                              meta?.qtyRemaining !== ""
                                ? ` - QTA: ${meta.qtyRemaining}`
                                : "";
                            return (
                              <div key={name} className="catalog-row-grid">
                                <div
                                  className="catalog-cell"
                                  data-label="Articolo"
                                >
                                  <div className="catalog-name">
                                    {String(name || "").toUpperCase()}
                                  </div>
                                  {variantsLabel ? (
                                    <div className="catalog-variants">
                                      {variantsLabel}
                                    </div>
                                  ) : null}
                                  <div className="catalog-sub">
                                    {isTemp
                                      ? `Temporaneo${qtyLabel}`
                                      : "Listino"}
                                  </div>
                                </div>
                                <div
                                  className="catalog-cell catalog-avail"
                                  data-label="Disponibilita"
                                >
                                  {stations.join(", ")}
                                </div>
                                <div
                                  className="catalog-cell catalog-price"
                                  data-label="Prezzo"
                                >
                                  {fmtPrice(menuPriceFor(name))}
                                </div>
                                <div
                                  className="catalog-cell"
                                  data-label="Stato"
                                >
                                  <span
                                    className={`pill ${disabled ? "pill-bad" : "pill-ok"}`}
                                  >
                                    {statusLabel}
                                  </span>
                                </div>
                                <div
                                  className="catalog-cell catalog-actions"
                                  data-label="Azioni"
                                >
                                  <button
                                    className={`small-btn ${disabled ? "success" : "danger"}`}
                                    type="button"
                                    onClick={() => toggleCatalogItem(name)}
                                  >
                                    {disabled ? "ATTIVA" : "DISATTIVA"}
                                  </button>
                                  {isTemp ? (
                                    <>
                                      <button
                                        className="small-btn"
                                        type="button"
                                        onClick={() => openTempItemModal(name)}
                                      >
                                        MODIFICA
                                      </button>
                                      <button
                                        className="small-btn danger"
                                        type="button"
                                        onClick={() => deleteTempItem(name)}
                                      >
                                        RIMUOVI
                                      </button>
                                    </>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => setModal((m) => ({ ...m, catalog: false }))}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.scope && pendingDisableItem ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && closeScopeModal()}
        >
          <div className="modal-card" style={{ width: "min(520px,94vw)" }}>
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-ban" /> Disabilita articolo
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={closeScopeModal}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-hint">
                Articolo: <strong>{pendingDisableItem.toUpperCase()}</strong>
                <br />
                Scegli se e terminato solo per questa postazione o per tutte.
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={() => disableItemScope("local")}
              >
                Solo questa postazione
              </button>
              <button
                className="modal-btn danger"
                type="button"
                onClick={() => disableItemScope("global")}
              >
                Tutte le postazioni
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.tempItem ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && closeTempItemModal()}
        >
          <div className="modal-card modal-temp is-scroll">
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-tags" /> Articolo temporaneo
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={closeTempItemModal}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-row">
                <label className="modal-label">Nome articolo</label>
                <input
                  className="modal-input"
                  placeholder="Es: Negroni"
                  value={tempDraft.name}
                  onChange={(event) =>
                    setTempDraft((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="modal-row">
                <label className="modal-label">Prezzo</label>
                <div className="price-input">
                  <input
                    className="modal-input"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={tempDraft.price}
                    onChange={(event) =>
                      setTempDraft((prev) => ({
                        ...prev,
                        price: event.target.value,
                      }))
                    }
                  />
                  <span className="price-euro">EUR</span>
                </div>
              </div>
              <div className="modal-row">
                <label className="modal-label">Quantita (facoltativa)</label>
                <input
                  className="modal-input"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Es: 12"
                  value={tempDraft.qty}
                  onChange={(event) =>
                    setTempDraft((prev) => ({
                      ...prev,
                      qty: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="modal-row">
                <label className="modal-label">Disponibile su</label>
                <div className="stations-check">
                  {configuredStations.map((station) => {
                    const selectedStation =
                      tempDraft.stations.includes(station);
                    return (
                      <label key={station} className="chk">
                        <input
                          type="checkbox"
                          checked={selectedStation}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setTempDraft((prev) => {
                              const current = Array.isArray(prev.stations)
                                ? prev.stations
                                : [];
                              if (checked) {
                                return {
                                  ...prev,
                                  stations: [...new Set([...current, station])],
                                };
                              }
                              return {
                                ...prev,
                                stations: current.filter(
                                  (entry) => entry !== station,
                                ),
                              };
                            });
                          }}
                        />
                        <span>{station}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="modal-hint">
                {editingTempName
                  ? "Modifica articolo temporaneo."
                  : "Crea un articolo temporaneo valido su una o piu postazioni."}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn"
                type="button"
                onClick={closeTempItemModal}
              >
                Annulla
              </button>
              {editingTempName ? (
                <button
                  className="modal-btn danger"
                  type="button"
                  onClick={deleteTempItem}
                >
                  Rimuovi
                </button>
              ) : null}
              <button
                className="modal-btn primary"
                type="button"
                onClick={saveTempItem}
              >
                Salva
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal.notify && pendingNotify ? (
        <div
          className="modal-backdrop show"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && closeNotifyModal()}
        >
          <div className="modal-card" style={{ width: "min(520px,94vw)" }}>
            <div className="modal-head">
              <div className="modal-title">
                <i className="fa-solid fa-bell" /> Notifica
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Chiudi"
                onClick={closeNotifyModal}
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div
                className="modal-hint"
                dangerouslySetInnerHTML={{ __html: pendingNotify }}
              />
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn primary"
                type="button"
                onClick={ackNotify}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        className={`toast${toast.show ? " show" : ""}`}
        aria-live="polite"
        aria-atomic="true"
      >
        {toast.text}
      </div>
    </>
  );
}
