(function () {
  if (window.__mobileHideRecentBadgeInstalled === true) return;
  window.__mobileHideRecentBadgeInstalled = true;

  const BADGE_SELECTOR = ".table-order-product-badge";
  const BADGE_LABEL = "recenti";

  function removeRecentBadge(node) {
    if (!(node instanceof Element)) {
      return;
    }

    const candidates = [];
    if (node.matches(BADGE_SELECTOR)) {
      candidates.push(node);
    }
    candidates.push(...node.querySelectorAll(BADGE_SELECTOR));

    for (const badge of candidates) {
      if (String(badge.textContent || "").trim().toLowerCase() !== BADGE_LABEL) {
        continue;
      }
      badge.remove();
    }
  }

  function startObserver() {
    removeRecentBadge(document.documentElement);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          removeRecentBadge(node);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
