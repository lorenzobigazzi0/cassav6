import assert from "node:assert/strict";
import test from "node:test";

import {
  authHeaders,
  createSimpleOrder,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

test("orders/create espone il breakdown quando il refresh parallelo e attivo", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH: "1",
      RUNTIME_METRICS: "1",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    clientApp: "mobile-frontend",
    deviceUuid: "parallel-refresh-cashier",
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    clientApp: "mobile-frontend",
    deviceUuid: "parallel-refresh-admin",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "parallel-refresh-cashier",
    idempotencyKey: "parallel-refresh-order-1",
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.ok, true);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "parallel-refresh-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const metricsBody = await metricsResponse.json();
  const labels = metricsBody.runtimeMetrics.operations.runMsByLabel;

  for (const label of [
    "orderCreateRead:appStateRead",
    "orderCreateRead:refreshTableLocks",
    "orderCreateRead:refreshStationStates",
    "orderCreateRead:parallelExternalRefresh",
    "orderCreateInternal:auth",
    "orderCreateInternal:relationalPrimary",
    "orderCreateInternal:appStateWrite",
    "orderCreateInternal:outboxPublish",
    "orderCreateInternal:response",
  ]) {
    assert.equal(labels[label]?.count, 1, `metrica mancante: ${label}`);
  }
});
