#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = "/srv/applicazione/data/backend.sqlite";
const BACKUP_DIR = "/srv/applicazione/data";
const DEFAULT_MENU_CATALOG_MODULE = path.resolve(
  __dirname,
  "../../cassa-frontend/backend/modules/menu/default-menu-catalog.js"
);

function nowIso() {
  return new Date().toISOString();
}

function validateSeedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Catalogo menu di default non valido o vuoto.");
  }

  const ids = new Set();
  const names = new Set();
  items.forEach((item, index) => {
    const id = String(item?.id ?? "").trim();
    const name = String(item?.name ?? "").trim();
    const category = String(item?.category ?? "").trim();
    const price = Number(item?.price);
    if (!id) throw new Error(`ID mancante per articolo #${index + 1}.`);
    if (!name) throw new Error(`Nome mancante per articolo #${index + 1}.`);
    if (!category) throw new Error(`Categoria mancante per articolo "${name}".`);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Prezzo non valido per articolo "${name}".`);
    }
    const nameKey = name.toLowerCase();
    if (ids.has(id)) throw new Error(`ID duplicato: ${id}.`);
    if (names.has(nameKey)) throw new Error(`Nome duplicato: ${name}.`);
    ids.add(id);
    names.add(nameKey);
  });
}

function buildMenuItems(defaultMenuItems, previousItems, timestamp) {
  const previousById = new Map(
    (Array.isArray(previousItems) ? previousItems : [])
      .map((item) => [String(item?.id ?? "").trim(), item])
      .filter(([id]) => id.length > 0)
  );

  return defaultMenuItems.map((item) => {
    const existing = previousById.get(String(item.id));
    return {
      ...item,
      id: String(item.id),
      name: String(item.name),
      price: Number(item.price),
      category: String(item.category),
      enabled: item.enabled !== false,
      createdByUserId: String(existing?.createdByUserId ?? "system"),
      createdAt: String(existing?.createdAt ?? timestamp),
      updatedAt: timestamp,
    };
  });
}

async function main() {
  const { DEFAULT_MENU_ITEMS } = await import(
    pathToFileURL(DEFAULT_MENU_CATALOG_MODULE).href
  );
  validateSeedItems(DEFAULT_MENU_ITEMS);

  const sqlite = new DatabaseSync(DB_PATH);
  const row = sqlite.prepare("SELECT json FROM app_state WHERE id = 1").get();
  if (!row || typeof row.json !== "string") {
    throw new Error("Stato applicazione non trovato.");
  }

  const backupPath = path.join(
    BACKUP_DIR,
    `backup-app-state-${nowIso().replace(/[:.]/g, "-")}-menu-catalog.json`
  );
  fs.writeFileSync(backupPath, row.json, "utf-8");

  const app = JSON.parse(row.json);
  const timestamp = nowIso();
  const beforeItems = Array.isArray(app.menuItems) ? app.menuItems : [];
  const nextItems = buildMenuItems(DEFAULT_MENU_ITEMS, beforeItems, timestamp);

  app.menuItems = nextItems;
  if (!app.meta || typeof app.meta !== "object") {
    app.meta = {};
  }
  app.meta.lastWriteAt = timestamp;
  app.meta.settingsLastWriteAt = timestamp;

  const serialized = JSON.stringify(app);
  sqlite
    .prepare(
      `
        INSERT INTO app_state (id, json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          json = excluded.json,
          updated_at = excluded.updated_at
      `
    )
    .run(serialized, timestamp);
  sqlite.close();

  const categoriesAfter = [];
  const seenCategories = new Set();
  nextItems.forEach((item) => {
    const category = String(item.category);
    if (seenCategories.has(category)) return;
    seenCategories.add(category);
    categoriesAfter.push(category);
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        backupPath,
        beforeCount: beforeItems.length,
        afterCount: nextItems.length,
        categoriesAfter,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
