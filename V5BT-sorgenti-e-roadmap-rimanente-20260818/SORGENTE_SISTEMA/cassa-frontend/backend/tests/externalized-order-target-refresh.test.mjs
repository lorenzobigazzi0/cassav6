import assert from "node:assert/strict";
import test from "node:test";

import { refreshExternalizedIntegrationOrderTarget } from "../modules/orders/externalized-order-target-refresh.js";

test("refresh ordine target sostituisce solo la comanda richiesta", async () => {
  const db = {
    integration: {
      orders: [
        { id: "00041", workflowStatus: "prep" },
        { id: "00042", workflowStatus: "prep" },
      ],
    },
  };
  const counters = [];
  const result = await refreshExternalizedIntegrationOrderTarget(
    db,
    { refreshExternalizedIntegrationOrderId: "42" },
    {
      repository: {
        enabled: true,
        async readObjectArrayEntry(_domain, _field, candidate) {
          return candidate === "00042"
            ? { id: "00042", workflowStatus: "ready" }
            : null;
        },
      },
      buildLookupCandidates: () => ["42", "00042"],
      findOrderIndex: (orders, id) =>
        orders.findIndex((order) => Number(order.id) === Number(id)),
      incrementCounter: (name) => counters.push(name),
    },
  );

  assert.equal(result, db);
  assert.equal(result.integration.orders[0].workflowStatus, "prep");
  assert.equal(result.integration.orders[1].workflowStatus, "ready");
  assert.deepEqual(counters, ["orderTargetRefreshHits"]);
});

test("refresh ordine target lascia la cache invariata quando il record non esiste", async () => {
  const order = { id: "00043", workflowStatus: "prep" };
  const db = { integration: { orders: [order] } };
  const counters = [];
  await refreshExternalizedIntegrationOrderTarget(
    db,
    { refreshExternalizedIntegrationOrderId: "00043" },
    {
      repository: {
        enabled: true,
        async readObjectArrayEntry() {
          return null;
        },
      },
      buildLookupCandidates: (id) => [id],
      incrementCounter: (name) => counters.push(name),
    },
  );

  assert.equal(db.integration.orders[0], order);
  assert.deepEqual(counters, ["orderTargetRefreshMisses"]);
});
