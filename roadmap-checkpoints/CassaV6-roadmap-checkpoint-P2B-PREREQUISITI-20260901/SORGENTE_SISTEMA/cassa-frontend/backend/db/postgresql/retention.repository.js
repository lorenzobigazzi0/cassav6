import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

const MAX_GROWTH_ROWS = 500;

export const POSTGRESQL_RETENTION_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "app-meta.retention",
  methods: [
    { name: "listPolicies", kind: "read", transaction: "none" },
    { name: "getTableGrowth", kind: "read", transaction: "none" },
    { name: "getRetentionCandidates", kind: "read", transaction: "none" },
  ],
});

function validationError(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_RETENTION_INVALID_INPUT";
  return error;
}

function requireRuntime(runtime) {
  if (typeof runtime?.withConnection !== "function") {
    throw validationError("runtime PostgreSQL non valido per retention.");
  }
  return runtime;
}

function isoValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowToPolicy(row) {
  return {
    target: row.target,
    retentionDays: row.retention_days === null || row.retention_days === undefined
      ? null
      : numberValue(row.retention_days),
    strategy: row.strategy,
    enabled: row.enabled === true,
    legallyRequired: row.legally_required === true,
    decisionRef: row.decision_ref,
    approvedAt: isoValue(row.approved_at),
    notes: row.notes ?? null,
    updatedAt: isoValue(row.updated_at),
  };
}

function rowToGrowth(row) {
  return {
    schemaName: row.schema_name,
    tableName: row.table_name,
    relationKind: row.relation_kind,
    totalBytes: numberValue(row.total_bytes),
    approxRows: numberValue(row.approx_rows),
    deadRows: numberValue(row.dead_rows),
    lastAnalyzeAt: isoValue(row.last_analyze_at),
  };
}

function rowToCandidates(row) {
  return {
    target: row.target,
    retentionDays: row.retention_days === null || row.retention_days === undefined
      ? null
      : numberValue(row.retention_days),
    strategy: row.strategy,
    enabled: row.enabled === true,
    eligibleRows: numberValue(row.eligible_rows),
    oldestEligibleAt: isoValue(row.oldest_eligible_at),
  };
}

function boundedLimit(value) {
  const candidate = value === undefined ? 100 : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_GROWTH_ROWS) {
    throw validationError(`limit deve essere un intero tra 1 e ${MAX_GROWTH_ROWS}.`);
  }
  return candidate;
}

export function createPostgresqlRetentionRepository(options = {}) {
  const runtime = requireRuntime(options.runtime);
  const implementation = {
    async listPolicies() {
      return runtime.withConnection("retention:list-policies", async (client) => {
        const result = await client.query(`
          SELECT
            target, retention_days, strategy, enabled, legally_required,
            decision_ref, approved_at, notes, updated_at
          FROM app_meta.retention_policies
          ORDER BY target
        `);
        return (result.rows ?? []).map(rowToPolicy);
      });
    },

    async getTableGrowth(input = {}) {
      const limit = boundedLimit(input.limit);
      return runtime.withConnection("retention:table-growth", async (client) => {
        const result = await client.query(
          `
            SELECT
              schema_name, table_name, relation_kind, total_bytes,
              approx_rows, dead_rows, last_analyze_at
            FROM app_meta.v_table_growth
            ORDER BY total_bytes DESC, schema_name, table_name
            LIMIT $1
          `,
          [limit],
        );
        return (result.rows ?? []).map(rowToGrowth);
      });
    },

    async getRetentionCandidates() {
      return runtime.withConnection("retention:candidates", async (client) => {
        const result = await client.query(`
          SELECT
            target, retention_days, strategy, enabled,
            eligible_rows, oldest_eligible_at
          FROM app_meta.v_retention_candidates
          ORDER BY target
        `);
        return (result.rows ?? []).map(rowToCandidates);
      });
    },
  };
  return assertRepositoryImplementation(POSTGRESQL_RETENTION_REPOSITORY_CONTRACT, implementation);
}
