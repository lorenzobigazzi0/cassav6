(function () {
  if (window.__mobilePaymentConfigResetInstalled === true) return;
  window.__mobilePaymentConfigResetInstalled = true;

  const RESET_VERSION = "20260509-global-payment-runtime-reset-1";
  const RESET_MARKER_KEY = "mobile:payment-config-reset-version";
  const TARGET_KEYS = [
    "payment_pos_id",
    "payment_cash_float",
    "payment_cash_float_locked",
    "pos_session_started_at",
    "pos_analytics_transactions_v1",
  ];
  const TARGET_PREFIXES = [
    "mobile_payment_runtime_v1:",
    "payment_settlement_cutoff_v1:",
    "payment_settlement_summary_v1:",
  ];

  function readMarker() {
    try {
      const localValue = window.localStorage.getItem(RESET_MARKER_KEY);
      if (localValue) return localValue;
    } catch {
      // noop
    }
    try {
      return window.sessionStorage.getItem(RESET_MARKER_KEY) || "";
    } catch {
      return "";
    }
  }

  function writeMarker() {
    try {
      window.localStorage.setItem(RESET_MARKER_KEY, RESET_VERSION);
    } catch {
      // noop
    }
    try {
      window.sessionStorage.setItem(RESET_MARKER_KEY, RESET_VERSION);
    } catch {
      // noop
    }
  }

  function removeKey(storage, key) {
    try {
      storage.removeItem(key);
    } catch {
      // noop
    }
  }

  function clearPaymentRuntime() {
    const cleared = [];
    const storages = [window.localStorage, window.sessionStorage].filter(Boolean);
    storages.forEach((storage) => {
      TARGET_KEYS.forEach((key) => {
        removeKey(storage, key);
        cleared.push(key);
      });
      try {
        for (let index = storage.length - 1; index >= 0; index -= 1) {
          const key = storage.key(index);
          if (!key || !TARGET_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
          removeKey(storage, key);
          cleared.push(key);
        }
      } catch {
        // noop
      }
    });
    return [...new Set(cleared)];
  }

  if (readMarker() === RESET_VERSION) {
    return;
  }

  const clearedKeys = clearPaymentRuntime();
  writeMarker();

  try {
    window.dispatchEvent(
      new CustomEvent("mobile:payment-config-reset", {
        detail: {
          version: RESET_VERSION,
          clearedKeys,
        },
      })
    );
  } catch {
    // noop
  }
})();
