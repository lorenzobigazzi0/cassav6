import assert from "node:assert/strict";
import test from "node:test";

import { createMysqlNamedLockCoordinator } from "../db/app-state/mysql-named-lock-coordinator.js";

function createHarness({ acquired = 1 } = {}) {
  const queries = [];
  const counters = [];
  const operations = [];
  let releases = 0;
  const connection = {
    async query(sql, parameters) {
      queries.push([sql, parameters]);
      if (sql.includes("GET_LOCK")) return [[{ acquired }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
      throw new Error(`Query inattesa: ${sql}`);
    },
    release() {
      releases += 1;
    },
  };
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: true,
    name: "v5bt:test:payment-domain",
    timeoutSeconds: 7,
    mysqlRepository: {
      getPool: async () => ({ getConnection: async () => connection }),
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: (category, label, durationMs) =>
        operations.push([category, label, durationMs]),
    },
  });
  return {
    coordinator,
    counters,
    operations,
    queries,
    releases: () => releases,
  };
}

test("named lock acquisisce, esegue e rilascia la connessione", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.run("counter.write", async () => "written");

  assert.equal(result, "written");
  assert.deepEqual(harness.queries, [
    ["SELECT GET_LOCK(?, ?) AS acquired", ["v5bt:test:payment-domain", 7]],
    ["SELECT RELEASE_LOCK(?) AS released", ["v5bt:test:payment-domain"]],
  ]);
  assert.equal(harness.releases(), 1);
  assert.deepEqual(harness.counters, ["mysqlDomainNamedLockAcquired"]);
  assert.equal(harness.operations.length, 2);
  assert.equal(harness.operations[0][0], "mysqlNamedLock");
  assert.equal(harness.operations[0][1], "counter.write.foreground.localWait");
  assert.ok(harness.operations[0][2] >= 0);
  assert.equal(harness.operations[1][1], "counter.write.foreground.wait");
});

test("named lock distingue la telemetria background", async () => {
  const harness = createHarness();

  await harness.coordinator.run("mirror.write", async () => "written", {
    priority: "background",
  });

  assert.equal(harness.operations[0][1], "mirror.write.background.localWait");
  assert.equal(harness.operations[1][1], "mirror.write.background.wait");
});

test("named lock propaga un timeout tipizzato senza eseguire l'azione", async () => {
  const harness = createHarness({ acquired: 0 });
  let actionCalls = 0;

  await assert.rejects(
    harness.coordinator.run("provider.write", async () => {
      actionCalls += 1;
    }),
    (error) => error?.code === "MYSQL_DOMAIN_NAMED_LOCK_TIMEOUT" &&
      /provider\.write/.test(error.message),
  );

  assert.equal(actionCalls, 0);
  assert.deepEqual(harness.queries, [
    ["SELECT GET_LOCK(?, ?) AS acquired", ["v5bt:test:payment-domain", 7]],
  ]);
  assert.equal(harness.releases(), 1);
  assert.deepEqual(harness.counters, []);
  assert.equal(harness.operations.length, 2);
});

test("named lock accoda localmente prima di occupare una connessione MySQL", async () => {
  const queries = [];
  const counters = [];
  let connectionCalls = 0;
  let releaseFirstAction;
  const firstActionGate = new Promise((resolve) => {
    releaseFirstAction = resolve;
  });
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: true,
    name: "v5bt:test:payment-domain",
    mysqlRepository: {
      getPool: async () => ({
        getConnection: async () => {
          connectionCalls += 1;
          const connectionId = connectionCalls;
          return {
            async query(sql) {
              queries.push([connectionId, sql]);
              if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
              if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
              throw new Error(`Query inattesa: ${sql}`);
            },
            release() {},
          };
        },
      }),
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation() {},
    },
  });

  const executionOrder = [];
  const first = coordinator.run("first", async () => {
    executionOrder.push("first:start");
    await firstActionGate;
    executionOrder.push("first:end");
  });
  const second = coordinator.run("second", async () => {
    executionOrder.push("second");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectionCalls, 1);
  assert.deepEqual(executionOrder, ["first:start"]);
  releaseFirstAction();
  await Promise.all([first, second]);

  assert.equal(connectionCalls, 2);
  assert.deepEqual(executionOrder, ["first:start", "first:end", "second"]);
  assert.equal(queries.filter(([, sql]) => sql.includes("GET_LOCK")).length, 2);
  assert.equal(queries.filter(([, sql]) => sql.includes("RELEASE_LOCK")).length, 2);
  assert.ok(counters.includes("mysqlDomainNamedLockLocalQueued"));
});

