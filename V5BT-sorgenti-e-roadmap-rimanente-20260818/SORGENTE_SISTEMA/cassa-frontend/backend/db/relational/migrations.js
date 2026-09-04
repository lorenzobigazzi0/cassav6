import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRelationalTransaction } from "./connection.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(currentDir, "migrations");

export const RELATIONAL_MIGRATIONS = [
  { version: "001", name: "core", fileName: "001_core.sql" },
  { version: "002", name: "audit_events", fileName: "002_audit_events.sql" },
  { version: "003", name: "users", fileName: "003_users.sql" },
  { version: "004", name: "sessions", fileName: "004_sessions.sql" },
  { version: "005", name: "sale_sessions", fileName: "005_sale_sessions.sql" },
  { version: "006", name: "payments", fileName: "006_payments.sql" },
  { version: "007", name: "menu_settings", fileName: "007_menu_settings.sql" },
  { version: "008", name: "orders", fileName: "008_orders.sql" },
  { version: "009", name: "tables_bills", fileName: "009_tables_bills.sql" },
  {
    version: "010",
    name: "realtime_backbone",
    fileName: "010_realtime_backbone.sql",
  },
  {
    version: "011",
    name: "orders_revision",
    fileName: "011_orders_revision.sql",
  },
  { version: "012", name: "reservations", fileName: "012_reservations.sql" },
  {
    version: "013",
    name: "table_locks_revision",
    fileName: "013_table_locks_revision.sql",
  },
  {
    version: "014",
    name: "table_states_revision",
    fileName: "014_table_states_revision.sql",
  },
  {
    version: "015",
    name: "payments_revision",
    fileName: "015_payments_revision.sql",
  },
  {
    version: "016",
    name: "fiscal_receipts_attempt_scope",
    fileName: "016_fiscal_receipts_attempt_scope.sql",
  },
  {
    version: "017",
    name: "orders_updated_at_index",
    fileName: "017_orders_updated_at_index.sql",
  },
  { version: "018", name: "command_inbox", fileName: "018_command_inbox.sql" },
  { version: "019", name: "print_spool", fileName: "019_print_spool.sql" },
  {
    version: "020",
    name: "aggregate_versions",
    fileName: "020_aggregate_versions.sql",
  },
  { version: "021", name: "fiscal_outbox", fileName: "021_fiscal_outbox.sql" },
  {
    version: "022",
    name: "fiscal_outbox_lease",
    fileName: "022_fiscal_outbox_lease.sql",
  },
  {
    version: "023",
    name: "orders_idempotency_index",
    fileName: "023_orders_idempotency_index.sql",
  },
  {
    version: "024",
    name: "order_id_allocator",
    fileName: "024_order_id_allocator.sql",
  },
  {
    version: "025",
    name: "payment_mirror_outbox",
    fileName: "025_payment_mirror_outbox.sql",
  },
  {
    version: "026",
    name: "payment_mirror_outbox_retention",
    fileName: "026_payment_mirror_outbox_retention.sql",
  },
  {
    version: "027",
    name: "reservation_state_versions",
    fileName: "027_reservation_state_versions.sql",
  },
];

function ensureMigrationRegistry(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

async function readMigrationSql(fileName) {
  return fs.readFile(path.join(migrationsDir, fileName), "utf-8");
}

export async function runRelationalMigrations(db, options = {}) {
  const migrations = options.migrations ?? RELATIONAL_MIGRATIONS;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  for (const migration of migrations) {
    try {
      const sql = await readMigrationSql(migration.fileName);
      runRelationalTransaction(db, () => {
        ensureMigrationRegistry(db);
        const applied = db
          .prepare("SELECT version FROM schema_migrations WHERE version = ?")
          .get(migration.version);
        if (applied) return;

        db.exec(sql);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, nowIso());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Migrazione relazionale ${migration.version}_${migration.name} fallita: ${message}`,
      );
    }
  }
}
