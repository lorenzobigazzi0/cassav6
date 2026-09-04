import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import * as postgresql from "../db/postgresql/index.js";

const {
  createPostgresqlIdempotencyKeysRepository,
  createPostgresqlIdempotencyService,
  createPostgresqlTransactionRunner,
  hashPostgresqlIdempotencyRequest,
  POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT,
} = postgresql;

const REQUEST_HASH = "a".repeat(64);

function idempotencyRow(overrides = {}) {
  return {
    scope: "orders.create",
    key: "idem-1",
    request_hash: REQUEST_HASH,
    status: "completed",
    response_code: 201,
    response_json: { orderId: "order-1" },
    created_at: "2026-08-31T12:00:00.000Z",
    completed_at: "2026-08-31T12:00:01.000Z",
    expires_at: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

function repositoryHarness(results = []) {
  const queue = [...results];
  const queries = [];
  const connectionLabels = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? { rowCount: 0, rows: [] };
    },
  };
  const runtime = {
    async withConnection(label, callback) {
      connectionLabels.push(label);
      return callback(client);
    },
    async withTransaction(_label, callback) {
      return callback(client, { attempt: 1, maxAttempts: 3 });
    },
  };
  return { client, connectionLabels, queries, runtime };
}

test("MIG-025 esporta repository e servizio con scritture obbligatoriamente transazionali", () => {
  assert.equal(typeof createPostgresqlIdempotencyKeysRepository, "function");
  assert.equal(typeof createPostgresqlIdempotencyService, "function");
  assert.equal(POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT.domain, "messaging.idempotency-keys");
  assert.deepEqual(POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT.methods, [
    { name: "begin", kind: "write", transaction: "required" },
    { name: "finish", kind: "write", transaction: "required" },
    { name: "get", kind: "read", transaction: "none" },
  ]);
});

test("hash richiesta e canonico, deterministico e rifiuta valori non JSON", () => {
  assert.equal(
    hashPostgresqlIdempotencyRequest({ b: 2, a: { y: true, x: [1, null] } }),
    hashPostgresqlIdempotencyRequest({ a: { x: [1, null], y: true }, b: 2 }),
  );
  assert.match(hashPostgresqlIdempotencyRequest({ orderId: "order-1" }), /^[a-f0-9]{64}$/);
  assert.throws(() => hashPostgresqlIdempotencyRequest({ amount: Number.NaN }), /JSON/);
  assert.throws(() => hashPostgresqlIdempotencyRequest({ value: 1n }), /JSON/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => hashPostgresqlIdempotencyRequest(cyclic), /JSON/);
});

test("begin crea processing con clock DB, TTL bounded e senza transazione autonoma", async () => {
  const row = idempotencyRow({ status: "processing", response_code: null, response_json: null, completed_at: null });
  const harness = repositoryHarness([{ rowCount: 1, rows: [row] }]);
  const repository = createPostgresqlIdempotencyKeysRepository({ runtime: harness.runtime });

  const result = await repository.begin(harness.client, {
    scope: "orders.create",
    key: "idem-1",
    requestHash: REQUEST_HASH,
    ttlMs: 86_400_000,
  });

  assert.equal(result.state, "created");
  assert.equal(result.record.status, "processing");
  assert.deepEqual(harness.connectionLabels, []);
  assert.equal(harness.queries.length, 1);
  assert.match(harness.queries[0].sql, /INSERT INTO messaging\.idempotency_keys/i);
  assert.match(harness.queries[0].sql, /ON CONFLICT \(scope, key\) DO NOTHING/i);
  assert.match(harness.queries[0].sql, /now\(\)/i);
  assert.doesNotMatch(harness.queries[0].sql, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.deepEqual(harness.queries[0].parameters, ["orders.create", "idem-1", REQUEST_HASH, 86_400_000]);
});

test("begin rilegge con lock e produce replay deterministico per lo stesso hash", async () => {
  const row = idempotencyRow();
  const harness = repositoryHarness([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [row] },
  ]);
  const repository = createPostgresqlIdempotencyKeysRepository({ runtime: harness.runtime });

  const result = await repository.begin(harness.client, {
    scope: "orders.create",
    key: "idem-1",
    requestHash: REQUEST_HASH,
  });

  assert.equal(result.state, "completed");
  assert.equal(result.responseCode, 201);
  assert.deepEqual(result.response, { orderId: "order-1" });
  assert.match(harness.queries[1].sql, /FOR UPDATE/i);
});

test("begin segnala conflict per stessa coppia scope/key con hash differente", async () => {
  const harness = repositoryHarness([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [idempotencyRow()] },
  ]);
  const repository = createPostgresqlIdempotencyKeysRepository({ runtime: harness.runtime });
  const result = await repository.begin(harness.client, {
    scope: "orders.create",
    key: "idem-1",
    requestHash: "b".repeat(64),
  });
  assert.equal(result.state, "conflict");
  assert.equal(result.record.requestHash, REQUEST_HASH);
});

