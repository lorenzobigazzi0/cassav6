#!/usr/bin/env node
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const backendDir =
  process.env.V3_BACKEND_DIR || "/srv/applicazione/v3/cassa-frontend/backend";
const jsonPath = process.env.V3_JSON_DB_PATH || path.join(backendDir, "app-state.json");
const sqlitePath = process.env.V3_SQLITE_DB_PATH || path.join(backendDir, "backend.sqlite");
const backupDir = path.join(backendDir, "backups", "sqlite-cutover");

async function readStableJson(maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await fs.stat(jsonPath);
    const raw = await fs.readFile(jsonPath, "utf8");
    const after = await fs.stat(jsonPath);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { raw, parsed: JSON.parse(raw), stat: after, attempt };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "app-state.json continua a cambiare durante la lettura: allineamento non sicuro"
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function moveExistingSqliteAside(stamp) {
  for (const candidate of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (!fssync.existsSync(candidate)) continue;
    const basename = path.basename(candidate);
    await fs.rename(candidate, path.join(backupDir, `${basename}.before-align-${stamp}`));
  }
}

async function main() {
  await fs.mkdir(backupDir, { recursive: true });
  const tmpPath = path.join(backendDir, `backend.sqlite.align-${Date.now()}.tmp`);
  const { raw, parsed, stat, attempt } = await readStableJson();
  const sourceSha256 = sha256(raw);
  const updatedAt = String(parsed?.meta?.lastWriteAt || new Date(stat.mtimeMs).toISOString());

  await fs.rm(tmpPath, { force: true });
  await fs.rm(`${tmpPath}-wal`, { force: true });
  await fs.rm(`${tmpPath}-shm`, { force: true });

  const db = new DatabaseSync(tmpPath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?)").run(
        raw,
        updatedAt
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // noop
      }
      throw error;
    }
  } finally {
    db.close();
  }

  await fs.rm(`${tmpPath}-wal`, { force: true });
  await fs.rm(`${tmpPath}-shm`, { force: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  await moveExistingSqliteAside(stamp);
  await fs.rename(tmpPath, sqlitePath);

  const verifyDb = new DatabaseSync(sqlitePath, { readOnly: true });
  let row;
  try {
    row = verifyDb.prepare("SELECT json, updated_at FROM app_state WHERE id = 1").get();
  } finally {
    verifyDb.close();
  }

  const sqliteSha256 = sha256(String(row?.json ?? ""));
  if (sourceSha256 !== sqliteSha256) {
    throw new Error(`Hash mismatch JSON/SQLite: ${sourceSha256} != ${sqliteSha256}`);
  }

  const sqliteState = JSON.parse(row.json);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "sqlite-staged-not-active",
        jsonPath,
        sqlitePath,
        readAttempt: attempt,
        jsonBytes: Buffer.byteLength(raw, "utf8"),
        jsonMtime: stat.mtime.toISOString(),
        sourceSha256,
        sqliteSha256,
        updatedAt: row.updated_at,
        metaLastWriteAt: sqliteState?.meta?.lastWriteAt ?? null,
        topLevelKeys: Object.keys(sqliteState).length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
