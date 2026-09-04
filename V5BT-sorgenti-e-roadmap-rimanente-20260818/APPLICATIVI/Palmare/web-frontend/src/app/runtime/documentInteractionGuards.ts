// Moved from the retired src/mobile/installMobileInteractionGuards.ts. Logic is
// unchanged; only encapsulated so a root React hook can mount it once. The
// legacy window-scoped install flags became module-level booleans. Intrinsically
// DOM-global (anti context-menu, selection guard, press feedback).

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

function isEditableTarget(target: EventTarget | null): boolean {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node && target.parentElement instanceof Element
        ? target.parentElement
        : null;
  return Boolean(element?.closest(EDITABLE_SELECTOR));
}

let contextMenuGuardInstalled = false;
let productPressFeedbackInstalled = false;

function installContextMenuGuard() {
  if (contextMenuGuardInstalled === true) return;
  contextMenuGuardInstalled = true;

  if (!document.getElementById("mobile-interaction-lock-style")) {
    const style = document.createElement("style");
    style.id = "mobile-interaction-lock-style";
    style.textContent = [
      "html, body, #root {",
      "  -webkit-touch-callout: none;",
      "  -webkit-user-select: none !important;",
      "  user-select: none !important;",
      "}",
      "body,",
      'body *:not(input):not(textarea):not(select):not([contenteditable=""]):not([contenteditable="true"]) {',
      "  -webkit-touch-callout: none !important;",
      "  -webkit-user-select: none !important;",
      "  user-select: none !important;",
      "  -webkit-user-drag: none !important;",
      "  -webkit-tap-highlight-color: transparent !important;",
      "  touch-action: manipulation;",
      "}",
      'body *:not(input):not(textarea):not(select):not([contenteditable=""]):not([contenteditable="true"])::selection {',
      "  background: transparent !important;",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }

  const preventNonEditableSelection = (event: Event) => {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const clearSelectionOutsideEditors = () => {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!selection || selection.isCollapsed) return;
    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : (selection.anchorNode?.parentElement ?? null);
    const focusElement =
      selection.focusNode instanceof Element
        ? selection.focusNode
        : (selection.focusNode?.parentElement ?? null);
    if (isEditableTarget(anchorElement) || isEditableTarget(focusElement)) return;
    selection.removeAllRanges();
  };

  const blockRightClick = (event: MouseEvent) => {
    if (event.button !== 2 && event.which !== 3) return;
    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  document.addEventListener("mousedown", blockRightClick, true);
  document.addEventListener("mouseup", blockRightClick, true);
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  document.addEventListener(
    "auxclick",
    (event) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  document.addEventListener("selectstart", preventNonEditableSelection, true);
  document.addEventListener("dragstart", preventNonEditableSelection, true);
  document.addEventListener("selectionchange", clearSelectionOutsideEditors, true);
  document.addEventListener("touchstart", clearSelectionOutsideEditors, true);
  document.addEventListener("touchmove", clearSelectionOutsideEditors, true);
  document.addEventListener("touchend", clearSelectionOutsideEditors, true);
  document.addEventListener("touchcancel", clearSelectionOutsideEditors, true);
  document.addEventListener("pointerdown", clearSelectionOutsideEditors, true);
  document.addEventListener("pointerup", clearSelectionOutsideEditors, true);
  document.addEventListener("pointercancel", clearSelectionOutsideEditors, true);
}

function installProductPressFeedback() {
  if (productPressFeedbackInstalled === true) return;
  productPressFeedbackInstalled = true;

  const activeClass = "is-press-feedback";
  const durationMs = 360;
  const timers = new WeakMap<HTMLButtonElement, number>();

  const isInteractiveProductRow = (row: Element | null): row is HTMLButtonElement =>
    row instanceof HTMLButtonElement &&
    row.matches("button.menu-product-row") &&
    row.disabled !== true &&
    !row.classList.contains("is-global-terminated");

  const setPressOrigin = (row: HTMLButtonElement, event: PointerEvent | null) => {
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
  };

  const clearPulse = (row: HTMLButtonElement) => {
    const timerId = timers.get(row);
    if (timerId) {
      window.clearTimeout(timerId);
      timers.delete(row);
    }
    row.classList.remove(activeClass);
  };

  const pulseRow = (row: HTMLButtonElement, event: PointerEvent | null) => {
    clearPulse(row);
    setPressOrigin(row, event);
    void row.offsetWidth;
    row.classList.add(activeClass);
    const timerId = window.setTimeout(() => {
      row.classList.remove(activeClass);
      timers.delete(row);
    }, durationMs);
    timers.set(row, timerId);
  };

  document.addEventListener(
    "pointerdown",
    (event) => {
      const row =
        event.target instanceof Element ? event.target.closest("button.menu-product-row") : null;
      if (!isInteractiveProductRow(row)) return;
      pulseRow(row, event);
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row =
        event.target instanceof Element ? event.target.closest("button.menu-product-row") : null;
      if (!isInteractiveProductRow(row)) return;
      pulseRow(row, null);
    },
    true
  );
}

export function installDocumentInteractionGuards() {
  installContextMenuGuard();
  installProductPressFeedback();
}
