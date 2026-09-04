(function mobileStationAvailabilityGuard() {
  if (window.__mobileStationAvailabilityGuardInstalled === true) return;
  window.__mobileStationAvailabilityGuardInstalled = true;

  var ACTIVE_STATIONS_PATH = "/api/integration/stations/active";
  var WARNING_ID = "mobile-no-active-stations-warning";
  var STYLE_ID = "mobile-no-active-stations-warning-style";
  var POLL_MS = 15000;
  var state = {
    noActiveStations: false,
    loading: false,
    lastCheckedAt: 0,
    warnedComposer: null,
    warnedComposerKey: "",
    pollTimer: 0,
  };

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function isElement(value) {
    return value instanceof Element;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".mobile-no-active-stations-backdrop{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(7,15,27,.58);}",
      ".mobile-no-active-stations-card{width:min(430px,calc(100vw - 30px));border-radius:22px;background:#fffaf0;color:#241607;border:1px solid rgba(185,105,20,.28);box-shadow:0 26px 70px rgba(0,0,0,.38);overflow:hidden;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;}",
      ".mobile-no-active-stations-head{display:flex;align-items:center;gap:12px;padding:16px 18px;background:linear-gradient(135deg,#ffe6a8,#ffc85f);}",
      ".mobile-no-active-stations-icon{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(88,43,0,.12);color:#6b3500;font-size:1.35rem;font-weight:950;}",
      ".mobile-no-active-stations-title{font-size:1.08rem;font-weight:950;line-height:1.18;}",
      ".mobile-no-active-stations-body{padding:16px 18px;font-size:.98rem;font-weight:800;line-height:1.38;}",
      ".mobile-no-active-stations-body strong{font-weight:950;}",
      ".mobile-no-active-stations-actions{display:flex;justify-content:flex-end;padding:0 18px 16px;}",
      ".mobile-no-active-stations-ok{min-height:44px;border:0;border-radius:14px;padding:0 18px;background:#1f6fb8;color:#fff;font-weight:950;box-shadow:0 12px 24px rgba(31,111,184,.22);}",
      ".mobile-no-active-stations-ok:active{transform:translateY(1px) scale(.985);}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function orderComposerNode() {
    return (
      document.querySelector(".table-order-composer-backdrop .table-order-composer") ||
      document.querySelector(".table-order-composer-backdrop")
    );
  }

  function removeWarning() {
    var warning = document.getElementById(WARNING_ID);
    if (warning) warning.remove();
  }

  function composerWarningKey(composer) {
    if (!isElement(composer)) return "";
    var recoveryRoot = composer.closest("#mobile-service-recovery-modal-root");
    if (recoveryRoot) return "service-recovery";
    if (!composer.dataset.mobileStationWarningKey) {
      composer.dataset.mobileStationWarningKey = "composer_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    }
    return composer.dataset.mobileStationWarningKey;
  }

  function showWarningForComposer(composer) {
    if (!composer || state.noActiveStations !== true) return;
    var composerKey = composerWarningKey(composer);
    if ((composerKey && state.warnedComposerKey === composerKey) || document.getElementById(WARNING_ID)) return;
    ensureStyle();
    state.warnedComposer = composer;
    state.warnedComposerKey = composerKey;
    var root = document.createElement("div");
    root.id = WARNING_ID;
    root.className = "mobile-no-active-stations-backdrop";
    root.setAttribute("role", "presentation");
    root.innerHTML =
      '<section class="mobile-no-active-stations-card" role="alertdialog" aria-modal="true" aria-labelledby="mobile-no-active-stations-title">' +
      '<header class="mobile-no-active-stations-head">' +
      '<div class="mobile-no-active-stations-icon" aria-hidden="true">!</div>' +
      '<div class="mobile-no-active-stations-title" id="mobile-no-active-stations-title">Nessuna postazione attiva</div>' +
      "</header>" +
      '<div class="mobile-no-active-stations-body">' +
      "<strong>Attenzione:</strong> nessuna postazione attiva, gli ordini andranno in coda ma non verranno preparati fino alla riattivazione di almeno una postazione." +
      "</div>" +
      '<footer class="mobile-no-active-stations-actions">' +
      '<button type="button" class="mobile-no-active-stations-ok" data-mobile-station-warning-ok="1">OK</button>' +
      "</footer>" +
      "</section>";
    document.body.appendChild(root);
  }

  function syncWarningWithDom() {
    var composer = orderComposerNode();
    if (!composer) {
      state.warnedComposer = null;
      state.warnedComposerKey = "";
      removeWarning();
      return;
    }
    if (state.noActiveStations === true) {
      showWarningForComposer(composer);
    } else {
      removeWarning();
    }
  }

  function setNoActiveStations(nextValue) {
    var next = nextValue === true;
	    if (state.noActiveStations !== next) {
	      state.noActiveStations = next;
	      if (!next) {
	        state.warnedComposer = null;
	        state.warnedComposerKey = "";
	      }
	    }
    syncWarningWithDom();
  }

  function fetchActiveStations() {
    if (state.loading) return Promise.resolve(state.noActiveStations);
    state.loading = true;
    return fetch(ACTIVE_STATIONS_PATH + "?_=" + Date.now(), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (payload) {
          if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.stations)) {
            throw new Error("Stato postazioni non disponibile.");
          }
          state.lastCheckedAt = Date.now();
          setNoActiveStations(payload.stations.length === 0);
          return state.noActiveStations;
        });
      })
      .catch(function () {
        syncWarningWithDom();
        return state.noActiveStations;
      })
      .finally(function () {
        state.loading = false;
      });
  }

  function schedulePoll() {
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    state.pollTimer = window.setTimeout(function poll() {
      fetchActiveStations().finally(schedulePoll);
    }, POLL_MS);
  }

  window.__mobileStationAvailabilityGuardRefresh = function () {
    return fetchActiveStations();
  };

  document.addEventListener("click", function (event) {
    var target = isElement(event.target) ? event.target : null;
    if (target && target.closest('[data-mobile-station-warning-ok="1"]')) {
      event.preventDefault();
      event.stopPropagation();
      removeWarning();
    }
  }, true);

  var observer = new MutationObserver(function () {
    window.clearTimeout(observer.__stationGuardTimer);
    observer.__stationGuardTimer = window.setTimeout(function () {
      if (orderComposerNode() && Date.now() - state.lastCheckedAt > 3000) {
        fetchActiveStations();
      } else {
        syncWarningWithDom();
      }
    }, 80);
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    fetchActiveStations().finally(schedulePoll);
    window.addEventListener("focus", fetchActiveStations);
    window.addEventListener("online", fetchActiveStations);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