test("finish consente soltanto una transizione terminale conditional e bounded", async () => {
  const harness = repositoryHarness([{ rowCount: 1, rows: [idempotencyRow()] }]);
  const repository = createPostgresqlIdempotencyKeysRepository({ runtime: harness.runtime });
  const response = { orderId: "order-1" };

  const record = await repository.finish(harness.client, {
    scope: "orders.create",
    key: "idem-1",
    requestHash: REQUEST_HASH,
    status: "completed",
    responseCode: 201,
    response,
  });
  response.orderId = "mutated";

  assert.equal(record.response.orderId, "order-1");
  assert.match(harness.queries[0].sql, /status = 'processing'/i);
  assert.match(harness.queries[0].sql, /completed_at\s*=\s*now\(\)/i);
  assert.deepEqual(harness.queries[0].parameters, [
    "orders.create", "idem-1", REQUEST_HASH, "completed", 201, { orderId: "order-1" },
  ]);
  await assert.rejects(repository.finish(harness.client, {
    scope: "orders.create", key: "idem-1", requestHash: REQUEST_HASH,
    status: "processing", responseCode: 201, response: {},
  }), /status/);
  await assert.rejects(repository.finish(harness.client, {
    scope: "orders.create", key: "idem-1", requestHash: REQUEST_HASH,
    status: "completed", responseCode: 700, response: {},
  }), /responseCode/);
});

test("servizio esegue business write e finish nella stessa transazione", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { rowCount: 1, rows: [] }; } };
  const runtime = {
    async withTransaction(label, callback) {
      calls.push(`tx:${label}`);
      return callback(client);
    },
  };
  const repository = {
    async begin(receivedClient) {
      assert.equal(receivedClient, client);
      calls.push("begin");
      return { state: "created", record: { status: "processing" } };
    },
    async finish(receivedClient, input) {
      assert.equal(receivedClient, client);
      calls.push(`finish:${input.status}`);
      return { ...input, createdAt: "now", completedAt: "now", expiresAt: "later" };
    },
    async get() { return null; },
  };
  const service = createPostgresqlIdempotencyService({ runtime, repository });

  const result = await service.execute({
    scope: "orders.create",
    key: "idem-1",
    request: { orderId: "order-1" },
    async operation(receivedClient) {
      assert.equal(receivedClient, client);
      await receivedClient.query("INSERT INTO business_probe(id) VALUES ($1)", ["order-1"]);
      return { responseCode: 201, response: { orderId: "order-1" } };
    },
  });

  assert.equal(result.state, "executed");
  assert.deepEqual(calls, [
    "tx:idempotency:orders.create", "begin", "INSERT INTO business_probe(id) VALUES ($1)", "finish:completed",
  ]);
});

test("servizio non riesegue la callback su replay o conflict", async () => {
  let operations = 0;
  let beginResult = {
    state: "completed",
    record: idempotencyRow(),
    responseCode: 201,
    response: { orderId: "order-1" },
  };
  const repository = {
    async begin() { return beginResult; },
    async finish() { throw new Error("finish inatteso"); },
    async get() { return null; },
  };
  const runtime = { async withTransaction(_label, callback) { return callback({ query() {} }); } };
  const service = createPostgresqlIdempotencyService({ runtime, repository });
  const input = {
    scope: "orders.create", key: "idem-1", request: { orderId: "order-1" },
    async operation() { operations += 1; },
  };

  const replay = await service.execute(input);
  assert.equal(replay.state, "replayed");
  assert.deepEqual(replay.response, { orderId: "order-1" });
  beginResult = { state: "conflict", record: idempotencyRow() };
  const conflict = await service.execute(input);
  assert.equal(conflict.state, "conflict");
  assert.equal(operations, 0);
});

test("errore applicativo esegue rollback e non lascia un claim processing", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    },
  };
  const withTransaction = createPostgresqlTransactionRunner({
    async withConnection(_label, callback) { return callback(client); },
  });
  const runtime = { withTransaction };
  const repository = {
    async begin() { queries.push("CLAIM"); return { state: "created", record: { status: "processing" } }; },
    async finish() { queries.push("FINISH"); },
    async get() { return null; },
  };
  const service = createPostgresqlIdempotencyService({ runtime, repository });
  const expected = new Error("business failed");

  await assert.rejects(service.execute({
    scope: "orders.create", key: "idem-rollback", request: {},
    async operation(receivedClient) {
      await receivedClient.query("INSERT INTO business_probe(id) VALUES ('rollback')");
      throw expected;
    },
  }), (error) => error === expected);

  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL READ COMMITTED", "CLAIM",
    "INSERT INTO business_probe(id) VALUES ('rollback')", "ROLLBACK",
  ]);
});

test("migration MIG-025 vincola stato, terminalita, immutabilita e least privilege", async () => {
  const sql = await fs.readFile(
    new URL("../db/postgresql/migrations/004_idempotency_store_contract.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /idempotency_keys_request_hash_format/i);
  assert.match(sql, /status IN \('processing', 'completed', 'failed'\)/i);
  assert.match(sql, /ADD COLUMN completed_at timestamptz/i);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER idempotency_keys_require_terminal/i);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(sql, /CREATE TRIGGER idempotency_keys_enforce_transition/i);
  assert.match(sql, /OLD\.status <> 'processing'/i);
  assert.match(sql, /ERRCODE = '55000'/i);
  assert.match(sql, /REVOKE DELETE, TRUNCATE ON messaging\.idempotency_keys FROM cassav6_runtime/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
});
