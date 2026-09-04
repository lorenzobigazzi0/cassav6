import test from "node:test";
import assert from "node:assert/strict";
import { createSerializedMutationLane } from "../modules/queue/mutation-lane.js";

function createLane(overrides = {}) {
  let lane;
  lane = createSerializedMutationLane({
    enabled: true,
    concurrency: 1,
    burst: 10,
    kind: "testLane",
    slowWaitMs: Number.MAX_SAFE_INTEGER,
    slowRunMs: Number.MAX_SAFE_INTEGER,
    scheduleNext: () => queueMicrotask(() => lane.schedule()),
    ...overrides,
  });
  return lane;
}

test("mutation lane notifica l'attesa alla callback della singola richiesta", async () => {
  const lane = createLane();
  const waits = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = lane.enqueue("first", "same-key", async () => {
    markFirstStarted();
    await firstGate;
    return "first";
  }, {
    fallback: () => assert.fail("fallback inatteso"),
    onWait: (waitMs) => waits.push(["first", waitMs]),
  });
  await firstStarted;

  const second = lane.enqueue("second", "same-key", async () => "second", {
    fallback: () => assert.fail("fallback inatteso"),
    onWait: (waitMs) => waits.push(["second", waitMs]),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(waits.length, 2);
  assert.equal(waits[0][0], "first");
  assert.equal(waits[1][0], "second");
  assert.ok(waits[1][1] >= 5, `attesa seconda richiesta: ${waits[1][1]}ms`);
});

test("mutation lane condivide la stessa attesa intera tra coda e richiesta", async () => {
  let monotonicTime = 100.2;
  const queueWaits = [];
  const requestWaits = [];
  const lane = createLane({
    monotonicNow: () => monotonicTime,
    runtimeMetrics: {
      recordQueueWait(_kind, _label, waitMs) {
        queueWaits.push(waitMs);
      },
    },
  });

  const task = lane.enqueue("fractional-wait", "key", async () => 42, {
    fallback: () => assert.fail("fallback inatteso"),
    onWait: (waitMs) => requestWaits.push(waitMs),
  });
  monotonicTime = 101.7;

  assert.equal(await task, 42);
  assert.deepEqual(queueWaits, [2]);
  assert.deepEqual(requestWaits, queueWaits);
});

test("mutation lane usa una label metrica stabile senza cambiare la label operativa", async () => {
  const waits = [];
  const runs = [];
  const lane = createLane({
    runtimeMetrics: {
      recordQueueWait(kind, label) {
        waits.push([kind, label]);
      },
      recordQueueRun(kind, label) {
        runs.push([kind, label]);
      },
    },
  });

  const result = await lane.enqueue(
    "owner auto-print batch private-id",
    "order:private-id",
    async () => 42,
    {
      fallback: () => assert.fail("fallback inatteso"),
      metricLabel: "owner auto-print batch",
    },
  );

  assert.equal(result, 42);
  assert.deepEqual(waits, [["testLane", "owner auto-print batch"]]);
  assert.deepEqual(runs, [["testLane", "owner auto-print batch"]]);
});

test("mutation lane non interrompe il workflow se la callback metriche fallisce", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const lane = createLane();
    const result = await lane.enqueue("callback-error", "key", async () => 42, {
      fallback: () => assert.fail("fallback inatteso"),
      onWait: () => {
        throw new Error("metric sink offline");
      },
    });
    assert.equal(result, 42);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("mutation lane esegue prima il task con priorita piu alta mantenendo FIFO a parita", async () => {
  const lane = createLane();
  const executionOrder = [];
  let releaseBlocker;
  let markBlockerStarted;
  const blockerStarted = new Promise((resolve) => {
    markBlockerStarted = resolve;
  });
  const blockerGate = new Promise((resolve) => {
    releaseBlocker = resolve;
  });

  const blocker = lane.enqueue("blocker", "blocker", async () => {
    executionOrder.push("blocker");
    markBlockerStarted();
    await blockerGate;
  }, {
    fallback: () => assert.fail("fallback inatteso"),
    priority: 0,
  });
  await blockerStarted;

  const ack = lane.enqueue("ack", "notification:1", async () => {
    executionOrder.push("ack");
  }, {
    fallback: () => assert.fail("fallback inatteso"),
    priority: 7,
  });
  const firstPublish = lane.enqueue("publish-1", "target:waiter-1", async () => {
    executionOrder.push("publish-1");
  }, {
    fallback: () => assert.fail("fallback inatteso"),
    priority: 4,
  });
  const secondPublish = lane.enqueue("publish-2", "target:waiter-2", async () => {
    executionOrder.push("publish-2");
  }, {
    fallback: () => assert.fail("fallback inatteso"),
    priority: 4,
  });

  releaseBlocker();
  await Promise.all([blocker, ack, firstPublish, secondPublish]);

  assert.deepEqual(executionOrder, [
    "blocker",
    "publish-1",
    "publish-2",
    "ack",
  ]);
});

test("nextTaskMetadata riflette la stessa selezione per priorita e FIFO della dequeue", async () => {
  const lane = createLane({ scheduleNext: () => {} });
  const executionOrder = [];

  const laterPriority = lane.enqueue(
    "priority-7",
    "key-7",
    async () => executionOrder.push("priority-7"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 7,
    },
  );
  const firstPriority = lane.enqueue(
    "priority-4-first",
    "key-4-first",
    async () => executionOrder.push("priority-4-first"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 4,
    },
  );
  const secondPriority = lane.enqueue(
    "priority-4-second",
    "key-4-second",
    async () => executionOrder.push("priority-4-second"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 4,
    },
  );

  assert.deepEqual(
    {
      label: lane.nextTaskMetadata()?.label,
      priority: lane.nextTaskMetadata()?.priority,
      sequence: lane.nextTaskMetadata()?.sequence,
    },
    { label: "priority-4-first", priority: 4, sequence: 1 },
  );

  assert.equal(lane.schedule(), true);
  await firstPriority;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lane.nextTaskMetadata()?.label, "priority-4-second");

  assert.equal(lane.schedule(), true);
  await secondPriority;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lane.nextTaskMetadata()?.label, "priority-7");

  assert.equal(lane.schedule(), true);
  await laterPriority;
  assert.deepEqual(executionOrder, [
    "priority-4-first",
    "priority-4-second",
    "priority-7",
  ]);
});

test("starvationWaitMs promuove la richiesta anziana davanti alle nuove ad alta priorita", async () => {
  let monotonicTime = 100;
  const lane = createLane({
    scheduleNext: () => {},
    starvationWaitMs: 10,
    monotonicNow: () => monotonicTime,
  });
  const executionOrder = [];
  const aged = lane.enqueue(
    "aged-priority-7",
    "aged",
    async () => executionOrder.push("aged-priority-7"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 7,
    },
  );

  monotonicTime = 111;
  const urgentFirst = lane.enqueue(
    "new-priority-0",
    "new-0",
    async () => executionOrder.push("new-priority-0"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 0,
    },
  );
  const urgentSecond = lane.enqueue(
    "new-priority-1",
    "new-1",
    async () => executionOrder.push("new-priority-1"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 1,
    },
  );

  assert.equal(lane.nextTaskMetadata()?.label, "aged-priority-7");
  assert.equal(lane.schedule(), true);
  await aged;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(lane.schedule(), true);
  await urgentFirst;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lane.schedule(), true);
  await urgentSecond;
  assert.deepEqual(executionOrder, [
    "aged-priority-7",
    "new-priority-0",
    "new-priority-1",
  ]);
});

