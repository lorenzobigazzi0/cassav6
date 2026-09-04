import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticCashSplitGuard } from "../db/app-state/automatic-cash-split-guard.js";

function harness() {
  const calls = [];
  let current = { cashFloats: [{ cashFloatId: "FCA-current" }] };
  const repository = {
    enabled: true,
    readObjectEntry: async () => structuredClone(current),
    syncObjectEntryFromAppState: async (db, domain, field) => {
      calls.push({ domain, field });
      current = structuredClone(db.posSettings.automaticCash);
    },
  };
  return {
    calls,
    guard: createAutomaticCashSplitGuard({
      repository,
      cloneJson: (value) => structuredClone(value),
    }),
  };
}

test("automatic cash split guard rinfresca la cache anche per domini non posSettings", async () => {
  const { guard } = harness();
  const state = { posSettings: { automaticCash: { cashFloats: [] } } };
  const decision = await guard.beforeDomainSync({
    selectedDomains: new Set(["integration"]),
    requestRoute: "POST /api/integration/notifications/publish",
  });
  assert.equal(decision.refresh, true);
  assert.equal(decision.preserve, false);
  assert.deepEqual(decision.syncOptions, {});
  await guard.afterDomainSync({ guard: decision, states: [state] });
  assert.equal(state.posSettings.automaticCash.cashFloats[0].cashFloatId, "FCA-current");
});

test("automatic cash split guard idrata la state machine prima di ogni operazione", async () => {
  const { guard } = harness();
  const state = { posSettings: { automaticCash: { cashFloats: [] } } };
  await guard.refreshState(state);
  assert.equal(state.posSettings.automaticCash.cashFloats[0].cashFloatId, "FCA-current");
});

test("automatic cash split guard preserva la row durante sync posSettings", async () => {
  const { guard } = harness();
  const decision = await guard.beforeDomainSync({
    selectedDomains: new Set(["posSettings"]),
    requestRoute: "POST /api/payments/free-split",
  });
  assert.equal(decision.preserve, true);
  assert.deepEqual(decision.syncOptions, {
    preserveObjectEntriesByDomain: { posSettings: ["automaticCash"] },
  });
});

test("automatic cash split guard scrive solo la entry dedicata in MySQL", async () => {
  const { calls, guard } = harness();
  let fallbackWrites = 0;
  const db = { posSettings: { automaticCash: { cashFloats: [{ cashFloatId: "FCA-next" }] } } };
  await guard.writeEntry(db, {
    dbMode: "mysql",
    writeDb: async () => { fallbackWrites += 1; },
  });
  assert.deepEqual(calls, [{ domain: "posSettings", field: "automaticCash" }]);
  assert.equal(fallbackWrites, 0);
});
