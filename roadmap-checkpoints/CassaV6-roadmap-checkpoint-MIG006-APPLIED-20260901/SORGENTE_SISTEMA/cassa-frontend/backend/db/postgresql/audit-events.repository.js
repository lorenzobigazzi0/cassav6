import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_LIST_LIMIT = 500;
const SENSITIVE_PAYLOAD_KEYS = new Set([
  "password",
  "passwd",
  "pin",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "cookie",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
]);

export const POSTGRESQL_AUDIT_EVENTS_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "audit.events",
  methods: [
    { name: "append", kind: "write", transaction: "required" },
    { name: "getById", kind: "read", transaction: "none" },
    { name: "listByAggregate", kind: "read", transaction: "none" },
  ],
});

function validationError(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_AUDIT_EVENT_INVALID_INPUT";
  return error;
}

function requiredText(value, fieldName, maxLength = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw validationError(`${fieldName} non valido.`);
  }
  return normalized;
}

function optionalText(value, fieldName, maxLength = 200) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return requiredText(value, fieldName, maxLength);
}

function routingKey(value, fieldName, maxLength) {
  const normalized = requiredText(value, fieldName, maxLength);
  const pattern = new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,${maxLength - 1}}$`);
  if (!pattern.test(normalized)) throw validationError(`${fieldName} non valido.`);
  return normalized;
}

function normalizedPayloadKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSensitivePayloadKeys(value, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitivePayloadKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(normalizedPayloadKey(key))) {
      throw validationError(`Chiave payload sensibile non ammessa in ${path}.`);
    }
    assertNoSensitivePayloadKeys(child, `${path}.${key}`);
  }
}

function normalizePayload(value) {
  const payload = value === undefined ? {} : value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw validationError("payload deve essere un oggetto JSON.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw validationError("payload non serializzabile in JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw validationError(`payload supera il limite di ${MAX_PAYLOAD_BYTES} byte.`);
  }
  const clone = JSON.parse(serialized);
  assertNoSensitivePayloadKeys(clone);
  return clone;
}

function isoValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function rowToAuditEvent(row) {
  if (!row) return null;
  let payload = row.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  return {
    id: row.id,
    domain: row.domain,
    aggregateType: row.aggregate_type ?? null,
    aggregateId: row.aggregate_id ?? null,
    action: row.action,
    actorUserId: row.actor_user_id ?? null,
    actorUsername: row.actor_username ?? null,
    occurredAt: isoValue(row.occurred_at),
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
  };
}

function normalizeAggregate(input = {}) {
  const hasType = input.aggregateType !== null
    && input.aggregateType !== undefined
    && String(input.aggregateType).trim() !== "";
  const hasId = input.aggregateId !== null
    && input.aggregateId !== undefined
    && String(input.aggregateId).trim() !== "";
  if (hasType !== hasId) {
    throw validationError("aggregateType e aggregateId devono essere entrambi presenti o entrambi assenti.");
  }
  if (!hasType) return { aggregateType: null, aggregateId: null };
  return {
    aggregateType: routingKey(input.aggregateType, "aggregateType", 128),
    aggregateId: requiredText(input.aggregateId, "aggregateId"),
  };
}

function boundedLimit(value) {
  const candidate = value === undefined ? 100 : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_LIST_LIMIT) {
    throw validationError(`limit deve essere un intero tra 1 e ${MAX_LIST_LIMIT}.`);
  }
  return candidate;
}

function optionalIsoTimestamp(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw validationError(`${fieldName} non valido.`);
  return new Date(timestamp).toISOString();
}

function requireRuntime(runtime) {
  if (typeof runtime?.withConnection !== "function" || typeof runtime?.withTransaction !== "function") {
    throw validationError("runtime PostgreSQL non valido per audit events.");
  }
  return runtime;
}

export function createPostgresqlAuditEventsRepository(options = {}) {
  const runtime = requireRuntime(options.runtime);

  const implementation = {
    async append(client, event = {}) {
      if (typeof client?.query !== "function") {
        throw validationError("client transazionale richiesto per append.");
      }
      if (Object.prototype.hasOwnProperty.call(event, "occurredAt")) {
        throw validationError("occurredAt e assegnato dal clock PostgreSQL.");
      }
      const aggregate = normalizeAggregate(event);
      const normalized = {
        id: requiredText(event.id, "id"),
        domain: routingKey(event.domain, "domain", 64),
        ...aggregate,
        action: routingKey(event.action, "action", 160),
        actorUserId: optionalText(event.actorUserId, "actorUserId"),
        actorUsername: optionalText(event.actorUsername, "actorUsername", 160),
        payload: normalizePayload(event.payload),
      };
      const result = await client.query(
        `
          INSERT INTO audit.events (
            id,
            domain,
            aggregate_type,
            aggregate_id,
            action,
            actor_user_id,
            actor_username,
            payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            id,
            domain,
            aggregate_type,
            aggregate_id,
            action,
            actor_user_id,
            actor_username,
            occurred_at,
            payload
        `,
        [
          normalized.id,
          normalized.domain,
          normalized.aggregateType,
          normalized.aggregateId,
          normalized.action,
          normalized.actorUserId,
          normalized.actorUsername,
          normalized.payload,
        ],
      );
      return rowToAuditEvent(result.rows?.[0]);
    },

    async getById(idValue) {
      const id = requiredText(idValue, "id");
      return runtime.withConnection("audit-events:get-by-id", async (client) => {
        const result = await client.query(
          `
            SELECT
              event.id, event.domain, event.aggregate_type, event.aggregate_id, event.action,
              event.actor_user_id, event.actor_username, event.occurred_at, event.payload
            FROM audit.event_ids registry
            JOIN audit.events event
              ON event.id = registry.id
             AND event.occurred_at = registry.occurred_at
            WHERE registry.id = $1
          `,
          [id],
        );
        return rowToAuditEvent(result.rows?.[0]);
      });
    },

    async listByAggregate(input = {}) {
      const aggregate = normalizeAggregate(input);
      if (!aggregate.aggregateType) {
        throw validationError("aggregateType e aggregateId sono richiesti per la lettura.");
      }
      const beforeOccurredAt = optionalIsoTimestamp(input.beforeOccurredAt, "beforeOccurredAt");
      const limit = boundedLimit(input.limit);
      return runtime.withConnection("audit-events:list-by-aggregate", async (client) => {
        const result = await client.query(
          `
            SELECT
              id, domain, aggregate_type, aggregate_id, action,
              actor_user_id, actor_username, occurred_at, payload
            FROM audit.events
            WHERE aggregate_type = $1
              AND aggregate_id = $2
              AND ($3::timestamptz IS NULL OR occurred_at < $3::timestamptz)
            ORDER BY occurred_at DESC, id DESC
            LIMIT $4
          `,
          [aggregate.aggregateType, aggregate.aggregateId, beforeOccurredAt, limit],
        );
        return (result.rows ?? []).map(rowToAuditEvent);
      });
    },
  };

  return assertRepositoryImplementation(
    POSTGRESQL_AUDIT_EVENTS_REPOSITORY_CONTRACT,
    Object.freeze(implementation),
  );
}
