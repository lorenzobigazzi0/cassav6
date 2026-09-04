(function () {
  if (window.__mobileMenuAvailabilityBridgeInstalled === true) return;
  window.__mobileMenuAvailabilityBridgeInstalled = true;

  const POLL_MS = 3000;
  const ORDER_STATION = "BAR PRINCIPALE";
  const state = {
    itemsByName: new Map(),
    loading: null,
    queued: false,
  };

  const AUTH_KEYS = {
    token: "pos_token",
    userId: "pos_user_id",
    username: "pos_user",
    fullName: "pos_full_name",
    deviceUuid: "pos_device_uuid",
    roomId: "pos_room_id",
    roomName: "pos_room_name",
  };

  function safeText(value) {
    return String(value ?? "").trim();
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

  function getAuth() {
    return {
      token: safeText(readStorage(AUTH_KEYS.token)),
      userId: safeText(readStorage(AUTH_KEYS.userId)),
      username: safeText(readStorage(AUTH_KEYS.username)),
      fullName: safeText(readStorage(AUTH_KEYS.fullName)),
      deviceUuid: safeText(readStorage(AUTH_KEYS.deviceUuid)),
      roomId: safeText(readStorage(AUTH_KEYS.roomId)),
      roomName: safeText(readStorage(AUTH_KEYS.roomName)),
    };
  }

  function hasMobileSession() {
    const auth = getAuth();
    return Boolean(auth.token && auth.deviceUuid);
  }

  function withMobileAuth(url, init) {
    const auth = getAuth();
    const nextUrl = new URL(url, window.location.origin);
    if (auth.token && !nextUrl.searchParams.has("token")) nextUrl.searchParams.set("token", auth.token);
    if (auth.userId && !nextUrl.searchParams.has("userId")) nextUrl.searchParams.set("userId", auth.userId);
    if (auth.username && !nextUrl.searchParams.has("username")) nextUrl.searchParams.set("username", auth.username);
    if (auth.fullName && !nextUrl.searchParams.has("fullName")) nextUrl.searchParams.set("fullName", auth.fullName);
    if (auth.deviceUuid && !nextUrl.searchParams.has("deviceUuid")) nextUrl.searchParams.set("deviceUuid", auth.deviceUuid);
    if (auth.roomId && !nextUrl.searchParams.has("roomId")) nextUrl.searchParams.set("roomId", auth.roomId);
    if (auth.roomName && !nextUrl.searchParams.has("roomName")) nextUrl.searchParams.set("roomName", auth.roomName);
    if (!nextUrl.searchParams.has("clientApp")) nextUrl.searchParams.set("clientApp", "mobile-frontend");

    const headers = new Headers((init && init.headers) || undefined);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (auth.token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.token}`);
    if (auth.userId && !headers.has("X-User-Id")) headers.set("X-User-Id", auth.userId);
    if (auth.username && !headers.has("X-Username")) headers.set("X-Username", auth.username);
    if (auth.deviceUuid && !headers.has("X-Device-Uuid")) headers.set("X-Device-Uuid", auth.deviceUuid);
    if (!headers.has("X-Client-App")) headers.set("X-Client-App", "mobile-frontend");

    return {
      url: `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      init: { ...(init || {}), headers },
    };
  }

  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function menuRows() {
    return Array.from(
      document.querySelectorAll(
        "button.menu-product-row, button.table-order-product-row:not(.is-custom)"
      )
    );
  }

  function findNameNode(row) {
    return row.querySelector(".menu-product-name, .table-order-product-name");
  }

  function buildAvailabilityEntry(record) {
    return {
      available: record?.available !== false,
      scope: String(record?.availabilityScope ?? "").trim().toLowerCase(),
      stations: Array.isArray(record?.unavailableStations)
        ? record.unavailableStations.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : [],
    };
  }

  async function loadAvailability() {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        if (!hasMobileSession()) {
          return;
        }
        const request = withMobileAuth(
          `/api/integration/menu?station=${encodeURIComponent(ORDER_STATION)}&_=${Date.now()}`,
          {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          }
        );
        const response = await fetch(request.url, request.init);
        const json = await response.json().catch(() => null);
        if (!response.ok || !json || json.ok !== true) {
          return;
        }
        const nextMap = new Map();
        const items = Array.isArray(json.products) ? json.products : [];
        items.forEach((item) => {
          const key = normalizeName(item?.name);
          if (!key) return;
          nextMap.set(key, buildAvailabilityEntry(item));
        });
        state.itemsByName = nextMap;
      } catch {
        // noop
      } finally {
        state.loading = null;
      }
    })();
    return state.loading;
  }

  function clearRowUi(row) {
    row.classList.remove("is-station-limited", "is-global-terminated");
    row.removeAttribute("aria-disabled");
    row.disabled = false;
    const chips = row.querySelectorAll(".mobile-menu-availability-chip");
    chips.forEach((chip) => chip.remove());
    const note = row.querySelector(".mobile-menu-availability-note");
    if (note) note.remove();
  }

  function ensurePreview(row) {
    const preview = row.querySelector(".menu-product-preview");
    return (
      preview ||
      row.querySelector(".menu-product-main") ||
      row.querySelector(".table-order-product-meta") ||
      row
    );
  }

  function appendChip(host, label, extraClass) {
    const chip = document.createElement("span");
    chip.className = `mobile-menu-availability-chip ${extraClass}`.trim();
    chip.textContent = label;
    host.appendChild(chip);
  }

  function appendNote(row, label) {
    const note = document.createElement("span");
    note.className = "mobile-menu-availability-note";
    note.textContent = label;
    note.title = label;
    row.appendChild(note);
  }

  function applyRowUi(row) {
    clearRowUi(row);
    const nameNode = findNameNode(row);
    const key = normalizeName(nameNode?.textContent);
    if (!key) return;
    const availability = state.itemsByName.get(key);
    if (!availability) return;
    const preview = ensurePreview(row);
    const hasNativeOffBadge = !!row.querySelector(".table-order-product-badge.is-off");

    if (availability.available === false || availability.scope === "global") {
      row.classList.add("is-global-terminated");
      row.setAttribute("aria-disabled", "true");
      row.disabled = true;
      if (!hasNativeOffBadge) {
        appendChip(preview, "TERMINATO", "is-terminated");
      }
      return;
    }

    if (availability.scope === "station" && availability.stations.length > 0) {
      row.classList.add("is-station-limited");
      appendChip(preview, "ATTENZIONE", "is-warning");
      appendNote(row, `Non disponibile: ${availability.stations.join(", ")}`);
    }
  }

  function applyAll() {
    menuRows().forEach((row) => {
      applyRowUi(row);
    });
  }

  function scheduleApply() {
    if (state.queued) return;
    state.queued = true;
    window.requestAnimationFrame(() => {
      state.queued = false;
      applyAll();
    });
  }

  async function refreshAndApply() {
    await loadAvailability();
    scheduleApply();
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      const row =
        event.target instanceof Element
          ? event.target.closest(
              "button.menu-product-row, button.table-order-product-row:not(.is-custom)"
            )
          : null;
      if (row && row.classList.contains("is-global-terminated")) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      const row =
        event.target instanceof Element
          ? event.target.closest(
              "button.menu-product-row, button.table-order-product-row:not(.is-custom)"
            )
          : null;
      if (row && row.classList.contains("is-global-terminated")) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  const observer = new MutationObserver(() => {
    scheduleApply();
  });

  function start() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    void refreshAndApply();
    window.setInterval(() => {
      void refreshAndApply();
    }, POLL_MS);
  }

  window.addEventListener("focus", () => {
    void refreshAndApply();
  });
  window.addEventListener("load", start, { once: true });
  if (document.readyState === "complete" || document.readyState === "interactive") {
    start();
  }
})();
