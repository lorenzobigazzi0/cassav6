import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostazioneSyncCoordinator,
  createSingleFlight,
} from "../src/postazioneSyncCoordinator.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

function createManualClock() {
  let currentTime = 0;
  let nextTimerId = 1;
  const timers = new Map();

  const runDueTimers = () => {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= currentTime)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      if (!timers.delete(id)) continue;
      timer.callback();
    }
  };

  return {
    now: () => currentTime,
    schedule(callback, delayMs) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { at: currentTime + delayMs, callback });
      return id;
    },
    clearScheduled(id) {
      timers.delete(id);
    },
    async advance(delayMs) {
      currentTime += delayMs;
      runDueTimers();
      await flushTasks();
    },
    pendingCount: () => timers.size,
  };
}

test("a realtime burst runs one active sync and at most one trailing sync", async () => {
  const runs = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createPostazioneSyncCoordinator({
    execute: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      runs.push(gate);
      await gate.promise;
      active -= 1;
      return true;
    },
  });

  const first = coordinator.trigger();
  await flushTasks();
  const burst = Array.from({ length: 100 }, () => coordinator.trigger());
  assert.equal(runs.length, 1);
  assert.equal(coordinator.status().trailing, true);
  assert.ok(burst.every((promise) => promise === first));

  runs[0].resolve();
  await flushTasks();
  assert.equal(runs.length, 2);
  assert.equal(coordinator.status().trailing, false);
  runs[1].resolve();

  assert.equal(await first, true);
  assert.equal(maxActive, 1);
  assert.equal(runs.length, 2);
  assert.deepEqual(coordinator.status(), {
    cancelled: false,
    running: false,
    trailing: false,
  });
});

test("a burst in the same event-loop turn is retained as one trailing sync", async () => {
  const runs = [];
  const coordinator = createPostazioneSyncCoordinator({
    execute: async () => {
      const gate = deferred();
      runs.push(gate);
      await gate.promise;
      return true;
    },
  });

  const first = coordinator.trigger();
  const burst = Array.from({ length: 50 }, () => coordinator.trigger());
  assert.ok(burst.every((promise) => promise === first));
  await flushTasks();
  assert.equal(runs.length, 1);

  runs[0].resolve();
  await flushTasks();
  assert.equal(runs.length, 2);
  runs[1].resolve();

  assert.equal(await first, true);
  assert.equal(runs.length, 2);
});

test("a trigger received during the trailing sync is preserved for the next pass", async () => {
  const runs = [];
  const coordinator = createPostazioneSyncCoordinator({
    execute: async () => {
      const gate = deferred();
      runs.push(gate);
      await gate.promise;
      return runs.length;
    },
  });

  const result = coordinator.trigger();
  await flushTasks();
  coordinator.trigger();
  runs[0].resolve();
  await flushTasks();
  assert.equal(runs.length, 2);

  coordinator.trigger();
  runs[1].resolve();
  await flushTasks();
  assert.equal(runs.length, 3);
  runs[2].resolve();

  assert.equal(await result, 3);
});

test("cancel invalidates queued work and rejects every later trigger", async () => {
  const gate = deferred();
  let runs = 0;
  let context = null;
  const coordinator = createPostazioneSyncCoordinator({
    execute: async (nextContext) => {
      runs += 1;
      context = nextContext;
      await gate.promise;
      return true;
    },
  });

  const result = coordinator.trigger();
  await flushTasks();
  coordinator.trigger();
  coordinator.cancel();
  assert.equal(context.isCancelled(), true);
  gate.resolve();

  assert.equal(await result, false);
  assert.equal(await coordinator.trigger(), false);
  assert.equal(runs, 1);
  assert.deepEqual(coordinator.status(), {
    cancelled: true,
    running: false,
    trailing: false,
  });
});

test("a queued trigger is still served when the active sync fails", async () => {
  const gate = deferred();
  let runs = 0;
  const coordinator = createPostazioneSyncCoordinator({
    execute: async () => {
      runs += 1;
      if (runs === 1) {
        await gate.promise;
        throw new Error("temporary failure");
      }
      return "recovered";
    },
  });

  const result = coordinator.trigger();
  await flushTasks();
  coordinator.trigger();
  gate.resolve();

  assert.equal(await result, "recovered");
  assert.equal(runs, 2);
});

test("canRun blocks sync before start and cancels a trailing pass", async () => {
  const gate = deferred();
  let allowed = false;
  let runs = 0;
  const coordinator = createPostazioneSyncCoordinator({
    canRun: () => allowed,
    execute: async () => {
      runs += 1;
      await gate.promise;
      return true;
    },
  });

  assert.equal(await coordinator.trigger(), false);
  allowed = true;
  const result = coordinator.trigger();
  await flushTasks();
  coordinator.trigger();
  allowed = false;
  gate.resolve();

  assert.equal(await result, false);
  assert.equal(runs, 1);
});

