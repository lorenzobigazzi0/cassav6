import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntegrationOrderLineSignature,
  nextIntegrationOrderLineId,
} from "../modules/orders/order-lines.js";

test("buildIntegrationOrderLineSignature normalizza i campi distintivi della riga", () => {
  assert.equal(
    buildIntegrationOrderLineSignature({
      name: "  Gin Tonic  ",
      variant: " Premium ",
      note: "  Poco ghiaccio ",
      unitPriceApplied: 8,
      listPriceAtTime: 10,
      routeStations: ["BAR-1", "BAR-2"],
    }),
    "Gin Tonic||Premium||Poco ghiaccio||8||10||BAR-1|BAR-2"
  );
});

test("buildIntegrationOrderLineSignature usa fallback compatibili per campi mancanti", () => {
  assert.equal(buildIntegrationOrderLineSignature({}), "||||||0||0||");
});

test("nextIntegrationOrderLineId incrementa il massimo numerico con padding a quattro cifre", () => {
  assert.equal(
    nextIntegrationOrderLineId({
      items: [
        { lineId: "line_0001" },
        { lineId: "line_0012" },
        { lineId: "line_0007" },
      ],
    }),
    "line_0013"
  );
});

test("nextIntegrationOrderLineId ignora righe senza parte numerica valida", () => {
  assert.equal(
    nextIntegrationOrderLineId({
      items: [
        { lineId: "line_x" },
        { lineId: "" },
        { lineId: null },
      ],
    }),
    "line_0001"
  );
});
