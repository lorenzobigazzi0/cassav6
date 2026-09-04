// app.js
// Bar Station Interface V2.3 (UI mockup)

const STATIONS = ["BAR PRINCIPALE", "COCKTAIL", "CAFFETTERIA", "BAR 2"];
const DEFAULT_WAITERS = [];
let WAITERS = [...DEFAULT_WAITERS];

// Mock: stato + operatore per ogni postazione (serve per la UI di trasferimento)
const stationsState = STATIONS.map((name, idx) => ({
	name,
	active: true,
	operatorName: idx === 0 ? "Guest" : (["Giulia", "Paolo", "Sara"][idx - 1] || "Operatore"),
	operatorRole: idx === 0 ? "Non autenticato" : "Barista"
}));

// Mock: catalogo articoli e disponibilita' per postazione
// Nota: "variants" e' opzionale. Se presente, indica le varianti selezionabili dall'ordine.
const MENU_ITEMS = [
	{ name: "Gin Tonic", stations: ["BAR PRINCIPALE", "COCKTAIL"], price: 8.00 },
	{ name: "Aperol Spritz", stations: ["BAR PRINCIPALE", "COCKTAIL"], price: 7.00 },
	{ name: "Spritz", stations: ["BAR PRINCIPALE", "COCKTAIL"], price: 7.00 },
	{ name: "Analcolico", stations: ["BAR PRINCIPALE", "COCKTAIL"], price: 6.00, variants: ["Dolce", "Secco"] },
	{ name: "Caffe'", stations: ["CAFFETTERIA"], price: 1.20 },
	{ name: "Cappuccino", stations: ["CAFFETTERIA"], price: 1.80 },
	{ name: "Cornetto", stations: ["CAFFETTERIA"], price: 1.50 },
	{ name: "Birra", stations: ["BAR PRINCIPALE", "BAR 2"], price: 4.50 }
];

// Persistenza: articoli temporanei (visibili da tutte le postazioni)
const LS_TEMP_ITEMS = "BAR_TEMP_MENU_V1";
const LS_DISABLED_GLOBAL = "BAR_DISABLED_GLOBAL_V1";
const LS_DISABLED_LOCAL = "BAR_DISABLED_LOCAL_V1";
const POSTAZIONE_ORDER_DONE_HISTORY_LIMIT = 8;

