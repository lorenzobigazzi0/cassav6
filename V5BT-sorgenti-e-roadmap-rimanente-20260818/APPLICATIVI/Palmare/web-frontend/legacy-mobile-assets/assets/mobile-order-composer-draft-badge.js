(function mobileOrderComposerDraftBadgeBootstrap() {
  if (window.__mobileOrderComposerDraftBadgeInitialized) {
    return;
  }

  window.__mobileOrderComposerDraftBadgeInitialized = true;

  var CATALOG_ENDPOINT = "/api/integration/menu";
  var TABLE_WORKSPACE_KEY_PREFIX = "tables_workspace_";
  var ORDER_COMPOSER_KEY_PREFIX = "table_order_composer_";
  var CUSTOM_PRODUCT_ID = "custom_varie";
  var CUSTOM_ROW_KEY = "__custom__";
  var POLL_MS = 650;

  var state = {
    catalogNamesById: new Map(),
    loadingCatalog: null,
    observer: null,
    pollTimer: null,
    queued: false,
  };

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function isObject(value) {
    return Boolean(value && typeof value === "object");
  }

  function readJsonStorage(key) {
    if (!key) return null;
    try {
      var raw = window.sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function menuRows() {
    return Array.from(document.querySelectorAll(".table-order-product-row"));
  }

  function clearRowUi(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    row.classList.remove("has-draft-qty");
    row.removeAttribute("data-draft-qty");

    var badge = row.querySelector(".mobile-order-draft-qty-badge");
    if (badge) {
      badge.remove();
    }
  }

  function parseCatalogProducts(payload) {
    if (!isObject(payload)) return [];

    if (Array.isArray(payload.products)) {
      return payload.products;
    }

    if (isObject(payload.catalog) && Array.isArray(payload.catalog.products)) {
      return payload.catalog.products;
    }

    return [];
  }

  async function loadCatalog() {
    if (state.loadingCatalog) {
      return state.loadingCatalog;
    }

    state.loadingCatalog = (async function () {
      try {
        var response = await fetch(CATALOG_ENDPOINT + "?_=" + Date.now(), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          return;
        }

        var json = await response.json().catch(function () {
          return null;
        });
        var products = parseCatalogProducts(json);

        if (!Array.isArray(products) || products.length === 0) {
          return;
        }

        var nextMap = new Map();
        products.forEach(function (product) {
          var id = String(product && product.id ? product.id : "").trim();
          var name = String(product && product.name ? product.name : "").trim();
          if (id && name) {
            nextMap.set(id, name);
          }
        });

        if (nextMap.size > 0) {
          state.catalogNamesById = nextMap;
        }
      } catch {
        // noop
      } finally {
        state.loadingCatalog = null;
      }
    })();

    return state.loadingCatalog;
  }

  function resolveComposerPersistKey() {
    try {
      for (var index = 0; index < window.sessionStorage.length; index += 1) {
        var key = window.sessionStorage.key(index);
        if (!key || key.indexOf(TABLE_WORKSPACE_KEY_PREFIX) !== 0) continue;

        var workspaceState = readJsonStorage(key);
        if (!isObject(workspaceState)) continue;

        var isComposerOpen = workspaceState.orderComposerOpen === true;
        var selectedTableId = String(workspaceState.selectedTableId ?? "").trim();
        if (isComposerOpen && selectedTableId) {
          return ORDER_COMPOSER_KEY_PREFIX + selectedTableId;
        }
      }

      var fallbackKey = null;
      var fallbackDraftSize = -1;

      for (var storageIndex = 0; storageIndex < window.sessionStorage.length; storageIndex += 1) {
        var composerKey = window.sessionStorage.key(storageIndex);
        if (!composerKey || composerKey.indexOf(ORDER_COMPOSER_KEY_PREFIX) !== 0) continue;

        var composerState = readJsonStorage(composerKey);
        var draft = Array.isArray(composerState && composerState.draft) ? composerState.draft : [];
        if (draft.length > fallbackDraftSize) {
          fallbackDraftSize = draft.length;
          fallbackKey = composerKey;
        }
      }

      return fallbackKey;
    } catch {
      return null;
    }
  }

  function readActiveDraft() {
    var key = resolveComposerPersistKey();
    if (!key) {
      return [];
    }

    var composerState = readJsonStorage(key);
    return Array.isArray(composerState && composerState.draft) ? composerState.draft : [];
  }

  function buildDraftCounts() {
    var counts = new Map();
    var draft = readActiveDraft();

    draft.forEach(function (entry) {
      if (!isObject(entry)) return;

      var quantity = Math.max(1, Math.min(99, Math.round(Number(entry.quantity) || 1)));
      var productId = String(entry.productId ?? "").trim();

      if (!productId) return;

      if (productId === CUSTOM_PRODUCT_ID) {
        counts.set(CUSTOM_ROW_KEY, (counts.get(CUSTOM_ROW_KEY) || 0) + quantity);
        return;
      }

      var productName = state.catalogNamesById.get(productId);
      if (!productName) return;

      var nameKey = normalizeName(productName);
      if (!nameKey) return;

      counts.set(nameKey, (counts.get(nameKey) || 0) + quantity);
    });

    return counts;
  }

  function rowDraftKey(row) {
    if (!(row instanceof HTMLElement)) {
      return "";
    }

    if (row.classList.contains("is-custom")) {
      return CUSTOM_ROW_KEY;
    }

    return normalizeName(textOf(row.querySelector(".table-order-product-name")));
  }

  function ensureBadge(row) {
    var badge = row.querySelector(".mobile-order-draft-qty-badge");
    if (badge) {
      return badge;
    }

    badge = document.createElement("span");
    badge.className = "mobile-order-draft-qty-badge";
    row.appendChild(badge);
    return badge;
  }

  function applyDraftCount(row, count) {
    clearRowUi(row);

    if (!(count > 0)) {
      return;
    }

    row.classList.add("has-draft-qty");
    row.setAttribute("data-draft-qty", String(count));

    var badge = ensureBadge(row);
    badge.textContent = count > 99 ? "99+" : "x" + count;
    badge.setAttribute("aria-label", count + " articoli già aggiunti");
    badge.title = count + " articoli già aggiunti";
  }

  function applyAll() {
    var rows = menuRows();
    if (rows.length === 0) {
      return;
    }

    var counts = buildDraftCounts();
    rows.forEach(function (row) {
      applyDraftCount(row, counts.get(rowDraftKey(row)) || 0);
    });
  }

  function scheduleApply() {
    if (state.queued) {
      return;
    }

    state.queued = true;
    window.requestAnimationFrame(function () {
      state.queued = false;
      applyAll();
    });
  }

  async function refreshAndApply() {
    await loadCatalog();
    scheduleApply();
  }

  function start() {
    if (state.observer) {
      state.observer.disconnect();
    }

    state.observer = new MutationObserver(function () {
      scheduleApply();
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-expanded", "data-swipe"],
    });

    if (state.pollTimer !== null) {
      window.clearInterval(state.pollTimer);
    }

    state.pollTimer = window.setInterval(function () {
      if (!document.hidden) {
        void refreshAndApply();
      }
    }, POLL_MS);

    void refreshAndApply();
  }

  window.addEventListener("focus", function () {
    void refreshAndApply();
  });

  document.addEventListener(
    "click",
    function (event) {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".table-order-product-row, .table-order-drawer, .table-order-qty-btn")) return;

      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          scheduleApply();
        });
      });
    },
    true
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
