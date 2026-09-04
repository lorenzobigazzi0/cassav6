(function () {
  if (window.__mobileProductPressFeedbackInstalled === true) return;
  window.__mobileProductPressFeedbackInstalled = true;

  const ACTIVE_CLASS = "is-press-feedback";
  const DURATION_MS = 360;
  const timers = new WeakMap();

  function isInteractiveProductRow(row) {
    return (
      row instanceof HTMLButtonElement &&
      row.matches("button.menu-product-row") &&
      row.disabled !== true &&
      !row.classList.contains("is-global-terminated")
    );
  }

  function setPressOrigin(row, event) {
    if (!event || typeof event.clientX !== "number" || typeof event.clientY !== "number") {
      row.style.setProperty("--mobile-press-x", "50%");
      row.style.setProperty("--mobile-press-y", "50%");
      return;
    }
    const bounds = row.getBoundingClientRect();
    const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    row.style.setProperty("--mobile-press-x", `${x}px`);
    row.style.setProperty("--mobile-press-y", `${y}px`);
  }

  function clearPulse(row) {
    const timerId = timers.get(row);
    if (timerId) {
      window.clearTimeout(timerId);
      timers.delete(row);
    }
    row.classList.remove(ACTIVE_CLASS);
  }

  function pulseRow(row, event) {
    clearPulse(row);
    setPressOrigin(row, event);
    void row.offsetWidth;
    row.classList.add(ACTIVE_CLASS);
    const timerId = window.setTimeout(() => {
      row.classList.remove(ACTIVE_CLASS);
      timers.delete(row);
    }, DURATION_MS);
    timers.set(row, timerId);
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      const row = event.target instanceof Element ? event.target.closest("button.menu-product-row") : null;
      if (!isInteractiveProductRow(row)) return;
      pulseRow(row, event);
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target instanceof Element ? event.target.closest("button.menu-product-row") : null;
      if (!isInteractiveProductRow(row)) return;
      pulseRow(row, null);
    },
    true
  );
})();
