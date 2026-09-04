(function () {
  const USERNAME_KEY = "pos_user";
  const FULL_NAME_KEY = "pos_full_name";
  const ALLOWED_METHOD_IDS_KEY = "pos_allowed_payment_method_ids";
  const PAYMENT_METHODS_URL = "/api/settings/payment-methods";
  const DISABLED_CLASS = "is-disabled";

  const METHOD_ID_BY_LABEL = new Map([
    ["contanti", "pay_cash"],
    ["carta", "pay_card"],
    ["buono pasto", "pay_voucher"],
    ["satispay", "pay_satispay"],
    ["satispay business", "pay_satispay"],
    ["conto sospeso", "pay_suspended"],
    ["assegno", "pay_check"],
    ["bonifico", "pay_wire"],
  ]);

  let configuredMethodIds = null;
  let loginFetchWrapped = false;

  function readStorageValue(key) {
    try {
      const localValue = window.localStorage.getItem(key);
      if (localValue !== null) return localValue;
    } catch {
      // noop
    }
    try {
      const sessionValue = window.sessionStorage.getItem(key);
      if (sessionValue !== null) return sessionValue;
    } catch {
      // noop
    }
    return "";
  }

  function writeStorageValue(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // noop
    }
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // noop
    }
  }

  function removeStorageValue(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // noop
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // noop
    }
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function parseMethodIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
    }
    try {
      const parsed = JSON.parse(String(value));
      return parseMethodIds(parsed);
    } catch {
      return [];
    }
  }

  function isGiadaUser() {
    const identity = normalizeText(
      `${readStorageValue(USERNAME_KEY)} ${readStorageValue(FULL_NAME_KEY)}`
    );
    return identity === "giada" || identity.includes("giada imperato");
  }

  function getUserAllowedMethodIds() {
    const stored = parseMethodIds(readStorageValue(ALLOWED_METHOD_IDS_KEY));
    if (stored.length > 0) return new Set(stored);
    return isGiadaUser() ? new Set(["pay_cash", "pay_card"]) : null;
  }

  function resolveMethodLabel(button) {
    const label = button.querySelector(".table-payment-method-label");
    return normalizeText(label ? label.textContent : button.textContent);
  }

  function resolveMethodId(button) {
    return METHOD_ID_BY_LABEL.get(resolveMethodLabel(button)) || "";
  }

  function resolveBlockReason(methodId) {
    if (!methodId) return "Metodo di pagamento non riconosciuto";
    if (configuredMethodIds && !configuredMethodIds.has(methodId)) {
      return "Metodo non configurato in cassa";
    }
    const userAllowedIds = getUserAllowedMethodIds();
    if (userAllowedIds && !userAllowedIds.has(methodId)) {
      return "Metodo disabilitato per questo utente";
    }
    return "";
  }

  function decorateButton(button, blockReason) {
    if (!blockReason) {
      if (button.dataset.paymentMethodFilter === "1") {
        if (button.dataset.paymentMethodHadDisabledClass !== "1") {
          button.classList.remove(DISABLED_CLASS);
        }
        button.removeAttribute("aria-disabled");
        button.disabled = button.dataset.paymentMethodWasDisabled === "1";
        button.style.removeProperty("opacity");
        button.style.removeProperty("cursor");
        button.style.removeProperty("filter");
        button.style.removeProperty("pointer-events");
        if (button.title === button.dataset.paymentMethodFilterTitle) {
          button.removeAttribute("title");
        }
        delete button.dataset.paymentMethodFilter;
        delete button.dataset.paymentMethodWasDisabled;
        delete button.dataset.paymentMethodHadDisabledClass;
        delete button.dataset.paymentMethodFilterTitle;
      }
      return;
    }

    if (button.dataset.paymentMethodFilter !== "1") {
      button.dataset.paymentMethodWasDisabled = button.disabled ? "1" : "0";
      button.dataset.paymentMethodHadDisabledClass = button.classList.contains(DISABLED_CLASS)
        ? "1"
        : "0";
    }
    button.dataset.paymentMethodFilter = "1";
    button.dataset.paymentMethodFilterTitle = blockReason;
    button.classList.add(DISABLED_CLASS);
    button.setAttribute("aria-disabled", "true");
    button.disabled = true;
    button.title = blockReason;
    button.style.opacity = "0.38";
    button.style.cursor = "not-allowed";
    button.style.filter = "grayscale(0.45)";
    button.style.pointerEvents = "none";
  }

  function refreshPaymentMethods() {
    const buttons = [...document.querySelectorAll(".table-payment-method-card")];
    if (buttons.length === 0) return;

    let activeBlocked = false;
    let firstAllowed = null;
    buttons.forEach((button) => {
      const methodId = resolveMethodId(button);
      const blockReason = resolveBlockReason(methodId);
      if (!blockReason && !button.disabled && !firstAllowed) {
        firstAllowed = button;
      }
      if (blockReason && button.classList.contains("is-active")) {
        activeBlocked = true;
      }
      decorateButton(button, blockReason);
    });

    if (activeBlocked && firstAllowed) {
      window.setTimeout(() => {
        try {
          firstAllowed.click();
        } catch {
          // noop
        }
      }, 0);
    }
  }

  function persistAllowedMethodIdsFromLoginPayload(payload) {
    const ids = parseMethodIds(payload?.user?.allowedPaymentMethodIds);
    if (ids.length > 0) {
      writeStorageValue(ALLOWED_METHOD_IDS_KEY, JSON.stringify(ids));
    } else {
      removeStorageValue(ALLOWED_METHOD_IDS_KEY);
    }
    refreshPaymentMethods();
  }

  function isLoginRequest(input) {
    try {
      const url =
        typeof input === "string"
          ? new URL(input, window.location.origin)
          : input?.url
            ? new URL(input.url, window.location.origin)
            : null;
      return url?.pathname === "/api/auth/login";
    } catch {
      return false;
    }
  }

  function wrapLoginFetch() {
    if (loginFetchWrapped || typeof window.fetch !== "function") return;
    loginFetchWrapped = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = function patchedPaymentMethodFetch(input, init) {
      const loginRequest = isLoginRequest(input);
      const promise = originalFetch(input, init);
      if (loginRequest) {
        promise
          .then((response) => {
            if (!response || !response.ok || typeof response.clone !== "function") return;
            response
              .clone()
              .json()
              .then(persistAllowedMethodIdsFromLoginPayload)
              .catch(() => {
                removeStorageValue(ALLOWED_METHOD_IDS_KEY);
              });
          })
          .catch(() => {
            // noop
          });
      }
      return promise;
    };
  }

  async function fetchConfiguredPaymentMethods() {
    try {
      const response = await fetch(`${PAYMENT_METHODS_URL}?_=${Date.now()}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = await response.json();
      const ids = Array.isArray(payload?.paymentMethods)
        ? payload.paymentMethods
            .filter((method) => method && method.enabled !== false)
            .map((method) => String(method.id ?? "").trim())
            .filter(Boolean)
        : [];
      configuredMethodIds = ids.length > 0 ? new Set(ids) : null;
      refreshPaymentMethods();
    } catch {
      // Se l'endpoint non risponde non blocchiamo l'operativita: resta il blocco utente.
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.(".table-payment-method-card");
      if (!button) return;
      const blockReason = resolveBlockReason(resolveMethodId(button));
      if (!blockReason) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    },
    true
  );

  const observer = new MutationObserver(() => {
    window.requestAnimationFrame(refreshPaymentMethods);
  });

  function start() {
    wrapLoginFetch();
    refreshPaymentMethods();
    fetchConfiguredPaymentMethods();
    window.setInterval(fetchConfiguredPaymentMethods, 60 * 1000);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
