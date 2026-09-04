(function () {
  if (window.__mobileReservationsHeaderBridgeInstalled === true) return;
  window.__mobileReservationsHeaderBridgeInstalled = true;

  var movedButtons = new WeakSet();
  var rafId = 0;

  function markHeader(head) {
    if (!head || head.dataset.mobileReservationsHeaderReady === "1") {
      return;
    }
    head.dataset.mobileReservationsHeaderReady = "1";
  }

  function tuneTitle(title) {
    if (!title) {
      return;
    }
    title.classList.add("mobile-reservations-title");
    var headline = title.querySelector(".h1");
    if (headline) {
      headline.setAttribute("aria-hidden", "true");
    }
    var roomLabel = title.querySelector(".p");
    if (roomLabel) {
      roomLabel.classList.add("mobile-reservations-room-label");
    }
  }

  function tuneDate(dateBox) {
    if (!dateBox) {
      return;
    }
    dateBox.classList.add("mobile-reservations-date-box");
    var label = dateBox.querySelector("span");
    if (label) {
      label.setAttribute("aria-hidden", "true");
    }
  }

  function moveAddButton(card) {
    var head = card.querySelector(".reservations-head");
    var button = card.querySelector(".reservations-add-btn");
    if (!head || !button) {
      return;
    }

    markHeader(head);
    if (head.lastElementChild !== button) {
      head.appendChild(button);
    }

    if (!movedButtons.has(button)) {
      button.dataset.mobileReservationsOriginalLabel = button.textContent || "";
      button.setAttribute("aria-label", "Nuova prenotazione");
      button.setAttribute("title", "Nuova prenotazione");
      movedButtons.add(button);
    }

    button.classList.add("mobile-reservations-add-btn");
    button.textContent = "+";
  }

  function reconcile() {
    rafId = 0;
    var cards = document.querySelectorAll(".reservations-card");
    cards.forEach(function (card) {
      var head = card.querySelector(".reservations-head");
      if (!head) {
        return;
      }
      tuneTitle(head.querySelector(".reservations-head-title"));
      tuneDate(head.querySelector(".reservations-date-display"));
      moveAddButton(card);
    });
  }

  function schedule() {
    if (rafId) {
      return;
    }
    rafId = window.requestAnimationFrame(reconcile);
  }

  var observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }

  window.addEventListener("pageshow", schedule);
})();