function loadJson(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return fallback;
		return JSON.parse(raw);
	} catch (_) { return fallback; }
}
function saveJson(key, value) {
	try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function normalizeName(s) { return String(s || "").trim(); }
function keyName(s) { return normalizeName(s).toLowerCase(); }
function normalizeStationName(value) {
	const station = String(value || "").trim();
	return STATIONS.includes(station) ? station : STATIONS[0];
}

function buildPostazioneOrdersPath() {
	const params = new URLSearchParams({
		includeDone: "1",
		includeTransferred: "1",
		doneHistoryLimit: String(POSTAZIONE_ORDER_DONE_HISTORY_LIMIT),
		station: normalizeStationName(state?.stationName),
		clientApp: "postazione",
	});
	const deviceUuid = String(getOrCreatePostazioneNotifyDevice() || "").trim();
	const fullName = String(state?.userName || "").trim();
	if (deviceUuid) params.set("deviceUuid", deviceUuid);
	if (fullName && fullName !== "Guest") params.set("fullName", fullName);
	return `/api/integration/orders?${params.toString()}`;
}

// ------------------------------------------------------------
// UUID helper (Android WebView / older Chrome compatibility)
// Some Android tablet builds do not support crypto.randomUUID().
// ------------------------------------------------------------
function safeUUID() {
	try {
		if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
			return globalThis.crypto.randomUUID();
		}
	} catch (_) {}
	// Fallback: RFC4122 v4-ish
	const bytes = new Uint8Array(16);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
	const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function loadTempItems() {
	const arr = loadJson(LS_TEMP_ITEMS, []);
	if (!Array.isArray(arr)) return [];
	// Sanitizzazione minima
	return arr
		.filter(x => x && typeof x === "object")
		.map(x => ({
			id: String(x.id || safeUUID()),
			name: normalizeName(x.name),
			stations: Array.isArray(x.stations) ? x.stations.map(String) : [...STATIONS],
			price: (x.price == null || x.price === "") ? null : Number(x.price),
			createdAtMs: Number(x.createdAtMs || Date.now())
		}))
		.filter(x => x.name.length > 0);
}
function saveTempItems(items) { saveJson(LS_TEMP_ITEMS, items); }

let tempMenuItems = loadTempItems();

function getAllMenuItems() {
	const all = [...MENU_ITEMS.map(x => ({...x, isTemp:false})), ...tempMenuItems.map(x => ({...x, isTemp:true}))];
	all.sort((a,b) => a.name.localeCompare(b.name, 'it', {sensitivity:'base'}));
	return all;
}

function findMenuItemByName(name) {
	const k = keyName(name);
	return getAllMenuItems().find(x => keyName(x.name) === k) || null;
}

function menuStationsFor(itemName) {
	const hit = findMenuItemByName(itemName);
	return hit ? hit.stations : [...STATIONS];
}

function menuPriceFor(itemName) {
	const hit = findMenuItemByName(itemName);
	return hit && typeof hit.price === 'number' && !Number.isNaN(hit.price) ? hit.price : null;
}

function menuVariantsFor(itemName) {
	const hit = findMenuItemByName(itemName);
	if (!hit) return [];
	if (!Array.isArray(hit.variants)) return [];
	return hit.variants.map(v => String(v).trim()).filter(v => v.length > 0);
}

// ------------------------------------------------------------
// Out-of-stock locale: se un articolo e' terminato SOLO per questa postazione
// e risulta disponibile su altri bar, inoltra automaticamente un parziale
// delle comande (solo le righe dell'articolo terminato) alle altre postazioni.
// Se non e' disponibile altrove, non crea parziali (solo notifica ai camerieri).
// ------------------------------------------------------------
function getStationsThatCanPrepareItem(itemName, excludeStation) {
	const stations = menuStationsFor(itemName)
		.filter(st => st !== excludeStation)
		.filter(st => isStationOnline(st))
		.filter(st => !isItemDisabledForStation(itemName, st));
	return stations;
}

function genPartialOrderId(parentId) {
	const rnd = Math.floor(100 + Math.random() * 900);
	return `${parentId}P${rnd}`;
}

function forwardPartialOrdersForLocalOutOfStock(itemName) {
	const targets = getStationsThatCanPrepareItem(itemName, state.stationName);
	if (!targets.length) {
		// Niente bar alternativi: informo solo i camerieri.
		queueAction({ type: 'notify_waiters_item_out', itemName, station: state.stationName });
		return;
	}

	let movedTotal = 0;
	let tIdx = 0;
	const k = keyName(itemName);

	// Sposta solo le righe NON ancora spuntate.
	orders
		.filter(o => o.station === state.stationName)
		.filter(o => computeStatus(o) !== 'done')
		.forEach(o => {
			const moved = o.items.filter(it => keyName(it.name) === k && !it.done);
			if (!moved.length) return;

			const target = targets[tIdx % targets.length];
			tIdx++;

			// Rimuovo dal padre le righe spostate
			o.items = o.items.filter(it => !(keyName(it.name) === k && !it.done));

			// Creo una comanda parziale sulla postazione target
			const partial = {
				id: genPartialOrderId(o.id),
				station: target,
				table: o.table,
				tableId: String(o.tableId || ""),
				tableNumber: Number.isFinite(Number(o.tableNumber)) ? Math.max(0, Math.trunc(Number(o.tableNumber))) : Number(o.table) || 0,
				roomId: String(o.roomId || ""),
				roomName: String(o.roomName || ""),
				waiter: o.waiter,
				covers: o.covers,
				apericena: o.apericena,
				note: o.note,
				communications: o.communications || '',
				receivedAtMs: nowMs(),
				workflowStatus: 'waiting',
				items: moved.map(x => ({
					name: x.name,
					variant: x.variant || '',
					note: x.note || '',
					done: false
				})),
				parentOrderId: o.id,
				isPartial: true,
				transferredFromStation: state.stationName,
				ownerStation: null,
				ownerOperator: null,
				ownerRole: null,
				ownerAtMs: null,
				completedAtMs: null
			};
			orders.push(partial);
			movedTotal += moved.length;

			queueAction({
				type: 'order_partial_transfer',
				fromStation: state.stationName,
				toStation: target,
				parentOrderId: o.id,
				orderId: partial.id,
				itemName,
				itemsCount: moved.length
			});
		});

	if (movedTotal > 0) {
		toast(`Parziale inoltrato: ${itemName} → ${targets.join(', ')}`);
		// Aggiorno la UI per riflettere le righe rimosse.
		renderOrdersFull();
		updateSelectedCard();
		renderDetails();
	}
}

// Stato disabilitazione articoli
const disabledGlobal = new Set(); // itemName (case-insensitive stored as lower)
const disabledLocal = {}; // stationName -> Set(lower)

// Flag controllati dal server (mock).
// allowTransferWaiting: se true, e' consentito trasferire (richiedere/autorizzare) anche comande in ATTESA.
const SERVER_FLAGS = {
	allowTransferWaiting: false
};

// ------------------------------------------------------------
// Server-ready hooks (opzionali)
	// - Se esiste un backend, puoi impostare window.API_BASE (es. "http://localhost:8000")
	// - Le chiamate falliscono in modo silenzioso e la UI resta in modalita' standalone.
	// ------------------------------------------------------------
	function resolveApiBase() {
		try {
			if (typeof window !== "undefined" && typeof window.API_BASE === "string" && window.API_BASE.trim()) {
			return window.API_BASE.trim();
		}
		if (typeof window !== "undefined") {
				const params = new URLSearchParams(window.location.search || "");
				const fromQuery = String(params.get("apiBase") || "").trim();
				if (fromQuery) return fromQuery;
			}
			const fromStorage = String(loadJson("BAR_API_BASE_URL", "") || "").trim();
			if (fromStorage) return fromStorage;
			if (typeof window !== "undefined") {
				const origin = String(window.location.origin || "").trim();
				if (origin) return origin;
			}
		} catch (_) {}
		return "";
	}

let API_BASE = resolveApiBase();
if (typeof window !== "undefined") {
	window.API_BASE = API_BASE;
}
const API_BASE_FALLBACKS = (() => {
	const candidates = [];
	try {
			if (typeof window !== "undefined") {
				const host = String(window.location.hostname || "").trim();
				const origin = String(window.location.origin || "").trim();
				if (origin) candidates.push(origin);
				if (host) {
					const protocol = window.location.protocol === "https:" ? "https:" : "http:";
					candidates.push(`${protocol}//${host}:5381`);
				}
			}
		} catch (_) {}
		candidates.push("http://localhost:5381", "http://127.0.0.1:5381");
	const unique = [];
	const seen = new Set();
	[...candidates].forEach((entry) => {
		const key = String(entry || "").trim();
		if (!key || key === API_BASE || seen.has(key)) return;
		seen.add(key);
		unique.push(key);
	});
	return unique;
})();
try {
	console.info("[postazione] API_BASE:", API_BASE);
} catch (_) {}
const LS_POSTAZIONE_NOTIFY_DEVICE = "BAR_NOTIFY_DEVICE_V1";
const LS_POSTAZIONE_OPERATOR_SESSION = "BAR_OPERATOR_SESSION_V1";
const LS_POSTAZIONE_STATION = "BAR_POSTAZIONE_STATION_V1";
let integrationOrdersFingerprint = "";
let integrationMenuFingerprint = "";
let integrationWaitersFingerprint = "";
let integrationLayoutFingerprint = "";
const integrationTablesById = new Map();
const integrationTablesByNumber = new Map();
if (typeof window !== "undefined" && !window.__postazioneOrdersSync) {
	window.__postazioneOrdersSync = {
		ok: true,
		totalOrders: 0,
		activeOrders: 0,
		visibleOrders: 0,
		lastAtMs: 0,
		lastError: "",
		apiBase: API_BASE
	};
}

function loadPersistedStationName() {
	return normalizeStationName(loadJson(LS_POSTAZIONE_STATION, STATIONS[0]));
}

function persistStationName() {
	saveJson(LS_POSTAZIONE_STATION, normalizeStationName(state?.stationName));
}

function loadPersistedOperatorSession() {
	const payload = loadJson(LS_POSTAZIONE_OPERATOR_SESSION, null);
	if (!payload || typeof payload !== "object") {
		return { loggedIn: false, userName: "Guest", userRole: "Non autenticato" };
	}
	const loggedIn = payload.loggedIn === true;
	const userName = String(payload.userName || "").trim();
	const userRole = String(payload.userRole || "").trim();
	if (!loggedIn || !userName) {
		return { loggedIn: false, userName: "Guest", userRole: "Non autenticato" };
	}
	return {
		loggedIn: true,
		userName: userName.slice(0, 64),
		userRole: userRole || "Operatore"
	};
}

function persistOperatorSessionState() {
	saveJson(LS_POSTAZIONE_OPERATOR_SESSION, {
		loggedIn: state.loggedIn === true,
		userName: String(state.userName || ""),
		userRole: String(state.userRole || "")
	});
}

function getOrCreatePostazioneNotifyDevice() {
	const existing = String(loadJson(LS_POSTAZIONE_NOTIFY_DEVICE, "") || "").trim();
	if (existing) return existing;
	const generated = safeUUID();
	saveJson(LS_POSTAZIONE_NOTIFY_DEVICE, generated);
	return generated;
}

function buildPostazioneNotificationConsumer() {
	const station = String(state?.stationName || "BAR PRINCIPALE")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "") || "bar_principale";
	const device = getOrCreatePostazioneNotifyDevice().slice(0, 12).toLowerCase();
	return `postazione:${station}:${device}`;
}

