import { runRelationalTransaction } from "./connection.js";

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function optionalString(value) {
  const normalized = asTrimmedString(value);
  return normalized || null;
}

function slugifyId(value, fallback = "item") {
  const normalized = asTrimmedString(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function truthyFlag(value, fallback = true) {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  if (value === false || value === 0) return 0;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["0", "false", "no", "off", "disabled", "inactive"].includes(normalized)) return 0;
  return 1;
}

function centsFromMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric * 100));
}

function uniqueStringList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;]+/)
      : [];
  const seen = new Set();
  const result = [];
  for (const entry of source) {
    const normalized = optionalString(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function categoryIdFromLabel(label) {
  return `cat_${slugifyId(label, "altro")}`;
}

function categoryLabelFromItem(item) {
  return optionalString(item?.categoryName ?? item?.category) ?? "Altro";
}

function categoryIdFromItem(item) {
  return optionalString(item?.categoryId) ?? categoryIdFromLabel(categoryLabelFromItem(item));
}

function departmentFromCategory(label) {
  const normalized = asTrimmedString(label).toLowerCase();
  if (/(caffe|caffetteria|colazione|cornetti)/.test(normalized)) return "caffetteria";
  if (/(cocktail|drink|gin|vodka|premium|spritz|aperitivo)/.test(normalized)) return "bar";
  if (/(cucina|food|panini|primi|secondi|snack|apericena)/.test(normalized)) return "cucina";
  return "generale";
}

function stationListFromItem(item) {
  return uniqueStringList(
    item?.stations ??
      item?.stationIds ??
      item?.routeStations ??
      item?.workstations ??
      item?.station ??
      item?.stationName
  );
}

function variantRequiredForItem(item) {
  return (
    item?.variantRequired === true ||
    item?.requiresVariant === true ||
    item?.requiresVariantSelection === true
  );
}

function metadataFromItem(item) {
  const metadata = {};
  for (const key of [
    "section",
    "subcategory",
    "type",
    "kind",
    "source",
    "menuSource",
    "catalogSource",
    "imageUrl",
    "isPremiumAlcohol",
    "variantRequired",
    "requiresVariant",
    "requiresVariantSelection",
  ]) {
    if (item?.[key] !== undefined) metadata[key] = item[key];
  }
  return metadata;
}

export function buildMenuCategoryRows(menuItems) {
  const byId = new Map();
  const source = Array.isArray(menuItems) ? menuItems : [];
  source.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const label = categoryLabelFromItem(item);
    const id = categoryIdFromItem(item);
    const current = byId.get(id);
    const active = truthyFlag(item.enabled, true);
    if (!current) {
      byId.set(id, {
        id,
        name: label,
        sortOrder: index,
        active,
        rawJson: stringifyJson({ id, name: label, category: label }, {}),
      });
      return;
    }
    current.active = current.active || active ? 1 : 0;
  });
  return [...byId.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

export function mapMenuItemToRelationalRow(item) {
  if (!item || typeof item !== "object") return null;
  const id = optionalString(item.id);
  const name = optionalString(item.name ?? item.label);
  if (!id || !name) return null;
  const categoryLabel = categoryLabelFromItem(item);
  const stations = stationListFromItem(item);
  const metadata = metadataFromItem(item);

  return {
    id,
    categoryId: categoryIdFromItem(item),
    name,
    description: optionalString(item.description ?? item.desc),
    priceCents: centsFromMoney(item.price ?? item.unitPrice),
    active: truthyFlag(item.enabled ?? item.active, true),
    available: truthyFlag(item.available, true),
    department: optionalString(item.department) ?? departmentFromCategory(categoryLabel),
    stationId: optionalString(item.stationId ?? item.station ?? item.stationName) ?? stations[0] ?? null,
    stationsJson: stringifyJson(stations, []),
    metadataJson: stringifyJson(metadata, {}),
    rawJson: stringifyJson(item, {}),
  };
}

export function mapMenuVariantToRelationalRows(item) {
  if (!item || typeof item !== "object" || !Array.isArray(item.variants)) return [];
  const itemId = optionalString(item.id);
  if (!itemId) return [];
  const itemRequiresVariant = variantRequiredForItem(item);
  return item.variants
    .map((variant, index) => {
      if (!variant || typeof variant !== "object") return null;
      const name = optionalString(variant.name ?? variant.label ?? variant.value);
      if (!name) return null;
      const rawId = optionalString(variant.id ?? variant.value);
      return {
        id: rawId || `${itemId}_variant_${index + 1}`,
        itemId,
        name,
        priceDeltaCents: centsFromMoney(variant.priceDelta ?? variant.delta ?? variant.price),
        required: truthyFlag(variant.required ?? itemRequiresVariant, false),
        active: truthyFlag(variant.enabled ?? variant.active ?? variant.available, true),
        rawJson: stringifyJson(variant, {}),
      };
    })
    .filter((row) => row !== null);
}

function ensureUniqueVariantIds(rows) {
  const seen = new Set();
  return rows.map((row) => {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      return row;
    }
    const base = `${row.itemId}_${row.id}`;
    let candidate = base;
    let counter = 2;
    while (seen.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    seen.add(candidate);
    return {
      ...row,
      id: candidate,
    };
  });
}

function paymentMethodType(method) {
  const explicit = optionalString(method?.type ?? method?.methodType ?? method?.kind);
  if (explicit) return explicit;
  const idAndName = `${method?.id ?? ""} ${method?.label ?? ""} ${method?.name ?? ""}`.toLowerCase();
  if (method?.isSmart === true || /smart|chip|conto/.test(idAndName)) return "smart";
  if (/card|carta|pos/.test(idAndName)) return "card";
  if (/cash|contanti/.test(idAndName)) return "cash";
  return null;
}

export function mapPaymentMethodToRelationalRow(method, index = 0) {
  if (!method || typeof method !== "object") return null;
  const id = optionalString(method.id) ?? `pay_method_${index + 1}`;
  const name = optionalString(method.name ?? method.label) ?? id;
  return {
    id,
    name,
    type: paymentMethodType(method),
    active: truthyFlag(method.enabled ?? method.active, true),
    fiscal: truthyFlag(method.isFiscal ?? method.fiscal, false),
    sortOrder: Number.isFinite(Number(method.sortOrder ?? method.order)) ? Math.trunc(Number(method.sortOrder ?? method.order)) : index,
    rawJson: stringifyJson(method, {}),
  };
}

function roomIdFromRoom(room) {
  return optionalString(room?.id ?? room?.roomId);
}

function tableRoomId(table) {
  return optionalString(table?.roomId ?? table?.room ?? table?.areaId) ?? `room_${slugifyId(table?.type ?? "sala", "sala")}`;
}

export function buildRoomRows(posSettings) {
  const byId = new Map();
  const rooms = Array.isArray(posSettings?.rooms) ? posSettings.rooms : [];
  rooms.forEach((room, index) => {
    if (!room || typeof room !== "object") return;
    const id = roomIdFromRoom(room);
    if (!id) return;
    byId.set(id, {
      id,
      name: optionalString(room.name ?? room.label ?? room.roomName) ?? id,
      active: truthyFlag(room.enabled ?? room.active, true),
      rawJson: stringifyJson(room, {}),
      sortOrder: index,
    });
  });

  const areas = Array.isArray(posSettings?.areas) ? posSettings.areas : [];
  areas.forEach((area, index) => {
    if (!area || typeof area !== "object") return;
    const id = optionalString(area.id);
    if (!id || byId.has(id)) return;
    byId.set(id, {
      id,
      name: optionalString(area.name ?? area.label) ?? id,
      active: truthyFlag(area.enabled ?? area.active, true),
      rawJson: stringifyJson(area, {}),
      sortOrder: rooms.length + index,
    });
  });

  const tables = Array.isArray(posSettings?.tables) ? posSettings.tables : [];
  tables.forEach((table, index) => {
    if (!table || typeof table !== "object") return;
    const id = tableRoomId(table);
    if (!id || byId.has(id)) return;
    byId.set(id, {
      id,
      name: optionalString(table.type ?? table.roomName ?? table.roomLabel) ?? id,
      active: 1,
      rawJson: stringifyJson({ id, name: table.type ?? id, inferredFromTableId: table.id }, {}),
      sortOrder: rooms.length + areas.length + index,
    });
  });

  return [...byId.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function tableLayout(table) {
  const layout = {};
  for (const key of ["x", "y", "width", "height", "rotation", "shape", "layout", "zone", "status", "covers", "totalDue"]) {
    if (table?.[key] !== undefined) layout[key] = table[key];
  }
  return layout;
}

export function mapTableToRelationalRow(table, roomIds = new Set()) {
  if (!table || typeof table !== "object") return null;
  const id = optionalString(table.id);
  if (!id) return null;
  const roomId = tableRoomId(table);
  return {
    id,
    roomId: roomIds.has(roomId) ? roomId : null,
    name: optionalString(table.name ?? table.label ?? table.tableLabel) ?? null,
    number: optionalString(table.number ?? table.tableNumber),
    active: truthyFlag(table.enabled ?? table.active, true),
    layoutJson: stringifyJson(tableLayout(table), {}),
    rawJson: stringifyJson(table, {}),
  };
}

export function buildMenuSettingsRelationalRows(appState) {
  const menuItems = Array.isArray(appState?.menuItems) ? appState.menuItems : [];
  const posSettings = appState?.posSettings && typeof appState.posSettings === "object" ? appState.posSettings : {};
  const categories = buildMenuCategoryRows(menuItems);
  const categoryIds = new Set(categories.map((row) => row.id));
  const items = menuItems
    .map((item) => mapMenuItemToRelationalRow(item))
    .filter((row) => row !== null)
    .map((row) => ({ ...row, categoryId: categoryIds.has(row.categoryId) ? row.categoryId : null }));
  const itemIds = new Set(items.map((row) => row.id));
  const variants = ensureUniqueVariantIds(
    menuItems
      .flatMap((item) => mapMenuVariantToRelationalRows(item))
      .filter((row) => itemIds.has(row.itemId))
  );
  const paymentMethods = (Array.isArray(posSettings.paymentMethods) ? posSettings.paymentMethods : [])
    .map((method, index) => mapPaymentMethodToRelationalRow(method, index))
    .filter((row) => row !== null);
  const rooms = buildRoomRows(posSettings);
  const roomIds = new Set(rooms.map((row) => row.id));
  const tables = (Array.isArray(posSettings.tables) ? posSettings.tables : [])
    .map((table) => mapTableToRelationalRow(table, roomIds))
    .filter((row) => row !== null);

  return {
    categories,
    items,
    variants,
    paymentMethods,
    rooms,
    tables,
  };
}

export class MenuSettingsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  listMenuItems(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "category_id", filters.categoryId);
    this.#appendFilter(clauses, params, "station_id", filters.stationId);
    if (filters.activeOnly === true) clauses.push("active = 1");
    if (filters.availableOnly === true) clauses.push("available = 1");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM menu_items${where} ORDER BY name ASC, id ASC`)
      .all(...params)
      .map((row) => this.#hydrateMenuItem(row));
  }

  listMenuItemsInAppStateOrder() {
    return this.db
      .prepare("SELECT * FROM menu_items ORDER BY rowid ASC")
      .all()
      .map((row) => this.#hydrateMenuItem(row));
  }

  getMenuItemById(id) {
    const row = this.db.prepare("SELECT * FROM menu_items WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateMenuItem(row) : null;
  }

  listCategories() {
    return this.db
      .prepare("SELECT * FROM menu_categories ORDER BY sort_order ASC, name ASC")
      .all()
      .map((row) => this.#hydrateCategory(row));
  }

  listPaymentMethods() {
    return this.db
      .prepare("SELECT * FROM payment_methods ORDER BY sort_order ASC, id ASC")
      .all()
      .map((row) => this.#hydratePaymentMethod(row));
  }

  listRooms() {
    return this.db
      .prepare("SELECT * FROM pos_rooms ORDER BY name ASC, id ASC")
      .all()
      .map((row) => this.#hydrateRoom(row));
  }

  listTables(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "room_id", filters.roomId);
    if (filters.activeOnly === true) clauses.push("active = 1");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM pos_tables${where} ORDER BY room_id ASC, CAST(number AS INTEGER) ASC, id ASC`)
      .all(...params)
      .map((row) => this.#hydrateTable(row));
  }

  replaceAllFromAppState(appState, options = {}) {
    const rows = buildMenuSettingsRelationalRows(appState);
    const operation = () => {
      this.#deleteAll();
      for (const row of rows.categories) this.#insertCategory(row);
      for (const row of rows.items) this.#insertItem(row);
      for (const row of rows.variants) this.#insertVariant(row);
      for (const row of rows.paymentMethods) this.#insertPaymentMethod(row);
      for (const row of rows.rooms) this.#insertRoom(row);
      for (const row of rows.tables) this.#insertTable(row);
      return rows;
    };

    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  #appendFilter(clauses, params, columnName, value) {
    const normalized = optionalString(value);
    if (!normalized) return;
    clauses.push(`${columnName} = ?`);
    params.push(normalized);
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM menu_item_variants").run();
    this.db.prepare("DELETE FROM menu_items").run();
    this.db.prepare("DELETE FROM menu_categories").run();
    this.db.prepare("DELETE FROM payment_methods").run();
    this.db.prepare("DELETE FROM pos_tables").run();
    this.db.prepare("DELETE FROM pos_rooms").run();
  }

  #insertCategory(row) {
    this.db
      .prepare(
        `
          INSERT INTO menu_categories (
            id,
            name,
            sort_order,
            active,
            raw_json
          ) VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(row.id, row.name, row.sortOrder, row.active, row.rawJson);
  }

  #insertItem(row) {
    this.db
      .prepare(
        `
          INSERT INTO menu_items (
            id,
            category_id,
            name,
            description,
            price_cents,
            active,
            available,
            department,
            station_id,
            stations_json,
            metadata_json,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.categoryId,
        row.name,
        row.description,
        row.priceCents,
        row.active,
        row.available,
        row.department,
        row.stationId,
        row.stationsJson,
        row.metadataJson,
        row.rawJson
      );
  }

  #insertVariant(row) {
    this.db
      .prepare(
        `
          INSERT INTO menu_item_variants (
            id,
            item_id,
            name,
            price_delta_cents,
            required,
            active,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(row.id, row.itemId, row.name, row.priceDeltaCents, row.required, row.active, row.rawJson);
  }

  #insertPaymentMethod(row) {
    this.db
      .prepare(
        `
          INSERT INTO payment_methods (
            id,
            name,
            type,
            active,
            fiscal,
            sort_order,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(row.id, row.name, row.type, row.active, row.fiscal, row.sortOrder, row.rawJson);
  }

  #insertRoom(row) {
    this.db
      .prepare(
        `
          INSERT INTO pos_rooms (
            id,
            name,
            active,
            raw_json
          ) VALUES (?, ?, ?, ?)
        `
      )
      .run(row.id, row.name, row.active, row.rawJson);
  }

  #insertTable(row) {
    this.db
      .prepare(
        `
          INSERT INTO pos_tables (
            id,
            room_id,
            name,
            number,
            active,
            layout_json,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(row.id, row.roomId, row.name, row.number, row.active, row.layoutJson, row.rawJson);
  }

  #hydrateCategory(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
      active: row.active === 1,
    };
  }

  #hydrateMenuItem(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      price: row.price_cents / 100,
      priceCents: row.price_cents,
      enabled: row.active === 1,
      active: row.active === 1,
      available: row.available === 1,
      department: row.department,
      stationId: row.station_id,
      stations: safeJsonParse(row.stations_json, []),
      metadata: safeJsonParse(row.metadata_json, {}),
    };
  }

  #hydratePaymentMethod(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      name: row.name,
      label: row.name,
      type: row.type,
      active: row.active === 1,
      enabled: row.active === 1,
      fiscal: row.fiscal === 1,
      isFiscal: row.fiscal === 1,
      sortOrder: row.sort_order,
    };
  }

  #hydrateRoom(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      roomId: row.id,
      name: row.name,
      active: row.active === 1,
      enabled: row.active === 1,
    };
  }

  #hydrateTable(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      roomId: row.room_id,
      name: row.name,
      number: row.number,
      active: row.active === 1,
      enabled: row.active === 1,
      layout: safeJsonParse(row.layout_json, {}),
    };
  }
}
