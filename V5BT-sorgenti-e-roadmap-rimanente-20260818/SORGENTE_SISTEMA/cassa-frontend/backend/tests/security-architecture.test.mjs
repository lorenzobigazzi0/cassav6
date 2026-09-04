import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRouteRegistry } from "../routes/index.js";
import { startBackend } from "./helpers/test-server.mjs";

const AUTH_STATE_MUTATIONS = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/session/status",
  "POST /api/auth/workstation/select",
]);

const routeKey = (route) => `${String(route.method ?? "").toUpperCase()} ${String(route.path ?? "")}`;
const testDir = path.dirname(fileURLToPath(import.meta.url));
const cassaDir = path.resolve(testDir, "..", "..");

test("route registry esplicita mutazioni pubbliche e POST read-only", () => {
  const routes = buildRouteRegistry();

  for (const route of routes) {
    const key = routeKey(route);
    if (AUTH_STATE_MUTATIONS.has(key)) {
      assert.equal(route.mutation, true, `${key} deve essere serializzata come mutazione DB`);
    }

    if (route.public === true && route.mutation === true) {
      assert.equal(route.allowPublicMutation, true, `${key} deve accettare esplicitamente il rischio public mutation`);
      assert.ok(
        String(route.publicReason ?? "").trim().length >= 12,
        `${key} deve documentare publicReason`
      );
      assert.ok(Number(route.maxBodySize) > 0 && Number(route.maxBodySize) <= 65_536, `${key} deve limitare il body`);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(String(route.method ?? "").toUpperCase()) && route.mutation === false) {
      assert.equal(route.readOnly, true, `${key} deve dichiarare readOnly:true`);
      assert.ok(String(route.readOnlyReason ?? "").trim().length >= 8, `${key} deve documentare readOnlyReason`);
    }
  }
});

test("backend applica header HTTP difensivi sulle API", async (t) => {
  const { baseUrl } = await startBackend(t, { stateOverrides: {} });
  const response = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-permitted-cross-domain-policies"), "none");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
});


test("produzione disabilita token auth/service da query string per default", async () => {
  const script = `process.env.NODE_ENV='production'; const m = await import('./backend/core/config.js'); console.log(JSON.stringify({ auth: m.ALLOW_AUTH_QUERY_TOKEN, service: m.ALLOW_SERVICE_TOKEN_QUERY_PARAM }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: cassaDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { auth: false, service: false });
});

test("CORS usa allowlist header chiusa e non riflette header arbitrari", async (t) => {
  const { baseUrl } = await startBackend(t, { stateOverrides: {} });
  const response = await fetch(`${baseUrl}/api/health`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5180",
      "Access-Control-Request-Headers": "X-Unsafe-Header, X-Workflow-Pin-Reason",
    },
  });

  assert.equal(response.status, 204);
  const allowHeaders = response.headers.get("access-control-allow-headers") ?? "";
  assert.match(allowHeaders, /X-Workflow-Pin-Reason/);
  assert.doesNotMatch(allowHeaders, /X-Unsafe-Header/i);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
