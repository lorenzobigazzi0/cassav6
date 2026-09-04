import assert from "node:assert/strict";
import test from "node:test";
import {
  claimV5btStationWorkflowTarget,
  filterV5btStationWorkflowCandidates,
} from "./v5bt-station-workflow-reservation.mjs";

test("la Postazione esclude dal poll le comande derivate non inventariate", () => {
  const reservedOrderIds = new Set(["00070", "00072"]);
  const candidates = filterV5btStationWorkflowCandidates(
    [
      { id: "00090", workflowStatus: "ready" },
      { id: "00071", workflowStatus: "waiting" },
      { id: "00072", workflowStatus: "prep" },
      { id: "00070", workflowStatus: "waiting" },
    ],
    {
      fallbackOrderId: "00070",
      eligibleOrderIds: new Set(["00070", "00071", "00072"]),
      reservedOrderIds,
    },
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["00071", "00070"],
  );
});

test("la Postazione prenota il target effettivo scelto dal poll", () => {
  const reservedOrderIds = new Set(["00070"]);

  assert.equal(
    claimV5btStationWorkflowTarget({ id: "00071" }, reservedOrderIds),
    "00071",
  );
  assert.deepEqual([...reservedOrderIds], ["00070", "00071"]);
});

test("senza inventario esplicito il filtro conserva il comportamento P5", () => {
  const candidates = filterV5btStationWorkflowCandidates(
    [{ id: "00090" }],
    { reservedOrderIds: new Set() },
  );

  assert.equal(candidates.length, 1);
});