test("cooldown keeps full sync starts at least three seconds apart", async () => {
  const clock = createManualClock();
  const gates = [];
  const starts = [];
  const coordinator = createPostazioneSyncCoordinator({
    cooldownMs: 3000,
    now: clock.now,
    schedule: clock.schedule,
    clearScheduled: clock.clearScheduled,
    execute: async () => {
      starts.push(clock.now());
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return true;
    },
  });

  const result = coordinator.trigger();
  await flushTasks();
  assert.deepEqual(starts, [0]);
  coordinator.trigger();
  gates[0].resolve();
  await flushTasks();
  assert.equal(clock.pendingCount(), 1);

  await clock.advance(2999);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  assert.deepEqual(starts, [0, 3000]);
  gates[1].resolve();

  assert.equal(await result, true);
  assert.equal(clock.pendingCount(), 0);
});

test("realtime events during cooldown coalesce into the already pending sync", async () => {
  const clock = createManualClock();
  const starts = [];
  const coordinator = createPostazioneSyncCoordinator({
    cooldownMs: 3000,
    now: clock.now,
    schedule: clock.schedule,
    clearScheduled: clock.clearScheduled,
    execute: async () => {
      starts.push(clock.now());
      return true;
    },
  });

  assert.equal(await coordinator.trigger(), true);
  const pending = coordinator.trigger();
  await flushTasks();
  const burst = Array.from({ length: 100 }, () => coordinator.trigger());
  assert.ok(burst.every((promise) => promise === pending));
  assert.equal(clock.pendingCount(), 1);

  await clock.advance(3000);
  assert.equal(await pending, true);
  assert.deepEqual(starts, [0, 3000]);
  assert.equal(clock.pendingCount(), 0);
});

test("an event received during the cooldown pass preserves one final refresh", async () => {
  const clock = createManualClock();
  const gates = [];
  const starts = [];
  const coordinator = createPostazioneSyncCoordinator({
    cooldownMs: 3000,
    now: clock.now,
    schedule: clock.schedule,
    clearScheduled: clock.clearScheduled,
    execute: async () => {
      starts.push(clock.now());
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return true;
    },
  });

  const result = coordinator.trigger();
  await flushTasks();
  coordinator.trigger();
  gates[0].resolve();
  await clock.advance(3000);
  assert.deepEqual(starts, [0, 3000]);

  coordinator.trigger();
  gates[1].resolve();
  await flushTasks();
  await clock.advance(3000);
  assert.deepEqual(starts, [0, 3000, 6000]);
  gates[2].resolve();

  assert.equal(await result, true);
});

test("cancel clears a pending cooldown without running the queued sync", async () => {
  const clock = createManualClock();
  let runs = 0;
  const coordinator = createPostazioneSyncCoordinator({
    cooldownMs: 3000,
    now: clock.now,
    schedule: clock.schedule,
    clearScheduled: clock.clearScheduled,
    execute: async () => {
      runs += 1;
      return true;
    },
  });

  assert.equal(await coordinator.trigger(), true);
  const pending = coordinator.trigger();
  await flushTasks();
  assert.equal(clock.pendingCount(), 1);
  coordinator.cancel();

  assert.equal(await pending, false);
  assert.equal(clock.pendingCount(), 0);
  await clock.advance(3000);
  assert.equal(runs, 1);
});

test("single-flight shares one layout read between concurrent callers", async () => {
  const gates = [];
  let runs = 0;
  const operation = createSingleFlight(async () => {
    runs += 1;
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });

  const first = operation.run();
  const concurrent = Array.from({ length: 20 }, () => operation.run());
  assert.ok(concurrent.every((promise) => promise === first));
  await flushTasks();
  assert.equal(runs, 1);
  assert.equal(operation.isRunning(), true);

  gates[0].resolve("layout-1");
  assert.equal(await first, "layout-1");
  assert.equal(operation.isRunning(), false);

  const second = operation.run();
  await flushTasks();
  assert.equal(runs, 2);
  gates[1].resolve("layout-2");
  assert.equal(await second, "layout-2");
});

test("single-flight is reusable after a rejected layout read", async () => {
  let runs = 0;
  const operation = createSingleFlight(async () => {
    runs += 1;
    if (runs === 1) throw new Error("layout unavailable");
    return true;
  });

  await assert.rejects(operation.run(), /layout unavailable/);
  assert.equal(operation.isRunning(), false);
  assert.equal(await operation.run(), true);
  assert.equal(runs, 2);
});
