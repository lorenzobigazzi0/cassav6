(function () {
  if (window.__mobileTableGroupsBridgeInstalled === true) return;
  window.__mobileTableGroupsBridgeInstalled = true;

  const GROUPS_URL = "/api/integration/table-groups";
  const SAVE_URL = "/api/integration/table-groups/save";
  const MOVE_URL = "/api/integration/layout/table/move";
  const TABLE_SYNC_URL = "/api/integration/layout/table/sync";
  const ROOMS_URL = "/api/pos/rooms";
  const ROOM_CHANGE_URL = "/api/pos/room-change/request";
  const ROOM_MOVE_REQUEST_URL = "/api/integration/layout/table/room-move/request";
  const ROOM_MOVE_STATUS_URL = "/api/integration/layout/table/room-move/status";
  const ROOM_MOVE_PENDING_URL = "/api/integration/layout/table/room-move/pending";
  const ROOM_MOVE_RESOLVE_URL = "/api/integration/layout/table/room-move/resolve";
  const LONG_PRESS_MS = 560;
  const ROOM_MOVE_POLL_MS = 2500;
  const AUTH_KEYS = {
    token: "pos_token",
    userId: "pos_user_id",
    username: "pos_user",
    fullName: "pos_full_name",
    role: "pos_role",
    deviceUuid: "pos_device_uuid",
    roomId: "pos_room_id",
    roomName: "pos_room_name",
  };
  const originalFetch = window.fetch.bind(window);
  const state = {
    groups: [],
    groupsLoading: null,
    rooms: [],
    roomsLoading: null,
    layout: null,
    transformedLayout: null,
    tileMap: new WeakMap(),
    queued: false,
    modal: null,
    suppressClickUntil: 0,
    pendingPoll: null,
    activeApprovalRequestId: "",
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function safeText(value) {
    return String(value ?? "").trim();
  }

  function escapeHtml(value) {
    return safeText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function readStorage(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null) return value;
    } catch {
      // noop
    }
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
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

  function readPreferenceMap() {
    try {
      const parsed = JSON.parse(readStorage("pos_last_room_by_user") || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writePreferenceMap(map) {
    writeStorage("pos_last_room_by_user", JSON.stringify(map || {}));
  }

  function getAuth() {
    return {
      token: safeText(readStorage(AUTH_KEYS.token)),
      userId: safeText(readStorage(AUTH_KEYS.userId)),
      username: safeText(readStorage(AUTH_KEYS.username)),
      fullName: safeText(readStorage(AUTH_KEYS.fullName)),
      role: safeText(readStorage(AUTH_KEYS.role)).toLowerCase(),
      deviceUuid: safeText(readStorage(AUTH_KEYS.deviceUuid)),
      roomId: safeText(readStorage(AUTH_KEYS.roomId)),
      roomName: safeText(readStorage(AUTH_KEYS.roomName)),
    };
  }

  function setCurrentRoom(room) {
    const roomId = safeText(room && (room.id || room.roomId));
    const roomName = safeText(room && (room.name || room.roomName)) || roomId;
    if (!roomId) return false;
    writeStorage(AUTH_KEYS.roomId, roomId);
    writeStorage(AUTH_KEYS.roomName, roomName);
    const userId = safeText(readStorage(AUTH_KEYS.userId));
    if (userId) {
      const preferences = readPreferenceMap();
      preferences[userId] = {
        roomId,
        roomName,
        updatedAt: nowIso(),
      };
      writePreferenceMap(preferences);
    }
    window.dispatchEvent(
      new CustomEvent("mobile:room-changed", {
        detail: { roomId, roomName },
      })
    );
    window.dispatchEvent(
      new CustomEvent("mobile:room-preference-updated", {
        detail: { userId, roomId, roomName },
      })
    );
    return true;
  }

  function clearTableTileBindings() {
    document.querySelectorAll(".tables-grid .table-tile").forEach((tile) => {
      if (!(tile instanceof HTMLElement)) return;
      delete tile.dataset.mobileTableId;
      tile.style.display = "";
      tile.classList.remove("is-mobile-complex-table");
      tile.querySelectorAll(".mobile-table-complex-badge").forEach((entry) => entry.remove());
    });
    state.tileMap = new WeakMap();
  }

  async function refreshVisibleRoom(room, options) {
    const safeRoom = room && typeof room === "object" ? room : {};
    const roomId = safeText(safeRoom.id || safeRoom.roomId);
    const roomName = safeText(safeRoom.name || safeRoom.roomName) || roomId;
    if (roomName) {
      document.querySelectorAll(".tables-title").forEach((title) => {
        if (title instanceof HTMLElement) title.textContent = roomName;
      });
    }
    clearTableTileBindings();
    try {
      await loadGroups(true);
    } catch {
      // Il reload sotto resta il fallback autorevole.
    }
    try {
      const params = new URLSearchParams({ _: String(Date.now()) });
      if (roomId) params.set("roomId", roomId);
      const response = await authenticatedFetch(`/api/integration/layout?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const json = await response.json().catch(() => null);
      if (response.ok && json && Array.isArray(json.tables)) {
        transformLayout(json);
      }
    } catch {
      // La UI viene comunque riallineata dal reload di sicurezza, quando richiesto.
    }
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("resize"));
    scheduleApply();
    if (options && options.reload === true) {
      const delay = Number.isFinite(Number(options.reloadDelayMs)) ? Math.max(80, Number(options.reloadDelayMs)) : 650;
      window.setTimeout(() => window.location.reload(), delay);
    }
  }

  function authPayload(extra) {
    const auth = getAuth();
    return {
      token: auth.token,
      userId: auth.userId,
      username: auth.username,
      fullName: auth.fullName,
      role: auth.role,
      deviceUuid: auth.deviceUuid,
      roomId: auth.roomId,
      roomName: auth.roomName,
      ...(extra || {}),
    };
  }

  function hasMobileSession() {
    const auth = getAuth();
    return Boolean(auth.token && auth.deviceUuid);
  }

  function requestUrlFor(input) {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input.url === "string"
            ? input.url
            : "";
    if (!raw) return null;
    try {
      return new URL(raw, window.location.origin);
    } catch {
      return null;
    }
  }

  function serializeUrlForInput(url, input) {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input.url === "string"
            ? input.url
            : "";
    if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return url.toString();
  }

  function withMobileAuth(input, init) {
    const url = requestUrlFor(input);
    if (!url || !url.pathname.startsWith("/api/")) {
      return { input, init };
    }

    const auth = getAuth();
    const nextInit = { ...(init || {}) };
    const sourceHeaders =
      (init && init.headers) ||
      (input && typeof input === "object" && "headers" in input ? input.headers : undefined);
    const headers = new Headers(sourceHeaders || undefined);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (auth.token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.token}`);
    if (auth.userId && !headers.has("X-User-Id")) headers.set("X-User-Id", auth.userId);
    if (auth.username && !headers.has("X-Username")) headers.set("X-Username", auth.username);
    if (auth.deviceUuid && !headers.has("X-Device-Uuid")) headers.set("X-Device-Uuid", auth.deviceUuid);
    if (!headers.has("X-Client-App")) headers.set("X-Client-App", "mobile-frontend");
    nextInit.headers = headers;

    const method = safeText(nextInit.method || (input && input.method) || "GET").toUpperCase() || "GET";
    if (method === "GET" || method === "HEAD") {
      if (auth.token && !url.searchParams.has("token")) url.searchParams.set("token", auth.token);
      if (auth.userId && !url.searchParams.has("userId")) url.searchParams.set("userId", auth.userId);
      if (auth.username && !url.searchParams.has("username")) url.searchParams.set("username", auth.username);
      if (auth.fullName && !url.searchParams.has("fullName")) url.searchParams.set("fullName", auth.fullName);
      if (auth.deviceUuid && !url.searchParams.has("deviceUuid")) url.searchParams.set("deviceUuid", auth.deviceUuid);
      if (auth.roomId && !url.searchParams.has("roomId")) url.searchParams.set("roomId", auth.roomId);
      if (auth.roomName && !url.searchParams.has("roomName")) url.searchParams.set("roomName", auth.roomName);
      if (!url.searchParams.has("clientApp")) url.searchParams.set("clientApp", "mobile-frontend");
    }

    if (typeof Request === "function" && input instanceof Request) {
      return { input: new Request(url.toString(), input), init: nextInit };
    }
    return { input: serializeUrlForInput(url, input), init: nextInit };
  }

  function authenticatedFetch(input, init) {
    const request = withMobileAuth(input, init);
    return originalFetch(request.input, request.init);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeNode(node) {
    if (!isObject(node)) return null;
    const id = safeText(node.id || node.tableId);
    if (!id) return null;
    const children = Array.isArray(node.children)
      ? node.children.map(normalizeNode).filter(Boolean)
      : [];
    if (children.length >= 2) {
      return { id, type: "complex", children };
    }
    return { id, type: "simple" };
  }

  function normalizeGroups(groups) {
    if (!Array.isArray(groups)) return [];
    const result = [];
    const usedLeaves = new Set();
    groups.forEach((group) => {
      const normalized = normalizeNode(group);
      if (!normalized || normalized.type !== "complex") return;
      const leaves = flattenLeafIds(normalized);
      if (leaves.length < 2) return;
      if (leaves.some((id) => usedLeaves.has(id))) return;
      leaves.forEach((id) => usedLeaves.add(id));
      result.push({ ...normalized, updatedAt: safeText(group.updatedAt) || nowIso() });
    });
    return result;
  }

  async function loadGroups(force) {
    if (!hasMobileSession()) {
      return state.groups;
    }
    if (!force && state.groupsLoading) return state.groupsLoading;
    state.groupsLoading = (async () => {
      try {
        const response = await authenticatedFetch(`${GROUPS_URL}?_=${Date.now()}`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const json = await response.json().catch(() => null);
        if (response.ok && json && json.ok !== false) {
          state.groups = normalizeGroups(json.groups);
          if (state.layout) transformLayout(state.layout);
        }
      } catch {
        // Il backend resta la sorgente autorevole: meglio nessun gruppo che un'unione tavoli stale.
        state.groups = [];
        if (state.layout) transformLayout(state.layout);
      } finally {
        state.groupsLoading = null;
      }
      return state.groups;
    })();
    return state.groupsLoading;
  }

  async function saveGroups(nextGroups) {
    const groups = normalizeGroups(nextGroups);
    const response = await authenticatedFetch(SAVE_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ groups }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.ok === false) {
      throw new Error(safeText(json && json.error) || "Impossibile salvare l'unione tavoli.");
    }
    state.groups = normalizeGroups(json.groups);
    if (state.layout) transformLayout(state.layout);
    window.dispatchEvent(
      new CustomEvent("mobile:table-groups-updated", {
        detail: { groups: state.groups },
      })
    );
    setTimeout(() => {
      window.dispatchEvent(new Event("focus"));
      scheduleApply();
    }, 30);
    return state.groups;
  }

  async function postJson(url, payload) {
    const response = await authenticatedFetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.ok === false) {
      throw new Error(safeText(json && (json.error || json.message)) || "Operazione non riuscita.");
    }
    return json;
  }

  function normalizeRoom(room) {
    if (!isObject(room)) return null;
    const id = safeText(room.id);
    const name = safeText(room.name);
    if (!id || !name) return null;
    const hasAuthorizedFlag = Object.prototype.hasOwnProperty.call(room, "authorized");
    const hasEnabledFlag = Object.prototype.hasOwnProperty.call(room, "enabled");
    const requiresAdminAuth = room.requiresAdminAuth === true;
    return {
      id,
      name,
      enabled: hasEnabledFlag ? room.enabled !== false : true,
      authorized: hasAuthorizedFlag ? room.authorized === true : true,
      requiresAdminAuth,
    };
  }

  function isDirectAuthorizedRoom(room) {
    return Boolean(
      room &&
        room.enabled !== false &&
        room.authorized !== false &&
        room.requiresAdminAuth !== true
    );
  }

  function directAuthorizedRooms(rooms) {
    const list = (Array.isArray(rooms) ? rooms : []).filter(isDirectAuthorizedRoom);
    return list.length > 0 ? list : [];
  }

  async function loadRooms(force) {
    if (!force && state.rooms.length > 0) return state.rooms;
    if (!force && state.roomsLoading) return state.roomsLoading;
    state.roomsLoading = (async () => {
      try {
        const json = await postJson(ROOMS_URL, authPayload());
        state.rooms = (Array.isArray(json.rooms) ? json.rooms : []).map(normalizeRoom).filter(Boolean);
      } catch {
        const layout = state.layout || state.transformedLayout;
        state.rooms = (Array.isArray(layout && layout.rooms) ? layout.rooms : []).map(normalizeRoom).filter(Boolean);
      } finally {
        state.roomsLoading = null;
      }
      return state.rooms;
    })();
    return state.roomsLoading;
  }

  function tableMap(layout) {
    const map = new Map();
    const tables = Array.isArray(layout && layout.tables) ? layout.tables : [];
    tables.forEach((table) => {
      const id = safeText(table && table.id);
      if (id) map.set(id, table);
    });
    return map;
  }

  function groupByRoot(id) {
    const rootId = safeText(id);
    return state.groups.find((group) => group.id === rootId) || null;
  }

  function flattenLeafIds(node, output) {
    const target = output || [];
    if (!node) return target;
    if (node.type === "complex" && Array.isArray(node.children)) {
      node.children.forEach((child) => flattenLeafIds(child, target));
      return target;
    }
    const id = safeText(node.id);
    if (id && !target.includes(id)) target.push(id);
    return target;
  }

  function directNodeKey(node, index) {
    return `${node && node.type === "complex" ? "complex" : "simple"}:${safeText(node && node.id)}:${index}`;
  }

  function getTableStatus(table) {
    if (!table) return "libero";
    if (Number(table.amountDue) > 0) return "da_pagare";
    if (Number(table.ordersInProgress) > 0) return "ordine";
    const occupancy = safeText(table.occupancyState);
    if (occupancy === "reserved") return "prenotato";
    if (occupancy && occupancy !== "free") return "occupato";
    return "libero";
  }

  function statusLabel(status) {
    return {
      libero: "Libero",
      prenotato: "Prenotato",
      occupato: "Occupato",
      ordine: "Ordine",
      da_pagare: "Da pagare",
    }[status] || "Libero";
  }

  function getNodeActiveLeaves(node, tablesById) {
    return flattenLeafIds(node)
      .map((id) => ({ id, table: tablesById.get(id) || null }))
      .map((entry) => ({ ...entry, status: getTableStatus(entry.table) }))
      .filter((entry) => entry.status !== "libero");
  }

  function canMergeNodes(nodes, tablesById) {
    const active = [];
    nodes.forEach((node) => {
      getNodeActiveLeaves(node, tablesById).forEach((entry) => active.push(entry));
    });
    return active.length <= 1;
  }

  function compositionLabel(node, tablesById) {
    const numbers = flattenLeafIds(node)
      .map((id) => Number(tablesById.get(id) && tablesById.get(id).number))
      .filter((number) => Number.isFinite(number) && number > 0)
      .sort((a, b) => a - b);
    const unique = Array.from(new Set(numbers));
    if (unique.length === 0) return "?";
    if (unique.length === 1) return String(unique[0]);
    const consecutive = unique.every((number, index) => index === 0 || number === unique[index - 1] + 1);
    return consecutive ? `${unique[0]}-${unique[unique.length - 1]}` : unique.join("/");
  }

  function nodeLabel(node, tablesById) {
    if (!node) return "Tavolo";
    if (node.type === "complex") return compositionLabel(node, tablesById);
    const table = tablesById.get(node.id);
    return table ? String(table.number) : "?";
  }

  function simpleLeafTableNames(node, tablesById) {
    return flattenLeafIds(node)
      .map((id) => {
        const table = tablesById.get(id);
        const number = Math.trunc(Number(table && table.number) || 0);
        return {
          sortNumber: number > 0 ? number : Number.MAX_SAFE_INTEGER,
          label: number > 0 ? `Tavolo ${number}` : `Tavolo ${id}`,
        };
      })
      .sort((left, right) => {
        if (left.sortNumber !== right.sortNumber) return left.sortNumber - right.sortNumber;
        return left.label.localeCompare(right.label, "it");
      })
      .map((entry) => entry.label)
      .filter((label, index, items) => items.indexOf(label) === index);
  }

  function nodeHistoryLabel(node, tablesById) {
    const labels = simpleLeafTableNames(node, tablesById);
    if (labels.length > 1) {
      return `Storico: ${labels.join(", ")}`;
    }
    return "";
  }

  function splitRowLeafLabels(node, tablesById) {
    return simpleLeafTableNames(node, tablesById);
  }

  function splitRowTitle(node, tablesById) {
    return `Tavolo ${nodeLabel(node, tablesById)}`;
  }

  function splitRowLeafListHtml(node, tablesById) {
    if (!node || node.type !== "complex") return "";
    const history = nodeHistoryLabel(node, tablesById);
    if (!history) return "";
    return `<span class="mobile-table-groups-row-history" data-no-logical-rewrite="true">${escapeHtml(history)}</span>`;
  }

  function logicalNodeForId(id) {
    const group = groupByRoot(id);
    return group || { id: safeText(id), type: "simple" };
  }

  function groupContainingId(id) {
    const safeId = safeText(id);
    if (!safeId) return null;
    return state.groups.find((group) => group.id === safeId || flattenLeafIds(group).includes(safeId)) || null;
  }

  function logicalLabelForId(id) {
    const group = groupContainingId(id);
    if (!group || !state.layout) return "";
    return compositionLabel(group, tableMap(state.layout));
  }

  function escapeRegExp(value) {
    return safeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function logicalNumberLabels() {
    const layout = state.layout;
    if (!layout) return [];
    const tablesById = tableMap(layout);
    const entries = [];
    state.groups.forEach((group) => {
      const label = compositionLabel(group, tablesById);
      if (!label) return;
      flattenLeafIds(group).forEach((id) => {
        const number = Number(tablesById.get(id) && tablesById.get(id).number);
        if (Number.isFinite(number) && number > 0) {
          entries.push({ number: String(Math.trunc(number)), label });
        }
      });
    });
    return entries;
  }

  function replaceLogicalTableText(value, entry) {
    let next = String(value ?? "");
    const number = escapeRegExp(entry.number);
    next = next.replace(new RegExp(`\\bTavolo\\s+${number}(?![\\d/-])`, "g"), `Tavolo ${entry.label}`);
    next = next.replace(new RegExp(`\\btavolo\\s+${number}(?![\\d/-])`, "g"), `tavolo ${entry.label}`);
    next = next.replace(new RegExp(`\\bTAV\\.\\s*${number}(?![\\d/-])`, "g"), `TAV. ${entry.label}`);
    return next;
  }

  function applyLogicalTextLabels() {
    if (!document.body) return;
    const entries = logicalNumberLabels();
    if (entries.length === 0) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest("script, style, input, textarea, select") ||
          parent.closest("#mobile-table-groups-modal") ||
          parent.closest('[data-no-logical-rewrite="true"]')
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      let next = node.nodeValue;
      entries.forEach((entry) => {
        next = replaceLogicalTableText(next, entry);
      });
      if (next !== node.nodeValue) node.nodeValue = next;
    });
  }

  function topLogicalItemsForRoom(roomId) {
    const layout = state.layout;
    if (!layout) return [];
    const tablesById = tableMap(layout);
    const rootIds = new Set(state.groups.map((group) => group.id));
    const hiddenIds = new Set();
    state.groups.forEach((group) => {
      flattenLeafIds(group).forEach((id) => {
        if (id !== group.id) hiddenIds.add(id);
      });
    });
    return (Array.isArray(layout.tables) ? layout.tables : [])
      .filter((table) => !roomId || table.roomId === roomId)
      .filter((table) => rootIds.has(table.id) || !hiddenIds.has(table.id))
      .map((table) => {
        const group = groupByRoot(table.id);
        return {
          id: table.id,
          table,
          node: group || { id: table.id, type: "simple" },
          isComplex: !!group,
          label: group ? compositionLabel(group, tablesById) : String(table.number),
        };
      });
  }

  function simpleFreeItemsForRoom(roomId, excludedId) {
    return topLogicalItemsForRoom(roomId)
      .filter((item) => !item.isComplex)
      .filter((item) => item.id !== safeText(excludedId))
      .filter((item) => getTableStatus(item.table) === "libero");
  }

  function aggregateGroupTable(group, tablesById) {
    const root = tablesById.get(group.id);
    if (!root) return null;
    const label = compositionLabel(group, tablesById);
    const leafTables = flattenLeafIds(group).map((id) => tablesById.get(id)).filter(Boolean);
    const activeLeaves = leafTables
      .map((table) => ({ table, status: getTableStatus(table) }))
      .filter((entry) => entry.status !== "libero");
    const active = activeLeaves[0] ? activeLeaves[0].table : root;
    const amountDue = leafTables.reduce((sum, table) => sum + Math.max(Number(table.amountDue) || 0, 0), 0);
    const ordersInProgress = leafTables.reduce(
      (sum, table) => sum + Math.max(Math.trunc(Number(table.ordersInProgress) || 0), 0),
      0
    );
    const ordersTaken = leafTables.reduce(
      (sum, table) => sum + Math.max(Math.trunc(Number(table.ordersTaken) || 0), 0),
      0
    );
    const covers = leafTables.reduce((sum, table) => sum + Math.max(Math.trunc(Number(table.covers) || 0), 0), 0);
    return {
      ...root,
      tableName: safeText(active.tableName) || safeText(root.tableName),
      customerPhone: safeText(active.customerPhone) || safeText(root.customerPhone),
      note: safeText(active.note) || safeText(root.note),
      allergens: Array.isArray(active.allergens) ? active.allergens : root.allergens,
      manualIntolerance: safeText(active.manualIntolerance) || safeText(root.manualIntolerance),
      reservationAt: active.reservationAt || root.reservationAt,
      seatedAt: active.seatedAt || root.seatedAt,
      occupancyState: active.occupancyState || root.occupancyState,
      amountDue: Math.round(amountDue * 100) / 100,
      ordersInProgress,
      ordersTaken,
      covers,
      mobileComplex: true,
      mobileComplexLabel: label,
      tableLabel: label,
      logicalTableLabel: label,
    };
  }

  function transformLayout(layout) {
    if (!layout || !Array.isArray(layout.tables)) return layout;
    state.layout = cloneJson(layout);
    const tablesById = tableMap(layout);
    const rootIds = new Set(state.groups.map((group) => group.id));
    const tables = layout.tables
      .map((table) => {
        const group = groupByRoot(table.id);
        return group ? aggregateGroupTable(group, tablesById) || table : table;
      });
    const countByRoom = new Map();
    tables.forEach((table) => {
      countByRoom.set(table.roomId, (countByRoom.get(table.roomId) || 0) + 1);
    });
    const rooms = (Array.isArray(layout.rooms) ? layout.rooms : []).map((room) => ({
      ...room,
      tablesCount: countByRoom.get(room.id) || 0,
    }));
    state.transformedLayout = { ...layout, rooms, tables };
    return state.transformedLayout;
  }

  function isLayoutRequest(input, init) {
    const method = safeText((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (method && method !== "GET") return false;
    const url = resolveUrl(input);
    return url && url.pathname === "/api/integration/layout";
  }

  function resolveUrl(input) {
    try {
      const value = typeof input === "string" || input instanceof URL ? String(input) : String(input && input.url);
      return new URL(value, window.location.origin);
    } catch {
      return null;
    }
  }

  function operationUsesLogicalTable(pathname) {
    return (
      pathname === "/api/settings/pos/assign-bill" ||
      pathname === "/api/payments/table" ||
      pathname === "/api/integration/layout/table/sync"
    );
  }

  function operationMayCarryTableLabel(pathname) {
    return (
      operationUsesLogicalTable(pathname) ||
      pathname === "/api/integration/orders/create" ||
      pathname === "/api/integration/orders/sync"
    );
  }

  function activeCarrierId(rootId) {
    const group = groupByRoot(rootId);
    if (!group || !state.layout) return rootId;
    const tablesById = tableMap(state.layout);
    const active = getNodeActiveLeaves(group, tablesById);
    return active.length === 1 ? active[0].id : rootId;
  }

  function maybeRewriteTablePayload(input, init) {
    const url = resolveUrl(input);
    if (!url || !operationMayCarryTableLabel(url.pathname) || !init || !init.body) return init;
    if (typeof init.body !== "string") return init;
    try {
      const payload = JSON.parse(init.body);
      const tableId = safeText(payload.tableId);
      let nextPayload = payload;
      if (tableId) {
        const label = logicalLabelForId(tableId);
        if (label) {
          nextPayload = {
            ...nextPayload,
            tableLabel: label,
            logicalTableLabel: label,
          };
        }
      }
      if (payload.order && typeof payload.order === "object" && !Array.isArray(payload.order)) {
        const orderTableId = safeText(payload.order.tableId || tableId);
        const orderLabel = logicalLabelForId(orderTableId);
        if (orderLabel) {
          nextPayload = {
            ...nextPayload,
            order: {
              ...payload.order,
              tableLabel: orderLabel,
              logicalTableLabel: orderLabel,
            },
          };
        }
      }
      if (!operationUsesLogicalTable(url.pathname)) {
        return nextPayload === payload
          ? init
          : {
              ...init,
              body: JSON.stringify(nextPayload),
            };
      }
      const group = tableId ? groupByRoot(tableId) : null;
      if (!group) {
        return nextPayload === payload
          ? init
          : {
              ...init,
              body: JSON.stringify(nextPayload),
            };
      }
      const targetId = activeCarrierId(tableId);
      if (!targetId || targetId === tableId) {
        return nextPayload === payload
          ? init
          : {
              ...init,
              body: JSON.stringify(nextPayload),
            };
      }
      return {
        ...init,
        body: JSON.stringify({
          ...nextPayload,
          tableId: targetId,
          logicalTableId: tableId,
        }),
      };
    } catch {
      return init;
    }
  }

  window.fetch = async function mobileTableGroupsFetch(input, init) {
    const layoutRequest = isLayoutRequest(input, init);
    if (layoutRequest) {
      await loadGroups(false);
    }
    const nextInit = maybeRewriteTablePayload(input, init);
    const request = withMobileAuth(input, nextInit);
    const response = await originalFetch(request.input, request.init);
    if (!layoutRequest) return response;
    try {
      const json = await response.clone().json();
      if (!response.ok || !json || json.ok === false) return response;
      const transformed = transformLayout(json);
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/json; charset=utf-8");
      scheduleApply();
      return new Response(JSON.stringify(transformed), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  };

  function visibleRoomFromTitle() {
    const title = safeText(document.querySelector(".tables-title")?.textContent);
    if (!title) return null;
    const layout = state.transformedLayout || state.layout;
    const rooms = Array.isArray(layout && layout.rooms) ? layout.rooms : [];
    return (
      rooms.find((entry) => safeText(entry.name || entry.roomName) === title) ||
      null
    );
  }

  function currentRoomId() {
    const visibleRoom = visibleRoomFromTitle();
    if (visibleRoom) return safeText(visibleRoom.id || visibleRoom.roomId);
    const authRoomId = safeText(readStorage(AUTH_KEYS.roomId));
    if (authRoomId) return authRoomId;
    return "";
  }

  function currentRoomName() {
    const visibleRoom = visibleRoomFromTitle();
    if (visibleRoom) return safeText(visibleRoom.name || visibleRoom.roomName);
    return safeText(document.querySelector(".tables-title")?.textContent) || safeText(readStorage(AUTH_KEYS.roomName));
  }

  async function refreshTableGroupsModalState() {
    await loadGroups(true);
    try {
      const response = await authenticatedFetch(`/api/integration/layout?_=${Date.now()}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const json = await response.json().catch(() => null);
      if (response.ok && json && Array.isArray(json.tables)) {
        transformLayout(json);
        scheduleApply();
      }
    } catch {
      // Se il refresh live fallisce, mantengo l'ultimo layout noto valido.
    }
  }

  function annotateGrid() {
    const layout = state.transformedLayout || state.layout;
    if (!layout) return;
    const roomId = currentRoomId();
    const originalLayout = state.layout || layout;
    const tablesById = tableMap(originalLayout);
    const transformedById = tableMap(layout);
    const originalRoomTables = (Array.isArray(originalLayout.tables) ? originalLayout.tables : []).filter(
      (table) => !roomId || table.roomId === roomId
    );
    const hiddenIds = new Set();
    state.groups.forEach((group) => {
      flattenLeafIds(group).forEach((id) => {
        if (id !== group.id) hiddenIds.add(id);
      });
    });
    const byNumber = new Map();
    originalRoomTables.forEach((table) => {
      const key = String(table.number);
      const items = byNumber.get(key) || [];
      items.push(table);
      byNumber.set(key, items);
    });
    const used = new Set();
    document.querySelectorAll(".tables-grid .table-tile").forEach((tile) => {
      if (!(tile instanceof HTMLElement)) return;
      const titleNode = tile.querySelector(".table-title");
      const rawTitle = safeText(titleNode && titleNode.textContent);
      const matchedNumber = rawTitle.match(/(\d+)/);
      let table = null;
      const existingId = safeText(tile.dataset.mobileTableId);
      if (existingId) {
        table = originalRoomTables.find((entry) => entry.id === existingId) || null;
      }
      if (!table && matchedNumber) {
        const candidates = byNumber.get(matchedNumber[1]) || [];
        table = candidates.find((entry) => !used.has(entry.id)) || null;
      }
      if (!table) return;
      used.add(table.id);
      tile.dataset.mobileTableId = table.id;
      const effectiveTable = transformedById.get(table.id) || table;
      state.tileMap.set(tile, effectiveTable);
      if (hiddenIds.has(table.id)) {
        tile.style.display = "none";
        return;
      }
      tile.style.display = "";
      const group = groupByRoot(table.id);
      tile.classList.toggle("is-mobile-complex-table", !!group);
      tile.querySelectorAll(".mobile-table-complex-badge").forEach((entry) => entry.remove());
      if (group && titleNode) {
        const label = compositionLabel(group, tablesById);
        if (titleNode.textContent !== label) titleNode.textContent = label;
      } else if (titleNode) {
        const label = String(table.number);
        if (titleNode.textContent !== label) titleNode.textContent = label;
      }
    });
    applyLogicalTextLabels();
  }

  function scheduleApply() {
    if (state.queued) return;
    state.queued = true;
    window.requestAnimationFrame(() => {
      state.queued = false;
      annotateGrid();
    });
  }

  function closeModal() {
    const root = document.getElementById("mobile-table-groups-modal");
    if (root) root.remove();
    state.modal = null;
    state.activeApprovalRequestId = "";
  }

  function renderContextMenu(table) {
    closeModal();
    const group = groupByRoot(table.id);
    const allowMove = !group;
    const root = document.createElement("div");
    root.id = "mobile-table-groups-modal";
    root.innerHTML = [
      '<div class="mobile-table-groups-backdrop">',
      '  <div class="mobile-table-groups-context" role="dialog" aria-modal="true" aria-label="Azioni tavolo">',
      '    <button type="button" class="mobile-table-groups-context-close" data-role="close">&times;</button>',
      `    <div class="mobile-table-groups-context-title">Tavolo ${escapeHtml(group ? groupLabel(group) : String(table.number))}</div>`,
      '    <button type="button" class="mobile-table-groups-action" data-role="merge">Unisci</button>',
      allowMove ? '    <button type="button" class="mobile-table-groups-action" data-role="move">Sposta</button>' : "",
      '    <button type="button" class="mobile-table-groups-action" data-role="room-move">Cambio sala</button>',
      group ? '    <button type="button" class="mobile-table-groups-action" data-role="split">Dividi</button>' : "",
      "  </div>",
      "</div>",
    ].join("");
    document.body.appendChild(root);
    root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
    root.querySelector('[data-role="merge"]')?.addEventListener("click", () => renderMergeModal(table.id));
    root.querySelector('[data-role="move"]')?.addEventListener("click", () => renderMoveModal(table.id));
    root.querySelector('[data-role="room-move"]')?.addEventListener("click", () => renderRoomMoveRoomsModal(table.id));
    root.querySelector('[data-role="split"]')?.addEventListener("click", async () => {
      await refreshTableGroupsModalState();
      renderSplitModal(table.id);
    });
  }

  function groupLabel(group) {
    return compositionLabel(group, tableMap(state.layout || {}));
  }

  function renderMergeModal(rootId) {
    const layout = state.layout;
    if (!layout) return;
    const tablesById = tableMap(layout);
    const rootTable = tablesById.get(rootId);
    const roomId = rootTable ? rootTable.roomId : currentRoomId();
    const selected = new Set();
    const items = topLogicalItemsForRoom(roomId);
    const rootNode = logicalNodeForId(rootId);
    let error = "";

    function setMergeError(root, message) {
      const errorBox = root.querySelector(".mobile-table-groups-error");
      if (!(errorBox instanceof HTMLElement)) return;
      errorBox.textContent = message || "";
      errorBox.hidden = !message;
    }

    function updateMergeSelectionUi(root) {
      const selectedNodes = [...selected].map(logicalNodeForId);
      const canConfirm = selected.size > 0 && canMergeNodes([rootNode, ...selectedNodes], tablesById);
      const confirmButton = root.querySelector('[data-role="confirm"]');
      if (confirmButton instanceof HTMLButtonElement) {
        confirmButton.disabled = !canConfirm;
      }
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) return;
        const id = button.getAttribute("data-id") || "";
        const checked = selected.has(id);
        const isMain = id === rootId;
        const testNodes = checked ? selectedNodes : [...selectedNodes, logicalNodeForId(id)];
        const compatible = isMain || checked || canMergeNodes([rootNode, ...testNodes], tablesById);
        button.classList.toggle("is-selected", checked);
        button.setAttribute("aria-pressed", checked ? "true" : "false");
        button.disabled = isMain || !compatible;
        const marker = button.querySelector(".mobile-table-groups-select-mark");
        if (marker instanceof HTMLElement) {
          marker.innerHTML = checked ? "&#10003;" : "";
        }
        const note = button.querySelector(".mobile-table-groups-row-note");
        if (note instanceof HTMLElement) {
          note.hidden = compatible || isMain;
        }
      });
    }

    function render() {
      const root = document.getElementById("mobile-table-groups-modal") || document.createElement("div");
      root.id = "mobile-table-groups-modal";
      const selectedNodes = [...selected].map(logicalNodeForId);
      const canConfirm = selected.size > 0 && canMergeNodes([rootNode, ...selectedNodes], tablesById);
      root.innerHTML = [
        '<div class="mobile-table-groups-backdrop">',
        '  <div class="mobile-table-groups-dialog" role="dialog" aria-modal="true" aria-label="Unisci tavoli">',
        '    <div class="mobile-table-groups-head">',
        '      <strong>Unisci tavoli</strong>',
        '      <button type="button" class="mobile-table-groups-close" data-role="close" aria-label="Chiudi">&times;</button>',
        "    </div>",
        '    <div class="mobile-table-groups-list">',
        items
          .map((item) => {
            const checked = selected.has(item.id);
            const isMain = item.id === rootId;
            const testNodes = [...selectedNodes, item.node];
            const compatible = isMain || checked || canMergeNodes([rootNode, ...testNodes], tablesById);
            const active = getNodeActiveLeaves(item.node, tablesById)[0];
            const subtitle = isMain ? "Tavolo principale" : "";
            return [
              `<button type="button" class="mobile-table-groups-row ${isMain ? "is-main" : ""} ${checked ? "is-selected" : ""}" data-id="${escapeHtml(item.id)}" aria-pressed="${checked ? "true" : "false"}" ${isMain || !compatible ? "disabled" : ""}>`,
              '  <span class="mobile-table-groups-row-main">',
              `    <strong>Tavolo ${escapeHtml(item.label)}</strong>`,
              subtitle ? `    <em>${escapeHtml(subtitle)}</em>` : "",
              `    <span class="mobile-table-groups-row-note mobile-table-groups-row-note-badge" ${compatible || isMain ? "hidden" : ""}>INCOMPATIBILE</span>`,
              "  </span>",
              `  <span class="mobile-table-groups-select-mark" aria-hidden="true">${checked ? "&#10003;" : ""}</span>`,
              `  <span class="mobile-table-groups-row-state">${escapeHtml(statusLabel(active ? active.status : "libero"))}</span>`,
              "</button>",
            ].join("");
          })
          .join(""),
        "    </div>",
        `    <div class="mobile-table-groups-error" ${error ? "" : "hidden"}>${escapeHtml(error)}</div>`,
        '    <div class="mobile-table-groups-actions">',
        `      <button type="button" class="mobile-table-groups-confirm" data-role="confirm" ${canConfirm ? "" : "disabled"}>Unisci</button>`,
        "    </div>",
        "  </div>",
        "</div>",
      ].join("");
      if (!root.parentNode) document.body.appendChild(root);
      root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.getAttribute("data-id") || "";
          if (!id || id === rootId || button.hasAttribute("disabled")) return;
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          error = "";
          setMergeError(root, "");
          updateMergeSelectionUi(root);
        });
      });
      root.querySelector('[data-role="confirm"]')?.addEventListener("click", async () => {
        try {
          await confirmMerge(rootId, [...selected]);
          closeModal();
        } catch (err) {
          error = err instanceof Error ? err.message : "Unione non riuscita.";
          setMergeError(root, error);
          updateMergeSelectionUi(root);
        }
      });
      updateMergeSelectionUi(root);
    }
    render();
  }

  async function confirmMerge(rootId, selectedIds) {
    if (!selectedIds.length) return;
    const layout = state.layout;
    const tablesById = tableMap(layout || {});
    const groups = cloneJson(state.groups);
    const rootIndex = groups.findIndex((group) => group.id === rootId);
    const rootNode = rootIndex >= 0 ? groups.splice(rootIndex, 1)[0] : { id: rootId, type: "simple" };
    const selectedNodes = [];
    selectedIds.forEach((id) => {
      const groupIndex = groups.findIndex((group) => group.id === id);
      selectedNodes.push(groupIndex >= 0 ? groups.splice(groupIndex, 1)[0] : { id, type: "simple" });
    });
    if (!canMergeNodes([rootNode, ...selectedNodes], tablesById)) {
      throw new Error("Stati incompatibili: libera prima uno dei tavoli attivi.");
    }
    const children = rootNode.type === "complex" ? [...rootNode.children, ...selectedNodes] : [rootNode, ...selectedNodes];
    const seen = new Set();
    const nextChildren = children.filter((child) => {
      const key = `${child.type}:${child.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    groups.push({ id: rootId, type: "complex", children: nextChildren, updatedAt: nowIso() });
    await saveGroups(groups);
  }

  function renderMoveModal(rootId) {
    const layout = state.layout;
    if (!layout) return;
    const tablesById = tableMap(layout);
    const sourceTable = tablesById.get(rootId);
    if (!sourceTable) return;
    const roomId = sourceTable.roomId || currentRoomId();
    const items = simpleFreeItemsForRoom(roomId, rootId);
    let selectedId = "";
    let error = "";

    function setMoveError(root, message) {
      const errorBox = root.querySelector(".mobile-table-groups-error");
      if (!(errorBox instanceof HTMLElement)) return;
      errorBox.textContent = message || "";
      errorBox.hidden = !message;
    }

    function updateMoveSelectionUi(root) {
      const confirmButton = root.querySelector('[data-role="confirm"]');
      if (confirmButton instanceof HTMLButtonElement) {
        confirmButton.disabled = !selectedId;
      }
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) return;
        const id = button.getAttribute("data-id") || "";
        const checked = id === selectedId;
        button.classList.toggle("is-selected", checked);
        button.setAttribute("aria-pressed", checked ? "true" : "false");
        const marker = button.querySelector(".mobile-table-groups-select-mark");
        if (marker instanceof HTMLElement) {
          marker.innerHTML = checked ? "&#10003;" : "";
        }
      });
    }

    function render() {
      const root = document.getElementById("mobile-table-groups-modal") || document.createElement("div");
      root.id = "mobile-table-groups-modal";
      root.innerHTML = [
        '<div class="mobile-table-groups-backdrop">',
        '  <div class="mobile-table-groups-dialog" role="dialog" aria-modal="true" aria-label="Sposta tavolo">',
        '    <div class="mobile-table-groups-head">',
        '      <strong>Sposta tavolo</strong>',
        '      <button type="button" class="mobile-table-groups-close" data-role="close" aria-label="Chiudi">&times;</button>',
        "    </div>",
        '    <div class="mobile-table-groups-list">',
        items.length
          ? items
              .map((item) => {
                const checked = item.id === selectedId;
                return [
                  `<button type="button" class="mobile-table-groups-row ${checked ? "is-selected" : ""}" data-id="${escapeHtml(item.id)}" aria-pressed="${checked ? "true" : "false"}">`,
                  '  <span class="mobile-table-groups-row-main">',
                  `    <strong>Tavolo ${escapeHtml(item.label)}</strong>`,
                  `    <span class="mobile-table-groups-row-history">Destinazione libera</span>`,
                  "  </span>",
                  `  <span class="mobile-table-groups-select-mark" aria-hidden="true">${checked ? "&#10003;" : ""}</span>`,
                  `  <span class="mobile-table-groups-row-state">${escapeHtml(statusLabel(getTableStatus(item.table)))}</span>`,
                  "</button>",
                ].join("");
              })
              .join("")
          : '<div class="mobile-table-groups-empty">Nessun tavolo libero disponibile in questa sala.</div>',
        "    </div>",
        `    <div class="mobile-table-groups-error" ${error ? "" : "hidden"}>${escapeHtml(error)}</div>`,
        '    <div class="mobile-table-groups-actions">',
        `      <button type="button" class="mobile-table-groups-confirm" data-role="confirm" ${selectedId ? "" : "disabled"}>Sposta</button>`,
        "    </div>",
        "  </div>",
        "</div>",
      ].join("");
      if (!root.parentNode) document.body.appendChild(root);
      root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        button.addEventListener("click", () => {
          selectedId = button.getAttribute("data-id") || "";
          error = "";
          setMoveError(root, "");
          updateMoveSelectionUi(root);
        });
      });
      root.querySelector('[data-role="confirm"]')?.addEventListener("click", async () => {
        try {
          await confirmMove(rootId, selectedId);
          closeModal();
        } catch (err) {
          error = err instanceof Error ? err.message : "Spostamento non riuscito.";
          setMoveError(root, error);
          updateMoveSelectionUi(root);
        }
      });
      updateMoveSelectionUi(root);
    }

    render();
  }

  async function confirmMove(rootId, targetId) {
    const sourceId = safeText(rootId);
    const destinationId = safeText(targetId);
    if (!sourceId || !destinationId) {
      throw new Error("Seleziona un tavolo destinazione.");
    }
    const response = await authenticatedFetch(MOVE_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        fromTableId: sourceId,
        toTableId: destinationId,
      }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.ok === false) {
      throw new Error(safeText(json && json.error) || "Impossibile spostare il tavolo.");
    }
    setTimeout(() => {
      window.dispatchEvent(new Event("focus"));
      scheduleApply();
    }, 30);
    return json;
  }

  function renderModalShell(title, bodyHtml, actionsHtml, label) {
    const root = document.getElementById("mobile-table-groups-modal") || document.createElement("div");
    root.id = "mobile-table-groups-modal";
    root.innerHTML = [
      '<div class="mobile-table-groups-backdrop">',
      `  <div class="mobile-table-groups-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(label || title)}">`,
      '    <div class="mobile-table-groups-head">',
      `      <strong>${escapeHtml(title)}</strong>`,
      '      <button type="button" class="mobile-table-groups-close" data-role="close" aria-label="Chiudi">&times;</button>',
      "    </div>",
      bodyHtml,
      actionsHtml || "",
      "  </div>",
      "</div>",
    ].join("");
    if (!root.parentNode) document.body.appendChild(root);
    root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
    return root;
  }

  function setModalError(root, message) {
    const errorBox = root.querySelector(".mobile-table-groups-error");
    if (!(errorBox instanceof HTMLElement)) return;
    errorBox.textContent = message || "";
    errorBox.hidden = !message;
  }

  async function ensureRoomMoveLayout() {
    await refreshTableGroupsModalState();
    if (state.layout) return state.layout;
    const response = await authenticatedFetch(`/api/integration/layout?_=${Date.now()}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || !Array.isArray(json.tables)) {
      throw new Error("Impossibile caricare i tavoli.");
    }
    transformLayout(json);
    return state.layout;
  }

  function leafCountForTable(rootId) {
    return flattenLeafIds(logicalNodeForId(rootId)).length || 1;
  }

  function tableLabelById(id) {
    const layout = state.layout || {};
    const tablesById = tableMap(layout);
    const group = groupByRoot(id);
    if (group) return `Tavolo ${compositionLabel(group, tablesById)}`;
    const table = tablesById.get(id);
    const number = Math.trunc(Number(table && table.number) || 0);
    return number > 0 ? `Tavolo ${number}` : `Tavolo ${id}`;
  }

  function targetLabelsForIds(ids) {
    const tablesById = tableMap(state.layout || {});
    return ids.map((id) => {
      const table = tablesById.get(id);
      const number = Math.trunc(Number(table && table.number) || 0);
      return number > 0 ? `Tavolo ${number}` : `Tavolo ${id}`;
    });
  }

  function removeGroupsForTransfer(groups, rootId, targetIds) {
    const targets = new Set([safeText(rootId), ...targetIds.map(safeText)]);
    return normalizeGroups(groups).filter((group) => {
      const leaves = flattenLeafIds(group);
      if (targets.has(group.id)) return false;
      return !leaves.some((id) => targets.has(id));
    });
  }

  function buildTransferredGroups(rootId, targetIds) {
    const nextGroups = removeGroupsForTransfer(state.groups, rootId, targetIds);
    if (targetIds.length >= 2) {
      nextGroups.push({
        id: targetIds[0],
        type: "complex",
        children: targetIds.map((id) => ({ id, type: "simple" })),
        updatedAt: nowIso(),
      });
    }
    return nextGroups;
  }

  async function adjustMovedTableCovers(context, moveResponse) {
    const delta = Math.trunc(Number(context.adjustCoversDelta) || 0);
    if (delta === 0) return;
    const moved = moveResponse && typeof moveResponse === "object" ? moveResponse.toTable : null;
    const currentCovers = Math.max(Math.trunc(Number(moved && moved.covers) || 0), 1);
    const nextCovers = Math.max(1, Math.min(24, currentCovers + delta));
    if (nextCovers === currentCovers) return;
    await postJson(
      TABLE_SYNC_URL,
      authPayload({
        roomId: context.targetRoom.id,
        tableId: context.targetIds[0],
        status: safeText(moved && moved.status) || "no_orders",
        tableName: safeText(moved && (moved.guestName || moved.tableName)),
        customerPhone: safeText(moved && moved.customerPhone),
        covers: nextCovers,
        note: safeText(moved && moved.note),
        allergens: Array.isArray(moved && moved.allergens) ? moved.allergens : [],
        manualIntolerance: safeText(moved && moved.manualIntolerance),
        seatedAt: moved && moved.seatedAt ? moved.seatedAt : undefined,
      })
    );
  }

  async function performRoomTransfer(context) {
    const sourceId = activeCarrierId(context.rootId);
    const destinationId = context.targetIds[0];
    if (!sourceId || !destinationId) throw new Error("Tavoli non validi.");
    const moveResponse = await postJson(
      MOVE_URL,
      authPayload({
        fromTableId: sourceId,
        toTableId: destinationId,
        roomId: context.currentRoomId,
      })
    );
    await adjustMovedTableCovers(context, moveResponse);
    await saveGroups(buildTransferredGroups(context.rootId, context.targetIds));
    await refreshVisibleRoom(
      { id: context.currentRoomId, name: context.currentRoomName },
      { reload: false }
    );
    return moveResponse;
  }

  async function requestRoomTransfer(context) {
    const payload = authPayload({
      fromRoomId: context.currentRoomId,
      fromRoomName: context.currentRoomName,
      targetRoomId: context.targetRoom.id,
      fromTableId: context.rootId,
      fromTableLabel: tableLabelById(context.rootId),
      targetTableIds: context.targetIds,
      targetTableLabels: targetLabelsForIds(context.targetIds),
      sourceLeafCount: context.sourceLeafCount,
      targetTableCount: context.targetIds.length,
      adjustCoversDelta: context.adjustCoversDelta,
    });
    return postJson(ROOM_MOVE_REQUEST_URL, payload);
  }

  function renderRoomMoveWaitingModal(context, request) {
    let timer = null;
    const expiresAt = Number(request && request.expiresAt) || Date.now() + 120000;
    const root = renderModalShell(
      "In attesa conferma",
      [
        '<div class="mobile-table-groups-list">',
        `  <div class="mobile-table-groups-empty">Richiesta inviata a ${escapeHtml(context.targetRoom.name)}. Se nessuno risponde entro 120 secondi, lo spostamento parte comunque.</div>`,
        `  <div class="mobile-table-groups-empty" data-role="countdown"></div>`,
        "</div>",
        '<div class="mobile-table-groups-error" hidden></div>',
      ].join(""),
      '<div class="mobile-table-groups-actions"><button type="button" class="mobile-table-groups-confirm" data-role="cancel">Chiudi</button></div>',
      "Attesa conferma cambio sala"
    );
    const stop = () => {
      if (timer) window.clearInterval(timer);
      timer = null;
    };
    root.querySelector('[data-role="cancel"]')?.addEventListener("click", () => {
      stop();
      closeModal();
    });
    const tick = async () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      const countdown = root.querySelector('[data-role="countdown"]');
      if (countdown instanceof HTMLElement) countdown.textContent = `Tempo residuo: ${remaining}s`;
      try {
        const status = await postJson(ROOM_MOVE_STATUS_URL, authPayload({ requestId: request.requestId }));
        if (status.status === "approved" || status.status === "timeout_approved") {
          stop();
          await performRoomTransfer(context);
          closeModal();
        } else if (status.status === "rejected") {
          stop();
          setModalError(root, "Spostamento rifiutato dal cameriere in sala.");
        }
      } catch (err) {
        setModalError(root, err instanceof Error ? err.message : "Errore controllo richiesta.");
      }
    };
    timer = window.setInterval(tick, ROOM_MOVE_POLL_MS);
    void tick();
  }

  async function confirmRoomMove(context) {
    const response = await requestRoomTransfer(context);
    if (response.status === "approved") {
      await performRoomTransfer(context);
      closeModal();
      return;
    }
    const request = response.request || {};
    if (!request.requestId) throw new Error("Richiesta non valida.");
    renderRoomMoveWaitingModal(context, request);
  }

  function renderRoomMoveCountConfirm(context) {
    const relation = context.targetIds.length < context.sourceLeafCount ? "meno" : "piu";
    const root = renderModalShell(
      "Conferma coperti",
      [
        '<div class="mobile-table-groups-list">',
        `  <div class="mobile-table-groups-empty">Hai selezionato ${relation} tavoli rispetto al tavolo complesso attuale (${context.sourceLeafCount} -> ${context.targetIds.length}).</div>`,
        '  <div class="mobile-table-groups-empty">Confermando, viene applicata anche la variazione del numero di coperti.</div>',
        "</div>",
        '<div class="mobile-table-groups-error" hidden></div>',
      ].join(""),
      [
        '<div class="mobile-table-groups-actions">',
        '  <button type="button" class="mobile-table-groups-confirm" data-role="back">Indietro</button>',
        '  <button type="button" class="mobile-table-groups-confirm" data-role="confirm">Conferma e cambia coperti</button>',
        "</div>",
      ].join(""),
      "Conferma variazione coperti"
    );
    root.querySelector('[data-role="back"]')?.addEventListener("click", () => renderRoomMoveTargetsModal(context.rootId, context.targetRoom));
    root.querySelector('[data-role="confirm"]')?.addEventListener("click", async () => {
      try {
        await confirmRoomMove(context);
      } catch (err) {
        setModalError(root, err instanceof Error ? err.message : "Cambio sala non riuscito.");
      }
    });
  }

  async function renderRoomMoveTargetsModal(rootId, targetRoom) {
    const loadingRoot = renderModalShell(
      "Cambio sala",
      '<div class="mobile-table-groups-list"><div class="mobile-table-groups-empty">Caricamento tavoli liberi...</div></div>',
      "",
      "Cambio sala tavolo"
    );
    try {
      await ensureRoomMoveLayout();
      const sourceLeafCount = leafCountForTable(rootId);
      const items = simpleFreeItemsForRoom(targetRoom.id, rootId);
      const selected = new Set();
      const currentRoomIdValue = currentRoomId();
      const contextBase = {
        rootId,
        targetRoom,
        sourceLeafCount,
        currentRoomId: currentRoomIdValue,
        currentRoomName: currentRoomName(),
      };
      function update(root) {
        const confirm = root.querySelector('[data-role="confirm"]');
        if (confirm instanceof HTMLButtonElement) confirm.disabled = selected.size === 0;
        root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
          const id = button.getAttribute("data-id") || "";
          const checked = selected.has(id);
          button.classList.toggle("is-selected", checked);
          button.setAttribute("aria-pressed", checked ? "true" : "false");
          const mark = button.querySelector(".mobile-table-groups-select-mark");
          if (mark instanceof HTMLElement) mark.innerHTML = checked ? "&#10003;" : "";
        });
      }
      const root = renderModalShell(
        `Tavoli in ${targetRoom.name}`,
        [
          '<div class="mobile-table-groups-list">',
          items.length
            ? items
                .map((item) => [
                  `<button type="button" class="mobile-table-groups-row" data-id="${escapeHtml(item.id)}" aria-pressed="false">`,
                  '  <span class="mobile-table-groups-row-main">',
                  `    <strong>Tavolo ${escapeHtml(item.label)}</strong>`,
                  '    <span class="mobile-table-groups-row-history">Destinazione libera</span>',
                  "  </span>",
                  '  <span class="mobile-table-groups-select-mark" aria-hidden="true"></span>',
                  `  <span class="mobile-table-groups-row-state">${escapeHtml(statusLabel(getTableStatus(item.table)))}</span>`,
                  "</button>",
                ].join(""))
                .join("")
            : '<div class="mobile-table-groups-empty">Nessun tavolo libero disponibile in questa sala.</div>',
          "</div>",
          '<div class="mobile-table-groups-error" hidden></div>',
        ].join(""),
        [
          '<div class="mobile-table-groups-actions">',
          '  <button type="button" class="mobile-table-groups-confirm" data-role="rooms">Sale</button>',
          '  <button type="button" class="mobile-table-groups-confirm" data-role="confirm" disabled>Continua</button>',
          "</div>",
        ].join(""),
        "Seleziona tavoli destinazione"
      );
      if (loadingRoot !== root && loadingRoot.parentNode) loadingRoot.remove();
      root.querySelector('[data-role="rooms"]')?.addEventListener("click", () => renderRoomMoveRoomsModal(rootId));
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.getAttribute("data-id") || "";
          if (!id) return;
          if (sourceLeafCount <= 1) {
            selected.clear();
            selected.add(id);
          } else if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          update(root);
        });
      });
      root.querySelector('[data-role="confirm"]')?.addEventListener("click", async () => {
        const targetIds = [...selected];
        const context = {
          ...contextBase,
          targetIds,
          adjustCoversDelta: targetIds.length - sourceLeafCount,
        };
        if (sourceLeafCount > 1 && targetIds.length !== sourceLeafCount) {
          renderRoomMoveCountConfirm(context);
          return;
        }
        try {
          await confirmRoomMove(context);
        } catch (err) {
          setModalError(root, err instanceof Error ? err.message : "Cambio sala non riuscito.");
        }
      });
      update(root);
    } catch (err) {
      setModalError(loadingRoot, err instanceof Error ? err.message : "Impossibile caricare i tavoli.");
    }
  }

  async function renderRoomMoveRoomsModal(rootId) {
    const root = renderModalShell(
      "Cambio sala",
      '<div class="mobile-table-groups-list"><div class="mobile-table-groups-empty">Caricamento sale autorizzate...</div></div>',
      "",
      "Seleziona sala"
    );
    try {
      await ensureRoomMoveLayout();
      const rooms = directAuthorizedRooms(await loadRooms(true));
      const activeRoomId = currentRoomId();
      root.innerHTML = [
        '<div class="mobile-table-groups-backdrop">',
        '  <div class="mobile-table-groups-dialog" role="dialog" aria-modal="true" aria-label="Seleziona sala">',
        '    <div class="mobile-table-groups-head">',
        '      <strong>Cambio sala</strong>',
        '      <button type="button" class="mobile-table-groups-close" data-role="close" aria-label="Chiudi">&times;</button>',
        "    </div>",
        '    <div class="mobile-table-groups-list">',
        rooms
          .map((room) => {
            const current = room.id === activeRoomId;
            return [
              `<button type="button" class="mobile-table-groups-row ${current ? "is-main" : ""}" data-id="${escapeHtml(room.id)}" ${current ? "disabled" : ""}>`,
              '  <span class="mobile-table-groups-row-main">',
              `    <strong>${escapeHtml(room.name)}</strong>`,
              `    <span class="mobile-table-groups-row-history">${current ? "Sala attuale" : "Autorizzata"}</span>`,
              "  </span>",
              `  <span class="mobile-table-groups-row-state">${current ? "Attuale" : "Apri"}</span>`,
              "</button>",
            ].join("");
          })
          .join("") || '<div class="mobile-table-groups-empty">Nessuna sala autorizzata.</div>',
        "    </div>",
        '<div class="mobile-table-groups-error" hidden></div>',
        "  </div>",
        "</div>",
      ].join("");
      root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const room = rooms.find((entry) => entry.id === button.getAttribute("data-id"));
          if (room && room.id !== activeRoomId) renderRoomMoveTargetsModal(rootId, room);
        });
      });
    } catch (err) {
      setModalError(root, err instanceof Error ? err.message : "Impossibile caricare le sale.");
    }
  }

  async function renderRoomSwitchModal() {
    const root = renderModalShell(
      "Cambia sala",
      '<div class="mobile-table-groups-list"><div class="mobile-table-groups-empty">Caricamento sale autorizzate...</div></div>',
      "",
      "Cambia sala"
    );
    try {
      await ensureRoomMoveLayout();
      const rooms = directAuthorizedRooms(await loadRooms(true));
      const activeRoomId = currentRoomId();
      root.innerHTML = [
        '<div class="mobile-table-groups-backdrop">',
        '  <div class="mobile-table-groups-dialog" role="dialog" aria-modal="true" aria-label="Cambia sala">',
        '    <div class="mobile-table-groups-head">',
        '      <strong>Cambia sala</strong>',
        '      <button type="button" class="mobile-table-groups-close" data-role="close" aria-label="Chiudi">&times;</button>',
        "    </div>",
        '    <div class="mobile-table-groups-list">',
        rooms
          .map((room) => {
            const current = room.id === activeRoomId;
            return [
              `<button type="button" class="mobile-table-groups-row ${current ? "is-selected" : ""}" data-id="${escapeHtml(room.id)}" ${current ? "disabled" : ""}>`,
              '  <span class="mobile-table-groups-row-main">',
              `    <strong>${escapeHtml(room.name)}</strong>`,
              `    <span class="mobile-table-groups-row-history">${current ? "Sala attuale" : "Autorizzata"}</span>`,
              "  </span>",
              `  <span class="mobile-table-groups-row-state">${current ? "Attuale" : "Vai"}</span>`,
              "</button>",
            ].join("");
          })
          .join("") || '<div class="mobile-table-groups-empty">Nessuna sala autorizzata.</div>',
        "    </div>",
        '<div class="mobile-table-groups-error" hidden></div>',
        "  </div>",
        "</div>",
      ].join("");
      root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
      root.querySelectorAll(".mobile-table-groups-row[data-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          const room = rooms.find((entry) => entry.id === button.getAttribute("data-id"));
          if (!room || room.id === activeRoomId) return;
          try {
            const json = await postJson(ROOM_CHANGE_URL, authPayload({ targetRoomId: room.id }));
            if (json.status !== "approved" && json.direct !== true && !isDirectAuthorizedRoom(room)) {
              throw new Error("Sala non autorizzata senza approvazione.");
            }
            if (!setCurrentRoom(json.room || room)) {
              throw new Error("Risposta cambio sala non valida.");
            }
            closeModal();
            await refreshVisibleRoom(json.room || room, { reload: true, reloadDelayMs: 700 });
          } catch (err) {
            setModalError(root, err instanceof Error ? err.message : "Cambio sala non riuscito.");
          }
        });
      });
    } catch (err) {
      setModalError(root, err instanceof Error ? err.message : "Impossibile caricare le sale.");
    }
  }

  function renderIncomingRoomMoveApproval(request) {
    if (!request || state.activeApprovalRequestId === request.requestId) return;
    state.activeApprovalRequestId = request.requestId;
    const source = request.fromTableLabel || request.fromTableId || "Tavolo";
    const root = renderModalShell(
      "Richiesta cambio sala",
      [
        '<div class="mobile-table-groups-list">',
        `  <div class="mobile-table-groups-empty">${escapeHtml(request.requesterFullName || request.requesterUsername || "Un cameriere")} vuole spostare ${escapeHtml(source)} in ${escapeHtml(request.targetRoomName || "questa sala")}.</div>`,
        `  <div class="mobile-table-groups-empty">Destinazione: ${escapeHtml((request.targetTableLabels || []).join(", ") || "tavoli selezionati")}</div>`,
        "</div>",
        '<div class="mobile-table-groups-error" hidden></div>',
      ].join(""),
      [
        '<div class="mobile-table-groups-actions">',
        '  <button type="button" class="mobile-table-groups-confirm" data-role="reject">Rifiuta</button>',
        '  <button type="button" class="mobile-table-groups-confirm" data-role="approve">Approva</button>',
        "</div>",
      ].join(""),
      "Conferma cambio sala tavolo"
    );
    const resolve = async (approve) => {
      try {
        await postJson(ROOM_MOVE_RESOLVE_URL, authPayload({ requestId: request.requestId, approve }));
        state.activeApprovalRequestId = "";
        closeModal();
      } catch (err) {
        setModalError(root, err instanceof Error ? err.message : "Risposta non inviata.");
      }
    };
    root.querySelector('[data-role="reject"]')?.addEventListener("click", () => void resolve(false));
    root.querySelector('[data-role="approve"]')?.addEventListener("click", () => void resolve(true));
    root.querySelector('[data-role="close"]')?.addEventListener("click", () => {
      state.activeApprovalRequestId = "";
    });
  }

  async function pollIncomingRoomMoveRequests() {
    const auth = getAuth();
    if (!auth.token || !auth.userId || !auth.deviceUuid || !auth.roomId) return;
    if (document.getElementById("mobile-table-groups-modal")) return;
    try {
      const json = await postJson(ROOM_MOVE_PENDING_URL, authPayload({ roomId: auth.roomId }));
      const request = (Array.isArray(json.requests) ? json.requests : [])[0];
      if (request) renderIncomingRoomMoveApproval(request);
    } catch {
      // Il polling non deve disturbare l'operativita se il backend non risponde.
    }
  }

  function startPendingApprovalPoll() {
    if (state.pendingPoll) window.clearInterval(state.pendingPoll);
    state.pendingPoll = window.setInterval(() => {
      void pollIncomingRoomMoveRequests();
    }, ROOM_MOVE_POLL_MS);
    void pollIncomingRoomMoveRequests();
  }

  function renderSplitModal(rootId) {
    const group = groupByRoot(rootId);
    if (!group) return;
    const tablesById = tableMap(state.layout || {});
    const selectedKeys = new Set();
    let error = "";
    function setSplitError(root, message) {
      const errorBox = root.querySelector(".mobile-table-groups-error");
      if (!(errorBox instanceof HTMLElement)) return;
      errorBox.textContent = message || "";
      errorBox.hidden = !message;
    }
    function updateSplitSelectionUi(root) {
      const confirmButton = root.querySelector('[data-role="confirm"]');
      if (confirmButton instanceof HTMLButtonElement) {
        confirmButton.disabled = selectedKeys.size === 0;
      }
      root.querySelectorAll(".mobile-table-groups-row[data-key]").forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) return;
        const key = button.getAttribute("data-key") || "";
        const checked = selectedKeys.has(key);
        button.classList.toggle("is-selected", checked);
        button.setAttribute("aria-pressed", checked ? "true" : "false");
        const title = button.querySelector(".mobile-table-groups-row-title");
        if (title instanceof HTMLElement) {
          title.textContent = title.getAttribute("data-row-title") || "";
        }
        const marker = button.querySelector(".mobile-table-groups-select-mark");
        if (marker instanceof HTMLElement) {
          marker.innerHTML = checked ? "&#10003;" : "";
        }
      });
    }
    function render() {
      const root = document.getElementById("mobile-table-groups-modal") || document.createElement("div");
      root.id = "mobile-table-groups-modal";
      root.innerHTML = [
        '<div class="mobile-table-groups-backdrop">',
        '  <div class="mobile-table-groups-dialog" role="dialog" aria-modal="true" aria-label="Dividi tavolo">',
        '    <div class="mobile-table-groups-head">',
        '      <strong>Dividi tavolo</strong>',
        '      <button type="button" class="mobile-table-groups-close" data-role="close" aria-label="Chiudi">&times;</button>',
        "    </div>",
        '    <div class="mobile-table-groups-list">',
        group.children
          .map((child, index) => {
            const key = directNodeKey(child, index);
            const checked = selectedKeys.has(key);
            const title = splitRowTitle(child, tablesById);
            const leafList = splitRowLeafListHtml(child, tablesById);
            return [
              `<button type="button" class="mobile-table-groups-row ${checked ? "is-selected" : ""}" data-key="${escapeHtml(key)}" aria-pressed="${checked ? "true" : "false"}" data-no-logical-rewrite="true">`,
              '  <span class="mobile-table-groups-row-main">',
              `    <strong class="mobile-table-groups-row-title" data-row-title="${escapeHtml(title)}" data-no-logical-rewrite="true">${escapeHtml(title)}</strong>`,
              leafList,
              "  </span>",
              `  <span class="mobile-table-groups-select-mark" aria-hidden="true">${checked ? "&#10003;" : ""}</span>`,
              "</button>",
            ].join("");
          })
          .join(""),
        "    </div>",
        `    <div class="mobile-table-groups-error" ${error ? "" : "hidden"}>${escapeHtml(error)}</div>`,
        '    <div class="mobile-table-groups-actions">',
        `      <button type="button" class="mobile-table-groups-confirm" data-role="confirm" ${selectedKeys.size ? "" : "disabled"}>Dividi</button>`,
        "    </div>",
        "  </div>",
        "</div>",
      ].join("");
      if (!root.parentNode) document.body.appendChild(root);
      root.querySelector('[data-role="close"]')?.addEventListener("click", closeModal);
      root.querySelectorAll(".mobile-table-groups-row[data-key]").forEach((button) => {
        button.addEventListener("click", () => {
          const key = button.getAttribute("data-key") || "";
          if (selectedKeys.has(key)) selectedKeys.delete(key);
          else selectedKeys.add(key);
          error = "";
          setSplitError(root, "");
          updateSplitSelectionUi(root);
        });
      });
      root.querySelector('[data-role="confirm"]')?.addEventListener("click", async () => {
        try {
          await confirmSplit(rootId, selectedKeys);
          closeModal();
        } catch (err) {
          error = err instanceof Error ? err.message : "Divisione non riuscita.";
          setSplitError(root, error);
          updateSplitSelectionUi(root);
        }
      });
      updateSplitSelectionUi(root);
    }
    render();
  }

  async function confirmSplit(rootId, selectedKeys) {
    const groups = cloneJson(state.groups);
    const index = groups.findIndex((group) => group.id === rootId);
    if (index < 0) return;
    const group = groups.splice(index, 1)[0];
    const remaining = [];
    group.children.forEach((child, childIndex) => {
      const key = directNodeKey(child, childIndex);
      if (!selectedKeys.has(key)) remaining.push(child);
      else if (child.type === "complex") groups.push({ ...child, updatedAt: nowIso() });
    });
    if (remaining.length >= 2) {
      const rootStillInside = flattenLeafIds({ type: "complex", id: rootId, children: remaining }).includes(rootId);
      const nextRootId = rootStillInside ? rootId : flattenLeafIds(remaining[0])[0];
      groups.push({ id: nextRootId, type: "complex", children: remaining, updatedAt: nowIso() });
    } else if (remaining.length === 1 && remaining[0].type === "complex") {
      groups.push({ ...remaining[0], updatedAt: nowIso() });
    }
    await saveGroups(groups);
  }

  function handleLongPress(event) {
    if (!(event.target instanceof Element)) return;
    const tile = event.target.closest(".tables-grid .table-tile");
    if (!(tile instanceof HTMLElement)) return;
    annotateGrid();
    const table = state.tileMap.get(tile);
    if (!table) return;
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
    let cancelled = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      state.suppressClickUntil = Date.now() + 700;
      event.preventDefault();
      event.stopPropagation();
      renderContextMenu(table);
    }, LONG_PRESS_MS);
    const cleanup = () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("pointerup", cleanup, true);
      window.removeEventListener("pointercancel", cleanup, true);
      window.removeEventListener("pointermove", onMove, true);
    };
    const onMove = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 14 || Math.abs(moveEvent.clientY - startY) > 14) {
        cleanup();
      }
    };
    window.addEventListener("pointerup", cleanup, true);
    window.addEventListener("pointercancel", cleanup, true);
    window.addEventListener("pointermove", onMove, true);
  }

  function handleRoomTitleLongPress(event) {
    if (!(event.target instanceof Element)) return;
    const title = event.target.closest(".tables-title, .tables-title-wrap");
    if (!(title instanceof HTMLElement)) return;
    if (!title.closest(".tables-shell")) return;
    let cancelled = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      state.suppressClickUntil = Date.now() + 700;
      event.preventDefault();
      event.stopPropagation();
      void renderRoomSwitchModal();
    }, LONG_PRESS_MS);
    const cleanup = () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("pointerup", cleanup, true);
      window.removeEventListener("pointercancel", cleanup, true);
      window.removeEventListener("pointermove", onMove, true);
    };
    const onMove = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 14 || Math.abs(moveEvent.clientY - startY) > 14) {
        cleanup();
      }
    };
    window.addEventListener("pointerup", cleanup, true);
    window.addEventListener("pointercancel", cleanup, true);
    window.addEventListener("pointermove", onMove, true);
  }

  document.addEventListener("pointerdown", handleLongPress, true);
  document.addEventListener("pointerdown", handleRoomTitleLongPress, true);
  document.addEventListener(
    "click",
    (event) => {
      if (Date.now() <= state.suppressClickUntil && event.target instanceof Element && event.target.closest(".tables-grid .table-tile")) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  const observer = new MutationObserver(scheduleApply);
  function start() {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    void loadGroups(false).then(scheduleApply);
    startPendingApprovalPoll();
  }

  window.addEventListener("mobile:table-groups-updated", scheduleApply);
  window.addEventListener("focus", () => void loadGroups(true).then(scheduleApply));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
