import { createHmac } from "node:crypto";
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

function sanitizeTokenHash(value) {
  const tokenHash = asTrimmedString(value);
  if (!tokenHash) return null;
  return tokenHash;
}

function hashSessionToken(token, tokenSecret) {
  const safeToken = asTrimmedString(token);
  const safeSecret = asTrimmedString(tokenSecret);
  if (!safeToken || !safeSecret) return null;
  return createHmac("sha256", safeSecret).update(safeToken).digest("hex");
}

function buildRawSessionJson(session) {
  const raw = session && typeof session === "object" ? { ...session } : {};
  delete raw.token;
  delete raw.plainToken;
  delete raw.sessionToken;
  return stringifyJson(raw, {});
}

function resolveTokenHash(session, options = {}) {
  const existing = sanitizeTokenHash(session?.tokenHash);
  if (existing) return existing;
  const tokenSecret = options.tokenSecret ?? process.env.BACKEND_TOKEN_SECRET;
  return hashSessionToken(session?.token, tokenSecret);
}

export function mapSessionToRelationalRow(session, options = {}) {
  if (!session || typeof session !== "object") return null;
  const id = asTrimmedString(session.id);
  const userId = asTrimmedString(session.userId);
  const tokenHash = resolveTokenHash(session, options);
  const deviceUuid = asTrimmedString(session.deviceUuid);
  const createdAt = asTrimmedString(session.createdAt);
  if (!id || !userId || !tokenHash || !deviceUuid || !createdAt) return null;

  return {
    id,
    userId,
    tokenHash,
    deviceUuid,
    clientApp: optionalString(session.clientApp),
    createdAt,
    lastSeenAt: optionalString(session.lastSeenAt),
    expiresAt: optionalString(session.expiresAt),
    revokedAt: optionalString(session.revokedAt),
    rawJson: buildRawSessionJson(session),
  };
}

export class SessionsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  list(filters = {}) {
    const clauses = [];
    const params = [];
    const userId = optionalString(filters.userId);
    const deviceUuid = optionalString(filters.deviceUuid);
    const fromCreatedAt = optionalString(filters.from ?? filters.fromCreatedAt);
    const toCreatedAt = optionalString(filters.to ?? filters.toCreatedAt);

    if (userId) {
      clauses.push("user_id = ?");
      params.push(userId);
    }
    if (deviceUuid) {
      clauses.push("device_uuid = ?");
      params.push(deviceUuid);
    }
    if (filters.includeRevoked === false || filters.activeOnly === true) {
      clauses.push("revoked_at IS NULL");
    }
    if (filters.activeOnly === true) {
      const nowIso = typeof filters.nowIso === "function" ? filters.nowIso() : new Date().toISOString();
      clauses.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(nowIso);
    }
    if (fromCreatedAt) {
      clauses.push("created_at >= ?");
      params.push(fromCreatedAt);
    }
    if (toCreatedAt) {
      clauses.push("created_at <= ?");
      params.push(toCreatedAt);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions${where} ORDER BY created_at ASC, id ASC`)
      .all(...params);
    return rows.map((row) => this.#hydrateSession(row));
  }

  getById(id) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateSession(row) : null;
  }

  getByTokenHash(tokenHash) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(asTrimmedString(tokenHash));
    return row ? this.#hydrateSession(row) : null;
  }

  listByUserId(userId) {
    return this.list({ userId });
  }

  replaceAllFromAppState(sessions, options = {}) {
    const rows = (Array.isArray(sessions) ? sessions : [])
      .map((session) => mapSessionToRelationalRow(session, options))
      .filter((row) => row !== null);
    const operation = () => {
      this.#deleteAll();
      for (const row of rows) {
        this.#insertSession(row);
      }
      return rows;
    };

    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM sessions").run();
  }

  #insertSession(row) {
    this.db
      .prepare(
        `
          INSERT INTO sessions (
            id,
            user_id,
            token_hash,
            device_uuid,
            client_app,
            created_at,
            last_seen_at,
            expires_at,
            revoked_at,
            raw_json
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `
      )
      .run(
        row.id,
        row.userId,
        row.tokenHash,
        row.deviceUuid,
        row.clientApp,
        row.createdAt,
        row.lastSeenAt,
        row.expiresAt,
        row.revokedAt,
        row.rawJson
      );
  }

  #hydrateSession(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      deviceUuid: row.device_uuid,
      clientApp: row.client_app,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }
}
