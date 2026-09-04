(function () {
  if (window.__mobilePaymentSessionPersistInitialized) return;
  window.__mobilePaymentSessionPersistInitialized = true;

  var RUNTIME_PREFIX = "mobile_payment_runtime_v1";
  var SYNC_DELAY_MS = 140;
  var POLL_MS = 1000;

  var TOKEN_KEY = "pos_token";
  var USER_ID_KEY = "pos_user_id";
  var USERNAME_KEY = "pos_user";
  var FULL_NAME_KEY = "pos_full_name";
  var DEVICE_UUID_KEY = "pos_device_uuid";
  var SESSION_STARTED_AT_KEY = "pos_session_started_at";
  var POS_ID_KEY = "payment_pos_id";
  var CASH_FLOAT_KEY = "payment_cash_float";
  var CASH_FLOAT_LOCKED_KEY = "payment_cash_float_locked";

  var scheduled = 0;
  var restoring = false;
  var suppressRestoreUntil = 0;
  var lastRuntimeKey = "";
  var lastSavedSignature = "";

  function normalize(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function tokenPart(value, fallback) {
    var normalized = normalize(value).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    return (normalized || fallback).slice(0, 48);
  }

  function readStorage(key) {
    try {
      var localValue = window.localStorage.getItem(key);
      if (localValue !== null) return localValue;
    } catch (_error) {}
    try {
      var sessionValue = window.sessionStorage.getItem(key);
      if (sessionValue !== null) return sessionValue;
    } catch (_error) {}
    return null;
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {}
    try {
      window.sessionStorage.setItem(key, value);
    } catch (_error) {}
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {}
    try {
      window.sessionStorage.removeItem(key);
    } catch (_error) {}
  }

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    var raw = normalize(value);
    if (!raw) return null;
    var compact = raw.replace(/\s+/g, "").replace(/[^\d,.-]/g, "");
    if (!compact) return null;
    var normalized = compact;
    if (compact.indexOf(",") >= 0 && compact.indexOf(".") >= 0) {
      normalized = compact.replace(/\./g, "").replace(/,/g, ".");
    } else if (compact.indexOf(",") >= 0) {
      normalized = compact.replace(/,/g, ".");
    }
    var parsed = Number(normalized);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : null;
  }

  function parseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 1000000000000) return Math.trunc(value);
      if (value > 1000000000) return Math.trunc(value * 1000);
      return null;
    }
    var raw = normalize(value);
    if (!raw) return null;
    var numeric = Number(raw);
    if (Number.isFinite(numeric)) return parseTimestamp(numeric);
    var parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function readIdentity() {
    return {
      token: normalize(readStorage(TOKEN_KEY)),
      userId: normalize(readStorage(USER_ID_KEY)),
      username: normalize(readStorage(USERNAME_KEY)),
      fullName: normalize(readStorage(FULL_NAME_KEY)),
      deviceUuid: normalize(readStorage(DEVICE_UUID_KEY)),
    };
  }

  function runtimeKey(identity) {
    var userPart = tokenPart(identity.userId || identity.username, "anon");
    var devicePart = tokenPart(identity.deviceUuid, "device");
    if (userPart === "anon") return "";
    return RUNTIME_PREFIX + ":" + userPart + ":" + devicePart;
  }

  function readRuntime(key) {
    if (!key) return null;
    var raw = readStorage(key);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch (_error) {
      removeStorage(key);
      return null;
    }
  }

  function readCurrentSnapshot() {
    var identity = readIdentity();
    var posId = normalize(readStorage(POS_ID_KEY));
    var cashFloat = parseMoney(readStorage(CASH_FLOAT_KEY));
    var cashFloatLocked = normalize(readStorage(CASH_FLOAT_LOCKED_KEY)) === "1" && cashFloat !== null;
    var sessionStartedAt = parseTimestamp(readStorage(SESSION_STARTED_AT_KEY));
    var hasActivePaymentConfig = Boolean(posId) || cashFloatLocked;
    return {
      token: identity.token,
      userId: identity.userId,
      username: identity.username,
      fullName: identity.fullName,
      deviceUuid: identity.deviceUuid,
      posId: posId,
      cashFloat: cashFloat,
      cashFloatLocked: cashFloatLocked,
      sessionStartedAt: sessionStartedAt || Date.now(),
      hasActivePaymentConfig: hasActivePaymentConfig,
    };
  }

  function signature(snapshot) {
    return [
      snapshot.userId,
      snapshot.username,
      snapshot.deviceUuid,
      snapshot.posId,
      snapshot.cashFloatLocked ? "1" : "0",
      snapshot.cashFloat === null ? "" : snapshot.cashFloat.toFixed(2),
      snapshot.sessionStartedAt,
    ].join("|");
  }

  function persistCurrentState(reason) {
    if (restoring) return;
    var snapshot = readCurrentSnapshot();
    var key = runtimeKey(snapshot);
    if (!key || !snapshot.hasActivePaymentConfig) return;

    var previous = readRuntime(key);
    var previousStartedAt = parseTimestamp(previous && previous.sessionStartedAt);
    if (previousStartedAt && previousStartedAt < snapshot.sessionStartedAt) {
      snapshot.sessionStartedAt = previousStartedAt;
    }

    var currentSignature = signature(snapshot);
    if (currentSignature === lastSavedSignature && key === lastRuntimeKey) return;

    var payload = {
      version: 1,
      savedAt: Date.now(),
      savedReason: normalize(reason) || "sync",
      userId: snapshot.userId,
      username: snapshot.username,
      fullName: snapshot.fullName,
      deviceUuid: snapshot.deviceUuid,
      posId: snapshot.posId,
      cashFloat: snapshot.cashFloat,
      cashFloatLocked: snapshot.cashFloatLocked,
      sessionStartedAt: snapshot.sessionStartedAt,
      hasActivePaymentConfig: true,
    };

    writeStorage(key, JSON.stringify(payload));
    lastRuntimeKey = key;
    lastSavedSignature = currentSignature;
  }

  function emitPaymentStoreSync(detail) {
    try {
      window.dispatchEvent(new CustomEvent("mobile:payment-config-reset", { detail: detail || {} }));
    } catch (_error) {}
    try {
      window.dispatchEvent(new CustomEvent("mobile:payment-config-restored", { detail: detail || {} }));
    } catch (_error) {}
  }

  function restoreIfNeeded(reason) {
    if (restoring || Date.now() < suppressRestoreUntil) return;

    var current = readCurrentSnapshot();
    if (!current.token || !(current.userId || current.username)) return;

    var key = runtimeKey(current);
    var saved = readRuntime(key);
    if (!saved || saved.hasActivePaymentConfig !== true) return;

    var changed = false;
    var savedPosId = normalize(saved.posId);
    var savedCashFloat = parseMoney(saved.cashFloat);
    var savedCashFloatLocked = saved.cashFloatLocked === true && savedCashFloat !== null;
    var savedStartedAt = parseTimestamp(saved.sessionStartedAt);
    var currentStartedAt = parseTimestamp(readStorage(SESSION_STARTED_AT_KEY));

    restoring = true;
    try {
      if (savedPosId && normalize(readStorage(POS_ID_KEY)) !== savedPosId) {
        writeStorage(POS_ID_KEY, savedPosId);
        changed = true;
      }

      if (savedCashFloatLocked) {
        var formattedCashFloat = savedCashFloat.toFixed(2);
        if (normalize(readStorage(CASH_FLOAT_KEY)) !== formattedCashFloat) {
          writeStorage(CASH_FLOAT_KEY, formattedCashFloat);
          changed = true;
        }
        if (normalize(readStorage(CASH_FLOAT_LOCKED_KEY)) !== "1") {
          writeStorage(CASH_FLOAT_LOCKED_KEY, "1");
          changed = true;
        }
      }

      if (savedStartedAt && (!currentStartedAt || savedStartedAt < currentStartedAt)) {
        writeStorage(SESSION_STARTED_AT_KEY, String(savedStartedAt));
        changed = true;
      }
    } finally {
      restoring = false;
    }

    if (changed) {
      lastRuntimeKey = key;
      lastSavedSignature = "";
      emitPaymentStoreSync({
        source: "mobile-payment-session-persist",
        reason: normalize(reason) || "restore",
        keys: [POS_ID_KEY, CASH_FLOAT_KEY, CASH_FLOAT_LOCKED_KEY, SESSION_STARTED_AT_KEY],
      });
    }

    persistCurrentState("post-restore");
  }

  function clearCurrentRuntime(reason) {
    var identity = readIdentity();
    var key = runtimeKey(identity);
    if (key) removeStorage(key);
    suppressRestoreUntil = Date.now() + 5000;
    lastRuntimeKey = "";
    lastSavedSignature = "";
    try {
      window.dispatchEvent(
        new CustomEvent("mobile:payment-runtime-cleared", {
          detail: { source: "mobile-payment-session-persist", reason: normalize(reason) || "settlement" },
        })
      );
    } catch (_error) {}
  }

  function scheduleSync(reason) {
    if (scheduled) window.clearTimeout(scheduled);
    scheduled = window.setTimeout(function () {
      scheduled = 0;
      persistCurrentState(reason);
      restoreIfNeeded(reason);
    }, SYNC_DELAY_MS);
  }

  function onBeforeLogout() {
    persistCurrentState("before-logout");
  }

  function onDocumentInteraction(event) {
    var target = event && event.target;
    if (target && target.closest && target.closest(".menu-logout")) {
      onBeforeLogout();
      return;
    }
    scheduleSync(event && event.type ? event.type : "interaction");
  }

  function start() {
    ["click", "change", "input", "pointerdown", "touchstart"].forEach(function (eventName) {
      document.addEventListener(eventName, onDocumentInteraction, { capture: true, passive: true });
    });

    window.addEventListener("beforeunload", function () {
      persistCurrentState("beforeunload");
    });
    window.addEventListener("mobile:payments:settlement-completed", function () {
      clearCurrentRuntime("settlement-completed");
    });
    window.addEventListener("mobile:session-expired", function () {
      persistCurrentState("session-expired");
    });
    window.addEventListener("storage", function (event) {
      var key = event && typeof event.key === "string" ? event.key : "";
      if (
        !key ||
        key === TOKEN_KEY ||
        key === USER_ID_KEY ||
        key === USERNAME_KEY ||
        key === SESSION_STARTED_AT_KEY ||
        key === POS_ID_KEY ||
        key === CASH_FLOAT_KEY ||
        key === CASH_FLOAT_LOCKED_KEY
      ) {
        scheduleSync("storage");
      }
    });

    window.setInterval(function () {
      persistCurrentState("poll");
      restoreIfNeeded("poll");
    }, POLL_MS);

    scheduleSync("boot");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
