import assert from "node:assert/strict";
import test from "node:test";

import {
  INVALID_ORDER_STATE_TRANSITION_CODE,
  INVALID_ORDER_STATUS_TRANSITION_CODE,
  applyOrderStateTransition,
  canTransitionOrderState,
  createIntegrationWorkflowStateMachine,
  getIntegrationWorkflowTransitionViolation,
  hasIntegrationRouteReadyProgress,
  hasIntegrationRouteTimestamp,
  isCancelledIntegrationWorkflowStatus,
  isIntegrationWorkflowRegression,
  normalizeIntegrationWorkflowStatus,
  normalizeOrderState,
  resolveOrderRuntimeState,
  resolveIntegrationWorkflowRank,
} from "../modules/orders/order-state-machine.js";

test("N2 order state machine formalizza le transizioni principali della roadmap", () => {
  const cases = [
    ["draft", "emitted", true],
    ["emitted", "queued", true],
    ["queued", "preparing", true],
    ["preparing", "ready", true],
    ["ready", "delivered", true],
    ["delivered", "partially_paid", true],
    ["partially_paid", "paid", true],
    ["queued", "cancelled", true],
    ["ready", "corrected", true],
    ["delivered", "compensated", true],
    ["paid", "corrected", true],
    ["preparing", "queued", false],
    ["paid", "queued", false],
    ["delivered", "preparing", false],
    ["cancelled", "queued", false],
    ["draft", "unknown", false],
  ];

  for (const [from, to, expected] of cases) {
    assert.equal(canTransitionOrderState(from, to), expected, `${from} -> ${to}`);
  }
  assert.equal(
    canTransitionOrderState("preparing", "queued", { allowPreparationDemotion: true }),
    true,
    "preparing -> queued deve restare solo una retrocessione esplicita",
  );
});

test("N2 order state machine normalizza stati legacy workflow e pagamento", () => {
  assert.equal(normalizeOrderState("waiting"), "queued");
  assert.equal(normalizeOrderState("prep"), "preparing");
  assert.equal(normalizeOrderState("pagata"), "paid");
  assert.equal(normalizeOrderState("annullata"), "cancelled");
  assert.equal(normalizeOrderState("reso"), "compensated");
});

test("N2 order state machine applica transizioni o solleva errore esplicito", () => {
  const updated = applyOrderStateTransition(
    { id: "ord_1", workflowStatus: "ready" },
    "delivered",
    { now: () => "2026-07-03T11:00:00.000Z" },
  );

  assert.equal(updated.orderState, "delivered");
  assert.equal(updated.orderStateUpdatedAt, "2026-07-03T11:00:00.000Z");
  assert.throws(
    () => applyOrderStateTransition({ id: "ord_2", orderState: "paid" }, "queued"),
    (error) => {
      assert.equal(error.code, INVALID_ORDER_STATE_TRANSITION_CODE);
      assert.match(error.message, /Transizione ordine non ammessa: paid -> queued/);
      return true;
    },
  );
});

test("N2 order state machine proietta lo stato runtime dagli stati legacy", () => {
  assert.deepEqual(
    resolveOrderRuntimeState({ workflowStatus: "waiting", paymentStatus: "unpaid" }),
    { orderState: "queued", path: ["draft", "emitted", "queued"] },
  );
  assert.deepEqual(
    resolveOrderRuntimeState({ workflowStatus: "waiting", paymentStatus: "unpaid", completedAtMs: null }),
    { orderState: "queued", path: ["draft", "emitted", "queued"] },
  );
  assert.deepEqual(
    resolveOrderRuntimeState({ workflowStatus: "prep", paymentStatus: "unpaid" }),
    { orderState: "preparing", path: ["draft", "emitted", "queued", "preparing"] },
  );
  assert.deepEqual(
    resolveOrderRuntimeState({ workflowStatus: "delivered", paymentStatus: "partial" }),
    {
      orderState: "partially_paid",
      path: ["draft", "emitted", "queued", "preparing", "ready", "delivered", "partially_paid"],
    },
  );
  assert.deepEqual(
    resolveOrderRuntimeState({ workflowStatus: "ready", paymentStatus: "paid" }),
    {
      orderState: "paid",
      path: ["draft", "emitted", "queued", "preparing", "ready", "delivered", "paid"],
    },
  );
  assert.equal(
    resolveOrderRuntimeState({ workflowStatus: "cancelled" }).orderState,
    "cancelled",
  );
  assert.equal(
    resolveOrderRuntimeState({ workflowStatus: "delivered", correctionStatus: "compensated" }).orderState,
    "compensated",
  );
});

test("resolveIntegrationWorkflowRank resolves known workflow order", () => {
  assert.equal(resolveIntegrationWorkflowRank("waiting"), 0);
  assert.equal(resolveIntegrationWorkflowRank(" prep "), 1);
  assert.equal(resolveIntegrationWorkflowRank("READY"), 2);
  assert.equal(resolveIntegrationWorkflowRank("delivered"), 3);
  assert.equal(resolveIntegrationWorkflowRank("cancelled"), null);
});

test("isIntegrationWorkflowRegression detects only known backwards transitions", () => {
  assert.equal(isIntegrationWorkflowRegression("ready", "prep"), true);
  assert.equal(isIntegrationWorkflowRegression("delivered", "waiting"), true);
  assert.equal(isIntegrationWorkflowRegression("waiting", "ready"), false);
  assert.equal(isIntegrationWorkflowRegression("cancelled", "waiting"), false);
});

test("getIntegrationWorkflowTransitionViolation allows forward and unknown transitions", () => {
  assert.equal(getIntegrationWorkflowTransitionViolation("waiting", "prep"), null);
  assert.equal(getIntegrationWorkflowTransitionViolation("prep", "ready"), null);
  assert.equal(getIntegrationWorkflowTransitionViolation("ready", "delivered"), null);
  assert.equal(getIntegrationWorkflowTransitionViolation("cancelled", "waiting"), null);
});

