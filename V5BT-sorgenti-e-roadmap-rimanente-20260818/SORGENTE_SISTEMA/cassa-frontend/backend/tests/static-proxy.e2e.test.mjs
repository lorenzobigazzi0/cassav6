import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { freePort, startBackend, startFrontendServer } from "./helpers/test-server.mjs";

function createDeferred() {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

function sendJsonResponse(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function parsePipelinedHttpResponses(raw) {
  const responses = [];
  let offset = 0;
  while (offset < raw.length) {
    const headerEnd = raw.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) throw new Error("Risposta HTTP pipeline senza terminatore header.");
    const headerBlock = raw.subarray(offset, headerEnd).toString("utf8");
    const [statusLine, ...headerLines] = headerBlock.split("\r\n");
    const statusMatch = /^HTTP\/1\.[01] (\d{3})\b/.exec(statusLine);
    if (!statusMatch) throw new Error(`Status line pipeline non valida: ${statusLine}`);
    const headers = {};
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    const contentLength = Number.parseInt(headers["content-length"] ?? "", 10);
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      throw new Error(`Content-Length pipeline non valido per ${statusLine}`);
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (bodyEnd > raw.length) throw new Error(`Body pipeline incompleto per ${statusLine}`);
    responses.push({
      statusCode: Number.parseInt(statusMatch[1], 10),
      headers,
      body: raw.subarray(bodyStart, bodyEnd).toString("utf8"),
    });
    offset = bodyEnd;
  }
  return responses;
}

function pipelinedHttpGetRequests(port, pathNames, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      try {
        resolve(parsePipelinedHttpResponses(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    };
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`Timeout pipeline HTTP dopo ${timeoutMs}ms.`));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", finish);
    socket.once("close", (hadError) => {
      if (!hadError) finish();
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.once("connect", () => {
      socket.setNoDelay(true);
      const payload = pathNames
        .map(
          (pathName, index) =>
            [
              `GET ${pathName} HTTP/1.1`,
              `Host: 127.0.0.1:${port}`,
              `Connection: ${index === pathNames.length - 1 ? "close" : "keep-alive"}`,
              "",
              "",
            ].join("\r\n"),
        )
        .join("");
      socket.write(payload);
    });
  });
}

function rawHttpRequest(port, pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: pathName,
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function rawHttpRequestWithIncompleteOutcome(port, pathName, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome, response = null) => {
      if (settled) return;
      settled = true;
      resolve({ outcome, response });
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: pathName,
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.once("end", () => finish("complete", { statusCode: res.statusCode, body }));
        res.once("aborted", () => finish("aborted", { statusCode: res.statusCode, body }));
        res.once("error", () => finish("error", { statusCode: res.statusCode, body }));
      },
    );
    req.once("error", () => finish("request_error"));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function captureTextStream(stream) {
  let output = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    output += chunk;
  });
  return () => output;
}

function proxyErrorTelemetry(rawOutput) {
  return String(rawOutput ?? "")
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === "frontend_proxy_upstream_error");
}

async function startEchoBackend(t, role = "owner") {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      const statusCode = req.url?.includes("status=418") ? 418 : 207;
      res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          role,
          method: req.method,
          url: req.url,
          body: rawBody ? JSON.parse(rawBody) : null,
          header: req.headers["x-test-proxy"] ?? "",
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${port}`;
}

async function startDelayedLayoutBackend(t, delayMs = 250) {
  const port = await freePort();
  let requestCount = 0;
  let resolveFirstRequest;
  const firstRequestReceived = new Promise((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server = http.createServer((req, res) => {
    requestCount += 1;
    resolveFirstRequest();
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    origin: `http://127.0.0.1:${port}`,
    firstRequestReceived,
    requestCount: () => requestCount,
  };
}