async function apiFetchJson(path, opts = {}) {
	if (!API_BASE) return null;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 6000);
	try {
		const method = String(opts.method || "GET").trim().toUpperCase();
		const bases = [API_BASE, ...API_BASE_FALLBACKS].filter(Boolean);
		for (const base of bases) {
			try {
				const r = await fetch(base + path, {
					...opts,
					cache: method === "GET" ? "no-store" : (opts.cache || "no-store"),
					signal: ctrl.signal,
					headers: {
						"Content-Type": "application/json",
						...(opts.headers || {})
					}
				});
				if (!r.ok) {
					// Se endpoint non trovato/problema host, provo fallback successivo.
					continue;
				}
				if (base !== API_BASE) {
					API_BASE = base;
					if (typeof window !== "undefined") {
						window.API_BASE = base;
					}
					saveJson("BAR_API_BASE_URL", base);
					try {
						console.info("[postazione] API_BASE fallback attivato:", base);
					} catch (_) {}
				}
				return await r.json();
			} catch (_) {
				// continua con base successivo
			}
		}
		return null;
	} catch (_) {
		return null;
	} finally {
		clearTimeout(t);
	}
}

async function apiRefreshFlags() {
	const j = await apiFetchJson("/api/flags", { method: "GET" });
	if (!j || typeof j !== "object") return;
	if (typeof j.allowTransferWaiting === "boolean") SERVER_FLAGS.allowTransferWaiting = j.allowTransferWaiting;
}

