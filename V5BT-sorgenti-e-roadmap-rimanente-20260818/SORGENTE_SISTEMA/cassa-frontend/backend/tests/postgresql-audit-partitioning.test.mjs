import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

const migrationUrl = new URL(
  "../db/postgresql/migrations/006_audit_events_partitioned_retention.sql",
  import.meta.url,
);

test("MIG-026 follow-up converte audit.events solo quando e vuota", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");

  assert.match(sql, /LOCK TABLE audit\.events IN ACCESS EXCLUSIVE MODE/i);
  assert.match(sql, /SELECT count\(\*\) INTO existing_rows FROM audit\.events/i);
  assert.match(sql, /IF existing_rows <> 0 THEN/i);
  assert.match(sql, /ERRCODE = '55000'/i);
  assert.match(sql, /requires an empty table/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+audit\.events\s+SELECT/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
});

test("audit.events usa partizioni mensili, default e manutenzione owner-only", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");

  assert.match(sql, /PARTITION BY RANGE \(occurred_at\)/i);
  assert.match(sql, /PRIMARY KEY \(occurred_at, id\)/i);
  assert.match(sql, /CREATE TABLE audit\.events_default\s+PARTITION OF audit\.events DEFAULT/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION audit\.ensure_event_month_partitions/i);
  assert.match(sql, /CREATE TABLE audit\.%I PARTITION OF audit\.events FOR VALUES FROM/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION audit\.ensure_event_month_partitions\(date, date\) FROM cassav6_runtime/i);
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*EXECUTE[^;]*audit\.ensure_event_month_partitions[^;]*cassav6_runtime/i,
  );
});

test("registro ID globale resta append-only e separato dalle partizioni dati", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");

  assert.match(sql, /CREATE TABLE audit\.event_ids/i);
  assert.match(sql, /id text PRIMARY KEY/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION audit\.register_event_id\(\)/i);
  assert.match(sql, /INSERT INTO audit\.event_ids\(id, occurred_at\)/i);
  assert.match(sql, /BEFORE INSERT ON audit\.events/i);
  assert.match(sql, /audit_event_ids_reject_update_delete/i);
  assert.match(sql, /audit_event_ids_reject_truncate/i);
  assert.match(sql, /GRANT SELECT ON audit\.event_ids TO cassav6_runtime/i);
  assert.doesNotMatch(sql, /GRANT[^;]*INSERT[^;]*audit\.event_ids[^;]*cassav6_runtime/i);
});