test("prima della soglia starvationWaitMs resta valido l'ordine per priorita", async () => {
  let monotonicTime = 100;
  const lane = createLane({
    scheduleNext: () => {},
    starvationWaitMs: 10,
    monotonicNow: () => monotonicTime,
  });
  const executionOrder = [];
  const older = lane.enqueue(
    "older-priority-7",
    "older",
    async () => executionOrder.push("older-priority-7"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 7,
    },
  );
  monotonicTime = 109;
  const urgent = lane.enqueue(
    "new-priority-0",
    "new",
    async () => executionOrder.push("new-priority-0"),
    {
      fallback: () => assert.fail("fallback inatteso"),
      priority: 0,
    },
  );

  assert.equal(lane.nextTaskMetadata()?.label, "new-priority-0");
  assert.equal(lane.schedule(), true);
  await urgent;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lane.schedule(), true);
  await older;
  assert.deepEqual(executionOrder, ["new-priority-0", "older-priority-7"]);
});

test("canSchedule resta false mentre la concorrenza della lane e piena", async () => {
  const lane = createLane({ scheduleNext: () => {} });
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = lane.enqueue(
    "first",
    "key-1",
    async () => {
      markFirstStarted();
      await firstGate;
      return "first";
    },
    { fallback: () => assert.fail("fallback inatteso") },
  );
  assert.equal(lane.canSchedule(), true);
  assert.equal(lane.schedule(), true);
  await firstStarted;

  const second = lane.enqueue("second", "key-2", async () => "second", {
    fallback: () => assert.fail("fallback inatteso"),
  });
  assert.equal(lane.runningCount(), 1);
  assert.equal(lane.depth(), 1);
  assert.equal(lane.canSchedule(), false);

  releaseFirst();
  assert.equal(await first, "first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lane.canSchedule(), true);
  assert.equal(lane.schedule(), true);
  assert.equal(await second, "second");
});

test("mutation lane cede dopo il burst sotto pressione peer e riparte senza pressione", async () => {
  let peerDepth = 1;
  const starts = [];
  const lane = createLane({
    burst: 1,
    getQueuePressureDepth: () => peerDepth,
    onScheduleStart: () => starts.push(Date.now()),
    scheduleNext: () => {},
  });

  const first = lane.enqueue("first", "key-1", async () => "first", {
    fallback: () => assert.fail("fallback inatteso"),
  });
  let secondStarted = false;
  const second = lane.enqueue(
    "second",
    "key-2",
    async () => {
      secondStarted = true;
      return "second";
    },
    { fallback: () => assert.fail("fallback inatteso") },
  );

  assert.equal(lane.schedule(), true);
  assert.equal(await first, "first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lane.canSchedule(), false);
  assert.equal(secondStarted, false);

  peerDepth = 0;
  assert.equal(lane.schedule(), true);
  assert.equal(await second, "second");
  assert.equal(starts.length, 2);
});
