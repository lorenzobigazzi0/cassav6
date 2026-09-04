(function mobileOrderPaymentLayoutFixBootstrap() {
  if (window.__mobileOrderPaymentLayoutFixInitialized) {
    return;
  }

  window.__mobileOrderPaymentLayoutFixInitialized = true;

  var FIELD_SELECTOR = "label.table-detail-field";
  var INPUT_SELECTOR = 'input[name="custom_amount"]';
  var NOTE_ROW_SELECTOR = ".table-payment-note-row";
  var NOTE_BUTTON_SELECTOR = ".table-payment-note-btn";
  var POLL_MS = 1200;
  var observer = null;
  var pollTimer = null;
  var syncScheduled = false;
  var selfMutating = false;

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getAmountField() {
    var fields = document.querySelectorAll(FIELD_SELECTOR);
    for (var index = 0; index < fields.length; index += 1) {
      var field = fields[index];
      if (field.querySelector(INPUT_SELECTOR)) {
        return field;
      }
    }
    return null;
  }

  function ensureControlsRow(field, input) {
    var controls = field.querySelector(".mobile-payment-inline-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "mobile-payment-inline-controls";
      field.appendChild(controls);
    }

    if (input.parentElement !== controls) {
      controls.appendChild(input);
    }

    return controls;
  }

  function addClassOnce(element, className) {
    if (!element.classList.contains(className)) {
      element.classList.add(className);
    }
  }

  function removeClassOnce(element, className) {
    if (element.classList.contains(className)) {
      element.classList.remove(className);
    }
  }

  function setAttributeOnce(element, name, value) {
    if (element.getAttribute(name) !== value) {
      element.setAttribute(name, value);
    }
  }

  function removeAttributeOnce(element, name) {
    if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }

  function syncNoteButton(field, controls) {
    if (!isElement(field) || !isElement(controls)) {
      return;
    }

    var scope = field.parentElement;
    if (!isElement(scope)) {
      return;
    }

    var noteRow = scope.querySelector(NOTE_ROW_SELECTOR);
    if (!isElement(noteRow)) {
      return;
    }

    var noteButton = noteRow.querySelector(NOTE_BUTTON_SELECTOR);
    if (!isElement(noteButton)) {
      return;
    }

    addClassOnce(noteButton, "mobile-payment-inline-note");
    if (noteButton.parentElement !== controls) {
      controls.appendChild(noteButton);
    }

    setAttributeOnce(noteRow, "data-inline-hidden", "1");
    setAttributeOnce(noteRow, "aria-hidden", "true");
  }

  function syncAmountField() {
    var field = getAmountField();
    if (!isElement(field)) {
      return;
    }

    var input = field.querySelector(INPUT_SELECTOR);
    if (!isElement(input)) {
      return;
    }

    addClassOnce(field, "mobile-payment-inline-field");

    var label = field.querySelector("span");
    var labelText = textOf(label);
    var isOrderTotal = /totale ordine/i.test(labelText);

    if (isOrderTotal && isElement(label)) {
      if (label.textContent !== "Totale ordine") {
        label.textContent = "Totale ordine";
      }
    }

    var controls = ensureControlsRow(field, input);
    syncNoteButton(field, controls);

    if (isOrderTotal) {
      if (!input.readOnly) {
        input.readOnly = true;
      }
      setAttributeOnce(input, "readonly", "readonly");
      setAttributeOnce(input, "aria-readonly", "true");
      addClassOnce(input, "is-readonly");
    } else {
      if (input.readOnly) {
        input.readOnly = false;
      }
      removeAttributeOnce(input, "readonly");
      removeAttributeOnce(input, "aria-readonly");
      removeClassOnce(input, "is-readonly");
    }
  }

  function scheduleSync() {
    if (syncScheduled) {
      return;
    }
    syncScheduled = true;
    window.requestAnimationFrame(function () {
      syncScheduled = false;
      selfMutating = true;
      try {
        syncAmountField();
      } finally {
        window.setTimeout(function () {
          selfMutating = false;
        }, 0);
      }
    });
  }

  function start() {
    scheduleSync();

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(function () {
      if (selfMutating) {
        return;
      }
      scheduleSync();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
    }

    pollTimer = window.setInterval(function () {
      if (!document.hidden) {
        syncAmountField();
      }
    }, POLL_MS);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        scheduleSync();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

(function mobileFreeTableModalStabilizer() {
  if (window.__mobileFreeTableModalStabilizerInitialized) {
    return;
  }

  window.__mobileFreeTableModalStabilizerInitialized = true;

  var FREE_BUTTON_SELECTOR = ".table-detail-bottom-btn-free";
  var FREE_BACKDROP_SELECTOR = ".table-free-confirm-backdrop";
  var FREE_CARD_SELECTOR = ".table-free-confirm-card";
  var openingTimer = 0;

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function markOpening() {
    document.body.classList.add("mobile-free-confirm-opening");
    window.clearTimeout(openingTimer);
    openingTimer = window.setTimeout(function () {
      document.body.classList.remove("mobile-free-confirm-opening");
    }, 420);
  }

  function stabilizeModal() {
    var backdrop = document.querySelector(FREE_BACKDROP_SELECTOR);
    if (isElement(backdrop)) {
      backdrop.setAttribute("data-mobile-free-stable", "1");
      backdrop.style.animation = "none";
      backdrop.style.transition = "none";
      backdrop.style.opacity = "1";
    }
    var card = document.querySelector(FREE_CARD_SELECTOR);
    if (isElement(card)) {
      card.setAttribute("data-mobile-free-stable", "1");
      card.style.animation = "none";
      card.style.transition = "none";
    }
  }

  document.addEventListener(
    "pointerdown",
    function (event) {
      var target = event.target;
      if (!isElement(target)) return;
      var button = target.closest(FREE_BUTTON_SELECTOR);
      if (!isElement(button)) return;
      if (typeof button.blur === "function") {
        button.blur();
      }
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!isElement(target)) return;
      var button = target.closest(FREE_BUTTON_SELECTOR);
      if (!isElement(button)) return;
      window.setTimeout(markOpening, 0);
      window.requestAnimationFrame(function () {
        markOpening();
        stabilizeModal();
      });
      window.setTimeout(stabilizeModal, 40);
    },
    true
  );

  var observer = new MutationObserver(function () {
    stabilizeModal();
    if (!document.querySelector(FREE_BACKDROP_SELECTOR)) {
      document.body.classList.remove("mobile-free-confirm-opening");
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    stabilizeModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

(function mobilePaymentConfirmFeedbackBootstrap() {
  if (window.__mobilePaymentConfirmFeedbackInitialized) {
    return;
  }

  window.__mobilePaymentConfirmFeedbackInitialized = true;

  var CONFIRM_SELECTOR = ".table-payment-confirm";
  var RECEIPT_SELECTOR = ".table-payment-receipt-card";
  var PANEL_SELECTOR = ".table-payment-panel";
  var pendingButton = null;
  var pendingStartedAt = 0;
  var observer = null;

  function isElement(value) {
    return value instanceof HTMLElement;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isReceiptConfirm(button) {
    if (!isElement(button) || !button.matches(CONFIRM_SELECTOR)) return false;
    var label = normalizeText(button.textContent).toLowerCase();
    return label === "conferma pagamento" || label === "confermo e stampo...";
  }

  function setPending(button) {
    if (!isReceiptConfirm(button)) return;
    pendingButton = button;
    pendingStartedAt = Date.now();
    if (!button.hasAttribute("data-mobile-confirm-original-label")) {
      button.setAttribute("data-mobile-confirm-original-label", normalizeText(button.textContent) || "Conferma pagamento");
    }
    button.classList.add("is-mobile-confirm-pending");
    button.textContent = "Confermo e stampo...";
  }

  function clearPending(button) {
    var target = button || pendingButton;
    if (isElement(target)) {
      target.classList.remove("is-mobile-confirm-pending");
      var original = target.getAttribute("data-mobile-confirm-original-label");
      if (original && normalizeText(target.textContent) === "Confermo e stampo...") {
        target.textContent = original;
      }
      target.removeAttribute("data-mobile-confirm-original-label");
    }
    if (!button || button === pendingButton) {
      pendingButton = null;
      pendingStartedAt = 0;
    }
  }

  function syncPending() {
    if (!pendingButton) return;
    if (!document.body.contains(pendingButton) || !document.querySelector(PANEL_SELECTOR)) {
      clearPending();
      return;
    }
    if (!pendingButton.disabled && Date.now() - pendingStartedAt > 250) {
      clearPending();
      return;
    }
    if (normalizeText(pendingButton.textContent) !== "Confermo e stampo...") {
      pendingButton.textContent = "Confermo e stampo...";
    }
  }

  function pulse(button) {
    if (!isElement(button)) return;
    button.classList.add("is-mobile-pressing");
    window.setTimeout(function () {
      button.classList.remove("is-mobile-pressing");
    }, 180);
  }

  document.addEventListener(
    "pointerdown",
    function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      var button = target.closest(CONFIRM_SELECTOR + ", " + RECEIPT_SELECTOR);
      if (button instanceof HTMLElement) pulse(button);
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      var button = target.closest(CONFIRM_SELECTOR);
      if (button instanceof HTMLElement && isReceiptConfirm(button) && button.disabled !== true) {
        setPending(button);
      }
    },
    true
  );

  observer = new MutationObserver(syncPending);
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "class"] });
      },
      { once: true }
    );
  } else {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "class"] });
  }

  window.setInterval(function () {
    if (!document.hidden) syncPending();
  }, 250);
})();