test("getIntegrationWorkflowTransitionViolation blocks regressions", () => {
  const violation = getIntegrationWorkflowTransitionViolation("ready", "waiting");

  assert.equal(violation.code, INVALID_ORDER_STATUS_TRANSITION_CODE);
  assert.equal(violation.message, "Transizione stato comanda non valida.");
  assert.deepEqual(violation.details, {
    previousStatus: "ready",
    nextStatus: "waiting",
  });
});

test("getIntegrationWorkflowTransitionViolation preserves preparation demotion escape hatch", () => {
  assert.equal(
    getIntegrationWorkflowTransitionViolation("prep", "waiting", { allowPreparationDemotion: true }),
    null
  );
  assert.equal(
    getIntegrationWorkflowTransitionViolation("ready", "waiting", { allowPreparationDemotion: true })?.code,
    INVALID_ORDER_STATUS_TRANSITION_CODE
  );
});

test("createIntegrationWorkflowStateMachine throws injected transition errors", () => {
  const stateMachine = createIntegrationWorkflowStateMachine({
    createTransitionError: (violation) => Object.assign(new Error(violation.message), {
      statusCode: 409,
      code: violation.code,
      details: violation.details,
    }),
  });

  assert.doesNotThrow(() => stateMachine.assertIntegrationWorkflowTransitionAllowed("waiting", "ready"));
  assert.throws(
    () => stateMachine.assertIntegrationWorkflowTransitionAllowed("delivered", "prep"),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, INVALID_ORDER_STATUS_TRANSITION_CODE);
      assert.deepEqual(error.details, {
        previousStatus: "delivered",
        nextStatus: "prep",
      });
      return true;
    }
  );
});

test("hasIntegrationRouteTimestamp accepts only non-empty string timestamps", () => {
  assert.equal(hasIntegrationRouteTimestamp({ readyAt: "2026-06-07T10:00:00.000Z" }, "readyAt"), true);
  assert.equal(hasIntegrationRouteTimestamp({ readyAt: "   " }, "readyAt"), false);
  assert.equal(hasIntegrationRouteTimestamp({ readyAt: 123 }, "readyAt"), false);
  assert.equal(hasIntegrationRouteTimestamp(null, "readyAt"), null);
});

test("hasIntegrationRouteReadyProgress detects ready, delivered or picked up progress", () => {
  assert.equal(hasIntegrationRouteReadyProgress({ readyAt: "2026-06-07T10:00:00.000Z" }), true);
  assert.equal(hasIntegrationRouteReadyProgress({ deliveredAt: "2026-06-07T10:00:00.000Z" }), true);
  assert.equal(hasIntegrationRouteReadyProgress({ pickedUpAt: "2026-06-07T10:00:00.000Z" }), true);
  assert.equal(hasIntegrationRouteReadyProgress({ receivedAt: "2026-06-07T10:00:00.000Z" }), false);
  assert.equal(hasIntegrationRouteReadyProgress({}), false);
});

test("isCancelledIntegrationWorkflowStatus recognizes cancelled aliases only", () => {
  assert.equal(isCancelledIntegrationWorkflowStatus("cancelled"), true);
  assert.equal(isCancelledIntegrationWorkflowStatus(" annullata "), true);
  assert.equal(isCancelledIntegrationWorkflowStatus("VOIDED"), true);
  assert.equal(isCancelledIntegrationWorkflowStatus("delivered"), false);
  assert.equal(isCancelledIntegrationWorkflowStatus(null), false);
});

test("normalizeIntegrationWorkflowStatus maps explicit aliases", () => {
  assert.equal(normalizeIntegrationWorkflowStatus("annullata", [], null), "cancelled");
  assert.equal(normalizeIntegrationWorkflowStatus("pagata", [], null), "delivered");
  assert.equal(normalizeIntegrationWorkflowStatus("consegnato", [], null), "delivered");
  assert.equal(normalizeIntegrationWorkflowStatus("da consegnare", [], null), "ready");
  assert.equal(normalizeIntegrationWorkflowStatus("pronta", [], null), "ready");
  assert.equal(normalizeIntegrationWorkflowStatus("in preparazione", [], null), "prep");
  assert.equal(normalizeIntegrationWorkflowStatus("", [], null), "waiting");
});

test("normalizeIntegrationWorkflowStatus derives state from item progress", () => {
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [{ qty: 2, doneQty: 2 }], null),
    "ready"
  );
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [{ qty: 2, doneQty: 1 }], null),
    "prep"
  );
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [{ qty: 1, done: true }], null),
    "ready"
  );
});

test("normalizeIntegrationWorkflowStatus derives state from route progress", () => {
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [], null, {
      lineRoutes: [{ deliveredAt: "2026-06-07T10:00:00.000Z" }],
    }),
    "delivered"
  );
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [], null, {
      lineRoutes: [{ readyAt: "2026-06-07T10:00:00.000Z" }],
    }),
    "ready"
  );
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [], null, {
      lineRoutes: [{ receivedAt: "2026-06-07T10:00:00.000Z" }],
    }),
    "prep"
  );
  assert.equal(
    normalizeIntegrationWorkflowStatus("waiting", [], null, { ownerStation: "BAR-1" }),
    "prep"
  );
});

test("normalizeIntegrationWorkflowStatus preserves completedAt terminal inference", () => {
  assert.equal(normalizeIntegrationWorkflowStatus("waiting", [], 0), "delivered");
  assert.equal(normalizeIntegrationWorkflowStatus("waiting", [], Date.now()), "delivered");
});
