(function () {
  if (window.__mobileMenuScrollRestoreBridgeInstalled === true) return;
  window.__mobileMenuScrollRestoreBridgeInstalled = true;

  "use strict";

  var STORAGE_KEY = "mobile:menu:product-scroll:v1";
  var MAX_STATE_AGE_MS = 10 * 60 * 1000;
  var RESTORE_ATTEMPTS = 22;
  var RESTORE_INTERVAL_MS = 45;
  var restoreTimer = 0;
  var memoryState = null;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function safeJsonParse(value) {
    if (!value) return null;
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function readStoredState() {
    var state = memoryState;
    if (!state) {
      try {
        state = safeJsonParse(window.sessionStorage.getItem(STORAGE_KEY));
      } catch (_) {
        state = null;
      }
    }
    if (!state || !Number.isFinite(Number(state.savedAt))) return null;
    if (Date.now() - Number(state.savedAt) > MAX_STATE_AGE_MS) {
      clearState();
      return null;
    }
    return state;
  }

  function writeState(state) {
    memoryState = state;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function clearState() {
    memoryState = null;
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function activeMenuBrowser() {
    return document.querySelector(".home-view.view-menu .menu-browser");
  }

  function menuTitle(browser) {
    return normalizeText(browser && browser.querySelector(".menu-stage-title") && browser.querySelector(".menu-stage-title").textContent);
  }

  function menuScroller(browser) {
    return browser && browser.querySelector(".menu-browser-content");
  }

  function rowName(row) {
    return normalizeText(row && row.querySelector(".menu-product-name") && row.querySelector(".menu-product-name").textContent);
  }

  function saveFromProductRow(row) {
    if (!row || !row.closest) return;
    var browser = row.closest(".menu-browser");
    var scroller = menuScroller(browser);
    var stage = row.closest(".menu-stage.is-products");
    var list = row.closest(".menu-product-list");
    if (!browser || !scroller || !stage || !list) return;

    var rows = Array.prototype.slice.call(list.querySelectorAll(".menu-product-row"));
    var index = rows.indexOf(row);
    var scrollerRect = scroller.getBoundingClientRect();
    var rowRect = row.getBoundingClientRect();
    writeState({
      savedAt: Date.now(),
      categoryTitle: menuTitle(browser),
      productName: rowName(row),
      rowIndex: index,
      scrollTop: Number(scroller.scrollTop) || 0,
      rowOffset: rowRect.top - scrollerRect.top
    });
  }

  function findTargetRow(list, state) {
    var rows = Array.prototype.slice.call(list.querySelectorAll(".menu-product-row"));
    if (!rows.length) return null;
    var productName = normalizeText(state.productName);
    if (productName) {
      var byName = rows.find(function (row) {
        return rowName(row) === productName;
      });
      if (byName) return byName;
    }
    var index = Number(state.rowIndex);
    if (Number.isFinite(index) && index >= 0 && index < rows.length) {
      return rows[index];
    }
    return null;
  }

  function restoreOnce() {
    var state = readStoredState();
    if (!state) return false;

    var browser = activeMenuBrowser();
    if (!browser) return false;
    if (browser.querySelector(".menu-stage.is-categories")) {
      clearState();
      return false;
    }
    if (browser.querySelector(".menu-stage.is-product-detail")) return false;

    var stage = browser.querySelector(".menu-stage.is-products");
    var list = stage && stage.querySelector(".menu-product-list");
    var scroller = menuScroller(browser);
    if (!stage || !list || !scroller) return false;

    var currentTitle = menuTitle(browser);
    if (state.categoryTitle && currentTitle && state.categoryTitle !== currentTitle) {
      return false;
    }

    var maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll <= 0 && Number(state.scrollTop) > 0) return false;

    var desiredTop = Number(state.scrollTop);
    var targetRow = findTargetRow(list, state);
    var rowOffset = Number(state.rowOffset);
    if (targetRow && Number.isFinite(rowOffset)) {
      desiredTop =
        targetRow.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        rowOffset;
    }

    desiredTop = clamp(Number.isFinite(desiredTop) ? desiredTop : 0, 0, maxScroll);
    if (Math.abs(scroller.scrollTop - desiredTop) > 1) {
      scroller.scrollTop = desiredTop;
    }
    return true;
  }

  function scheduleRestore() {
    if (restoreTimer) return;
    var attempts = 0;
    var firstAppliedAt = 0;
    restoreTimer = window.setInterval(function () {
      attempts += 1;
      var applied = restoreOnce();
      if (applied && !firstAppliedAt) firstAppliedAt = Date.now();
      if (firstAppliedAt && Date.now() - firstAppliedAt > 700) {
        clearState();
      }
      if (attempts >= RESTORE_ATTEMPTS || !readStoredState()) {
        window.clearInterval(restoreTimer);
        restoreTimer = 0;
      }
    }, RESTORE_INTERVAL_MS);
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      var row = target && target.closest && target.closest(".home-view.view-menu .menu-stage.is-products .menu-product-row");
      if (row) saveFromProductRow(row);
    },
    true
  );

  var observer = new MutationObserver(function () {
    if (readStoredState()) scheduleRestore();
  });

  function start() {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"]
      });
    }
    if (readStoredState()) scheduleRestore();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
