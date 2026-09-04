const PROCESS_ROLES = new Set([
  "monolith",
  "api-owner",
  "api-worker",
  "realtime-gateway",
  "table-lock-worker",
]);

const HEALTH_ROUTES = new Set([
  "GET /api/health",
  "HEAD /api/health",
]);

const LOCAL_READ_ROUTES = new Set([
  "GET /api/monitor/runtime-metrics",
]);

const OWNER_READ_PATH_PREFIXES = [
  "/api/automatic-cash/",
  "/api/settings/",
];

const OWNER_READ_ROUTES = new Set([
  "POST /api/mobile/radio/config",
  "POST /api/mobile/waiter-pause/status",
]);

const ORDER_MUTATION_PATHS = new Set([
  "/api/integration/orders/create",
  "/api/integration/orders/sync",
  "/api/integration/orders/line/split",
  "/api/integration/orders/line/price-override",
  "/api/integration/orders/correct",
  "/api/integration/orders/cancel",
  "/api/integration/orders/correct/resolve",
  "/api/integration/orders/comp",
  "/api/integration/orders/storno",
  "/api/orders/replacement/bar-charge",
  "/api/integration/orders/replacement/bar-charge",
  "/api/integration/orders/transfer/request",
  "/api/integration/orders/transfer/resolve",
  "/api/integration/orders/transfer/force",
]);

const TABLE_LOCK_MUTATION_PATHS = new Set([
  "/api/tables/lock/acquire",
  "/api/tables/lock/heartbeat",
  "/api/tables/lock/release",
  "/api/tables/lock/force-release",
]);

const INTERNAL_SERVICE_PATHS = new Set([
  "/api/internal/orders/async-appstate-flush",
  "/api/internal/monitor/runtime-metrics",
  "/api/internal/print-spool/auto-print",
]);

function routeKey(method, pathname) {
  return `${String(method ?? "").toUpperCase()} ${String(pathname ?? "")}`;
}

function envFlag(env, name) {
  return String(env?.[name] ?? "").trim() === "1";
}

function envValue(env, name) {
  return String(env?.[name] ?? "").trim();
}

function splitEnvList(value) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function routeAllowlistValues(env = {}) {
  return splitEnvList(env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST);
}

function orderWorkerRouteAllowlistUsesWildcard(env = {}) {
  return routeAllowlistValues(env).includes("*");
}

function orderWorkerRouteWildcardAllowed(env = {}) {
  return (
    !orderWorkerRouteAllowlistUsesWildcard(env) ||
    envFlag(env, "BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD")
  );
}

function orderWorkerRouteAllowlistHasAny(env = {}) {
  return routeAllowlistValues(env).length > 0;
}

function orderWorkerRouteAllowlistMatches(route = null, env = {}) {
  const values = routeAllowlistValues(env);
  if (values.includes("*")) return orderWorkerRouteWildcardAllowed(env);
  const key = routeKey(route?.method, route?.path);
  const pathname = String(route?.path ?? "").trim();
  return values.includes(key) || values.includes(pathname);
}

function isTableLockMutationRoute(route = null) {
  return TABLE_LOCK_MUTATION_PATHS.has(String(route?.path ?? ""));
}

