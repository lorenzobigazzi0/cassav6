(function () {
  if (window.__mobileUserMenuBridgeInstalled === true) return;
  window.__mobileUserMenuBridgeInstalled = true;

  const STORAGE_KEY = "mobile:menu:station-badge-enabled";
  const TOGGLE_ROW_ID = "mobile-menu-station-badge-setting";
  const SUSPICIOUS_PATTERN = /(?:Ã.|Â.|â[\u0080-\u00BF]|ï¿½)/;
  const SUSPICIOUS_CHARS = /[ÃÂâï¿½]/g;
  const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
  const decoder =
    typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;
  let started = false;
  let queued = false;

  function readStoredValue() {
    try {
      const localValue = window.localStorage.getItem(STORAGE_KEY);
      if (localValue !== null) {
        return localValue;
      }
    } catch {
      // noop
    }
    try {
      return window.sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function isBadgeEnabled() {
    const rawValue = String(readStoredValue() ?? "").trim();
    if (!rawValue) return true;
    return rawValue !== "0" && rawValue.toLowerCase() !== "false";
  }

  function storeBadgeEnabled(enabled) {
    const value = enabled ? "1" : "0";
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // noop
    }
    try {
      window.sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
      // noop
    }
    try {
      window.dispatchEvent(
        new CustomEvent("mobile:menu:station-badge-setting", {
          detail: { enabled: !!enabled },
        })
      );
    } catch {
      // noop
    }
  }

  function suspiciousScore(value) {
    return (String(value).match(SUSPICIOUS_CHARS) || []).length;
  }

  function decodeLatin1Utf8(value) {
    try {
      if (decoder) {
        const bytes = Uint8Array.from(Array.from(value), function (char) {
          return char.charCodeAt(0) & 0xff;
        });
        return decoder.decode(bytes);
      }
      return decodeURIComponent(escape(value));
    } catch {
      return value;
    }
  }

  function repairBrokenText(value) {
    let current = String(value ?? "");
    if (!SUSPICIOUS_PATTERN.test(current)) {
      return current;
    }

    for (let index = 0; index < 4; index += 1) {
      const decoded = decodeLatin1Utf8(current);
      if (!decoded || decoded === current) {
        break;
      }
      if (decoded.includes("\uFFFD") && !current.includes("\uFFFD")) {
        break;
      }
      if (CONTROL_PATTERN.test(decoded)) {
        break;
      }
      if (suspiciousScore(decoded) >= suspiciousScore(current)) {
        break;
      }
      current = decoded;
      if (!SUSPICIOUS_PATTERN.test(current)) {
        break;
      }
    }

    return current;
  }

  function normalizeText(value) {
    return repairBrokenText(value)
      .replace(/\u00C2\u00B7/g, "\u00B7")
      .replace(/\u00C3\u201A\u00B7/g, "\u00B7")
      .replace(/\u00C2(?=\s*[\u00B7\u2022|,])/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatStationLabel(value) {
    return normalizeText(value).toLocaleUpperCase("it-IT");
  }

  function splitCardLabel(value) {
    const normalized = normalizeText(value);
    if (!normalized) return null;
    const parts = normalized.split(/\s*(?:\u00B7|\u2022|\||,)\s*/).filter(Boolean);
    if (parts.length < 2) return null;
    const stationLabel = formatStationLabel(parts.shift());
    if (!stationLabel) return null;
    return {
      fullLabel: normalized,
      badgeLabel: stationLabel,
      mainLabel: normalizeText(parts.join(" · ")),
    };
  }

  function ensureCardBadge(card) {
    let badge = card.querySelector(".mobile-menu-level-station-badge");
    if (badge) {
      return badge;
    }
    badge = document.createElement("span");
    badge.className = "mobile-menu-level-station-badge";
    badge.setAttribute("aria-hidden", "true");
    card.appendChild(badge);
    return badge;
  }

  function cleanupCard(card, nameNode, fullLabel) {
    if (nameNode && fullLabel) {
      nameNode.textContent = fullLabel;
    }
    card.classList.remove("has-mobile-menu-station-badge");
    card.removeAttribute("data-mobile-menu-badge");
    const badge = card.querySelector(".mobile-menu-level-station-badge");
    if (badge) {
      badge.remove();
    }
  }

  function syncMenuLevelCard(card) {
    const nameNode = card.querySelector(".menu-level-name");
    if (!(nameNode instanceof HTMLElement)) return;

    const liveLabel = normalizeText(nameNode.textContent);
    if (splitCardLabel(liveLabel)) {
      card.dataset.mobileMenuOriginalLabel = liveLabel;
    }

    const originalLabel = normalizeText(card.dataset.mobileMenuOriginalLabel || liveLabel);
    const splitLabel = splitCardLabel(originalLabel);

    if (!splitLabel || !isBadgeEnabled()) {
      cleanupCard(card, nameNode, originalLabel);
      return;
    }

    nameNode.textContent = splitLabel.mainLabel;
    nameNode.title = splitLabel.mainLabel;
    card.classList.add("has-mobile-menu-station-badge");
    card.dataset.mobileMenuBadge = splitLabel.badgeLabel.toLowerCase();

    const badge = ensureCardBadge(card);
    badge.textContent = splitLabel.badgeLabel;
    badge.title = splitLabel.badgeLabel;
    badge.setAttribute("aria-label", splitLabel.badgeLabel);
  }

  function syncMenuLevelCards() {
    document.querySelectorAll(".menu-level-card").forEach((card) => {
      if (card instanceof HTMLElement) {
        syncMenuLevelCard(card);
      }
    });
  }

  function findManagedMenuSettingsGroup() {
    return (
      Array.from(document.querySelectorAll(".settings-group")).find((group) => {
        const title = group.querySelector(".settings-group-title");
        return normalizeText(title && title.textContent).toLowerCase() === "gestione menu";
      }) || null
    );
  }

  function syncToggleButtonState(button) {
    const enabled = isBadgeEnabled();
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-checked", enabled ? "true" : "false");
  }

  function ensureSettingsToggleRow() {
    const group = findManagedMenuSettingsGroup();
    if (!group) return;

    let list = document.getElementById(TOGGLE_ROW_ID);
    if (!list) {
      list = document.createElement("div");
      list.id = TOGGLE_ROW_ID;
      list.className = "settings-ios-list mobile-menu-station-badge-list";
      list.innerHTML = [
        '<div class="settings-ios-row settings-ios-row-toggle mobile-menu-station-badge-row">',
        '  <div class="settings-ios-key-wrap">',
        '    <div class="settings-ios-key">Badge postazione sulle card</div>',
        '    <div class="settings-ios-value">Mostra BAR, CAFFETTERIA o CUCINA in un badge in basso a destra.</div>',
        "  </div>",
        '  <button class="setting-switch mobile-menu-station-badge-toggle" type="button" role="switch" aria-label="Badge postazione sulle card" aria-checked="true">',
        '    <span class="setting-switch-track"><span class="setting-switch-thumb"></span></span>',
        "  </button>",
        "</div>",
      ].join("");

      const anchor =
        group.querySelector(".settings-menu-toolbar") ||
        group.querySelector(".settings-menu-list") ||
        group.querySelector(".settings-status-banner");

      if (anchor && anchor.parentElement === group) {
        group.insertBefore(list, anchor);
      } else {
        group.appendChild(list);
      }
    }

    const button = list.querySelector(".mobile-menu-station-badge-toggle");
    if (!(button instanceof HTMLButtonElement)) return;

    if (!button.dataset.bound) {
      button.dataset.bound = "1";
      button.addEventListener("click", () => {
        const nextEnabled = !isBadgeEnabled();
        storeBadgeEnabled(nextEnabled);
        syncToggleButtonState(button);
        scheduleSync();
      });
    }

    syncToggleButtonState(button);
  }

  function syncAll() {
    ensureSettingsToggleRow();
    syncMenuLevelCards();
  }

  function scheduleSync() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      syncAll();
    });
  }

  function start() {
    if (started) return;
    started = true;

    if (document.body) {
      const observer = new MutationObserver(() => {
        scheduleSync();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY) {
        scheduleSync();
      }
    });
    window.addEventListener("mobile:menu:station-badge-setting", scheduleSync);
    window.addEventListener("pageshow", scheduleSync);
    window.addEventListener("focus", scheduleSync);

    scheduleSync();
  }

  window.addEventListener("load", start, { once: true });
  if (document.readyState === "complete" || document.readyState === "interactive") {
    start();
  }
})();
