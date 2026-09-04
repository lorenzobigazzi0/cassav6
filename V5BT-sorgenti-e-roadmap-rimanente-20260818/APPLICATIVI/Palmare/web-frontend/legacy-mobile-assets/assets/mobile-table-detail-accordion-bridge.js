(function mobileTableDetailAccordionBridge() {
  if (window.__mobileTableDetailAccordionBridgeInstalled === true) return;
  window.__mobileTableDetailAccordionBridgeInstalled = true;

  var syncing = false;

  function isElement(value) {
    return value instanceof Element;
  }

  function isOpen(selector) {
    var node = document.querySelector(selector);
    return node instanceof Element && node.classList.contains("is-open");
  }

  function clickIfOpen(selector) {
    var node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) return;
    var open = node.classList.contains("is-open") || node.getAttribute("aria-expanded") === "true";
    if (!open) return;
    syncing = true;
    try {
      node.click();
    } finally {
      window.setTimeout(function () {
        syncing = false;
      }, 0);
    }
  }

  function enforceMutualExclusion(preferred) {
    if (syncing) return;
    if (preferred === "anagraphic" && isOpen(".table-detail-anagraphic-toggle")) {
      clickIfOpen(".table-history-toggle-btn[aria-expanded='true']");
      return;
    }
    if (preferred === "history" && isOpen(".table-history-chevron.is-open")) {
      clickIfOpen(".table-detail-anagraphic-toggle.is-open");
    }
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = isElement(event.target) ? event.target : null;
      if (!target || syncing) return;

      if (target.closest(".table-detail-anagraphic-toggle")) {
        window.requestAnimationFrame(function () {
          enforceMutualExclusion("anagraphic");
        });
        return;
      }

      if (target.closest(".table-history-toggle-btn")) {
        window.requestAnimationFrame(function () {
          enforceMutualExclusion("history");
        });
      }
    },
    true
  );
})();
