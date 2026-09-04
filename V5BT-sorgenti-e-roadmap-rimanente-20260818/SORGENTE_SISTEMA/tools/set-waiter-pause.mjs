/*
  Abilita o disabilita la pausa cameriere per un utente.

  Scrive su app_state_domain_records seguendo lo stesso protocollo di
  cassa-frontend/scripts/enable-all-user-apps.mjs: lettura FOR UPDATE, backup
  privato, UPDATE con guardia sul row_hash e ricalcolo canonico dell'hash.

  Uso:
    node tools/set-waiter-pause.mjs --user lorenzo               # anteprima
    node tools/set-waiter-pause.mjs --user lorenzo --apply       # abilita
    node tools/set-waiter-pause.mjs --user lorenzo --off --apply # disabilita

  Opzioni: --duration <minuti> (1-120), --renewal <minuti> (15-720).
  Le credenziali arrivano da BACKEND_MYSQL_* come per il backend.
*/
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "../cassa-frontend/node_modules/mysql2/promise.js";

// MariaDB non ha un tipo JSON nativo: raw_json e' longtext, niente CAST.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "../..");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DISABLE = args.includes("--off");

function argValue(name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return "";
  return String(args[index + 1] ?? "").trim();
}

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

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function writePrivateBackup(row, metadata) {
  const backupDir = path.join(packageRoot, ".runtime", "cassav5bt", "user-access-backups");
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDir,
    `user-waiter-pause-${stamp}-${randomUUID()}.json`,
  );
  await fs.writeFile(
    backupPath,
    `${JSON.stringify({ schemaVersion: 1, ...metadata, row }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return backupPath;
}

const targetUser = argValue("--user");
if (!targetUser) {
  throw new Error("Specificare l'utente con --user <username|id>.");
}

const config = {
  host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
  user: process.env.BACKEND_MYSQL_USER || "cassa_v5bt_app",
  password: process.env.BACKEND_MYSQL_PASSWORD || "",
  database: process.env.BACKEND_MYSQL_DATABASE || "cassa_v5bt",
};
const domainsTable = identifier(
  process.env.BACKEND_MYSQL_APP_STATE_DOMAINS_TABLE,
  "app_state_domain_records",
);

const connection = await mysql.createConnection(config);
try {
  if (APPLY) await connection.beginTransaction();

  const [rows] = await connection.query(
    `SELECT record_id, row_hash, raw_json FROM \`${domainsTable}\`
      WHERE domain = ? ORDER BY app_state_position ASC, record_id ASC${APPLY ? " FOR UPDATE" : ""}`,
    ["users"],
  );

  const needle = targetUser.toLowerCase();
  const row = rows.find((entry) => {
    const record = jsonValue(entry.raw_json, null);
    if (!record || typeof record !== "object") return false;
    return (
      String(record.username ?? "").toLowerCase() === needle ||
      String(record.id ?? "").toLowerCase() === needle
    );
  });
  if (!row) throw new Error(`Utente non trovato: ${targetUser}`);

  const current = jsonValue(row.raw_json, null);
  const currentSettings =
    current.waiterPauseSettings && typeof current.waiterPauseSettings === "object"
      ? current.waiterPauseSettings
      : {};
  const nextSettings = {
    enabled: !DISABLE,
    durationMinutes: clampInteger(
      argValue("--duration") || currentSettings.durationMinutes,
      1,
      120,
      15,
    ),
    renewalMinutes: clampInteger(
      argValue("--renewal") || currentSettings.renewalMinutes,
      15,
      720,
      120,
    ),
  };

  const next = {
    ...current,
    waiterPauseSettings: nextSettings,
    updatedAt: new Date().toISOString(),
  };
  const nextJson = JSON.stringify(next);
  const nextHash = sha256(nextJson);

  console.log(`Utente:  ${current.fullName ?? current.username} (${current.id})`);
  console.log(`Prima:   ${JSON.stringify(currentSettings)}`);
  console.log(`Dopo:    ${JSON.stringify(nextSettings)}`);

  if (!APPLY) {
    console.log("Anteprima: nessuna scrittura. Ripetere con --apply.");
    await connection.end();
    process.exit(0);
  }

  const backupPath = await writePrivateBackup(row, {
    createdAt: new Date().toISOString(),
    database: config.database,
    domainsTable,
    action: DISABLE ? "waiter-pause-disable" : "waiter-pause-enable",
  });

  const [result] = await connection.query(
    `UPDATE \`${domainsTable}\`
        SET raw_json = ?, row_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE domain = ? AND record_id = ? AND row_hash = ?`,
    [nextJson, nextHash, "users", String(row.record_id), String(row.row_hash)],
  );
  if (result.affectedRows !== 1) {
    throw new Error(`Aggiornamento concorrente rilevato: ${row.record_id}`);
  }

  // MySQL puo' riscrivere il JSON in forma canonica: riallinea l'hash.
  const [canonicalRows] = await connection.query(
    `SELECT record_id, row_hash, raw_json FROM \`${domainsTable}\`
      WHERE domain = ? AND record_id = ? FOR UPDATE`,
    ["users", String(row.record_id)],
  );
  const canonicalRow = canonicalRows[0];
  const canonicalHash = sha256(JSON.stringify(jsonValue(canonicalRow.raw_json, null)));
  if (canonicalHash !== String(canonicalRow.row_hash)) {
    const [fix] = await connection.query(
      `UPDATE \`${domainsTable}\`
          SET row_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE domain = ? AND record_id = ? AND row_hash = ?`,
      [canonicalHash, "users", String(canonicalRow.record_id), String(canonicalRow.row_hash)],
    );
    if (fix.affectedRows !== 1) {
      throw new Error(`Canonizzazione concorrente rilevata: ${canonicalRow.record_id}`);
    }
  }

  await connection.commit();
  console.log(`Backup:  ${backupPath}`);
  console.log("Scrittura completata: riavviare il backend per ricaricare lo stato.");
} catch (error) {
  try {
    await connection.rollback();
  } catch {}
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
} finally {
  await connection.end();
}