test("named lock prosegue con il turno successivo dopo un'azione fallita", async () => {
  let connectionCalls = 0;
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: true,
    name: "v5bt:test:payment-domain",
    mysqlRepository: {
      getPool: async () => ({
        getConnection: async () => {
          connectionCalls += 1;
          return {
            async query(sql) {
              if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
              if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
              throw new Error(`Query inattesa: ${sql}`);
            },
            release() {},
          };
        },
      }),
    },
  });

  const first = coordinator.run("first", async () => {
    throw new Error("azione fallita");
  });
  const second = coordinator.run("second", async () => "completed");

  await assert.rejects(first, /azione fallita/);
  assert.equal(await second, "completed");
  assert.equal(connectionCalls, 2);
});

test("named lock esegue il foreground prima del background gia accodato", async () => {
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const coordinator = createHarness().coordinator;
  const executionOrder = [];
  const active = coordinator.run("foreground-active", async () => {
    executionOrder.push("foreground-active");
    await activeGate;
  });
  const background = coordinator.run("background", async () => {
    executionOrder.push("background");
  }, { priority: "background" });
  const foregroundOne = coordinator.run("foreground-1", async () => {
    executionOrder.push("foreground-1");
  });
  const foregroundTwo = coordinator.run("foreground-2", async () => {
    executionOrder.push("foreground-2");
  });

  await new Promise((resolve) => setImmediate(resolve));
  releaseActive();
  await Promise.all([active, background, foregroundOne, foregroundTwo]);

  assert.deepEqual(executionOrder, [
    "foreground-active",
    "foreground-1",
    "foreground-2",
    "background",
  ]);
});

test("named lock mantiene FIFO tra task della stessa priorita", async () => {
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const coordinator = createHarness().coordinator;
  const executionOrder = [];
  const active = coordinator.run("active", async () => {
    executionOrder.push("active");
    await activeGate;
  });
  const backgroundOne = coordinator.run("background-1", async () => {
    executionOrder.push("background-1");
  }, { priority: "background" });
  const backgroundTwo = coordinator.run("background-2", async () => {
    executionOrder.push("background-2");
  }, { priority: "background" });

  await new Promise((resolve) => setImmediate(resolve));
  releaseActive();
  await Promise.all([active, backgroundOne, backgroundTwo]);

  assert.deepEqual(executionOrder, ["active", "background-1", "background-2"]);
});

test("la prenotazione locale attende fuori dalla lane e il run reentrante acquisisce MySQL una volta", async () => {
  const queries = [];
  let connectionCalls = 0;
  let releaseBackground;
  const backgroundGate = new Promise((resolve) => {
    releaseBackground = resolve;
  });
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: true,
    name: "v5bt:test:payment-domain",
    mysqlRepository: {
      getPool: async () => ({
        getConnection: async () => {
          connectionCalls += 1;
          const connectionId = connectionCalls;
          return {
            async query(sql) {
              queries.push([connectionId, sql]);
              if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
              if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
              throw new Error(`Query inattesa: ${sql}`);
            },
            release() {},
          };
        },
      }),
    },
  });
  const executionOrder = [];
  const background = coordinator.run(
    "paymentDomain",
    async () => {
      executionOrder.push("background:start");
      await backgroundGate;
      executionOrder.push("background:end");
    },
    { priority: "background" },
  );
  const foreground = coordinator.reserveLocal(
    "paymentLane.admission",
    async (reservation) => {
      executionOrder.push("foreground:lane");
      return coordinator.runInLocalReservation(reservation, () =>
        coordinator.run("paymentDomain", async () => {
          executionOrder.push("foreground:write");
          return "written";
        }));
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  executionOrder.push("peer:completed");
  assert.equal(connectionCalls, 1);
  assert.deepEqual(executionOrder, ["background:start", "peer:completed"]);

  releaseBackground();
  assert.equal(await foreground, "written");
  await background;

  assert.deepEqual(executionOrder, [
    "background:start",
    "peer:completed",
    "background:end",
    "foreground:lane",
    "foreground:write",
  ]);
  assert.equal(connectionCalls, 2);
  assert.equal(queries.filter(([, sql]) => sql.includes("GET_LOCK")).length, 2);
  assert.equal(queries.filter(([, sql]) => sql.includes("RELEASE_LOCK")).length, 2);
});

