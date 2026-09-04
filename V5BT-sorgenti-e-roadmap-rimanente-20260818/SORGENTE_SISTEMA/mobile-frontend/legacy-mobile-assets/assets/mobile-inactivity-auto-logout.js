(function mobileInactivityAutoLogout() {
  if (window.__mobileInactivityAutoLogoutInitialized) return;
  window.__mobileInactivityAutoLogoutInitialized = true;

  var MOBILE_INACTIVITY_LOGOUT_MS = 14400000;
  var CHECK_SESSION_MS = 10000;
  var timer = null;
  var sessionPoll = null;
  var loggingOut = false;
  var lastSessionKey = "";
  var activityEvents = [
    "touchstart",
    "touchmove",
    "pointerdown",
    "pointermove",
    "click",
    "scroll",
    "keydown",
    "focusin",
    "input",
  ];

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

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {}
    try {
      window.sessionStorage.removeItem(key);
    } catch (_error) {}
  }

  function writeSessionMessage(message) {
    try {
      window.sessionStorage.setItem("pos_logout_message", message);
      window.sessionStorage.setItem("mobile_login_message", message);
    } catch (_error) {}
  }

  function getSession() {
    return {
      token: normalize(readStorage("pos_token")),
      userId: normalize(readStorage("pos_user_id")),
      username: normalize(readStorage("pos_user")),
      deviceUuid: normalize(readStorage("pos_device_uuid")),
      roomId: normalize(readStorage("pos_room_id")),
    };
  }

  function getSessionKey() {
    var session = getSession();
    if (!session.token || !session.userId || !session.deviceUuid) return "";
    return [session.userId, session.deviceUuid, session.token].join("|");
  }

  function hasSession() {
    return Boolean(getSessionKey());
  }

  function clearTimer() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleTimeout() {
    clearTimer();
    var sessionKey = getSessionKey();
    if (!sessionKey || loggingOut) return;
    lastSessionKey = sessionKey;
    timer = window.setTimeout(handleTimeout, MOBILE_INACTIVITY_LOGOUT_MS);
  }

  function syncSessionTimerFromStorage() {
    var sessionKey = getSessionKey();
    if (!sessionKey) {
      lastSessionKey = "";
      clearTimer();
      return;
    }
    if (sessionKey !== lastSessionKey) scheduleTimeout();
  }

  function clearSessionStorage() {
    [
      "pos_token",
      "pos_user_id",
      "pos_user",
      "pos_role",
      "pos_permissions",
      "pos_room_id",
      "pos_room_name",
    ].forEach(removeStorage);
  }

  function showInlineMessage(message) {
    var node = document.createElement("div");
    node.textContent = message;
    node.style.position = "fixed";
    node.style.left = "50%";
    node.style.bottom = "24px";
    node.style.transform = "translateX(-50%)";
    node.style.zIndex = "2147483200";
    node.style.maxWidth = "calc(100vw - 32px)";
    node.style.padding = "12px 16px";
    node.style.borderRadius = "14px";
    node.style.background = "rgba(126, 24, 38, 0.96)";
    node.style.color = "#fff";
    node.style.font = "800 14px/1.3 system-ui, -apple-system, Segoe UI, sans-serif";
    node.style.textAlign = "center";
    document.body.appendChild(node);
  }

  function postLogout(session) {
    if (!session.token || !session.deviceUuid) return Promise.resolve();
    return fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.token,
        "X-User-Id": session.userId,
        "X-Device-Uuid": session.deviceUuid,
      },
      body: JSON.stringify({
        token: session.token,
        userId: session.userId,
        deviceUuid: session.deviceUuid,
        roomId: session.roomId,
        clientApp: "mobile-frontend",
      }),
      keepalive: true,
    }).catch(function () {});
  }

  function releaseActiveTableLock() {
    var releases = [];
    if (typeof window.__mobileServiceRecoveryReleaseActiveLock === "function") {
      try {
        releases.push(Promise.resolve(window.__mobileServiceRecoveryReleaseActiveLock()));
      } catch (_error) {}
    }
    if (typeof window.__mobileTableLockReleaseAll === "function") {
      try {
        releases.push(Promise.resolve(window.__mobileTableLockReleaseAll()));
      } catch (_error) {}
    }
    return Promise.all(releases).then(function () {});
  }

  function handleTimeout() {
    if (loggingOut || !hasSession()) return;
    loggingOut = true;
    clearTimer();
    var message = "Sessione terminata per inattività.";
    var session = getSession();
    Promise.resolve()
      .then(releaseActiveTableLock)
      .then(function () {
        return postLogout(session);
      })
      .finally(function () {
        clearSessionStorage();
        writeSessionMessage(message);
        showInlineMessage(message);
        try {
          window.dispatchEvent(new CustomEvent("mobile:session-expired", { detail: { reason: "inactivity" } }));
        } catch (_error) {}
        window.setTimeout(function () {
          window.location.assign("/");
        }, 650);
      });
  }

  function onUserActivity() {
    if (loggingOut) return;
    scheduleTimeout();
  }

  function start() {
    activityEvents.forEach(function (eventName) {
      document.addEventListener(eventName, onUserActivity, { capture: true, passive: true });
    });
    syncSessionTimerFromStorage();
    sessionPoll = window.setInterval(function () {
      syncSessionTimerFromStorage();
    }, CHECK_SESSION_MS);
    window.addEventListener("beforeunload", function () {
      clearTimer();
      if (sessionPoll !== null) window.clearInterval(sessionPoll);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
