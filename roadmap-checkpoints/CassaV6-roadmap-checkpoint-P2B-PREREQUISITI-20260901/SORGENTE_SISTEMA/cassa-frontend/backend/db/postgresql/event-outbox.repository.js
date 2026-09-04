import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

const MAX_BATCH_SIZE = 100;
const MIN_LEASE_MS = 100;
const MAX_LEASE_MS = 10 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;

export const POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "messaging.eventOutbox",
  methods: [
    { name: "enqueue", kind: "write", transaction: "required" },
    { name: "claimBatch", kind: "write", transaction: "required" },
    { name: "extendLease", kind: "write", transaction: "none" },
    { name: "markProcessed", kind: "write", transaction: "none" },
    { name: "reschedule", kind: "write", transaction: "none" },
    { name: "getById", kind: "read", transaction: "none" },
  ],
});

function validationError(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_EVENT_OUTBOX_INVALID_INPUT";
  return error;
}

function requiredText(value, fieldName, maxLength = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw validationError(`${fieldName} non valido.`);
  }
  return normalized;
}

function workerId(value) {
  const normalized = requiredText(value, "workerId", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalized)) {
    throw validationError("workerId non valido.");
  }
  return normalized;
}

function routingKey(value, fieldName, maxLength) {
  const normalized = requiredText(value, fieldName, maxLength);
  const pattern = new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,${maxLength - 1}}$`);
  if (!pattern.test(normalized)) throw validationError(`${fieldName} non valido.`);
  return normalized;
}

function controlledErrorCode(value) {
  const normalized = requiredText(value, "errorCode", 80).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(normalized)) {
    throw validationError("errorCode non valido.");
  }
  return normalized;
}

function boundedInteger(value, fallback, fieldName, min, max) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw validationError(`${fieldName} deve essere un intero tra ${min} e ${max}.`);
  }
  return candidate;
}

function normalizePayload(value) {
  const payload = value === undefined ? {} : value;
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw validationError("payload non serializzabile in JSON.");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw validationError(`payload supera il limite di ${MAX_EVENT_PAYLOAD_BYTES} byte.`);
  }
  return payload;
}

function isoValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: isoValue(row.created_at),
    availableAt: isoValue(row.available_at),
    attemptCount: Math.max(0, Math.trunc(Number(row.attempt_count) || 0)),
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: isoValue(row.lease_until),
    processedAt: isoValue(row.processed_at),
    lastError: row.last_error ?? null,
  };
}

function chronological(left, right) {
  return String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""))
    || String(left.id).localeCompare(String(right.id));
}

function requireRuntime(runtime) {
  if (typeof runtime?.withConnection !== "function" || typeof runtime?.withTransaction !== "function") {
    throw validationError("runtime PostgreSQL non valido per event outbox.");
  }
  return runtime;
}

export function createPostgresqlEventOutboxRepository(options = {}) {
  const runtime = requireRuntime(options.runtime);

  const implementation = {
    async enqueue(client, event = {}) {
      if (typeof client?.query !== "function") {
        throw validationError("client transazionale richiesto per enqueue.");
      }
      const normalized = {
        id: requiredText(event.id, "id"),
        aggregateType: routingKey(event.aggregateType, "aggregateType", 128),
        aggregateId: requiredText(event.aggregateId, "aggregateId"),
        eventType: routingKey(event.eventType, "eventType", 160),
        payload: normalizePayload(event.payload),
      };
      const result = await client.query(
        `
          INSERT INTO messaging.event_outbox (
            id,
            aggregate_type,
            aggregate_id,
            event_type,
            payload
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING
            id,
            aggregate_type,
            aggregate_id,
            event_type,
            payload,
            created_at,
            available_at,
            attempt_count,
            lease_owner,
            lease_until,
            processed_at,
            last_error
        `,
        [
          normalized.id,
          normalized.aggregateType,
          normalized.aggregateId,
          normalized.eventType,
          normalized.payload,
        ],
      );
      return rowToEvent(result.rows?.[0]);
    },

    async claimBatch(input = {}) {
      const owner = workerId(input.workerId);
      const leaseMs = boundedInteger(input.leaseMs, 60_000, "leaseMs", MIN_LEASE_MS, MAX_LEASE_MS);
      const batchSize = boundedInteger(input.batchSize, 50, "batchSize", 1, MAX_BATCH_SIZE);
      const claimed = await runtime.withTransaction(
        "event-outbox:claim",
        async (client) => {
          const result = await client.query(
            `
              WITH claimable AS (
                SELECT id
                FROM messaging.event_outbox
                WHERE processed_at IS NULL
                  AND available_at <= now()
                  AND (lease_until IS NULL OR lease_until < now())
                ORDER BY created_at ASC, id ASC
                FOR UPDATE SKIP LOCKED
                LIMIT $3
              )
              UPDATE messaging.event_outbox AS outbox
              SET lease_owner = $1,
                  lease_until = now() + ($2::integer * interval '1 millisecond'),
                  attempt_count = outbox.attempt_count + 1,
                  last_error = NULL
              FROM claimable
              WHERE outbox.id = claimable.id
              RETURNING
                outbox.id,
                outbox.aggregate_type,
                outbox.aggregate_id,
                outbox.event_type,
                outbox.payload,
                outbox.created_at,
                outbox.available_at,
                outbox.attempt_count,
                outbox.lease_owner,
                outbox.lease_until,
                outbox.processed_at,
                outbox.last_error
            `,
            [owner, leaseMs, batchSize],
          );
          return (result.rows ?? []).map(rowToEvent).sort(chronological);
        },
        { isolationLevel: "READ COMMITTED", maxAttempts: 3 },
      );
      return claimed;
    },

    async extendLease(input = {}) {
      const id = requiredText(input.id, "id");
      const owner = workerId(input.workerId);
      const leaseMs = boundedInteger(input.leaseMs, 60_000, "leaseMs", MIN_LEASE_MS, MAX_LEASE_MS);
      return runtime.withConnection("event-outbox:extend-lease", async (client) => {
        const result = await client.query(
          `
            UPDATE messaging.event_outbox
            SET lease_until = now() + ($3::integer * interval '1 millisecond')
            WHERE id = $1
              AND lease_owner = $2
              AND processed_at IS NULL
              AND lease_until > now()
            RETURNING
              id, aggregate_type, aggregate_id, event_type, payload,
              created_at, available_at, attempt_count, lease_owner, lease_until,
              processed_at, last_error
          `,
          [id, owner, leaseMs],
        );
        return rowToEvent(result.rows?.[0]);
      });
    },

    async markProcessed(input = {}) {
      const id = requiredText(input.id, "id");
      const owner = workerId(input.workerId);
      return runtime.withConnection("event-outbox:mark-processed", async (client) => {
        const result = await client.query(
          `
            UPDATE messaging.event_outbox
            SET processed_at = now(),
                lease_owner = NULL,
                lease_until = NULL,
                last_error = NULL
            WHERE id = $1
              AND lease_owner = $2
              AND processed_at IS NULL
              AND lease_until > now()
            RETURNING
              id, aggregate_type, aggregate_id, event_type, payload,
              created_at, available_at, attempt_count, lease_owner, lease_until,
              processed_at, last_error
          `,
          [id, owner],
        );
        return rowToEvent(result.rows?.[0]);
      });
    },

    async reschedule(input = {}) {
      const id = requiredText(input.id, "id");
      const owner = workerId(input.workerId);
      const delayMs = boundedInteger(input.delayMs, 1_000, "delayMs", 0, MAX_RETRY_DELAY_MS);
      const errorCode = controlledErrorCode(input.errorCode);
      return runtime.withConnection("event-outbox:reschedule", async (client) => {
        const result = await client.query(
          `
            UPDATE messaging.event_outbox
            SET available_at = now() + ($3::integer * interval '1 millisecond'),
                lease_owner = NULL,
                lease_until = NULL,
                last_error = $4
            WHERE id = $1
              AND lease_owner = $2
              AND processed_at IS NULL
            RETURNING
              id, aggregate_type, aggregate_id, event_type, payload,
              created_at, available_at, attempt_count, lease_owner, lease_until,
              processed_at, last_error
          `,
          [id, owner, delayMs, errorCode],
        );
        return rowToEvent(result.rows?.[0]);
      });
    },

    async getById(idValue) {
      const id = requiredText(idValue, "id");
      return runtime.withConnection("event-outbox:get-by-id", async (client) => {
        const result = await client.query(
          `
            SELECT
              id, aggregate_type, aggregate_id, event_type, payload,
              created_at, available_at, attempt_count, lease_owner, lease_until,
              processed_at, last_error
            FROM messaging.event_outbox
            WHERE id = $1
          `,
          [id],
        );
        return rowToEvent(result.rows?.[0]);
      });
    },
  };

  return assertRepositoryImplementation(
    POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT,
    Object.freeze(implementation),
  );
}
