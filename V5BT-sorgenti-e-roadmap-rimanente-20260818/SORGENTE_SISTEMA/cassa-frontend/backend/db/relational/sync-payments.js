import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import {
  buildPaymentsRelationalRows,
  PaymentsRelationalRepository,
} from "./payments.repo.js";

function buildChecksum(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

function rowCount(rows) {
  return (
    rows.containers.length +
    rows.parts.length +
    rows.transactions.length +
    rows.fiscalReceipts.length
  );
}

export function syncPaymentsFromAppState(db, appState, options = {}) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const repo = new PaymentsRelationalRepository(db);
  const rows = buildPaymentsRelationalRows(appState);
  const checksum = buildChecksum(rows);
  const sourceLastWriteAt =
    typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim().length > 0
      ? appState.meta.lastWriteAt
      : null;
  const syncedAt = nowIso();
  const count = rowCount(rows);

  runRelationalTransaction(db, () => {
    repo.replaceAllFromAppState(appState, { transaction: false });
    db.prepare(
      `
        INSERT INTO relational_sync_state (
          domain,
          source_last_write_at,
          row_count,
          checksum,
          synced_at
        ) VALUES (
          'payments', ?, ?, ?, ?
        )
        ON CONFLICT(domain) DO UPDATE SET
          source_last_write_at = excluded.source_last_write_at,
          row_count = excluded.row_count,
          checksum = excluded.checksum,
          synced_at = excluded.synced_at
      `
    ).run(sourceLastWriteAt, count, checksum, syncedAt);
  });

  return {
    domain: "payments",
    rowCount: count,
    checksum,
    syncedAt,
  };
}
