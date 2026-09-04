import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import * as postgresql from "../db/postgresql/index.js";

const {
  createPostgresqlAuditEventsRepository,
  createPostgresqlTransactionRunner,
  POSTGRESQL_AUDIT_EVENTS_REPOSITORY_CONTRACT,
} = postgresql;

function auditRow(overrides = {}) {
  return {
    id: "audit-1",
    domain: "orders",
    aggregate_type: "order",
    aggregate_id: "order-1",
    action: "order.created",
    actor_user_id: "user-1",
    actor_username: "admin",
    occurred_at: "2026-08-31T12:00:00.000Z",
    payload: { source: "test" },
    ...overrides,
  };
}

function runtimeHarness(results = []) {
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

test("MIG-024 esporta il contratto repository con append obbligatoriamente transazionale", () => {
  assert.equal(typeof createPostgresqlAuditEventsRepository, "function");
  assert.equal(POSTGRESQL_AUDIT_EVENTS_REPOSITORY_CONTRACT.domain, "audit.events");
  assert.deepEqual(
    POSTGRESQL_AUDIT_EVENTS_REPOSITORY_CONTRACT.methods,
    [
      { name: "append", kind: "write", transaction: "required" },
      { name: "getById", kind: "read", transaction: "none" },
      { name: "listByAggregate", kind: "read", transaction: "none" },
    ],
  );
});

test("append usa il client del chiamante, il clock DB e un INSERT senza upsert", async () => {
  const harness = runtimeHarness([{ rowCount: 1, rows: [auditRow()] }]);
  const repository = createPostgresqlAuditEventsRepository({ runtime: harness.runtime });

  const event = await repository.append(harness.client, {
    id: "audit-1",
    domain: "orders",
    aggregateType: "order",
    aggregateId: "order-1",
    action: "order.created",
    actorUserId: "user-1",
    actorUsername: "admin",
    payload: { source: "test" },
  });

  assert.equal(event.id, "audit-1");
  assert.equal(event.occurredAt, "2026-08-31T12:00:00.000Z");
  assert.deepEqual(harness.connectionLabels, []);
  assert.equal(harness.queries.length, 1);
  assert.match(harness.queries[0].sql, /INSERT INTO audit\.events/i);
  assert.match(harness.queries[0].sql, /RETURNING/i);
  assert.doesNotMatch(harness.queries[0].sql, /ON CONFLICT|UPDATE|DELETE/i);
  const insertClause = harness.queries[0].sql.slice(0, harness.queries[0].sql.indexOf("VALUES"));
  assert.doesNotMatch(insertClause, /\boccurred_at\b/i);
  assert.deepEqual(harness.queries[0].parameters, [
    "audit-1",
    "orders",
    "order",
    "order-1",
    "order.created",
    "user-1",
    "admin",
    { source: "test" },
  ]);
});

test("ID audit duplicato propaga il vincolo e non viene convertito in successo", async () => {
  const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
  const harness = runtimeHarness([duplicate]);
  const repository = createPostgresqlAuditEventsRepository({ runtime: harness.runtime });

  await assert.rejects(
    repository.append(harness.client, {
      id: "audit-1",
      domain: "orders",
      action: "order.created",
      payload: {},
    }),
    (error) => error === duplicate,
  );
  assert.equal(harness.queries.length, 1);
  assert.doesNotMatch(harness.queries[0].sql, /ON CONFLICT/i);
});

test("validazione rifiuta dati ambigui e payload sensibili prima del database", async () => {
  const harness = runtimeHarness();
  const repository = createPostgresqlAuditEventsRepository({ runtime: harness.runtime });
  const valid = { id: "audit-1", domain: "orders", action: "order.created", payload: {} };

  await assert.rejects(repository.append(harness.client, { ...valid, id: "" }), /id/);
  await assert.rejects(repository.append(harness.client, { ...valid, aggregateType: "order" }), /aggregate/);
  await assert.rejects(repository.append(harness.client, { ...valid, occurredAt: "2020-01-01T00:00:00Z" }), /occurredAt/);
  await assert.rejects(repository.append(harness.client, { ...valid, payload: [] }), /payload/);
  await assert.rejects(repository.append(harness.client, { ...valid, payload: { nested: { password: "x" } } }), /sensibile/);
  await assert.rejects(repository.append(harness.client, { ...valid, payload: { token: "x" } }), /sensibile/);
  await assert.rejects(repository.append(null, valid), /client transazionale/);
  assert.deepEqual(harness.queries, []);
});

test("letture puntuali e per aggregato sono bounded e deterministicamente ordinate", async () => {
  const harness = runtimeHarness([
    { rowCount: 1, rows: [auditRow()] },
    { rowCount: 2, rows: [auditRow(), auditRow({ id: "audit-0" })] },
  ]);
  const repository = createPostgresqlAuditEventsRepository({ runtime: harness.runtime });

  assert.equal((await repository.getById("audit-1")).action, "order.created");
  const events = await repository.listByAggregate({
    aggregateType: "order",
    aggregateId: "order-1",
    beforeOccurredAt: "2026-09-01T00:00:00.000Z",
    limit: 25,
  });
  assert.equal(events.length, 2);
  assert.deepEqual(harness.connectionLabels, ["audit-events:get-by-id", "audit-events:list-by-aggregate"]);
  assert.match(harness.queries[0].sql, /FROM audit\.event_ids registry/i);
  assert.match(harness.queries[0].sql, /event\.occurred_at = registry\.occurred_at/i);
  assert.match(harness.queries[1].sql, /ORDER BY occurred_at DESC, id DESC/i);
  assert.match(harness.queries[1].sql, /LIMIT \$4/i);
  assert.deepEqual(harness.queries[1].parameters, [
    "order",
    "order-1",
    "2026-09-01T00:00:00.000Z",
    25,
  ]);
  await assert.rejects(
    repository.listByAggregate({ aggregateType: "order", aggregateId: "order-1", limit: 501 }),
    /limit/,
  );
});

function atomicHarness({ failAudit = false } = {}) {
  const queries = [];
  const auditFailure = Object.assign(new Error("audit insert failed"), { code: "23514" });
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (failAudit && /INSERT INTO audit\.events/i.test(sql)) throw auditFailure;
      if (/INSERT INTO audit\.events/i.test(sql)) return { rowCount: 1, rows: [auditRow()] };
      return { rowCount: 1, rows: [] };
    },
  };
  async function withConnection(_label, callback) {
    return callback(client);
  }
  const withTransaction = createPostgresqlTransactionRunner({ withConnection });
  return {
    auditFailure,
    queries,
    runtime: { withConnection, withTransaction },
  };
}