function isOwnerReadRoute(route = null) {
  if (route?.mutation === true) return false;
  if (OWNER_READ_ROUTES.has(routeKey(route?.method, route?.path))) return true;
  const pathname = String(route?.path ?? "");
  return OWNER_READ_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function canScaleTableLockMutationRoute(route = null, env = {}) {
  if (!isTableLockMutationRoute(route)) return true;
  return (
    envFlag(env, "BACKEND_MYSQL_TABLE_LOCKS") &&
    envFlag(env, "BACKEND_MYSQL_SPLIT_SESSIONS")
  );
}

export function getOrderMutationScalePrerequisites(env = {}) {
  return [
    {
      name: "BACKEND_MULTI_PROCESS_ORDER_WORKERS",
      ok: envFlag(env, "BACKEND_MULTI_PROCESS_ORDER_WORKERS"),
    },
    {
      name: "BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED",
      ok: envFlag(env, "BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED"),
    },
    {
      name: "BACKEND_APP_STATE_SPLIT_TABLE_STATES",
      ok: envValue(env, "BACKEND_APP_STATE_SPLIT_TABLE_STATES") === "externalized",
      expected: "externalized",
    },
    {
      name: "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS",
      ok: envFlag(env, "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS"),
    },
    {
      name: "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY",
      ok:
        envFlag(env, "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY") ||
        envFlag(env, "ORDERS_RELATIONAL_WRITE_PRIMARY"),
    },
    {
      name: "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH",
      ok:
        envFlag(env, "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH") ||
        envFlag(env, "ORDERS_ASYNC_APPSTATE_FLUSH"),
    },
    {
      name: "EVENT_OUTBOX_ENABLED",
      ok: envFlag(env, "EVENT_OUTBOX_ENABLED"),
    },
    {
      name: "BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO",
      ok: envFlag(env, "BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO"),
    },
    {
      name: "BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST",
      ok: orderWorkerRouteAllowlistHasAny(env),
    },
    ...(orderWorkerRouteAllowlistUsesWildcard(env)
      ? [
          {
            name: "BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD",
            ok: envFlag(env, "BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD"),
          },
        ]
      : []),
  ];
}

export function normalizeBackendProcessRole(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  if (!normalized) return "monolith";
  if (["owner", "primary", "api-primary"].includes(normalized)) return "api-owner";
  if (["worker", "api", "api-replica", "read-worker"].includes(normalized)) return "api-worker";
  if (["realtime", "sse", "sse-gateway", "event-gateway"].includes(normalized)) return "realtime-gateway";
  if (["lock-worker", "table-lock", "table-locks"].includes(normalized)) return "table-lock-worker";
  return PROCESS_ROLES.has(normalized) ? normalized : "monolith";
}

export function classifyBackendRouteForProcess(route = {}) {
  const key = routeKey(route.method, route.path);
  if (HEALTH_ROUTES.has(key) || LOCAL_READ_ROUTES.has(key)) {
    return { scope: "local-control", scalable: true };
  }
  if (INTERNAL_SERVICE_PATHS.has(String(route.path ?? ""))) {
    return { scope: "internal-service", scalable: true };
  }
  if (key === "GET /api/integration/notifications/stream") {
    return { scope: "realtime-stream", scalable: true };
  }
  if (isOwnerReadRoute(route)) {
    return { scope: "single-owner-read", scalable: false };
  }
  if (route.mutation !== true) {
    return { scope: "read", scalable: "read-primary-required" };
  }
  if (
    ORDER_MUTATION_PATHS.has(String(route.path ?? "")) ||
    TABLE_LOCK_MUTATION_PATHS.has(String(route.path ?? ""))
  ) {
    return {
      scope: "order-workflow",
      scalable: "state-externalization-required",
      requiredFlags: [
        "BACKEND_MULTI_PROCESS_ORDER_WORKERS=1",
        "BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1",
        "BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized",
        "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1",
        "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1",
        "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1",
        "EVENT_OUTBOX_ENABLED=1",
        "BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1",
        "BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=<route>",
        "BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD=1 (solo per allowlist *)",
        ...(TABLE_LOCK_MUTATION_PATHS.has(String(route.path ?? ""))
          ? [
              "BACKEND_MYSQL_TABLE_LOCKS=1",
              "BACKEND_MYSQL_SPLIT_SESSIONS=1",
            ]
          : []),
      ],
    };
  }
  return { scope: "single-owner-mutation", scalable: false };
}

export function canScaleOrderMutationRoutes(env = {}) {
  return getOrderMutationScalePrerequisites(env).every((entry) => entry.ok);
}

export function canScaleOrderMutationRoute(route = null, env = {}) {
  return (
    canScaleOrderMutationRoutes(env) &&
    canScaleTableLockMutationRoute(route, env) &&
    orderWorkerRouteAllowlistMatches(route, env)
  );
}

export function canScaleReadRoutes(env = {}) {
  return (
    envFlag(env, "BACKEND_MULTI_PROCESS_READ_WORKERS") &&
    envFlag(env, "BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED")
  );
}

export function shouldRunBackendOwnerJobs(roleValue) {
  const role = normalizeBackendProcessRole(roleValue);
  return role === "monolith" || role === "api-owner";
}

export function resolveBackendProxyRouteTargetRole(route = null, env = {}) {
  if (!route) return "api-owner";
  const classification = classifyBackendRouteForProcess(route);
  if (classification.scope === "realtime-stream") return "realtime-gateway";
  if (classification.scope === "read" && canScaleReadRoutes(env)) return "api-worker";
  if (classification.scope === "order-workflow" && canScaleOrderMutationRoute(route, env)) {
    if (
      isTableLockMutationRoute(route) &&
      envFlag(env, "BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS")
    ) {
      return "table-lock-worker";
    }
    return "api-worker";
  }
  return "api-owner";
}

export function buildBackendProcessTopologyReport(routes = [], env = {}) {
  const role = normalizeBackendProcessRole(env.BACKEND_PROCESS_ROLE);
  const counts = new Map();
  const blockedForWorkers = [];
  for (const route of routes) {
    const classification = classifyBackendRouteForProcess(route);
    counts.set(classification.scope, (counts.get(classification.scope) ?? 0) + 1);
    if (
      classification.scope === "single-owner-read" ||
      classification.scope === "single-owner-mutation" ||
      classification.scope === "order-workflow"
    ) {
      blockedForWorkers.push({
        key: routeKey(route.method, route.path),
        scope: classification.scope,
        requiredFlags: classification.requiredFlags ?? [],
      });
    }
  }
  return {
    role,
    readWorkersEnabled: canScaleReadRoutes(env),
    orderWorkersEnabled: canScaleOrderMutationRoutes(env),
    orderWorkerPrerequisites: getOrderMutationScalePrerequisites(env),
    orderWorkerRouteAllowlist: routeAllowlistValues(env),
    counts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    blockedForWorkers,
  };
}

export function isRouteAllowedForBackendProcess(route = null, env = {}) {
  const role = normalizeBackendProcessRole(env.BACKEND_PROCESS_ROLE);
  if (!route) {
    return {
      allowed: true,
      role,
      classification: null,
      passthrough: true,
      reason: "route non registrata",
    };
  }
  const classification = classifyBackendRouteForProcess(route);
  if (role === "monolith" || role === "api-owner") return { allowed: true, role, classification };
  if (classification.scope === "local-control" || classification.scope === "internal-service") return { allowed: true, role, classification };
  if (role === "realtime-gateway") {
    return classification.scope === "realtime-stream"
      ? { allowed: true, role, classification }
      : { allowed: false, role, classification, reason: "route fuori dal gateway realtime" };
  }
  if (role === "table-lock-worker") {
    if (
      classification.scope === "order-workflow" &&
      isTableLockMutationRoute(route) &&
      canScaleOrderMutationRoute(route, env)
    ) {
      return { allowed: true, role, classification };
    }
    return { allowed: false, role, classification, reason: "route fuori dal worker lock tavoli" };
  }
  if (role === "api-worker") {
    if (classification.scope === "read") return { allowed: true, role, classification };
    if (classification.scope === "order-workflow" && canScaleOrderMutationRoute(route, env)) {
      return { allowed: true, role, classification };
    }
    return { allowed: false, role, classification, reason: "mutazione non scalabile su api-worker" };
  }
  return { allowed: false, role, classification, reason: "ruolo processo non valido" };
}

export function createBackendProcessRouteGuard({ routeRegistry, env = process.env } = {}) {
  const role = normalizeBackendProcessRole(env.BACKEND_PROCESS_ROLE);
  return {
    role,
    decide(method, pathname) {
      const route = routeRegistry?.findRoute?.(method, pathname) ?? null;
      return isRouteAllowedForBackendProcess(route, env);
    },
  };
}
