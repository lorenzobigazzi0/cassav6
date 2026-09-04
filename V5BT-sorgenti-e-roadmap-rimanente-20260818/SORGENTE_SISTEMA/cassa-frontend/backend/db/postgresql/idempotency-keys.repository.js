import { createHash } from "node:crypto";

import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 1024 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export const POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "messaging.idempotency-keys",
  methods: [
    { name: "begin", kind: "write", transaction: "required" },
    { name: "finish", kind: "write", transaction: "required" },
    { name: "get", kind: "read", transaction: "none" },
  ],
});

function validationError(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_IDEMPOTENCY_INVALID_INPUT";
  return error;
}

function transitionError(message) {
  const error = new Error(message);
  error.code = "POSTGRES_IDEMPOTENCY_TRANSITION_REJECTED";
  return error;
}

function routingText(value, fieldName, maxLength) {
  const normalized = String(value ?? "").trim();
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maxLength - 1}}$`);
  if (!normalized || normalized.length > maxLength || !pattern.test(normalized)) {
    throw validationError(`${fieldName} non valido.`);
  }
  return normalized;
}

function normalizeRequestHash(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw validationError("requestHash deve essere uno SHA-256 esadecimale da 64 caratteri.");
  }
  return normalized;
}

function canonicalJsonValue(value, seen, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw validationError(`${path} contiene un valore JSON non valido.`);
    return value;
  }
  if (typeof value !== "object") {
    throw validationError(`${path} contiene un valore JSON non valido.`);
  }
  if (seen.has(value)) throw validationError(`${path} contiene un riferimento JSON ciclico.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalJsonValue(entry, seen, `${path}[${index}]`));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw validationError(`${path} deve contenere soltanto valori JSON.`);
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalJsonValue(value[key], seen, `${path}.${key}`);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value, fieldName) {
  const normalized = canonicalJsonValue(value, new Set(), fieldName);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    throw validationError(`${fieldName} supera il limite di ${MAX_JSON_BYTES} byte.`);
  }
  return { normalized, serialized };
}

export function hashPostgresqlIdempotencyRequest(value) {
  const { serialized } = canonicalJson(value, "request JSON");
  return createHash("sha256").update(serialized).digest("hex");
}

function normalizeResponse(value) {
  const response = value === undefined ? null : value;
  return canonicalJson(response, "response JSON").normalized;
}

function normalizeTtlMs(value) {
  const candidate = value === undefined ? DEFAULT_TTL_MS : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1_000 || candidate > MAX_TTL_MS) {
    throw validationError(`ttlMs deve essere un intero tra 1000 e ${MAX_TTL_MS}.`);
  }
  return candidate;
}

function normalizeResponseCode(value) {
  const candidate = Number(value);
  if (!Number.isInteger(candidate) || candidate < 100 || candidate > 599) {
    throw validationError("responseCode deve essere un intero HTTP tra 100 e 599.");
  }
  return candidate;
}

function normalizeTerminalStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!TERMINAL_STATUSES.has(normalized)) {
    throw validationError("status terminale non valido.");
  }
  return normalized;
}

function isoValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function rowToRecord(row) {
  if (!row) return null;
  let response = row.response_json;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      response = null;
    }
  }
  if (response !== null && response !== undefined) {
    response = normalizeResponse(response);
  } else {
    response = null;
  }
  return {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    responseCode: row.response_code === null || row.response_code === undefined
      ? null
      : Number(row.response_code),
    response,
    createdAt: isoValue(row.created_at),
    completedAt: isoValue(row.completed_at),
    expiresAt: isoValue(row.expires_at),
  };
}

function normalizeIdentity(input = {}) {
  return {
    scope: routingText(input.scope, "scope", 128),
    key: routingText(input.key, "key", 191),
  };
}

function requireClient(client) {
  if (typeof client?.query !== "function") {
    throw validationError("client transazionale richiesto per idempotency store.");
  }
  return client;
}

function requireRuntime(runtime) {
  if (typeof runtime?.withConnection !== "function" || typeof runtime?.withTransaction !== "function") {
    throw validationError("runtime PostgreSQL non valido per idempotency store.");
  }
  return runtime;
}

export function createPostgresqlIdempotencyKeysRepository(options = {}) {
  const runtime = requireRuntime(options.runtime);

  const implementation = {
    async begin(clientValue, input = {}) {
      const client = requireClient(clientValue);
      const identity = normalizeIdentity(input);
      const requestHash = normalizeRequestHash(input.requestHash);
      const ttlMs = normalizeTtlMs(input.ttlMs);
      const inserted = await client.query(
        `
          INSERT INTO messaging.idempotency_keys (
            scope,
            key,
            request_hash,
            status,
            response_code,
            response_json,
            created_at,
            completed_at,
            expires_at
          ) VALUES (
            $1, $2, $3, 'processing', NULL, NULL,
            now(), NULL, now() + ($4::bigint * interval '1 millisecond')
          )
          ON CONFLICT (scope, key) DO NOTHING
          RETURNING
            scope, key, request_hash, status, response_code, response_json,
            created_at, completed_at, expires_at
        `,
        [identity.scope, identity.key, requestHash, ttlMs],
      );
      if (inserted.rows?.[0]) {
        return { state: "created", record: rowToRecord(inserted.rows[0]) };
      }

      const existingResult = await client.query(
        `
          SELECT
            scope, key, request_hash, status, response_code, response_json,
            created_at, completed_at, expires_at
          FROM messaging.idempotency_keys
          WHERE scope = $1 AND key = $2
          FOR UPDATE
        `,
        [identity.scope, identity.key],
      );
      const record = rowToRecord(existingResult.rows?.[0]);
      if (!record) {
        throw transitionError("Claim idempotenza concorrente non risolvibile.");
      }
      if (record.requestHash !== requestHash) {
        return { state: "conflict", record };
      }
      return {
        state: record.status,
        record,
        responseCode: record.responseCode,
        response: record.response,
      };
    },

    async finish(clientValue, input = {}) {
      const client = requireClient(clientValue);
      const identity = normalizeIdentity(input);
      const requestHash = normalizeRequestHash(input.requestHash);
      const status = normalizeTerminalStatus(input.status);
      const responseCode = normalizeResponseCode(input.responseCode);
      const response = normalizeResponse(input.response);
      const result = await client.query(
        `
          UPDATE messaging.idempotency_keys
          SET status = $4,
              response_code = $5,
              response_json = $6,
              completed_at = now()
          WHERE scope = $1
            AND key = $2
            AND request_hash = $3
            AND status = 'processing'
          RETURNING
            scope, key, request_hash, status, response_code, response_json,
            created_at, completed_at, expires_at
        `,
        [identity.scope, identity.key, requestHash, status, responseCode, response],
      );
      const record = rowToRecord(result.rows?.[0]);
      if (!record) {
        throw transitionError("Claim idempotenza assente, incompatibile o gia terminale.");
      }
      return record;
    },

    async get(input = {}) {
      const identity = normalizeIdentity(input);
      return runtime.withConnection("idempotency-keys:get", async (client) => {
        const result = await client.query(
          `
            SELECT
              scope, key, request_hash, status, response_code, response_json,
              created_at, completed_at, expires_at
            FROM messaging.idempotency_keys
            WHERE scope = $1 AND key = $2
          `,
          [identity.scope, identity.key],
        );
        return rowToRecord(result.rows?.[0]);
      });
    },
  };

  return assertRepositoryImplementation(
    POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT,
    implementation,
  );
}
