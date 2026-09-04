import assert from "node:assert/strict";
import test from "node:test";

import * as postgresql from "../db/postgresql/index.js";

const {
  createPostgresqlTransactionRunner,
  postgresqlTransactionErrorCode,
  POSTGRESQL_RETRYABLE_TRANSACTION_CODES,
} = postgresql;

function sqlStateError(code, message = `database failure ${code}`) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createHarness(options = {}) {
  const queries = [];
  const connectionLabels = [];
  let connectionCount = 0;

  async function withConnection(label, callback) {
    connectionCount += 1;
    const connection = connectionCount;
    connectionLabels.push(label);
    const client = {
      connection,
      async query(sql, parameters) {
        queries.push({ connection, parameters, sql });
        if (options.onQuery) {
          return options.onQuery({ connection, parameters, queries, sql });
        }
        return { rowCount: 0, rows: [] };
      },
    };
    return callback(client);
  }

  return {
    connectionLabels,
    get connectionCount() {
      return connectionCount;
    },
    queries,
    withConnection,
  };
}

function createMetrics() {
  const counters = new Map();
  const operations = [];
  return {
    counters,
    operations,
    runtimeMetrics: {
      incrementCounter(name) {
        counters.set(name, (counters.get(name) ?? 0) + 1);
      },
      recordOperation(kind, label, durationMs) {
        operations.push({ durationMs, kind, label });
      },
    },
  };
}

test("MIG-021 esporta runner, codici retryable e lettura SQLSTATE", () => {
  assert.equal(typeof createPostgresqlTransactionRunner, "function");
  assert.equal(typeof postgresqlTransactionErrorCode, "function");
  assert.deepEqual([...POSTGRESQL_RETRYABLE_TRANSACTION_CODES].sort(), ["40001", "40P01"]);

  const root = sqlStateError("40P01");
  const wrapped = new Error("wrapper", { cause: root });
  assert.equal(postgresqlTransactionErrorCode(wrapped), "40P01");
  assert.equal(postgresqlTransactionErrorCode(new Error("deadlock detected")), null);
});

test("successo: BEGIN esplicito, callback e COMMIT sulla stessa connessione", async () => {
  const harness = createHarness();
  const metrics = createMetrics();
  const contexts = [];
  const withTransaction = createPostgresqlTransactionRunner({
    nowMs: (() => {
      let value = 0;
      return () => (value += 5);
    })(),
    runtimeMetrics: metrics.runtimeMetrics,
    withConnection: harness.withConnection,
  });

  const result = await withTransaction("crea-documento", async (client, context) => {
    contexts.push(context);
    await client.query("INSERT INTO docs(id) VALUES ($1)", [7]);
    return { id: 7 };
  });

  assert.deepEqual(result, { id: 7 });
  assert.deepEqual(harness.queries.map(({ connection, sql }) => [connection, sql]), [
    [1, "BEGIN ISOLATION LEVEL READ COMMITTED"],
    [1, "INSERT INTO docs(id) VALUES ($1)"],
    [1, "COMMIT"],
  ]);
  assert.deepEqual(contexts, [{ attempt: 1, maxAttempts: 3 }]);
  assert.equal(metrics.counters.get("postgresTransactions"), 1);
  assert.equal(metrics.counters.get("postgresTransactionAttempts"), 1);
  assert.equal(metrics.counters.get("postgresTransactionCommits"), 1);
  assert.equal(metrics.counters.get("postgresTransactionRetries") ?? 0, 0);
});

