import assert from "node:assert/strict";
import test from "node:test";
import { createRouteRegistry } from "../core/router.js";
import {
  buildBackendProcessTopologyReport,
  canScaleOrderMutationRoute,
  canScaleOrderMutationRoutes,
  canScaleReadRoutes,
  classifyBackendRouteForProcess,
  createBackendProcessRouteGuard,
  getOrderMutationScalePrerequisites,
  normalizeBackendProcessRole,
  resolveBackendProxyRouteTargetRole,
  shouldRunBackendOwnerJobs,
} from "../core/process-topology.js";
import { buildRouteRegistry } from "../routes/index.js";

function registry() {
  const routes = buildRouteRegistry();
  const handlers = Object.fromEntries(
    routes
      .map((route) => route.handlerKey)
      .filter(Boolean)
      .map((key) => [key, () => {}]),
  );
  return createRouteRegistry(routes, handlers);
}

test("process topology normalizza i ruoli backend espliciti", () => {
  assert.equal(normalizeBackendProcessRole(""), "monolith");
  assert.equal(normalizeBackendProcessRole("owner"), "api-owner");
  assert.equal(normalizeBackendProcessRole("api_replica"), "api-worker");
  assert.equal(normalizeBackendProcessRole("sse-gateway"), "realtime-gateway");
  assert.equal(normalizeBackendProcessRole("lock-worker"), "table-lock-worker");
  assert.equal(normalizeBackendProcessRole("valore-strano"), "monolith");
});

test("route non registrate attraversano il process guard e restano 404 del router", () => {
  for (const role of [
    "monolith",
    "api-owner",
    "api-worker",
    "realtime-gateway",
    "table-lock-worker",
  ]) {
    const guard = createBackendProcessRouteGuard({
      routeRegistry: registry(),
      env: { BACKEND_PROCESS_ROLE: role },
    });
    const decision = guard.decide("GET", "/api/removed-route");
    assert.equal(decision.allowed, true);
    assert.equal(decision.passthrough, true);
    assert.equal(decision.role, role);
  }
});

test("process topology classifica stream realtime, letture e mutazioni ordine", () => {
  const routes = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  assert.equal(
    classifyBackendRouteForProcess(routes.get("GET /api/integration/notifications/stream")).scope,
    "realtime-stream",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("GET /api/integration/menu")).scope,
    "read",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("GET /api/automatic-cash/exchange/:exchangeId/state")).scope,
    "single-owner-read",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/mobile/radio/config")).scope,
    "single-owner-read",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/mobile/waiter-pause/status")).scope,
    "single-owner-read",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/settings/pos")).scope,
    "single-owner-read",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/integration/orders/create")).scope,
    "order-workflow",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/tables/lock/acquire")).scope,
    "order-workflow",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/internal/orders/async-appstate-flush")).scope,
    "internal-service",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/internal/print-spool/auto-print")).scope,
    "internal-service",
  );
  assert.equal(
    classifyBackendRouteForProcess(routes.get("POST /api/payments/ticket")).scope,
    "single-owner-mutation",
  );
});

test("realtime-gateway serve solo health/metrics locali e stream SSE", () => {
  const guard = createBackendProcessRouteGuard({
    routeRegistry: registry(),
    env: { BACKEND_PROCESS_ROLE: "realtime-gateway" },
  });
  assert.equal(guard.decide("GET", "/api/health").allowed, true);
  assert.equal(guard.decide("GET", "/api/monitor/runtime-metrics").allowed, true);
  assert.equal(guard.decide("POST", "/api/internal/orders/async-appstate-flush").allowed, true);
  assert.equal(guard.decide("POST", "/api/internal/print-spool/auto-print").allowed, true);
  assert.equal(guard.decide("GET", "/api/integration/notifications/stream").allowed, true);
  assert.equal(guard.decide("GET", "/api/integration/menu").allowed, false);
  assert.equal(guard.decide("POST", "/api/integration/orders/create").allowed, false);
});

test("api-worker non accetta mutazioni finche lo stato non e esternalizzato", () => {
  const guard = createBackendProcessRouteGuard({
    routeRegistry: registry(),
    env: { BACKEND_PROCESS_ROLE: "api-worker" },
  });
  assert.equal(guard.decide("GET", "/api/integration/menu").allowed, true);
  assert.equal(guard.decide("GET", "/api/automatic-cash/status").allowed, false);
  assert.equal(guard.decide("POST", "/api/mobile/radio/config").allowed, false);
  assert.equal(guard.decide("POST", "/api/mobile/waiter-pause/status").allowed, false);
  assert.equal(guard.decide("POST", "/api/settings/pos").allowed, false);
  assert.equal(guard.decide("POST", "/api/internal/orders/async-appstate-flush").allowed, true);
  assert.equal(guard.decide("POST", "/api/internal/print-spool/auto-print").allowed, true);
  assert.equal(guard.decide("POST", "/api/integration/orders/create").allowed, false);
  assert.equal(guard.decide("POST", "/api/tables/lock/acquire").allowed, false);
  assert.equal(guard.decide("POST", "/api/payments/ticket").allowed, false);
});

