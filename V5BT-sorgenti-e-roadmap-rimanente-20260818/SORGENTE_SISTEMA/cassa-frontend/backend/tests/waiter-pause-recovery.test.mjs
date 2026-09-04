import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWaiterPauseCorrelationId,
  buildWaiterPauseRecoveryPlan,
} from "../modules/notifications/waiter-pause-recovery.js";

const user = { id: "user-1" };
const session = { userId: "user-1" };

test("waiter pause rileva dopo restart l'audit start mancante", () => {
  const integration = {
    waiterPauses: [{
      userId: "user-1",
      status: "paused",
      startedAtMs: 1_000,
      endsAtMs: 901_000,
    }],
  };
  const plan = buildWaiterPauseRecoveryPlan({
    integration: structuredClone(integration),
    auditEvents: [],
    user,
    session,
    kind: "start",
  });

  assert.equal(plan.recoveryRequired, true);
  assert.equal(plan.correlationId, "waiter-pause:start:user-1:1000");

  const afterRecovery = buildWaiterPauseRecoveryPlan({
    integration: structuredClone(integration),
    auditEvents: [{
      action: "waiter.pause_started",
      entityId: "user-1",
      correlationId: plan.correlationId,
      payload: { startedAtMs: 1_000 },
    }],
    user,
    session,
    kind: "start",
  });
  assert.equal(afterRecovery.recoveryRequired, false);
});

test("waiter pause riconosce audit legacy senza correlationId", () => {
  const plan = buildWaiterPauseRecoveryPlan({
    integration: {
      waiterPauses: [{
        userId: "user-1",
        status: "active",
        stoppedAtMs: 2_000,
        reenableAtMs: 5_000,
      }],
    },
    auditEvents: [{
      action: "waiter.pause_stopped",
      entityId: "user-1",
      payload: { reenableAtMs: 5_000 },
    }],
    user,
    session,
    kind: "stop",
  });

  assert.equal(plan.recoveryRequired, false);
  assert.equal(
    buildWaiterPauseCorrelationId("stop", "user-1", 2_000),
    "waiter-pause:stop:user-1:2000",
  );
});

test("waiter pause non inventa recovery senza transizione persistita", () => {
  assert.equal(buildWaiterPauseRecoveryPlan({
    integration: { waiterPauses: [] },
    auditEvents: [],
    user,
    session,
    kind: "stop",
  }), null);
});
