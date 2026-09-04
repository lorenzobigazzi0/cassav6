import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGoldenDataset,
  collectLegacyReferences,
  generateP0Artifacts,
  sha256,
  validateGoldenDataset,
} from "./p0-artifacts.mjs";

const appRoot = path.resolve(import.meta.dirname, "../..");

test("golden dataset covers the required P0 business domains", () => {
  const dataset = buildGoldenDataset();
  const validation = validateGoldenDataset(dataset);

  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(dataset.schemaVersion, 2);
  assert.equal(dataset.datasetId, "v6-postgresql-migration-golden-002");
  assert.equal(dataset.appState.posSettings.priceLists.length, 2);
  assert.equal(dataset.appState.posSettings.priceListSchedules.length, 2);
  assert.equal(dataset.appState.posSettings.menuSchedules.length, 1);
  assert.equal(dataset.appState.posSettings.areaMenus.length, 1);
  assert.equal(dataset.appState.users.length, 2);
  assert.equal(dataset.appState.sessions.length, 3);
  assert.equal(dataset.appState.integration.orders.length, 1);
  assert.equal(dataset.appState.integration.orders[0].items.length, 3);
  assert.equal(dataset.appState.integration.orders[0].discountCents, 50);
  assert.equal(dataset.appState.paymentTransactions.length, 2);
  assert.equal(dataset.appState.payments.length, 2);
  assert.equal(dataset.appState.posReservationStates[0].reservations.length, 1);
  assert.equal(dataset.appState.commercialBenefitCoupons.length, 1);
  assert.equal(dataset.appState.commercialBenefitRedemptions.length, 1);
  assert.equal(dataset.pricingCases.length, 5);
  assert.equal(dataset.expected.pricing.equivalencePercent, 100);
});

for (const regression of [
  {
    name: "missing listini",
    mutate: (dataset) => { dataset.appState.posSettings.priceLists = []; },
    expectedError: /price lists/u,
  },
  {
    name: "missing overnight schedules",
    mutate: (dataset) => {
      dataset.appState.posSettings.priceListSchedules =
        dataset.appState.posSettings.priceListSchedules.filter(
          (schedule) => schedule.id !== "golden_schedule_overnight",
        );
    },
    expectedError: /schedules|overnight/u,
  },
  {
    name: "missing identity sessions",
    mutate: (dataset) => { dataset.appState.sessions = []; },
    expectedError: /sessions/u,
  },
  {
    name: "allergens collapsed into ingredients",
    mutate: (dataset) => {
      for (const item of dataset.appState.menuItems) delete item.allergens;
    },
    expectedError: /allergens/u,
  },
  {
    name: "single-row payment",
    mutate: (dataset) => {
      dataset.appState.paymentParts.length = 1;
      dataset.appState.paymentTransactions.length = 1;
      dataset.appState.payments.length = 1;
    },
    expectedError: /split payment/u,
  },
  {
    name: "inconsistent discounted order",
    mutate: (dataset) => { dataset.appState.integration.orders[0].totalCents += 1; },
    expectedError: /Order gross totals/u,
  },
]) {
  test("golden dataset validation rejects " + regression.name, () => {
    const dataset = buildGoldenDataset();
    regression.mutate(dataset);

    const validation = validateGoldenDataset(dataset);
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join(" "), regression.expectedError);
  });
}

test("golden dataset adapter keeps allergens separate from ingredient labels", () => {
  const dataset = buildGoldenDataset();
  const product = dataset.commercialConfiguration.products.find(
    (entry) => entry.id === dataset.appState.menuItems[1].id,
  );

  assert.deepEqual(product.allergens, ["latte"]);
  assert.deepEqual(product.metadata.legacyIngredientLabels, ["caffe", "latte vaccino"]);
  assert.notDeepEqual(product.allergens, product.metadata.legacyIngredientLabels);
});

test("legacy inventory is scoped to backend sources and marks runtime references", async () => {
  const references = await collectLegacyReferences(appRoot);

  assert.ok(references.some((row) => row.pattern === "readDb(" && row.runtime));
  assert.ok(references.some((row) => row.pattern === "writeDb(" && row.runtime));
  assert.equal(references.some((row) => row.file.includes("node_modules")), false);
});

test("P0 generator writes a checksum-verifiable fixture and evidence files", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "v6-pg-p0-"));
  try {
    const baseline = await generateP0Artifacts({ appRoot, outputDir });
    const dataset = await readFile(path.join(outputDir, "golden-dataset.json"), "utf8");
    const checksum = await readFile(path.join(outputDir, "golden-dataset.sha256"), "utf8");
    const inventory = await readFile(path.join(outputDir, "legacy-storage-inventory.csv"), "utf8");

    assert.equal(checksum, `${sha256(dataset)}  golden-dataset.json\n`);
    assert.match(inventory, /"readDb\("/u);
    assert.equal(baseline.goldenDataset.validation.ok, true);
    assert.equal(baseline.hardware.validForProductionHardwareGate, false);
    assert.equal(baseline.source.sourceArchive.label, "V6.0.0.6.zip");
    assert.match(baseline.source.sourceArchive.sha256, /^[A-F0-9]{64}$/u);
    assert.equal(typeof baseline.runtimeArtifacts.cassaWebRuntimeAvailable, "boolean");
    assert.equal(typeof baseline.runtimeArtifacts.cassaWebRebuildPossible, "boolean");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