test("errore dopo business write e audit esegue rollback di entrambi", async () => {
  const harness = atomicHarness();
  const repository = createPostgresqlAuditEventsRepository({ runtime: harness.runtime });
  const expected = new Error("rollback probe");

  await assert.rejects(
    harness.runtime.withTransaction("audit-atomic-rollback", async (client) => {
      await client.query("INSERT INTO business_probe(id) VALUES ($1)", ["business-1"]);
      await repository.append(client, {
        id: "audit-1",
        domain: "probe",
        aggregateType: "probe",
        aggregateId: "business-1",
        action: "probe.created",
        payload: {},
      });
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.deepEqual(harness.queries.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" ")), [
    "BEGIN ISOLATION LEVEL",
    "INSERT INTO business_probe(id)",
    "INSERT INTO audit.events",
    "ROLLBACK",
  ]);
});

test("fallimento audit annulla la business write e conserva l'errore originale", async () => {
  const harness = atomicHarness({ failAudit: true });
  const repository = createPostgresqlAuditEventsRepository({ runtime: harness.runtime });

  await assert.rejects(
    harness.runtime.withTransaction("audit-required", async (client) => {
      await client.query("INSERT INTO business_probe(id) VALUES ($1)", ["business-1"]);
      await repository.append(client, {
        id: "audit-1",
        domain: "probe",
        action: "probe.created",
        payload: {},
      });
    }),
    (error) => error === harness.auditFailure,
  );
  assert.equal(harness.queries.at(-1).sql, "ROLLBACK");
  assert.equal(harness.queries.some(({ sql }) => sql === "COMMIT"), false);
});

test("migration MIG-024 protegge append-only, coerenza aggregato e payload object", async () => {
  const sql = await fs.readFile(
    new URL("../db/postgresql/migrations/003_audit_events_append_only.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON audit\.events FROM cassav6_runtime/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION audit\.reject_event_mutation\(\)/i);
  assert.match(sql, /ERRCODE\s*=\s*'55000'/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON audit\.events/i);
  assert.match(sql, /BEFORE TRUNCATE ON audit\.events/i);
  assert.match(sql, /audit_events_aggregate_pair_coherent/i);
  assert.match(sql, /jsonb_typeof\(payload\) = 'object'/i);
  assert.match(sql, /NOT VALID[\s\S]+VALIDATE CONSTRAINT/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
});
