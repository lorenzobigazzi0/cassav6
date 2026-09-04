import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";

import {
  authHeaders,
  buildTestState,
  cassaRoot,
  freePort,
  loginJson,
  waitForHealth,
} from "./helpers/test-server.mjs";

const dbConfig = {
  host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
  user: process.env.BACKEND_MYSQL_USER || "cassa_app",
  password: process.env.BACKEND_MYSQL_PASSWORD || "amalia2026",
  database: process.env.BACKEND_MYSQL_DATABASE || "cassa",
};

function safeIdentifier(value) {
  const identifier = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Identificatore MySQL test non valido: ${identifier}`);
  }
  return `\`${identifier}\``;
}

async function tryCreateMysqlConnection() {
  try {
    const connection = await mysql.createConnection(dbConfig);
    await connection.ping();
    return connection;
  } catch {
    return null;
  }
}

async function dropTables(connection, tableNames) {
  for (const tableName of tableNames) {
    await connection.query(`DROP TABLE IF EXISTS ${safeIdentifier(tableName)}`);
  }
}

async function stopChildProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // noop
        }
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function waitUntil(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastValue;
}

async function startTcpPrinterSimulator(t) {
  const chunks = [];
  const connections = [];
  const markerWaiters = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      while (markerWaiters.length > 0) {
        const waiter = markerWaiters.shift();
        waiter(text);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    for (const socket of connections) {
      try {
        socket.destroy();
      } catch {
        // noop
      }
    }
    server.close();
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    waitForMarker(marker, timeoutMs = 10_000) {
      const current = Buffer.concat(chunks).toString("utf8");
      if (current.includes(marker)) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout attesa marker stampa: ${marker}`));
        }, timeoutMs);
        markerWaiters.push((text) => {
          if (!text.includes(marker)) return;
          clearTimeout(timeout);
          resolve(text);
        });
      });
    },
  };
}

async function startMysqlBackend(t, { printerPort }) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "print-spool-fast-"));
  const backendPort = await freePort();
  const runSuffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const prefix = `test_fast_spool_${runSuffix}`;
  const tables = {
    appState: `${prefix}_app_state`,
    sessions: `${prefix}_sessions`,
    audit: `${prefix}_audit`,
    domains: `${prefix}_domains`,
    tableLocks: `${prefix}_table_locks`,
  };
  const tableNames = Object.values(tables);
  const seedPath = path.join(runDir, "seed.json");
  const outLog = path.join(runDir, "backend.out.log");
  const errLog = path.join(runDir, "backend.err.log");
  const state = buildTestState((draft) => {
    draft.printSpoolJobs = [];
    draft.posSettings.printers = [
      {
        id: "printer_tcp_fake_fast",
        name: "Printer TCP Fake Fast",
        host: "127.0.0.1",
        port: printerPort,
        purpose: "generic",
        active: true,
      },
    ];
  });
  await fs.writeFile(seedPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: cassaRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      BACKEND_HOST: "127.0.0.1",
      PORT: String(backendPort),
      BACKEND_PORT: String(backendPort),
      BACKEND_DB_MODE: "mysql",
      BACKEND_MYSQL_HOST: dbConfig.host,
      BACKEND_MYSQL_PORT: String(dbConfig.port),
      BACKEND_MYSQL_USER: dbConfig.user,
      BACKEND_MYSQL_PASSWORD: dbConfig.password,
      BACKEND_MYSQL_DATABASE: dbConfig.database,
      BACKEND_MYSQL_APP_STATE_TABLE: tables.appState,
      BACKEND_MYSQL_SPLIT_SESSIONS: "1",
      BACKEND_MYSQL_SESSIONS_TABLE: tables.sessions,
      BACKEND_MYSQL_SPLIT_AUDIT_EVENTS: "1",
      BACKEND_MYSQL_AUDIT_EVENTS_TABLE: tables.audit,
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_MYSQL_APP_STATE_DOMAINS_TABLE: tables.domains,
      BACKEND_MYSQL_TABLE_LOCKS: "1",
      BACKEND_MYSQL_TABLE_LOCKS_TABLE: tables.tableLocks,
      BACKEND_ALLOW_EMPTY_DB_INIT: "1",
      BACKEND_ALLOW_MYSQL_IMPORT_JSON: "1",
      BACKEND_DB_IMPORT_JSON_PATH: seedPath,
      APP_STATE_DIRTY_TRACKING: "1",
      PRINTING_ENABLED: "1",
      PRINT_SPOOL_FAST_WORKER: "1",
      PRINT_TCP_TIMEOUT_MS: "1500",
      PRINT_SPOOL_PRINTER_PROBE_TIMEOUT_MS: "500",
      RUNTIME_METRICS: "1",
      RUNTIME_METRICS_QUEUE_SAMPLE_LIMIT: "200",
      SMART_CARD_AUTO_DETECT: "0",
      SMART_CARD_READER_MODE: "push",
      BACKEND_TOKEN_SECRET: "print-spool-fast-worker-test-secret-1234567890",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outFile = await fs.open(outLog, "a");
  const errFile = await fs.open(errLog, "a");
  child.stdout.on("data", (chunk) => void outFile.write(chunk));
  child.stderr.on("data", (chunk) => void errFile.write(chunk));

  t.after(async () => {
    await stopChildProcess(child);
    await Promise.allSettled([outFile.close(), errFile.close()]);
    const connection = await tryCreateMysqlConnection();
    if (connection) {
      try {
        await dropTables(connection, tableNames);
      } finally {
        await connection.end();
      }
    }
  });

  const baseUrl = `http://127.0.0.1:${backendPort}`;
  await waitForHealth(baseUrl, 20_000);
  return { baseUrl, domainsTable: tables.domains };
}

async function readPrintJobFromDomainTable(connection, domainsTable, jobId) {
  const [rows] = await connection.query(
    `
      SELECT raw_json
      FROM ${safeIdentifier(domainsTable)}
      WHERE domain = 'printSpoolJobs' AND record_id = ?
      LIMIT 1
    `,
    [jobId],
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.raw_json) return null;
  if (typeof row.raw_json === "object") return row.raw_json;
  return JSON.parse(String(row.raw_json));
}

test("print spool fast worker stampa su TCP simulato senza coda globale", async (t) => {
  const mysqlConnection = await tryCreateMysqlConnection();
  if (!mysqlConnection) {
    t.skip("MySQL locale non disponibile per test fast worker stampa.");
    return;
  }
  t.after(() => mysqlConnection.end().catch(() => {}));

  const printer = await startTcpPrinterSimulator(t);
  const { baseUrl, domainsTable } = await startMysqlBackend(t, {
    printerPort: printer.port,
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "print-fast-admin",
    clientApp: "cassa-frontend",
  });

  const resetMetrics = await fetch(`${baseUrl}/api/monitor/runtime-metrics/reset`, {
    method: "POST",
    headers: authHeaders(admin, "print-fast-admin"),
    body: JSON.stringify({}),
  });
  assert.equal(resetMetrics.status, 200);

  const marker = `FAST_WORKER_TCP_${Date.now()}`;
  const printResponse = await fetch(`${baseUrl}/api/integration/print`, {
    method: "POST",
    headers: authHeaders(admin, "print-fast-admin"),
    body: JSON.stringify({
      kind: "generic",
      printerId: "printer_tcp_fake_fast",
      orderId: "fast-worker-test",
      text: `TEST STAMPA FAST WORKER\n${marker}\n`,
    }),
  });
  assert.equal(printResponse.status, 202);
  const printBody = await printResponse.json();
  assert.equal(printBody.accepted, true);
  assert.equal(printBody.async, true);
  assert.equal(printBody.queued, true);
  assert.equal(printBody.status, "queued");
  assert.match(printBody.jobId, /^print_/);

  const printedText = await printer.waitForMarker(marker);
  assert.match(printedText, new RegExp(marker));

  const printedJob = await waitUntil(
    () =>
      readPrintJobFromDomainTable(
        mysqlConnection,
        domainsTable,
        printBody.jobId,
      ).then((job) => (job?.status === "printed" ? job : null)),
    { timeoutMs: 10_000, intervalMs: 100 },
  );
  assert.equal(printedJob?.status, "printed");
  assert.equal(printedJob?.printerId, "printer_tcp_fake_fast");

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "print-fast-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const metricsBody = await metricsResponse.json();
  const queueLabels = [
    ...Object.keys(
      metricsBody.runtimeMetrics?.queues?.dbMutation?.waitMsByLabel ?? {},
    ),
    ...Object.keys(
      metricsBody.runtimeMetrics?.queues?.dbMutation?.runMsByLabel ?? {},
    ),
  ];
  assert.equal(
    queueLabels.some(
      (label) =>
        label.startsWith("print_spool_") ||
        label.includes("/api/integration/print"),
    ),
    false,
  );

});