test("solo monolith e api-owner eseguono job owner di startup", () => {
  assert.equal(shouldRunBackendOwnerJobs(""), true);
  assert.equal(shouldRunBackendOwnerJobs("monolith"), true);
  assert.equal(shouldRunBackendOwnerJobs("api-owner"), true);
  assert.equal(shouldRunBackendOwnerJobs("api-worker"), false);
  assert.equal(shouldRunBackendOwnerJobs("realtime-gateway"), false);
  assert.equal(shouldRunBackendOwnerJobs("table-lock-worker"), false);
});

test("order worker richiede esplicitamente write-primary, async flush, outbox, stato esternalizzato, audit GO e allowlist", () => {
  assert.equal(canScaleOrderMutationRoutes({ BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1" }), false);
  const baseEnv = {
    BACKEND_PROCESS_ROLE: "api-worker",
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
  };
  assert.equal(canScaleOrderMutationRoutes(baseEnv), false);
  assert.deepEqual(
    getOrderMutationScalePrerequisites(baseEnv).filter((entry) => !entry.ok).map((entry) => entry.name),
    ["BACKEND_APP_STATE_SPLIT_TABLE_STATES", "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS", "EVENT_OUTBOX_ENABLED", "BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO", "BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST"],
  );
  const env = {
    ...baseEnv,
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    EVENT_OUTBOX_ENABLED: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/integration/orders/create",
  };
  assert.equal(canScaleOrderMutationRoutes(env), true);
  const routes = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  assert.equal(canScaleOrderMutationRoute(routes.get("POST /api/integration/orders/create"), env), true);
  assert.equal(canScaleOrderMutationRoute(routes.get("POST /api/integration/orders/sync"), env), false);
  const guard = createBackendProcessRouteGuard({ routeRegistry: registry(), env });
  assert.equal(guard.decide("POST", "/api/integration/orders/create").allowed, true);
  assert.equal(guard.decide("POST", "/api/integration/orders/sync").allowed, false);
  assert.equal(guard.decide("POST", "/api/tables/lock/acquire").allowed, false);
  assert.equal(guard.decide("POST", "/api/payments/ticket").allowed, false);
});

test("table lock su api-worker richiede repository lock e sessioni MySQL condivisi", () => {
  const routes = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  const lockRoute = routes.get("POST /api/tables/lock/acquire");
  const baseEnv = {
    BACKEND_PROCESS_ROLE: "api-worker",
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    EVENT_OUTBOX_ENABLED: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/tables/lock/acquire",
  };

  assert.equal(canScaleOrderMutationRoute(lockRoute, baseEnv), false);
  assert.equal(
    canScaleOrderMutationRoute(lockRoute, { ...baseEnv, BACKEND_MYSQL_TABLE_LOCKS: "1" }),
    false,
  );
  const sharedEnv = {
    ...baseEnv,
    BACKEND_MYSQL_TABLE_LOCKS: "1",
    BACKEND_MYSQL_SPLIT_SESSIONS: "1",
  };
  assert.equal(canScaleOrderMutationRoute(lockRoute, sharedEnv), true);
  const guard = createBackendProcessRouteGuard({ routeRegistry: registry(), env: sharedEnv });
  assert.equal(guard.decide("POST", "/api/tables/lock/acquire").allowed, true);
  assert.equal(guard.decide("POST", "/api/tables/lock/heartbeat").allowed, false);
});

test("table-lock-worker espone soltanto le mutazioni lock allowlisted", () => {
  const env = {
    BACKEND_PROCESS_ROLE: "table-lock-worker",
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    EVENT_OUTBOX_ENABLED: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    BACKEND_MYSQL_TABLE_LOCKS: "1",
    BACKEND_MYSQL_SPLIT_SESSIONS: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: [
      "POST /api/integration/orders/create",
      "POST /api/tables/lock/acquire",
    ].join(","),
  };
  const guard = createBackendProcessRouteGuard({ routeRegistry: registry(), env });
  assert.equal(guard.decide("GET", "/api/health").allowed, true);
  assert.equal(guard.decide("POST", "/api/tables/lock/acquire").allowed, true);
  assert.equal(guard.decide("POST", "/api/integration/orders/create").allowed, false);
  assert.equal(guard.decide("GET", "/api/integration/menu").allowed, false);
  assert.equal(guard.decide("POST", "/api/payments/ticket").allowed, false);
});

test("proxy route-aware manda stream, letture sicure e mutazioni al ruolo corretto", () => {
  const routes = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  assert.equal(canScaleReadRoutes({ BACKEND_MULTI_PROCESS_READ_WORKERS: "1" }), false);
  assert.equal(
    canScaleReadRoutes({
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    }),
    true,
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("GET /api/integration/notifications/stream"), {}),
    "realtime-gateway",
  );
  assert.equal(resolveBackendProxyRouteTargetRole(routes.get("GET /api/integration/menu"), {}), "api-owner");
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("GET /api/integration/menu"), {
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    }),
    "api-worker",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(
      routes.get("GET /api/automatic-cash/exchange/:exchangeId/state"),
      {
        BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
        BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
      },
    ),
    "api-owner",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/mobile/radio/config"), {
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    }),
    "api-owner",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/mobile/waiter-pause/status"), {
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    }),
    "api-owner",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/settings/pos"), {
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    }),
    "api-owner",
  );
  assert.equal(resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), {}), "api-owner");
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), {
      BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
      BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
      BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    }),
    "api-owner",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), {
      BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
      BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
      BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      EVENT_OUTBOX_ENABLED: "1",
    }),
    "api-owner",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), {
      BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
      BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
      BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
      EVENT_OUTBOX_ENABLED: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/integration/orders/create",
    }),
    "api-worker",
  );
  const syncAllowlistEnv = {
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    EVENT_OUTBOX_ENABLED: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/integration/orders/sync",
  };
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/sync"), syncAllowlistEnv),
    "api-worker",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), syncAllowlistEnv),
    "api-owner",
  );
  assert.equal(resolveBackendProxyRouteTargetRole(routes.get("POST /api/payments/ticket"), {}), "api-owner");

  const dedicatedLockEnv = {
    ...syncAllowlistEnv,
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/tables/lock/acquire",
    BACKEND_MYSQL_TABLE_LOCKS: "1",
    BACKEND_MYSQL_SPLIT_SESSIONS: "1",
    BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS: "1",
  };
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/tables/lock/acquire"), dedicatedLockEnv),
    "table-lock-worker",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), dedicatedLockEnv),
    "api-owner",
  );
});