test("la prenotazione locale viene rilasciata dopo un'eccezione reentrante", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.coordinator.reserveLocal(
      "paymentLane.failure",
      (reservation) => harness.coordinator.runInLocalReservation(
        reservation,
        () => harness.coordinator.run("paymentDomain", async () => {
          throw new Error("writer fallito");
        }),
      ),
    ),
    /writer fallito/,
  );

  assert.equal(
    await harness.coordinator.run("after.failure", async () => "completed"),
    "completed",
  );
  assert.equal(harness.releases(), 2);
  assert.equal(
    harness.queries.filter(([sql]) => sql.includes("RELEASE_LOCK")).length,
    2,
  );
});

test("il timeout MySQL reentrante rilascia prenotazione e connessione", async () => {
  let connectionCalls = 0;
  let connectionReleases = 0;
  const queries = [];
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: true,
    name: "v5bt:test:payment-domain",
    timeoutSeconds: 2,
    mysqlRepository: {
      getPool: async () => ({
        getConnection: async () => {
          connectionCalls += 1;
          const connectionId = connectionCalls;
          return {
            async query(sql) {
              queries.push([connectionId, sql]);
              if (sql.includes("GET_LOCK")) {
                return [[{ acquired: connectionId === 1 ? 0 : 1 }]];
              }
              if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
              throw new Error(`Query inattesa: ${sql}`);
            },
            release() {
              connectionReleases += 1;
            },
          };
        },
      }),
    },
  });

  await assert.rejects(
    coordinator.reserveLocal(
      "paymentLane.timeout",
      (reservation) => coordinator.runInLocalReservation(
        reservation,
        () => coordinator.run("paymentDomain", async () => "not-run"),
      ),
    ),
    (error) => error?.code === "MYSQL_DOMAIN_NAMED_LOCK_TIMEOUT",
  );

  assert.equal(await coordinator.run("after.timeout", async () => "completed"), "completed");
  assert.equal(connectionCalls, 2);
  assert.equal(connectionReleases, 2);
  assert.equal(queries.filter(([, sql]) => sql.includes("GET_LOCK")).length, 2);
  assert.equal(queries.filter(([, sql]) => sql.includes("RELEASE_LOCK")).length, 1);
});

test("la prenotazione foreground mantiene la priorita sui task background accodati", async () => {
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const coordinator = createHarness().coordinator;
  const executionOrder = [];
  const active = coordinator.run("active", async () => {
    executionOrder.push("active");
    await activeGate;
  });
  const background = coordinator.run(
    "background",
    async () => executionOrder.push("background"),
    { priority: "background" },
  );
  const foreground = coordinator.reserveLocal(
    "foreground.admission",
    async () => executionOrder.push("foreground:admitted"),
  );

  await new Promise((resolve) => setImmediate(resolve));
  releaseActive();
  await Promise.all([active, background, foreground]);

  assert.deepEqual(executionOrder, [
    "active",
    "foreground:admitted",
    "background",
  ]);
});

test("named lock concede il background dopo otto foreground consecutivi", async () => {
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const coordinator = createHarness().coordinator;
  const executionOrder = [];
  const active = coordinator.run("foreground-0", async () => {
    executionOrder.push("foreground-0");
    await activeGate;
  });
  const background = coordinator.run("background", async () => {
    executionOrder.push("background");
  }, { priority: "background" });
  const foreground = Array.from({ length: 9 }, (_, index) =>
    coordinator.run(`foreground-${index + 1}`, async () => {
      executionOrder.push(`foreground-${index + 1}`);
    }));

  await new Promise((resolve) => setImmediate(resolve));
  releaseActive();
  await Promise.all([active, background, ...foreground]);

  assert.deepEqual(executionOrder, [
    "foreground-0",
    "foreground-1",
    "foreground-2",
    "foreground-3",
    "foreground-4",
    "foreground-5",
    "foreground-6",
    "foreground-7",
    "background",
    "foreground-8",
    "foreground-9",
  ]);
});

test("named lock disabilitato esegue direttamente senza richiedere MySQL", async () => {
  let poolCalls = 0;
  let actionCalls = 0;
  const coordinator = createMysqlNamedLockCoordinator({
    enabled: false,
    mysqlRepository: {
      getPool: async () => {
        poolCalls += 1;
        throw new Error("non deve essere invocato");
      },
    },
  });

  const result = await coordinator.run("disabled.write", async () => {
    actionCalls += 1;
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(actionCalls, 1);
  assert.equal(poolCalls, 0);
});
