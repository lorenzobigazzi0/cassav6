import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderCorrectionReadModel,
  hasOrderCorrectionReadModel,
  shouldPreferRelationalOrderCorrectionReadModel,
} from "../modules/integration/order-correction-read-model.js";

test("MP-4ao read model correzioni rileva righe barrate e lastCorrectionId", () => {
  const order = {
    id: "00077",
    revision: 2,
    lastCorrectionId: "corr_1",
    items: [
      { lineId: "l1", productName: "Caffe" },
      {
        lineId: "l2",
        productName: "Acqua",
        voidedAt: "2026-07-05T01:10:00.000Z",
        correctionStatus: "removed",
        correctionId: "corr_1",
      },
    ],
  };

  const model = buildOrderCorrectionReadModel(order);

  assert.equal(hasOrderCorrectionReadModel(order), true);
  assert.equal(model.hasCorrections, true);
  assert.equal(model.lastCorrectionId, "corr_1");
  assert.equal(model.correctedItemCount, 1);
  assert.deepEqual(model.markers[0], {
    lineId: "l2",
    correctionId: "corr_1",
    correctionStatus: "removed",
    voidedAt: "2026-07-05T01:10:00.000Z",
  });
});

test("MP-4ao read model correzioni preferisce il relazionale a pari revisione se conserva marcatori visuali", () => {
  const appOrder = {
    id: "00077",
    revision: 2,
    currentRevision: 2,
    items: [{ lineId: "l1", productName: "Caffe" }],
  };
  const relationalOrder = {
    id: "00077",
    revision: 2,
    currentRevision: 2,
    lastCorrectionId: "corr_1",
    items: [
      { lineId: "l1", productName: "Caffe" },
      {
        lineId: "l2",
        productName: "Acqua",
        voidedAt: "2026-07-05T01:10:00.000Z",
        correctionStatus: "removed",
        correctionId: "corr_1",
      },
    ],
  };

  assert.equal(
    shouldPreferRelationalOrderCorrectionReadModel(appOrder, relationalOrder),
    true,
  );
  assert.equal(
    shouldPreferRelationalOrderCorrectionReadModel(relationalOrder, appOrder),
    false,
  );
});
