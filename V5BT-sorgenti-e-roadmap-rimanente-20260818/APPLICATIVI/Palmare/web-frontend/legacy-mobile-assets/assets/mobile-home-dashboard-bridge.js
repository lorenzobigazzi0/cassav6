(function () {
  if (window.__mobileHomeDashboardBridgeInstalled === true) return;
  window.__mobileHomeDashboardBridgeInstalled = true;

  const AUTH_KEYS = {
    token: "pos_token",
    userId: "pos_user_id",
    username: "pos_user",
    fullName: "pos_full_name",
    role: "pos_role",
    permissions: "pos_permissions",
    deviceUuid: "pos_device_uuid",
    roomId: "pos_room_id",
    roomName: "pos_room_name",
  };
  const QUICK_FILTER_KEY = "mobile:dashboard:quick-filter";
  const QUICK_FILTER_APPLIED_KEY = "mobile:dashboard:quick-filter-applied";
  const STYLE_CLASS_HIDDEN = "mobile-dashboard-table-hidden";
  const POLL_MS = 8000;
  const FETCH_TIMEOUT_MS = 7000;
  const QUICK_FILTER_RETRY_MS = 140;
  const QUICK_FILTER_MAX_RETRIES = 24;
  const REFRESH_DEBOUNCE_MS = 36;
  const HOME_BOOTSTRAP_MS = 1600;
  const HOME_REFRESH_MIN_MS = 1500;
  const state = {
    homeMarkup: "",
    homeRoomId: "",
    homeRoomName: "",
    settingsMounted: false,
    pollHandle: null,
    startDone: false,
    homeLoading: null,
    lastHomeFetchAt: 0,
    refreshTimer: null,
    observerMutedUntil: 0,
    quickFilterTimer: null,
    quickFilterRetries: 0,
    quickFilterPending: "",
    homeBootstrapUntil: 0,
  };

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

  function writeSession(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // noop
    }
  }

  function removeSession(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // noop
    }
  }

  function parsePermissions(raw) {
    try {
      const parsed = JSON.parse(String(raw || "[]"));
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function getAuth() {
    return {
      token: String(readStorage(AUTH_KEYS.token) || "").trim(),
      userId: String(readStorage(AUTH_KEYS.userId) || "").trim(),
      username: String(readStorage(AUTH_KEYS.username) || "").trim(),
      fullName: String(readStorage(AUTH_KEYS.fullName) || "").trim(),
      role: String(readStorage(AUTH_KEYS.role) || "").trim().toLowerCase(),
      permissions: parsePermissions(readStorage(AUTH_KEYS.permissions)),
      deviceUuid: String(readStorage(AUTH_KEYS.deviceUuid) || "").trim(),
      roomId: String(readStorage(AUTH_KEYS.roomId) || "").trim(),
      roomName: String(readStorage(AUTH_KEYS.roomName) || "").trim(),
    };
  }

  function isAdmin(auth) {
    return auth.role === "admin" || auth.permissions.includes("manage_users");
  }

  function shouldUseHomeDashboard(auth) {
    return !!auth.token;
  }

  function hasCollectPermissions(auth) {
    return auth.permissions.includes("collect_payments");
  }

  function formatCurrency(amount) {
    const value = Number(amount) || 0;
    try {
      return new Intl.NumberFormat("it-IT", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} EUR`;
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

  async function fetchJson(url, init) {
    const controller =
      typeof AbortController === "function"
        ? new AbortController()
        : null;
    const requestInit = {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    };
    if (controller && !requestInit.signal) {
      requestInit.signal = controller.signal;
    }
    const timeoutId =
      controller !== null
        ? window.setTimeout(() => {
            controller.abort();
          }, FETCH_TIMEOUT_MS)
        : 0;
    try {
      const response = await fetch(url, requestInit);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        const message =
          (payload && (payload.error || payload.message) && String(payload.error || payload.message).trim()) ||
          "Richiesta non riuscita.";
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        throw new Error("Timeout richiesta.");
      }
      throw error;
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  function isVisible(element) {
    return !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  function currentHomeCardBody() {
    const candidates = Array.from(document.querySelectorAll(".home-view.view-home .home-card .card-body"));
    if (!candidates.length) return null;
    return (
      candidates.find((element) => {
        const view = element.closest(".home-view.view-home");
        if (!view) return false;
        const ariaHidden = String(view.getAttribute("aria-hidden") || "").trim().toLowerCase();
        if (ariaHidden === "true" || view.classList.contains("is-hidden")) return false;
        return isVisible(view) || isVisible(element);
      }) ||
      candidates.find(isVisible) ||
      candidates[0] ||
      null
    );
  }

  function setDashboardMode(auth) {
    const mode = shouldUseHomeDashboard(auth) ? "operator" : "off";
    document.body.setAttribute("data-mobile-dashboard-mode", mode);
  }

  function currentSettingsScrollArea() {
    const path = String(window.location.pathname || "").toLowerCase();
    if (!/\/settings$/.test(path)) return null;
    return (
      Array.from(document.querySelectorAll(".settings-page .settings-scroll-area, .settings-shell .settings-scroll-area")).find(isVisible) ||
      null
    );
  }

  function currentTablesShell() {
    return Array.from(document.querySelectorAll(".home-view.view-tavoli .tables-shell")).find(isVisible) || null;
  }

  function currentTablesView() {
    return Array.from(document.querySelectorAll(".home-view.view-tavoli")).find(isVisible) || null;
  }

  function readQuickFilter() {
    return String(readStorage(QUICK_FILTER_KEY) || "").trim();
  }

  function clearQuickFilter() {
    removeSession(QUICK_FILTER_KEY);
    removeSession(QUICK_FILTER_APPLIED_KEY);
    state.quickFilterPending = "";
    state.quickFilterRetries = 0;
    if (state.quickFilterTimer !== null) {
      window.clearTimeout(state.quickFilterTimer);
      state.quickFilterTimer = null;
    }
    cleanupForcedTableFilter();
  }

  function muteObserver(ms) {
    state.observerMutedUntil = Date.now() + Math.max(0, Number(ms) || 0);
  }

  function observerIsMuted() {
    return Date.now() < state.observerMutedUntil;
  }

  function tableNumberFromTile(tile) {
    const title = tile.querySelector(".table-title");
    const match = /(\d+)/.exec(String(title?.textContent || ""));
    return match ? Number(match[1]) : null;
  }

  function cleanupForcedTableFilter() {
    muteObserver(200);
    document.querySelectorAll(`.${STYLE_CLASS_HIDDEN}`).forEach((tile) => {
      tile.classList.remove(STYLE_CLASS_HIDDEN);
    });
    document.querySelectorAll(".tables-legend-item.is-mobile-dashboard-active").forEach((button) => {
      button.classList.remove("is-mobile-dashboard-active");
    });
    const badge = document.getElementById("mobile-dashboard-filter-badge");
    if (badge) badge.remove();
  }

  function buildQuickFilterBadge(filterLabel) {
    const badge = document.createElement("div");
    badge.id = "mobile-dashboard-filter-badge";
    badge.className = "mobile-dashboard-filter-badge";
    badge.innerHTML = `
      <span>Filtro rapido: ${escapeHtml(filterLabel)}</span>
      <button type="button" class="smallbtn mobile-dashboard-filter-clear">Mostra tutto</button>
    `;
    const clearButton = badge.querySelector(".mobile-dashboard-filter-clear");
    if (clearButton) {
      clearButton.addEventListener("click", () => {
        clearQuickFilter();
      });
    }
    return badge;
  }

  function activeLegendButton(shell, filter) {
    const selector =
      filter === "free"
        ? ".tables-legend-item.state-free"
        : filter === "payment_due"
          ? ".tables-legend-item.state-payment_due"
          : filter === "ordering"
            ? ".tables-legend-item.state-ordering"
            : "";
    return selector ? shell.querySelector(selector) : null;
  }

  function filterLabel(filter) {
    if (filter === "free") return "Liberi";
    if (filter === "payment_due") return "Da riscuotere";
    if (filter === "ordering") return "Ordine attivo";
    return "Attivo";
  }

  function shouldKeepTile(tile, filter) {
    if (filter === "free") return tile.classList.contains("state-free");
    if (filter === "payment_due") return tile.classList.contains("state-payment_due");
    if (filter === "ordering") return tile.classList.contains("state-ordering");
    return true;
  }

  function applyForcedTableFilter() {
    const shell = currentTablesShell();
    const filter = readQuickFilter();
    if (!filter || !shell) return false;

    muteObserver(240);
    cleanupForcedTableFilter();

    const grid = shell.querySelector(".tables-grid-scroll");
    const tiles = Array.from(shell.querySelectorAll(".table-tile"));
    if (!grid || !tiles.length) return false;

    tiles.forEach((tile) => {
      if (!shouldKeepTile(tile, filter)) {
        tile.classList.add(STYLE_CLASS_HIDDEN);
      }
    });

    const legendButton = activeLegendButton(shell, filter);
    if (legendButton) {
      legendButton.classList.add("is-mobile-dashboard-active");
    }

    const badgeHost = shell.querySelector(".tables-search-wrap") || shell.querySelector(".tables-head") || shell;
    if (badgeHost && !document.getElementById("mobile-dashboard-filter-badge")) {
      badgeHost.appendChild(buildQuickFilterBadge(filterLabel(filter)));
    }

    writeSession(QUICK_FILTER_APPLIED_KEY, "1");
    return true;
  }

  function handleQuickFilterLifecycle() {
    const tablesShell = currentTablesShell();
    const filter = readQuickFilter();
    const applied = readStorage(QUICK_FILTER_APPLIED_KEY) === "1";
    if (tablesShell && filter) {
      if (!applyForcedTableFilter()) {
        scheduleQuickFilterApply(QUICK_FILTER_RETRY_MS);
      } else {
        state.quickFilterPending = "";
        state.quickFilterRetries = 0;
      }
      return;
    }
    if (!tablesShell && applied && !state.quickFilterPending) {
      clearQuickFilter();
    }
  }

  function switchToTablesTab() {
    const button = Array.from(document.querySelectorAll(".bottom-btn")).find((entry) => {
      const label = String(entry.getAttribute("aria-label") || entry.title || "").trim().toLowerCase();
      return label === "tavoli";
    });
    if (button) {
      if (
        button.classList.contains("is-active") ||
        String(button.getAttribute("aria-current") || "").trim().toLowerCase() === "page" ||
        String(button.getAttribute("data-state") || "").trim().toLowerCase() === "active"
      ) {
        return true;
      }
      button.click();
      return true;
    }
    return false;
  }

  function scheduleQuickFilterApply(delayMs) {
    if (state.quickFilterTimer !== null) {
      window.clearTimeout(state.quickFilterTimer);
    }
    state.quickFilterTimer = window.setTimeout(() => {
      state.quickFilterTimer = null;
      const filter = readQuickFilter();
      if (!filter) {
        state.quickFilterPending = "";
        state.quickFilterRetries = 0;
        return;
      }
      if (applyForcedTableFilter()) {
        state.quickFilterPending = "";
        state.quickFilterRetries = 0;
        return;
      }
      state.quickFilterRetries += 1;
      if (state.quickFilterRetries >= QUICK_FILTER_MAX_RETRIES) {
        state.quickFilterPending = "";
        state.quickFilterRetries = 0;
        return;
      }
      switchToTablesTab();
      scheduleQuickFilterApply(QUICK_FILTER_RETRY_MS);
    }, Math.max(0, Number(delayMs) || 0));
  }

  function activateQuickFilter(filter) {
    if (!filter) return;
    writeSession(QUICK_FILTER_KEY, filter);
    removeSession(QUICK_FILTER_APPLIED_KEY);
    state.quickFilterPending = filter;
    state.quickFilterRetries = 0;
    switchToTablesTab();
    scheduleQuickFilterApply(40);
  }

  function homeDashboardSkeletonMarkup(roomName) {
    return `
      <div class="mobile-dashboard-shell is-loading" aria-busy="true">
        <section class="mobile-dashboard-room-card is-loading">
          <span class="mobile-dashboard-room-eyebrow">Sala attuale</span>
          <strong class="mobile-dashboard-room-name">${escapeHtml(roomName || "Caricamento sala")}</strong>
          <span class="mobile-dashboard-room-meta">Aggiornamento cruscotto in corso</span>
        </section>
        <div class="mobile-dashboard-grid">
          <div class="mobile-dashboard-widget is-loading"><span class="mobile-dashboard-widget-eyebrow">Tavoli liberi</span><strong>--</strong><span class="mobile-dashboard-widget-meta">Attendi un istante</span></div>
          <div class="mobile-dashboard-widget is-loading"><span class="mobile-dashboard-widget-eyebrow">Da riscuotere</span><strong>--</strong><span class="mobile-dashboard-widget-meta">Attendi un istante</span></div>
          <div class="mobile-dashboard-widget is-loading"><span class="mobile-dashboard-widget-eyebrow">Ordini in attesa</span><strong>--</strong><span class="mobile-dashboard-widget-meta">Attendi un istante</span></div>
          <div class="mobile-dashboard-widget is-loading"><span class="mobile-dashboard-widget-eyebrow">Tavoli in arrivo</span><strong>--</strong><span class="mobile-dashboard-widget-meta">Attendi un istante</span></div>
        </div>
      </div>
    `;
  }

  function ensureDashboardHost(body) {
    if (!body) return;
    body.setAttribute("data-mobile-dashboard-host", "1");
    body.parentElement?.classList.add("workspace-card", "mobile-dashboard-card");
    body.parentElement?.setAttribute("data-mobile-dashboard", "true");
  }

  function hasLoadingDashboard(body) {
    return !!body?.querySelector(".mobile-dashboard-shell.is-loading");
  }

  function restoreCachedHomeDashboard(body) {
    if (!body || !state.homeMarkup) return false;
    const shouldReplace = hasLoadingDashboard(body) || !body.querySelector(".mobile-dashboard-shell");
    if (shouldReplace) {
      muteObserver(180);
      body.innerHTML = state.homeMarkup;
    }
    ensureDashboardHost(body);
    attachDashboardActions(body);
    return true;
  }

  function ensureOperatorHomeSkeleton(auth) {
    const body = currentHomeCardBody();
    if (!body || !shouldUseHomeDashboard(auth)) return;
    if (restoreCachedHomeDashboard(body)) return;
    if (body.querySelector(".mobile-dashboard-shell")) return;
    muteObserver(180);
    ensureDashboardHost(body);
    body.innerHTML = homeDashboardSkeletonMarkup(auth.roomName || state.homeRoomName || "Sala");
  }

  function homeDashboardMarkup(metrics, canCollect) {
    const paymentWidget = canCollect
      ? `
        <button type="button" class="mobile-dashboard-widget is-collect" data-dashboard-filter="payment_due">
          <span class="mobile-dashboard-widget-eyebrow">Da riscuotere</span>
          <strong>${metrics.paymentDueCount}</strong>
          <span class="mobile-dashboard-widget-meta">
            ${metrics.paymentDueCount === 1 ? "1 tavolo" : `${metrics.paymentDueCount} tavoli`} · ${escapeHtml(metrics.paymentDueAmountLabel)}
          </span>
        </button>
      `
      : "";
    return `
      <div class="mobile-dashboard-shell" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:stretch;width:100%;">
        <section class="mobile-dashboard-room-card">
          <span class="mobile-dashboard-room-eyebrow">Sala attuale</span>
          <strong class="mobile-dashboard-room-name">${escapeHtml(metrics.roomName)}</strong>
          <span class="mobile-dashboard-room-meta">${metrics.totalTables} tavoli configurati</span>
        </section>
        <div class="mobile-dashboard-grid" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;width:100%;">
          <button type="button" class="mobile-dashboard-widget is-free" data-dashboard-filter="free">
            <span class="mobile-dashboard-widget-eyebrow">Tavoli liberi</span>
            <strong>${metrics.freeCount}</strong>
            <span class="mobile-dashboard-widget-meta">${metrics.freeCount === 1 ? "1 tavolo libero" : `${metrics.freeCount} tavoli liberi`}</span>
          </button>
          ${paymentWidget}
          <button type="button" class="mobile-dashboard-widget is-ordering" data-dashboard-filter="ordering">
            <span class="mobile-dashboard-widget-eyebrow">Ordini in attesa</span>
            <strong>${metrics.orderingCount}</strong>
            <span class="mobile-dashboard-widget-meta">
              ${metrics.orderingCount === 1 ? "1 tavolo con ordine attivo" : `${metrics.orderingCount} tavoli con ordine attivo`}
            </span>
          </button>
          <div class="mobile-dashboard-widget is-arrivals ${metrics.arrivalsCount > 0 ? "has-arrivals" : ""}">
            <span class="mobile-dashboard-widget-eyebrow">Tavoli in arrivo</span>
            <strong>${metrics.arrivalsCount}</strong>
            <span class="mobile-dashboard-widget-meta">
              ${metrics.arrivalsCount === 1 ? "1 tavolo atteso da prenotazione" : `${metrics.arrivalsCount} tavoli attesi da prenotazione`}
            </span>
          </div>
        </div>
      </div>
    `;
  }

  function attachDashboardActions(host) {
    host.querySelectorAll("[data-dashboard-filter]").forEach((button) => {
      if (button.getAttribute("data-dashboard-bound") === "1") return;
      button.setAttribute("data-dashboard-bound", "1");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const filter = String(button.getAttribute("data-dashboard-filter") || "").trim();
        if (filter) activateQuickFilter(filter);
      });
    });
  }

  async function fetchHomeMetrics() {
    const auth = getAuth();
    const layoutPayload = await fetchJson(`/api/integration/layout?_=${Date.now()}`);
    const rooms = Array.isArray(layoutPayload.rooms) ? layoutPayload.rooms : [];
    const tables = Array.isArray(layoutPayload.tables) ? layoutPayload.tables : [];
    const room =
      rooms.find((entry) => String(entry.id || "").trim() === auth.roomId) ||
      rooms.find((entry) => String(entry.name || "").trim() === auth.roomName) ||
      rooms[0] ||
      null;

    const roomId = String(room?.id || auth.roomId || "").trim();
    const roomName = String(room?.name || auth.roomName || "Sala non assegnata").trim();
    const roomTables = tables.filter((entry) => String(entry.roomId || "").trim() === roomId);
    const freeTables = roomTables.filter((entry) => String(entry.occupancyState || "").trim() === "free");
    const dueTables = roomTables.filter((entry) => Number(entry.amountDue) > 0);
    const orderingTables = roomTables.filter((entry) => Number(entry.ordersInProgress) > 0);

    let arrivalsCount = 0;
    if (auth.token && auth.userId && auth.deviceUuid && roomId) {
      try {
        const reservationsPayload = await fetchJson(`/api/pos/reservations/list?_=${Date.now()}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            token: auth.token,
            userId: auth.userId,
            deviceUuid: auth.deviceUuid,
            roomId,
            serviceDate: new Date().toISOString().slice(0, 10),
          }),
        });
        const reservationTables = new Set();
        const now = Date.now();
        const reservations = Array.isArray(reservationsPayload.reservations)
          ? reservationsPayload.reservations
          : [];
        reservations.forEach((entry) => {
          const assignedTableId = String(entry?.assignedTableId || "").trim();
          const reservationAt = Number(entry?.reservationAt);
          if (!assignedTableId || !Number.isFinite(reservationAt)) return;
          if (reservationAt > now) {
            reservationTables.add(assignedTableId);
          }
        });
        arrivalsCount = reservationTables.size;
      } catch {
        arrivalsCount = 0;
      }
    }

    return {
      roomId,
      roomName,
      totalTables: roomTables.length,
      freeCount: freeTables.length,
      paymentDueCount: dueTables.length,
      paymentDueAmountLabel: formatCurrency(
        dueTables.reduce((sum, entry) => sum + (Number(entry.amountDue) || 0), 0)
      ),
      orderingCount: orderingTables.length,
      arrivalsCount,
    };
  }

  async function renderOperatorHomeDashboard() {
    const auth = getAuth();
    if (!shouldUseHomeDashboard(auth)) return;
    const body = currentHomeCardBody();
    if (!body) return;
    const restoredFromCache = restoreCachedHomeDashboard(body);
    if (!restoredFromCache) {
      ensureOperatorHomeSkeleton(auth);
    }
    const liveBody = currentHomeCardBody();
    if (!liveBody) return;
    if (
      state.homeMarkup &&
      !hasLoadingDashboard(liveBody) &&
      Date.now() - state.lastHomeFetchAt < HOME_REFRESH_MIN_MS
    ) {
      return;
    }
    if (state.homeLoading) {
      await state.homeLoading;
      return;
    }
    state.homeLoading = (async () => {
      try {
        const metrics = await fetchHomeMetrics();
        const markup = homeDashboardMarkup(metrics, hasCollectPermissions(auth));
        const liveBody = currentHomeCardBody();
        if (!liveBody) return;
        const hasRenderedDashboard = !!liveBody.querySelector(".mobile-dashboard-shell");
        if (markup === state.homeMarkup && metrics.roomId === state.homeRoomId && hasRenderedDashboard) {
          state.lastHomeFetchAt = Date.now();
          if (hasLoadingDashboard(liveBody)) {
            restoreCachedHomeDashboard(liveBody);
          } else {
            ensureDashboardHost(liveBody);
            attachDashboardActions(liveBody);
          }
          return;
        }
        muteObserver(240);
        liveBody.innerHTML = markup;
        ensureDashboardHost(liveBody);
        attachDashboardActions(liveBody);
        state.homeMarkup = markup;
        state.homeRoomId = metrics.roomId;
        state.homeRoomName = metrics.roomName;
        state.lastHomeFetchAt = Date.now();
      } catch {
        // noop: keep existing UI if dashboard data cannot load
      } finally {
        state.homeLoading = null;
      }
    })();
    await state.homeLoading;
  }

  function isHomeButtonTarget(target) {
    const button = target instanceof Element ? target.closest(".bottom-btn") : null;
    if (!button) return false;
    const label = String(button.getAttribute("aria-label") || button.title || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return label === "home";
  }

  function scheduleHomeBootstrap() {
    const auth = getAuth();
    if (!shouldUseHomeDashboard(auth)) return;
    state.homeBootstrapUntil = Date.now() + HOME_BOOTSTRAP_MS;
    state.lastHomeFetchAt = 0;
    const pump = () => {
      if (Date.now() > state.homeBootstrapUntil) return;
      refreshUi();
      const body = currentHomeCardBody();
      if (!body || !body.querySelector(".mobile-dashboard-shell")) {
        window.requestAnimationFrame(pump);
      }
    };
    window.requestAnimationFrame(pump);
  }

  function cleanupLegacyAdminControls() {
    document.querySelectorAll('[id^="mobile-admin-"]').forEach((group) => {
      if (group.id.includes("sim")) group.remove();
    });
  }

  function currentMenuBrowserHead() {
    return Array.from(document.querySelectorAll(".home-view.view-menu .menu-browser-head")).find(isVisible) || null;
  }

  function currentMenuToolbar() {
    return Array.from(document.querySelectorAll(".home-view.view-menu .menu-toolbar")).find(isVisible) || null;
  }

  function currentNativeMenuBackButton() {
    return (
      Array.from(document.querySelectorAll(".home-view.view-menu .menu-back-btn")).find(
        (button) => button instanceof HTMLButtonElement
      ) || null
    );
  }

  function cleanupInlineMenuBackButton(activeHost) {
    document.querySelectorAll(".mobile-menu-inline-back").forEach((button) => {
      if (activeHost && button.parentElement === activeHost) return;
      button.remove();
    });
    document.querySelectorAll(".mobile-menu-inline-back-host, .mobile-menu-inline-back-head").forEach((host) => {
      if (host === activeHost) return;
      host.classList.remove("mobile-menu-inline-back-host", "mobile-menu-inline-back-head");
    });
  }

  function ensureInlineMenuBackButton() {
    const toolbar = currentMenuToolbar();
    const nativeBackButton = currentNativeMenuBackButton();
    const browserHead = currentMenuBrowserHead();
    const host = nativeBackButton ? toolbar || browserHead : null;

    cleanupInlineMenuBackButton(host);
    if (!(nativeBackButton instanceof HTMLButtonElement) || !host) return;

    let button = host.querySelector(".mobile-menu-inline-back");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "smallbtn mobile-menu-inline-back";
      button.setAttribute("aria-label", "Torna al livello precedente");
      button.setAttribute("title", "Indietro");
      button.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 18l-6-6 6-6"></path>
        </svg>
      `;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const targetButton = currentNativeMenuBackButton();
        if (targetButton instanceof HTMLButtonElement) {
          targetButton.click();
        }
      });
    }

    if (toolbar) {
      host.classList.add("mobile-menu-inline-back-host");
      host.classList.remove("mobile-menu-inline-back-head");
      if (host.firstElementChild !== button) {
        host.insertBefore(button, host.firstChild);
      }
    } else {
      host.classList.add("mobile-menu-inline-back-head");
      host.classList.remove("mobile-menu-inline-back-host");
      if (host.firstElementChild !== button) {
        host.insertBefore(button, host.firstChild);
      }
    }

    button.disabled = false;
    button.classList.remove("is-disabled");
  }

  function forceConsultMenuOnly() {
    const row = document.querySelector(".menu-nav-row");
    if (!row) return;
    const activeManageButton = row.querySelector(".menu-view-switch-btn.is-active:last-child");
    const consultButton = Array.from(row.querySelectorAll(".menu-view-switch-btn")).find((button) =>
      /consulta/i.test(String(button.textContent || ""))
    );
    if (activeManageButton && consultButton) {
      consultButton.click();
    }
  }

  function handlePointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (isHomeButtonTarget(target)) {
      scheduleHomeBootstrap();
    }
    if (target.closest(".tables-legend-item") || target.closest(".tables-search input")) {
      clearQuickFilter();
    }
  }

  function refreshUi() {
    const auth = getAuth();
    setDashboardMode(auth);
    if (shouldUseHomeDashboard(auth)) {
      ensureOperatorHomeSkeleton(auth);
      void renderOperatorHomeDashboard();
    }
    if (auth.token && isAdmin(auth)) {
      cleanupLegacyAdminControls();
    }
    forceConsultMenuOnly();
    ensureInlineMenuBackButton();
    handleQuickFilterLifecycle();
  }

  function startPolling() {
    if (state.pollHandle !== null) return;
    state.pollHandle = window.setInterval(() => {
      refreshUi();
    }, POLL_MS);
  }

  function start() {
    if (state.startDone) return;
    state.startDone = true;
    const observer = new MutationObserver(() => {
      if (observerIsMuted()) return;
      if (state.refreshTimer !== null) {
        window.clearTimeout(state.refreshTimer);
      }
      state.refreshTimer = window.setTimeout(() => {
        state.refreshTimer = null;
        refreshUi();
      }, REFRESH_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !isHomeButtonTarget(target)) return;
        scheduleHomeBootstrap();
      },
      true
    );
    window.addEventListener("focus", refreshUi);
    window.addEventListener("pageshow", refreshUi);
    window.addEventListener("popstate", refreshUi);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        refreshUi();
      }
    });
    refreshUi();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
