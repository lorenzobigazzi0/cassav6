import assert from "node:assert/strict";
import test from "node:test";

import { createSingleflight } from "../modules/queue/singleflight.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

test("condivide una sola esecuzione tra chiamate concorrenti", async () => {
  const gate = deferred();
  let starts = 0;
  let joins = 0;
  let calls = 0;
  const run = createSingleflight(
    async () => {
      calls += 1;
      await gate.promise;
      return "ok";
    },
    {
      onStart: () => { starts += 1; },
      onJoin: () => { joins += 1; },
    },
  );
  const first = run();
  const second = run();
  const third = run();
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["ok", "ok", "ok"]);
  assert.equal(calls, 1);
  assert.equal(starts, 1);
  assert.equal(joins, 2);
});

test("dopo successo avvia una nuova esecuzione", async () => {
  let calls = 0;
  const run = createSingleflight(async () => ++calls);
  assert.equal(await run(), 1);
  assert.equal(await run(), 2);
});

test("dopo errore libera il volo e permette retry", async () => {
  let calls = 0;
  const run = createSingleflight(async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return calls;
  });
  await assert.rejects(run(), /boom/);
  assert.equal(await run(), 2);
});
