(function () {
  if (window.__postazioneDisableContextMenuInstalled === true) return;
  window.__postazioneDisableContextMenuInstalled = true;

  function block(event) {
    if (!event) return false;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    return false;
  }

  document.addEventListener(
    "contextmenu",
    function (event) {
      block(event);
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (event) {
      if (!event) return;
      const key = String(event.key || "").toLowerCase();
      if (key === "contextmenu" || (event.shiftKey && key === "f10")) {
        block(event);
      }
    },
    true
  );
})();
