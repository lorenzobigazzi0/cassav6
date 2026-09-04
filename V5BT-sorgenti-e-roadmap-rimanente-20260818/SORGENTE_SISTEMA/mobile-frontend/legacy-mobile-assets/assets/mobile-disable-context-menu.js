(function () {
  if (window.__mobileDisableContextMenuInstalled === true) return;
  window.__mobileDisableContextMenuInstalled = true;

  function isEditableTarget(target) {
    const element =
      target instanceof Element
        ? target
        : target && target.parentElement instanceof Element
          ? target.parentElement
          : null;
    if (!element) return false;
    return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  function injectInteractionLockStyle() {
    if (document.getElementById("mobile-interaction-lock-style")) return;
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

  function preventNonEditableSelection(event) {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function clearSelectionOutsideEditors() {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!selection || selection.isCollapsed) return;
    const anchorElement =
      selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement ?? null;
    const focusElement =
      selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement ?? null;
    if (isEditableTarget(anchorElement) || isEditableTarget(focusElement)) return;
    selection.removeAllRanges();
  }

  function blockRightClick(event) {
    if (event.button === 2 || event.which === 3) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  injectInteractionLockStyle();

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
      if (event.button === 2) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
  document.addEventListener(
    "auxclick",
    (event) => {
      if (event.button === 2) {
        event.preventDefault();
        event.stopPropagation();
      }
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
})();