function toTitleCaseWords(value) {
	return String(value || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(part => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

function fallbackRoomNameFromId(roomId) {
	const cleaned = String(roomId || "")
		.trim()
		.replace(/^sala[_-]?/i, "")
		.replace(/^room[_-]?/i, "")
		.replace(/[_-]+/g, " ");
	const titled = toTitleCaseWords(cleaned);
	if (!titled) return "";
	return titled.toLowerCase().startsWith("sala") ? titled : `Sala ${titled}`;
}

function normalizeIncomingLayoutTable(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = String(raw.id || "").trim();
	const roomId = String(raw.roomId || "").trim();
	const roomName = String(raw.roomName || "").trim();
	const number = Number.isFinite(Number(raw.number)) ? Math.max(0, Math.trunc(Number(raw.number))) : 0;
	if (!id) return null;
	return {
		id,
		number,
		roomId,
		roomName
	};
}

function replaceIntegrationLayoutIndex(tables) {
	integrationTablesById.clear();
	integrationTablesByNumber.clear();
	tables.forEach(table => {
		if (!table || !table.id) return;
		integrationTablesById.set(table.id, table);
		const key = table.number > 0 ? table.number : 0;
		const bucket = integrationTablesByNumber.get(key) || [];
		bucket.push(table);
		integrationTablesByNumber.set(key, bucket);
	});
}

async function syncLayoutFromBackend() {
	const payload = await apiFetchJson("/api/integration/layout", { method: "GET" });
	if (!payload || !Array.isArray(payload.tables)) return false;
	const tables = payload.tables
		.map(normalizeIncomingLayoutTable)
		.filter(Boolean);
	if (!tables.length) return false;
	const fingerprint = JSON.stringify(tables);
	if (fingerprint === integrationLayoutFingerprint) return true;
	integrationLayoutFingerprint = fingerprint;
	replaceIntegrationLayoutIndex(tables);
	return true;
}

function resolveOrderLayoutMeta(rawOrder) {
	const tableId = String(rawOrder?.tableId || "").trim();
	const directTableNumber = Number(rawOrder?.tableNumber ?? rawOrder?.table);
	let tableNumber = Number.isFinite(directTableNumber) ? Math.max(0, Math.trunc(directTableNumber)) : 0;
	let roomId = String(rawOrder?.roomId || "").trim();
	let roomName = String(rawOrder?.roomName || "").trim();

	const tableById = tableId ? integrationTablesById.get(tableId) : null;
	if (tableById) {
		if (tableNumber <= 0 && tableById.number > 0) tableNumber = tableById.number;
		if (!roomId && tableById.roomId) roomId = tableById.roomId;
		if (!roomName && tableById.roomName) roomName = tableById.roomName;
	}

	if (tableNumber > 0) {
		const candidates = integrationTablesByNumber.get(tableNumber) || [];
		let byNumber = null;
		if (roomId) {
			byNumber = candidates.find(entry => entry.roomId === roomId) || null;
		}
		if (!byNumber && tableId) {
			byNumber = candidates.find(entry => entry.id === tableId) || null;
		}
		if (!byNumber && candidates.length === 1) {
			byNumber = candidates[0];
		}
		if (byNumber) {
			if (!roomId && byNumber.roomId) roomId = byNumber.roomId;
			if (!roomName && byNumber.roomName) roomName = byNumber.roomName;
		}
	}

	if (!roomName && roomId) {
		roomName = fallbackRoomNameFromId(roomId);
	}

	return {
		tableId,
		tableNumber,
		roomId,
		roomName
	};
}

function buildOrderRoomLabel(order) {
	const meta = resolveOrderLayoutMeta(order);
	return meta.roomName || "";
}

function buildOrderTableLabel(order) {
	const meta = resolveOrderLayoutMeta(order);
	if (meta.tableNumber > 0) return String(meta.tableNumber);
	const fallback = Number(order?.table);
	return Number.isFinite(fallback) && fallback > 0 ? String(Math.trunc(fallback)) : "-";
}

function isOrderForCurrentStation(order) {
	if (!order || typeof order !== "object") return false;
	if (order.broadcastToAllStations === true) return true;
	return String(order.station || "") === String(state?.stationName || "");
}

function toMsOrNull(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function normalizeIncomingOrder(raw) {
	if (!raw || typeof raw !== "object") return null;
	const safeItems = Array.isArray(raw.items)
		? raw.items
			.filter(it => it && typeof it === "object")
			.map((it, idx) => ({
				id: String(it.id || `i${idx + 1}`),
				name: String(it.name || "Articolo"),
				variant: String(it.variant || it.variantName || ""),
				note: String(it.note || ""),
				done: !!it.done
			}))
		: [];
	const layoutMeta = resolveOrderLayoutMeta(raw);
	const tableValue =
		layoutMeta.tableNumber > 0
			? layoutMeta.tableNumber
			: Number.isFinite(Number(raw.table))
				? Math.max(0, Math.trunc(Number(raw.table)))
				: 0;
	const workflowRaw = String(raw.workflowStatus || "waiting").trim().toLowerCase();
	const workflowStatus =
		workflowRaw === "done" || workflowRaw === "delivered" || workflowRaw === "consegnato"
			? "delivered"
			: workflowRaw === "ready" || workflowRaw === "da consegnare" || workflowRaw === "da_consegnare"
				? "ready"
				: workflowRaw === "prep" || workflowRaw === "in preparazione" || workflowRaw === "in_preparazione"
					? "prep"
					: "waiting";
	const source = String(raw.source || "").trim().toLowerCase();

	return {
		id: String(raw.id || safeUUID()),
		table: tableValue,
		tableId: layoutMeta.tableId,
		tableNumber: layoutMeta.tableNumber > 0 ? layoutMeta.tableNumber : tableValue,
		roomId: layoutMeta.roomId,
		roomName: layoutMeta.roomName,
		waiter: String(raw.waiter || "Cameriere"),
		covers: Number.isFinite(Number(raw.covers)) ? Math.max(0, Math.floor(Number(raw.covers))) : 0,
		apericena: Number.isFinite(Number(raw.apericena)) ? Math.max(0, Math.floor(Number(raw.apericena))) : 0,
		note: String(raw.note || ""),
		communications: String(raw.communications || ""),
		receivedAtMs: toMsOrNull(raw.receivedAtMs) ?? Date.now(),
		completedAtMs: toMsOrNull(raw.completedAtMs),
		station: String(raw.station || "BAR PRINCIPALE"),
		ownerStation: raw.ownerStation ? String(raw.ownerStation) : null,
		ownerOperator: raw.ownerOperator ? String(raw.ownerOperator) : null,
		ownerRole: raw.ownerRole ? String(raw.ownerRole) : null,
		ownerAtMs: toMsOrNull(raw.ownerAtMs),
		workflowStatus,
		items: safeItems,
		parentOrderId: raw.parentOrderId ? String(raw.parentOrderId) : null,
		isPartial: !!raw.isPartial,
			broadcastToAllStations: raw.broadcastToAllStations === true,
		transferredFromStation: raw.transferredFromStation ? String(raw.transferredFromStation) : null,
		transferredToStation: raw.transferredToStation ? String(raw.transferredToStation) : null,
		transferredAtMs: toMsOrNull(raw.transferredAtMs),
		pendingAuthRequest: raw.pendingAuthRequest && typeof raw.pendingAuthRequest === "object"
			? {
				orderId: String(raw.pendingAuthRequest.orderId || String(raw.id || "")),
				fromStation: String(raw.pendingAuthRequest.fromStation || ""),
				toStation: String(raw.pendingAuthRequest.toStation || ""),
				toOperator: String(raw.pendingAuthRequest.toOperator || ""),
				requestedAtMs: toMsOrNull(raw.pendingAuthRequest.requestedAtMs) ?? Date.now(),
				mode: "takeover",
				shownToOwner: !!raw.pendingAuthRequest.shownToOwner
			}
			: null,
		source,
		updatedAt: raw.updatedAt ? String(raw.updatedAt) : ""
	};
}

function normalizeIncomingMenuItem(raw) {
	if (!raw || typeof raw !== "object") return null;
	const name = String(raw.name || "").trim();
	if (!name) return null;
	const price = Number(raw.price);
	const stations = Array.isArray(raw.stations)
		? raw.stations.map(String).map(s => s.trim()).filter(Boolean)
		: [];
	const variants = Array.isArray(raw.variants)
		? raw.variants.map(String).map(v => v.trim()).filter(Boolean)
		: [];
	return {
		name,
		price: Number.isFinite(price) ? Number(price) : 0,
		stations: stations.length ? stations : ["BAR PRINCIPALE"],
		variants
	};
}

function buildWaiterBadge(fullName, fallback = "CM") {
	const parts = String(fullName || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!parts.length) return fallback;
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function normalizeIncomingWaiter(raw, index) {
	if (!raw || typeof raw !== "object") return null;
	const fullName = String(raw.fullName || raw.name || raw.username || "").trim();
	if (!fullName) return null;
	const safeName = fullName.slice(0, 32);
	const fallback = String(index + 1).padStart(2, "0");
	const username = String(raw.username || "").trim();
	const userId = String(raw.userId || "").trim();
	const clientApp = String(raw.clientApp || "").trim().toLowerCase();
	return {
		id: buildWaiterBadge(safeName, fallback),
		name: safeName,
		username,
		userId,
		clientApp
	};
}

async function syncWaitersFromBackend(options = {}) {
	const payload = await apiFetchJson(
		"/api/integration/waiters?source=mobile-frontend&activeMs=90000",
		{ method: "GET" }
	);
	if (!payload || !Array.isArray(payload.waiters)) return false;
	const nextWaiters = payload.waiters
		.filter((raw) => {
			if (!raw || typeof raw !== "object") return false;
			const app = String(raw.clientApp || "").trim().toLowerCase();
			// I palmari vengono normalizzati dal backend come mobile-frontend.
			return (
				(app === "mobile-frontend" || app === "pos-frontend") &&
				raw.online !== false &&
				raw.activeNow !== false
			);
		})
		.map(normalizeIncomingWaiter)
		.filter(Boolean);
	const normalized = nextWaiters.length ? nextWaiters : [];
	const fingerprint = JSON.stringify(normalized);
	if (fingerprint === integrationWaitersFingerprint) return true;
	integrationWaitersFingerprint = fingerprint;
	WAITERS = normalized;
	if (options.render !== false && typeof renderWaiters === "function") {
		renderWaiters();
	}
	return true;
}

async function syncMenuFromBackend() {
	const payload = await apiFetchJson("/api/integration/menu", { method: "GET" });
	if (!payload || !Array.isArray(payload.postazioneItems)) return false;
	const nextItems = payload.postazioneItems
		.map(normalizeIncomingMenuItem)
		.filter(Boolean);
	if (!nextItems.length) return false;
	const fingerprint = JSON.stringify(nextItems);
	if (fingerprint === integrationMenuFingerprint) return true;
	integrationMenuFingerprint = fingerprint;
	MENU_ITEMS.length = 0;
	nextItems.forEach(item => {
		MENU_ITEMS.push({
			name: item.name,
			stations: item.stations,
			price: item.price,
			variants: item.variants
		});
	});
	return true;
}

function maybeAutoSelectStationFromOrders(nextOrders) {
	if (!Array.isArray(nextOrders) || nextOrders.length === 0) return false;
	const currentStation = normalizeStationName(state.stationName);
	let currentStationOrders = 0;
	const weightsByStation = new Map();

	nextOrders.forEach(order => {
		const station = normalizeStationName(order?.station);
		const workflowStatus = String(order?.workflowStatus || "waiting").toLowerCase();
		const weight =
			workflowStatus === "done" || workflowStatus === "delivered" || workflowStatus === "ready"
				? 0.2
				: 1;
		weightsByStation.set(station, (weightsByStation.get(station) || 0) + weight);
		if (station === currentStation) {
			currentStationOrders += 1;
		}
	});

	if (currentStationOrders > 0 || weightsByStation.size === 0) return false;

	if (weightsByStation.size === 1) {
		const onlyStation = [...weightsByStation.keys()][0];
		if (onlyStation && onlyStation !== currentStation) {
			state.stationName = onlyStation;
			persistStationName();
			return true;
		}
		return false;
	}

	// Non sovrascrivere la selezione utente, tranne il default iniziale.
	if (currentStation !== STATIONS[0]) return false;

	let bestStation = "";
	let bestWeight = -1;
	STATIONS.forEach(station => {
		const weight = Number(weightsByStation.get(station) || 0);
		if (weight > bestWeight) {
			bestStation = station;
			bestWeight = weight;
		}
	});

	if (!bestStation || bestStation === currentStation) return false;
	state.stationName = bestStation;
	persistStationName();
	return true;
}

async function syncOrdersFromBackend(options = {}) {
	await syncLayoutFromBackend();
	const payload = await apiFetchJson(
		buildPostazioneOrdersPath(),
		{ method: "GET" }
	);
	if (!payload || !Array.isArray(payload.orders)) {
		if (typeof window !== "undefined") {
			window.__postazioneOrdersSync = {
				ok: false,
				totalOrders: 0,
				activeOrders: 0,
				visibleOrders: 0,
				lastAtMs: Date.now(),
				lastError: "sync ordini non disponibile",
				apiBase: API_BASE
			};
		}
		return false;
	}
	const nextOrders = payload.orders
		.map(normalizeIncomingOrder)
		.filter(Boolean)
		.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
	const activeCount = nextOrders.filter((order) => {
		const workflow = String(order?.workflowStatus || "").trim().toLowerCase();
		const completed = Number.isFinite(Number(order?.completedAtMs)) && Number(order.completedAtMs) > 0;
		const delivered = workflow === "delivered" || workflow === "done" || workflow === "consegnato";
		const ready = workflow === "ready" || workflow === "da consegnare" || workflow === "da_consegnare";
		return !completed && !delivered && !ready;
	}).length;
	let visibleCount = 0;
	try {
		if (typeof getVisibleOrdersForStation === "function") {
			const prevOrders = orders;
			orders = nextOrders;
			visibleCount = getVisibleOrdersForStation().length;
			orders = prevOrders;
		}
	} catch (_) {
		visibleCount = 0;
	}
	if (typeof window !== "undefined") {
		window.__postazioneOrdersSync = {
			ok: true,
			totalOrders: nextOrders.length,
			activeOrders: activeCount,
			visibleOrders: visibleCount,
			lastAtMs: Date.now(),
			lastError: "",
			apiBase: API_BASE
		};
	}
	const stationAutoChanged = maybeAutoSelectStationFromOrders(nextOrders);
	const fingerprint = JSON.stringify(
		nextOrders.map(o => ({
			id: o.id,
			status: o.workflowStatus,
			done: o.items.map(it => !!it.done),
			station: o.station,
			table: o.table,
			roomId: o.roomId || "",
			roomName: o.roomName || "",
			owner: o.ownerStation,
			updatedAt: o.updatedAt || o.completedAtMs || o.receivedAtMs
		}))
	);
	const hasOrdersChanged = fingerprint !== integrationOrdersFingerprint;
	if (!hasOrdersChanged && !stationAutoChanged) return true;
	if (hasOrdersChanged) {
		integrationOrdersFingerprint = fingerprint;
		orders = nextOrders;
		if (state.selectedOrderId && !orders.find(o => o.id === state.selectedOrderId)) {
			state.selectedOrderId = null;
		}
	}
	if (options.render !== false && typeof renderAll === "function") {
		renderAll();
	}
	if (stationAutoChanged && typeof syncStationNotificationsFromBackend === "function") {
		void syncStationNotificationsFromBackend();
	}
	return true;
}

async function syncOrderToBackend(order) {
	if (!order || !order.id) return false;
	const meta = resolveOrderLayoutMeta(order);
	const normalizedTable =
		meta.tableNumber > 0
			? meta.tableNumber
			: Number.isFinite(Number(order.table))
				? Math.max(0, Math.trunc(Number(order.table)))
				: 0;
	order.table = normalizedTable;
	order.tableNumber = meta.tableNumber > 0 ? meta.tableNumber : normalizedTable;
	order.tableId = meta.tableId;
	order.roomId = meta.roomId;
	order.roomName = meta.roomName;
	const payload = {
		id: String(order.id),
		order
	};
	const res = await apiFetchJson("/api/integration/orders/sync", {
		method: "POST",
		body: JSON.stringify(payload)
	});
	return !!res;
}

async function publishIntegrationNotification(type, title, description, meta = {}) {
	const safeType = ["waiter", "bell", "general"].includes(String(type)) ? String(type) : "general";
	const payload = {
		type: safeType,
		title: String(title || "").trim(),
		description: String(description || "").trim(),
		meta: meta && typeof meta === "object" ? meta : {}
	};
	const res = await apiFetchJson("/api/integration/notifications/publish", {
		method: "POST",
		body: JSON.stringify(payload)
	});
	return !!res;
}

async function ackStationNotification(id, consumer) {
	const safeId = String(id || "").trim();
	if (!safeId) return;
	await apiFetchJson("/api/integration/notifications/ack", {
		method: "POST",
		body: JSON.stringify({
			id: safeId,
			consumer,
			action: "delete",
			clientApp: "postazione",
			station: String(state.stationName || "BAR PRINCIPALE"),
		}),
	});
}

async function syncStationNotificationsFromBackend() {
	const consumer = buildPostazioneNotificationConsumer();
	const station = encodeURIComponent(String(state.stationName || "BAR PRINCIPALE"));
	const path =
		`/api/integration/notifications/pull?consumer=${encodeURIComponent(consumer)}` +
		`&clientApp=postazione&station=${station}`;
	const payload = await apiFetchJson(path, { method: "GET" });
	if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return false;

	for (const raw of payload.items) {
		if (!raw || typeof raw !== "object") continue;
		const id = String(raw.id || "").trim();
		const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
		const eventType = String(meta.eventType || "").trim().toLowerCase();
		if (eventType === "waiter_ack") {
			const waiterName = String(meta.waiter || "").trim();
			toast(waiterName ? `${waiterName} sta arrivando...` : "Il cameriere sta arrivando...", 3200);
		}
		if (eventType === "bell_ack_pickup") {
			const waiterName = String(meta.waiter || "").trim();
			const orderId = String(meta.orderId || "").trim();
			if (waiterName && orderId) {
				toast(`${waiterName} ritira ${orderId}`, 3200);
			} else if (waiterName) {
				toast(`${waiterName} ritira la comanda`, 3200);
			} else if (orderId) {
				toast(`Comanda ${orderId} ritirata`, 3200);
			} else {
				toast("Comanda ritirata", 3200);
			}
		}
		if (id) {
			await ackStationNotification(id, consumer);
		}
	}
	return true;
}


function getTempItemByName(name) {
	const k = keyName(name);
	return tempMenuItems.find(x => keyName(x.name) === k) || null;
}

function isItemSoldOutByQty(itemName) {
	const t = getTempItemByName(itemName);
	if (!t) return false;
	if (t.qtyRemaining == null) return false;
	return Number(t.qtyRemaining) <= 0;
}
function isItemDisabledForStation(itemName, stationName) {
	const k = keyName(itemName);
	if (disabledGlobal.has(k)) return true;
	if (isItemSoldOutByQty(itemName)) return true;
	const set = disabledLocal[stationName];
	if (set && set.has(k)) return true;
	return false;
}


function loadDisabledState() {
	// Global
	const g = loadJson(LS_DISABLED_GLOBAL, []);
	if (Array.isArray(g)) g.forEach(x => { if (x) disabledGlobal.add(String(x).toLowerCase()); });
	// Local per postazione
	const l = loadJson(LS_DISABLED_LOCAL, {});
	if (l && typeof l === 'object') {
		Object.keys(l).forEach(st => {
			if (!Array.isArray(l[st])) return;
			const set = new Set();
			l[st].forEach(x => { if (x) set.add(String(x).toLowerCase()); });
			disabledLocal[st] = set;
		});
	}
}

function persistDisabledState() {
	saveJson(LS_DISABLED_GLOBAL, [...disabledGlobal]);
	const out = {};
	Object.keys(disabledLocal).forEach(st => { out[st] = [...disabledLocal[st]]; });
	saveJson(LS_DISABLED_LOCAL, out);
}

// ------------------------------------------------------------
// Offline queue azioni (notifiche/comunicazioni)
// - Se offline: lavori comunque; le azioni vanno in coda
// - Quando torni online: flush automatico
// ------------------------------------------------------------
const LS_ACTION_QUEUE = "BAR_ACTION_QUEUE_V1";
let actionQueue = loadJson(LS_ACTION_QUEUE, []);
if (!Array.isArray(actionQueue)) actionQueue = [];

function persistActionQueue() { saveJson(LS_ACTION_QUEUE, actionQueue); }

function setOnlineUI(isOnline) {
	const pill = $("systemPill");
	const dot = $("systemDot");
	const text = $("systemText");
	if (!pill || !dot || !text) return;
	if (isOnline) {
		pill.classList.remove('offline');
		text.textContent = 'ONLINE';
	} else {
		pill.classList.add('offline');
		text.textContent = 'OFFLINE';
		toast('OFFLINE: notifiche e comunicazioni non disponibili. Le azioni verranno inviate appena torni ONLINE.');
	}
}

async function trySendAction(action) {
	if (!API_BASE) return true; // standalone: considero sincronizzata
	const res = await apiFetchJson('/api/actions', { method: 'POST', body: JSON.stringify(action) });
	return !!res; // se null -> fallita
}

function queueAction(action) {
	actionQueue.push({ ...action, queuedAtMs: nowMs() });
	persistActionQueue();
	// Se online, provo subito
	if (navigator.onLine) {
		flushActionQueue();
	}
}

let flushing = false;
async function flushActionQueue() {
	if (flushing) return;
	if (!navigator.onLine) return;
	if (!actionQueue.length) return;
	flushing = true;
	try {
		const remaining = [];
		for (const a of actionQueue) {
			const ok = await trySendAction(a);
			if (!ok) remaining.push(a);
		}
		actionQueue = remaining;
		persistActionQueue();
	} finally {
		flushing = false;
	}
}

window.addEventListener('online', () => { setOnlineUI(true); flushActionQueue(); });
window.addEventListener('offline', () => { setOnlineUI(false); });

let orders = [];
const persistedOperatorSession = loadPersistedOperatorSession();

const state = {
	stationActive: true,
	stationName: loadPersistedStationName(),
	darkMode: false,
	loggedIn: persistedOperatorSession.loggedIn,
	userName: persistedOperatorSession.userName,
	userRole: persistedOperatorSession.userRole,
	selectedOrderId: null,
	showDone: false,
	searchQuery: "",
	catalogQuery: "",
	catalogOpenCats: {},
	showTransferredHistory: false,
	editingTempName: null,
	pendingDisableItem: null,
	pendingTransferTarget: null,
	pendingAuth: null,
	pendingNotify: null,
	callMode: "waiter" // "waiter" | "recall"
};
persistStationName();

// Notifiche "post-pausa" (durano 60 minuti). Key: stationName -> array
const pauseNotifications = {};

function nowMs() { return Date.now(); }

function setOwner(order, stationName) {
	order.ownerStation = stationName;
	order.ownerOperator = state.loggedIn ? state.userName : "Guest";
	order.ownerRole = state.loggedIn ? state.userRole : "Non autenticato";
	order.ownerAtMs = nowMs();
}

function releaseOwner(order) {
	if (!order) return;
	order.ownerStation = null;
	order.ownerOperator = null;
	order.ownerRole = null;
	order.ownerAtMs = null;
}

function ownerLabel(order) {
	if (!order || !order.ownerStation) return "-";
	const op = order.ownerOperator || "Operatore";
	return `${op} - ${order.ownerStation}`;
}
