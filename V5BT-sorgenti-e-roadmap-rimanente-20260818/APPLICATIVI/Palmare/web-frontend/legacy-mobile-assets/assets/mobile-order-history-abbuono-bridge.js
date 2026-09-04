(function mobileOrderHistoryAbbuonoBridge() {
  if (window.__mobileOrderHistoryAbbuonoBridgeInitialized) return;
  window.__mobileOrderHistoryAbbuonoBridgeInitialized = true;

  var HISTORY_ACTION_SELECTOR = ".table-history-action";
  var HISTORY_PREVIEW_ACTION_SELECTOR = ".table-history-preview-action";
  var ACTION_SELECTOR = HISTORY_ACTION_SELECTOR + ", " + HISTORY_PREVIEW_ACTION_SELECTOR;
  var ROW_SELECTOR = ".table-history-row";
  var POLL_MS = 1000;
  var observer = null;
  var pollTimer = null;
  var syncScheduled = false;
  var selfMutating = false;

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function textOf(node) {
    return normalizeText(node && node.textContent);
  }

  function isPayLabel(label) {
    var safe = normalizeText(label).toLowerCase();
    return safe === "paga" || safe === "paga ordine";
  }

  function isAbbuonoButton(button) {
    if (!isElement(button)) return false;
    var label = normalizeText(button.textContent).toLowerCase();
    return button.getAttribute("data-moha-abbuono") === "1" || label === "abbuono" || label === "reso bar" || label === "reso a carico bar";
  }

  function isPreviewAction(button) {
    return isElement(button) && button.matches(HISTORY_PREVIEW_ACTION_SELECTOR);
  }

  function isManagedByServiceRecovery(button) {
    return (
      isElement(button) &&
      (button.getAttribute("data-msr-native-payment-hidden") === "1" ||
        button.closest(".mobile-service-recovery-actions") ||
        button.classList.contains("mobile-service-recovery-btn"))
    );
  }

  function keepServiceRecoveryHidden(button) {
    if (!isElement(button) || button.getAttribute("data-msr-native-payment-hidden") !== "1") return false;
    button.hidden = true;
    button.style.display = "none";
    return true;
  }

  function hideCardLevelReso(button) {
    if (!isElement(button) || isPreviewAction(button)) return false;
    if (!button.matches(HISTORY_ACTION_SELECTOR)) return false;
    if (!isAbbuonoButton(button)) return false;
    button.hidden = true;
    button.style.display = "none";
    button.setAttribute("data-moha-card-reso-hidden", "1");
    return true;
  }

  function injectStyle() {
    if (document.getElementById("mobile-order-history-abbuono-bridge-style")) return;
    var style = document.createElement("style");
    style.id = "mobile-order-history-abbuono-bridge-style";
    style.textContent = [
      ".mobile-order-history-abbuono-btn{background:linear-gradient(135deg,#f7b267,#f79d65)!important;border-color:rgba(247,157,101,.75)!important;color:#241207!important;box-shadow:0 10px 22px rgba(247,157,101,.24)!important;}",
      ".mobile-order-history-abbuono-btn:disabled{opacity:.6!important;box-shadow:none!important;}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function getReactFiber(node) {
    if (!node) return null;
    for (var key in node) {
      if (key.indexOf("__reactFiber$") === 0 || key.indexOf("__reactInternalInstance$") === 0) return node[key];
    }
    return null;
  }

  function getFiberKey(fiber) {
    var current = fiber;
    var seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (typeof current.key === "string" && current.key.trim()) return current.key.trim();
      current = current.return;
    }
    return "";
  }

  function resolveOrderIdFromNode(node, skipSelectedFallback) {
    if (typeof window.__mobileOrderServiceRecoveryResolveOrderId === "function") {
      var bridged = normalizeText(window.__mobileOrderServiceRecoveryResolveOrderId(node));
      if (bridged) return bridged;
    }
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
    var selectedRow = document.querySelector(ROW_SELECTOR + ".is-selected");
    if (!skipSelectedFallback && selectedRow) {
      var selectedKey = resolveOrderIdFromNode(selectedRow, true);
      if (selectedKey) return selectedKey;
    }
    var title = textOf(document.querySelector(".table-history-preview-title"));
    var match = title.match(/comanda\s*:\s*([^\s]+)/i);
    return match ? match[1].trim() : "";
  }

  function convertButton(button) {
    if (!isElement(button)) return;
    if (isManagedByServiceRecovery(button)) {
      keepServiceRecoveryHidden(button);
      return;
    }
    if (hideCardLevelReso(button)) return;
    if (!isPreviewAction(button)) return;
    var label = textOf(button);
    if (!isPayLabel(label) && !isAbbuonoButton(button)) return;
    var orderId = resolveOrderIdFromNode(button);
    if (
      typeof window.__mobileOrderServiceRecoveryShouldShowResoBar === "function" &&
      !window.__mobileOrderServiceRecoveryShouldShowResoBar(orderId)
    ) {
      button.hidden = true;
      button.style.display = "none";
      button.setAttribute("data-moha-hidden-until-ready", "1");
      return;
    }
    button.hidden = false;
    if (button.getAttribute("data-moha-hidden-until-ready") === "1") {
      button.style.display = "";
      button.removeAttribute("data-moha-hidden-until-ready");
    }
    if (button.getAttribute("data-moha-abbuono") !== "1") {
      button.setAttribute("data-moha-abbuono", "1");
    }
    if (!button.classList.contains("mobile-order-history-abbuono-btn")) {
      button.classList.add("mobile-order-history-abbuono-btn");
    }
    if (label !== "Reso") {
      button.textContent = "Reso";
    }
    if (button.getAttribute("aria-label") !== "Reso") {
      button.setAttribute("aria-label", "Reso");
    }
  }

  function syncButtons() {
    injectStyle();
    selfMutating = true;
    try {
      var buttons = document.querySelectorAll(ACTION_SELECTOR);
      for (var index = 0; index < buttons.length; index += 1) {
        convertButton(buttons[index]);
      }
    } finally {
      window.setTimeout(function () {
        selfMutating = false;
      }, 0);
    }
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    window.requestAnimationFrame(function () {
      syncScheduled = false;
      syncButtons();
    });
  }

  function openAbbuono(button) {
    var orderId = resolveOrderIdFromNode(button);
    if (typeof window.__mobileOrderServiceRecoveryOpenResoBar === "function") {
      window.__mobileOrderServiceRecoveryOpenResoBar(orderId);
      return;
    }
    if (typeof window.__mobileOrderServiceRecoveryOpenAbbuono === "function") {
      window.__mobileOrderServiceRecoveryOpenAbbuono(orderId);
      return;
    }
    window.alert("Modulo reso a carico bar non ancora pronto. Riapri il dettaglio comanda e riprova.");
  }

  function handleClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var button = target.closest(ACTION_SELECTOR);
    if (!isElement(button)) return;
    if (isManagedByServiceRecovery(button)) {
      keepServiceRecoveryHidden(button);
      return;
    }
    if (hideCardLevelReso(button)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      return;
    }
    if (!isPreviewAction(button)) return;
    if (!isAbbuonoButton(button) && !isPayLabel(textOf(button))) return;
    convertButton(button);
    if (button.hidden || button.getAttribute("data-moha-hidden-until-ready") === "1") {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (button.disabled) return;
    openAbbuono(button);
  }

  function start() {
    syncButtons();
    document.addEventListener("click", handleClick, true);
    observer = new MutationObserver(function () {
      if (!selfMutating) scheduleSync();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    pollTimer = window.setInterval(function () {
      if (!document.hidden) syncButtons();
    }, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) scheduleSync();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
