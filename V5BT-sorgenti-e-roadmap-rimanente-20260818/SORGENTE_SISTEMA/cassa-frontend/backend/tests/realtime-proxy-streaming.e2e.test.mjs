import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "../../..");
const serveFrontendsPath = path.join(sourceRoot, "serve-frontends.mjs");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForOutput(child, expected, timeoutMs = 5_000) {
  return await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timeout avvio proxy: ${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(output);
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Proxy terminato prima dell'avvio: ${code}; ${output}`));
    });
  });
}

async function readUntilReady(response, timeoutMs = 1_500) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout SSE proxy")), remaining)),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    if (buffer.includes("event: ready")) {
      await reader.cancel();
      return buffer;
    }
  }
  throw new Error(`Frame ready non ricevuto: ${buffer}`);
}

test("il proxy consegna un piccolo frame SSE senza attendere heartbeat o chiusura stream", async (t) => {
  const upstream = createServer((req, res) => {
    if (!String(req.url).startsWith("/api/integration/notifications/stream")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    setTimeout(() => {
      res.write('event: ready\ndata: {"ok":true}\n\n');
    }, 15);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const proxyPort = await reservePort();
  const child = spawn(process.execPath, [serveFrontendsPath], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      FRONTEND_HOST: "127.0.0.1",
      FRONTEND_PORT: String(proxyPort),
      FRONTEND_ROOT: sourceRoot,
      FRONTEND_HTTPS: "false",
      FRONTEND_LAN_HTTPS: "false",
      BACKEND_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
      BACKEND_REALTIME_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  await waitForOutput(child, "Static server attivo");

  const controller = new AbortController();
  t.after(() => controller.abort());
  const startedAt = performance.now();
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/api/integration/notifications/stream?clientApp=mobile-frontend`,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /text\/event-stream/i);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  await readUntilReady(response);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `frame SSE via proxy ricevuto in ${elapsedMs.toFixed(1)} ms`);
});
