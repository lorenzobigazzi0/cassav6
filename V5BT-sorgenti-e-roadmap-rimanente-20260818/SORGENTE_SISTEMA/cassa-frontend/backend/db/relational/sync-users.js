import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import { mapUserToRelationalRows, UsersRelationalRepository } from "./users.repo.js";

function buildChecksum(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

export function syncUsersFromAppState(db, appState, options = {}) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const repo = new UsersRelationalRepository(db);
  const users = Array.isArray(appState?.users) ? appState.users : [];
  const rows = users.map((user) => mapUserToRelationalRows(user)).filter((row) => row !== null);
  const checksum = buildChecksum(rows);
  const sourceLastWriteAt =
    typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim().length > 0
      ? appState.meta.lastWriteAt
      : null;
  const syncedAt = nowIso();

  runRelationalTransaction(db, () => {
    repo.replaceAllFromAppState(users, { transaction: false });
    db.prepare(
      `
        INSERT INTO relational_sync_state (
          domain,
          source_last_write_at,
          row_count,
          checksum,
          synced_at
        ) VALUES (
          'users', ?, ?, ?, ?
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
    domain: "users",
    rowCount: rows.length,
    checksum,
    syncedAt,
  };
}
