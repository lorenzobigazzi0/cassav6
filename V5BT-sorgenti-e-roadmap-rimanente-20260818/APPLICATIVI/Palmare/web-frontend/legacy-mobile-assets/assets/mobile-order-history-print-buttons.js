(function mobileOrderHistoryPrintButtonsBootstrap() {
  if (window.__mobileOrderHistoryPrintButtonsInitialized) {
    return;
  }

  window.__mobileOrderHistoryPrintButtonsInitialized = true;

  var ROW_SELECTOR = ".table-history-row";
  var RIGHT_SELECTOR = ".table-history-right";
  var PREVIEW_ACTIONS_SELECTOR = ".table-history-preview-actions";
  var ROW_ACTIONS_CLASS = "mobile-history-print-actions";
  var PREVIEW_ACTIONS_CLASS = "mobile-history-print-preview-actions";
  var BUTTON_CLASS = "mobile-history-print-btn";
  var TOAST_LAYER_CLASS = "mobile-history-print-toast-layer";
  var ACTIVE_CLASS = "is-busy";
  var POLL_MS = 1600;
  var observer = null;
  var pollTimer = null;
  var activeJobs = new Set();

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getReactFiber(node) {
    if (!node) return null;
    for (var key in node) {
      if (key.indexOf("__reactFiber$") === 0 || key.indexOf("__reactInternalInstance$") === 0) {
        return node[key];
      }
    }
    return null;
  }

  function getFiberKey(fiber) {
    var current = fiber;
    var seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (typeof current.key === "string" && current.key.trim()) {
        return current.key.trim();
      }
      current = current.return;
    }
    return "";
  }

  function resolveOrderIdFromNode(node) {
    var current = node;
    while (isElement(current) && current !== document.body) {
      var fiber = getReactFiber(current);
      var fiberKey = getFiberKey(fiber);
      if (fiberKey) {
        return fiberKey;
      }
      if (fiber && fiber.alternate) {
        fiberKey = getFiberKey(fiber.alternate);
        if (fiberKey) {
          return fiberKey;
        }
      }
      current = current.parentElement;
    }
    return "";
  }

  function getOrderIdForRow(row) {
    if (!isElement(row)) return "";
    var cached = String(row.getAttribute("data-mobile-history-order-id") || "").trim();
    if (cached) {
      return cached;
    }
    var orderId = resolveOrderIdFromNode(row);
    if (orderId) {
      row.setAttribute("data-mobile-history-order-id", orderId);
    }
    return orderId;
  }

  function getSelectedOrderId() {
    var selectedRow = document.querySelector(ROW_SELECTOR + ".is-selected");
    return getOrderIdForRow(selectedRow);
  }

  function getToastLayer() {
    var layer = document.querySelector("." + TOAST_LAYER_CLASS);
    if (layer) {
      return layer;
    }

    layer = document.createElement("div");
    layer.className = TOAST_LAYER_CLASS;
    document.body.appendChild(layer);
    return layer;
  }

  function showToast(message, tone) {
    var text = String(message || "").trim();
    if (!text) return;

    var layer = getToastLayer();
    var toast = document.createElement("div");
    toast.className = "mobile-history-print-toast" + (tone === "error" ? " is-error" : "");
    toast.textContent = text;
    layer.appendChild(toast);

    window.requestAnimationFrame(function () {
      toast.classList.add("is-visible");
    });

    window.setTimeout(function () {
      toast.classList.remove("is-visible");
      window.setTimeout(function () {
        if (toast.parentElement) {
          toast.parentElement.removeChild(toast);
        }
      }, 220);
    }, 2400);
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

  function buttonJobKey(orderId, kind) {
    return String(orderId || "").trim() + "::" + String(kind || "").trim();
  }

  function forEachManagedButton(callback) {
    var buttons = document.querySelectorAll("." + BUTTON_CLASS);
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (!isElement(button)) continue;
      callback(button);
    }
  }

  function getButtonLabel(kind, busy) {
    if (busy) return "Stampa...";
    return kind === "order" ? "Comanda" : "Preconto";
  }

  function printerIconMarkup() {
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M7 9V4h10v5"></path>' +
      '<rect x="4" y="9" width="16" height="8" rx="2"></rect>' +
      '<path d="M7 14h10v6H7z"></path>' +
      '<path d="M16 12h.01"></path>' +
      "</svg>"
    );
  }

  function renderButtonContent(button, kind, busy) {
    if (!isElement(button)) return;
    button.innerHTML =
      '<span class="mobile-history-print-btn-icon">' +
      printerIconMarkup() +
      "</span>" +
      '<span class="mobile-history-print-btn-label">' +
      getButtonLabel(kind, busy) +
      "</span>";
  }

  function setButtonsBusy(orderId, kind, busy) {
    var safeOrderId = String(orderId || "").trim();
    var safeKind = String(kind || "").trim();
    forEachManagedButton(function (button) {
      if (
        String(button.getAttribute("data-mobile-order-id") || "").trim() !== safeOrderId ||
        String(button.getAttribute("data-mobile-print-kind") || "").trim() !== safeKind
      ) {
        return;
      }
      button.disabled = !!busy;
      button.classList.toggle(ACTIVE_CLASS, !!busy);
      renderButtonContent(button, safeKind, !!busy);
    });
  }

  function requestPrint(orderId, kind) {
    var safeOrderId = String(orderId || "").trim();
    var safeKind = kind === "order" ? "order" : "preconto";
    var jobKey = buttonJobKey(safeOrderId, safeKind);
    if (!safeOrderId || activeJobs.has(jobKey)) {
      return Promise.resolve(false);
    }

    activeJobs.add(jobKey);
    setButtonsBusy(safeOrderId, safeKind, true);

    return fetch("/api/integration/print", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: safeKind,
        orderId: safeOrderId,
        clientApp: "mobile-history-print",
      }),
    })
      .then(function (response) {
        return readResponseJson(response).then(function (payload) {
          if (!response.ok || !payload || payload.ok === false) {
            var errorMessage =
              (payload && (payload.error || payload.message)) || "Stampa non riuscita.";
            throw new Error(String(errorMessage).trim() || "Stampa non riuscita.");
          }
          return payload;
        });
      })
      .then(function (payload) {
        var kindLabel = safeKind === "order" ? "Comanda" : "Preconto";
        var printerLabel = String(payload && payload.printer ? payload.printer : "").trim();
        showToast(
          printerLabel ? kindLabel + " inviata su " + printerLabel : kindLabel + " inviata in stampa",
          "success"
        );
        return true;
      })
      .catch(function (error) {
        var message = error instanceof Error ? error.message : "Stampa non riuscita.";
        showToast(message, "error");
        return false;
      })
      .finally(function () {
        activeJobs.delete(jobKey);
        setButtonsBusy(safeOrderId, safeKind, false);
      });
  }

  function createPrintButton(orderId, kind) {
    var safeKind = kind === "order" ? "order" : "preconto";
    var button = document.createElement("button");
    button.type = "button";
    button.className =
      "smallbtn " + BUTTON_CLASS + " mobile-history-print-btn-" + safeKind;
    button.setAttribute("data-mobile-order-id", orderId);
    button.setAttribute("data-mobile-print-kind", safeKind);
    button.setAttribute(
      "aria-label",
      safeKind === "order" ? "Stampa comanda" : "Stampa preconto"
    );
    renderButtonContent(button, safeKind, false);

    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var currentOrderId = String(button.getAttribute("data-mobile-order-id") || "").trim();
      var currentKind = String(button.getAttribute("data-mobile-print-kind") || "").trim();
      void requestPrint(currentOrderId, currentKind);
    });

    button.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.stopPropagation();
      }
    });

    return button;
  }

  function ensureRowButtons(row) {
    if (!isElement(row)) return;

    var right = row.querySelector(RIGHT_SELECTOR);
    if (!isElement(right)) return;

    var orderId = getOrderIdForRow(row);
    var container = right.querySelector("." + ROW_ACTIONS_CLASS);

    if (!orderId) {
      if (container) {
        container.remove();
      }
      return;
    }

    if (!container) {
      container = document.createElement("div");
      container.className = ROW_ACTIONS_CLASS;
      container.appendChild(createPrintButton(orderId, "order"));
      container.appendChild(createPrintButton(orderId, "preconto"));
      right.appendChild(container);
    } else {
      var buttons = container.querySelectorAll("." + BUTTON_CLASS);
      for (var index = 0; index < buttons.length; index += 1) {
        buttons[index].setAttribute("data-mobile-order-id", orderId);
      }
    }
  }

  function ensurePreviewButtons() {
    var previewActions = document.querySelector(PREVIEW_ACTIONS_SELECTOR);
    if (!isElement(previewActions)) return;

    var orderId = getSelectedOrderId();
    var container = previewActions.querySelector("." + PREVIEW_ACTIONS_CLASS);

    if (!orderId) {
      if (container) {
        container.remove();
      }
      return;
    }

    if (!container) {
      container = document.createElement("div");
      container.className = PREVIEW_ACTIONS_CLASS;
      container.appendChild(createPrintButton(orderId, "order"));
      container.appendChild(createPrintButton(orderId, "preconto"));
      previewActions.insertBefore(container, previewActions.firstChild);
    } else {
      var buttons = container.querySelectorAll("." + BUTTON_CLASS);
      for (var index = 0; index < buttons.length; index += 1) {
        buttons[index].setAttribute("data-mobile-order-id", orderId);
      }
    }
  }

  function syncHistoryPrintButtons() {
    var rows = document.querySelectorAll(ROW_SELECTOR);
    for (var index = 0; index < rows.length; index += 1) {
      ensureRowButtons(rows[index]);
    }
    ensurePreviewButtons();
  }

  function scheduleSync() {
    window.requestAnimationFrame(syncHistoryPrintButtons);
  }

  function start() {
    scheduleSync();

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(function () {
      scheduleSync();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
    }

    pollTimer = window.setInterval(function () {
      if (!document.hidden) {
        syncHistoryPrintButtons();
      }
    }, POLL_MS);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        scheduleSync();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
