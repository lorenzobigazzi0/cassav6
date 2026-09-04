(function mobileOrderHistoryPaymentBridgeBootstrap() {
  if (window.__mobileOrderHistoryPaymentBridgeInitialized) {
    return;
  }

  window.__mobileOrderHistoryPaymentBridgeInitialized = true;

  var HISTORY_ACTION_SELECTOR = ".table-history-action";
  var HISTORY_PREVIEW_ACTION_SELECTOR = ".table-history-preview-action";
  var MODE_GRID_SELECTOR = ".table-payment-mode-grid";
  var METHOD_GRID_SELECTOR = ".table-payment-method-grid";
  var STEP_HEAD_SELECTOR = ".table-payment-step-head";
  var STEP_HEAD_BUTTON_SELECTOR = ".table-payment-step-head .smallbtn";
  var FLAG_TTL_MS = 12000;
  var POLL_MS = 250;
  var observer = null;
  var pollTimer = null;
  var pendingRedirect = null;

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isHistoryPayButton(button) {
    if (!isElement(button)) return false;
    var selector = HISTORY_ACTION_SELECTOR + ", " + HISTORY_PREVIEW_ACTION_SELECTOR;
    if (!button.matches(selector)) return false;
    var label = textOf(button).toLowerCase();
    return label === "paga" || label === "paga ordine";
  }

  function markPendingRedirect(sourceButton) {
    pendingRedirect = {
      createdAt: Date.now(),
      sourceLabel: textOf(sourceButton),
      consumed: false,
    };
  }

  function clearExpiredRedirect() {
    if (!pendingRedirect) return;
    if (Date.now() - pendingRedirect.createdAt > FLAG_TTL_MS) {
      pendingRedirect = null;
    }
  }

  function hasPendingRedirect() {
    clearExpiredRedirect();
    return Boolean(pendingRedirect && pendingRedirect.consumed !== true);
  }

  function isModeStepVisible() {
    return isElement(document.querySelector(MODE_GRID_SELECTOR));
  }

  function isMethodStepVisible() {
    return isElement(document.querySelector(METHOD_GRID_SELECTOR));
  }

  function findDivisionBackButton() {
    if (!isMethodStepVisible()) {
      return null;
    }

    var buttons = document.querySelectorAll(STEP_HEAD_BUTTON_SELECTOR);
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (!isElement(button)) continue;
      var label = textOf(button).toLowerCase();
      if (label.indexOf("divisione conto") >= 0) {
        return button;
      }
    }

    return null;
  }

  function findMethodStepHeading() {
    var stepHead = document.querySelector(STEP_HEAD_SELECTOR);
    return isElement(stepHead) ? textOf(stepHead).toLowerCase() : "";
  }

  function routeToSplitStep() {
    if (!hasPendingRedirect()) {
      return;
    }

    if (isModeStepVisible()) {
      pendingRedirect = null;
      return;
    }

    var backButton = findDivisionBackButton();
    if (!isElement(backButton) && findMethodStepHeading().indexOf("metodo di pagamento") < 0) {
      return;
    }

    pendingRedirect.consumed = true;
    window.requestAnimationFrame(function () {
      if (isElement(backButton) && document.contains(backButton)) {
        backButton.click();
      }
      pendingRedirect = null;
    });
  }

  function scheduleRouteCheck() {
    window.requestAnimationFrame(routeToSplitStep);
  }

  function handleDocumentClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    var selector = HISTORY_ACTION_SELECTOR + ", " + HISTORY_PREVIEW_ACTION_SELECTOR;
    var button = target.closest(selector);
    if (!isHistoryPayButton(button)) {
      return;
    }

    markPendingRedirect(button);
    scheduleRouteCheck();
  }

  function start() {
    document.addEventListener("click", handleDocumentClick, true);

    observer = new MutationObserver(function () {
      routeToSplitStep();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    pollTimer = window.setInterval(function () {
      if (!document.hidden) {
        routeToSplitStep();
      }
    }, POLL_MS);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        scheduleRouteCheck();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
