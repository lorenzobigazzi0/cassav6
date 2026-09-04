import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanReleaseClean } from "../../scripts/check-release-clean.mjs";
import { buildSummary, toMarkdown } from "../../scripts/parse-latency-logs.mjs";
import { collectRuntimeProfile, formatRuntimeProfile } from "../../scripts/print-runtime-profile.mjs";
import { buildBaselineRequestRecord } from "../modules/baseline-diagnostics.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassav4-phase0-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("check-release-clean passa su directory pulita", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "backend"), { recursive: true });
    const report = await scanReleaseClean(dir);
    assert.equal(report.ok, true);
    assert.equal(report.counts.errors, 0);
  });
});

test("check-release-clean segnala backup app-state e spool non vuoto", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "backend", ".print-spool"), { recursive: true });
    await writeFile(path.join(dir, "backend", ".print-spool", "job.txt"), "runtime");
    await writeFile(path.join(dir, "app-state.before-test.json"), "{}");
    const report = await scanReleaseClean(dir);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => /\.print-spool/.test(issue.path) && /non vuota/.test(issue.message)));
    assert.ok(report.issues.some((issue) => /app-state\.before/.test(issue.path)));
  });
});

test("runtime profile stampa flag principali senza segreti in chiaro", () => {
  const previous = { ...process.env };
  try {
    process.env.INVOCATION_ID = "";
    process.env.JOURNAL_STREAM = "";
    process.env.CASSA_RUNTIME_PROFILE = "near-realtime";
    process.env.SSE_EVENT_PAYLOAD = "0";
    process.env.EVENT_OUTBOX_ENABLED = "1";
    process.env.BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR = "1";
    process.env.BACKEND_TOKEN_SECRET = "super-secret-value";
    const text = formatRuntimeProfile(collectRuntimeProfile());
    assert.match(text, /CASSAv4 runtime profile/);
    assert.match(text, /SSE_EVENT_PAYLOAD/);
    assert.match(text, /NEAR_REALTIME attivo ma SSE_EVENT_PAYLOAD e spento/);
    assert.match(text, /durablePaymentMirror/);
    assert.match(text, /requested=ON effective=OFF source=env/);
    assert.doesNotMatch(text, /super-secret-value/);
  } finally {
    process.env = previous;
  }
});

test("runtime profile segnala worker fiscale con write-primary pagamenti parziali", () => {
  const previous = { ...process.env };
  try {
    process.env = { ...previous };
    process.env.CASSA_RUNTIME_PROFILE = "fiscal-outbox-worker-staging";
    process.env.BACKEND_RELATIONAL_ENABLED = "1";
    process.env.EVENT_OUTBOX_ENABLED = "1";
    process.env.IDEMPOTENCY_STORE_ENABLED = "1";
    process.env.BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY = "1";
    process.env.BACKEND_FISCAL_OUTBOX_ENABLED = "1";
    process.env.BACKEND_FISCAL_OUTBOX_WORKER_ENABLED = "1";
    process.env.BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY = "1";
    process.env.BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY = "0";
    process.env.BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY = "1";
    const text = formatRuntimeProfile(collectRuntimeProfile());
    assert.match(text, /pagamenti write-primary parziali/);
  } finally {
    process.env = previous;
  }
});

test("parse-latency-logs calcola p95 e markdown", () => {
  const records = [
    { type: "http_request", route: "POST /api/integration/orders/create", responseMs: 100, readDbCount: 1, writeDbCount: 1, writeDbMs: 20, status: 200 },
    { type: "http_request", route: "POST /api/integration/orders/create", responseMs: 300, readDbCount: 2, writeDbCount: 1, writeDbMs: 30, status: 200 },
    { type: "http_request", route: "GET /api/integration/layout", responseMs: 50, readDbCount: 1, writeDbCount: 0, writeDbMs: 0, status: 200 },
  ];
  const report = buildSummary(records);
  const orderRoute = report.routes.find((route) => route.route.includes("orders/create"));
  assert.equal(orderRoute.responseMs.p95, 300);
  assert.match(toMarkdown(report), /Baseline latency summary/);
});

test("baseline diagnostics record non include token e normalizza campi", () => {
  const record = buildBaselineRequestRecord({
    requestId: "req-1",
    method: "POST",
    path: "/api/test",
    durationMs: 42,
    status: 200,
    readDbCount: 1,
    writeDbCount: 0,
    dirtyDomains: ["orders", "orders", "tables"],
    mysqlRetryCount: 2,
    mysqlRetryScopes: ["payment", "payment"],
    mysqlRetryCodes: ["ER_LOCK_DEADLOCK"],
    token: "not-to-log",
  });
  assert.equal(record.responseMs, 42);
  assert.deepEqual(record.dirtyDomains, ["orders", "tables"]);
  assert.equal(record.mysqlRetryCount, 2);
  assert.deepEqual(record.mysqlRetryScopes, ["payment"]);
  assert.deepEqual(record.mysqlRetryCodes, ["ER_LOCK_DEADLOCK"]);
  assert.equal(Object.hasOwn(record, "token"), false);
});
