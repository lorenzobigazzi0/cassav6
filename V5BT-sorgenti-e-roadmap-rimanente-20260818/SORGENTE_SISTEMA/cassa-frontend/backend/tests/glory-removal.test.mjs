import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildRouteRegistry } from "../routes/index.js";
import {
  TEST_TOKEN_SECRET,
  cassaRoot,
  createTempRunDir,
  freePort,
  projectRoot,
  waitForHealth,
  writeTestDb,
} from "./helpers/test-server.mjs";

function withoutMachineEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GLORY" + "_"))
  );
}

async function collectSourceFiles(rootDir) {
  const excludedDirs = new Set([
    ".git",
    ".tmp-refactor",
    "node_modules",
    "test-results",
    "playwright-report",
    "app-state",
    "logs",
    "print-spool",
    "tmp",
  ]);
  const files = [];

  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(fullPath);
    }
  }

  await visit(rootDir);
  return files;
}

test("route registry non contiene endpoint macchina contanti rimossi", () => {
  const removedPath = "/bff/" + "glory";
  const removedHandlerPrefix = "glory" + ".";
  const routes = buildRouteRegistry();

  assert.equal(
    routes.some((route) => String(route.path ?? "").includes(removedPath)),
    false
  );
  assert.equal(
    routes.some((route) => String(route.handlerKey ?? "").startsWith(removedHandlerPrefix)),
    false
  );
});

test("backend parte senza variabili ambiente macchina contanti legacy", async (t) => {
  const port = await freePort();
  const runDir = await createTempRunDir("apptocheck-no-machine-env");
  const dbPath = path.join(runDir, "app-state.json");
  await writeTestDb(dbPath);

  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: cassaRoot,
    env: {
      ...withoutMachineEnv(),
      NODE_ENV: "test",
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: "json",
      BACKEND_DB_PATH: dbPath,
      BACKEND_TOKEN_SECRET: TEST_TOKEN_SECRET,
      FISCAL_PROVIDER: "mock",
      PRINTING_ENABLED: "0",
      SMART_CARD_READER_MODE: "push",
      SMART_CARD_PUSH_TOKEN: "test-smart-card-token",
      SMART_CARD_AUTO_DETECT: "0",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  t.after(() => {
    if (!child.killed) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const response = await fetch(`${baseUrl}${"/bff/" + "glory/status"}`);
  assert.equal(response.status, 404);
});

test("sorgenti non contengono stringhe legacy macchina contanti", async () => {
  const forbidden = ["GLORY" + "_", "/bff/" + "glory", "glory-control-" + "bridge"];
  const files = await collectSourceFiles(projectRoot);
  const matches = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (content === null) continue;
    for (const token of forbidden) {
      if (content.includes(token)) {
        matches.push(`${path.relative(projectRoot, file)} -> ${token}`);
      }
    }
  }

  assert.deepEqual(matches, []);
});
