import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

export const AGGREGATE_LAST_EVENT_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "realtimeBackbone",
  methods: [
    { name: "resolveBinding", kind: "read", transaction: "supported" },
    { name: "bindLastEventId", kind: "write", transaction: "required" },
  ],
});

function positiveIntegerOrNull(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function resolveAggregateLastEventBinding(event = {}) {
  const eventId = positiveIntegerOrNull(event.id);
  const aggregateType = optionalText(event.aggregateType)?.toLowerCase();
  const aggregateId = optionalText(event.aggregateId);
  if (!eventId || !aggregateType || !aggregateId) return null;
  if (aggregateType === "order") {
    return {
      aggregateId,
      aggregateType,
      eventId,
      idColumn: "id",
      tableName: "orders",
    };
  }
  if (aggregateType === "table") {
    return {
      aggregateId,
      aggregateType,
      eventId,
      idColumn: "table_id",
      tableName: "table_states",
    };
  }
  return null;
}

export function createAggregateLastEventRepository(db, options = {}) {
  const implementation = {
    resolveBinding: resolveAggregateLastEventBinding,
    bindLastEventId(event = {}) {
      const binding = resolveAggregateLastEventBinding(event);
      if (!binding) return { bound: false, reason: "unsupported" };

      const result = db
        .prepare(
          `
            UPDATE ${binding.tableName}
            SET last_event_id = ?
            WHERE ${binding.idColumn} = ?
              AND (last_event_id IS NULL OR last_event_id < ?)
          `,
        )
        .run(binding.eventId, binding.aggregateId, binding.eventId);

      if (result.changes > 0) {
        options.metrics?.incrementCounter?.("aggregateLastEventBound");
        return { ...binding, bound: true };
      }

      const exists = db
        .prepare(`SELECT 1 AS ok FROM ${binding.tableName} WHERE ${binding.idColumn} = ?`)
        .get(binding.aggregateId);
      if (exists) {
        options.metrics?.incrementCounter?.("aggregateLastEventSkipped");
        return { ...binding, bound: false, reason: "not_newer" };
      }

      options.metrics?.incrementCounter?.("aggregateLastEventMissing");
      return { ...binding, bound: false, reason: "missing_aggregate" };
    },
  };
  return assertRepositoryImplementation(
    AGGREGATE_LAST_EVENT_REPOSITORY_CONTRACT,
    implementation,
  );
}

export function bindAggregateLastEventId(db, event = {}, options = {}) {
  return createAggregateLastEventRepository(db, options).bindLastEventId(event);
}

