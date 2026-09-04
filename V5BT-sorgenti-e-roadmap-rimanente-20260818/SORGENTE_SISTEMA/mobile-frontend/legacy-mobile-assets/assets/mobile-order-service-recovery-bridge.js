(function mobileOrderServiceRecoveryBridge() {
  if (window.__mobileOrderServiceRecoveryBridgeInitialized) return;
  window.__mobileOrderServiceRecoveryBridgeInitialized = true;

  var PREVIEW_ACTIONS_SELECTOR = ".table-history-preview-actions";
  var ROW_SELECTOR = ".table-history-row";
  var BUTTONS_CLASS = "mobile-service-recovery-actions";
  var MODAL_ID = "mobile-service-recovery-modal-root";
  var TOAST_LAYER_CLASS = "mobile-service-recovery-toast-layer";
  var PREVIEW_ORDER_SENTINEL = "__preview_order__";
  var POLL_MS = 1400;
  var HEARTBEAT_MS = 25000;
  var observer = null;
  var pollTimer = null;
  var heartbeatTimer = null;
  var activeLock = null;
  var selfMutating = false;
  var selfMutatingTimer = 0;
  var previewOrderCache = {
    orderId: "",
    loading: false,
    order: null,
  };
  var lastPreviewSnapshot = null;
  var replacementRowsCache = {
    loading: false,
    loadedAt: 0,
    ordersById: {},
  };
  var menuCatalogCache = {
    loading: null,
    loadedAt: 0,
    products: [],
    error: "",
  };
  var state = {
    open: false,
    mode: "",
    orderId: "",
    loading: false,
    busy: false,
    error: "",
    order: null,
    lines: [],
    addRows: [],
    orderUpdates: {},
    selectedLineId: "",
    reasonPromptOpen: false,
	    replacementReason: "",
	    replacementReasonError: "",
	    replacementSelectionError: "",
	    replacementSelections: {},
	    cancelConfirmOpen: false,
    cancelReason: "",
    cancelReasonError: "",
    catalogLoading: false,
    catalogError: "",
    lineDrafts: {},
    correctionNoChangesError: "",
  };

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function parseIntInRange(value, min, max, fallback) {
    var parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function parseMoney(value) {
    var raw = String(value == null ? "" : value).trim().replace(/\s+/g, "").replace(/[^\d,.-]/g, "");
    if (!raw) return 0;
    if (raw.indexOf(",") >= 0 && raw.indexOf(".") >= 0) raw = raw.replace(/\./g, "").replace(",", ".");
    else raw = raw.replace(",", ".");
    var parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : 0;
  }

  function formatMoney(value) {
    var amount = Number(value);
    if (!Number.isFinite(amount)) amount = 0;
    try {
      return amount.toLocaleString("it-IT", { style: "currency", currency: "EUR" });
    } catch (_error) {
      return "EUR " + (Math.round(amount * 100) / 100).toFixed(2);
    }
  }

  function slugify(value, fallback) {
    var normalized = normalizeText(value)
      .toLowerCase()
      .normalize ? normalizeText(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : normalizeText(value).toLowerCase();
    normalized = normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return normalized || fallback || "product";
  }

  function readStorageValue(key) {
    try {
      var localValue = window.localStorage.getItem(key);
      if (localValue !== null) return localValue;
    } catch (_error) {}
    try {
      return window.sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function readPermissions() {
    var raw = readStorageValue("pos_permissions") || "[]";
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(function (entry) { return String(entry || "").trim(); }) : [];
    } catch (_error) {
      return [];
    }
  }

  function getSession() {
    return {
      token: normalizeText(readStorageValue("pos_token")),
      userId: normalizeText(readStorageValue("pos_user_id")),
      username: normalizeText(readStorageValue("pos_user")),
      deviceUuid: normalizeText(readStorageValue("pos_device_uuid")),
      roomId: normalizeText(readStorageValue("pos_room_id")),
      clientApp: "mobile-service-recovery",
      permissions: readPermissions(),
    };
  }

  function hasReplacementPermission() {
    var session = getSession();
    var role = normalizeText(readStorageValue("pos_role")).toLowerCase();
    return role === "admin" || role === "responsabile" || session.permissions.indexOf("create_bar_replacement") >= 0 || session.permissions.indexOf("collect_payments") >= 0;
  }

  function authHeaders() {
    var session = getSession();
    var headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-User-Id": session.userId,
      "X-Device-Uuid": session.deviceUuid,
      "X-Client-App": session.clientApp,
    };
    if (session.token) headers.Authorization = "Bearer " + session.token;
    return headers;
  }

  function sessionPayload(extra) {
    var session = getSession();
    return Object.assign(
      {
        token: session.token,
        userId: session.userId,
        username: session.username,
        deviceUuid: session.deviceUuid,
        roomId: session.roomId,
        clientApp: session.clientApp,
      },
      extra || {}
    );
  }

  function readResponseJson(response) {
    return response.text().then(function (text) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_error) {
        return { ok: false, error: text };
      }
    });
  }

  function apiPost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(sessionPayload(body)),
    }).then(function (response) {
      return readResponseJson(response).then(function (payload) {
        if (!response.ok || !payload || payload.ok === false) {
          var message = payload && (payload.error || payload.message || payload.code);
          throw new Error(normalizeText(message) || "Operazione non riuscita.");
        }
        return payload;
      });
    });
  }

  function normalizeCatalogVariant(variant, index) {
    if (!variant || typeof variant !== "object") return null;
    var name = normalizeText(variant.name || variant.label || variant.value);
    if (!name) return null;
    var id = normalizeText(variant.id || variant.value) || slugify(name, "variant_" + (index + 1));
    var delta = Number(variant.priceDelta != null ? variant.priceDelta : variant.delta != null ? variant.delta : variant.price);
    return {
      id: id,
      name: name,
      priceDelta: Number.isFinite(delta) ? Math.round(delta * 100) / 100 : 0,
      available: variant.enabled !== false && variant.available !== false,
    };
  }

  function normalizeCatalogProduct(item) {
    if (!item || typeof item !== "object" || normalizeText(item.type).toLowerCase() === "divider") return null;
    var name = normalizeText(item.name);
    if (!name) return null;
    var price = Number(item.price);
    return {
      id: normalizeText(item.id) || slugify(name, "product"),
      name: name,
      price: Number.isFinite(price) ? Math.max(Math.round(price * 100) / 100, 0) : 0,
      category: normalizeText(item.category),
      section: normalizeText(item.section),
      variants: (Array.isArray(item.variants) ? item.variants : [])
        .map(normalizeCatalogVariant)
        .filter(Boolean)
        .filter(function (variant) { return variant.available !== false; }),
      variantRequired: item.variantRequired === true || item.requiresVariant === true || item.requiresVariantSelection === true,
      enabled: item.enabled !== false,
    };
  }

  function sortCatalogProducts(products) {
    return (Array.isArray(products) ? products : []).slice().sort(function (left, right) {
      return left.name.localeCompare(right.name, "it-IT");
    });
  }

  function fetchMenuCatalog() {
    if (menuCatalogCache.products.length && Date.now() - menuCatalogCache.loadedAt < 60000) {
      return Promise.resolve(menuCatalogCache.products);
    }
    if (menuCatalogCache.loading) return menuCatalogCache.loading;
    menuCatalogCache.loading = fetch("/api/menu/catalog", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(sessionPayload({})),
    })
      .then(function (response) {
        return readResponseJson(response).then(function (payload) {
          if (!response.ok || !payload || payload.ok === false) {
            throw new Error((payload && (payload.error || payload.message)) || "Catalogo menu non disponibile.");
          }
          var catalogItems = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.products) ? payload.products : [];
          var products = sortCatalogProducts(
            catalogItems
              .map(normalizeCatalogProduct)
              .filter(Boolean)
              .filter(function (product) { return product.enabled !== false; })
          );
          menuCatalogCache.products = products;
          menuCatalogCache.loadedAt = Date.now();
          menuCatalogCache.error = "";
          return products;
        });
      })
      .catch(function (error) {
        menuCatalogCache.error = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(function () {
        menuCatalogCache.loading = null;
      });
    return menuCatalogCache.loading;
  }

  function ensureMenuCatalogLoaded() {
    state.catalogLoading = true;
    state.catalogError = "";
    return fetchMenuCatalog()
      .then(function () {
        state.catalogLoading = false;
        state.catalogError = "";
      })
      .catch(function (error) {
        state.catalogLoading = false;
        state.catalogError = error instanceof Error ? error.message : String(error);
      });
  }

  function catalogProducts() {
    return menuCatalogCache.products || [];
  }

  function findCatalogProductById(productId) {
    var safeId = normalizeText(productId);
    if (!safeId) return null;
    return catalogProducts().find(function (product) { return product.id === safeId; }) || null;
  }

  function findCatalogProductForLine(line) {
    var byId = findCatalogProductById(line && line.productId);
    if (byId) return byId;
    var name = compactCompareText(line && line.productName);
    if (!name) return null;
    return catalogProducts().find(function (product) { return compactCompareText(product.name) === name; }) || null;
  }

  function findCatalogVariant(product, value) {
    var safe = normalizeText(value);
    if (!product || !safe) return null;
    var safeCompare = compactCompareText(safe);
    return (Array.isArray(product.variants) ? product.variants : []).find(function (variant) {
      return variant.id === safe || compactCompareText(variant.name) === safeCompare;
    }) || null;
  }

  function renderNativeOptions(options, selectedValue) {
    var safeSelected = normalizeText(selectedValue);
    return (Array.isArray(options) ? options : []).map(function (option) {
      return '<option value="' + escapeHtml(option.value) + '"' + (option.value === safeSelected ? " selected" : "") + ">" + escapeHtml(option.label) + "</option>";
    }).join("");
  }

  function supplementOptionList(selected) {
    var safeSelected = normalizeText(selected) || "none";
    var options = [
      { value: "none", label: "Nessun supplemento" },
      { value: "menu_apericena", label: "Menu Apericena" },
      { value: "apericena_prenotazione", label: "Apericena Prenotazione" },
    ];
    if (!options.some(function (option) { return option.value === safeSelected; })) {
      options.unshift({ value: safeSelected, label: safeSelected });
    }
    return options;
  }

  function supplementLabelForPrice(value, basePrice) {
    var safeValue = normalizeText(value) || "none";
    if (safeValue === "none") return "Nessun supplemento";
    var delta = apericenaSupplementDeltaForPrice(basePrice, safeValue);
    var label = safeValue === "apericena_prenotazione" ? "Apericena Prenotazione" : "Menu Apericena";
    if (delta <= 0) return label + " (non disponibile)";
    return label + " (+" + formatMoney(delta) + " -> " + formatMoney(basePrice + delta) + ")";
  }

  function supplementOptionListForPrice(selected, basePrice) {
    var safeSelected = normalizeText(selected) || "none";
    var options = ["none", "menu_apericena", "apericena_prenotazione"].map(function (value) {
      return {
        value: value,
        label: supplementLabelForPrice(value, Math.max(Number(basePrice) || 0, 0)),
        disabled: value !== "none" && apericenaSupplementDeltaForPrice(basePrice, value) <= 0,
      };
    });
    if (!options.some(function (option) { return option.value === safeSelected; })) {
      options.unshift({ value: safeSelected, label: safeSelected });
    }
    return options;
  }

  function supplementOptionsHtml(selected) {
    return renderNativeOptions(supplementOptionList(selected), normalizeText(selected) || "none");
  }

  function modifierPresetOptionList(selected) {
    var safeSelected = normalizeText(selected);
    var options = ["", "Senza ghiaccio", "Poco ghiaccio", "Con ghiaccio", "Con limone", "Senza zucchero", "Sour", "Fizz", "Liscio", "Lemon", "Tonic", "Personalizzata"];
    if (safeSelected && options.indexOf(safeSelected) < 0) options.splice(options.length - 1, 0, safeSelected);
    return options.map(function (label) {
      var display = label || "Nessuna modifica";
      return { value: label, label: display };
    });
  }

  function modifierPresetOptionsHtml(selected) {
    return renderNativeOptions(modifierPresetOptionList(selected), selected);
  }

  function variantOptionList(product, selectedValue, includeNone) {
    var selected = normalizeText(selectedValue);
    var options = [];
    if (includeNone !== false && !(product && product.variantRequired)) {
      options.push({ value: "", label: "Nessuna variante" });
    }
    (Array.isArray(product && product.variants) ? product.variants : []).forEach(function (variant) {
      var suffix = variant.priceDelta ? " (" + (variant.priceDelta > 0 ? "+" : "") + variant.priceDelta.toFixed(2) + " EUR)" : "";
      options.push({ value: variant.name, label: variant.name + suffix });
    });
    if (selected && !options.some(function (option) { return option.value === selected; })) {
      options.unshift({ value: selected, label: "Attuale: " + selected });
    }
    return options;
  }

  function variantOptionsHtml(product, selectedValue, includeNone) {
    return renderNativeOptions(variantOptionList(product, selectedValue, includeNone), selectedValue);
  }

  function detectSupplement(value) {
    var text = compactCompareText(value);
    if (!text) return "none";
    if (text.indexOf("prenotazione") >= 0) return "apericena_prenotazione";
    if (text.indexOf("apericena") >= 0 || text.indexOf("menu") >= 0) return "menu_apericena";
    return "none";
  }

  function apericenaSupplementDeltaForPrice(price, supplement) {
    var base = Math.max(Number(price) || 0, 0);
    if (supplement === "apericena_prenotazione") return base <= 10 ? Math.max(0, 14 - base) : 0;
    if (supplement === "menu_apericena") return base <= 10 ? Math.max(0, 12 - base) : base < 17 ? Math.max(0, 17 - base) : 0;
    return 0;
  }

  function computeCatalogUnitPrice(product, variantValue, supplement) {
    if (!product) return 0;
    var variant = findCatalogVariant(product, variantValue);
    var base = Math.max(Number(product.price) || 0, 0);
    var withVariant = base + (variant ? Number(variant.priceDelta) || 0 : 0);
    return Math.round((withVariant + apericenaSupplementDeltaForPrice(withVariant, supplement)) * 100) / 100;
  }

  function computeCatalogBaseUnitPrice(product, variantValue) {
    if (!product) return 0;
    var variant = findCatalogVariant(product, variantValue);
    var base = Math.max(Number(product.price) || 0, 0);
    return Math.round((base + (variant ? Number(variant.priceDelta) || 0 : 0)) * 100) / 100;
  }

  function buildModifierPayload(variant, additions, supplement) {
    var payload = {};
    var safeVariant = normalizeText(variant);
    var safeAdditions = normalizeText(additions);
    var safeSupplement = normalizeText(supplement);
    if (safeVariant) payload.Variante = safeVariant;
    if (safeAdditions) payload.Aggiunte = safeAdditions;
    if (safeSupplement && safeSupplement !== "none") {
      payload.Supplemento = safeSupplement === "apericena_prenotazione" ? "Apericena Prenotazione" : "Menu Apericena";
    }
    return payload;
  }

  function getToastLayer() {
    var layer = document.querySelector("." + TOAST_LAYER_CLASS);
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = TOAST_LAYER_CLASS;
    document.body.appendChild(layer);
    return layer;
  }

  function showToast(message, tone) {
    var text = normalizeText(message);
    if (!text) return;
    var layer = getToastLayer();
    var toast = document.createElement("div");
    toast.className = "mobile-service-recovery-toast" + (tone === "error" ? " is-error" : " is-success");
    toast.textContent = text;
    layer.appendChild(toast);
    window.requestAnimationFrame(function () {
      toast.classList.add("is-visible");
    });
    window.setTimeout(function () {
      toast.classList.remove("is-visible");
      window.setTimeout(function () {
        if (toast.parentElement) toast.parentElement.removeChild(toast);
      }, 220);
    }, 2800);
  }

  function markSelfMutating() {
    selfMutating = true;
    if (selfMutatingTimer) window.clearTimeout(selfMutatingTimer);
    selfMutatingTimer = window.setTimeout(function () {
      selfMutating = false;
      selfMutatingTimer = 0;
    }, 0);
  }

  function getReactFiber(node) {
    if (!node) return null;
    for (var key in node) {
      if (key.indexOf("__reactFiber$") === 0 || key.indexOf("__reactInternalInstance$") === 0) return node[key];
    }
    return null;
  }

  function normalizeOrderIdCandidate(value) {
    var text = normalizeText(value);
    if (!text || text === PREVIEW_ORDER_SENTINEL) return "";
    var hashOnly = text.match(/^#\s*(\d{1,8})$/);
    if (hashOnly && hashOnly[1]) return hashOnly[1];
    var orderPrefixOnly = text.match(/^order[_\s:#-]+(\d{1,8})$/i);
    if (orderPrefixOnly && orderPrefixOnly[1]) return orderPrefixOnly[1];
    if (/^\d{3,8}$/.test(text)) return text;
    var explicit = text.match(/\b(?:comanda|ordine|order)\s*([:#_-]?)\s*(\d{1,8})/i);
    if (explicit && explicit[2]) {
      var separator = explicit[1] || "";
      var trailing = text.slice(explicit.index + explicit[0].length).trim();
      if (explicit[2].length >= 3 || separator === "#" || !trailing) return explicit[2];
    }
    var embedded = text.match(/(?:^|[^0-9])(\d{5,8})(?:[^0-9]|$)/);
    return embedded && embedded[1] ? embedded[1] : "";
  }

  function normalizeNumericToken(value) {
    var text = normalizeText(value)
      .replace(/^comanda\s*#?\s*/i, "")
      .replace(/^ordine\s*#?\s*/i, "")
      .replace(/^order[_\s:#-]+/i, "")
      .replace(/^#\s*/i, "")
      .trim();
    if (!/^\d{1,8}$/.test(text)) return "";
    var normalized = text.replace(/^0+/, "");
    return normalized || "0";
  }

  function isWeakOrderIdLookup(value) {
    var numeric = normalizeNumericToken(value);
    return Boolean(numeric && numeric.length < 3);
  }

  function normalizeTableToken(value) {
    var text = normalizeText(value).toLowerCase();
    var explicit = text.match(/\btavolo\s+([a-z0-9][a-z0-9/_-]*)/i);
    if (explicit && explicit[1]) text = explicit[1];
    text = text.replace(/^tavolo\s*/i, "");
    text = text.replace(/\s+/g, "");
    text = text.replace(/^room_[a-z0-9_-]*_t/i, "");
    text = text.replace(/^t/i, "");
    return text;
  }

  function tableTokenFromVisibleText(value) {
    var text = normalizeText(value);
    var explicit = text.match(/\btavolo\s+([a-z0-9][a-z0-9/_-]*)/i);
    return explicit && explicit[1] ? normalizeTableToken(explicit[1]) : "";
  }

  function orderTableTokens(order) {
    var values = [
      order && order.tableLabel,
      order && order.logicalTableLabel,
      order && order.tableNumber,
      order && order.table,
      order && order.tableId,
    ];
    var tokens = [];
    values.forEach(function (value) {
      var token = normalizeTableToken(value);
      if (token && tokens.indexOf(token) < 0) tokens.push(token);
    });
    return tokens;
  }

  function previewTableLabel() {
    var dataLabel = dataTableLabelFromNode(
      document.querySelector(".table-history-preview-card") || document.querySelector(".table-history-row.is-selected")
    );
    if (dataLabel) return dataLabel;
    var nodes = [
      document.querySelector(".table-detail-title"),
      document.querySelector(".table-history-preview-card"),
      document.querySelector(".table-history-row.is-selected"),
    ];
    for (var index = 0; index < nodes.length; index += 1) {
      var token = tableTokenFromVisibleText(textOf(nodes[index]));
      if (token) return token;
    }
    return "";
  }

  function orderCreatedAtMs(order) {
    var direct = Number(order && (order.createdAtMs || order.receivedAtMs || order.updatedAtMs));
    if (Number.isFinite(direct) && direct > 0) return direct;
    var parsed = Date.parse(String((order && (order.createdAt || order.receivedAt || order.updatedAt)) || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getFiberKey(fiber) {
    var current = fiber;
    var seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      var candidate = normalizeOrderIdCandidate(current.key);
      if (candidate) return candidate;
      current = current.return;
    }
    return "";
  }

  function dataOrderIdFromNode(node) {
    var current = isElement(node) ? node : null;
    while (current && current !== document.body) {
      var raw = normalizeText(current.getAttribute("data-order-id") || current.getAttribute("data-msr-order-id"));
      var candidate = normalizeOrderIdCandidate(raw) || raw;
      if (candidate && candidate !== PREVIEW_ORDER_SENTINEL) return candidate;
      current = current.parentElement;
    }
    var selectors = [
      ".table-history-preview-card[data-order-id]",
      ".table-history-preview-actions[data-order-id]",
      ROW_SELECTOR + ".is-selected[data-order-id]",
    ];
    for (var index = 0; index < selectors.length; index += 1) {
      var element = document.querySelector(selectors[index]);
      var value = normalizeText(element && element.getAttribute("data-order-id"));
      var normalized = normalizeOrderIdCandidate(value) || value;
      if (normalized && normalized !== PREVIEW_ORDER_SENTINEL) return normalized;
    }
    return "";
  }

  function dataTableLabelFromNode(node) {
    var current = isElement(node) ? node : null;
    while (current && current !== document.body) {
      var value =
        normalizeText(current.getAttribute("data-table-label")) ||
        normalizeText(current.getAttribute("data-table-number")) ||
        normalizeText(current.getAttribute("data-table-id"));
      if (value) return value;
      current = current.parentElement;
    }
    var element =
      document.querySelector(".table-history-preview-card[data-table-label]") ||
      document.querySelector(".table-history-preview-actions[data-table-label]") ||
      document.querySelector(ROW_SELECTOR + ".is-selected[data-table-label]");
    return (
      normalizeText(element && element.getAttribute("data-table-label")) ||
      normalizeText(element && element.getAttribute("data-table-number")) ||
      normalizeText(element && element.getAttribute("data-table-id"))
    );
  }

  function dataTableIdFromNode(node) {
    var current = isElement(node) ? node : null;
    while (current && current !== document.body) {
      var value = normalizeText(current.getAttribute("data-table-id"));
      if (value) return value;
      current = current.parentElement;
    }
    var element =
      document.querySelector(".table-history-preview-card[data-table-id]") ||
      document.querySelector(".table-history-preview-actions[data-table-id]") ||
      document.querySelector(ROW_SELECTOR + ".is-selected[data-table-id]");
    return normalizeText(element && element.getAttribute("data-table-id"));
  }

  function previewTableId() {
    return dataTableIdFromNode(
      document.querySelector(".table-history-preview-card") || document.querySelector(".table-history-row.is-selected")
    );
  }

  function visibleOrderIdFromNode(node) {
    var dataOrderId = dataOrderIdFromNode(node);
    if (dataOrderId) return dataOrderId;
    var candidates = [];
    if (isElement(node)) {
      var row = node.closest(ROW_SELECTOR);
      if (row) {
        candidates.push(row.querySelector(".table-history-order-title"));
        candidates.push(row);
      }
      if (node.closest(".table-history-preview-card") || node.closest(PREVIEW_ACTIONS_SELECTOR)) {
        candidates.push(document.querySelector(".table-history-preview-title"));
      }
    }
    candidates.push(document.querySelector(".table-history-preview-title"));
    candidates.push(document.querySelector(ROW_SELECTOR + ".is-selected .table-history-order-title"));
    candidates.push(document.querySelector(ROW_SELECTOR + ".is-selected"));
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = normalizeOrderIdCandidate(textOf(candidates[index]));
      if (candidate) return candidate;
    }
    return "";
  }

  function resolveOrderIdFromNode(node) {
    var visibleOrderId = visibleOrderIdFromNode(node);
    if (visibleOrderId) return visibleOrderId;
    var current = node;
    while (isElement(current) && current !== document.body) {
      var fiber = getReactFiber(current);
      var fiberKey = getFiberKey(fiber);
      if (fiberKey) return fiberKey;
      if (fiber && fiber.alternate) {
        fiberKey = getFiberKey(fiber.alternate);
        if (fiberKey) return fiberKey;
      }
      current = current.parentElement;
    }
    return "";
  }

  function getSelectedOrderId() {
    var selectedRow = document.querySelector(ROW_SELECTOR + ".is-selected");
    var visibleOrderId = visibleOrderIdFromNode(selectedRow);
    if (visibleOrderId) return visibleOrderId;
    var orderId = resolveOrderIdFromNode(selectedRow);
    if (orderId) return orderId;
    return previewAllowsCorrection() ? PREVIEW_ORDER_SENTINEL : "";
  }

  function fetchOrders(currentSessionOnly, lookupOrderId) {
    var suffix = currentSessionOnly ? "&currentSessionOnly=1" : "";
    var safeLookupOrderId = normalizeText(lookupOrderId);
    var lookupSuffix =
      safeLookupOrderId && safeLookupOrderId !== PREVIEW_ORDER_SENTINEL
        ? "&orderId=" + encodeURIComponent(safeLookupOrderId)
        : "";
    return fetch("/api/integration/orders?includeDone=1&includeTransferred=1" + suffix + lookupSuffix + "&_=" + Date.now(), {
      method: "GET",
      headers: authHeaders(),
    }).then(function (response) {
      return readResponseJson(response).then(function (payload) {
        if (!response.ok || !payload || payload.ok === false || !Array.isArray(payload.orders)) {
          throw new Error((payload && payload.error) || "Comande non disponibili.");
        }
        return payload.orders;
      });
    });
  }

  function cloneOrderFromLayout(order, table) {
    if (!order || typeof order !== "object") return null;
    var next = {};
    Object.keys(order).forEach(function (key) {
      next[key] = order[key];
    });
    next.id = normalizeText(next.id || next.orderId || next.sourceOrderId);
    if (!next.id) return null;
    next.tableId = normalizeText(next.tableId || (table && table.id));
    next.tableLabel = normalizeText(next.tableLabel || next.logicalTableLabel || (table && (table.tableName || table.number)));
    next.tableNumber = next.tableNumber || (table && table.number);
    next.roomId = normalizeText(next.roomId || (table && table.roomId));
    next.roomName = normalizeText(next.roomName || (table && table.roomName));
    if (!Array.isArray(next.items) && Array.isArray(next.lines)) next.items = next.lines;
    if (!next.workflowStatus) next.workflowStatus = "waiting";
    return next;
  }

  function orderFromPendingBill(bill, table) {
    if (!bill || typeof bill !== "object") return null;
    var orderIds = Array.isArray(bill.orderIds) ? bill.orderIds : [];
    var id = normalizeText(bill.orderId || orderIds[0] || bill.id);
    id = normalizeOrderIdCandidate(id) || id.replace(/^order[_\s:#-]+/i, "");
    if (!id) return null;
    var lines = Array.isArray(bill.lines) ? bill.lines : [];
    return {
      id: id,
      tableId: normalizeText(table && table.id),
      tableLabel: normalizeText(table && (table.tableName || table.number)),
      tableNumber: table && table.number,
      roomId: normalizeText(table && table.roomId),
      roomName: normalizeText(table && table.roomName),
      workflowStatus: normalizeText(bill.workflowStatus || "waiting"),
      paymentStatus: "unpaid",
      dueAmount: Number(bill.subtotal || 0) || Number(table && table.amountDue) || 0,
      total: Number(bill.subtotal || 0) || Number(table && table.amountDue) || 0,
      createdAt: bill.createdAt,
      items: lines.map(function (line, index) {
        return {
          id: "layout_bill_line_" + index,
          lineId: normalizeText(line && line.lineId) || "layout_bill_line_" + index,
          name: normalizeText(line && (line.name || line.productName || line.productNameSnapshot)) || "Articolo",
          qty: Number(line && line.qty) || 1,
          unitPriceApplied: Number(line && line.unitPrice) || 0,
          lineTotal: Number(line && line.lineTotal) || 0,
          note: normalizeText(line && (line.note || line.notes)),
        };
      }),
    };
  }

  function collectLayoutOrders(payload) {
    var tables = Array.isArray(payload && payload.tables) ? payload.tables : [];
    var orders = [];
    tables.forEach(function (table) {
      (Array.isArray(table && table.orderHistory) ? table.orderHistory : []).forEach(function (order) {
        var cloned = cloneOrderFromLayout(order, table);
        if (cloned) orders.push(cloned);
      });
      (Array.isArray(table && table.pendingBills) ? table.pendingBills : []).forEach(function (bill) {
        var pendingOrder = orderFromPendingBill(bill, table);
        if (pendingOrder) orders.push(pendingOrder);
      });
    });
    return orders;
  }

  function fetchLayoutOrders() {
    return fetch("/api/integration/layout?_=" + Date.now(), {
      method: "GET",
      headers: authHeaders(),
    }).then(function (response) {
      return readResponseJson(response).then(function (payload) {
        if (!response.ok || !payload || payload.ok === false) {
          throw new Error((payload && payload.error) || "Layout non disponibile.");
        }
        return collectLayoutOrders(payload);
      });
    });
  }

  function previewTitleText() {
    return (
      textOf(document.querySelector(".table-history-preview-title")) ||
      textOf(document.querySelector(".table-history-row.is-selected .table-history-order-title"))
    );
  }

  function previewTotalAmount() {
    var previewTotal = textOf(document.querySelector(".table-history-preview-meta .table-history-total"));
    if (!previewTotal) previewTotal = textOf(document.querySelector(".table-history-row.is-selected .table-history-total"));
    return parseMoney(previewTotal);
  }

  function getPreviewSnapshot() {
    var selectedRow = document.querySelector(ROW_SELECTOR + ".is-selected");
    var snapshot = {
      title: previewTitleText(),
      total: previewTotalAmount(),
      workflow: previewWorkflowOf(),
      orderId: visibleOrderIdFromNode(selectedRow) || resolveOrderIdFromNode(selectedRow),
      tableLabel: previewTableLabel(),
      tableId: previewTableId(),
      capturedAt: Date.now(),
    };
    return snapshot.title || snapshot.total || snapshot.workflow || snapshot.orderId || snapshot.tableLabel || snapshot.tableId
      ? snapshot
      : null;
  }

  function rememberPreviewSnapshot(snapshot) {
    if (!snapshot) snapshot = getPreviewSnapshot();
    if (snapshot) lastPreviewSnapshot = snapshot;
    return snapshot || lastPreviewSnapshot;
  }

  function compactCompareText(value) {
    return normalizeText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findOrderFromPreview(orders, snapshot) {
    var source = snapshot || lastPreviewSnapshot || getPreviewSnapshot() || {};
    var title = compactCompareText(source.title || previewTitleText());
    var total = Number(source.total);
    if (!Number.isFinite(total) || total <= 0) total = previewTotalAmount();
    var workflow = normalizeWorkflowStatus(source.workflow) || previewWorkflowOf();
    if (!title && !total && !workflow) return null;
    var best = null;
    var bestScore = 0;
    var bestCreatedAt = 0;
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      if (!order) return;
      if (!canShowCorrection(order) && !canShowComp(order)) return;
      var score = 0;
      var orderTitle = compactCompareText(order.title || order.orderTitle || "");
      if (title && orderTitle) {
        if (orderTitle === title) score += 6;
        else if (orderTitle.indexOf(title) >= 0 || title.indexOf(orderTitle) >= 0) score += 4;
      }
      var orderTotal = Number(order.total || order.totalAmount || 0) || 0;
      if (total > 0 && Math.abs(orderTotal - total) <= 0.02) score += 3;
      if (workflow && workflowOf(order) === workflow) score += 3;
      var createdAt = Date.parse(String(order.createdAt || order.receivedAt || "")) || 0;
      if (score > bestScore || (score === bestScore && createdAt > bestCreatedAt)) {
        best = order;
        bestScore = score;
        bestCreatedAt = createdAt;
      }
    });
    return bestScore >= 3 ? best : null;
  }

  function findOrderFromTableContext(orders, snapshot) {
    var source = snapshot || lastPreviewSnapshot || getPreviewSnapshot() || {};
    var tableToken = normalizeTableToken(source.tableLabel || previewTableLabel());
    var tableId = normalizeText(source.tableId || previewTableId());
    if (!tableToken && !tableId) return null;
    var best = null;
    var bestScore = -1;
    var bestCreatedAt = 0;
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      if (!order || (!canShowCorrection(order) && !canShowComp(order))) return;
      var exactTableId = tableId && normalizeText(order.tableId) === tableId;
      if (!exactTableId && (!tableToken || orderTableTokens(order).indexOf(tableToken) < 0)) return;
      var score = canShowCorrection(order) ? 6 : 3;
      if (exactTableId) score += 6;
      var workflow = workflowOf(order);
      if (["waiting", "received", "queued", "sent", "prep", "preparing", "in_preparation"].indexOf(workflow) >= 0) score += 2;
      if (dueOf(order) > 0.009) score += 1;
      var createdAt = orderCreatedAtMs(order);
      if (score > bestScore || (score === bestScore && createdAt > bestCreatedAt)) {
        best = order;
        bestScore = score;
        bestCreatedAt = createdAt;
      }
    });
    return best;
  }

  function fetchOrder(orderId, snapshot) {
    var safeOrderId = normalizeText(orderId);
    var normalizedOrderId = normalizeOrderIdCandidate(safeOrderId);
    var snapshotOrderId = normalizeOrderIdCandidate(snapshot && snapshot.orderId);
    if (
      snapshotOrderId &&
      (safeOrderId === PREVIEW_ORDER_SENTINEL || !normalizedOrderId || snapshotOrderId !== normalizedOrderId)
    ) {
      safeOrderId = snapshotOrderId;
      normalizedOrderId = snapshotOrderId;
    }
    var lookupIds = normalizedOrderId ? [normalizedOrderId] : [];
    var numericLookupIds = [];
    function rememberNumericLookup(value) {
      var numeric = normalizeNumericToken(value);
      if (numeric && numericLookupIds.indexOf(numeric) < 0) numericLookupIds.push(numeric);
    }
    if (normalizedOrderId) rememberNumericLookup(normalizedOrderId);
    var withoutPrefix = safeOrderId.replace(/^comanda\s*#?\s*/i, "").replace(/^order[_\s:#-]+/i, "").trim();
    var normalizedWithoutPrefix = normalizeOrderIdCandidate(withoutPrefix);
    if (normalizedWithoutPrefix && lookupIds.indexOf(normalizedWithoutPrefix) < 0) {
      lookupIds.push(normalizedWithoutPrefix);
      rememberNumericLookup(normalizedWithoutPrefix);
    }
    var digitsMatch = safeOrderId.match(/\d{1,8}/);
    if (digitsMatch && digitsMatch[0]) {
      var digits = digitsMatch[0];
      if (digits.length >= 5 && lookupIds.indexOf(digits) < 0) lookupIds.push(digits);
      if (digits.length >= 3) rememberNumericLookup(digits);
    }
    var usePreviewFallback = safeOrderId === PREVIEW_ORDER_SENTINEL || lookupIds.length === 0;
    var useContextFallback = usePreviewFallback || isWeakOrderIdLookup(safeOrderId) || isWeakOrderIdLookup(normalizedOrderId);
    function findContextFallback(orders) {
      if (!useContextFallback) return null;
      return findOrderFromTableContext(orders, snapshot) || findOrderFromPreview(orders, snapshot);
    }
    function matchesOrderId(order) {
      var id = normalizeText(order && order.id);
      if (lookupIds.indexOf(id) >= 0 || lookupIds.indexOf("order_" + id) >= 0) return true;
      var numericId = normalizeNumericToken(id);
      return Boolean(numericId && numericLookupIds.indexOf(numericId) >= 0);
    }
    function pickOrder(orders) {
      return orders.find(matchesOrderId) || findContextFallback(orders) || null;
    }
    var endpointLookupOrderId =
      normalizedOrderId && !isWeakOrderIdLookup(normalizedOrderId) ? normalizedOrderId : "";
    var firstLookup = endpointLookupOrderId
      ? fetchOrders(false, endpointLookupOrderId).then(pickOrder)
      : Promise.resolve(null);
    return firstLookup
      .then(function (order) {
        if (order) return order;
        return fetchOrders(true, endpointLookupOrderId).then(pickOrder);
      })
      .then(function (order) {
        if (order) return order;
        return fetchOrders(false).then(pickOrder);
      })
      .then(function (order) {
        if (order) return order;
        return fetchLayoutOrders()
          .then(pickOrder)
          .catch(function () {
            return null;
          });
      })
      .then(function (order) {
        if (!order) throw new Error("Comanda non trovata.");
        return order;
      });
  }

  function isNonChargeableReplacementOrder(order) {
    if (!order || typeof order !== "object") return false;
    if (order.nonChargeableReplacement === true) return true;
    if (normalizeText(order.replacementSettlement) === "non_chargeable_zero") return true;
    var items = Array.isArray(order.items) ? order.items : [];
    var total = Number(order.total || order.totalAmount || 0) || 0;
    var due = Number(order.dueAmount);
    if (!Number.isFinite(due)) due = total;
    return (
      items.length > 0 &&
      Math.abs(total) <= 0.009 &&
      Math.abs(due) <= 0.009 &&
      items.every(function (item) {
        return item && normalizeText(item.lineType).toUpperCase() === "BAR_CHARGE_REPLACEMENT";
      })
    );
  }

  function indexReplacementOrders(orders) {
    var next = {};
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      if (!isNonChargeableReplacementOrder(order)) return;
      var orderId = normalizeText(order.id);
      if (!orderId) return;
      next[orderId] = order;
      var numeric = orderId.replace(/^0+/, "");
      if (numeric) next[numeric] = order;
    });
    replacementRowsCache.ordersById = next;
    replacementRowsCache.loadedAt = Date.now();
  }

  function replacementOrderForRow(row) {
    var orderId = normalizeText(resolveOrderIdFromNode(row));
    if (!orderId) {
      var title = textOf(row && row.querySelector && row.querySelector(".table-history-order-title"));
      var match = title.match(/(\d{1,8})/);
      orderId = match ? match[1] : "";
    }
    if (!orderId) return null;
    return replacementRowsCache.ordersById[orderId] || replacementRowsCache.ordersById[orderId.replace(/^0+/, "")] || null;
  }

  function annotateReplacementHistoryRows() {
    var rows = document.querySelectorAll(ROW_SELECTOR);
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      var order = replacementOrderForRow(row);
      if (!order) continue;
      row.classList.add("mobile-service-recovery-zero-replacement-row");
      var state = row.querySelector(".table-history-state");
      if (state) {
        state.classList.add("mobile-service-recovery-zero-replacement-state");
        state.textContent = "Sostituzione 0€";
      }
      var total = row.querySelector(".table-history-total");
      if (total) total.textContent = formatMoney(0);
    }
  }

  function ensureReplacementHistoryRows(force) {
    annotateReplacementHistoryRows();
    if (replacementRowsCache.loading) return;
    if (!force && Date.now() - replacementRowsCache.loadedAt < 5000) return;
    replacementRowsCache.loading = true;
    fetchOrders(false)
      .then(function (orders) {
        indexReplacementOrders(orders);
        annotateReplacementHistoryRows();
      })
      .catch(function () {})
      .finally(function () {
        replacementRowsCache.loading = false;
      });
  }

  window.__mobileOrderServiceRecoveryGetPreviewOrder = function (orderId) {
    var safeOrderId = normalizeText(orderId);
    if (!safeOrderId || previewOrderCache.orderId !== safeOrderId) return null;
    return previewOrderCache.order || null;
  };

  function collectStructuredLabels(value, skipKeys) {
    var labels = [];
    var skip = Array.isArray(skipKeys) ? skipKeys : [];
    function push(label) {
      var text = normalizeText(label);
      if (!text || labels.indexOf(text) >= 0) return;
      labels.push(text);
    }
    if (!value) return labels;
    if (typeof value === "string" || typeof value === "number") {
      push(value);
      return labels;
    }
    if (Array.isArray(value)) {
      value.forEach(function (entry) {
        if (typeof entry === "string" || typeof entry === "number") push(entry);
        else if (entry && typeof entry === "object") push(entry.label || entry.name || entry.title || entry.value);
      });
      return labels;
    }
    if (value && typeof value === "object") {
      Object.keys(value).forEach(function (key) {
        if (skip.indexOf(String(key).toLowerCase()) >= 0) return;
        var entry = value[key];
        if (entry === true) push(key);
        else if (typeof entry === "string" || typeof entry === "number") push(entry);
        else if (entry && typeof entry === "object") push(entry.label || entry.name || entry.title || key);
      });
    }
    return labels;
  }

  function primaryVariantText(item) {
    return (
      normalizeText(item && (item.variant || item.variantName || item.selectedVariantName)) ||
      collectStructuredLabels(item && item.variants, ["aggiunte", "aggiunta", "addition", "additions", "extra", "extras"])[0] ||
      ""
    );
  }

  function additionsText(item) {
    var labels = []
      .concat(collectStructuredLabels(item && item.additions))
      .concat(collectStructuredLabels(item && item.modifiers))
      .concat(collectStructuredLabels(item && item.selectedOptions))
      .concat(collectStructuredLabels(item && item.variants, ["label", "name", "value", "variante", "variant"]));
    return labels.filter(function (entry, index) { return labels.indexOf(entry) === index; }).join(" / ");
  }

  function parseOptionalQuantity(value) {
    if (value === null || value === undefined || value === "") return null;
    var parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) ? Math.max(parsed, 0) : null;
  }

  function compAvailabilityEntry(order, lineId, productId) {
    var availability = order && order.compAvailability;
    if (!availability || typeof availability !== "object") return null;
    var safeLineId = normalizeText(lineId);
    var safeProductId = normalizeText(productId);
    var byLine = availability.byLine && typeof availability.byLine === "object" ? availability.byLine : {};
    var byProduct = availability.byProduct && typeof availability.byProduct === "object" ? availability.byProduct : {};
    if (safeLineId && byLine[safeLineId]) return byLine[safeLineId];
    if (safeProductId && byProduct[safeProductId]) return byProduct[safeProductId];
    return null;
  }

  function availableCompQuantityForLine(order, line) {
    var entry = compAvailabilityEntry(order, line && line.lineId, line && line.productId);
    if (!entry) return null;
    return parseOptionalQuantity(
      entry.availableQuantity != null ? entry.availableQuantity : entry.availableQty
    );
  }

  function aggregateOrderLines(order) {
    var map = new Map();
    function pushDetail(target, label) {
      var text = normalizeText(label);
      if (!text || target.details.indexOf(text) >= 0) return;
      target.details.push(text);
    }
    function appendStructuredDetails(target, value) {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(function (entry) {
          if (typeof entry === "string") pushDetail(target, entry);
          else if (entry && typeof entry === "object") {
            pushDetail(target, entry.label || entry.name || entry.title || entry.value);
          }
        });
        return;
      }
      if (value && typeof value === "object") {
        Object.keys(value).forEach(function (key) {
          var entry = value[key];
          if (entry === true) pushDetail(target, key);
          else if (typeof entry === "string" || typeof entry === "number") pushDetail(target, key + ": " + entry);
          else if (entry && typeof entry === "object") pushDetail(target, entry.label || entry.name || entry.title || key);
        });
      }
    }
    (Array.isArray(order && order.items) ? order.items : []).forEach(function (item) {
      if (!item || item.voidedAt || item.lineType === "BAR_CHARGE_REPLACEMENT") return;
      var lineId = normalizeText(item.lineId || item.id);
      if (!lineId) return;
      var qty = Math.max(1, Math.trunc(Number(item.qty) || 1));
      var existing = map.get(lineId);
      if (!existing) {
        existing = {
          lineId: lineId,
          productId: normalizeText(item.productId) || slugify(item.productNameSnapshot || item.name, "product"),
          productName: normalizeText(item.productNameSnapshot || item.name) || "Articolo",
          variant: normalizeText(item.variant || item.variantName),
          variantText: primaryVariantText(item),
          additionsText: additionsText(item),
          note: normalizeText(item.note || item.notes),
          variants: item.variants && typeof item.variants === "object" ? item.variants : {},
          additions: Array.isArray(item.additions) ? item.additions : [],
          modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
          selectedOptions: Array.isArray(item.selectedOptions) ? item.selectedOptions : [],
          details: [],
          unitPrice: Math.max(Number(item.unitPriceApplied || item.listPriceAtTime || item.unitPrice || 0) || 0, 0),
          qty: 0,
          lineTotal: 0,
        };
        map.set(lineId, existing);
      }
      pushDetail(existing, item.variant || item.variantName);
      appendStructuredDetails(existing, item.variants);
      appendStructuredDetails(existing, item.additions);
      appendStructuredDetails(existing, item.modifiers);
      appendStructuredDetails(existing, item.selectedOptions);
      pushDetail(existing, item.note || item.notes);
      if (!existing.variantText) existing.variantText = primaryVariantText(item);
      var nextAdditionsText = additionsText(item);
      if (nextAdditionsText && existing.additionsText.indexOf(nextAdditionsText) < 0) {
        existing.additionsText = [existing.additionsText, nextAdditionsText].filter(Boolean).join(" / ");
      }
      existing.qty += qty;
      existing.lineTotal += Math.max(
        Number(item.lineTotal) ||
          Number(item.unitPriceApplied || item.listPriceAtTime || item.unitPrice || 0) * qty ||
          0,
        0
      );
    });
    return Array.from(map.values()).map(function (line) {
      var availableQuantity = availableCompQuantityForLine(order, line);
      if (availableQuantity === null) return line;
      if (availableQuantity <= 0) return null;
      var originalQty = Math.max(Math.trunc(Number(line.qty) || 0), 0);
      if (originalQty > 0 && availableQuantity < originalQty) {
        var unitPrice = Math.max(Number(line.unitPrice) || line.lineTotal / originalQty || 0, 0);
        line.originalQty = originalQty;
        line.qty = availableQuantity;
        line.lineTotal = unitPrice * availableQuantity;
        line.unitPrice = unitPrice;
        line.compAvailableQuantity = availableQuantity;
      }
      return line;
    }).filter(Boolean);
  }

  function idempotencyKey(prefix, orderId) {
    return [
      prefix,
      normalizeText(orderId).replace(/[^a-z0-9_-]+/gi, "_"),
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 8),
    ].join("_");
  }

  function startHeartbeat(tableId, purpose) {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(function () {
      if (!activeLock) return;
      apiPost("/api/tables/lock/heartbeat", { tableId: tableId, purpose: purpose }).catch(function () {
        // The next submit will surface the lock error. Keep the UI quiet while editing.
      });
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function releaseActiveLock() {
    var lock = activeLock;
    activeLock = null;
    stopHeartbeat();
    if (!lock || !lock.tableId) return Promise.resolve();
    return apiPost("/api/tables/lock/release", { tableId: lock.tableId, purpose: lock.purpose }).catch(function () {});
  }
  window.__mobileServiceRecoveryReleaseActiveLock = releaseActiveLock;

  function acquireLock(order, purpose) {
    var tableId = normalizeText(order && order.tableId);
    if (!tableId) return Promise.reject(new Error("Tavolo non disponibile per il lock."));
    return releaseActiveLock()
      .then(function () {
        return apiPost("/api/tables/lock/acquire", { tableId: tableId, purpose: purpose });
      })
      .then(function (payload) {
        activeLock = { tableId: tableId, purpose: purpose, lock: payload.lock || null };
        startHeartbeat(tableId, purpose);
        return payload;
      });
  }

  function setLoadedOrderForModal(order) {
    state.order = order;
    state.orderId = normalizeText(order && order.id) || state.orderId;
    state.lines = aggregateOrderLines(order);
    state.orderUpdates = {
      note: normalizeText(order.note || order.orderNote),
      communications: normalizeText(order.communications || order.orderComment),
      covers: parseIntInRange(order.covers, 0, 999, 0),
      apericena: parseIntInRange(order.apericena, 0, 999, 0),
    };
	    state.lineDrafts = {};
	    state.selectedLineId = "";
	    state.replacementSelections = {};
	  }

  function openModalWithOrder(mode, order) {
    state = {
      open: true,
      mode: mode,
      orderId: normalizeText(order && order.id),
      loading: true,
      busy: false,
      error: "",
      order: null,
      lines: [],
      addRows: [],
      orderUpdates: {},
      selectedLineId: "",
      reasonPromptOpen: false,
	    replacementReason: "",
	    replacementReasonError: "",
	    replacementSelectionError: "",
	    replacementSelections: {},
	    cancelConfirmOpen: false,
      cancelReason: "",
      cancelReasonError: "",
      lineDrafts: {},
      correctionNoChangesError: "",
    };
    setLoadedOrderForModal(order);
    renderModal();
    var purpose = mode === "replacement" ? "order.comp" : "order.correction";
    Promise.all([
      acquireLock(order, purpose),
      mode === "correction" ? ensureMenuCatalogLoaded() : Promise.resolve(),
    ])
      .then(function () {
        state.loading = false;
        renderModal();
      })
      .catch(function (error) {
        state.loading = false;
        state.error = error instanceof Error ? error.message : String(error);
        renderModal();
      });
  }

  function openModal(mode, orderId, snapshot) {
    snapshot = rememberPreviewSnapshot(snapshot);
    state = {
      open: true,
      mode: mode,
      orderId: orderId,
      loading: true,
      busy: false,
      error: "",
      order: null,
      lines: [],
      addRows: [],
      orderUpdates: {},
      selectedLineId: "",
      reasonPromptOpen: false,
	    replacementReason: "",
	    replacementReasonError: "",
	    replacementSelectionError: "",
	    replacementSelections: {},
	    cancelConfirmOpen: false,
      cancelReason: "",
      cancelReasonError: "",
      lineDrafts: {},
      correctionNoChangesError: "",
    };
    renderModal();
    fetchOrder(orderId, snapshot)
      .then(function (order) {
        setLoadedOrderForModal(order);
        var purpose = mode === "replacement" ? "order.comp" : "order.correction";
        return Promise.all([
          acquireLock(order, purpose),
          mode === "correction" ? ensureMenuCatalogLoaded() : Promise.resolve(),
        ]);
      })
      .then(function () {
        state.loading = false;
        renderModal();
      })
      .catch(function (error) {
        state.loading = false;
        state.error = error instanceof Error ? error.message : String(error);
        renderModal();
      });
  }

  function openCorrectionChoice(orderId, snapshot) {
    snapshot = rememberPreviewSnapshot(snapshot);
    state = {
      open: true,
      mode: "choice",
      orderId: orderId,
      loading: true,
      busy: false,
      error: "",
      order: null,
      lines: [],
      addRows: [],
      orderUpdates: {},
      selectedLineId: "",
      reasonPromptOpen: false,
	    replacementReason: "",
	    replacementReasonError: "",
	    replacementSelectionError: "",
	    replacementSelections: {},
	    cancelConfirmOpen: false,
      cancelReason: "",
      cancelReasonError: "",
      lineDrafts: {},
      correctionNoChangesError: "",
    };
    renderModal();
    fetchOrder(orderId, snapshot)
      .then(function (order) {
        state.order = order;
        state.orderId = normalizeText(order.id) || state.orderId;
        state.lines = aggregateOrderLines(order);
        state.loading = false;
        renderModal();
      })
      .catch(function (error) {
        state.loading = false;
        state.error = error instanceof Error ? error.message : String(error);
        renderModal();
      });
  }
  window.__mobileOrderServiceRecoveryOpenAbbuono = function (orderId) {
    var safeOrderId = normalizeText(orderId) || getSelectedOrderId();
    if (!safeOrderId) {
      showToast("Seleziona una comanda.", "error");
      return;
    }
    openModal("replacement", safeOrderId, rememberPreviewSnapshot());
  };
  window.__mobileOrderServiceRecoveryOpenResoBar = window.__mobileOrderServiceRecoveryOpenAbbuono;
  window.__mobileOrderServiceRecoveryResolveOrderId = function (node) {
    return resolveOrderIdFromNode(node) || getSelectedOrderId();
  };

  function closeModal() {
    state.open = false;
    state.error = "";
    renderModal();
    void releaseActiveLock();
  }

  function resetPreviewOrderCache(orderId) {
    var safeOrderId = normalizeText(orderId);
    if (!safeOrderId || previewOrderCache.orderId === safeOrderId) {
      previewOrderCache.orderId = "";
      previewOrderCache.order = null;
      previewOrderCache.loading = false;
    }
  }

  function resolveMutatedOrderId(payload) {
    var candidates = [
      payload && payload.order && payload.order.id,
      payload && payload.comp && payload.comp.orderId,
      payload && payload.comp && payload.comp.originalOrderId,
      payload && payload.replacement && payload.replacement.originalOrderId,
      payload && payload.replacement && payload.replacement.orderId,
      state.order && state.order.id,
      state.orderId,
    ];
    for (var index = 0; index < candidates.length; index += 1) {
      var value = normalizeText(candidates[index]);
      if (value) return value;
    }
    return "";
  }

  function closeNativeHistoryPreview() {
    var closeButton = document.querySelector(".table-history-preview-close");
    if (isElement(closeButton)) {
      markSelfMutating();
      closeButton.click();
      return true;
    }
    var backdrop = document.querySelector(".table-history-preview-backdrop");
    if (isElement(backdrop)) {
      markSelfMutating();
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    return false;
  }

  function refreshHistoryAfterOperation(payload) {
    var orderId = resolveMutatedOrderId(payload);
    resetPreviewOrderCache(orderId);
    if (payload && payload.replacementOrder) {
      indexReplacementOrders([payload.replacementOrder]);
    }
    closeNativeHistoryPreview();
    try {
      window.dispatchEvent(new CustomEvent("mobile:orders-mutated", { detail: { orderId: orderId, payload: payload || null } }));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    } catch (_error) {}
    window.setTimeout(sync, 80);
    window.setTimeout(sync, 700);
    window.setTimeout(function () { ensureReplacementHistoryRows(true); }, 900);
  }

  function lineLabel(line) {
    var variant = normalizeText(line && (line.variantText || line.variant));
    return line.productName + (variant ? " (" + variant + ")" : "");
  }

  function renderLineDetails(line) {
    var groups = lineDetailGroups(line);
    if (!groups.length) return "";
    return (
      '<small class="msr-line-details msr-line-detail-chips">' +
      groups.map(function (group) {
        return '<span class="msr-line-detail-chip"><b>' + escapeHtml(group.label) + '</b><em>' + escapeHtml(group.value) + "</em></span>";
      }).join("") +
      "</small>"
    );
  }

  function splitLineDetailPieces(value) {
    return normalizeText(value)
      .split(/\s*(?:\/|·|\||,)\s*/g)
      .map(function (entry) { return normalizeText(entry); })
      .filter(Boolean);
  }

  function supplementLabelFromCode(code) {
    if (code === "apericena_prenotazione") return "Apericena Prenotazione";
    if (code === "menu_apericena") return "Menu Apericena";
    return "";
  }

  function lineSupplementCode(line) {
    var parts = [line && line.additionsText, line && line.note].concat(Array.isArray(line && line.details) ? line.details : []);
    return detectSupplement(parts.filter(Boolean).join(" / "));
  }

  function cleanLineAdditionsText(line) {
    var variantCompare = compactCompareText(line && (line.variantText || line.variant));
    return splitLineDetailPieces(line && line.additionsText)
      .filter(function (entry) {
        var compare = compactCompareText(entry);
        if (!compare) return false;
        if (variantCompare && compare === variantCompare) return false;
        return detectSupplement(entry) === "none";
      })
      .join(" / ");
  }

  function lineDetailGroups(line) {
    var groups = [];
    var seen = new Set();
    function push(label, value) {
      var safeValue = normalizeText(value);
      if (!safeValue) return;
      var key = compactCompareText(label + ":" + safeValue);
      if (!key || seen.has(key)) return;
      seen.add(key);
      groups.push({ label: label, value: safeValue });
    }
    var variant = normalizeText(line && (line.variantText || line.variant));
    var supplement = supplementLabelFromCode(lineSupplementCode(line));
    var additions = cleanLineAdditionsText(line);
    var note = normalizeText(line && line.note);
    push("Variante", variant);
    push("Supplemento", supplement);
    push("Aggiunte", additions);
    push("Note", note);
    var known = [];
    [variant, supplement, additions, note].forEach(function (value) {
      splitLineDetailPieces(value).forEach(function (piece) {
        var compare = compactCompareText(piece);
        if (compare && known.indexOf(compare) < 0) known.push(compare);
      });
    });
    (Array.isArray(line && line.details) ? line.details : []).forEach(function (detail) {
      splitLineDetailPieces(detail).forEach(function (piece) {
        var compare = compactCompareText(piece);
        if (!compare || known.indexOf(compare) >= 0 || detectSupplement(piece) !== "none") return;
        push("Dettaglio", piece);
      });
    });
    return groups;
  }

  function normalizeWorkflowStatus(value) {
    var workflow = normalizeText(value).toLowerCase().replace(/[_-]+/g, " ");
    if (!workflow) return "";
    if (workflow === "inviato" || workflow === "inviata") return "waiting";
    if (workflow === "in preparazione" || workflow === "preparazione") return "prep";
    if (workflow === "da ritirare" || workflow === "pronto" || workflow === "pronta") return "ready";
    if (workflow === "pronto al pagamento" || workflow === "consegnato" || workflow === "consegnata" || workflow === "da pagare" || workflow === "da incassare") return "delivered";
    if (workflow === "pagato" || workflow === "pagata") return "paid";
    if (workflow === "canceled" || workflow === "annullato" || workflow === "annullata") return "cancelled";
    return workflow.replace(/\s+/g, "_");
  }

  function isKnownWorkflowStatus(workflow) {
    return [
      "draft",
      "sent",
      "received",
      "queued",
      "waiting",
      "prep",
      "preparing",
      "in_preparation",
      "ready",
      "delivered",
      "paid",
      "cancelled",
      "voided",
    ].indexOf(workflow) >= 0;
  }

  function workflowOf(order) {
    var candidates = [
      order && order.workflowStatus,
      order && order.status,
      order && order.state,
      order && order.statusLabel,
      order && order.workflowLabel,
    ];
    var fallback = "";
    for (var index = 0; index < candidates.length; index += 1) {
      var workflow = normalizeWorkflowStatus(candidates[index]);
      if (!workflow) continue;
      if (isKnownWorkflowStatus(workflow)) return workflow;
      if (!fallback) fallback = workflow;
    }
    return fallback;
  }

  function paymentOf(order) {
    var payment = normalizeText(order && order.paymentStatus).toLowerCase().replace(/[_-]+/g, " ");
    if (payment === "pagato" || payment === "pagata") return "paid";
    return payment.replace(/\s+/g, "_");
  }

  function dueOf(order) {
    var total = Number(order && (order.total || order.totalAmount)) || 0;
    var paid = Number(order && order.paidAmount) || 0;
    var due = Number(order && order.dueAmount);
    return Number.isFinite(due) ? Math.max(due, 0) : Math.max(total - paid, 0);
  }

  function isOrderPaid(order) {
    if (!order) return false;
    if (paymentOf(order) === "paid") return true;
    var paid = Number(order && order.paidAmount) || 0;
    return dueOf(order) <= 0.009 && paid > 0.009;
  }

  function canShowComp(order) {
    var workflow = workflowOf(order);
    if (!order || isNonChargeableReplacementOrder(order)) return false;
    if (["cancelled", "voided", "draft"].indexOf(workflow) >= 0) return false;
    if (isOrderPaid(order)) return true;
    return (workflow === "ready" || workflow === "delivered") && dueOf(order) > 0.009;
  }

  function isCorrectionCashApprovalWorkflow(order) {
    var workflow = workflowOf(order);
    return ["prep", "preparing", "in_preparation"].indexOf(workflow) >= 0;
  }

  function canShowCorrection(order) {
    if (!order || isNonChargeableReplacementOrder(order) || isOrderPaid(order)) return false;
    var workflow = workflowOf(order);
    return ["cancelled", "voided", "paid"].indexOf(workflow) < 0;
  }

  function previewWorkflowOf() {
    var nodes = [
      document.querySelector(".table-history-preview-meta .table-history-state"),
      document.querySelector(".table-history-row.is-selected .table-history-state"),
    ];
    for (var index = 0; index < nodes.length; index += 1) {
      var workflow = normalizeWorkflowStatus(textOf(nodes[index]));
      if (workflow) return workflow;
    }
    return "";
  }

  function previewAllowsCorrection() {
    var fallbackOrder = previewFallbackOrder();
    return Boolean(fallbackOrder && (canShowCorrection(fallbackOrder) || canShowComp(fallbackOrder)));
  }

  function previewFallbackOrder() {
    var workflow = previewWorkflowOf();
    if (!workflow) return null;
    var paid = workflow === "paid";
    return {
      workflowStatus: workflow,
      paymentStatus: paid ? "paid" : "unpaid",
      dueAmount: paid ? 0 : 1,
      paidAmount: paid ? 1 : 0,
      total: 1,
    };
  }

  window.__mobileOrderServiceRecoveryShouldShowAbbuono = function (orderId) {
    var order = window.__mobileOrderServiceRecoveryGetPreviewOrder(orderId);
    return canShowComp(order);
  };
  window.__mobileOrderServiceRecoveryShouldShowResoBar = window.__mobileOrderServiceRecoveryShouldShowAbbuono;

  function normalizeReplacementSelections(selections) {
    var source = selections && typeof selections === "object" ? selections : {};
    var normalized = {};
    state.lines.forEach(function (line) {
      var lineId = normalizeText(line && line.lineId);
      if (!lineId || source[lineId] === undefined) return;
      normalized[lineId] = parseIntInRange(source[lineId], 1, parseIntInRange(line.qty, 1, 99, 1), 1);
    });
    return normalized;
  }

  function readReplacementSelectionsFromDom() {
    var selections = {};
    var rows = document.querySelectorAll("#" + MODAL_ID + " .msr-replacement-row[data-line-id]");
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      if (!row.classList.contains("is-selected")) continue;
      var lineId = normalizeText(row.getAttribute("data-line-id"));
      var line = state.lines.find(function (entry) { return entry.lineId === lineId; });
      if (!line) continue;
      var input = row.querySelector(".msr-replacement-qty-input");
      selections[lineId] = parseIntInRange(input && input.value, 1, parseIntInRange(line.qty, 1, 99, 1), 1);
    }
    state.replacementSelections = normalizeReplacementSelections(selections);
    return state.replacementSelections;
  }

  function selectedReplacementEntries() {
    var selections = normalizeReplacementSelections(state.replacementSelections);
    state.replacementSelections = selections;
    return state.lines
      .map(function (line) {
        var lineId = normalizeText(line && line.lineId);
        if (!lineId || selections[lineId] === undefined) return null;
        return {
          line: line,
          quantity: parseIntInRange(selections[lineId], 1, parseIntInRange(line.qty, 1, 99, 1), 1),
        };
      })
      .filter(Boolean);
  }

  function renderReplacementForm() {
    var order = state.order;
    var lines = state.lines;
    var selections = normalizeReplacementSelections(state.replacementSelections);
    var reasonErrorClass = state.replacementReasonError ? " is-error" : "";
    return (
      '<div class="msr-replacement-title">Scegli uno o piu articoli</div>' +
      (state.replacementSelectionError ? '<div class="msr-inline-error msr-selection-error">' + escapeHtml(state.replacementSelectionError) + "</div>" : "") +
      '<div class="msr-replacement-cart table-order-cart table-order-cart-drawer" role="listbox" aria-multiselectable="true" aria-label="Articoli rendibili">' +
      lines.map(function (line) {
        var selected = selections[line.lineId] !== undefined;
        var maxQty = parseIntInRange(line.qty, 1, 99, 1);
        var qty = selected ? parseIntInRange(selections[line.lineId], 1, maxQty, 1) : 1;
        var details = renderLineDetails(line);
        return (
          '<section class="msr-replacement-row table-order-item ' + (selected ? "is-selected is-open" : "") + '" role="option" aria-selected="' + (selected ? "true" : "false") + '" data-line-id="' + escapeHtml(line.lineId) + '" data-msr-unit-price="' + escapeHtml(unitPriceForLine(line).toFixed(4)) + '">' +
          '<button type="button" class="msr-replacement-check" aria-label="' + escapeHtml(selected ? "Deseleziona articolo" : "Seleziona articolo") + '" data-msr-action="toggle-replacement-line" data-line-id="' + escapeHtml(line.lineId) + '" data-checked="' + (selected ? "true" : "false") + '"><span></span></button>' +
          '<button type="button" class="table-order-item-main msr-replacement-main" data-msr-action="toggle-replacement-line" data-line-id="' + escapeHtml(line.lineId) + '">' +
          '<span class="table-order-item-info"><strong>' + escapeHtml(lineLabel(line)) + "</strong>" + details + '</span>' +
          '<span class="table-order-item-qty msr-replacement-qty"><strong>' + escapeHtml(line.qty + "x") + "</strong></span>" +
          "</button>" +
          '<div class="table-order-item-qty msr-replacement-qty-controls">' +
          '<button type="button" class="table-order-qty-btn is-minus" data-msr-action="replacement-qty-step" data-line-id="' + escapeHtml(line.lineId) + '" data-step="-1" aria-label="Riduci quantita" ' + (!selected ? "disabled" : "") + ">-</button>" +
          '<input class="msr-replacement-qty-input" data-line-id="' + escapeHtml(line.lineId) + '" type="number" min="1" max="' + escapeHtml(maxQty) + '" value="' + escapeHtml(qty) + '" ' + (!selected ? "disabled" : "") + " />" +
          '<button type="button" class="table-order-qty-btn is-plus" data-msr-action="replacement-qty-step" data-line-id="' + escapeHtml(line.lineId) + '" data-step="1" aria-label="Aumenta quantita" ' + (!selected ? "disabled" : "") + ">+</button>" +
          "</div>" +
          '<span class="msr-replacement-total table-order-item-total">' + escapeHtml(priceLabelForLineQty(line, qty)) + "</span>" +
          '</section>'
        );
      }).join("") +
      "</div>" +
      '<label class="msr-field' + reasonErrorClass + '"><span>Motivazione</span><textarea class="msr-input msr-textarea' + reasonErrorClass + '" data-msr-field="replacement-reason" maxlength="300" placeholder="Es. articolo caduto, errore servizio, rifacimento...">' + escapeHtml(state.replacementReason || "") + "</textarea></label>" +
      (state.replacementReasonError ? '<div class="msr-inline-error">' + escapeHtml(state.replacementReasonError) + "</div>" : "") +
      (!order || lines.length ? "" : '<div class="msr-error">Nessuna riga rendibile trovata.</div>')
    );
  }

  function renderCorrectionChoice() {
    return (
      '<div class="msr-choice-panel">' +
      '<div class="msr-choice-copy"><strong>Che cosa vuoi fare?</strong></div>' +
      '<div class="msr-choice-actions">' +
      '<button class="msr-choice-card msr-choice-danger" type="button" data-msr-action="submit-cancel-order" ' + (state.busy ? "disabled" : "") + ">" +
      '<strong>' + escapeHtml(state.busy ? "Annullamento..." : "Annulla comanda") + "</strong>" +
      '<span>Chiude la comanda e la rimuove dal lavoro operativo.</span>' +
      "</button>" +
      '<button class="msr-choice-card" type="button" data-msr-action="choose-correction" ' + (state.busy ? "disabled" : "") + ">" +
      "<strong>Modifica comanda</strong>" +
      "<span>Cambia quantita, varianti, supplementi, note o comunicazioni.</span>" +
      "</button>" +
      "</div></div>"
    );
  }

  function splitModifierText(value) {
    var text = normalizeText(value);
    if (!text) return { preset: "", custom: "" };
    var known = ["Senza ghiaccio", "Poco ghiaccio", "Con ghiaccio", "Con limone", "Senza zucchero", "Sour", "Fizz", "Liscio", "Lemon", "Tonic"];
    for (var index = 0; index < known.length; index += 1) {
      if (compactCompareText(text) === compactCompareText(known[index])) return { preset: known[index], custom: "" };
    }
    return { preset: "Personalizzata", custom: text };
  }

  function joinModifierText(preset, custom) {
    var safePreset = normalizeText(preset);
    var safeCustom = normalizeText(custom);
    if (safePreset === "Personalizzata") return safeCustom;
    return [safePreset, safeCustom].filter(Boolean).join(" / ");
  }

  function selectedOptionLabel(options, selectedValue, placeholder) {
    var selected = normalizeText(selectedValue);
    var match = (Array.isArray(options) ? options : []).find(function (option) { return option.value === selected; });
    return match ? match.label : placeholder;
  }

  function renderCustomDropdown(config) {
    var options = Array.isArray(config.options) ? config.options : [];
    var selected = normalizeText(config.value);
    var label = selectedOptionLabel(options, selected, config.placeholder || "Seleziona...");
    var hiddenClass = config.hiddenClass ? ' class="' + escapeHtml(config.hiddenClass) + '"' : "";
    var attrs = config.attrs || "";
    var key = config.key || ("dropdown_" + Math.random().toString(36).slice(2));
    var optionHtml = options.length
      ? options.map(function (option) {
          var value = normalizeText(option.value);
          var selectedClass = value === selected ? " is-selected" : "";
          var disabledClass = option.disabled ? " is-disabled" : "";
          return (
            '<button type="button" class="table-glass-dropdown-option' + selectedClass + disabledClass + '" role="option" aria-selected="' + (value === selected ? "true" : "false") + '" data-msr-action="select-custom-dropdown" data-msr-dropdown-value="' + escapeHtml(value) + '" ' + (option.disabled ? "disabled" : "") + ">" +
            '<span>' + escapeHtml(option.label) + "</span>" +
            (value === selected ? '<svg class="table-glass-dropdown-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"></path></svg>' : "") +
            "</button>"
          );
        }).join("")
      : '<div class="table-glass-dropdown-option is-empty" role="option" aria-selected="false">Nessuna opzione disponibile</div>';
    return (
      '<div class="table-glass-dropdown msr-custom-dropdown' + (config.className ? " " + escapeHtml(config.className) : "") + '" data-msr-dropdown-key="' + escapeHtml(key) + '">' +
      '<input type="hidden"' + hiddenClass + attrs + ' value="' + escapeHtml(selected) + '" />' +
      '<button type="button" class="table-glass-dropdown-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="' + escapeHtml(config.ariaLabel || config.label || "Seleziona") + '" data-msr-action="toggle-custom-dropdown">' +
      '<span class="table-glass-dropdown-label">' + escapeHtml(label || config.placeholder || "Seleziona...") + "</span>" +
      '<svg class="table-glass-dropdown-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>' +
      "</button>" +
      '<div class="table-glass-dropdown-menu" role="listbox" aria-label="' + escapeHtml(config.ariaLabel || config.label || "Seleziona") + '">' + optionHtml + "</div>" +
      "</div>"
    );
  }

  function productOptionList(selectedProductId) {
    var selected = normalizeText(selectedProductId);
    var products = catalogProducts();
    var options = [{ value: "", label: products.length ? "Articolo manuale" : "Catalogo non caricato" }];
    products.forEach(function (product) {
      options.push({ value: product.id, label: product.name + " - " + formatMoney(product.price) });
    });
    if (selected && !options.some(function (option) { return option.value === selected; })) {
      options.unshift({ value: selected, label: "Attuale: " + selected });
    }
    return options;
  }

  function lineDraftKey(line, index) {
    return normalizeText(line && line.lineId) || String(index);
  }

  function defaultLineDraft(line) {
    var detectedSupplement = lineSupplementCode(line);
    return {
      qty: line.qty,
      note: line.note || "",
      variant: normalizeText(line.variantText || line.variant || ""),
      modifierPreset: "",
      supplement: detectedSupplement,
      additions: cleanLineAdditionsText(line),
    };
  }

  function lineDraft(line, index) {
    var key = lineDraftKey(line, index);
    return (state.lineDrafts && state.lineDrafts[key]) || defaultLineDraft(line);
  }

  function readLineDraftsFromDom() {
    var drafts = {};
    var lineInputs = document.querySelectorAll("#" + MODAL_ID + " .msr-line-qty");
    for (var index = 0; index < lineInputs.length; index += 1) {
      var input = lineInputs[index];
      var lineIndex = Number(input.getAttribute("data-line-index"));
      var line = state.lines[lineIndex];
      if (!line) continue;
      var key = lineDraftKey(line, lineIndex);
      var noteInput = document.querySelector("#" + MODAL_ID + ' .msr-line-note[data-line-note-index="' + lineIndex + '"]');
      var variantInput = document.querySelector("#" + MODAL_ID + ' .msr-line-variant[data-line-variant-index="' + lineIndex + '"]');
      var modifierInput = document.querySelector("#" + MODAL_ID + ' .msr-line-modifier[data-line-modifier-index="' + lineIndex + '"]');
      var supplementInput = document.querySelector("#" + MODAL_ID + ' .msr-line-supplement[data-line-supplement-index="' + lineIndex + '"]');
      var additionsInput = document.querySelector("#" + MODAL_ID + ' .msr-line-additions[data-line-additions-index="' + lineIndex + '"]');
      drafts[key] = {
        qty: input.value,
        note: noteInput ? noteInput.value : "",
        variant: variantInput ? variantInput.value : "",
        modifierPreset: modifierInput ? modifierInput.value : "",
        supplement: supplementInput ? supplementInput.value : "none",
        additions: additionsInput ? additionsInput.value : "",
      };
    }
    state.lineDrafts = drafts;
    return drafts;
  }

  function renderLineVariantField(line, index, product, draft) {
    var current = normalizeText((draft && draft.variant) || line.variantText || line.variant || "");
    var attrs = ' data-line-variant-index="' + index + '"';
    if (product) {
      return (
        '<label class="msr-field"><span>' + escapeHtml(product.variantRequired ? "Variante obbligatoria" : "Variante") + '</span>' +
        renderCustomDropdown({
          key: "line_" + index + "_variant",
          value: current,
          options: variantOptionList(product, current, true),
          placeholder: product.variantRequired ? "Scegli variante" : "Nessuna variante",
          ariaLabel: "Variante " + product.name,
          hiddenClass: "msr-line-variant",
          attrs: attrs,
        }) +
        "</label>"
      );
    }
    return '<input type="hidden" class="msr-line-variant" data-line-variant-index="' + index + '" value="' + escapeHtml(current) + '" />';
  }

  function renderLineModifierFields(line, index, draft) {
    var baseDraft = draft || defaultLineDraft(line);
    var detectedSupplement = normalizeText(baseDraft.supplement) || "none";
    var product = findCatalogProductForLine(line);
    var basePrice = product ? computeCatalogBaseUnitPrice(product, baseDraft.variant) : unitPriceForLine(line);
    return (
      '<input type="hidden" class="msr-line-modifier" data-line-modifier-index="' + index + '" value="" />' +
      '<label class="msr-field"><span>Supplemento</span>' +
      renderCustomDropdown({
        key: "line_" + index + "_supplement",
        value: detectedSupplement,
        options: supplementOptionListForPrice(detectedSupplement, basePrice),
        placeholder: "Nessun supplemento",
        ariaLabel: "Supplemento " + lineLabel(line),
        hiddenClass: "msr-line-supplement",
        attrs: ' data-line-supplement-index="' + index + '"',
      }) +
      "</label>" +
      '<label class="msr-field msr-field-wide"><span>Aggiunte</span><textarea class="msr-input msr-line-additions" data-line-additions-index="' + index + '" maxlength="180" placeholder="Es. senza ghiaccio, extra limone...">' + escapeHtml(baseDraft.additions || "") + "</textarea></label>"
    );
  }

  function renderProductOptionsHtml(selectedProductId) {
    var selected = normalizeText(selectedProductId);
    return renderNativeOptions(productOptionList(selected), selected);
  }

  function renderAddVariantField(row, index, product) {
    var current = normalizeText(row.variant || "");
    if (product) {
      return (
        '<label class="msr-field"><span>' + escapeHtml(product.variantRequired ? "Variante obbligatoria" : "Variante") + '</span>' +
        renderCustomDropdown({
          key: "add_" + index + "_variant",
          value: current,
          options: variantOptionList(product, current, true),
          placeholder: product.variantRequired ? "Scegli variante" : "Nessuna variante",
          ariaLabel: "Variante " + product.name,
          attrs: ' data-msr-add-field="variant"',
        }) +
        "</label>"
      );
    }
    return '<input type="hidden" data-msr-add-field="variant" value="' + escapeHtml(current) + '" />';
  }

  function renderAddRow(row, index) {
    var product = findCatalogProductById(row.productId);
    var supplement = normalizeText(row.supplement) || "none";
    var finalPrice = product ? computeCatalogUnitPrice(product, row.variant, supplement) : parseMoney(row.price);
    var title = product ? product.name : normalizeText(row.name) || "Nuovo articolo";
    var qty = parseIntInRange(row.qty, 1, 99, 1);
    var basePrice = product ? computeCatalogBaseUnitPrice(product, row.variant) : finalPrice;
    return (
      '<section class="msr-add-row table-order-item is-open" data-msr-add-index="' + index + '" data-msr-unit-price="' + escapeHtml(finalPrice.toFixed(4)) + '">' +
      '<div class="table-order-item-main">' +
      '<button type="button" class="table-order-item-toggle msr-static-toggle" aria-label="Articolo aggiunto"><svg viewBox="0 0 24 24" class="table-order-item-chevron is-open" aria-hidden="true"><path d="M7 10l5 5 5-5"></path></svg></button>' +
      '<div class="table-order-item-info"><strong>' + escapeHtml(title) + '</strong><span class="table-order-item-sub">Aggiunta alla modifica</span></div>' +
      '<div class="table-order-item-qty">' +
      '<button type="button" class="table-order-qty-btn is-minus" data-msr-action="add-qty-step" data-index="' + index + '" data-step="-1" aria-label="Riduci quantita">-</button>' +
      '<input data-msr-add-field="qty" type="number" min="1" max="99" value="' + escapeHtml(qty) + '" />' +
      '<button type="button" class="table-order-qty-btn is-plus" data-msr-action="add-qty-step" data-index="' + index + '" data-step="1" aria-label="Aumenta quantita">+</button>' +
      "</div></div>" +
      '<div class="table-order-item-total">' + escapeHtml(formatMoney(finalPrice * qty)) + "</div>" +
      '<div class="table-order-item-details">' +
      '<label class="msr-field msr-field-product"><span>Articolo</span>' + renderCustomDropdown({
        key: "add_" + index + "_product",
        value: row.productId || "",
        options: productOptionList(row.productId),
        placeholder: "Articolo manuale",
        ariaLabel: "Articolo da aggiungere",
        className: "msr-product-dropdown",
        attrs: ' data-msr-add-field="productId"',
      }) + "</label>" +
      (!product ? '<label class="msr-field"><span>Nome manuale</span><input class="msr-input" data-msr-add-field="name" maxlength="120" placeholder="Nome prodotto" value="' + escapeHtml(row.name || "") + '" /></label>' : "") +
      '<label class="msr-field"><span>Prezzo finale</span><input class="msr-input" data-msr-add-field="price" inputmode="decimal" placeholder="0,00" value="' + escapeHtml(finalPrice ? finalPrice.toFixed(2) : row.price || "") + '" /></label>' +
      renderAddVariantField(row, index, product) +
      '<input type="hidden" data-msr-add-field="modifierPreset" value="" />' +
      '<label class="msr-field"><span>Supplemento</span>' + renderCustomDropdown({
        key: "add_" + index + "_supplement",
        value: supplement,
        options: supplementOptionListForPrice(supplement, basePrice),
        placeholder: "Nessun supplemento",
        ariaLabel: "Supplemento articolo aggiunto",
        attrs: ' data-msr-add-field="supplement"',
      }) + "</label>" +
      '<label class="msr-field msr-field-wide"><span>Aggiunte / modifiche libere</span><textarea class="msr-input msr-line-additions" data-msr-add-field="additions" maxlength="180" placeholder="Aggiunte o extra">' + escapeHtml(row.additions || "") + "</textarea></label>" +
      '<label class="msr-field msr-field-wide"><span>Note</span><textarea class="msr-input msr-line-note" data-msr-add-field="note" maxlength="180" placeholder="Note articolo">' + escapeHtml(row.note || "") + "</textarea></label>" +
      '<button class="smallbtn msr-secondary msr-remove-add" type="button" data-msr-action="remove-add-row" data-index="' + index + '">Rimuovi</button>' +
      "</div>" +
      "</section>"
    );
  }

  function renderCorrectionLine(line, index) {
    var product = findCatalogProductForLine(line);
    var draft = lineDraft(line, index);
    var isOpen = "";
    var details = renderLineDetails(line);
    var qty = parseIntInRange(draft.qty, 0, 99, line.qty);
    var unitPrice = unitPriceForLine(line);
    return (
      '<div class="table-order-swipe-row msr-correction-swipe-row">' +
      '<section class="msr-correction-row table-order-item' + isOpen + '" data-msr-line-index="' + index + '" data-msr-unit-price="' + escapeHtml(unitPrice.toFixed(4)) + '">' +
      '<div class="table-order-item-main">' +
      '<button type="button" class="table-order-item-toggle" data-msr-action="toggle-correction-line" data-line-index="' + index + '" aria-label="' + (isOpen ? "Riduci dettaglio articolo" : "Espandi dettaglio articolo") + '">' +
      '<svg viewBox="0 0 24 24" class="table-order-item-chevron' + isOpen + '" aria-hidden="true"><path d="M7 10l5 5 5-5"></path></svg>' +
      "</button>" +
      '<div class="table-order-item-info"><strong>' + escapeHtml(line.productName) + "</strong>" + details + "</div>" +
      '<div class="table-order-item-qty">' +
      '<button type="button" class="table-order-qty-btn is-minus" data-msr-action="line-qty-step" data-line-index="' + index + '" data-step="-1" aria-label="Riduci quantita">-</button>' +
      '<input class="msr-line-qty" data-line-index="' + index + '" type="number" min="0" max="99" value="' + escapeHtml(qty) + '" />' +
      '<button type="button" class="table-order-qty-btn is-plus" data-msr-action="line-qty-step" data-line-index="' + index + '" data-step="1" aria-label="Aumenta quantita">+</button>' +
      "</div></div>" +
      '<div class="table-order-item-total">' + escapeHtml(priceLabelForLineQty(line, qty)) + "</div>" +
      '<div class="table-order-item-details">' +
      '<div class="table-order-item-row msr-line-edit-grid">' +
      renderLineVariantField(line, index, product, draft) +
      renderLineModifierFields(line, index, draft) +
      "</div>" +
      '<label class="msr-field msr-field-wide"><span>Note articolo</span><textarea class="msr-input msr-line-note" data-line-note-index="' + index + '" maxlength="180" placeholder="Note articolo">' + escapeHtml(draft.note || "") + "</textarea></label>" +
      "</div></section></div>"
    );
  }

  function renderCorrectionForm() {
    var updates = state.orderUpdates || {};
    var requiresApproval = isCorrectionCashApprovalWorkflow(state.order);
    var rows = state.lines.map(function (line, index) {
      return renderCorrectionLine(line, index);
    }).join("");
	    return (
	      (requiresApproval ? '<div class="msr-info">La comanda e in preparazione: la modifica verra inviata alla cassa per autorizzazione.</div>' : "") +
	      (state.catalogError ? '<div class="msr-info msr-catalog-warning">Catalogo varianti non disponibile: puoi comunque compilare i campi manualmente.</div>' : "") +
	      (state.correctionNoChangesError ? '<div class="msr-inline-error msr-correction-nochange-error">' + escapeHtml(state.correctionNoChangesError) + "</div>" : "") +
	      '<section class="msr-correction-section msr-correction-section-items"><div class="msr-section-head"><div><span>ARTICOLI</span><strong>Comanda attuale</strong></div><em>' + escapeHtml(state.lines.length + " righe") + "</em></div>" +
	      '<div class="msr-correction-list table-order-cart table-order-cart-drawer">' + rows + "</div></section>" +
	      '<section class="msr-correction-section msr-order-notes-card table-order-item">' +
      '<div class="table-order-item-main">' +
      '<button type="button" class="table-order-item-toggle" data-msr-action="toggle-notes-section" aria-label="Espandi note ordine">' +
      '<svg viewBox="0 0 24 24" class="table-order-item-chevron" aria-hidden="true"><path d="M7 10l5 5 5-5"></path></svg>' +
      "</button>" +
      '<div class="table-order-item-info"><strong>Note ordine e comunicazioni</strong><span class="table-order-item-sub">Facoltative, in fondo alla modifica</span></div>' +
      "</div>" +
      '<div class="table-order-item-details">' +
      '<div class="table-order-notes table-order-notes-drawer msr-order-fields">' +
      '<label><span>Nota ordine</span><textarea class="msr-input msr-textarea" data-msr-field="order-note" maxlength="240" placeholder="Nota generale">' + escapeHtml(updates.note || "") + '</textarea></label>' +
      '<label><span>Comunicazioni interne</span><textarea class="msr-input msr-textarea" data-msr-field="order-communications" maxlength="240" placeholder="Comunicazioni interne o extra">' + escapeHtml(updates.communications || "") + '</textarea></label>' +
      "</div></div></section>" +
      '<section class="msr-correction-section msr-reason-box"><div class="msr-section-head"><div><span>MOTIVO</span><strong>Motivo modifica</strong></div></div>' +
      '<label class="msr-field"><span>Motivo</span><textarea class="msr-input msr-textarea" data-msr-field="correction-reason" maxlength="300" placeholder="Motivo modifica"></textarea></label></section>'
    );
  }

  function modalTitle() {
    return state.mode === "replacement" ? "Reso" : state.mode === "choice" ? "Gestisci comanda" : "Modifica comanda";
  }

  function renderReplacementReasonPrompt() {
    if (!state.reasonPromptOpen) return "";
    return (
      '<div class="msr-reason-backdrop"></div>' +
      '<section class="msr-reason-modal msr-notice-modal" role="alertdialog" aria-modal="true" aria-label="Motivo reso mancante">' +
      '<header><strong>Motivo mancante</strong></header>' +
      '<p class="msr-confirm-copy">Per registrare il reso a carico bar devi inserire una motivazione.</p>' +
      '<footer><button class="smallbtn msr-primary" type="button" data-msr-action="ack-replacement-reason">OK</button></footer>' +
      "</section>"
    );
  }

  function renderCancelConfirmPrompt() {
    if (!state.cancelConfirmOpen) return "";
    return (
      '<div class="msr-reason-backdrop"></div>' +
      '<section class="msr-reason-modal" role="dialog" aria-modal="true" aria-label="Conferma annullamento comanda">' +
      '<header><strong>Conferma annullamento</strong></header>' +
      '<p class="msr-confirm-copy">La comanda verra annullata e verra stampato il tagliando di annullamento.</p>' +
      (state.cancelReasonError ? '<div class="msr-error">' + escapeHtml(state.cancelReasonError) + "</div>" : "") +
      '<textarea class="msr-input msr-textarea" data-msr-field="cancel-reason" maxlength="300" placeholder="Motivo annullamento">' + escapeHtml(state.cancelReason || "") + "</textarea>" +
      '<footer><button class="smallbtn msr-secondary" type="button" data-msr-action="cancel-cancel-confirm">Indietro</button>' +
      '<button class="smallbtn msr-danger-confirm" type="button" data-msr-action="confirm-cancel-order" ' + (state.busy ? "disabled" : "") + ">" + (state.busy ? "Invio..." : "Conferma annulla") + "</button></footer>" +
      "</section>"
    );
  }

  function renderModal() {
    var root = document.getElementById(MODAL_ID);
    if (!state.open) {
      if (root) root.remove();
      return;
    }
    if (!root) {
      root = document.createElement("div");
      root.id = MODAL_ID;
      document.body.appendChild(root);
    }
    var order = state.order;
    var body = state.loading
      ? '<div class="msr-loading">Caricamento comanda...</div>'
      : state.error
        ? '<div class="msr-error">' + escapeHtml(state.error) + '</div>'
        : state.mode === "replacement"
          ? renderReplacementForm()
          : state.mode === "choice"
            ? renderCorrectionChoice()
            : renderCorrectionForm();
    root.innerHTML =
      '<div class="msr-backdrop" data-msr-action="close-modal"></div>' +
      '<section class="msr-composer-modal table-order-composer-backdrop" role="dialog" aria-modal="true" aria-label="' + escapeHtml(modalTitle()) + '">' +
      '<header class="msr-head"><div><strong>' + escapeHtml(modalTitle()) + '</strong><span>' +
      escapeHtml(order ? "Comanda " + order.id + " - Tavolo " + (order.tableLabel || order.tableNumber || order.tableId) : "Comanda " + state.orderId) +
      '</span></div><button class="msr-close" type="button" data-msr-action="close-modal" aria-label="Chiudi">x</button></header>' +
      '<div class="msr-body">' + body + '</div>' +
      '<footer class="msr-foot">' +
      '<button class="smallbtn msr-secondary" type="button" data-msr-action="close-modal">Annulla</button>' +
      (!state.loading && !state.error
        ? state.mode === "replacement"
          ? '<button class="smallbtn msr-primary" type="button" data-msr-action="submit-comp-only" ' + (state.busy ? "disabled" : "") + ">" + (state.busy ? "Invio..." : "Solo reso") + "</button>" +
            '<button class="smallbtn msr-primary" type="button" data-msr-action="submit-comp-replacement" ' + (state.busy ? "disabled" : "") + ">" + (state.busy ? "Invio..." : "Reso e sostituzione 0") + "</button>"
          : state.mode === "choice"
            ? ""
            : '<button class="smallbtn table-order-submit msr-submit-correction" type="button" data-msr-action="submit-modal" ' + (state.busy ? "disabled" : "") + ">" +
              '<svg class="table-order-submit-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5l17-8-4.2 17-2.9-6.6L3 11.5z"></path><path d="M12.9 13.4l6.1-9.9"></path></svg>' +
              '<span>' + (state.busy ? "Invio..." : "Invia modifica") + "</span></button>"
        : "") +
      '</footer></section>' +
      renderReplacementReasonPrompt() +
      renderCancelConfirmPrompt();
  }

  function readAddRowsFromDom() {
    var rows = [];
    var nodes = document.querySelectorAll("#" + MODAL_ID + " .msr-add-row[data-msr-add-index]");
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      function field(name) {
        return node.querySelector('[data-msr-add-field="' + name + '"]');
      }
      var productId = normalizeText(field("productId") && field("productId").value);
      var product = findCatalogProductById(productId);
      var variant = normalizeText(field("variant") && field("variant").value);
      var supplement = normalizeText(field("supplement") && field("supplement").value) || "none";
      var modifierPreset = normalizeText(field("modifierPreset") && field("modifierPreset").value);
      var additions = joinModifierText(modifierPreset, field("additions") && field("additions").value);
      var price = product ? computeCatalogUnitPrice(product, variant, supplement).toFixed(2) : normalizeText(field("price") && field("price").value);
      rows.push({
        productId: productId,
        name: product ? product.name : normalizeText(field("name") && field("name").value),
        qty: parseIntInRange(field("qty") && field("qty").value, 1, 99, 1),
        price: price,
        variant: variant,
        supplement: supplement,
        additions: additions,
        note: normalizeText(field("note") && field("note").value),
      });
    }
    return rows;
  }

  function readCorrectionPayload() {
    var changedItems = [];
    var removedItems = [];
    var addedItems = [];
    var lineInputs = document.querySelectorAll("#" + MODAL_ID + " .msr-line-qty");
    for (var index = 0; index < lineInputs.length; index += 1) {
      var input = lineInputs[index];
      var line = state.lines[Number(input.getAttribute("data-line-index"))];
      if (!line) continue;
      var nextQty = parseIntInRange(input.value, 0, 99, line.qty);
      var noteInput = document.querySelector("#" + MODAL_ID + ' .msr-line-note[data-line-note-index="' + index + '"]');
      var nextNotes = normalizeText(noteInput && noteInput.value);
      var variantInput = document.querySelector("#" + MODAL_ID + ' .msr-line-variant[data-line-variant-index="' + index + '"]');
      var modifierInput = document.querySelector("#" + MODAL_ID + ' .msr-line-modifier[data-line-modifier-index="' + index + '"]');
      var supplementInput = document.querySelector("#" + MODAL_ID + ' .msr-line-supplement[data-line-supplement-index="' + index + '"]');
      var additionsInput = document.querySelector("#" + MODAL_ID + ' .msr-line-additions[data-line-additions-index="' + index + '"]');
      var nextVariant = normalizeText(variantInput && variantInput.value);
      var nextSupplement = normalizeText(supplementInput && supplementInput.value) || "none";
      var nextAdditions = joinModifierText(modifierInput && modifierInput.value, additionsInput && additionsInput.value);
      var lineProduct = findCatalogProductForLine(line);
      var nextUnitPrice = lineProduct
        ? computeCatalogUnitPrice(lineProduct, nextVariant, nextSupplement)
        : Math.max(Number(line.unitPrice) || (Number(line.lineTotal) || 0) / Math.max(1, Number(line.qty) || 1) || 0, 0);
      var notesChanged = nextNotes !== normalizeText(line.note || "");
      var variantChanged = nextVariant !== normalizeText(line.variantText || line.variant || "");
      var additionsChanged = nextAdditions !== normalizeText(line.additionsText || "");
      var supplementChanged = nextSupplement !== detectSupplement([line.additionsText, line.note].filter(Boolean).join(" / "));
      var priceChanged = Math.abs(nextUnitPrice - Math.max(Number(line.unitPrice) || (Number(line.lineTotal) || 0) / Math.max(1, Number(line.qty) || 1) || 0, 0)) > 0.009;
      if (nextQty === line.qty && !notesChanged && !variantChanged && !additionsChanged && !supplementChanged && !priceChanged) continue;
      if (nextQty <= 0) {
        removedItems.push({ lineId: line.lineId, quantity: line.qty, productId: line.productId, productName: line.productName });
      } else {
        changedItems.push({
          lineId: line.lineId,
          nextQuantity: nextQty,
          productId: line.productId,
          productName: line.productName,
          nextNotes: nextNotes,
          nextVariant: nextVariant,
          nextModifiers: buildModifierPayload(nextVariant, nextAdditions, nextSupplement),
          nextUnitPrice: nextUnitPrice,
        });
      }
    }
    state.addRows = readAddRowsFromDom();
    state.addRows.forEach(function (row) {
      if (!row.name) return;
      addedItems.push({
        productId: row.productId || undefined,
        productName: row.name,
        quantity: row.qty,
        unitPrice: parseMoney(row.price),
        note: row.note,
        modifiers: buildModifierPayload(row.variant, row.additions, row.supplement),
      });
    });
    var originalOrder = state.order || {};
    function fieldValue(name, fallback) {
      var node = document.querySelector('[data-msr-field="' + name + '"]');
      return node ? node.value : fallback;
    }
    var originalCovers = parseIntInRange(originalOrder.covers, 0, 999, 0);
    var originalApericena = parseIntInRange(originalOrder.apericena, 0, 999, 0);
    var orderUpdates = {
      note: normalizeText(fieldValue("order-note", originalOrder.note || originalOrder.orderNote)),
      communications: normalizeText(fieldValue("order-communications", originalOrder.communications || originalOrder.orderComment)),
      covers: originalCovers,
      apericena: originalApericena,
    };
    var changedOrderUpdates = {};
    if (orderUpdates.note !== normalizeText(originalOrder.note || originalOrder.orderNote)) changedOrderUpdates.note = orderUpdates.note;
    if (orderUpdates.communications !== normalizeText(originalOrder.communications || originalOrder.orderComment)) changedOrderUpdates.communications = orderUpdates.communications;
    state.orderUpdates = orderUpdates;
    return {
      addedItems: addedItems,
      removedItems: removedItems,
      changedItems: changedItems,
      orderUpdates: changedOrderUpdates,
      reason: normalizeText(document.querySelector('[data-msr-field="correction-reason"]') && document.querySelector('[data-msr-field="correction-reason"]').value),
    };
  }

  function hasCorrectionChanges(diff) {
    return Boolean(
      diff &&
      (
        (diff.addedItems || []).length ||
        (diff.removedItems || []).length ||
        (diff.changedItems || []).length ||
        Object.keys(diff.orderUpdates || {}).length
      )
    );
  }

  function submitCorrection(existingDiff) {
    var order = state.order;
    if (!order) return Promise.reject(new Error("Comanda non caricata."));
    var diff = existingDiff || readCorrectionPayload();
    if (!hasCorrectionChanges(diff)) {
      return Promise.reject(new Error("Nessuna modifica da applicare."));
    }
    return apiPost("/api/integration/orders/correct", {
      orderId: order.id,
      tableId: order.tableId,
      roomId: order.roomId,
      tableLabel: order.tableLabel || order.logicalTableLabel || "",
      expectedRevision: parseIntInRange(order.currentRevision || order.revision, 1, 1000000, 1),
      addedItems: diff.addedItems,
      removedItems: diff.removedItems,
      changedItems: diff.changedItems,
      orderUpdates: diff.orderUpdates,
      reason: diff.reason,
      requestCashApproval: isCorrectionCashApprovalWorkflow(order),
      idempotencyKey: idempotencyKey("correction", order.id),
    });
  }

  function submitCancelOrder(reason) {
    var order = state.order;
    if (!order) return Promise.reject(new Error("Comanda non caricata."));
    var safeReason = normalizeText(reason || state.cancelReason) || "Annullata da operatore mobile";
    return acquireLock(order, "order.cancel").then(function () {
      return apiPost("/api/integration/orders/cancel", {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId,
        tableLabel: order.tableLabel || order.logicalTableLabel || "",
        expectedRevision: parseIntInRange(order.currentRevision || order.revision, 1, 1000000, 1),
        reason: safeReason,
        idempotencyKey: idempotencyKey("cancel", order.id),
      });
    });
  }

  function submitReplacement(reason, sendReplacement) {
    var order = state.order;
    if (!order) return Promise.reject(new Error("Comanda non caricata."));
    var entries = selectedReplacementEntries();
    if (!entries.length) return Promise.reject(new Error("Seleziona almeno un articolo da rendere."));
    var safeReason = normalizeText(reason);
    if (safeReason.length < 3) return Promise.reject(new Error("Inserisci il motivo del reso."));
    var results = [];
    return entries.reduce(function (chain, entry) {
      return chain.then(function () {
        var line = entry.line;
        return apiPost("/api/integration/orders/comp", {
          orderId: order.id,
          tableId: order.tableId,
          roomId: order.roomId,
          tableLabel: order.tableLabel || order.logicalTableLabel || "",
          productId: line.productId || slugify(line.productName, "product"),
          productName: line.productName,
          originalLineId: line.lineId,
          quantity: entry.quantity,
          reason: safeReason,
          sendReplacement: sendReplacement === true,
          idempotencyKey: idempotencyKey((sendReplacement === true ? "comp_replacement" : "comp") + "_" + line.lineId, order.id),
        }).then(function (payload) {
          results.push(payload);
          return payload;
        });
      });
    }, Promise.resolve()).then(function () {
      var lastPayload = results[results.length - 1] || {};
      return {
        ok: true,
        multiComp: true,
        results: results,
        comp: lastPayload.comp || (results[0] && results[0].comp) || null,
        replacement: lastPayload.replacement || null,
        replacementOrder: lastPayload.replacementOrder || null,
        order: lastPayload.order || order,
      };
    });
  }

  function isPendingCashApprovalPayload(payload) {
    var status = normalizeText(payload && payload.status).toLowerCase();
    var code = normalizeText(payload && payload.code).toUpperCase();
    return status === "pending_cash_approval" || code === "ORDER_CORRECTION_REQUIRES_CASH_APPROVAL";
  }

  function runOperation(operation, successMessage) {
    state.busy = true;
    renderModal();
    operation
      .then(function (payload) {
        showToast(
          successMessage ||
          (state.mode === "replacement"
            ? (payload && payload.replacement ? "Reso registrato e sostituzione inviata a costo 0." : "Reso registrato.")
            : isPendingCashApprovalPayload(payload)
              ? "Richiesta modifica inviata alla cassa."
              : "Modifica applicata."),
          "success"
        );
        closeModal();
        refreshHistoryAfterOperation(payload);
      })
      .catch(function (error) {
        state.busy = false;
        state.error = error instanceof Error ? error.message : String(error);
        renderModal();
      });
  }

  function submitModal() {
    if (state.mode === "replacement") {
      submitCompFromModal(false);
      return;
    }
    var diff;
    try {
      diff = readCorrectionPayload();
    } catch (error) {
      runOperation(Promise.reject(error));
      return;
    }
    if (!hasCorrectionChanges(diff)) {
      state.error = "";
      state.correctionNoChangesError = "Nessuna modifica da applicare.";
      renderModal();
      return;
    }
    state.correctionNoChangesError = "";
    var operation;
    try {
      operation = submitCorrection(diff);
    } catch (error) {
      operation = Promise.reject(error);
    }
    runOperation(operation);
  }

  function chooseCorrectionFromChoice() {
    if (state.order && normalizeText(state.order.id)) {
      openModalWithOrder("correction", state.order);
      return;
    }
    var safeOrderId = normalizeText(state.orderId);
    if (!safeOrderId || safeOrderId === PREVIEW_ORDER_SENTINEL) {
      state.error = "Comanda non caricata.";
      renderModal();
      return;
    }
    openModal("correction", safeOrderId, lastPreviewSnapshot);
  }

  function submitCancelFromChoice() {
    var operation;
    try {
      operation = submitCancelOrder();
    } catch (error) {
      operation = Promise.reject(error);
    }
    runOperation(operation, "Comanda annullata e stampa inviata.");
  }

  function openCancelConfirmFromChoice() {
    state.cancelConfirmOpen = true;
    state.cancelReasonError = "";
    renderModal();
  }

  function confirmCancelFromPrompt() {
    var input = document.querySelector("#" + MODAL_ID + ' [data-msr-field="cancel-reason"]');
    state.cancelReason = normalizeText(input && input.value);
    state.cancelReasonError = "";
    submitCancelFromChoice();
  }

  function submitCompFromModal(sendReplacement) {
    state.replacementSelections = readReplacementSelectionsFromDom();
    if (!selectedReplacementEntries().length) {
      state.error = "";
      state.replacementSelectionError = "Seleziona almeno un articolo da rendere.";
      renderModal();
      return;
    }
    var input = document.querySelector("#" + MODAL_ID + ' [data-msr-field="replacement-reason"]');
    var reason = normalizeText(input && input.value);
    state.replacementReason = reason;
    if (reason.length < 3) {
      state.error = "";
      state.replacementReasonError = "Inserisci il motivo del reso.";
      state.reasonPromptOpen = true;
      renderModal();
      return;
    }
    state.error = "";
    state.replacementSelectionError = "";
    state.replacementReasonError = "";
    var operation;
    try {
      operation = submitReplacement(reason, sendReplacement === true);
    } catch (error) {
      operation = Promise.reject(error);
    }
    runOperation(operation);
  }

  function focusReplacementReasonField() {
    window.setTimeout(function () {
      var input = document.querySelector("#" + MODAL_ID + ' [data-msr-field="replacement-reason"]');
      if (input && typeof input.focus === "function") input.focus();
    }, 40);
  }

  function acknowledgeReplacementReasonNotice() {
    state.reasonPromptOpen = false;
    state.replacementReasonError = "Inserisci il motivo del reso.";
    renderModal();
    focusReplacementReasonField();
  }

  function createActionButton(orderId, mode, snapshot) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "smallbtn mobile-history-print-btn mobile-service-recovery-btn mobile-service-recovery-btn-" + mode;
    button.innerHTML =
      '<span class="mobile-history-print-btn-icon mobile-service-recovery-btn-icon">' +
      (mode === "replacement"
        ? '<img class="mobile-service-recovery-broken-glass" src="/mobile/assets/brokenglass.png" alt="" aria-hidden="true" />'
        : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4.2L19.4 8.8a2 2 0 0 0 0-2.8L18 4.6a2 2 0 0 0-2.8 0L4 15.8V20Zm2-3.4L16.6 6 18 7.4 7.4 18H6v-1.4Z" fill="currentColor"/></svg>') +
      '</span><span class="mobile-history-print-btn-label">' +
      (mode === "replacement" ? "Reso" : "Modifica") +
      "</span>";
    button.setAttribute("data-msr-action", mode);
    button.setAttribute("data-msr-order-id", orderId);
    button.setAttribute("aria-label", mode === "replacement" ? "Reso" : "Modifica comanda");
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var actionSnapshot = rememberPreviewSnapshot(getPreviewSnapshot() || snapshot);
      if (mode === "correction") {
        openCorrectionChoice(orderId, actionSnapshot);
      } else {
        openModal(mode, orderId, actionSnapshot);
      }
    });
    return button;
  }

  function removePreviewCloseButton(actions) {
    var buttons = actions.querySelectorAll("button");
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (textOf(button).toLowerCase() === "chiudi") {
        button.remove();
      }
    }
  }

  function hideNativePayButtons(actions) {
    var buttons = actions.querySelectorAll("button");
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (button.closest("." + BUTTONS_CLASS)) continue;
      var label = textOf(button).toLowerCase();
      if (label === "paga" || label === "paga ordine" || label === "abbuono" || label === "reso bar" || label === "reso a carico bar" || label === "modifica") {
        button.hidden = true;
        button.style.display = "none";
        button.setAttribute("data-msr-native-payment-hidden", "1");
      }
    }
  }

  function dedupePreviewActionButtons(container) {
    if (!container) return;
    var seen = {};
    var buttons = container.querySelectorAll(".mobile-service-recovery-btn");
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      var key = normalizeText(button.getAttribute("data-msr-action") || textOf(button)).toLowerCase();
      if (!key) continue;
      if (seen[key]) {
        button.remove();
        continue;
      }
      seen[key] = true;
    }
  }

  function renderPreviewActionButtons(container, orderId, order, snapshot) {
    snapshot = rememberPreviewSnapshot(snapshot);
    markSelfMutating();
    container.innerHTML = "";
    var effectiveOrderId = normalizeText(order && order.id) || orderId;
    container.setAttribute("data-msr-order-id", effectiveOrderId);
    var showCorrection = canShowCorrection(order);
    var showComp = canShowComp(order);
    container.classList.toggle("is-single", (showCorrection ? 1 : 0) + (showComp ? 1 : 0) <= 1);
    if (showCorrection) {
      container.appendChild(createActionButton(effectiveOrderId, "correction", snapshot));
    }
    if (showComp) {
      container.appendChild(createActionButton(effectiveOrderId, "replacement", snapshot));
    }
    dedupePreviewActionButtons(container);
  }

  function unitPriceForLine(line) {
    var qty = Math.max(1, Math.trunc(Number(line && line.qty) || 1));
    var total = Math.max(Number(line && line.lineTotal) || Number(line && line.unitPrice) * qty || 0, 0);
    return Math.max(Number(line && line.unitPrice) || (qty > 0 ? total / qty : total) || 0, 0);
  }

  function priceLabelForLineQty(line, qtyValue) {
    var qty = Math.max(0, Math.trunc(Number(qtyValue) || 0));
    var unit = unitPriceForLine(line);
    var total = Math.max(unit * qty, 0);
    return qty > 1 ? formatMoney(unit) + " cad. - Tot. " + formatMoney(total) : formatMoney(total);
  }

  function priceLabelForLine(line) {
    return priceLabelForLineQty(line, Math.max(1, Math.trunc(Number(line && line.qty) || 1)));
  }

  function correctionRecordsForOrder(order) {
    if (Array.isArray(order && order.corrections) && order.corrections.length) return order.corrections;
    if (order && order.latestCorrection && typeof order.latestCorrection === "object") return [order.latestCorrection];
    return [];
  }

  function buildCorrectionState(order) {
    var changed = new Map();
    var removed = [];
    correctionRecordsForOrder(order).forEach(function (record) {
      (Array.isArray(record.changedItems) ? record.changedItems : []).forEach(function (item) {
        var lineId = normalizeText(item && item.lineId);
        if (lineId) changed.set(lineId, item);
      });
      (Array.isArray(record.removedItems) ? record.removedItems : []).forEach(function (item) {
        removed.push(item);
      });
    });
    return { changed: changed, removed: removed };
  }

  function renderCorrectionQuantityBadge(change) {
    if (!change || typeof change !== "object") return null;
    var previousQuantity = parseIntInRange(change.previousQuantity, 0, 999, 0);
    var nextQuantity = parseIntInRange(change.nextQuantity, 0, 999, previousQuantity);
    if (previousQuantity === nextQuantity) return null;
    var badge = document.createElement("span");
    badge.className = "mobile-service-recovery-qty-change " + (nextQuantity > previousQuantity ? "is-increase" : "is-decrease");
    badge.textContent = previousQuantity + " -> " + nextQuantity;
    return badge;
  }

  function annotatePreviewLinePrices(order) {
    var body = document.querySelector(".table-history-preview-body");
    if (!isElement(body) || !order) return;
    markSelfMutating();
    var lines = aggregateOrderLines(order);
    var correctionState = buildCorrectionState(order);
    body.querySelectorAll(".mobile-service-recovery-removed-line").forEach(function (node) { node.remove(); });
    var rows = body.querySelectorAll(".table-history-line:not(.table-history-line-empty)");
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      var oldPrice = row.querySelector(".mobile-service-recovery-line-price");
      if (oldPrice) oldPrice.remove();
      row.querySelectorAll(".mobile-service-recovery-qty-change").forEach(function (node) { node.remove(); });
      row.classList.remove("mobile-service-recovery-line-increase", "mobile-service-recovery-line-decrease", "mobile-service-recovery-line-removed");
      var line = lines[index];
      if (!line) continue;
      row.classList.add("mobile-service-recovery-priced-line");
      var change = correctionState.changed.get(line.lineId);
      if (change) {
        var previousQuantity = parseIntInRange(change.previousQuantity, 0, 999, line.qty);
        var nextQuantity = parseIntInRange(change.nextQuantity, 0, 999, line.qty);
        if (nextQuantity > previousQuantity) row.classList.add("mobile-service-recovery-line-increase");
        else if (nextQuantity < previousQuantity) row.classList.add("mobile-service-recovery-line-decrease");
      }
      var left = row.querySelector(".mobile-service-recovery-line-left");
      if (!left) {
        left = document.createElement("span");
        left.className = "mobile-service-recovery-line-left";
        while (row.firstChild) {
          left.appendChild(row.firstChild);
        }
        row.appendChild(left);
      }
      var qtyBadge = renderCorrectionQuantityBadge(change);
      if (qtyBadge) left.appendChild(qtyBadge);
      var price = document.createElement("span");
      price.className = "mobile-service-recovery-line-price";
      price.textContent = priceLabelForLine(line);
      row.appendChild(price);
    }
    correctionState.removed.forEach(function (item) {
      var removedRow = document.createElement("div");
      removedRow.className = "table-history-line mobile-service-recovery-priced-line mobile-service-recovery-line-removed mobile-service-recovery-removed-line";
      var left = document.createElement("span");
      left.className = "mobile-service-recovery-line-left";
      left.textContent = (parseIntInRange(item && (item.quantity || item.qty), 1, 999, 1)) + "x " + normalizeText(item && (item.productName || item.productId || item.lineId || "Articolo"));
      var price = document.createElement("span");
      price.className = "mobile-service-recovery-line-price";
      price.textContent = "Rimosso";
      removedRow.appendChild(left);
      removedRow.appendChild(price);
      body.appendChild(removedRow);
    });
  }

  function ensurePreviewLinePrices(orderId, snapshot) {
    snapshot = rememberPreviewSnapshot(snapshot);
    if (!orderId) {
      previewOrderCache.orderId = "";
      previewOrderCache.order = null;
      return;
    }
    if (previewOrderCache.orderId === orderId && previewOrderCache.order) {
      annotatePreviewLinePrices(previewOrderCache.order);
      var actions = document.querySelector(PREVIEW_ACTIONS_SELECTOR);
      var container = actions && actions.querySelector("." + BUTTONS_CLASS);
      if (container) renderPreviewActionButtons(container, orderId, previewOrderCache.order, snapshot);
      return;
    }
    if (previewOrderCache.loading && previewOrderCache.orderId === orderId) return;
    previewOrderCache.orderId = orderId;
    previewOrderCache.order = null;
    previewOrderCache.loading = true;
    fetchOrder(orderId, snapshot)
      .then(function (order) {
        if (previewOrderCache.orderId !== orderId) return;
        previewOrderCache.order = order;
        annotatePreviewLinePrices(order);
        var actions = document.querySelector(PREVIEW_ACTIONS_SELECTOR);
        var container = actions && actions.querySelector("." + BUTTONS_CLASS);
        if (container) renderPreviewActionButtons(container, orderId, order, snapshot);
      })
      .catch(function () {
        var actions = document.querySelector(PREVIEW_ACTIONS_SELECTOR);
        var container = actions && actions.querySelector("." + BUTTONS_CLASS);
        var fallbackOrder = previewFallbackOrder();
        if (container && fallbackOrder) renderPreviewActionButtons(container, orderId, fallbackOrder, snapshot);
      })
      .finally(function () {
        if (previewOrderCache.orderId === orderId) previewOrderCache.loading = false;
      });
  }

  function ensurePreviewButtons() {
    var actions = document.querySelector(PREVIEW_ACTIONS_SELECTOR);
    if (!isElement(actions)) return;
    var snapshot = rememberPreviewSnapshot();
    removePreviewCloseButton(actions);
    hideNativePayButtons(actions);
    var orderId = getSelectedOrderId();
    var container = actions.querySelector("." + BUTTONS_CLASS);
    if (!orderId) {
      if (container) {
        markSelfMutating();
        container.remove();
      }
      return;
    }
    if (!container) {
      markSelfMutating();
      container = document.createElement("div");
      container.className = BUTTONS_CLASS;
      var printActions = actions.querySelector(".mobile-history-print-preview-actions");
      if (printActions && printActions.nextSibling) actions.insertBefore(container, printActions.nextSibling);
      else if (printActions) actions.appendChild(container);
      else actions.appendChild(container);
    }
    var currentOrderId = normalizeText(container.getAttribute("data-msr-order-id"));
    if (currentOrderId === orderId && container.childElementCount > 0) {
      ensurePreviewLinePrices(orderId, snapshot);
      return;
    }
    container.setAttribute("data-msr-order-id", orderId);
    markSelfMutating();
    container.innerHTML = "";
    if (previewAllowsCorrection()) {
      renderPreviewActionButtons(container, orderId, previewFallbackOrder(), snapshot);
    }
    ensurePreviewLinePrices(orderId, snapshot);
  }

  function sync() {
    ensurePreviewButtons();
    ensureReplacementHistoryRows(false);
    var orderId = getSelectedOrderId();
    if (orderId) ensurePreviewLinePrices(orderId);
  }

  function scheduleSync() {
    if (selfMutating) return;
    window.requestAnimationFrame(sync);
  }

  function closeCustomDropdowns(except) {
    var nodes = document.querySelectorAll("#" + MODAL_ID + " .msr-custom-dropdown.is-open");
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (except && node === except) continue;
      node.classList.remove("is-open");
      var trigger = node.querySelector(".table-glass-dropdown-trigger");
      var icon = node.querySelector(".table-glass-dropdown-icon");
      if (trigger) {
        trigger.classList.remove("is-open");
        trigger.setAttribute("aria-expanded", "false");
      }
      if (icon) icon.classList.remove("is-open");
    }
  }

  function toggleCustomDropdown(actionNode) {
    var dropdown = actionNode.closest(".msr-custom-dropdown");
    if (!dropdown) return;
    var willOpen = !dropdown.classList.contains("is-open");
    closeCustomDropdowns(dropdown);
    dropdown.classList.toggle("is-open", willOpen);
    actionNode.classList.toggle("is-open", willOpen);
    actionNode.setAttribute("aria-expanded", willOpen ? "true" : "false");
    var icon = dropdown.querySelector(".table-glass-dropdown-icon");
    if (icon) icon.classList.toggle("is-open", willOpen);
  }

  function clearCorrectionNoChangesError() {
    if (!state.correctionNoChangesError) return;
    state.correctionNoChangesError = "";
    var node = document.querySelector("#" + MODAL_ID + " .msr-correction-nochange-error");
    if (node) node.remove();
  }

  function clearReplacementSelectionError() {
    if (!state.replacementSelectionError) return;
    state.replacementSelectionError = "";
    var node = document.querySelector("#" + MODAL_ID + " .msr-selection-error");
    if (node) node.remove();
  }

  function selectCustomDropdownOption(actionNode) {
    if (actionNode.disabled || actionNode.classList.contains("is-disabled")) return;
    var dropdown = actionNode.closest(".msr-custom-dropdown");
    if (!dropdown) return;
    var input = dropdown.querySelector('input[type="hidden"]');
    if (!input) return;
    var value = normalizeText(actionNode.getAttribute("data-msr-dropdown-value"));
    input.value = value;
    if (state.mode === "correction") clearCorrectionNoChangesError();
    var label = dropdown.querySelector(".table-glass-dropdown-label");
    var optionText = textOf(actionNode.querySelector("span")) || textOf(actionNode);
    if (label) label.textContent = optionText;
    var options = dropdown.querySelectorAll(".table-glass-dropdown-option");
    for (var index = 0; index < options.length; index += 1) {
      var option = options[index];
      var selected = normalizeText(option.getAttribute("data-msr-dropdown-value")) === value;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-selected", selected ? "true" : "false");
    }
    closeCustomDropdowns();
    var addRow = dropdown.closest(".msr-add-row");
    var fieldName = input.getAttribute("data-msr-add-field");
    if (addRow && fieldName) {
      if (fieldName === "productId") {
        var variantInput = addRow.querySelector('[data-msr-add-field="variant"]');
        if (variantInput) variantInput.value = "";
      }
      readLineDraftsFromDom();
      state.addRows = readAddRowsFromDom();
      renderModal();
      return;
    }
    if (input.classList.contains("msr-line-variant")) {
      readLineDraftsFromDom();
      state.addRows = readAddRowsFromDom();
      renderModal();
    }
  }

  function stepNumberInput(input, step, min, max) {
    if (!input) return;
    var current = parseIntInRange(input.value, min, max, min);
    input.value = String(Math.max(min, Math.min(max, current + step)));
    updateQuantityTotal(input);
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_error) {}
  }

  function updateQuantityTotal(input) {
    if (!input) return;
    var row = input.closest(".msr-correction-row, .msr-add-row, .msr-replacement-row");
    if (!row) return;
    var target = row.querySelector(".table-order-item-total");
    var unit = Number(row.getAttribute("data-msr-unit-price")) || 0;
    var min = row.classList.contains("msr-add-row") || row.classList.contains("msr-replacement-row") ? 1 : 0;
    var max = Number(input.getAttribute("max")) || 99;
    var qty = parseIntInRange(input.value, min, max, min);
    input.value = String(qty);
    if (target) {
      var total = Math.max(unit * qty, 0);
      target.textContent = (row.classList.contains("msr-correction-row") || row.classList.contains("msr-replacement-row")) && qty > 1
        ? formatMoney(unit) + " cad. - Tot. " + formatMoney(total)
        : formatMoney(total);
    }
  }

  function toggleCorrectionLine(actionNode) {
    var row = actionNode.closest(".msr-correction-row");
    if (!row) return;
    var willOpen = !row.classList.contains("is-open");
    var rows = document.querySelectorAll("#" + MODAL_ID + " .msr-correction-row.table-order-item");
    for (var index = 0; index < rows.length; index += 1) {
      var current = rows[index];
      var open = current === row ? willOpen : false;
      current.classList.toggle("is-open", open);
      var trigger = current.querySelector(".table-order-item-toggle");
      var chevron = current.querySelector(".table-order-item-chevron");
      if (chevron) chevron.classList.toggle("is-open", open);
      if (trigger) trigger.setAttribute("aria-label", open ? "Riduci dettaglio articolo" : "Espandi dettaglio articolo");
    }
  }

  function toggleNotesSection(actionNode) {
    var card = actionNode.closest(".msr-order-notes-card");
    if (!card) return;
    var willOpen = !card.classList.contains("is-open");
    card.classList.toggle("is-open", willOpen);
    var trigger = card.querySelector(".table-order-item-toggle");
    var chevron = card.querySelector(".table-order-item-chevron");
    if (chevron) chevron.classList.toggle("is-open", willOpen);
    if (trigger) trigger.setAttribute("aria-label", willOpen ? "Riduci note ordine" : "Espandi note ordine");
  }

  function updateReplacementRowSelectionDom(row, line, selected) {
    if (!row || !line) return;
    var lineId = normalizeText(line.lineId);
    var maxQty = parseIntInRange(line.qty, 1, 99, 1);
    var qty = selected ? parseIntInRange(state.replacementSelections[lineId], 1, maxQty, 1) : 1;
    row.classList.toggle("is-selected", selected);
    row.classList.toggle("is-open", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
    var check = row.querySelector(".msr-replacement-check");
    if (check) {
      check.setAttribute("aria-label", selected ? "Deseleziona articolo" : "Seleziona articolo");
      check.setAttribute("data-checked", selected ? "true" : "false");
    }
    var input = row.querySelector(".msr-replacement-qty-input");
    if (input) {
      input.disabled = !selected;
      input.value = String(qty);
    }
    row.querySelectorAll(".msr-replacement-qty-controls .table-order-qty-btn").forEach(function (button) {
      button.disabled = !selected;
    });
    var total = row.querySelector(".msr-replacement-total.table-order-item-total");
    if (total) total.textContent = priceLabelForLineQty(line, qty);
  }

  function toggleReplacementLine(actionNode) {
    state.replacementSelections = readReplacementSelectionsFromDom();
    var reasonFieldBefore = document.querySelector("#" + MODAL_ID + ' [data-msr-field="replacement-reason"]');
    state.replacementReason = normalizeText(reasonFieldBefore && reasonFieldBefore.value);
    var nextLineId = normalizeText(actionNode.getAttribute("data-line-id"));
    if (!nextLineId) return;
    var line = state.lines.find(function (entry) { return entry.lineId === nextLineId; });
    if (!line) return;
    if (state.replacementSelections[nextLineId] === undefined) {
      state.replacementSelections[nextLineId] = 1;
      state.selectedLineId = nextLineId;
    } else {
      delete state.replacementSelections[nextLineId];
      if (state.selectedLineId === nextLineId) {
        var remainingIds = Object.keys(state.replacementSelections);
        state.selectedLineId = remainingIds[0] || "";
      }
    }
    state.replacementSelections = normalizeReplacementSelections(state.replacementSelections);
    var selected = state.replacementSelections[nextLineId] !== undefined;
    state.replacementReasonError = "";
    clearReplacementSelectionError();
    state.error = "";
    updateReplacementRowSelectionDom(
      actionNode.closest(".msr-replacement-row"),
      line,
      selected
    );
    var reasonField = document.querySelector("#" + MODAL_ID + ' [data-msr-field="replacement-reason"]');
    if (reasonField) {
      reasonField.classList.remove("is-error");
      var reasonWrapper = reasonField.closest(".msr-field");
      if (reasonWrapper) reasonWrapper.classList.remove("is-error");
    }
    var reasonError = document.querySelector("#" + MODAL_ID + " .msr-inline-error:not(.msr-selection-error)");
    if (reasonError) reasonError.remove();
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var actionNode = target.closest("[data-msr-action]");
    if (!actionNode) {
      if (state.open && !target.closest(".msr-custom-dropdown")) closeCustomDropdowns();
      return;
    }
    var action = actionNode.getAttribute("data-msr-action");
    if (action === "close-modal") {
      event.preventDefault();
      closeModal();
    } else if (action === "toggle-custom-dropdown") {
      event.preventDefault();
      toggleCustomDropdown(actionNode);
    } else if (action === "select-custom-dropdown") {
      event.preventDefault();
      selectCustomDropdownOption(actionNode);
    } else if (action === "toggle-correction-line") {
      event.preventDefault();
      toggleCorrectionLine(actionNode);
    } else if (action === "toggle-notes-section") {
      event.preventDefault();
      toggleNotesSection(actionNode);
    } else if (action === "line-qty-step") {
      event.preventDefault();
      clearCorrectionNoChangesError();
      var lineIndex = actionNode.getAttribute("data-line-index");
      stepNumberInput(document.querySelector("#" + MODAL_ID + ' .msr-line-qty[data-line-index="' + lineIndex + '"]'), Number(actionNode.getAttribute("data-step")) || 0, 0, 99);
    } else if (action === "add-qty-step") {
      event.preventDefault();
      clearCorrectionNoChangesError();
      var addRow = actionNode.closest(".msr-add-row");
      stepNumberInput(addRow && addRow.querySelector('[data-msr-add-field="qty"]'), Number(actionNode.getAttribute("data-step")) || 0, 1, 99);
    } else if (action === "replacement-qty-step") {
      event.preventDefault();
      var replacementRow = actionNode.closest(".msr-replacement-row");
      var replacementInput = replacementRow && replacementRow.querySelector(".msr-replacement-qty-input");
      stepNumberInput(replacementInput, Number(actionNode.getAttribute("data-step")) || 0, 1, Number(replacementInput && replacementInput.getAttribute("max")) || 99);
      state.replacementSelections = readReplacementSelectionsFromDom();
    } else if (action === "submit-modal") {
      event.preventDefault();
      submitModal();
    } else if (action === "choose-correction") {
      event.preventDefault();
      chooseCorrectionFromChoice();
    } else if (action === "submit-cancel-order") {
      event.preventDefault();
      openCancelConfirmFromChoice();
    } else if (action === "confirm-cancel-order") {
      event.preventDefault();
      confirmCancelFromPrompt();
    } else if (action === "cancel-cancel-confirm") {
      event.preventDefault();
      state.cancelConfirmOpen = false;
      state.cancelReasonError = "";
      renderModal();
    } else if (action === "submit-comp-only") {
      event.preventDefault();
      submitCompFromModal(false);
    } else if (action === "submit-comp-replacement") {
      event.preventDefault();
      submitCompFromModal(true);
    } else if (action === "toggle-replacement-line" || action === "select-replacement-line") {
      event.preventDefault();
      toggleReplacementLine(actionNode);
    } else if (action === "ack-replacement-reason") {
      event.preventDefault();
      acknowledgeReplacementReasonNotice();
    } else if (action === "cancel-replacement-reason") {
      event.preventDefault();
      state.reasonPromptOpen = false;
      renderModal();
    } else if (action === "add-row") {
      event.preventDefault();
      clearCorrectionNoChangesError();
      readLineDraftsFromDom();
      state.addRows = readAddRowsFromDom();
      state.addRows.push({ id: "add_" + Date.now().toString(36) });
      renderModal();
    } else if (action === "remove-add-row") {
      event.preventDefault();
      clearCorrectionNoChangesError();
      readLineDraftsFromDom();
      state.addRows = readAddRowsFromDom();
      var index = Number(actionNode.getAttribute("data-index"));
      state.addRows.splice(index, 1);
      renderModal();
    }
  }, true);

  document.addEventListener("change", function (event) {
    var target = event.target;
    if (!(target instanceof Element) || !state.open || state.mode !== "correction") return;
    var addField = target.closest("#" + MODAL_ID + ' [data-msr-add-field="productId"], #' + MODAL_ID + ' [data-msr-add-field="variant"], #' + MODAL_ID + ' [data-msr-add-field="supplement"], #' + MODAL_ID + ' [data-msr-add-field="modifierPreset"]');
    if (!addField) return;
    clearCorrectionNoChangesError();
    readLineDraftsFromDom();
    state.addRows = readAddRowsFromDom();
    renderModal();
  }, true);

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!(target instanceof Element) || !state.open) return;
    if (state.mode === "replacement" && target.matches("#" + MODAL_ID + " .msr-replacement-qty-input")) {
      updateQuantityTotal(target);
      state.replacementSelections = readReplacementSelectionsFromDom();
      clearReplacementSelectionError();
      return;
    }
    if (state.mode !== "correction") return;
    clearCorrectionNoChangesError();
    if (target.matches("#" + MODAL_ID + " .msr-line-qty") || target.matches("#" + MODAL_ID + ' [data-msr-add-field="qty"]')) {
      updateQuantityTotal(target);
    }
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.open) closeModal();
  });

  function start() {
    scheduleSync();
    if (observer) observer.disconnect();
    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(function () {
      if (!document.hidden) sync();
    }, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) scheduleSync();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
