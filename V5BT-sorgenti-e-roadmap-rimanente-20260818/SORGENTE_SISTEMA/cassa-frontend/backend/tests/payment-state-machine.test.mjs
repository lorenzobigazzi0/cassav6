import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPaymentStateTransition,
  buildPaymentRealtimeBoundary,
  canTransitionPaymentState,
  createPaymentStateMachine,
  resolvePaymentRuntimeState,
} from "../modules/payments/index.js";

test("N1 payment state machine formalizza le transizioni minime della roadmap", () => {
  const cases = [
    ["created", "authorized", true],
    ["created", "settled", true],
    ["pending_provider", "authorized", true],
    ["authorized", "settled", true],
    ["settled", "fiscal_queued", true],
    ["fiscal_queued", "fiscal_ok", true],
    ["fiscal_queued", "fiscal_ko_retryable", true],
    ["fiscal_queued", "fiscal_ko_expired", true],
    ["fiscal_ko_retryable", "fiscal_queued", true],
    ["settled", "created", false],
    ["fiscal_ok", "fiscal_queued", false],
    ["reversed", "settled", false],
    ["created", "unknown", false],
  ];

  for (const [from, to, expected] of cases) {
    assert.equal(
      canTransitionPaymentState(from, to),
      expected,
      `${from} -> ${to}`,
    );
  }
});

test("N1 payment state machine applica transizioni o solleva errore esplicito", () => {
  const updated = applyPaymentStateTransition(
    { id: "pay_1", status: "COMPLETED" },
    "fiscal_queued",
    { now: () => "2026-07-03T10:00:00.000Z" },
  );

  assert.equal(updated.paymentState, "fiscal_queued");
  assert.equal(updated.paymentStateUpdatedAt, "2026-07-03T10:00:00.000Z");
  assert.throws(
    () => applyPaymentStateTransition({ id: "pay_2", paymentState: "fiscal_ok" }, "fiscal_queued"),
    /Transizione pagamento non ammessa: fiscal_ok -> fiscal_queued/,
  );
});

test("N1 payment state machine proietta stati runtime fiscali", () => {
  assert.deepEqual(
    resolvePaymentRuntimeState({ fiscalResults: [] }),
    { paymentState: "settled", path: ["created", "settled"] },
  );
  assert.deepEqual(
    resolvePaymentRuntimeState({
      fiscalResults: [{ pending: true, receipt: { fiscalStatus: "PENDING" } }],
    }),
    {
      paymentState: "fiscal_queued",
      path: ["created", "settled", "fiscal_queued"],
    },
  );
  assert.deepEqual(
    resolvePaymentRuntimeState({
      fiscalResults: [{ issued: true, receipt: { fiscalStatus: "ISSUED" } }],
    }),
    {
      paymentState: "fiscal_ok",
      path: ["created", "settled", "fiscal_queued", "fiscal_ok"],
    },
  );
  assert.deepEqual(
    resolvePaymentRuntimeState({
      fiscalResults: [{ requiresRetry: true, receipt: { fiscalStatus: "FAILED" } }],
    }),
    {
      paymentState: "fiscal_ko_retryable",
      path: ["created", "settled", "fiscal_queued", "fiscal_ko_retryable"],
    },
  );
  assert.deepEqual(
    resolvePaymentRuntimeState({
      fiscalResults: [{ receipt: { fiscalStatus: "EXPIRED" } }],
    }),
    {
      paymentState: "fiscal_ko_expired",
      path: ["created", "settled", "fiscal_queued", "fiscal_ko_expired"],
    },
  );
});

test("N1 buildPaymentRealtimeBoundary conserva legacy status ed espone paymentState", () => {
  const pending = buildPaymentRealtimeBoundary({
    completed: true,
    fiscalResults: [{ pending: true, receipt: { fiscalStatus: "PENDING" } }],
  });
  assert.equal(pending.paymentStatus, "PENDING_FISCAL");
  assert.equal(pending.paymentState, "fiscal_queued");
  assert.deepEqual(pending.paymentStatePath, ["created", "settled", "fiscal_queued"]);

  const completed = buildPaymentRealtimeBoundary({
    completed: true,
    fiscalResults: [{ issued: true, receipt: { fiscalStatus: "ISSUED" } }],
  });
  assert.equal(completed.paymentStatus, "COMPLETED");
  assert.equal(completed.paymentState, "fiscal_ok");

  const disabled = buildPaymentRealtimeBoundary({
    completed: true,
    fiscalResults: [{ pending: true, receipt: { fiscalStatus: "PENDING" } }],
    paymentStateMachineEnabled: false,
  });
  assert.equal(disabled.paymentStatus, "PENDING_FISCAL");
  assert.equal(disabled.paymentState, null);
});

test("N1 createPaymentStateMachine espone canTransition/applyTransition", () => {
  const machine = createPaymentStateMachine();
  assert.equal(machine.canTransition("created", "settled"), true);
  assert.equal(machine.applyTransition("created", "settled"), "settled");
  assert.throws(
    () => machine.assertTransitionAllowed("settled", "created"),
    /Transizione pagamento non ammessa/,
  );
});
