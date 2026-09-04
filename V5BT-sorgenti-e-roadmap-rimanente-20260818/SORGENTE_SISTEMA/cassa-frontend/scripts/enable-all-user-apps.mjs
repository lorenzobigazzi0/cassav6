import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

const ENABLED_APP_IDS = Object.freeze(["cassa", "postazione", "palmare"]);
const APPLY = process.argv.includes("--apply");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "../../..");

function identifier(value, fallback) {
  const normalized = String(value ?? fallback ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Identificatore MySQL non valido: ${normalized || "(vuoto)"}`);
  }
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function activeWorkstationIds(rawValue) {
  const seen = new Set();
  const result = [];
  for (const entry of jsonValue(rawValue, [])) {
    if (!entry || typeof entry !== "object" || entry.active === false) continue;
    const status = String(entry.status ?? "active").trim().toLowerCase();
    if (["disabled", "inactive", "deleted"].includes(status)) continue;
    const id = String(entry.id ?? entry.stationId ?? entry.stationName ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

async function writePrivateBackup(rows, metadata) {
  const backupDir = path.join(
    workspaceRoot,
    ".runtime",
    "cassav5bt",
    "user-access-backups",
  );
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDir,
    `users-before-enable-all-${stamp}-${randomUUID()}.json`,
  );
  await fs.writeFile(
    backupPath,
    `${JSON.stringify({ schemaVersion: 1, ...metadata, rows }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await fs.chmod(backupPath, 0o600);
  return backupPath;
}

const config = {
  host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
  user: process.env.BACKEND_MYSQL_USER || "cassa_app",
  password: process.env.BACKEND_MYSQL_PASSWORD || "amalia2026",
  database: process.env.BACKEND_MYSQL_DATABASE || "cassa",
};
const domainsTable = identifier(
  process.env.BACKEND_MYSQL_APP_STATE_DOMAINS_TABLE,
  "app_state_domain_records",
);

const connection = await mysql.createConnection(config);
let backupPath = "";
try {
  if (APPLY) await connection.beginTransaction();

  const [workstationRows] = await connection.query(
    `SELECT raw_json FROM \`${domainsTable}\` WHERE domain = ? AND record_id = ?${
      APPLY ? " FOR UPDATE" : ""
    }`,
    ["posSettings", "workstations"],
  );
  const workstationIds = activeWorkstationIds(workstationRows[0]?.raw_json);
  if (workstationIds.length === 0) {
    throw new Error("Nessuna Postazione attiva trovata nella configurazione.");
  }

  const [rows] = await connection.query(
    `SELECT record_id, kind, app_state_position, row_hash, raw_json
       FROM \`${domainsTable}\`
      WHERE domain = ?
      ORDER BY app_state_position ASC, record_id ASC${APPLY ? " FOR UPDATE" : ""}`,
    ["users"],
  );
  if (rows.length === 0) throw new Error("Nessun utente trovato.");

  const changes = rows.map((row) => {
    const current = jsonValue(row.raw_json, null);
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Record utente non valido: ${row.record_id}`);
    }
    if (String(current.id ?? "").trim() !== String(row.record_id)) {
      throw new Error(`Identita record incoerente: ${row.record_id}`);
    }
    const currentJson = JSON.stringify(current);
    const currentHashValid = sha256(currentJson) === String(row.row_hash);
    const accessChanged =
      JSON.stringify(current.enabledAppIds) !== JSON.stringify(ENABLED_APP_IDS) ||
      JSON.stringify(current.workstationIds) !== JSON.stringify(workstationIds);
    const next =
      accessChanged
        ? {
            ...current,
            workstationIds: [...workstationIds],
            enabledAppIds: [...ENABLED_APP_IDS],
            updatedAt: new Date().toISOString(),
          }
        : current;
    const nextJson = JSON.stringify(next);
    return {
      recordId: String(row.record_id),
      currentHash: String(row.row_hash),
      currentHashValid,
      next,
      nextJson,
      nextHash: sha256(nextJson),
      changed: accessChanged || !currentHashValid,
    };
  });

  const pendingChanges = changes.filter((entry) => entry.changed);
  if (APPLY && pendingChanges.length > 0) {
    backupPath = await writePrivateBackup(rows, {
      createdAt: new Date().toISOString(),
      database: config.database,
      domainsTable,
    });
    for (const change of pendingChanges) {
      const [result] = await connection.query(
        `UPDATE \`${domainsTable}\`
            SET raw_json = CAST(? AS JSON), row_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE domain = ? AND record_id = ? AND row_hash = ?`,
        [
          change.nextJson,
          change.nextHash,
          "users",
          change.recordId,
          change.currentHash,
        ],
      );
      if (result.affectedRows !== 1) {
        throw new Error(`Aggiornamento concorrente rilevato: ${change.recordId}`);
      }
    }
    const changedIds = new Set(pendingChanges.map((entry) => entry.recordId));
    const [canonicalRows] = await connection.query(
      `SELECT record_id, row_hash, raw_json
         FROM \`${domainsTable}\`
        WHERE domain = ?
        ORDER BY app_state_position ASC, record_id ASC
        FOR UPDATE`,
      ["users"],
    );
    for (const row of canonicalRows) {
      if (!changedIds.has(String(row.record_id))) continue;
      const canonicalHash = sha256(JSON.stringify(jsonValue(row.raw_json, null)));
      if (canonicalHash === String(row.row_hash)) continue;
      const [result] = await connection.query(
        `UPDATE \`${domainsTable}\`
            SET row_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE domain = ? AND record_id = ? AND row_hash = ?`,
        [canonicalHash, "users", String(row.record_id), String(row.row_hash)],
      );
      if (result.affectedRows !== 1) {
        throw new Error(`Canonizzazione concorrente rilevata: ${row.record_id}`);
      }
    }
  }
  if (APPLY) await connection.commit();

  const [verifiedRows] = await connection.query(
    `SELECT record_id, row_hash, raw_json
       FROM \`${domainsTable}\`
      WHERE domain = ?
      ORDER BY app_state_position ASC, record_id ASC`,
    ["users"],
  );
  const verified = verifiedRows.filter((row) => {
    const user = jsonValue(row.raw_json, null);
    const rawJson = JSON.stringify(user);
    return (
      sha256(rawJson) === String(row.row_hash) &&
      JSON.stringify(user?.enabledAppIds) === JSON.stringify(ENABLED_APP_IDS) &&
      JSON.stringify(user?.workstationIds) === JSON.stringify(workstationIds)
    );
  }).length;

  console.log(
    JSON.stringify(
      {
        ok: !APPLY || verified === rows.length,
        mode: APPLY ? "APPLY" : "DRY_RUN",
        users: rows.length,
        usersChanged: changes.filter((entry) => entry.changed).length,
        usersWithValidInputHash: changes.filter((entry) => entry.currentHashValid)
          .length,
        enabledAppIds: ENABLED_APP_IDS,
        activeWorkstationIds: workstationIds,
        verified: APPLY ? verified : 0,
        backupCreated: Boolean(backupPath),
      },
      null,
      2,
    ),
  );

  if (APPLY && verified !== rows.length) process.exitCode = 1;
} catch (error) {
  if (APPLY) await connection.rollback().catch(() => {});
  throw error;
} finally {
  await connection.end();
}
