import { createHash } from "node:crypto";
import { AuditEventsRelationalRepository, mapAuditEventToRow } from "./audit-events.repo.js";
import { runRelationalTransaction } from "./connection.js";

function buildChecksum(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

export function syncAuditEventsFromAppState(db, appState, options = {}) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const repo = new AuditEventsRelationalRepository(db);
  const rows = (Array.isArray(appState?.auditEvents) ? appState.auditEvents : [])
    .map((event, index) => mapAuditEventToRow(event, index))
    .filter((row) => row !== null);
  const checksum = buildChecksum(rows);
  const sourceLastWriteAt =
    typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim().length > 0
      ? appState.meta.lastWriteAt
      : null;
  const syncedAt = nowIso();

  runRelationalTransaction(db, () => {
    repo.deleteAll();
    for (const row of rows) {
      repo.insert(row);
    }
    db.prepare(
      `
        INSERT INTO relational_sync_state (
          domain,
          source_last_write_at,
          row_count,
          checksum,
          synced_at
        ) VALUES (
          'auditEvents', ?, ?, ?, ?
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
    domain: "auditEvents",
    rowCount: rows.length,
    checksum,
    syncedAt,
  };
}

export async function syncRelationalShadowAfterAppStateWrite(appState, runtime, context = {}) {
  if (!runtime || !["shadow", "primary"].includes(runtime.mode)) return null;
  try {
    return await runtime.syncAfterAppStateWrite(appState, context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const mode = runtime.mode === "primary" ? "primary" : "shadow";
    const message = `[backend] Sync relazionale ${mode} app-state fallita: ${reason}`;
    if (runtime.mode === "primary") {
      throw new Error(message);
    }
    runtime.logger?.warn?.(message);
    return null;
  }
}
