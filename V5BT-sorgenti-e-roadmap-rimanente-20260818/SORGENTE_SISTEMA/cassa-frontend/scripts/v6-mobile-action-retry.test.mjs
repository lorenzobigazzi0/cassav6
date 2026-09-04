import assert from "node:assert/strict";
import test from "node:test";

import {
  V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS,
  V6_MOBILE_TABLE_LOCK_RETRY_DELAY_MS,
  isV6TransientMobileTableLock,
  runV6MobileBusinessActionRetry,
} from "./v6-mobile-action-retry.mjs";

const baseOptions = (overrides = {}) => ({
  actionType: "order.price_override",
  logicalActionId: "run-1:handheld:1:34:order.price_override",
  idempotencyKey: "load-price-override-stable",
  wait: async () => undefined,
  ...overrides,
});

test("un TABLE_LOCKED transitorio ritenta una volta con identita logica invariata", async () => {
  const contexts = [];
  const waits = [];
  const retries = [];
  const results = [
    { status: 409, body: { code: "TABLE_LOCKED" } },
    { status: 200, body: { ok: true } },
  ];
  const result = await runV6MobileBusinessActionRetry(
    baseOptions({
      attempt: async (context) => {
        contexts.push(context);
        return results[context.attempt - 1];
      },
      wait: async (delayMs) => waits.push(delayMs),
      onRetry: async (detail) => retries.push(detail),
    }),
  );

  assert.equal(result.status, 200);
  assert.equal(contexts.length, 2);
  assert.deepEqual(
    contexts.map(({ actionType, logicalActionId, idempotencyKey }) => ({
      actionType,
      logicalActionId,
      idempotencyKey,
    })),
    [
      {
        actionType: "order.price_override",
        logicalActionId: "run-1:handheld:1:34:order.price_override",
        idempotencyKey: "load-price-override-stable",
      },
      {
        actionType: "order.price_override",
        logicalActionId: "run-1:handheld:1:34:order.price_override",
        idempotencyKey: "load-price-override-stable",
      },
    ],
  );
  assert.deepEqual(waits, [V6_MOBILE_TABLE_LOCK_RETRY_DELAY_MS]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].code, "TABLE_LOCKED");
});

test("un TABLE_LOCKED persistente resta fallimento dopo il limite stretto", async () => {
  let attempts = 0;
  const result = await runV6MobileBusinessActionRetry(
    baseOptions({
      maxAttempts: 99,
      attempt: async () => {
        attempts += 1;
        return { status: 409, body: { code: "TABLE_LOCKED" } };
      },
    }),
  );

  assert.equal(attempts, V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "TABLE_LOCKED");
});

test("gli altri errori HTTP e business non vengono ritentati", async (t) => {
  const cases = [
    { status: 409, body: { code: "REVISION_CONFLICT" } },
    { status: 409, body: { code: "table_locked" } },
    { status: 428, body: { code: "TABLE_LOCK_REQUIRED" } },
    { status: 500, body: { code: "INTERNAL_ERROR" } },
  ];
  for (const expected of cases) {
    await t.test(`${expected.status}/${expected.body.code}`, async () => {
      let attempts = 0;
      const result = await runV6MobileBusinessActionRetry(
        baseOptions({
          attempt: async () => {
            attempts += 1;
            return expected;
          },
          wait: async () => {
            throw new Error("non deve attendere");
          },
        }),
      );
      assert.equal(attempts, 1);
      assert.equal(result, expected);
    });
  }
});

test("il classificatore accetta solo 409 con codice TABLE_LOCKED esatto", () => {
  assert.equal(
    isV6TransientMobileTableLock({
      status: 409,
      body: { code: " TABLE_LOCKED " },
    }),
    true,
  );
  assert.equal(
    isV6TransientMobileTableLock({
      status: 200,
      body: { code: "TABLE_LOCKED" },
    }),
    false,
  );
  assert.equal(
    isV6TransientMobileTableLock({
      status: 409,
      body: { error: "Tavolo bloccato" },
    }),
    false,
  );
});

test("identita logica, chiave e callback mancanti sono rifiutate", async () => {
  await assert.rejects(
    runV6MobileBusinessActionRetry(
      baseOptions({ logicalActionId: "", attempt: async () => ({ status: 200 }) }),
    ),
    /logicalActionId stabile/,
  );
  await assert.rejects(
    runV6MobileBusinessActionRetry(
      baseOptions({ idempotencyKey: "", attempt: async () => ({ status: 200 }) }),
    ),
    /idempotencyKey stabile/,
  );
  await assert.rejects(runV6MobileBusinessActionRetry(baseOptions()), /attempt/);
});
