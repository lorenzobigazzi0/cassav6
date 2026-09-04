(function () {
  const POLL_MS = 3000;
  const STORAGE_KEY = "pos:settings-version";
  const BANNER_ID = "pos-settings-sync-banner";
  const STYLE_ID = "pos-settings-sync-style";
  const state = {
    baseline: null,
    reloading: false,
    started: false,
  };

  function readStoredVersion() {
    try {
      const value = Number(window.localStorage.getItem(STORAGE_KEY) || "");
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function writeStoredVersion(version) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(version));
    } catch {
      // noop
    }
  }

  function resolveVersion(payload) {
    const raw =
      payload && payload.settingsVersion != null
        ? Number(payload.settingsVersion)
        : Number(payload && payload.version);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  function ensureBannerStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 100000;
        min-height: 42px;
        padding: 10px 14px;
        border-radius: 14px;
        background: rgba(10, 28, 49, 0.94);
        color: #f5fbff;
        border: 1px solid rgba(157, 212, 255, 0.34);
        box-shadow: 0 16px 34px rgba(0, 0, 0, 0.28);
        font-size: 13px;
        font-weight: 820;
        letter-spacing: 0.02em;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 140ms ease, transform 140ms ease;
        pointer-events: none;
      }
      #${BANNER_ID}.is-visible {
        opacity: 1;
        transform: translateY(0);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureBanner() {
    ensureBannerStyles();
    let banner = document.getElementById(BANNER_ID);
    if (banner) return banner;
    banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.setAttribute("aria-live", "polite");
    document.body.appendChild(banner);
    return banner;
  }

  function triggerReload() {
    if (state.reloading) return;
    state.reloading = true;
    const banner = ensureBanner();
    banner.textContent = "Configurazione aggiornata. Ricarico...";
    banner.classList.add("is-visible");
    window.setTimeout(() => {
      window.location.reload();
    }, 420);
  }

  async function pollVersion() {
    try {
      const response = await fetch(`/api/health?_=${Date.now()}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        return;
      }
      const remoteVersion = resolveVersion(payload);
      if (!remoteVersion) return;

      const storedVersion = readStoredVersion();
      if (state.baseline === null) {
        state.baseline = Math.max(remoteVersion, storedVersion);
        writeStoredVersion(state.baseline);
        return;
      }

      const nextVersion = Math.max(remoteVersion, storedVersion);
      if (nextVersion > state.baseline) {
        state.baseline = nextVersion;
        writeStoredVersion(nextVersion);
        triggerReload();
      }
    } catch {
      // noop
    }
  }

  function handleVersionEvent(event) {
    const version = Number(event?.detail?.version);
    if (!Number.isFinite(version) || version <= 0) return;
    state.baseline = state.baseline === null ? version : Math.max(state.baseline, version);
    writeStoredVersion(version);
  }

  function isSettingsUrl(url) {
    return /\/api\/settings\/pos(?:\/|$|\?)/.test(url) || /\/api\/settings\/menu(?:\/|$|\?)/.test(url);
  }

  function installFetchBridge() {
    if (typeof window.fetch !== "function" || window.fetch.__posSettingsSyncWrapped === true) {
      return;
    }
    const nativeFetch = window.fetch.bind(window);
    const wrappedFetch = function (input, init) {
      return nativeFetch(input, init).then((response) => {
        try {
          const url =
            typeof input === "string"
              ? input
              : input && typeof input.url === "string"
                ? input.url
                : String(response?.url ?? "");
          if (!isSettingsUrl(url)) {
            return response;
          }
          const contentType =
            response?.headers && typeof response.headers.get === "function"
              ? String(response.headers.get("content-type") || "")
              : "";
          if (!/application\/json/i.test(contentType)) {
            return response;
          }
          response
            .clone()
            .json()
            .then((payload) => {
              const version = resolveVersion(payload);
              if (version > 0) {
                handleVersionEvent({ detail: { version } });
              }
            })
            .catch(() => {});
        } catch {
          // noop
        }
        return response;
      });
    };
    wrappedFetch.__posSettingsSyncWrapped = true;
    window.fetch = wrappedFetch;
  }

  function start() {
    if (state.started) return;
    state.started = true;
    state.baseline = readStoredVersion() || null;
    installFetchBridge();
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || state.reloading) return;
      const version = Number(event.newValue || "");
      if (!Number.isFinite(version) || version <= 0) return;
      if (state.baseline === null || version > state.baseline) {
        state.baseline = version;
        triggerReload();
      }
    });
    window.addEventListener("pos:settings-version", handleVersionEvent);
    window.addEventListener("focus", () => {
      if (!state.reloading) {
        void pollVersion();
      }
    });
    void pollVersion();
    window.setInterval(() => {
      if (!document.hidden && !state.reloading) {
        void pollVersion();
      }
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
