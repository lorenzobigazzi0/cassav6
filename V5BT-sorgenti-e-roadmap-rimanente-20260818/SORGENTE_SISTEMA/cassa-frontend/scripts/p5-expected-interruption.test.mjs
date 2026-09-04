import assert from "node:assert/strict";
import test from "node:test";

import { createExpectedInterruptionRequestTracker } from "./p5-expected-interruption.mjs";

test("mantiene attesa una richiesta iniziata durante il blackout anche dopo il ripristino", () => {
  let interrupted = true;
  const tracker = createExpectedInterruptionRequestTracker(() => interrupted);
  const request = {};

  tracker.observe(request);
  interrupted = false;

  assert.equal(tracker.includes(request), true);
});

test("non classifica come attese le richieste iniziate dopo il ripristino", () => {
  const tracker = createExpectedInterruptionRequestTracker(() => false);
  const request = {};

  tracker.observe(request);

  assert.equal(tracker.includes(request), false);
});

test("rifiuta un predicato di interruzione non valido", () => {
  assert.throws(
    () => createExpectedInterruptionRequestTracker(null),
    /isExpectedInterruption deve essere una funzione/,
  );
});
