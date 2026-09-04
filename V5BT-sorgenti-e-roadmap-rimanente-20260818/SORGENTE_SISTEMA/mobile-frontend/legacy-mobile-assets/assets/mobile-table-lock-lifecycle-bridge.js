(function mobileTableLockLifecycleBridge() {
  if (window.__mobileTableLockLifecycleBridgeInitialized) return;
  window.__mobileTableLockLifecycleBridgeInitialized = true;

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!originalFetch) return;

  var HEARTBEAT_MS = 25000;
  var MUTATING_PATHS = new Set([
    "/api/integration/orders/create",
    "/api/integration/orders/correct",
    "/api/integration/orders/replacement/bar-charge",
    "/api/orders/replacement/bar-charge",
    "/api/payments/table",
    "/api/payments/free-split",
    "/api/integration/layout/table/sync",
    "/api/integration/layout/table/move",
    "/api/settings/pos/assign-bill",
  ]);
  var activeOperations = [];
  var composerLock = null;
  var composerHeartbeat = null;
  var composerObserver = null;
  var paymentLock = null;
  var paymentHeartbeat = null;
  var paymentAcquirePromise = null;
  var paymentAcquireToken = 0;
  var layoutCache = null;
  var layoutCacheAt = 0;
  var layoutFetchPromise = null;
  var MutationObserverCtor = typeof window.MutationObserver === "function" ? window.MutationObserver : null;

  function normalize(value) {
    return String(value == null ? "" : value).trim();
  }

  function readStorage(key) {
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

  function getSession() {
    return {
      token: normalize(readStorage("pos_token")),
      userId: normalize(readStorage("pos_user_id")),
      deviceUuid: normalize(readStorage("pos_device_uuid")),
      roomId: normalize(readStorage("pos_room_id")),
    };
  }

  function parseBody(init) {
    var raw = init && init.body;
    if (!raw || typeof raw !== "string") return {};
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function pathFromInput(input) {
    try {
      return new URL(typeof input === "string" ? input : input.url, window.location.origin).pathname;
    } catch (_error) {
      return "";
    }
  }

  function tableIdsForPayload(payload) {
    return [
      payload.tableId,
      payload.fromTableId,
      payload.toTableId,
      payload.targetTableId,
    ]
      .map(normalize)
      .filter(function (value, index, list) {
        return value && list.indexOf(value) === index;
      });
  }

  function headersFor(session) {
    var headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-User-Id": session.userId,
      "X-Device-Uuid": session.deviceUuid,
      "X-Client-App": "mobile-frontend",
    };
    if (session.token) headers.Authorization = "Bearer " + session.token;
    return headers;
  }

  function lockPayload(session, tableId, purpose) {
    return {
      token: session.token,
      userId: session.userId,
      deviceUuid: session.deviceUuid,
      roomId: session.roomId,
      tableId: tableId,
      purpose: purpose,
      clientApp: "mobile-frontend",
    };
  }

  function showLockConflict(payload) {
    var details = payload && payload.details ? payload.details : {};
    var lockedBy = normalize(details.lockedByUsername);
    var purpose = normalize(details.purpose || details.lockPurpose).toLowerCase();
    var expiresAt = normalize(details.expiresAt);
    var activity = purpose.indexOf("payment") >= 0 || purpose.indexOf("riscoss") >= 0
      ? "in riscossione"
      : "in modifica";
    var message = lockedBy
      ? "Tavolo " + activity + " da " + lockedBy + (expiresAt ? " fino a " + new Date(expiresAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "") + "."
      : "Tavolo " + activity + " da un altro operatore.";
    try {
      window.dispatchEvent(new CustomEvent("mobile:table-lock-conflict", { detail: { message: message, payload: payload } }));
    } catch (_error) {}
    window.setTimeout(function () {
      if (window.alert) window.alert(message);
    }, 0);
  }

  function apiPost(path, body, session) {
    return originalFetch(path, {
      method: "POST",
      headers: headersFor(session),
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch (_error) {
          payload = { ok: false, error: text };
        }
        if (!response.ok || !payload || payload.ok === false) {
          var error = new Error((payload && (payload.error || payload.message || payload.code)) || "Lock tavolo non disponibile.");
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  function acquireLocks(tableIds, purpose, session) {
    var acquired = [];
    return tableIds.reduce(function (chain, tableId) {
      return chain.then(function () {
        return apiPost("/api/tables/lock/acquire", lockPayload(session, tableId, purpose), session).then(function () {
          acquired.push(tableId);
        });
      });
    }, Promise.resolve()).then(function () {
      return acquired;
    }).catch(function (error) {
      return releaseLocks(acquired, purpose, session).then(function () {
        throw error;
      });
    });
  }

  function releaseLocks(tableIds, purpose, session) {
    return Promise.all(
      tableIds.map(function (tableId) {
        return apiPost("/api/tables/lock/release", lockPayload(session, tableId, purpose), session).catch(function () {});
      })
    );
  }

  function startHeartbeat(tableIds, purpose, session) {
    if (!tableIds.length) return null;
    return window.setInterval(function () {
      tableIds.forEach(function (tableId) {
        apiPost("/api/tables/lock/heartbeat", lockPayload(session, tableId, purpose), session).catch(function () {});
      });
    }, HEARTBEAT_MS);
  }

  function syntheticErrorResponse(error) {
    var payload = error && error.payload ? error.payload : { ok: false, error: error.message || "Lock tavolo non disponibile." };
    if (payload && payload.code === "TABLE_LOCKED") showLockConflict(payload);
    if (typeof Response !== "function") {
      return {
        ok: false,
        status: error.status || 409,
        headers: { get: function () { return "application/json"; } },
        json: function () { return Promise.resolve(payload); },
        text: function () { return Promise.resolve(JSON.stringify(payload)); },
        clone: function () { return this; },
      };
    }
    return new Response(JSON.stringify(payload), {
      status: error.status || 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  function forgetActiveOperation(operation) {
    var index = activeOperations.indexOf(operation);
    if (index >= 0) activeOperations.splice(index, 1);
  }

  function inferComposerTableId() {
    try {
      var candidate = "";
      for (var index = 0; index < window.sessionStorage.length; index += 1) {
        var key = window.sessionStorage.key(index) || "";
        if (key.indexOf("table_order_composer_") !== 0) continue;
        var tableId = normalize(key.slice("table_order_composer_".length));
        if (!tableId) continue;
        var raw = window.sessionStorage.getItem(key) || "";
        var parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (_error) {
          parsed = {};
        }
        if (parsed.drawerOpen || (Array.isArray(parsed.draft) && parsed.draft.length > 0)) return tableId;
        candidate = candidate || tableId;
      }
      return candidate;
    } catch (_error) {
      return "";
    }
  }

  function hasNormalComposerOpen() {
    return Boolean(document.querySelector(".table-order-composer-backdrop:not(.msr-composer-modal)"));
  }

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasPaymentPanelOpen() {
    return Boolean(document.querySelector(".table-payment-backdrop .table-payment-panel"));
  }

  function normalizeTableLabel(value) {
    return normalize(value)
      .toLowerCase()
      .replace(/\btavolo\b/g, "")
      .replace(/\bpagamento\b/g, "")
      .replace(/\s+/g, "")
      .replace(/^n[.°]*/g, "");
  }

  function inferPaymentTableLabel() {
    var title = textOf(document.querySelector(".table-payment-backdrop .table-payment-head h4"));
    if (title) {
      var paymentLabel = title.replace(/^pagamento\s+tavolo\s*/i, "").trim();
      if (paymentLabel) return paymentLabel;
    }
    var detailTitle = textOf(document.querySelector(".table-detail-panel.is-open .table-detail-title"));
    if (detailTitle) {
      var detailLabel = detailTitle.replace(/^tavolo\s*/i, "").trim();
      if (detailLabel) return detailLabel;
    }
    return "";
  }

  function currentRoomHints(session, layout) {
    var hints = [];
    var add = function (value) {
      var safe = normalize(value);
      if (safe && hints.indexOf(safe) < 0) hints.push(safe);
    };
    add(session && session.roomId);
    add(readStorage("pos_room_id"));
    add(readStorage("pos_room_name"));
    add(textOf(document.querySelector(".tables-title")));
    var rooms = Array.isArray(layout && layout.rooms) ? layout.rooms : [];
    hints.slice().forEach(function (hint) {
      rooms.forEach(function (room) {
        var roomId = normalize(room.id || room.roomId);
        var roomName = normalize(room.name || room.roomName);
        if (hint === roomId || hint.toLowerCase() === roomName.toLowerCase()) {
          add(roomId);
          add(roomName);
        }
      });
    });
    return hints;
  }

  function tableLabelCandidates(table) {
    return [
      table && table.id,
      table && table.number,
      table && table.tableLabel,
      table && table.logicalTableLabel,
      table && table.mobileComplexLabel,
      table && table.tableName,
      table && table.name,
    ]
      .map(normalizeTableLabel)
      .filter(function (value, index, list) {
        return value && list.indexOf(value) === index;
      });
  }

  function tableMatchesRoom(table, roomHints) {
    if (!roomHints.length) return true;
    var roomId = normalize(table && (table.roomId || table.room));
    var roomName = normalize(table && table.roomName);
    return roomHints.some(function (hint) {
      return hint === roomId || hint.toLowerCase() === roomName.toLowerCase();
    });
  }

  function resolveTableIdFromLayout(layout, label, session) {
    var tables = Array.isArray(layout && layout.tables) ? layout.tables : [];
    if (!tables.length) return "";
    var wanted = normalizeTableLabel(label);
    if (!wanted) return "";
    var roomHints = currentRoomHints(session, layout);
    var matchingRoom = tables.filter(function (table) {
      return tableMatchesRoom(table, roomHints);
    });
    var pools = matchingRoom.length ? [matchingRoom, tables] : [tables];
    for (var poolIndex = 0; poolIndex < pools.length; poolIndex += 1) {
      var pool = pools[poolIndex];
      for (var index = 0; index < pool.length; index += 1) {
        var table = pool[index];
        if (tableLabelCandidates(table).indexOf(wanted) >= 0) {
          return normalize(table.id);
        }
      }
    }
    return "";
  }

  function fetchLayout(session) {
    var now = Date.now();
    if (layoutCache && now - layoutCacheAt < 3500) return Promise.resolve(layoutCache);
    if (layoutFetchPromise) return layoutFetchPromise;
    layoutFetchPromise = originalFetch("/api/integration/layout?_=" + now, {
      method: "GET",
      headers: headersFor(session),
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(function (response) {
        if (!response.ok) throw new Error("Layout tavoli non disponibile.");
        return response.json();
      })
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.tables)) throw new Error("Layout tavoli non valido.");
        layoutCache = payload;
        layoutCacheAt = Date.now();
        return payload;
      })
      .finally(function () {
        layoutFetchPromise = null;
      });
    return layoutFetchPromise;
  }

  function resolvePaymentTableId(session) {
    var label = inferPaymentTableLabel();
    if (!label) return Promise.resolve("");
    return fetchLayout(session).then(function (layout) {
      return resolveTableIdFromLayout(layout, label, session);
    });
  }

  function setPaymentPanelPending(pending) {
    var panel = document.querySelector(".table-payment-backdrop .table-payment-panel");
    if (!(panel instanceof HTMLElement)) return;
    panel.setAttribute("data-mobile-payment-lock", pending ? "pending" : "ready");
    var hint = panel.querySelector(".mobile-payment-lock-hint");
    if (hint && hint.parentNode) {
      hint.parentNode.removeChild(hint);
    }
    var controls = panel.querySelectorAll("button, input, select, textarea");
    controls.forEach(function (control) {
      if (!(control instanceof HTMLElement)) return;
      if (control.classList.contains("table-payment-close")) return;
      if (pending) {
        if (!control.hasAttribute("data-mobile-lock-original-disabled")) {
          control.setAttribute("data-mobile-lock-original-disabled", control.disabled ? "1" : "0");
        }
        control.disabled = true;
      } else if (control.hasAttribute("data-mobile-lock-original-disabled")) {
        control.disabled = control.getAttribute("data-mobile-lock-original-disabled") === "1";
        control.removeAttribute("data-mobile-lock-original-disabled");
      }
    });
  }

  function closePaymentPanel() {
    var closeButton = document.querySelector(".table-payment-backdrop .table-payment-close");
    if (closeButton instanceof HTMLElement) {
      closeButton.click();
      return;
    }
    var backdrop = document.querySelector(".table-payment-backdrop");
    if (backdrop instanceof HTMLElement) backdrop.click();
  }

  function releaseComposerLock() {
    var lock = composerLock;
    composerLock = null;
    if (composerHeartbeat !== null) {
      window.clearInterval(composerHeartbeat);
      composerHeartbeat = null;
    }
    if (!lock) return Promise.resolve();
    return releaseLocks([lock.tableId], lock.purpose, lock.session).then(function () {});
  }

  function releasePaymentLock() {
    paymentAcquireToken += 1;
    paymentAcquirePromise = null;
    setPaymentPanelPending(false);
    var lock = paymentLock;
    paymentLock = null;
    if (paymentHeartbeat !== null) {
      window.clearInterval(paymentHeartbeat);
      paymentHeartbeat = null;
    }
    if (!lock) return Promise.resolve();
    return releaseLocks([lock.tableId], lock.purpose, lock.session).then(function () {});
  }

  function acquireComposerLockIfNeeded() {
    if (composerLock || !hasNormalComposerOpen()) return;
    var tableId = inferComposerTableId();
    if (!tableId) {
      window.setTimeout(acquireComposerLockIfNeeded, 150);
      return;
    }
    var session = getSession();
    if (!session.token || !session.userId || !session.deviceUuid) return;
    var purpose = "mobile:order_composer";
    acquireLocks([tableId], purpose, session)
      .then(function () {
        if (!hasNormalComposerOpen()) {
          return releaseLocks([tableId], purpose, session);
        }
        composerLock = { tableId: tableId, purpose: purpose, session: session };
        composerHeartbeat = startHeartbeat([tableId], purpose, session);
        return null;
      })
      .catch(function (error) {
        if (error && error.payload && error.payload.code === "TABLE_LOCKED") showLockConflict(error.payload);
      });
  }

  function syncComposerLockLifecycle() {
    if (hasNormalComposerOpen()) acquireComposerLockIfNeeded();
    else void releaseComposerLock();
  }

  function acquirePaymentLockIfNeeded() {
    if (!hasPaymentPanelOpen()) return;
    if (paymentLock) {
      setPaymentPanelPending(false);
      return;
    }
    if (paymentAcquirePromise) return;
    var session = getSession();
    if (!session.token || !session.userId || !session.deviceUuid) return;
    var purpose = "mobile:payment_session";
    var token = ++paymentAcquireToken;
    setPaymentPanelPending(true);
    paymentAcquirePromise = resolvePaymentTableId(session)
      .then(function (tableId) {
        if (token !== paymentAcquireToken || !hasPaymentPanelOpen()) return null;
        if (!tableId) {
          window.setTimeout(function () {
            paymentAcquirePromise = null;
            acquirePaymentLockIfNeeded();
          }, 180);
          return null;
        }
        return acquireLocks([tableId], purpose, session).then(function () {
          if (token !== paymentAcquireToken || !hasPaymentPanelOpen()) {
            return releaseLocks([tableId], purpose, session);
          }
          paymentLock = { tableId: tableId, purpose: purpose, session: session };
          paymentHeartbeat = startHeartbeat([tableId], purpose, session);
          setPaymentPanelPending(false);
          return null;
        });
      })
      .catch(function (error) {
        setPaymentPanelPending(false);
        if (error && error.payload && error.payload.code === "TABLE_LOCKED") showLockConflict(error.payload);
        closePaymentPanel();
      })
      .finally(function () {
        if (token === paymentAcquireToken) paymentAcquirePromise = null;
      });
  }

  function syncPaymentLockLifecycle() {
    if (hasPaymentPanelOpen()) acquirePaymentLockIfNeeded();
    else void releasePaymentLock();
  }

  function isPersistentLockFor(tableId, session) {
    var normalizedId = normalize(tableId);
    var sameSession = function (lock) {
      return (
        lock &&
        lock.tableId === normalizedId &&
        normalize(lock.session && lock.session.userId) === normalize(session && session.userId) &&
        normalize(lock.session && lock.session.deviceUuid) === normalize(session && session.deviceUuid)
      );
    };
    return sameSession(composerLock) || sameSession(paymentLock);
  }

  window.__mobileTableLockReleaseAll = function releaseAllMobileTableLocks() {
    var operations = activeOperations.slice();
    activeOperations = [];
    var composerRelease = releaseComposerLock();
    var paymentRelease = releasePaymentLock();
    return Promise.all(
      operations.map(function (operation) {
        if (operation.heartbeat !== null) window.clearInterval(operation.heartbeat);
        return releaseLocks(operation.tableIds, operation.purpose, operation.session);
      })
    ).then(function () {
      return composerRelease;
    }).then(function () {
      return paymentRelease;
    }).then(function () {});
  };

  window.fetch = function patchedFetch(input, init) {
    var pathname = pathFromInput(input);
    var method = normalize((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (method !== "POST" || !MUTATING_PATHS.has(pathname) || pathname.indexOf("/api/tables/lock/") === 0) {
      return originalFetch(input, init);
    }
    var payload = parseBody(init);
    var tableIds = tableIdsForPayload(payload);
    if (!tableIds.length) return originalFetch(input, init);
    var session = getSession();
    if (!session.token || !session.userId || !session.deviceUuid) return originalFetch(input, init);
    var purpose = "mobile:" + pathname.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    var transientTableIds = tableIds.filter(function (tableId) {
      return !isPersistentLockFor(tableId, session);
    });
    var heartbeat = null;
    var acquired = [];
    var activeOperation = null;
    return acquireLocks(transientTableIds, purpose, session)
      .then(function (locked) {
        acquired = locked;
        heartbeat = startHeartbeat(acquired, purpose, session);
        activeOperation = { tableIds: acquired.slice(), purpose: purpose, session: session, heartbeat: heartbeat };
        activeOperations.push(activeOperation);
        return originalFetch(input, init);
      })
      .then(function (response) {
        return response.clone().json().then(function (body) {
          if (response.status === 409 && body && body.code === "TABLE_LOCKED") showLockConflict(body);
          return response;
        }).catch(function () {
          return response;
        });
      })
      .catch(function (error) {
        return syntheticErrorResponse(error);
      })
      .finally(function () {
        if (heartbeat !== null) window.clearInterval(heartbeat);
        if (activeOperation) forgetActiveOperation(activeOperation);
        if (acquired.length) void releaseLocks(acquired, purpose, session);
      });
  };

  var paymentObserver = null;
  if (MutationObserverCtor && document.documentElement) {
    composerObserver = new MutationObserverCtor(syncComposerLockLifecycle);
    composerObserver.observe(document.documentElement, { childList: true, subtree: true });
    paymentObserver = new MutationObserverCtor(syncPaymentLockLifecycle);
    paymentObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (typeof window.addEventListener === "function") window.addEventListener("beforeunload", function () {
    if (composerObserver) composerObserver.disconnect();
    if (paymentObserver) paymentObserver.disconnect();
    void window.__mobileTableLockReleaseAll();
  });
  syncComposerLockLifecycle();
  syncPaymentLockLifecycle();
})();
