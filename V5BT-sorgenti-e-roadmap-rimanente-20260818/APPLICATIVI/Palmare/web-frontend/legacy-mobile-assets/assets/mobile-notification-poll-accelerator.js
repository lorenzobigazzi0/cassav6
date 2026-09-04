(function () {
  const HEALTH_PATH = "/api/health";
  const STREAM_PATH = "/api/integration/notifications/stream";
  const RECOVERY_INTERVAL_MS = 350;
  const STREAM_BACKSTOP_INTERVAL_MS = 1200;
  const MIN_IMMEDIATE_GAP_MS = 15;
  const MAX_RECONNECT_DELAY_MS = 1500;
  const POLLER_DELAY_MIN_MS = 500;
  const POLLER_DELAY_MAX_MS = 2500;
  const HEALTH_PROBE_INTERVAL_MS = 10000;
  const HEALTH_PROBE_MIN_GAP_MS = 1500;
  const POLLER_CALLBACK_HINTS = ["tu(", "mk(", "notifications/pull"];

  if (window.__mobileNotificationPollAcceleratorInstalled === true) {
    return;
  }
  window.__mobileNotificationPollAcceleratorInstalled = true;

  if (typeof window.setInterval !== "function" || typeof window.fetch !== "function") {
    return;
  }

  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const nativeFetch = window.fetch.bind(window);

  const intervalRecords = new Map();
  let logicalIntervalId = 0;
  let activeRecord = null;
  let notificationPollerId = 0;
  let lastPullUrl = "";
  let pendingImmediatePoll = false;
  let pendingStreamWake = false;
  let lastImmediatePollAt = 0;
  let streamUrl = "";
  let stream = null;
  let reconnectTimer = 0;
  let reconnectAttempt = 0;
  let streamReady = false;
  let serverConnectionState = "online";
  let transportFailureCount = 0;
  let healthProbeInFlight = false;
  let lastHealthProbeAt = 0;

  function nextLogicalIntervalId() {
    logicalIntervalId += 1;
    return -logicalIntervalId;
  }

  function updateServerLed(state) {
    const nextState =
      state === "offline" ? "offline" : state === "reconnecting" ? "reconnecting" : "online";
    serverConnectionState = nextState;
    const led = document.querySelector(".system-status .status-led");
    if (!(led instanceof HTMLElement)) return;
    led.classList.remove("status-green", "status-amber", "status-red");
    if (nextState === "offline") {
      led.classList.add("status-red");
      led.title = "Server offline";
      led.setAttribute("aria-label", "Server offline");
      return;
    }
    if (nextState === "reconnecting") {
      led.classList.add("status-amber");
      led.title = "Server in riconnessione";
      led.setAttribute("aria-label", "Server in riconnessione");
      return;
    }
    led.classList.add("status-green");
    led.title = "Server connesso";
    led.setAttribute("aria-label", "Server connesso");
  }

  function markTransportHealthy() {
    transportFailureCount = 0;
    updateServerLed("online");
  }

  function resolveHealthProbeOrigin(preferredUrl) {
    if (preferredUrl instanceof URL) {
      return preferredUrl.origin;
    }
    return window.location.origin;
  }

  function probeServerHealth(preferredUrl) {
    if (healthProbeInFlight) return;
    const now = Date.now();
    if (now - lastHealthProbeAt < HEALTH_PROBE_MIN_GAP_MS) return;
    lastHealthProbeAt = now;
    healthProbeInFlight = true;
    const healthUrl = new URL(HEALTH_PATH, resolveHealthProbeOrigin(preferredUrl));
    nativeFetch(healthUrl.toString(), {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((response) => {
        if (response && response.ok) {
          markTransportHealthy();
          return;
        }
        updateServerLed("offline");
      })
      .catch(() => {
        updateServerLed("offline");
      })
      .finally(() => {
        healthProbeInFlight = false;
      });
  }

  function markTransportFailure(preferredUrl) {
    transportFailureCount += 1;
    updateServerLed("reconnecting");
    if (transportFailureCount >= 2) {
      probeServerHealth(preferredUrl);
    }
  }

  function toAbsoluteUrl(input) {
    const raw =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : "";
    if (!raw) return null;
    try {
      return new URL(raw, window.location.href);
    } catch {
      return null;
    }
  }

  function isNotificationPullUrl(url) {
    return Boolean(url && /\/api\/integration\/notifications\/pull(?:\?|$)/.test(url.pathname));
  }

  function clearManagedInterval(record) {
    if (!record || record.nativeId == null) return;
    nativeClearInterval(record.nativeId);
    record.nativeId = null;
  }

  function ensureManagedIntervalDelay(record, delayMs) {
    if (!record || record.cleared) return;
    const nextDelay = Math.max(50, Math.trunc(Number(delayMs) || record.delay || RECOVERY_INTERVAL_MS));
    if (record.effectiveDelay === nextDelay && record.nativeId != null) {
      return;
    }
    clearManagedInterval(record);
    record.effectiveDelay = nextDelay;
    record.nativeId = nativeSetInterval(record.wrapped, nextDelay);
  }

  function ensureNotificationPollerDelay(delayMs) {
    const record = intervalRecords.get(notificationPollerId);
    if (!record || record.cleared) return;
    ensureManagedIntervalDelay(record, delayMs);
  }

  function settlePollerRun(record) {
    if (!record) return;
    record.running = false;
    if (record.needsReplay) {
      record.needsReplay = false;
      scheduleImmediateNotificationPoll("replay");
    }
  }

  function scheduleImmediateNotificationPoll(reason) {
    const record = intervalRecords.get(notificationPollerId);
    if (!record || record.cleared) {
      pendingStreamWake = true;
      return;
    }

    if (record.running) {
      record.needsReplay = true;
      return;
    }

    if (pendingImmediatePoll) return;
    if (Date.now() - lastImmediatePollAt < MIN_IMMEDIATE_GAP_MS) {
      pendingStreamWake = true;
      return;
    }

    pendingStreamWake = false;
    pendingImmediatePoll = true;
    window.requestAnimationFrame(() => {
      pendingImmediatePoll = false;
      const activePoller = intervalRecords.get(notificationPollerId);
      if (!activePoller || activePoller.cleared || activePoller.running) {
        if (activePoller) {
          activePoller.needsReplay = true;
        }
        return;
      }
      if (Date.now() - lastImmediatePollAt < MIN_IMMEDIATE_GAP_MS) {
        return;
      }
      lastImmediatePollAt = Date.now();
      try {
        activePoller.wrapped(reason || "stream");
      } catch {
        // noop
      }
    });
  }

  function closeStream() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }
    streamReady = false;
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  function scheduleReconnect() {
    if (!streamUrl || reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * Math.max(1, reconnectAttempt));
    reconnectAttempt += 1;
    updateServerLed("reconnecting");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      connectStream();
    }, delay);
  }

  function connectStream() {
    if (!streamUrl || typeof window.EventSource !== "function") {
      return;
    }

    closeStream();

    const source = new window.EventSource(streamUrl, { withCredentials: true });
    stream = source;

    const handleRefresh = () => {
      reconnectAttempt = 0;
      streamReady = true;
      markTransportHealthy();
      ensureNotificationPollerDelay(STREAM_BACKSTOP_INTERVAL_MS);
      scheduleImmediateNotificationPoll("stream");
    };

    source.onopen = () => {
      reconnectAttempt = 0;
      streamReady = true;
      markTransportHealthy();
      ensureNotificationPollerDelay(STREAM_BACKSTOP_INTERVAL_MS);
      scheduleImmediateNotificationPoll("stream-open");
    };
    source.addEventListener("ready", () => {
      reconnectAttempt = 0;
      streamReady = true;
      markTransportHealthy();
      ensureNotificationPollerDelay(STREAM_BACKSTOP_INTERVAL_MS);
      scheduleImmediateNotificationPoll("stream-ready");
    });
    source.addEventListener("refresh", handleRefresh);
    source.onmessage = handleRefresh;
    source.onerror = () => {
      if (stream !== source) return;
      streamReady = false;
      markTransportFailure(toAbsoluteUrl(streamUrl));
      ensureNotificationPollerDelay(RECOVERY_INTERVAL_MS);
      closeStream();
      scheduleReconnect();
    };
  }

  function syncStreamFromPullUrl(pullUrl) {
    if (!(pullUrl instanceof URL)) return;
    const nextStreamUrl = new URL(STREAM_PATH, pullUrl.origin);
    pullUrl.searchParams.forEach((value, key) => {
      nextStreamUrl.searchParams.set(key, value);
    });
    const serialized = nextStreamUrl.toString();
    if (serialized === streamUrl) {
      return;
    }
    streamUrl = serialized;
    reconnectAttempt = 0;
    streamReady = false;
    connectStream();
  }

  function markNotificationPoller(record, absoluteUrl) {
    if (!record || record.cleared) return;
    notificationPollerId = record.logicalId;
    record.isNotificationPoller = true;
    lastPullUrl = absoluteUrl.toString();
    ensureManagedIntervalDelay(record, streamReady ? STREAM_BACKSTOP_INTERVAL_MS : RECOVERY_INTERVAL_MS);
    syncStreamFromPullUrl(absoluteUrl);
    if (pendingStreamWake) {
      scheduleImmediateNotificationPoll("pending-stream");
    }
  }

  function looksLikeNotificationPoller(record) {
    if (!record || typeof record.callback !== "function") {
      return false;
    }

    const delay = Math.max(0, Math.trunc(Number(record.delay) || 0));
    const callbackSource = String(record.callback);
    return (
      delay >= POLLER_DELAY_MIN_MS &&
      delay <= POLLER_DELAY_MAX_MS &&
      POLLER_CALLBACK_HINTS.some((hint) => callbackSource.indexOf(hint) >= 0)
    );
  }

  function markLikelyNotificationPoller(record) {
    if (!record || record.cleared || record.isNotificationPoller) {
      return;
    }
    if (!looksLikeNotificationPoller(record)) {
      return;
    }
    notificationPollerId = record.logicalId;
    record.isNotificationPoller = true;
    ensureManagedIntervalDelay(record, streamReady ? STREAM_BACKSTOP_INTERVAL_MS : RECOVERY_INTERVAL_MS);
    if (pendingStreamWake) {
      scheduleImmediateNotificationPoll("pending-stream");
    }
  }

  window.setInterval = function (callback, delay) {
    const args = Array.prototype.slice.call(arguments, 2);
    if (typeof callback !== "function") {
      return nativeSetInterval(callback, delay, ...args);
    }

    const record = {
      logicalId: nextLogicalIntervalId(),
      callback,
      delay: Math.max(50, Math.trunc(Number(delay) || 0)),
      effectiveDelay: Math.max(50, Math.trunc(Number(delay) || 0)),
      nativeId: null,
      running: false,
      cleared: false,
      needsReplay: false,
      isNotificationPoller: false,
      wrapped: null,
    };

    record.wrapped = function () {
      if (record.cleared) return;
      if (record.running) {
        record.needsReplay = true;
        return;
      }
      const previousRecord = activeRecord;
      activeRecord = record;
      record.running = true;
      let result;
      try {
        result = callback.apply(this, args);
      } catch (error) {
        activeRecord = previousRecord;
        settlePollerRun(record);
        throw error;
      }
      activeRecord = previousRecord;

      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => {
          settlePollerRun(record);
        });
      }

      settlePollerRun(record);
      return result;
    };

    record.nativeId = nativeSetInterval(record.wrapped, record.effectiveDelay);
    intervalRecords.set(record.logicalId, record);
    markLikelyNotificationPoller(record);
    return record.logicalId;
  };

  window.clearInterval = function (intervalId) {
    const record = intervalRecords.get(intervalId);
    if (!record) {
      nativeClearInterval(intervalId);
      return;
    }

    record.cleared = true;
    clearManagedInterval(record);
    intervalRecords.delete(intervalId);
    if (notificationPollerId === intervalId) {
      notificationPollerId = 0;
    }
  };

  window.fetch = function (input, init) {
    const absoluteUrl = toAbsoluteUrl(input);
    if (isNotificationPullUrl(absoluteUrl)) {
      if (activeRecord) {
        markNotificationPoller(activeRecord, absoluteUrl);
      } else {
        lastPullUrl = absoluteUrl.toString();
        syncStreamFromPullUrl(absoluteUrl);
      }
    }
    return nativeFetch(input, init)
      .then((response) => {
        if (isNotificationPullUrl(absoluteUrl)) {
          if (response && response.ok) {
            markTransportHealthy();
          } else if (response && (response.status === 401 || response.status === 403)) {
            transportFailureCount = 0;
            probeServerHealth(absoluteUrl);
          } else {
            markTransportFailure(absoluteUrl);
          }
        }
        return response;
      })
      .catch((error) => {
        if (isNotificationPullUrl(absoluteUrl)) {
          markTransportFailure(absoluteUrl);
        }
        throw error;
      });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (lastPullUrl) {
      try {
        syncStreamFromPullUrl(new URL(lastPullUrl, window.location.href));
      } catch {
        // noop
      }
    }
    scheduleImmediateNotificationPoll("visibility");
  });

  window.addEventListener("beforeunload", closeStream);
  document.addEventListener("DOMContentLoaded", () => {
    updateServerLed(serverConnectionState);
    probeServerHealth();
  });
  nativeSetInterval(() => {
    probeServerHealth();
  }, HEALTH_PROBE_INTERVAL_MS);
  updateServerLed("reconnecting");
  probeServerHealth();
})();
