import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import { mapSessionToRelationalRow, SessionsRelationalRepository } from "./sessions.repo.js";

function buildChecksum(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

export function syncSessionsFromAppState(db, appState, options = {}) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const repo = new SessionsRelationalRepository(db);
  const sessions = Array.isArray(appState?.sessions) ? appState.sessions : [];
  const rows = sessions
    .map((session) => mapSessionToRelationalRow(session, options))
    .filter((row) => row !== null);
  const checksum = buildChecksum(rows);
  const sourceLastWriteAt =
    typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim().length > 0
      ? appState.meta.lastWriteAt
      : null;
  const syncedAt = nowIso();

  runRelationalTransaction(db, () => {
    repo.replaceAllFromAppState(sessions, { ...options, transaction: false });
    db.prepare(
      `
        INSERT INTO relational_sync_state (
          domain,
          source_last_write_at,
          row_count,
          checksum,
          synced_at
        ) VALUES (
          'sessions', ?, ?, ?, ?
        )
        ON CONFLICT(domain) DO UPDATE SET
          source_last_write_at = excluded.source_last_write_at,
          row_count = excluded.row_count,
          checksum = excluded.checksum,
          synced_at = excluded.synced_at
      `
    ).run(sourceLastWriteAt, rows.length, checksum, syncedAt);
  });

  return {
    domain: "sessions",
    rowCount: rows.length,
    checksum,
    syncedAt,
  };
}
