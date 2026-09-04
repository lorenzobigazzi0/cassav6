import { assertRepositoryImplementation } from "../../core/repository-contract.js";
import {
  hashPostgresqlIdempotencyRequest,
  POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT,
} from "../../db/postgresql/idempotency-keys.repository.js";

function serviceError(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_IDEMPOTENCY_SERVICE_INVALID_INPUT";
  return error;
}

function normalizeOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("operation deve restituire responseCode e response.");
  }
  return {
    status: value.status === undefined ? "completed" : value.status,
    responseCode: value.responseCode,
    response: value.response,
  };
}

export function createPostgresqlIdempotencyService(options = {}) {
  const runtime = options.runtime;
  if (typeof runtime?.withTransaction !== "function") {
    throw serviceError("runtime PostgreSQL transazionale richiesto.");
  }
  const repository = assertRepositoryImplementation(
    POSTGRESQL_IDEMPOTENCY_KEYS_REPOSITORY_CONTRACT,
    options.repository,
  );

  return Object.freeze({
    async execute(input = {}) {
      if (typeof input.operation !== "function") {
        throw serviceError("operation database richiesta.");
      }
      const requestHash = input.requestHash === undefined
        ? hashPostgresqlIdempotencyRequest(input.request ?? {})
        : String(input.requestHash).trim().toLowerCase();
      const scope = String(input.scope ?? "").trim();

      return runtime.withTransaction(`idempotency:${scope || "invalid"}`, async (client) => {
        const claim = await repository.begin(client, {
          scope: input.scope,
          key: input.key,
          requestHash,
          ttlMs: input.ttlMs,
        });

        if (claim.state === "conflict") {
          return { state: "conflict", record: claim.record };
        }
        if (claim.state === "completed" || claim.state === "failed") {
          return {
            state: "replayed",
            outcome: claim.state,
            responseCode: claim.responseCode,
            response: claim.response,
            record: claim.record,
          };
        }
        if (claim.state !== "created") {
          const error = new Error("Claim idempotenza processing gia persistito: intervento richiesto.");
          error.code = "POSTGRES_IDEMPOTENCY_IN_PROGRESS";
          throw error;
        }

        const outcome = normalizeOutcome(await input.operation(client));
        const record = await repository.finish(client, {
          scope: input.scope,
          key: input.key,
          requestHash,
          ...outcome,
        });
        return {
          state: "executed",
          outcome: record.status,
          responseCode: record.responseCode,
          response: record.response,
          record,
        };
      });
    },
  });
}
