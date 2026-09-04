import assert from "node:assert/strict";
import test from "node:test";

import { createMysqlNamedLockCoordinator } from "../db/app-state/mysql-named-lock-coordinator.js";
import { enqueuePaymentLaneTaskWithAdmission } from "../modules/queue/payment-lane-admission.js";

function createConcurrentLane(concurrency) {
  const queue = [];
  let running = 0;
  let maximumRunning = 0;

  const pump = () => {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift();
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      void Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };

  return {
    enqueue(run) {
      return new Promise((resolve, reject) => {
        queue.push({ run, resolve, reject });
        pump();
      });
    },
    maximumRunning: () => maximumRunning,
  };
}

function createCoordinatorHarness() {
  const counters = new Map();
  const writes = [];
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: true,
    name: "v5bt:test:payment-liveness",
    runtimeMetrics: {
      incrementCounter(name) {
        counters.set(name, (counters.get(name) ?? 0) + 1);
      },
      recordOperation() {},
    },
    mysqlRepository: {
      getPool: async () => ({
        getConnection: async () => ({
          async query(sql) {
            if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
            if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
            throw new Error(`Query inattesa: ${sql}`);
          },
          release() {},
        }),
      }),
    },
  });
  return { coordinator, counters, writes };
}

test("un task accodato non riserva il named lock mentre attende uno slot", async () => {
  const lane = createConcurrentLane(2);
  const { coordinator, counters, writes } = createCoordinatorHarness();
  let deferredStarted = 0;
  let releaseDeferred;
  let markBothStarted;
  const deferredGate = new Promise((resolve) => {
    releaseDeferred = resolve;
  });
  const bothStarted = new Promise((resolve) => {
    markBothStarted = resolve;
  });

  const enqueueDeferred = (name) =>
    enqueuePaymentLaneTaskWithAdmission({
      coordinator,
      enqueue: lane.enqueue,
      label: name,
      deferNamedLockAdmission: true,
      action: async () => {
        deferredStarted += 1;
        if (deferredStarted === 2) markBothStarted();
        await deferredGate;
        return coordinator.run(`${name}.writer`, async () => {
          writes.push(name);
          return name;
        });
      },
    });

  const first = enqueueDeferred("free-split-a");
  const second = enqueueDeferred("free-split-b");
  await bothStarted;

  const counter = enqueuePaymentLaneTaskWithAdmission({
    coordinator,
    enqueue: lane.enqueue,
    label: "counter.collect",
    action: () => coordinator.run("counter.writer", async () => {
      writes.push("counter");
      return "counter";
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    counters.get("mysqlDomainNamedLockLocalReservationAcquired") ?? 0,
    0,
    "il counter accodato non deve mantenere una reservation",
  );

  releaseDeferred();
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("deadlock payment lane/named lock")),
      1_000,
    );
    timer.unref();
  });
  const results = await Promise.race([
    Promise.all([first, second, counter]),
    timeout,
  ]);

  assert.deepEqual(results, ["free-split-a", "free-split-b", "counter"]);
  assert.equal(lane.maximumRunning(), 2);
  assert.equal(
    counters.get("mysqlDomainNamedLockLocalReservationAcquired"),
    1,
  );
  assert.deepEqual([...writes].sort(), ["counter", "free-split-a", "free-split-b"]);
});
