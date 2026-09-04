(function () {
  if (window.__mobileOrderWorkflowSettingsBridgeInstalled === true) {
    return;
  }
  window.__mobileOrderWorkflowSettingsBridgeInstalled = true;

  const POLL_MS = 5000;
  const SYNC_POLL_MS = 800;
  const ROW_ID = "mobile-order-workflow-delivery-toggle-row";
  const DEFAULTS = {
    deliveryConfirmationEnabled: false,
    requireReadyForDelivery: false,
    requireDeliveredForPayment: false,
  };
  let currentSettings = { ...DEFAULTS };
  let loading = false;
  let saving = false;
  let statusMessage = "";
  let statusTone = "";
  let observer = null;
  let observerMutedUntil = 0;

  function muteObserver() {
    observerMutedUntil = Date.now() + 150;
  }

  function observerIsMuted() {
    return Date.now() < observerMutedUntil;
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function readStorageValue(key) {
    try {
      const localValue = window.localStorage.getItem(key);
      if (localValue !== null) return localValue;
    } catch (_error) {}
    try {
      return window.sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function authPayload(extra) {
    return {
      token: normalizeText(readStorageValue("pos_token")),
      userId: normalizeText(readStorageValue("pos_user_id")),
      username: normalizeText(readStorageValue("pos_user")),
      deviceUuid: normalizeText(readStorageValue("pos_device_uuid")),
      roomId: normalizeText(readStorageValue("pos_room_id")),
      clientApp: "mobile-frontend",
      ...(extra || {}),
    };
  }

  function injectStyle() {
    if (document.getElementById("mobile-order-workflow-settings-bridge-style")) return;
    const style = document.createElement("style");
    style.id = "mobile-order-workflow-settings-bridge-style";
    style.textContent = `
      #${ROW_ID}.is-saving { opacity: .72; }
      #${ROW_ID} .mow-status { display: block; margin-top: 4px; font-size: 11px; line-height: 1.25; color: rgba(255,255,255,.62); }
      #${ROW_ID} .mow-status.is-error { color: #ffd3c7; }
      #${ROW_ID} .mow-switch { min-width: 86px; justify-content: center; }
      #${ROW_ID} .mow-switch.is-enabled { background: rgba(41, 191, 124, .22); border-color: rgba(41, 191, 124, .46); color: #dcffe9; }
      #${ROW_ID} .mow-switch.is-disabled { background: rgba(255, 183, 77, .16); border-color: rgba(255, 183, 77, .42); color: #ffe0b2; }
    `;
    document.head.appendChild(style);
  }

  function applySettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    const deliveryConfirmationEnabled = source.deliveryConfirmationEnabled !== false;
    currentSettings = {
      deliveryConfirmationEnabled,
      requireReadyForDelivery: deliveryConfirmationEnabled && source.requireReadyForDelivery !== false,
      requireDeliveredForPayment: deliveryConfirmationEnabled && source.requireDeliveredForPayment !== false,
    };
    window.__cashmanagerOrderWorkflowSettings = { ...currentSettings };
    renderSettingsToggle();
  }

  async function refreshSettings() {
    if (loading) return;
    const auth = authPayload();
    if (!auth.token || !auth.userId) return;
    loading = true;
    try {
      const response = await fetch(`/api/settings/pos?_=${Date.now()}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(auth),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) return;
      applySettings(payload.orderWorkflow);
    } catch {
      // Mantiene l'ultimo valore noto.
    } finally {
      loading = false;
    }
  }

  async function saveDeliveryConfirmation(nextEnabled) {
    if (saving) return;
    const previous = { ...currentSettings };
    const nextSettings = {
      deliveryConfirmationEnabled: nextEnabled,
      requireReadyForDelivery: nextEnabled,
      requireDeliveredForPayment: nextEnabled,
    };
    saving = true;
    statusMessage = "Salvataggio...";
    statusTone = "";
    applySettings(nextSettings);
    try {
      const response = await fetch("/api/settings/order-workflow", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(authPayload({ orderWorkflow: nextSettings })),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) {
        const message = payload && (payload.error || payload.message || payload.code);
        throw new Error(normalizeText(message) || "Impossibile salvare l'impostazione.");
      }
      statusMessage = nextEnabled
        ? "Segna consegnato riattivato."
        : "Da ora le comande pronte diventano pagabili automaticamente.";
      statusTone = "success";
      applySettings(payload.orderWorkflow || nextSettings);
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : String(error);
      statusTone = "error";
      applySettings(previous);
    } finally {
      saving = false;
      renderSettingsToggle();
    }
  }

  function findComandeList() {
    const titles = document.querySelectorAll(".settings-group-title");
    for (let index = 0; index < titles.length; index += 1) {
      const title = titles[index];
      if (normalizeText(title.textContent).toLowerCase() !== "comande") continue;
      const group = title.closest(".settings-group");
      const list = group && group.querySelector(".settings-ios-list");
      if (list) return list;
    }
    return null;
  }

  function renderSettingsToggle() {
    if (!document.body) return;
    injectStyle();
    const list = findComandeList();
    const existing = document.getElementById(ROW_ID);
    if (!list) {
      if (existing) existing.remove();
      return;
    }
    const enabled = currentSettings.deliveryConfirmationEnabled !== false;
    const row = existing || document.createElement("div");
    row.id = ROW_ID;
    const nextClassName = "settings-ios-row settings-ios-row-toggle" + (saving ? " is-saving" : "");
    const nextMarkup = `
      <div class="settings-ios-key-wrap">
        <div class="settings-ios-key">Segna consegnato</div>
        <div class="settings-ios-value">
          ${enabled
            ? "Richiede la conferma consegna prima del pagamento."
            : "Quando la comanda e pronta viene considerata consegnata e pagabile."}
          ${statusMessage ? `<span class="mow-status ${statusTone === "error" ? "is-error" : ""}">${statusMessage}</span>` : ""}
        </div>
      </div>
      <button class="smallbtn mow-switch ${enabled ? "is-enabled" : "is-disabled"}" type="button" ${saving ? "disabled" : ""}>
        ${enabled ? "Attivo" : "Disattivo"}
      </button>
    `;
    if (row.className !== nextClassName) {
      muteObserver();
      row.className = nextClassName;
    }
    if (row.dataset.renderKey !== nextMarkup) {
      muteObserver();
      row.innerHTML = nextMarkup;
      row.dataset.renderKey = nextMarkup;
    }
    const button = row.querySelector(".mow-switch");
    if (button && !button.dataset.bound) {
      button.dataset.bound = "1";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void saveDeliveryConfirmation(!enabled);
      });
    }
    if (!existing) {
      muteObserver();
      list.appendChild(row);
    }
  }

  function start() {
    applySettings(DEFAULTS);
    void refreshSettings();
    window.setInterval(() => {
      if (!document.hidden) {
        void refreshSettings();
      }
    }, POLL_MS);
    window.addEventListener("focus", () => void refreshSettings());
    observer = new MutationObserver(() => {
      if (observerIsMuted()) return;
      renderSettingsToggle();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    window.setInterval(() => {
      if (!document.hidden) renderSettingsToggle();
    }, SYNC_POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