async function startControlledBackend(t, handler) {
  const port = await freePort();
  let requestCount = 0;
  let resolveFirstRequest;
  const firstRequestReceived = new Promise((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server = http.createServer((req, res) => {
    requestCount += 1;
    resolveFirstRequest();
    handler(req, res, requestCount);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    origin: `http://127.0.0.1:${port}`,
    firstRequestReceived,
    requestCount: () => requestCount,
  };
}

async function startWebSocketEchoBackend(t) {
  const port = await freePort();
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/radio/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (message) => {
        ws.send(`echo:${message.toString()}`);
      });
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => {
    wss.close();
    server.close();
  });
  return `http://127.0.0.1:${port}`;
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout opening ${url}`));
    }, 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("[BE][P0] health pubblico pulito", async (t) => {
  const { baseUrl } = await startBackend(t);

  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.service, "cash-backend");
  assert.equal(Object.hasOwn(body, "dbPath"), false);
  assert.equal(Object.hasOwn(body, "token"), false);
  assert.equal(Object.hasOwn(body, "tokenHash"), false);
  assert.equal(Object.hasOwn(body, "env"), false);
});

test("[BE][P0] static server rifiuta path traversal e NUL encoded", async (t) => {
  const backend = await startEchoBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend });

  for (const pathName of [
    "/img/%2e%2e/serve-frontends.mjs",
    "/mobile/%2e%2e/serve-frontends.mjs",
    "/mobile/%5c..%5cserve-frontends.mjs",
    "/postazione/%00/index.html",
  ]) {
    const response = await rawHttpRequest(frontend.port, pathName);
    assert.equal(response.statusCode, 400, pathName);
  }
});

test("[BE][P0] proxy /api conserva metodo, body, header e status", async (t) => {
  const backend = await startEchoBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend });

  const response = await rawHttpRequest(frontend.port, "/api/echo?status=418", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Proxy": "api-proxy",
    },
    body: JSON.stringify({ value: 42 }),
  });

  assert.equal(response.statusCode, 418);
  const body = JSON.parse(response.body);
  assert.equal(body.method, "POST");
  assert.equal(body.url, "/api/echo?status=418");
  assert.equal(body.header, "api-proxy");
  assert.deepEqual(body.body, { value: 42 });
});

test("[BE][P1] un client che annulla non interrompe un GET coalescente condiviso", async (t) => {
  const backend = await startDelayedLayoutBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend.origin });
  const first = http.request({
    hostname: "127.0.0.1",
    port: frontend.port,
    method: "GET",
    path: "/api/integration/layout?fresh=shared",
  });
  const firstSettled = new Promise((resolve) => {
    first.on("response", (response) => {
      response.resume();
      response.on("end", resolve);
    });
    first.on("error", resolve);
  });
  first.end();

  await backend.firstRequestReceived;
  const secondPromise = rawHttpRequest(
    frontend.port,
    "/api/integration/layout?fresh=shared",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  first.destroy();

  const [second] = await Promise.all([secondPromise, firstSettled]);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(JSON.parse(second.body), {
    ok: true,
    url: "/api/integration/layout?fresh=shared",
  });
  assert.equal(backend.requestCount(), 1);
});

test("[BE][P1] GET coalescente ritenta una sola volta sul worker successivo dopo reset pre-header", async (t) => {
  const releaseReset = createDeferred();
  t.after(() => releaseReset.resolve());
  const resettingWorker = await startControlledBackend(t, (req) => {
    req.resume();
    void releaseReset.promise.then(() => req.socket.destroy());
  });
  const healthyWorker = await startControlledBackend(t, (req, res) => {
    sendJsonResponse(res, 200, { ok: true, worker: "second", url: req.url });
  });
  const owner = await startControlledBackend(t, (req, res) => {
    sendJsonResponse(res, 200, { ok: true, barrier: req.url });
  });
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner.origin,
    env: {
      BACKEND_API_WORKER_ORIGIN: [resettingWorker.origin, healthyWorker.origin].join(","),
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    },
  });

  const orderPath = "/api/integration/orders?fresh=retry";
  const responsesPromise = pipelinedHttpGetRequests(frontend.port, [
    orderPath,
    orderPath,
    "/api/echo?barrier=retry",
  ]);
  await Promise.all([resettingWorker.firstRequestReceived, owner.firstRequestReceived]);
  releaseReset.resolve();
  const responses = await responsesPromise;

  assert.equal(responses.length, 3);
  for (const response of responses.slice(0, 2)) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-proxy-backend-role"], "api-worker");
    assert.equal(response.headers["x-proxy-in-flight"], "served");
    assert.deepEqual(JSON.parse(response.body), {
      ok: true,
      worker: "second",
      url: orderPath,
    });
  }
  assert.deepEqual(JSON.parse(responses[2].body), {
    ok: true,
    barrier: "/api/echo?barrier=retry",
  });
  assert.equal(resettingWorker.requestCount(), 1);
  assert.equal(healthyWorker.requestCount(), 1);
  assert.equal(owner.requestCount(), 1);
});

test("[BE][P1] GET coalescente non supera un retry se anche il secondo worker si resetta", async (t) => {
  const releaseFirstReset = createDeferred();
  const releaseSecondReset = createDeferred();
  t.after(() => {
    releaseFirstReset.resolve();
    releaseSecondReset.resolve();
  });
  const firstWorker = await startControlledBackend(t, (req) => {
    req.resume();
    void releaseFirstReset.promise.then(() => req.socket.destroy());
  });
  const secondWorker = await startControlledBackend(t, (req) => {
    req.resume();
    void releaseSecondReset.promise.then(() => req.socket.destroy());
  });
  const thirdWorker = await startControlledBackend(t, (_req, res) => {
    sendJsonResponse(res, 200, { ok: true, worker: "third" });
  });
  const owner = await startEchoBackend(t, "owner");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_API_WORKER_ORIGIN: [
        firstWorker.origin,
        secondWorker.origin,
        thirdWorker.origin,
      ].join(","),
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    },
  });

  const responsePromise = rawHttpRequest(
    frontend.port,
    "/api/integration/orders?fresh=retry-limit",
  );
  await firstWorker.firstRequestReceived;
  releaseFirstReset.resolve();
  await secondWorker.firstRequestReceived;
  releaseSecondReset.resolve();
  const response = await responsePromise;

  assert.equal(response.statusCode, 502);
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: "Backend non raggiungibile.",
  });
  assert.equal(firstWorker.requestCount(), 1);
  assert.equal(secondWorker.requestCount(), 1);
  assert.equal(thirdWorker.requestCount(), 0);
});

test("[BE][P1] overflow waiter coalescenti risponde 503 senza creare un secondo upstream", { timeout: 10_000 }, async (t) => {
  const releaseResponse = createDeferred();
  t.after(() => releaseResponse.resolve());
  const worker = await startControlledBackend(t, (req, res) => {
    req.resume();
    void releaseResponse.promise.then(() => {
      if (!res.destroyed) sendJsonResponse(res, 200, { ok: true, worker: "single" });
    });
  });
  const owner = await startControlledBackend(t, (req, res) => {
    sendJsonResponse(res, 200, { ok: true, barrier: req.url });
  });
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner.origin,
    env: {
      BACKEND_API_WORKER_ORIGIN: worker.origin,
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    },
  });

  const orderPath = "/api/integration/orders?fresh=waiter-overflow";
  const paths = [
    ...Array.from({ length: 49 }, () => orderPath),
    "/api/echo?barrier=waiter-overflow",
  ];
  const responsesPromise = pipelinedHttpGetRequests(frontend.port, paths, 8000);
  await Promise.all([worker.firstRequestReceived, owner.firstRequestReceived]);
  releaseResponse.resolve();
  const responses = await responsesPromise;

  assert.equal(responses.length, 50);
  assert.deepEqual(
    responses.slice(0, 48).map((response) => response.statusCode),
    Array.from({ length: 48 }, () => 200),
  );
  assert.equal(responses[48].statusCode, 503);
  assert.equal(responses[48].headers["x-proxy-in-flight"], "overflow");
  assert.equal(responses[48].headers["retry-after"], "1");
  assert.deepEqual(JSON.parse(responses[48].body), {
    ok: false,
    error: "Troppe richieste coalescenti in attesa.",
  });
  assert.equal(responses[49].statusCode, 200);
  assert.equal(worker.requestCount(), 1);
  assert.equal(owner.requestCount(), 1);
});

test("[BE][P1] una risposta applicativa 503 non viene ritentata", async (t) => {
  const rejectingWorker = await startControlledBackend(t, (_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "busy" }));
  });
  const unusedWorker = await startControlledBackend(t, (_req, res) => {
    res.writeHead(200).end();
  });
  const owner = await startEchoBackend(t, "owner");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_API_WORKER_ORIGIN: [rejectingWorker.origin, unusedWorker.origin].join(","),
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    },
  });

  const response = await rawHttpRequest(
    frontend.port,
    "/api/integration/orders?fresh=application-error",
  );

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "busy" });
  assert.equal(rejectingWorker.requestCount(), 1);
  assert.equal(unusedWorker.requestCount(), 0);
});

test("[BE][P1] una mutazione POST non viene ritentata dopo reset pre-header", async (t) => {
  const resettingWorker = await startControlledBackend(t, (req) => {
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  const unusedWorker = await startControlledBackend(t, (_req, res) => {
    res.writeHead(200).end();
  });
  const owner = await startEchoBackend(t, "owner");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_API_WORKER_ORIGIN: [resettingWorker.origin, unusedWorker.origin].join(","),
      BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
      BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
      BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
      EVENT_OUTBOX_ENABLED: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST:
        "POST /api/integration/orders/create",
    },
  });

  const response = await rawHttpRequest(frontend.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "single-attempt" }),
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");
  assert.equal(resettingWorker.requestCount(), 1);
  assert.equal(unusedWorker.requestCount(), 0);
});

test("[BE][P1] session/status ritenta una sola volta pre-header conservando il body e redigendo la telemetria", async (t) => {
  const receivedBodies = [];
  const backend = await startControlledBackend(t, (req, res, requestCount) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      receivedBodies.push(body);
      if (requestCount === 1) {
        req.socket.destroy();
        return;
      }
      sendJsonResponse(res, 200, { ok: true, replayedBody: JSON.parse(body) });
    });
  });
  const frontend = await startFrontendServer(t, {
    backendOrigin: backend.origin,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readStderr = captureTextStream(frontend.child.stderr);
  const requestBody = JSON.stringify({
    token: "private-token-marker",
    userId: "private-user-marker",
    deviceUuid: "private-device-marker",
  });

  const response = await rawHttpRequest(
    frontend.port,
    "/api/auth/session/status?probe=private-query-marker",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(requestBody)),
      },
      body: requestBody,
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(backend.requestCount(), 2);
  assert.deepEqual(receivedBodies, [requestBody, requestBody]);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    replayedBody: JSON.parse(requestBody),
  });

  const telemetry = proxyErrorTelemetry(readStderr());
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].method, "POST");
  assert.equal(telemetry[0].route, "/api/auth/session/status");
  assert.equal(telemetry[0].targetRole, "api-owner");
  assert.equal(telemetry[0].error.code, "ECONNRESET");
  assert.equal(telemetry[0].phase, "before_upstream_headers");
  assert.equal(Number.isInteger(telemetry[0].elapsedMs), true);
  assert.equal(telemetry[0].elapsedMs >= 0, true);
  assert.doesNotMatch(
    readStderr(),
    /private-(?:token|user|device|query)-marker/,
  );
});

test("[BE][P1] session/status non ritenta dopo header o body upstream", async (t) => {
  const backend = await startControlledBackend(t, (req, res) => {
    req.resume();
    req.once("end", () => {
      const partialBody = Buffer.from('{"ok":true,"partial":');
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(partialBody.length + 64),
      });
      res.write(partialBody);
      setImmediate(() => res.socket.destroy());
    });
  });
  const frontend = await startFrontendServer(t, {
    backendOrigin: backend.origin,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readStderr = captureTextStream(frontend.child.stderr);
  const requestBody = JSON.stringify({ token: "post-header-private-token" });

  const result = await rawHttpRequestWithIncompleteOutcome(
    frontend.port,
    "/api/auth/session/status",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(requestBody)),
      },
      body: requestBody,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.notEqual(result.outcome, "complete");
  assert.equal(backend.requestCount(), 1);
  const telemetry = proxyErrorTelemetry(readStderr());
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].route, "/api/auth/session/status");
  assert.equal(telemetry[0].phase, "after_upstream_body");
  assert.doesNotMatch(readStderr(), /post-header-private-token/);
});

test("[BE][P1] session/status non supera un solo retry pre-header", async (t) => {
  const backend = await startControlledBackend(t, (req) => {
    req.resume();
    req.once("end", () => req.socket.destroy());
  });
  const frontend = await startFrontendServer(t, {
    backendOrigin: backend.origin,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readStderr = captureTextStream(frontend.child.stderr);
  const requestBody = JSON.stringify({ token: "retry-limit-private-token" });

  const response = await rawHttpRequest(frontend.port, "/api/auth/session/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(requestBody)),
    },
    body: requestBody,
  });

  assert.equal(response.statusCode, 502);
  assert.equal(backend.requestCount(), 2);
  assert.equal(proxyErrorTelemetry(readStderr()).length, 2);
  assert.doesNotMatch(readStderr(), /retry-limit-private-token/);
});

test("[BE][P1] uno stream SSE non viene ritentato dopo reset pre-header", async (t) => {
  const releaseReset = createDeferred();
  t.after(() => releaseReset.resolve());
  const resettingRealtime = await startControlledBackend(t, (req) => {
    req.resume();
    void releaseReset.promise.then(() => req.socket.destroy());
  });
  const owner = await startEchoBackend(t, "owner");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_REALTIME_ORIGIN: resettingRealtime.origin,
    },
  });

  const responsePromise = rawHttpRequest(
    frontend.port,
    "/api/integration/notifications/stream",
  );
  await resettingRealtime.firstRequestReceived;
  releaseReset.resolve();
  const response = await responsePromise;

  assert.equal(response.statusCode, 502);
  assert.equal(response.headers["x-proxy-backend-role"], "realtime-gateway");
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: "Backend non raggiungibile.",
  });
  assert.equal(resettingRealtime.requestCount(), 1);
});

test("[BE][P1] reset mid-body pulisce l'inflight e rende subito riusabile la stessa key", { timeout: 5000 }, async (t) => {
  const worker = await startControlledBackend(t, (req, res, requestCount) => {
    if (requestCount === 1) {
      const partialBody = Buffer.from('{"ok":true,"partial":');
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(partialBody.length + 64),
      });
      res.write(partialBody);
      res.socket.end();
      return;
    }
    sendJsonResponse(res, 200, { ok: true, recovered: true, url: req.url });
  });
  const owner = await startEchoBackend(t, "owner");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_API_WORKER_ORIGIN: worker.origin,
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    },
  });
  const pathName = "/api/integration/orders?fresh=mid-body-recovery";

  const failedResponse = await rawHttpRequest(frontend.port, pathName);
  assert.equal(failedResponse.statusCode, 502);
  assert.equal(failedResponse.headers["x-proxy-backend-role"], "api-worker");
  assert.deepEqual(JSON.parse(failedResponse.body), {
    ok: false,
    error: "Backend non raggiungibile.",
  });

  const recoveredResponse = await rawHttpRequest(frontend.port, pathName);
  assert.equal(recoveredResponse.statusCode, 200);
  assert.equal(recoveredResponse.headers["x-proxy-in-flight"], "served");
  assert.deepEqual(JSON.parse(recoveredResponse.body), {
    ok: true,
    recovered: true,
    url: pathName,
  });
  assert.equal(worker.requestCount(), 2);
});

test("[BE][P3] proxy instrada route-aware verso owner, read-worker e realtime-gateway", async (t) => {
  const owner = await startEchoBackend(t, "owner");
  const worker = await startEchoBackend(t, "worker");
  const realtime = await startEchoBackend(t, "realtime");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_API_WORKER_ORIGIN: worker,
      BACKEND_REALTIME_ORIGIN: realtime,
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
    },
  });

  let response = await rawHttpRequest(frontend.port, "/api/integration/menu");
  assert.equal(response.statusCode, 207);
  let body = JSON.parse(response.body);
  assert.equal(body.role, "worker");
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");
  assert.equal(body.header, "");

  response = await rawHttpRequest(frontend.port, "/api/mobile/waiter-pause/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  response = await rawHttpRequest(frontend.port, "/api/integration/notifications/stream");
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "realtime");
  assert.equal(response.headers["x-proxy-backend-role"], "realtime-gateway");

  response = await rawHttpRequest(frontend.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");
});

test("[BE][P3] proxy tiene order-workflow su owner finche fuse audit GO e allowlist route sono chiusi", async (t) => {
  const owner = await startEchoBackend(t, "owner");
  const worker = await startEchoBackend(t, "worker");
  const baseOrderWorkerEnv = {
    BACKEND_API_WORKER_ORIGIN: worker,
    BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
    BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
    BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
    EVENT_OUTBOX_ENABLED: "1",
  };
  const frontendWithoutAuditGo = await startFrontendServer(t, {
    backendOrigin: owner,
    env: baseOrderWorkerEnv,
  });

  let response = await rawHttpRequest(frontendWithoutAuditGo.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  let body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  const frontendWithAuditGo = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      ...baseOrderWorkerEnv,
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
    },
  });

  response = await rawHttpRequest(frontendWithAuditGo.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  const frontendWithWildcardOnly = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      ...baseOrderWorkerEnv,
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "*",
    },
  });

  response = await rawHttpRequest(frontendWithWildcardOnly.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  const frontendWithRouteAllowlist = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      ...baseOrderWorkerEnv,
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/integration/orders/create",
    },
  });

  response = await rawHttpRequest(frontendWithRouteAllowlist.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "worker");
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");

  response = await rawHttpRequest(frontendWithRouteAllowlist.port, "/api/integration/orders/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  const frontendWithSyncAllowlist = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      ...baseOrderWorkerEnv,
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "POST /api/integration/orders/sync",
    },
  });

  response = await rawHttpRequest(frontendWithSyncAllowlist.port, "/api/integration/orders/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "worker");
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");

  response = await rawHttpRequest(frontendWithSyncAllowlist.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  const frontendWithApprovedWildcard = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      ...baseOrderWorkerEnv,
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: "*",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD: "1",
    },
  });

  response = await rawHttpRequest(frontendWithApprovedWildcard.port, "/api/integration/orders/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "worker");
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");
});

test("[BE][P4] proxy manda i lock tavolo al worker solo con lock e sessioni MySQL condivisi", async (t) => {
  const owner = await startEchoBackend(t, "owner");
  const worker = await startEchoBackend(t, "worker");
  const baseEnv = {
    BACKEND_API_WORKER_ORIGIN: worker,
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
  const frontendWithoutSharedLocks = await startFrontendServer(t, {
    backendOrigin: owner,
    env: baseEnv,
  });

  let response = await rawHttpRequest(frontendWithoutSharedLocks.port, "/api/tables/lock/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId: "table-1" }),
  });
  assert.equal(response.statusCode, 207);
  let body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");

  const frontendWithSharedLocks = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      ...baseEnv,
      BACKEND_MYSQL_TABLE_LOCKS: "1",
      BACKEND_MYSQL_SPLIT_SESSIONS: "1",
    },
  });

  response = await rawHttpRequest(frontendWithSharedLocks.port, "/api/tables/lock/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId: "table-1" }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "worker");
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");

  response = await rawHttpRequest(frontendWithSharedLocks.port, "/api/tables/lock/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId: "table-1" }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "owner");
  assert.equal(response.headers["x-proxy-backend-role"], "api-owner");
});

test("[BE][P4] proxy isola lock tavolo nel pool dedicato senza spostare gli ordini", async (t) => {
  const owner = await startEchoBackend(t, "owner");
  const worker = await startEchoBackend(t, "worker");
  const lockWorker = await startEchoBackend(t, "lock-worker");
  const frontend = await startFrontendServer(t, {
    backendOrigin: owner,
    env: {
      BACKEND_API_WORKER_ORIGIN: worker,
      BACKEND_TABLE_LOCK_WORKER_ORIGIN: lockWorker,
      BACKEND_MULTI_PROCESS_READ_WORKERS: "1",
      BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKERS: "1",
      BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED: "1",
      BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS: "1",
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_MYSQL_SPLIT_SESSIONS: "1",
      BACKEND_MYSQL_TABLE_LOCKS: "1",
      BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
      BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
      EVENT_OUTBOX_ENABLED: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO: "1",
      BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST: [
        "POST /api/integration/orders/create",
        "POST /api/tables/lock/acquire",
      ].join(","),
    },
  });

  let response = await rawHttpRequest(frontend.port, "/api/tables/lock/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId: "table-1" }),
  });
  assert.equal(response.statusCode, 207);
  let body = JSON.parse(response.body);
  assert.equal(body.role, "lock-worker");
  assert.equal(response.headers["x-proxy-backend-role"], "table-lock-worker");

  response = await rawHttpRequest(frontend.port, "/api/integration/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.statusCode, 207);
  body = JSON.parse(response.body);
  assert.equal(body.role, "worker");
  assert.equal(response.headers["x-proxy-backend-role"], "api-worker");
});

test("[BE][P0] static server inoltra upgrade WebSocket radio al backend", async (t) => {
  const backend = await startWebSocketEchoBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend });
  const ws = await openWebSocket(`ws://127.0.0.1:${frontend.port}/api/radio/ws`);
  t.after(() => ws.close());

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout websocket reply")), 3000);
    ws.once("message", (message) => {
      clearTimeout(timer);
      resolve(message.toString());
    });
    ws.send("ping");
  });

  assert.equal(reply, "echo:ping");
});

test("[BE][P0] static server consente microfono e posizione al frontend mobile", async (t) => {
  const backend = await startEchoBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend });

  const response = await rawHttpRequest(frontend.port, "/mobile/");

  assert.equal(response.statusCode, 200);
  const permissionsPolicy = String(response.headers["permissions-policy"] ?? "");
  assert.match(permissionsPolicy, /microphone=\(self\)/);
  assert.match(permissionsPolicy, /geolocation=\(self\)/);
});

test("[BE][P0] static server espone il favicon mobile anche sul percorso root", async (t) => {
  const backend = await startEchoBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend });

  const response = await rawHttpRequest(frontend.port, "/favicon.ico");

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"] ?? ""), /image\/svg\+xml/);
  assert.match(response.body, /<svg/);
});

test("[BE][P0] endpoint macchina contanti rimosso non viene proxyato", async (t) => {
  const backend = await startEchoBackend(t);
  const frontend = await startFrontendServer(t, { backendOrigin: backend });

  const removedPath = "/bff/" + "glory/status";
  const response = await rawHttpRequest(frontend.port, removedPath);

  assert.equal(response.statusCode, 404);
  assert.match(response.body, /Not Found/);
});
