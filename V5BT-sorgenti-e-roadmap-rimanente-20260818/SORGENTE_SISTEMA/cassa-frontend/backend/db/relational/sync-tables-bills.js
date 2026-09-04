import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import {
  buildTablesBillsRelationalRows,
  TablesBillsRelationalRepository,
} from "./tables-bills.repo.js";

function buildChecksum(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

function rowCount(rows) {
  return rows.tableStates.length + rows.bills.length + rows.locks.length;
}

export function syncTablesBillsFromAppState(db, appState, options = {}) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const repo = new TablesBillsRelationalRepository(db);
  const rows = buildTablesBillsRelationalRows(appState);
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
          'tablesBills', ?, ?, ?, ?
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
    domain: "tablesBills",
    rowCount: count,
    checksum,
    syncedAt,
  };
}
