#!/usr/bin/env node

import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Uso: v5bt-sqlite-quick-check.mjs FILE.sqlite [...]");
  process.exit(2);
}

for (const filePath of paths) {
  let database;
  try {
    const file = lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error("il percorso non e un file regolare");
    }
    database = new DatabaseSync(filePath, { readOnly: true });
    const rows = database.prepare("PRAGMA quick_check").all();
    if (
      rows.length !== 1 ||
      Object.keys(rows[0]).length !== 1 ||
      Object.values(rows[0])[0] !== "ok"
    ) {
      throw new Error(`PRAGMA quick_check non valido: ${JSON.stringify(rows)}`);
    }
  } catch (error) {
    console.error(`Quick check SQLite fallito per ${filePath}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}
