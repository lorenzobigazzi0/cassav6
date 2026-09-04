(function () {
  const SUMMARY_SELECTOR = ".summary-section";
  const STATS_ROW_SELECTOR = ".stats-row";
  const NOTES_BOX_SELECTOR = ".notes-box";
  const ORDER_ITEM_SELECTOR = ".order-item";
  const ITEM_QTY_SELECTOR = ".item-qty";
  const ITEM_VARIANT_SELECTOR = ".item-variant";
  const ITEM_NOTES_SELECTOR = ".item-notes";
  const APERICENA_BOX_CLASS = "postazione-apericena-box";

  if (window.__postazioneApericenaSummaryInstalled === true) {
    return;
  }
  window.__postazioneApericenaSummaryInstalled = true;

  function containsApericenaMarker(value) {
    return /\bmenu\s+apericena\b|\bapericena\b/i.test(String(value || "").trim());
  }

  function normalizeApericenaText(value) {
    const raw = String(value || "").trim();
    if (!containsApericenaMarker(raw)) {
      return raw;
    }
    return raw
      .replace(/\s*\+\s*\d[\d.,]*\s*(?:eur|euro|€)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/menu apericena/gi, "MENU APERICENA");
  }

  function parseApericenaQuantityFromStats(summary) {
    const statsRow = summary.querySelector(STATS_ROW_SELECTOR);
    if (!(statsRow instanceof HTMLElement)) {
      return 0;
    }

    const statsText = Array.from(statsRow.querySelectorAll("span"))
      .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
      .join(" ");

    const match = statsText.match(/APERICENA:\s*(\d+)/i);
    if (!match) {
      return 0;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function parseItemQuantity(item) {
    const qtyNode = item.querySelector(ITEM_QTY_SELECTOR);
    const parsed = Number.parseInt(String(qtyNode?.textContent || "").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  function deriveApericenaQuantityFromItems(summary) {
    const detailView = summary.closest(".detail-view");
    if (!(detailView instanceof HTMLElement)) {
      return 0;
    }

    let quantity = 0;
    detailView.querySelectorAll(ORDER_ITEM_SELECTOR).forEach((item) => {
      if (!(item instanceof HTMLElement)) {
        return;
      }
      if (item.classList.contains("postazione-correction-removed-item")) {
        return;
      }
      const nameText = String(item.querySelector(".item-name")?.textContent || "").trim();
      const variantText = String(item.querySelector(ITEM_VARIANT_SELECTOR)?.textContent || "").trim();
      const notesText = String(item.querySelector(ITEM_NOTES_SELECTOR)?.textContent || "").trim();
      if (!containsApericenaMarker(`${nameText} ${variantText} ${notesText}`)) {
        return;
      }
      quantity += parseItemQuantity(item);
    });
    return quantity;
  }

  function hasApericenaMarkersInItems(summary) {
    const detailView = summary.closest(".detail-view");
    if (!(detailView instanceof HTMLElement)) {
      return false;
    }
    return Array.from(detailView.querySelectorAll(ORDER_ITEM_SELECTOR)).some((item) => {
      if (!(item instanceof HTMLElement) || item.classList.contains("postazione-correction-removed-item")) {
        return false;
      }
      const nameText = String(item.querySelector(".item-name")?.textContent || "").trim();
      const variantText = String(item.querySelector(ITEM_VARIANT_SELECTOR)?.textContent || "").trim();
      const notesText = String(item.querySelector(ITEM_NOTES_SELECTOR)?.textContent || "").trim();
      return containsApericenaMarker(`${nameText} ${variantText} ${notesText}`);
    });
  }

  function syncStatsRowApericena(summary, quantity) {
    const statsRow = summary.querySelector(STATS_ROW_SELECTOR);
    if (!(statsRow instanceof HTMLElement)) {
      return;
    }

    Array.from(statsRow.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) {
        return;
      }
      const rawText = String(child.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (!rawText.startsWith("APERICENA:")) {
        return;
      }
      const valueNode = child.querySelector("span");
      if (valueNode instanceof HTMLElement) {
        valueNode.textContent = String(quantity);
      } else {
        child.textContent = `APERICENA: ${quantity}`;
      }
    });
  }

  function syncItemApericenaText(summary) {
    const detailView = summary.closest(".detail-view");
    if (!(detailView instanceof HTMLElement)) {
      return;
    }

    detailView.querySelectorAll(`${ITEM_VARIANT_SELECTOR}, ${ITEM_NOTES_SELECTOR}`).forEach((node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }
      const normalized = normalizeApericenaText(node.textContent || "");
      if (normalized && normalized !== node.textContent) {
        node.textContent = normalized;
      }
    });
  }

  function findCommunicationsBox(summary) {
    return Array.from(summary.querySelectorAll(NOTES_BOX_SELECTOR)).find((box) => {
      const label = String(box.querySelector("strong")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
      return label === "COMUNICAZIONI:";
    }) || null;
  }

  function ensureApericenaBox(summary, quantity) {
    let box = summary.querySelector(`.${APERICENA_BOX_CLASS}`);

    if (box instanceof HTMLElement) {
      box.remove();
    }
  }

  function applyApericenaSummary() {
    document.querySelectorAll(SUMMARY_SELECTOR).forEach((summary) => {
      if (!(summary instanceof HTMLElement)) {
        return;
      }
      syncItemApericenaText(summary);
      const statsQuantity = parseApericenaQuantityFromStats(summary);
      const derivedQuantity = deriveApericenaQuantityFromItems(summary);
      const quantity = hasApericenaMarkersInItems(summary) ? derivedQuantity : statsQuantity;
      syncStatsRowApericena(summary, quantity);
      ensureApericenaBox(summary, quantity);
    });
  }

  let rafId = 0;
  function scheduleApply() {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      applyApericenaSummary();
    });
  }

  function start() {
    applyApericenaSummary();
    const observer = new MutationObserver(() => {
      scheduleApply();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    window.addEventListener("focus", scheduleApply);
    window.addEventListener("resize", scheduleApply);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
