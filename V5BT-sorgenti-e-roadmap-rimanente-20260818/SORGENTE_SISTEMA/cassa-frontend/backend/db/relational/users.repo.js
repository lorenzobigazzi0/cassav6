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

function uniqueStringList(value) {
  const seen = new Set();
  const result = [];
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    const normalized = asTrimmedString(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeActive(value, fallbackValue) {
  const candidate = value === undefined ? fallbackValue : value;
  if (candidate === false || candidate === 0) return 0;
  const text = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
  if (["0", "false", "inactive", "disabled", "no"].includes(text)) return 0;
  return 1;
}

function parseScryptPinHash(pinHash) {
  if (typeof pinHash !== "string") return null;
  const parts = pinHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  const saltHex = parts[4];
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0) return null;
  return {
    algorithm: "scrypt",
    N,
    r,
    p,
    saltHex,
  };
}

function sanitizePinHash(value) {
  const pinHash = asTrimmedString(value);
  if (!pinHash || /^\d{4,6}$/.test(pinHash)) return null;
  return pinHash;
}

function buildRawUserJson(user) {
  const raw = user && typeof user === "object" ? { ...user } : {};
  delete raw.pin;
  delete raw.plainPin;
  delete raw.pinCode;
  delete raw.password;
  delete raw.passwordPlain;
  return stringifyJson(raw, {});
}

export function mapUserToRelationalRows(user) {
  if (!user || typeof user !== "object") return null;
  const id = asTrimmedString(user.id);
  const username = asTrimmedString(user.username);
  const role = asTrimmedString(user.role) || "operator";
  if (!id || !username || !role) return null;

  const pinHash = sanitizePinHash(user.pinHash);
  const parsedPin = parseScryptPinHash(pinHash);
  const pinSalt = optionalString(user.pinSalt) ?? parsedPin?.saltHex ?? null;
  const pinParams =
    user.pinParams && typeof user.pinParams === "object"
      ? user.pinParams
      : parsedPin
        ? {
            algorithm: parsedPin.algorithm,
            N: parsedPin.N,
            r: parsedPin.r,
            p: parsedPin.p,
          }
        : null;
  const paymentMethodIds = uniqueStringList(
    Array.isArray(user.paymentMethodIds) ? user.paymentMethodIds : user.allowedPaymentMethodIds
  );

  return {
    user: {
      id,
      username,
      fullName: optionalString(user.fullName),
      role,
      pinHash,
      pinSalt,
      pinParamsJson: pinParams ? stringifyJson(pinParams, {}) : null,
      active: normalizeActive(user.active, user.enabled),
      defaultRoomId: optionalString(user.defaultRoomId),
      lastSelectedRoomId: optionalString(user.lastSelectedRoomId),
      lastSelectedRoomName: optionalString(user.lastSelectedRoomName),
      lastSelectedRoomAt: optionalString(user.lastSelectedRoomAt),
      lastSelectedRoomDeviceUuid: optionalString(user.lastSelectedRoomDeviceUuid),
      rawJson: buildRawUserJson(user),
      createdAt: optionalString(user.createdAt),
      updatedAt: optionalString(user.updatedAt),
    },
    permissions: uniqueStringList(user.permissions),
    enabledRoomIds: uniqueStringList(user.enabledRoomIds),
    authorizedRoomIds: uniqueStringList(user.authorizedRoomIds),
    paymentMethodIds,
  };
}

export class UsersRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  list() {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY username ASC, id ASC").all();
    return rows.map((row) => this.#hydrateUser(row));
  }

  getById(id) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateUser(row) : null;
  }

  getByUsername(username) {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(asTrimmedString(username));
    return row ? this.#hydrateUser(row) : null;
  }

  replaceAllFromAppState(users, options = {}) {
    const rows = (Array.isArray(users) ? users : [])
      .map((user) => mapUserToRelationalRows(user))
      .filter((row) => row !== null);
    const operation = () => {
      this.#deleteAll();
      for (const row of rows) {
        this.#insertUser(row.user);
        this.#replaceChildValues("user_permissions", "permission", row.user.id, row.permissions);
        this.#replaceChildValues("user_enabled_rooms", "room_id", row.user.id, row.enabledRoomIds);
        this.#replaceChildValues("user_authorized_rooms", "room_id", row.user.id, row.authorizedRoomIds);
        this.#replaceChildValues("user_payment_methods", "payment_method_id", row.user.id, row.paymentMethodIds);
      }
      return rows;
    };

    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM user_permissions").run();
    this.db.prepare("DELETE FROM user_enabled_rooms").run();
    this.db.prepare("DELETE FROM user_authorized_rooms").run();
    this.db.prepare("DELETE FROM user_payment_methods").run();
    this.db.prepare("DELETE FROM users").run();
  }

  #insertUser(row) {
    this.db
      .prepare(
        `
          INSERT INTO users (
            id,
            username,
            full_name,
            role,
            pin_hash,
            pin_salt,
            pin_params_json,
            active,
            default_room_id,
            last_selected_room_id,
            last_selected_room_name,
            last_selected_room_at,
            last_selected_room_device_uuid,
            raw_json,
            created_at,
            updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `
      )
      .run(
        row.id,
        row.username,
        row.fullName,
        row.role,
        row.pinHash,
        row.pinSalt,
        row.pinParamsJson,
        row.active,
        row.defaultRoomId,
        row.lastSelectedRoomId,
        row.lastSelectedRoomName,
        row.lastSelectedRoomAt,
        row.lastSelectedRoomDeviceUuid,
        row.rawJson,
        row.createdAt,
        row.updatedAt
      );
  }

  #replaceChildValues(tableName, columnName, userId, values) {
    const statement = this.db.prepare(`INSERT INTO ${tableName} (user_id, ${columnName}) VALUES (?, ?)`);
    for (const value of values) {
      statement.run(userId, value);
    }
  }

  #listChildValues(tableName, columnName, userId) {
    return this.db
      .prepare(`SELECT ${columnName} AS value FROM ${tableName} WHERE user_id = ? ORDER BY rowid ASC`)
      .all(userId)
      .map((row) => row.value);
  }

  #hydrateUser(row) {
    const raw = safeJsonParse(row.raw_json, {});
    const paymentMethodIds = this.#listChildValues("user_payment_methods", "payment_method_id", row.id);
    const pinParams = safeJsonParse(row.pin_params_json, null);
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      role: row.role,
      pinHash: row.pin_hash,
      pinSalt: row.pin_salt,
      pinParams,
      active: row.active === 1,
      defaultRoomId: row.default_room_id,
      lastSelectedRoomId: row.last_selected_room_id,
      lastSelectedRoomName: row.last_selected_room_name,
      lastSelectedRoomAt: row.last_selected_room_at,
      lastSelectedRoomDeviceUuid: row.last_selected_room_device_uuid,
      permissions: this.#listChildValues("user_permissions", "permission", row.id),
      enabledRoomIds: this.#listChildValues("user_enabled_rooms", "room_id", row.id),
      authorizedRoomIds: this.#listChildValues("user_authorized_rooms", "room_id", row.id),
      paymentMethodIds,
      allowedPaymentMethodIds: paymentMethodIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
