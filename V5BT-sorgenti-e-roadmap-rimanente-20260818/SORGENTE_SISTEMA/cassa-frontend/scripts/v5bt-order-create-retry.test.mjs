import assert from "node:assert/strict";
import test from "node:test";

import { runV5btOrderCreateRetry } from "./v5bt-order-create-retry.mjs";

test("TABLE_LOCKED e 428 riacquisiscono il lock con la stessa chiave idempotente", async () => {
  const attempts = [];
  const waits = [];
  const results = [
    { status: 409, body: { code: "TABLE_LOCKED" } },
    { status: 428, body: { code: "TABLE_LOCK_REQUIRED" } },
    { status: 200, body: { order: { id: "order-1" } } },
  ];
  const result = await runV5btOrderCreateRetry({
    idempotencyKey: "logical-order-1",
    attempt: async (context) => {
      attempts.push(context);
      return results[context.attempt - 1];
    },
    wait: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(result.body.order.id, "order-1");
  assert.deepEqual(attempts.map((entry) => entry.idempotencyKey), [
    "logical-order-1",
    "logical-order-1",
    "logical-order-1",
  ]);
  assert.deepEqual(waits, [200, 350]);
});

test("un errore non classificato non viene nascosto da retry", async () => {
  let attempts = 0;
  const result = await runV5btOrderCreateRetry({
    idempotencyKey: "logical-order-2",
    attempt: async () => {
      attempts += 1;
      return { status: 500, body: { code: "INTERNAL_ERROR" } };
    },
    wait: async () => {
      throw new Error("non deve attendere");
    },
  });
  assert.equal(result.status, 500);
  assert.equal(attempts, 1);
});

test("il limite tentativi conserva l'ultimo conflitto e non genera duplicati logici", async () => {
  const keys = [];
  const result = await runV5btOrderCreateRetry({
    idempotencyKey: "logical-order-3",
    maxAttempts: 3,
    attempt: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      return { status: 409, body: { code: "TABLE_LOCKED" } };
    },
    wait: async () => undefined,
  });
  assert.equal(result.body.code, "TABLE_LOCKED");
  assert.deepEqual(keys, ["logical-order-3", "logical-order-3", "logical-order-3"]);
});

test("chiave o callback mancanti sono rifiutate prima del primo tentativo", async () => {
  await assert.rejects(
    runV5btOrderCreateRetry({ attempt: async () => ({ status: 200 }) }),
    /idempotencyKey stabile/,
  );
  await assert.rejects(
    runV5btOrderCreateRetry({ idempotencyKey: "logical-order-4" }),
    /attempt deve essere una funzione/,
  );
});
