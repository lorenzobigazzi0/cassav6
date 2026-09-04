import assert from "node:assert/strict";
import test from "node:test";
import {
  authRoute,
  permissionRoute,
  publicMutationRoute,
  publicRoute,
  route,
  serviceRoute,
} from "../core/route-builders.js";

test("route-builders centralizzano default mutation/auth", () => {
  assert.deepEqual(route("get", "/api/demo", "demo.read"), {
    method: "GET",
    path: "/api/demo",
    handlerKey: "demo.read",
    mutation: false,
  });
  assert.equal(route("POST", "/api/demo", "demo.write").mutation, true);
  assert.equal(authRoute("POST", "/api/a", "a").authRequired, true);
  assert.equal(permissionRoute("POST", "/api/a", "a", "perm").permission, "perm");
  assert.equal(serviceRoute("POST", "/api/a", "a", "smart-card").service, "smart-card");
});

test("publicMutationRoute richiede opt-in esplicito per policy router", () => {
  const built = publicMutationRoute("POST", "/api/public", "public.write", {
    maxBodySize: 1024,
    publicReason: "Motivo operativo documentato.",
  });
  assert.equal(built.public, true);
  assert.equal(built.authRequired, false);
  assert.equal(built.mutation, true);
  assert.equal(built.allowPublicMutation, true);
});

test("publicRoute read-only mantiene mutation false quando richiesto", () => {
  const built = publicRoute("GET", "/api/public", "public.read", { mutation: false });
  assert.equal(built.public, true);
  assert.equal(built.authRequired, false);
  assert.equal(built.mutation, false);
});
