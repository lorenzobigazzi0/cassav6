import assert from "node:assert/strict";
import test from "node:test";
import { buildScopedReadsRoutes } from "../modules/scoped-reads/index.js";

test("scoped reads registra endpoint mirati Step 9A read-only", () => {
  const routes = buildScopedReadsRoutes();
  const byPath = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));

  [
    "GET /api/tables/:tableId",
    "GET /api/tables/:tableId/open-order",
    "GET /api/rooms/:roomId/tables",
    "GET /api/notifications",
    "GET /api/print/jobs/:jobId",
  ].forEach((key) => {
    assert.equal(byPath.has(key), true, `${key} non registrato`);
    assert.equal(byPath.get(key).mutation, false);
    assert.equal(byPath.get(key).public, true);
  });
});
