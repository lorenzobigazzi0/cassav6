(function () {
  if (window.__mobileNotificationReminderInstalled) {
    return;
  }
  window.__mobileNotificationReminderInstalled = true;

  var REMINDER_INTERVAL_MS = 30000;
  var POLL_MS = 2000;
  var MAX_REMINDERS = 120;
  var AUDIO_DUTY_CYCLE_MS = 2500;
  var state = {
    reminders: new Map(),
    activeModalId: "",
    pollHandle: null,
    observer: null,
    audioContext: null,
    gainNode: null,
    audioReady: false,
    deliverySessionId: "",
  };

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeConsumerToken(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_");
  }

  function ensureDeliverySessionId() {
    if (!state.deliverySessionId) {
      state.deliverySessionId = "session_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    }
    return state.deliverySessionId;
  }

  function buildStableConsumer(searchParams) {
    var userToken = normalizeConsumerToken(
      searchParams.get("userId") || searchParams.get("username") || "anon"
    );
    var deviceToken = normalizeConsumerToken(searchParams.get("deviceUuid") || "device").slice(0, 24);
    return "mobile-frontend:" + (userToken || "anon") + ":" + (deviceToken || "device");
  }

  function buildSessionConsumer(stableConsumer) {
    var sessionToken = normalizeConsumerToken(ensureDeliverySessionId()).slice(0, 48);
    var stableToken = normalizeConsumerToken(stableConsumer).slice(0, 24);
    return "mobilepull_" + (stableToken || "device") + "_" + (sessionToken || "session");
  }

  function rewriteNotificationPullRequest(input, init) {
    var rawUrl =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : "";
    if (!/\/api\/integration\/notifications\/pull(?:\?|$)/.test(rawUrl)) {
      return {
        input: input,
        init: init,
        url: rawUrl,
      };
    }
    try {
      var url = new URL(rawUrl, window.location.origin);
      var stableConsumer = buildStableConsumer(url.searchParams);
      url.searchParams.set("ackConsumer", stableConsumer);
      url.searchParams.set("consumer", buildSessionConsumer(stableConsumer));
      return {
        input:
          typeof input === "string"
            ? url.toString()
            : new Request(url.toString(), input),
        init: init,
        url: url.toString(),
      };
    } catch {
      return {
        input: input,
        init: init,
        url: rawUrl,
      };
    }
  }

  function itemTypeKey(value) {
    var type = normalizeText(value).toLowerCase();
    return type === "waiter" || type === "bell" ? type : "";
  }

  function getOverlayInfo() {
    var overlay = document.querySelector(".call-overlay");
    if (!overlay) {
      return null;
    }
    var typeNode = overlay.querySelector(".call-type");
    var titleNode = overlay.querySelector(".call-title");
    var descNode = overlay.querySelector(".call-desc");
    var typeLabel = normalizeText(typeNode ? typeNode.textContent : "");
    return {
      overlay: overlay,
      title: normalizeText(titleNode ? titleNode.textContent : ""),
      description: normalizeText(descNode ? descNode.textContent : ""),
      type:
        /cameriere/i.test(typeLabel)
          ? "waiter"
          : /comanda pronta/i.test(typeLabel)
            ? "bell"
            : "",
    };
  }

  function ensureAudioReady() {
    if (state.audioReady) {
      return true;
    }
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      return false;
    }
    try {
      if (!state.audioContext) {
        state.audioContext = new AudioCtx();
        state.gainNode = state.audioContext.createGain();
        state.gainNode.gain.value = 0.035;
        state.gainNode.connect(state.audioContext.destination);
      }
      if (state.audioContext.state === "suspended" && typeof state.audioContext.resume === "function") {
        state.audioContext.resume();
      }
      state.audioReady = true;
      return true;
    } catch {
      return false;
    }
  }

  function acquireAudioDutyCycle() {
    var duty =
      window.__mobileNotificationAudioDutyCycle ||
      (window.__mobileNotificationAudioDutyCycle = {
        lastPlayedAt: 0,
        cooldownMs: AUDIO_DUTY_CYCLE_MS,
      });
    var cooldown = Math.max(Number(duty.cooldownMs) || AUDIO_DUTY_CYCLE_MS, AUDIO_DUTY_CYCLE_MS);
    var now = Date.now();
    if (now - (Number(duty.lastPlayedAt) || 0) < cooldown) {
      return false;
    }
    duty.lastPlayedAt = now;
    duty.cooldownMs = cooldown;
    return true;
  }

  function playReminderSound() {
    if (!ensureAudioReady() || !state.audioContext || !state.gainNode) {
      return;
    }
    if (!acquireAudioDutyCycle()) {
      return;
    }
    try {
      var context = state.audioContext;
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(1180, context.currentTime);
      oscillator.frequency.linearRampToValueAtTime(980, context.currentTime + 0.18);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
      oscillator.connect(gain);
      gain.connect(state.gainNode);
      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + 0.34);
      if (navigator.vibrate) {
        navigator.vibrate([130]);
      }
    } catch {
      // noop
    }
  }

  function getReminder(id) {
    return state.reminders.get(String(id || ""));
  }

  function trimReminders() {
    if (state.reminders.size <= MAX_REMINDERS) {
      return;
    }
    var entries = Array.from(state.reminders.values()).sort(function (left, right) {
      return (left.createdAt || 0) - (right.createdAt || 0);
    });
    while (entries.length > MAX_REMINDERS) {
      var next = entries.shift();
      if (!next || !next.id) {
        continue;
      }
      if (next.id === state.activeModalId && entries.length > 0) {
        entries.push(next);
        continue;
      }
      state.reminders.delete(next.id);
    }
  }

  function rememberNotification(notification) {
    if (!notification || typeof notification !== "object") {
      return;
    }
    var id = normalizeText(notification.id);
    var type = itemTypeKey(notification.type);
    if (!id || !type) {
      return;
    }
    var existing = getReminder(id);
    var next = {
      id: id,
      type: type,
      title: normalizeText(notification.title),
      description: normalizeText(notification.description),
      createdAt: Date.now(),
      snoozed: existing ? existing.snoozed : false,
      nextRingAt: existing ? existing.nextRingAt : 0,
    };
    state.reminders.set(id, next);
    trimReminders();
  }

  function removeReminder(id) {
    var key = normalizeText(id);
    if (!key) {
      return;
    }
    state.reminders.delete(key);
    if (state.activeModalId === key) {
      state.activeModalId = "";
    }
  }

  function clearReminderFromItem(item) {
    if (!item || typeof item !== "object") {
      return;
    }
    var meta = item.meta && typeof item.meta === "object" ? item.meta : {};
    var eventType = normalizeText(meta.eventType).toLowerCase();
    if (eventType === "bell_claimed_by_other") {
      removeReminder(meta.sourceNotificationId || meta.notificationId || item.id);
    }
  }

  function matchOverlayReminder(info) {
    if (!info || !info.type) {
      return null;
    }
    var matches = Array.from(state.reminders.values()).filter(function (entry) {
      if (entry.type !== info.type) return false;
      if (info.title && entry.title !== info.title) return false;
      if (info.description && entry.description !== info.description) return false;
      return true;
    });
    return matches.length ? matches[0] : null;
  }

  function syncActiveModal() {
    var info = getOverlayInfo();
    if (!info) {
      state.activeModalId = "";
      return;
    }
    var matched = matchOverlayReminder(info);
    if (!matched) {
      return;
    }
    matched.snoozed = false;
    matched.nextRingAt = 0;
    state.activeModalId = matched.id;
  }

  function snoozeActiveReminder() {
    if (!ensureAudioReady()) {
      // best effort: user gesture may still allow future resume later
    }
    var id = state.activeModalId;
    if (!id) {
      var matched = matchOverlayReminder(getOverlayInfo());
      id = matched ? matched.id : "";
    }
    if (!id) {
      return;
    }
    var reminder = getReminder(id);
    if (!reminder) {
      return;
    }
    reminder.snoozed = true;
    reminder.nextRingAt = Date.now() + REMINDER_INTERVAL_MS;
    state.activeModalId = "";
  }

  function ringDueReminders() {
    if (document.hidden) {
      return;
    }
    if (document.querySelector(".call-overlay")) {
      syncActiveModal();
      return;
    }
    var now = Date.now();
    var due = Array.from(state.reminders.values()).filter(function (entry) {
      return entry.snoozed === true && entry.nextRingAt > 0 && now >= entry.nextRingAt;
    });
    if (!due.length) {
      return;
    }
    playReminderSound();
    due.forEach(function (entry) {
      entry.nextRingAt = now + REMINDER_INTERVAL_MS;
    });
  }

  function installFetchObserver() {
    if (typeof window.fetch !== "function" || window.fetch.__mobileReminderWrapped === true) {
      return;
    }
    var nativeFetch = window.fetch.bind(window);
    var wrappedFetch = function (input, init) {
      var request = rewriteNotificationPullRequest(input, init);
      return nativeFetch(request.input, request.init).then(function (response) {
        try {
          var url =
            request.url ||
            (typeof request.input === "string"
              ? request.input
              : request.input && typeof request.input.url === "string"
                ? request.input.url
                : String(response && response.url ? response.url : ""));
          if (/\/api\/integration\/notifications\/pull(?:\?|$)/.test(url)) {
            response
              .clone()
              .json()
              .then(function (payload) {
                if (!payload || payload.ok !== true || !Array.isArray(payload.items)) {
                  return;
                }
                payload.items.forEach(function (item) {
                  rememberNotification(item);
                  clearReminderFromItem(item);
                });
                syncActiveModal();
              })
              .catch(function () {});
          }
          if (
            /\/api\/integration\/notifications\/ack(?:\?|$)/.test(url) &&
            request.init &&
            typeof request.init.body === "string"
          ) {
            var body = JSON.parse(request.init.body);
            if (body && body.id && (body.action === "ack" || body.action === "delete")) {
              removeReminder(body.id);
            }
          }
        } catch {
          // noop
        }
        return response;
      });
    };
    wrappedFetch.__mobileReminderWrapped = true;
    window.fetch = wrappedFetch;
  }

  function startPolling() {
    if (state.pollHandle !== null) {
      return;
    }
    state.pollHandle = window.setInterval(function () {
      ringDueReminders();
    }, POLL_MS);
  }

  function installDomObservers() {
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest(".call-close")) {
          snoozeActiveReminder();
          return;
        }
        if (target.closest(".call-confirm")) {
          if (state.activeModalId) {
            removeReminder(state.activeModalId);
          }
        }
      },
      true
    );

    state.observer = new MutationObserver(function () {
      syncActiveModal();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden"],
    });
  }

  function primeAudioOnInteraction() {
    function activate() {
      ensureAudioReady();
      window.removeEventListener("pointerdown", activate, true);
      window.removeEventListener("keydown", activate, true);
    }
    window.addEventListener("pointerdown", activate, true);
    window.addEventListener("keydown", activate, true);
  }

  function start() {
    installFetchObserver();
    installDomObservers();
    primeAudioOnInteraction();
    syncActiveModal();
    startPolling();
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        syncActiveModal();
        ringDueReminders();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