(function mobileRomanSplitPeopleModalBootstrap() {
  if (window.__mobileRomanSplitPeopleModalInitialized) {
    return;
  }

  window.__mobileRomanSplitPeopleModalInitialized = true;

  var MODAL_ID = "mobile-roman-split-people-modal";
  var ROMAN_BUTTON_SELECTOR = "button.table-payment-mode-card";
  var PEOPLE_INPUT_SELECTOR = 'input[name="roman_people"]';
  var MIN_PEOPLE = 2;
  var MAX_PEOPLE = 999;
  var bypassNextRomanClick = false;
  var pendingRomanButton = null;
  var selectedPeople = MIN_PEOPLE;

  function isElement(value) {
    return value instanceof Element;
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clampPeople(value) {
    var numeric = Math.trunc(Number(value) || 0);
    if (numeric < MIN_PEOPLE) {
      return MIN_PEOPLE;
    }
    if (numeric > MAX_PEOPLE) {
      return MAX_PEOPLE;
    }
    return numeric;
  }

  function getModal() {
    return document.getElementById(MODAL_ID);
  }

  function isRomanModeButton(button) {
    if (!isElement(button) || !button.matches(ROMAN_BUTTON_SELECTOR)) {
      return false;
    }

    return normalizeText(button.textContent).toLowerCase() === "alla romana";
  }

  function getPaymentPanel(fromElement) {
    if (isElement(fromElement)) {
      var closestPanel = fromElement.closest(".table-payment-panel");
      if (isElement(closestPanel)) {
        return closestPanel;
      }
    }

    return document.querySelector(".table-payment-panel");
  }

  function getDefaultPeople(button) {
    var panel = getPaymentPanel(button);
    var input = panel ? panel.querySelector(PEOPLE_INPUT_SELECTOR) : null;
    var inputValue = input && String(input.value || "").replace(/\D/g, "");
    if (inputValue && Number(inputValue) >= MIN_PEOPLE) {
      return clampPeople(inputValue);
    }

    var text = panel ? normalizeText(panel.textContent) : "";
    var coversMatch = text.match(/(\d{1,3})\s+copert/i);
    if (coversMatch && Number(coversMatch[1]) >= MIN_PEOPLE) {
      return clampPeople(coversMatch[1]);
    }

    return MIN_PEOPLE;
  }

  function setNativeInputValue(input, value) {
    var prototype = Object.getPrototypeOf(input);
    var descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")
      : null;

    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
  }

  function updateModalCount() {
    var modal = getModal();
    if (!modal) {
      return;
    }

    var input = modal.querySelector('[data-roman-people-input="1"]');
    if (input && input.value !== String(selectedPeople)) {
      input.value = String(selectedPeople);
    }
  }

  function setModalError(message) {
    var modal = getModal();
    if (!modal) {
      return;
    }

    var error = modal.querySelector("[data-roman-error]");
    if (!error) {
      return;
    }

    error.textContent = message || "";
    error.hidden = !message;
  }

  function closeModal() {
    var modal = getModal();
    if (modal) {
      modal.remove();
    }
    pendingRomanButton = null;
  }

  function renderModal() {
    var existing = getModal();
    if (existing) {
      existing.remove();
    }

    var modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = "mobile-roman-split-modal-backdrop";
    modal.setAttribute("role", "presentation");
    modal.innerHTML =
      '<div class="mobile-roman-split-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-roman-split-title">' +
        '<div class="mobile-roman-split-modal-head">' +
          '<div>' +
            '<span class="mobile-roman-split-kicker">Alla romana</span>' +
            '<strong id="mobile-roman-split-title">Persone</strong>' +
          '</div>' +
          '<button type="button" class="mobile-roman-split-close" data-roman-action="close" aria-label="Chiudi">x</button>' +
        '</div>' +
        '<label class="mobile-roman-split-field">' +
          '<span>Dividi per</span>' +
          '<div class="mobile-roman-split-stepper">' +
            '<button type="button" data-roman-action="decrease" aria-label="Diminuisci">-</button>' +
            '<input data-roman-people-input="1" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" value="' + selectedPeople + '" />' +
            '<button type="button" data-roman-action="increase" aria-label="Aumenta">+</button>' +
          '</div>' +
        '</label>' +
        '<div class="mobile-roman-split-presets" aria-label="Scelte rapide">' +
          '<button type="button" data-roman-preset="2">2</button>' +
          '<button type="button" data-roman-preset="3">3</button>' +
          '<button type="button" data-roman-preset="4">4</button>' +
          '<button type="button" data-roman-preset="5">5</button>' +
          '<button type="button" data-roman-preset="6">6</button>' +
        '</div>' +
        '<p class="mobile-roman-split-error" data-roman-error hidden></p>' +
        '<div class="mobile-roman-split-actions">' +
          '<button type="button" class="mobile-roman-split-secondary" data-roman-action="close">Annulla</button>' +
          '<button type="button" class="mobile-roman-split-primary" data-roman-action="confirm">Continua</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    updateModalCount();

    window.setTimeout(function () {
      var input = modal.querySelector('[data-roman-people-input="1"]');
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      }
    }, 30);
  }

  function openModal(button) {
    pendingRomanButton = button;
    selectedPeople = getDefaultPeople(button);
    renderModal();
  }

  function findContinueButton() {
    var panel = getPaymentPanel();
    var buttons = panel
      ? panel.querySelectorAll("button")
      : document.querySelectorAll("button");

    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (normalizeText(button.textContent).toLowerCase() === "continua") {
        return button;
      }
    }

    return null;
  }

  function applyPeopleToRomanStep(people, attemptsLeft) {
    var input = document.querySelector(PEOPLE_INPUT_SELECTOR);
    if (!input) {
      if (attemptsLeft > 0) {
        window.setTimeout(function () {
          applyPeopleToRomanStep(people, attemptsLeft - 1);
        }, 40);
      }
      return;
    }

    setNativeInputValue(input, String(people));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    window.setTimeout(function () {
      var continueButton = findContinueButton();
      if (continueButton && document.contains(continueButton)) {
        continueButton.click();
      }
    }, 90);
  }

  function confirmModal() {
    selectedPeople = clampPeople(selectedPeople);
    if (selectedPeople < MIN_PEOPLE) {
      setModalError("Inserisci almeno 2 persone.");
      return;
    }

    var button = pendingRomanButton;
    closeModal();
    if (!button || !document.contains(button)) {
      return;
    }

    bypassNextRomanClick = true;
    button.click();
    applyPeopleToRomanStep(selectedPeople, 20);
  }

  function handleModalAction(target) {
    var actionButton = target.closest("[data-roman-action]");
    if (!actionButton) {
      return;
    }

    var action = actionButton.getAttribute("data-roman-action");
    if (action === "close") {
      closeModal();
      return;
    }

    if (action === "increase") {
      selectedPeople = clampPeople(selectedPeople + 1);
      setModalError("");
      updateModalCount();
      return;
    }

    if (action === "decrease") {
      selectedPeople = clampPeople(selectedPeople - 1);
      setModalError("");
      updateModalCount();
      return;
    }

    if (action === "confirm") {
      confirmModal();
    }
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!isElement(target)) {
        return;
      }

      var modal = getModal();
      if (modal && target === modal) {
        event.preventDefault();
        closeModal();
        return;
      }

      if (modal && modal.contains(target)) {
        var preset = target.closest("[data-roman-preset]");
        if (preset && modal.contains(preset)) {
          event.preventDefault();
          selectedPeople = clampPeople(preset.getAttribute("data-roman-preset"));
          setModalError("");
          updateModalCount();
          return;
        }

        if (target.closest("[data-roman-action]")) {
          event.preventDefault();
          handleModalAction(target);
        }
        return;
      }

      var romanButton = target.closest(ROMAN_BUTTON_SELECTOR);
      if (!isRomanModeButton(romanButton)) {
        return;
      }

      if (bypassNextRomanClick) {
        bypassNextRomanClick = false;
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      openModal(romanButton);
    },
    true
  );

  document.addEventListener(
    "input",
    function (event) {
      var target = event.target;
      var modal = getModal();
      if (!modal || !isElement(target) || !modal.contains(target)) {
        return;
      }

      if (!target.matches('[data-roman-people-input="1"]')) {
        return;
      }

      var value = String(target.value || "").replace(/\D/g, "").slice(0, 3);
      target.value = value;
      selectedPeople = clampPeople(value);
      setModalError("");
    },
    true
  );

  document.addEventListener("keydown", function (event) {
    var modal = getModal();
    if (!modal) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      confirmModal();
    }
  });
})();