test("errore permanente: ROLLBACK e propagazione dello stesso errore senza retry", async () => {
  const harness = createHarness();
  const delays = [];
  const expected = sqlStateError("23505", "payload-riservato");
  const withTransaction = createPostgresqlTransactionRunner({
    sleep: async (delayMs) => delays.push(delayMs),
    withConnection: harness.withConnection,
  });

  await assert.rejects(
    withTransaction("vincolo-unico", async () => {
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.deepEqual(harness.queries.map(({ sql }) => sql), [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "ROLLBACK",
  ]);
  assert.equal(harness.connectionCount, 1);
  assert.deepEqual(delays, []);
});

test("serialization failure: rollback, backoff deterministico e nuovo tentativo", async () => {
  const harness = createHarness();
  const delays = [];
  const contexts = [];
  let callbackCalls = 0;
  const withTransaction = createPostgresqlTransactionRunner({
    sleep: async (delayMs) => delays.push(delayMs),
    withConnection: harness.withConnection,
  });

  const value = await withTransaction("serializable-counter", async (client, context) => {
    callbackCalls += 1;
    contexts.push(context);
    await client.query("SELECT value FROM counter");
    if (callbackCalls === 1) throw sqlStateError("40001");
    return "ok";
  }, {
    baseDelayMs: 25,
    isolationLevel: "serializable",
    maxAttempts: 3,
    maxDelayMs: 100,
  });

  assert.equal(value, "ok");
  assert.equal(harness.connectionCount, 2);
  assert.deepEqual(harness.connectionLabels, [
    "transaction:serializable-counter:attempt:1",
    "transaction:serializable-counter:attempt:2",
  ]);
  assert.deepEqual(harness.queries.map(({ sql }) => sql), [
    "BEGIN ISOLATION LEVEL SERIALIZABLE",
    "SELECT value FROM counter",
    "ROLLBACK",
    "BEGIN ISOLATION LEVEL SERIALIZABLE",
    "SELECT value FROM counter",
    "COMMIT",
  ]);
  assert.deepEqual(contexts, [
    { attempt: 1, maxAttempts: 3 },
    { attempt: 2, maxAttempts: 3 },
  ]);
  assert.deepEqual(delays, [25]);
});

test("deadlock nella catena cause esaurisce i tentativi con backoff limitato", async () => {
  const harness = createHarness();
  const delays = [];
  const errors = [];
  const metrics = createMetrics();
  const withTransaction = createPostgresqlTransactionRunner({
    runtimeMetrics: metrics.runtimeMetrics,
    sleep: async (delayMs) => delays.push(delayMs),
    withConnection: harness.withConnection,
  });

  await assert.rejects(
    withTransaction("deadlock", async () => {
      const root = sqlStateError("40P01", "segreto-db");
      const wrapped = new Error("errore-app", { cause: root });
      errors.push(wrapped);
      throw wrapped;
    }, {
      baseDelayMs: 20,
      maxAttempts: 3,
      maxDelayMs: 30,
    }),
    (error) => error === errors.at(-1),
  );

  assert.equal(harness.connectionCount, 3);
  assert.deepEqual(delays, [20, 30]);
  assert.equal(metrics.counters.get("postgresTransactionRollbacks"), 3);
  assert.equal(metrics.counters.get("postgresTransactionRetries"), 2);
  assert.equal(metrics.counters.get("postgresTransactionFailures"), 1);
});

test("serialization failure durante COMMIT viene ritentato dopo rollback", async () => {
  const harness = createHarness({
    onQuery({ connection, sql }) {
      if (connection === 1 && sql === "COMMIT") throw sqlStateError("40001");
      return { rowCount: 0, rows: [] };
    },
  });
  let callbackCalls = 0;
  const withTransaction = createPostgresqlTransactionRunner({
    sleep: async () => {},
    withConnection: harness.withConnection,
  });

  await withTransaction("commit-retry", async () => {
    callbackCalls += 1;
  });

  assert.equal(callbackCalls, 2);
  assert.deepEqual(harness.queries.map(({ sql }) => sql), [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "COMMIT",
    "ROLLBACK",
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "COMMIT",
  ]);
});

test("errore ambiguo durante COMMIT non viene ritentato", async () => {
  const expected = sqlStateError("ECONNRESET", "password-nel-messaggio");
  const harness = createHarness({
    onQuery({ sql }) {
      if (sql === "COMMIT") throw expected;
      return { rowCount: 0, rows: [] };
    },
  });
  const withTransaction = createPostgresqlTransactionRunner({
    sleep: async () => assert.fail("non deve attendere un retry"),
    withConnection: harness.withConnection,
  });

  await assert.rejects(
    withTransaction("commit-ambiguo", async () => "value"),
    (error) => error === expected,
  );
  assert.equal(harness.connectionCount, 1);
  assert.deepEqual(harness.queries.map(({ sql }) => sql), [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "COMMIT",
    "ROLLBACK",
  ]);
});

test("fallimento ROLLBACK conserva l'errore primario e blocca il retry", async () => {
  const primary = sqlStateError("40001", "primary-secret");
  const rollback = sqlStateError("08006", "rollback-secret");
  const harness = createHarness({
    onQuery({ sql }) {
      if (sql === "ROLLBACK") throw rollback;
      return { rowCount: 0, rows: [] };
    },
  });
  const withTransaction = createPostgresqlTransactionRunner({
    sleep: async () => assert.fail("rollback fallito: retry vietato"),
    withConnection: harness.withConnection,
  });

  await assert.rejects(
    withTransaction("rollback-failure", async () => {
      throw primary;
    }),
    (error) => error === primary && error.rollbackError === rollback,
  );
  assert.equal(harness.connectionCount, 1);
});

test("BEGIN fallito non esegue rollback e non viene ritentato", async () => {
  const expected = sqlStateError("40001");
  const harness = createHarness({
    onQuery({ sql }) {
      if (sql.startsWith("BEGIN")) throw expected;
      return { rowCount: 0, rows: [] };
    },
  });
  const withTransaction = createPostgresqlTransactionRunner({
    sleep: async () => assert.fail("BEGIN non riuscito: retry vietato"),
    withConnection: harness.withConnection,
  });

  await assert.rejects(
    withTransaction("begin-failure", async () => {}),
    (error) => error === expected,
  );
  assert.deepEqual(harness.queries.map(({ sql }) => sql), [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
  ]);
});

test("opzioni e callback sono validate prima di acquisire una connessione", async () => {
  const harness = createHarness();
  const withTransaction = createPostgresqlTransactionRunner({
    withConnection: harness.withConnection,
  });

  await assert.rejects(
    withTransaction("unsafe", async () => {}, { isolationLevel: "READ COMMITTED; DROP TABLE users" }),
    /isolationLevel/,
  );
  await assert.rejects(
    withTransaction("attempts", async () => {}, { maxAttempts: 6 }),
    /maxAttempts/,
  );
  await assert.rejects(
    withTransaction("callback", null),
    /callback/,
  );
  assert.equal(harness.connectionCount, 0);
});

test("errori di metriche e logger non alterano commit o retry e non espongono messaggi", async () => {
  const harness = createHarness();
  const warnings = [];
  let calls = 0;
  const withTransaction = createPostgresqlTransactionRunner({
    logger: {
      warn(message) {
        warnings.push(message);
        throw new Error("logger rotto");
      },
    },
    runtimeMetrics: {
      incrementCounter() {
        throw new Error("metriche rotte");
      },
      recordOperation() {
        throw new Error("metriche rotte");
      },
    },
    sleep: async () => {},
    withConnection: harness.withConnection,
  });

  const result = await withTransaction("safe-label", async () => {
    calls += 1;
    if (calls === 1) throw sqlStateError("40001", "segreto-da-non-loggare");
    return "committed";
  });

  assert.equal(result, "committed");
  assert.equal(warnings.length, 1);
  assert.equal(warnings.join(" ").includes("segreto-da-non-loggare"), false);
});
