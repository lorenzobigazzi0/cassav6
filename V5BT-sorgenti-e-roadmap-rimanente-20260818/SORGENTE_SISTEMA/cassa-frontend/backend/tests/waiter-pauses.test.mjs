import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWaiterPauseState,
  startWaiterPause,
  stopWaiterPause,
} from "../modules/notifications/waiter-pauses.js";

const user = {
  id: "u_giada",
  username: "giada",
  fullName: "Giada Test",
  waiterPauseSettings: {
    enabled: true,
    durationMinutes: 15,
    renewalMinutes: 120,
  },
};

const session = {
  userId: "u_giada",
  username: "giada",
  fullName: "Giada Test",
  deviceUuid: "mobile-gilda",
};

test("[BE][NOTIFY] stop pausa conserva il residuo nel ciclo corrente", () => {
  const integration = {};
  const startedAt = 1_000_000;
  const stoppedAt = startedAt + 120_000;

  const started = startWaiterPause(integration, user, session, { nowMs: startedAt });
  assert.equal(started.ok, true);
  assert.equal(started.state.active, true);
  assert.equal(started.state.remainingMs, 15 * 60_000);

  const stopped = stopWaiterPause(integration, user, session, { nowMs: stoppedAt });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.active, false);
  assert.equal(stopped.state.graceActive, true);
  assert.equal(stopped.state.remainingMs, 13 * 60_000);

  const afterGrace = resolveWaiterPauseState(integration, user, session, {
    nowMs: stoppedAt + 4_000,
  });
  assert.equal(afterGrace.available, true);
  assert.equal(afterGrace.remainingMs, 13 * 60_000);

  const resumed = startWaiterPause(integration, user, session, { nowMs: stoppedAt + 5_000 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.active, true);
  assert.equal(resumed.state.remainingMs, 13 * 60_000);
  assert.equal(
    integration.waiterPauses[0].nextAvailableAtMs,
    startedAt + 120 * 60_000,
    "il rinnovo resta ancorato al primo avvio del ciclo"
  );
});

test("[BE][NOTIFY] stato pausa scaduta viene calcolato senza mutare il record", () => {
  const startedAt = 2_000_000;
  const endsAt = startedAt + 15 * 60_000;
  const integration = {
    waiterPauses: [
      {
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        status: "paused",
        startedAtMs: startedAt,
        endsAtMs: endsAt,
        remainingAllowanceMs: 15 * 60_000,
      },
    ],
  };

  const state = resolveWaiterPauseState(integration, user, session, {
    nowMs: endsAt + 1_000,
  });
  assert.equal(state.active, false);
  assert.equal(state.graceActive, true);
  assert.equal(state.available, false);
  assert.equal(state.remainingMs, 0);
  assert.equal(state.reenableAtMs, endsAt + 3_000);
  assert.equal(integration.waiterPauses[0].status, "paused");
  assert.equal(integration.waiterPauses[0].remainingAllowanceMs, 15 * 60_000);
});

test("[BE][NOTIFY] stop dopo scadenza e' un no-op sul record", () => {
  const startedAt = 4_000_000;
  const integration = {};
  startWaiterPause(integration, user, session, { nowMs: startedAt });
  const recordBeforeStop = structuredClone(integration.waiterPauses[0]);

  const result = stopWaiterPause(integration, user, session, {
    nowMs: recordBeforeStop.endsAtMs + 1_000,
  });

  assert.equal(result.reason, "already_active");
  assert.deepEqual(integration.waiterPauses[0], recordBeforeStop);
});

test("[BE][NOTIFY] stop duplicato e idempotente e non estende la grace", () => {
  const integration = {};
  const startedAt = 3_000_000;
  const stoppedAt = startedAt + 60_000;
  startWaiterPause(integration, user, session, { nowMs: startedAt });

  const stopped = stopWaiterPause(integration, user, session, { nowMs: stoppedAt });
  const snapshot = structuredClone(integration.waiterPauses[0]);
  const duplicate = stopWaiterPause(integration, user, session, {
    nowMs: stoppedAt + 2_000,
  });

  assert.equal(stopped.reason, "stopped");
  assert.equal(duplicate.reason, "already_active");
  assert.deepEqual(integration.waiterPauses[0], snapshot);
  assert.equal(duplicate.state.reenableAtMs, stoppedAt + 3_000);
});
