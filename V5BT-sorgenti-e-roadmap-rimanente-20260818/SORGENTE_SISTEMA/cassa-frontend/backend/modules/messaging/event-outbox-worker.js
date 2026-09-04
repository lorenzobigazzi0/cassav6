import { assertRepositoryImplementation } from "../../core/repository-contract.js";
import { POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT } from "../../db/postgresql/event-outbox.repository.js";

const OUTBOX_CONSUMER_MARKER = Symbol("postgresql-outbox-consumer");
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

function invalid(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_EVENT_OUTBOX_WORKER_INVALID";
  return error;
}

function boundedInteger(value, fallback, fieldName, min, max) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw invalid(`${fieldName} deve essere un intero tra ${min} e ${max}.`);
  }
  return candidate;
}

function normalizeWorkerId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalized)) {
    throw invalid("workerId non valido.");
  }
  return normalized;
}

function normalizeEventType(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(normalized)) {
    throw invalid("eventType del consumer non valido.");
  }
  return normalized;
}

function safeErrorCode(error, fallback = "OUTBOX_CONSUMER_FAILED") {
  const code = String(error?.code ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback;
}

function defaultRetryDelayMs({ attemptCount }) {
  const exponent = Math.max(0, Math.min(16, Math.trunc(Number(attemptCount) || 1) - 1));
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** exponent));
}

function safeObserve(callback) {
  try {
    callback();
  } catch {
    // L'osservabilita non deve cambiare l'esito persistente dell'outbox.
  }
}

export function definePostgresqlOutboxConsumer(input = {}) {
  if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0) {
    throw invalid("Il consumer deve dichiarare almeno un eventType.");
  }
  if (typeof input.consume !== "function") {
    throw invalid("Il consumer deve esporre consume().");
  }
  const eventTypes = [...new Set(input.eventTypes.map(normalizeEventType))];
  if (eventTypes.length !== input.eventTypes.length) {
    throw invalid("Il consumer contiene eventType duplicati.");
  }
  return Object.freeze({
    [OUTBOX_CONSUMER_MARKER]: true,
    consume: input.consume,
    eventTypes: Object.freeze(eventTypes),
    idempotencyKey: "event.id",
  });
}

export function createPostgresqlEventOutboxWorker(options = {}) {
  const repository = assertRepositoryImplementation(
    POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT,
    options.repository,
  );
  const workerId = normalizeWorkerId(options.workerId);
  const batchSize = boundedInteger(options.batchSize, 50, "batchSize", 1, 100);
  const leaseMs = boundedInteger(options.leaseMs, 60_000, "leaseMs", 100, 10 * 60 * 1_000);
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  if (typeof retryDelayMs !== "function") throw invalid("retryDelayMs deve essere una funzione.");
  if (!Array.isArray(options.consumers) || options.consumers.length === 0) {
    throw invalid("Almeno un consumer outbox e richiesto.");
  }
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const consumersByEventType = new Map();
  for (const consumer of options.consumers) {
    if (consumer?.[OUTBOX_CONSUMER_MARKER] !== true) {
      throw invalid("Usare definePostgresqlOutboxConsumer() per dichiarare consumer idempotenti.");
    }
    for (const eventType of consumer.eventTypes) {
      if (consumersByEventType.has(eventType)) {
        throw invalid(`Consumer duplicato per eventType ${eventType}.`);
      }
      consumersByEventType.set(eventType, consumer);
    }
  }

  function incrementCounter(name) {
    safeObserve(() => runtimeMetrics?.incrementCounter?.(name));
  }

  async function retry(event, errorCode) {
    const delayMs = boundedInteger(
      retryDelayMs({ attemptCount: event.attemptCount, event }),
      1_000,
      "retryDelayMs result",
      0,
      MAX_RETRY_DELAY_MS,
    );
    const updated = await repository.reschedule({
      id: event.id,
      workerId,
      delayMs,
      errorCode,
    });
    if (!updated) {
      incrementCounter("postgresEventOutboxLostLeases");
      return "lostLease";
    }
    incrementCounter("postgresEventOutboxRetries");
    return "retried";
  }

  async function processEvent(event) {
    const consumer = consumersByEventType.get(event.eventType);
    if (!consumer) return retry(event, "OUTBOX_CONSUMER_NOT_REGISTERED");
    const context = Object.freeze({
      attemptCount: event.attemptCount,
      eventId: event.id,
      idempotencyKey: event.id,
      workerId,
      async extendLease(extensionMs = leaseMs) {
        const extended = await repository.extendLease({
          id: event.id,
          workerId,
          leaseMs: extensionMs,
        });
        return extended !== null;
      },
    });
    try {
      await consumer.consume(event, context);
      const completed = await repository.markProcessed({ id: event.id, workerId });
      if (!completed) {
        incrementCounter("postgresEventOutboxLostLeases");
        return "lostLease";
      }
      incrementCounter("postgresEventOutboxProcessed");
      return "processed";
    } catch (error) {
      return retry(event, safeErrorCode(error));
    }
  }

  return Object.freeze({
    batchSize,
    leaseMs,
    workerId,
    async runOnce() {
      const events = await repository.claimBatch({ batchSize, leaseMs, workerId });
      incrementCounter("postgresEventOutboxRuns");
      safeObserve(() => runtimeMetrics?.setGauge?.("postgresEventOutboxClaimed", events.length));
      const outcomes = await Promise.all(events.map(processEvent));
      return {
        claimed: events.length,
        processed: outcomes.filter((value) => value === "processed").length,
        retried: outcomes.filter((value) => value === "retried").length,
        lostLease: outcomes.filter((value) => value === "lostLease").length,
      };
    },
  });
}

