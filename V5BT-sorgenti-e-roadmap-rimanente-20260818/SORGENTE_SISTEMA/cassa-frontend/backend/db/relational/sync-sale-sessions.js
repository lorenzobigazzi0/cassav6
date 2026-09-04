import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import {
  mapSaleSessionToRelationalRow,
  mapSolarClosureToRelationalRow,
  SaleSessionsRelationalRepository,
} from "./sale-sessions.repo.js";

function buildChecksum(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

export function syncSaleSessionsFromAppState(db, appState, options = {}) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const repo = new SaleSessionsRelationalRepository(db);
  const saleSessions = Array.isArray(appState?.saleSessions) ? appState.saleSessions : [];
  const solarClosures = Array.isArray(appState?.solarClosures) ? appState.solarClosures : [];
  const saleSessionRows = saleSessions.map((session) => mapSaleSessionToRelationalRow(session)).filter(Boolean);
  const solarClosureRows = solarClosures
    .map((closure, index) => mapSolarClosureToRelationalRow(closure, index))
    .filter(Boolean);
  const checksum = buildChecksum({
    saleSessions: saleSessionRows,
    solarClosures: solarClosureRows,
  });
  const sourceLastWriteAt =
    typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim().length > 0
      ? appState.meta.lastWriteAt
      : null;
  const syncedAt = nowIso();

  runRelationalTransaction(db, () => {
    repo.replaceAllFromAppState(saleSessions, {
      solarClosures,
      transaction: false,
    });
    db.prepare(
      `
        INSERT INTO relational_sync_state (
          domain,
          source_last_write_at,
          row_count,
          checksum,
          synced_at
        ) VALUES (
          'saleSessions', ?, ?, ?, ?
        )
        ON CONFLICT(domain) DO UPDATE SET
          source_last_write_at = excluded.source_last_write_at,
          row_count = excluded.row_count,
          checksum = excluded.checksum,
          synced_at = excluded.synced_at
      `
    ).run(sourceLastWriteAt, saleSessionRows.length, checksum, syncedAt);
  });

  return {
    domain: "saleSessions",
    rowCount: saleSessionRows.length,
    checksum,
    syncedAt,
  };
}
