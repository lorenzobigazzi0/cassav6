import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import * as postgresql from "../db/postgresql/index.js";

const {
  createPostgresqlRetentionRepository,
  POSTGRESQL_RETENTION_REPOSITORY_CONTRACT,
} = postgresql;

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
  };
  return { client, connectionLabels, queries, runtime };
}

test("MIG-026 esporta un repository di sola osservabilita", () => {
  assert.equal(typeof createPostgresqlRetentionRepository, "function");
  assert.equal(POSTGRESQL_RETENTION_REPOSITORY_CONTRACT.domain, "app-meta.retention");
  assert.deepEqual(POSTGRESQL_RETENTION_REPOSITORY_CONTRACT.methods, [
    { name: "listPolicies", kind: "read", transaction: "none" },
    { name: "getTableGrowth", kind: "read", transaction: "none" },
    { name: "getRetentionCandidates", kind: "read", transaction: "none" },
  ]);
});

test("repository mappa policy proposte e conserva esplicito lo stato disabled", async () => {
  const harness = runtimeHarness([{ rows: [{
    target: "audit.events",
    retention_days: 1095,
    strategy: "drop_partition",
    enabled: false,
    legally_required: false,
    decision_ref: "RET-01:TODO",
    approved_at: null,
    notes: "proposta",
    updated_at: "2026-08-31T12:00:00.000Z",
  }] }]);
  const repository = createPostgresqlRetentionRepository({ runtime: harness.runtime });
  const policies = await repository.listPolicies();
  assert.deepEqual(policies, [{
    target: "audit.events",
    retentionDays: 1095,
    strategy: "drop_partition",
    enabled: false,
    legallyRequired: false,
    decisionRef: "RET-01:TODO",
    approvedAt: null,
    notes: "proposta",
    updatedAt: "2026-08-31T12:00:00.000Z",
  }]);
  assert.equal(harness.connectionLabels[0], "retention:list-policies");
  assert.match(harness.queries[0].sql, /ORDER BY target/i);
});

test("vista crescita e bounded e restituisce metriche numeriche", async () => {
  const harness = runtimeHarness([{ rows: [{
    schema_name: "audit",
    table_name: "events",
    relation_kind: "table",
    total_bytes: "16384",
    approx_rows: "12",
    dead_rows: "2",
    last_analyze_at: "2026-08-31T12:00:00.000Z",
  }] }]);
  const repository = createPostgresqlRetentionRepository({ runtime: harness.runtime });
  const growth = await repository.getTableGrowth({ limit: 25 });
  assert.deepEqual(growth[0], {
    schemaName: "audit",
    tableName: "events",
    relationKind: "table",
    totalBytes: 16384,
    approxRows: 12,
    deadRows: 2,
    lastAnalyzeAt: "2026-08-31T12:00:00.000Z",
  });
  assert.match(harness.queries[0].sql, /app_meta\.v_table_growth/i);
  assert.deepEqual(harness.queries[0].parameters, [25]);
  await assert.rejects(repository.getTableGrowth({ limit: 501 }), /limit/);
});

test("vista candidati distingue eleggibili da policy abilitate", async () => {
  const harness = runtimeHarness([{ rows: [{
    target: "messaging.event_outbox",
    retention_days: 30,
    strategy: "delete_batched",
    enabled: false,
    eligible_rows: "7",
    oldest_eligible_at: "2026-06-01T00:00:00.000Z",
  }] }]);
  const repository = createPostgresqlRetentionRepository({ runtime: harness.runtime });
  assert.deepEqual(await repository.getRetentionCandidates(), [{
    target: "messaging.event_outbox",
    retentionDays: 30,
    strategy: "delete_batched",
    enabled: false,
    eligibleRows: 7,
    oldestEligibleAt: "2026-06-01T00:00:00.000Z",
  }]);
  assert.match(harness.queries[0].sql, /app_meta\.v_retention_candidates/i);
});

test("migration MIG-026 e fail-closed, owner-only e non cancella domini protetti", async () => {
  const sql = await fs.readFile(
    new URL("../db/postgresql/migrations/005_retention_control_plane.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE app_meta\.retention_policies/i);
  assert.match(sql, /enabled boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /RET-01:TODO/i);
  assert.match(sql, /CREATE OR REPLACE VIEW app_meta\.v_table_growth/i);
  assert.match(sql, /CREATE OR REPLACE VIEW app_meta\.v_retention_candidates/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_meta\.purge_processed_outbox/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_meta\.purge_expired_idempotency/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /IF NOT policy_enabled THEN/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_meta\.purge_processed_outbox/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_meta\.purge_expired_idempotency/i);
  assert.match(sql, /GRANT USAGE ON SCHEMA app_meta TO cassav6_runtime/i);
  assert.match(sql, /GRANT SELECT ON app_meta\.retention_policies/i);
  assert.doesNotMatch(sql, /GRANT[^;]*EXECUTE[^;]*cassav6_runtime/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+(?:payments|fiscal)\./i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
});

test("migration RET-01 approva le finestre senza attivare alcuna cancellazione", async () => {
  const sql = await fs.readFile(
    new URL("../db/postgresql/migrations/007_ret01_retention_approval.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /UPDATE app_meta\.retention_policies/i);
  assert.match(sql, /decision_ref = 'RET-01:APPROVED-2026-09-02'/);
  assert.match(sql, /approved_at = COALESCE\(approved_at, now\(\)\)/i);
  // Approvazione e attivazione restano due passi distinti.
  assert.doesNotMatch(sql, /SET[^;]*enabled\s*=\s*true/i);
  assert.match(sql, /WHERE legally_required = false/i);
  assert.match(sql, /AND strategy <> 'none'/);
  assert.match(sql, /AND decision_ref ~\* 'TODO'/);
  // Le policy protette non vengono toccate ne cancellate.
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+(?:payments|fiscal)\./i);
  assert.doesNotMatch(sql, /LEGAL:NO_RETENTION'\s*,/i);
  // Postcondizioni fail-closed dentro la migration stessa.
  assert.match(sql, /nessuna policy deve risultare abilitata/i);
  assert.match(sql, /attese 8 policy approvate/i);
  assert.match(sql, /attese 5 policy legalmente protette/i);
  assert.match(sql, /ERRCODE = '55000'/);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
});