test("order worker wildcard richiede conferma esplicita separata", () => {
  const routes = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  const wildcardEnv = {
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    EVENT_OUTBOX_ENABLED: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "*",
  };

  assert.equal(canScaleOrderMutationRoutes(wildcardEnv), false);
  assert.deepEqual(
    getOrderMutationScalePrerequisites(wildcardEnv).filter((entry) => !entry.ok).map((entry) => entry.name),
    ["BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD"],
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), wildcardEnv),
    "api-owner",
  );

  const approvedWildcardEnv = {
    ...wildcardEnv,
    BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD: "1",
  };
  assert.equal(canScaleOrderMutationRoutes(approvedWildcardEnv), true);
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/create"), approvedWildcardEnv),
    "api-worker",
  );
  assert.equal(
    resolveBackendProxyRouteTargetRole(routes.get("POST /api/integration/orders/sync"), approvedWildcardEnv),
    "api-worker",
  );
});

test("topology report spiega quali prerequisiti bloccano gli order worker", () => {
  const partialEnv = {
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
  };
  assert.deepEqual(
    getOrderMutationScalePrerequisites(partialEnv).filter((entry) => !entry.ok).map((entry) => entry.name),
    ["BACKEND_APP_STATE_SPLIT_TABLE_STATES", "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS", "EVENT_OUTBOX_ENABLED", "BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST"],
  );
  const report = buildBackendProcessTopologyReport(buildRouteRegistry(), partialEnv);
  assert.equal(report.orderWorkersEnabled, false);
  assert.deepEqual(
    report.orderWorkerPrerequisites.filter((entry) => !entry.ok).map((entry) => entry.name),
    ["BACKEND_APP_STATE_SPLIT_TABLE_STATES", "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS", "EVENT_OUTBOX_ENABLED", "BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST"],
  );
  assert.deepEqual(report.orderWorkerRouteAllowlist, []);
});

test("topology report espone i blocchi residui per il multi-processo vero", () => {
  const report = buildBackendProcessTopologyReport(buildRouteRegistry(), {});
  assert.equal(report.role, "monolith");
  assert.equal(report.readWorkersEnabled, false);
  assert.ok(report.counts["order-workflow"] >= 8);
  assert.ok(report.counts["single-owner-read"] >= 1);
  assert.ok(report.counts["single-owner-mutation"] > report.counts["order-workflow"]);
  assert.ok(
    report.blockedForWorkers.some((entry) => entry.key === "POST /api/integration/orders/create"),
  );
  assert.ok(
    report.blockedForWorkers.some((entry) => entry.key === "POST /api/payments/ticket"),
  );
});
