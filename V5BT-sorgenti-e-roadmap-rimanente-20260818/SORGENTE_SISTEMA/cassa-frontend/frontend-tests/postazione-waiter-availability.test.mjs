import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveOrderWaiterAvailability } from "../../postazione/src/waiterAvailability.js";

const appSource = readFileSync(new URL("../../postazione/src/App.jsx", import.meta.url), "utf8");

test("[FE][P1] disponibilita cameriere non limita comande senza identita assegnata", () => {
  assert.deepEqual(resolveOrderWaiterAvailability({ id: "1" }, []), {
    required: false,
    available: true,
    waiter: null,
  });
});

test("[FE][P1] disponibilita cameriere abbina id username e nome normalizzato", () => {
  const waiters = [{
    userId: "u-giada",
    username: "Giada",
    name: "Giada Imperato",
    online: true,
    activeNow: true,
  }];

  assert.equal(resolveOrderWaiterAvailability({ waiterUserId: "u-giada" }, waiters).available, true);
  assert.equal(resolveOrderWaiterAvailability({ createdByUsername: " giada " }, waiters).available, true);
  assert.equal(resolveOrderWaiterAvailability({ waiter: "GIADA   IMPERATO" }, waiters).available, true);
});

test("[FE][P1] disponibilita cameriere richiede presenza online e attiva", () => {
  const order = { createdByUserId: "u-giada", waiter: "Giada Imperato" };

  assert.equal(resolveOrderWaiterAvailability(order, []).available, false);
  assert.equal(resolveOrderWaiterAvailability(order, [{ userId: "u-giada", online: false, activeNow: true }]).available, false);
  assert.equal(resolveOrderWaiterAvailability(order, [{ userId: "u-giada", online: true, activeNow: false }]).available, false);
  assert.equal(resolveOrderWaiterAvailability(order, [{ userId: "u-giada", online: true, activeNow: true }]).available, true);
});

test("[FE][P2] pulsante cameriere offline disegna la diagonale da angolo ad angolo", () => {
  const css = readFileSync(new URL("../../postazione/css/layout.css", import.meta.url), "utf8");
  const buttonRule = css.match(/\.btn-call\.is-waiter-offline\s*\{([^}]+)\}/)?.[1] || "";
  const rule = css.match(/\.btn-call\.is-waiter-offline::after\s*\{([^}]+)\}/)?.[1] || "";

  assert.match(buttonRule, /overflow:\s*hidden;/);
  assert.match(rule, /inset:\s*0;/);
  assert.match(rule, /border-radius:\s*inherit;/);
  assert.match(rule, /clip-path:\s*polygon\(0 calc\(100% - 4px\), 0 100%, 100% 4px, 100% 0\);/);
  assert.doesNotMatch(rule, /linear-gradient/);
  assert.doesNotMatch(rule, /border-radius:\s*999px|box-shadow:/);
});

test("[FE][P2] pulsante chiamata mostra solo la campanella nello stato normale", () => {
  assert.match(appSource, /aria-label=\{callBtnAccessibleLabel\}/);
  assert.match(
    appSource,
    /className=\{\s*selectedTransferredOut\s*\?\s*"fa-solid fa-rotate-left"\s*:\s*"fa-regular fa-bell"\s*\}/s,
  );
  assert.match(
    appSource,
    /\{selectedTransferredOut\s*\?\s*<span>RICHIEDI INDIETRO<\/span>\s*:\s*null\}/s,
  );
  assert.doesNotMatch(appSource, /fa-regular fa-bell[^\n]+\/>\s*CAMERIERE/);
});

test("[FE][P2] stampa e trasferisci sono icon-only e lasciano spazio a pronta", () => {
  const css = readFileSync(new URL("../../postazione/css/layout.css", import.meta.url), "utf8");
  const iconButtonRule = css.match(/\.action-bar \.btn-icon-only\s*\{([^}]+)\}/)?.[1] || "";

  assert.match(appSource, /className="btn btn-print btn-icon-only"/);
  assert.match(appSource, /aria-label="Stampa"/);
  assert.match(
    appSource,
    /<button\s+className="btn btn-print btn-icon-only"[\s\S]*?>\s*<i\s+className="fa-solid fa-print"\s+aria-hidden="true"\s*\/>\s*<\/button>/,
  );
  assert.match(appSource, /className="btn btn-transfer btn-icon-only"/);
  assert.match(appSource, /aria-label="Trasferisci"/);
  assert.match(
    appSource,
    /<button\s+className="btn btn-transfer btn-icon-only"[\s\S]*?>\s*<i\s+className="fa-solid fa-arrow-right-arrow-left"\s+aria-hidden="true"\s*\/>\s*<\/button>/,
  );
  assert.match(iconButtonRule, /flex:\s*0 0 clamp\(72px, 6vw, 88px\);/);
});
