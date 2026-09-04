import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COUNTER_COLLECTION_WRITE_DOMAINS,
  createCounterCollectionWriter,
} from "../modules/counter/counter-collection-writer.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

test("counter collect invia al writer atomico solo gli ID modificati", async () => {
  let atomicRequest = null;
  let fallbackCalls = 0;
  const writer = createCounterCollectionWriter({
    enabled: true,
    atomicSelectionWriter: {
      async write(_db, request) {
        atomicRequest = request;
        return { written: true };
      },
    },
    async writeDb() {
      fallbackCalls += 1;
    },
  });

  await writer(
    {},
    {
      paymentIds: ["pay_1"],
      paymentContainerIds: ["container_1"],
      paymentPartIds: ["part_1"],
      paymentTransactionIds: ["tx_1"],
      commercialBenefitCouponIds: ["coupon_1", "coupon_1"],
      commercialBenefitApplicationIds: ["application_1"],
      commercialBenefitRedemptionIds: ["redemption_1"],
      auditEventIds: ["audit_1", "audit_2"],
    },
  );

  assert.equal(fallbackCalls, 0);
  assert.deepEqual(atomicRequest.auditEventIds, ["audit_1", "audit_2"]);
  assert.deepEqual(
    atomicRequest.domainSelection.domainArrayEntries.map((entry) => [
      entry.domain,
      entry.entryIds,
    ]),
    [
      ["payments", ["pay_1"]],
      ["paymentContainers", ["container_1"]],
      ["paymentParts", ["part_1"]],
      ["paymentTransactions", ["tx_1"]],
      ["commercialBenefitCoupons", ["coupon_1"]],
      ["commercialBenefitApplications", ["application_1"]],
      ["commercialBenefitRedemptions", ["redemption_1"]],
    ],
  );
});

test("counter collect conserva il fallback completo quando il fast path e' OFF", async () => {
  let fallbackOptions = null;
  const writer = createCounterCollectionWriter({
    enabled: false,
    async writeDb(_db, options) {
      fallbackOptions = options;
    },
  });

  await writer({}, { paymentIds: ["pay_1"] });

  assert.equal(fallbackOptions.metricLabel, "counter.collect.appStateWrite");
  assert.deepEqual(fallbackOptions.splitDomains, COUNTER_COLLECTION_WRITE_DOMAINS);
});

test("counter collect rende osservabile un errore del writer atomico", async () => {
  const counters = [];
  const writer = createCounterCollectionWriter({
    enabled: true,
    atomicSelectionWriter: {
      async write() {
        throw new Error("mysql unavailable");
      },
    },
    runtimeMetrics: {
      incrementCounter(name) {
        counters.push(name);
      },
    },
  });

  await assert.rejects(
    writer({}, { paymentIds: ["pay_1"] }),
    /mysql unavailable/,
  );
  assert.deepEqual(counters, ["counterCollectionAtomicErrors"]);
});

test("server inietta il writer atomico nel factory del Banco", () => {
  const source = readFileSync(path.join(testDir, "..", "server.js"), "utf8");
  const usersFactoryStart = source.indexOf(
    "const usersHandlers = createUsersHandlers({",
  );
  const usersFactoryEnd = source.indexOf("\n});", usersFactoryStart);
  assert.ok(usersFactoryStart >= 0 && usersFactoryEnd > usersFactoryStart);
  assert.match(
    source,
    /const counterHandlers = createCounterHandlers\(\{[\s\S]*?validateSessionContext,\s*writeCounterCollectionDb,\s*writeDb,\s*\}\);/,
  );
  assert.doesNotMatch(
    source.slice(usersFactoryStart, usersFactoryEnd),
    /writeCounterCollectionDb/,
  );
});
