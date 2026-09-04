import test from "node:test";
import assert from "node:assert/strict";
import { createBridgeDom, evalAsset, installFetchMock } from "./helpers/bridge-env.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");

test("[FE][AUTH] guard Cassa e cache-buster sono allineati nelle copie runtime", async () => {
  const [runtimeGuard, packagedGuard, runtimeIndex, packagedIndex] = await Promise.all([
    readFile(path.join(projectRoot, "dist", "assets", "cash-lock-unlock-guard.js"), "utf8"),
    readFile(path.join(workspaceRoot, "WEBAPP_COMPILATA", "cassa", "assets", "cash-lock-unlock-guard.js"), "utf8"),
    readFile(path.join(projectRoot, "dist", "index.html"), "utf8"),
    readFile(path.join(workspaceRoot, "WEBAPP_COMPILATA", "cassa", "index.html"), "utf8"),
  ]);
  assert.equal(runtimeGuard, packagedGuard);
  assert.equal(runtimeIndex, packagedIndex);
  assert.match(runtimeIndex, /cash-lock-unlock-guard\.js\?v=20260804-user-app-access-v5bt/);
});

test("[FE][AUTH] Cassa identifica esplicitamente il login iniziale e lo sblocco", async () => {
  const dom = createBridgeDom('<!doctype html><body><div class="lock-overlay"></div></body>', {
    url: "http://localhost:5180/cassa/",
  });
  dom.window.Headers = globalThis.Headers;
  dom.window.Request = globalThis.Request;
  const calls = installFetchMock(dom.window, async () => ({ status: 200, ok: true }));

  await evalAsset(dom, "cassa-frontend/dist/assets/cash-lock-unlock-guard.js");
  await dom.window.fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "cashier", pin: "2222" }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/auth/login");
  assert.equal(calls[0].init.headers.get("x-client-app"), "cassa-frontend");
});

test("[FE][AUTH] Cassa identifica il login anche fuori dall'overlay", async () => {
  const dom = createBridgeDom("<!doctype html><body></body>", {
    url: "http://localhost:5180/cassa/",
  });
  dom.window.Headers = globalThis.Headers;
  const calls = installFetchMock(dom.window, async () => ({ status: 200, ok: true }));

  await evalAsset(dom, "cassa-frontend/dist/assets/cash-lock-unlock-guard.js");
  await dom.window.fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
  assert.equal(calls[0].init.headers.get("x-client-app"), "cassa-frontend");
});
