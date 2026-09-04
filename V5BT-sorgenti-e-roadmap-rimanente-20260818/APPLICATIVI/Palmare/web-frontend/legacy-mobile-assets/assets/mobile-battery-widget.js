(function installMobileBatteryWidget() {
  if (window.__mobileBatteryWidgetInstalled) {
    return;
  }
  window.__mobileBatteryWidgetInstalled = true;

  const API_PATH = "/api/mobile/battery";
  const POLL_MS = 1000;
  const TOKEN_KEYS = ["pos_auth_token", "pos_token", "auth_token", "token"];
  const USER_KEYS = ["pos_user_id", "user_id", "userId"];
  const DEVICE_KEYS = ["pos_device_uuid", "device_uuid", "deviceUuid", "mobile_device_uuid"];
  const BATTERY_DEVICE_KEYS = [
    "pos_battery_device_id",
    "pos_battery_device_uuid",
    "pos_battery_device_name",
    "battery_device_id",
    "battery_device_uuid",
    "battery_device_name",
  ];

  const state = {
    inflight: false,
    timer: null,
    observer: null,
  };

  function readStorageValue(keys) {
    try {
      for (const key of keys) {
        const value = window.localStorage && window.localStorage.getItem(key);
        if (value && String(value).trim()) {
          return String(value).trim();
        }
      }
    } catch (_error) {
      return "";
    }
    return "";
  }

  function getDeviceUuid() {
    return readStorageValue(DEVICE_KEYS);
  }

  function readQueryBatteryDevice() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const value =
        params.get("batteryDevice") ||
        params.get("batteryDeviceId") ||
        params.get("batteryDeviceName") ||
        params.get("batteryIp") ||
        params.get("deviceName") ||
        "";
      const normalized = String(value || "").trim();
      if (normalized && window.localStorage) {
        window.localStorage.setItem("pos_battery_device_id", normalized);
      }
      return normalized;
    } catch (_error) {
      return "";
    }
  }

  function getBatteryDeviceIdentifier() {
    return readQueryBatteryDevice() || readStorageValue(BATTERY_DEVICE_KEYS) || getDeviceUuid();
  }

  readQueryBatteryDevice();

  function ensureWidget() {
    const led = document.querySelector(".system-status .status-led");
    if (!led || !led.parentElement) {
      return null;
    }

    const host = led.parentElement;
    let widget = Array.from(host.children).find((child) => child.classList && child.classList.contains("mobile-battery-widget"));
    let created = false;
    if (!widget) {
      widget = document.createElement("span");
      widget.className = "mobile-battery-widget is-unknown";
      widget.setAttribute("role", "img");
      widget.setAttribute("aria-label", "Batteria non disponibile");
      widget.innerHTML = [
        '<span class="mobile-battery-shell" aria-hidden="true">',
        '<span class="mobile-battery-fill"></span>',
        '<span class="mobile-battery-percent" aria-hidden="true">--</span>',
        '<span class="mobile-battery-bolt">&#9889;</span>',
        "</span>",
      ].join("");
      host.insertBefore(widget, led);
      created = true;
    } else if (widget.nextElementSibling !== led) {
      host.insertBefore(widget, led);
    }
    if (created) {
      window.setTimeout(pollBattery, 0);
    }
    return widget;
  }

  function setUnknown(message) {
    const widget = ensureWidget();
    if (!widget) {
      return;
    }
    const fill = widget.querySelector(".mobile-battery-fill");
    const percent = widget.querySelector(".mobile-battery-percent");
    const shell = widget.querySelector(".mobile-battery-shell");
    if (shell && percent && percent.parentElement !== shell) {
      shell.appendChild(percent);
    }
    widget.classList.add("is-unknown");
    widget.classList.remove("is-low", "is-charging", "is-offline");
    widget.removeAttribute("data-level");
    widget.title = message || "Batteria non disponibile";
    widget.setAttribute("aria-label", widget.title);
    if (fill) {
      fill.style.removeProperty("width");
      fill.style.setProperty("--mobile-battery-level", "0");
    }
    if (percent) {
      percent.textContent = "--";
    }
  }

  function updateWidget(device, stale) {
    const widget = ensureWidget();
    if (!widget) {
      return;
    }
    if (!device || typeof device.level !== "number") {
      setUnknown("Batteria non disponibile per questo dispositivo");
      return;
    }

    const level = Math.max(0, Math.min(100, Math.round(device.level)));
    const fill = widget.querySelector(".mobile-battery-fill");
    const percent = widget.querySelector(".mobile-battery-percent");
    const shell = widget.querySelector(".mobile-battery-shell");
    if (shell && percent && percent.parentElement !== shell) {
      shell.appendChild(percent);
    }
    const deviceName = device.deviceName ? ` ${device.deviceName}` : "";
    const chargeText = device.charging ? "in carica" : "non in carica";
    const staleText = stale ? " (dato temporaneamente in cache)" : "";

    widget.classList.remove("is-unknown");
    widget.classList.toggle("is-low", level < 20);
    widget.classList.toggle("is-charging", Boolean(device.charging));
    widget.classList.toggle("is-offline", device.online === false);
    widget.dataset.level = String(level);
    widget.title = `Batteria${deviceName}: ${level}%, ${chargeText}${staleText}`;
    widget.setAttribute("aria-label", widget.title);
    if (fill) {
      fill.style.removeProperty("width");
      fill.style.setProperty("--mobile-battery-level", String(level / 100));
    }
    if (percent) {
      percent.textContent = String(level);
    }
  }

  async function pollBattery() {
    const widget = ensureWidget();
    if (!widget || state.inflight || typeof window.fetch !== "function") {
      return;
    }

    const deviceUuid = getDeviceUuid();
    const batteryDeviceIdentifier = getBatteryDeviceIdentifier();
    if (!batteryDeviceIdentifier) {
      setUnknown("Device mobile non riconosciuto");
      return;
    }

    const headers = {
      Accept: "application/json",
      "X-Device-Uuid": batteryDeviceIdentifier,
    };
    const token = readStorageValue(TOKEN_KEYS);
    const userId = readStorageValue(USER_KEYS);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (userId) {
      headers["X-User-Id"] = userId;
    }

    state.inflight = true;
    try {
      const url = new URL(API_PATH, window.location.origin);
      url.searchParams.set("deviceUuid", batteryDeviceIdentifier);
      if (deviceUuid && deviceUuid !== batteryDeviceIdentifier) {
        url.searchParams.set("mobileDeviceUuid", deviceUuid);
      }
      const response = await window.fetch(url.toString(), {
        cache: "no-store",
        credentials: "same-origin",
        headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload || !payload.ok || !payload.device) {
        setUnknown("Batteria non disponibile per questo dispositivo");
        return;
      }
      updateWidget(payload.device, Boolean(payload.stale));
    } catch (_error) {
      setUnknown("Batteria non disponibile");
    } finally {
      state.inflight = false;
    }
  }

  function startPolling() {
    ensureWidget();
    pollBattery();
    if (state.timer) {
      window.clearInterval(state.timer);
    }
    state.timer = window.setInterval(pollBattery, POLL_MS);
  }

  function startObserver() {
    if (state.observer || !document.documentElement || typeof MutationObserver !== "function") {
      return;
    }
    state.observer = new MutationObserver(() => {
      ensureWidget();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.addEventListener("storage", pollBattery);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollBattery();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startObserver();
      startPolling();
    }, { once: true });
  } else {
    startObserver();
    startPolling();
  }
})();
