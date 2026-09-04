import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanReleaseClean } from "./check-release-clean.mjs";
import { buildSummary, toMarkdown } from "./parse-latency-logs.mjs";
import { collectRuntimeProfile, formatRuntimeProfile } from "./print-runtime-profile.mjs";
import {
  buildFiscalOutboxSmokeSummary,
  formatFiscalOutboxSmokeSummary,
  writeFiscalOutboxSmokeOutput,
} from "./fiscal-outbox-staging-smoke.mjs";
import {
  classifyFiscalDeviceSafety,
  evaluateFiscalSafety,
  formatFiscalOutboxPaymentCanarySummary,
  parseFiscalOutboxPaymentCanaryArgs,
  writeFiscalOutboxPaymentCanaryOutput,
} from "./fiscal-outbox-payment-canary.mjs";
import {
  formatFiscalOutboxMockProviderCanarySummary,
  parseFiscalOutboxMockProviderCanaryArgs,
  writeFiscalOutboxMockProviderCanaryOutput,
} from "./fiscal-outbox-mock-provider-canary.mjs";
import {
  formatFiscalOutboxStep13EvidenceMarkdown,
  parseFiscalOutboxStep13EvidenceArgs,
  writeFiscalOutboxStep13Evidence,
} from "./fiscal-outbox-step13-evidence.mjs";
import { buildDirtyTrackingSummary, toMarkdown as dirtyTrackingToMarkdown } from "./analyze-dirty-tracking-snapshot.mjs";
import { buildCommandInboxSummary, toMarkdown as commandInboxToMarkdown } from "./analyze-command-inbox-snapshot.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassav4-phase0-tools-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("release hygiene passa su directory pulita", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "backend"), { recursive: true });
    const report = scanReleaseClean(dir);
    assert.equal(report.ok, true);
    assert.equal(report.counts.errors, 0);
  });
});

test("release hygiene blocca spool e backup app-state", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "backend", ".print-spool"), { recursive: true });
    await writeFile(path.join(dir, "backend", ".print-spool", "job.txt"), "runtime");
    await writeFile(path.join(dir, "app-state.before-test.json"), "{}");
    const report = scanReleaseClean(dir);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => /print-spool/i.test(issue.path)));
    assert.ok(report.issues.some((issue) => /app-state\.before/i.test(issue.path)));
  });
});

test("runtime profile mostra flag principali e non espone segreti", () => {
  const previous = { ...process.env };
  try {
    process.env.CASSA_RUNTIME_PROFILE = "NEAR_REALTIME";
    process.env.SSE_EVENT_PAYLOAD = "0";
    process.env.EVENT_OUTBOX_ENABLED = "1";
    process.env.BACKEND_TOKEN_SECRET = "super-secret-value";
    const text = formatRuntimeProfile(collectRuntimeProfile());
    assert.match(text, /CASSAv4 runtime profile/);
    assert.match(text, /SSE_EVENT_PAYLOAD/);
    assert.match(text, /NEAR_REALTIME attivo ma SSE_EVENT_PAYLOAD e spento/);
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

test("dev backend launcher resta compatibile con Windows cmd", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(packageJson.scripts?.["dev:backend"], "node backend/scripts/start-backend.mjs");
  const launcher = await readFile(path.resolve("backend", "scripts", "start-backend.mjs"), "utf8");
  assert.match(launcher, /PRINTING_ENABLED/);
  assert.doesNotMatch(packageJson.scripts["dev:backend"], /\w+=\$\{/);
});

test("profilo fiscal outbox staging example non richiede segreti production", async () => {
  const envExample = await readFile(
    path.resolve("configs", "fiscal-outbox-worker-staging.env.example"),
    "utf8",
  );
  assert.match(envExample, /^NODE_ENV=staging$/m);
  assert.doesNotMatch(envExample, /^NODE_ENV=production$/m);
});

test("fiscal outbox payment canary blocca provider fiscale non safe", () => {
  const unsafe = evaluateFiscalSafety({
    fiscalDevices: [
      {
        id: "rt_live",
        fiscalProvider: "pos-fiscal-api",
        apiBaseUrl: "http://127.0.0.1:9090",
        status: "active",
      },
    ],
  });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.reason, /non classificato safe/);

  const safe = evaluateFiscalSafety({
    fiscalDevices: [
      {
        id: "rt_mock",
        fiscalProvider: "mock",
        status: "active",
      },
    ],
  });
  assert.equal(safe.ok, true);
  assert.equal(classifyFiscalDeviceSafety({ fiscalProvider: "staging-pos", status: "active" }).safe, true);

  const override = evaluateFiscalSafety({ fiscalDevices: [{ id: "rt_live", fiscalProvider: "pos-fiscal-api" }] }, { allowRealFiscal: true });
  assert.equal(override.ok, true);
  assert.equal(override.mode, "explicit-real-fiscal-allowed");
});

test("fiscal outbox payment canary parse e report output", async () => {
  await withTempDir(async (dir) => {
    const parsed = parseFiscalOutboxPaymentCanaryArgs([
      "--base-url",
      "http://127.0.0.1:5280/",
      "--execute",
      "--amount=2.5",
      "--output",
      path.join(dir, "canary.json"),
    ]);
    assert.equal(parsed.baseUrl, "http://127.0.0.1:5280");
    assert.equal(parsed.execute, true);
    assert.equal(parsed.amount, 2.5);

    const summary = {
      ok: true,
      generatedAt: "2026-07-07T10:00:00.000Z",
      options: {
        baseUrl: parsed.baseUrl,
        dbPath: parsed.dbPath,
        execute: false,
      },
      checks: [{ name: "backend health", ok: true, detail: "cash-backend" }],
      safety: { mode: "safe", reason: "mock", activeDevices: [] },
      payment: { status: "skipped_preflight" },
    };
    assert.match(formatFiscalOutboxPaymentCanarySummary(summary), /RESULT: OK/);
    const reportPath = writeFiscalOutboxPaymentCanaryOutput(parsed.output, summary);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.ok, true);
  });
});

test("fiscal outbox mock provider canary resta isolato e scrive report", async () => {
  await withTempDir(async (dir) => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    assert.equal(
      packageJson.scripts?.["canary:fiscal-outbox-payment:mock"],
      "node scripts/fiscal-outbox-mock-provider-canary.mjs",
    );
    const script = await readFile(path.resolve("scripts", "fiscal-outbox-mock-provider-canary.mjs"), "utf8");
    assert.match(script, /startFakePosFiscalApi/);
    assert.match(script, /createTempRunDir/);
    assert.match(script, /BACKEND_FISCAL_OUTBOX_WORKER_ENABLED/);
    assert.doesNotMatch(packageJson.scripts["canary:fiscal-outbox-payment:mock"], /allow-real-fiscal/);

    const parsed = parseFiscalOutboxMockProviderCanaryArgs([
      "--idempotency-key",
      "mock-canary-test",
      "--amount=2.25",
      "--output",
      path.join(dir, "mock-canary.json"),
    ]);
    assert.equal(parsed.idempotencyKey, "mock-canary-test");
    assert.equal(parsed.amount, 2.25);
    const summary = {
      ok: true,
      generatedAt: "2026-07-07T10:00:00.000Z",
      runDir: "temp",
      backend: { baseUrl: "http://127.0.0.1:50001" },
      fakeFiscalApi: { baseUrl: "http://127.0.0.1:50002", statusRequests: 1, receiptRequests: 1 },
      payment: { httpStatus: 200, ok: true, fiscalPending: true, relationalWritePrimary: true, id: "pay_1" },
      relational: { dbPath: "rel.sqlite", transactionId: "tx_1", receiptId: "fiscal_1", receiptStatus: "ISSUED", fiscalOutboxId: "out_1", fiscalOutboxStatus: "issued", provider: "pos-fiscal-api" },
    };
    assert.match(formatFiscalOutboxMockProviderCanarySummary(summary), /RESULT: OK/);
    const reportPath = writeFiscalOutboxMockProviderCanaryOutput(parsed.output, summary);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.ok, true);
  });
});

test("fiscal outbox step13 evidence genera report consolidato", async () => {
  await withTempDir(async (dir) => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    assert.equal(
      packageJson.scripts?.["evidence:fiscal-outbox-step13"],
      "node scripts/fiscal-outbox-step13-evidence.mjs",
    );
    const parsed = parseFiscalOutboxStep13EvidenceArgs([
      "--base-url",
      "http://127.0.0.1:5280/",
      "--out-dir",
      dir,
      "--skip-mock",
    ]);
    assert.equal(parsed.baseUrl, "http://127.0.0.1:5280");
    assert.equal(parsed.outDir, path.resolve(dir));
    assert.equal(parsed.skipMock, true);

    const summary = {
      ok: true,
      generatedAt: "2026-07-07T10:00:00.000Z",
      options: {
        baseUrl: parsed.baseUrl,
        dbPath: parsed.dbPath,
        outDir: parsed.outDir,
        username: "admin",
        skipMock: true,
      },
      checks: [
        { name: "live smoke", ok: true, detail: "OK" },
        { name: "live payment preflight", ok: true, detail: "skipped_preflight" },
        { name: "mock provider canary", ok: true, skipped: true, detail: "--skip-mock impostato" },
      ],
      liveSmoke: {
        ok: true,
        checks: [
          { name: "backend health", detail: "cash-backend 0.0.2" },
          { name: "fiscal_outbox table", detail: "presente" },
        ],
        statusCounts: {},
      },
      livePaymentPreflight: {
        ok: true,
        payment: { status: "skipped_preflight" },
        safety: { mode: "blocked", reason: "provider reale", activeDevices: [] },
      },
      mockProviderCanary: { ok: true, skipped: true, reason: "--skip-mock impostato" },
    };
    assert.match(formatFiscalOutboxStep13EvidenceMarkdown(summary), /RESULT: OK/);
    const output = writeFiscalOutboxStep13Evidence(summary, dir);
    assert.match(await readFile(output.mdPath, "utf8"), /Fiscal outbox Step 13 evidence/);
    const json = JSON.parse(await readFile(output.jsonPath, "utf8"));
    assert.equal(json.ok, true);
  });
});

test("parse latency calcola p95 e markdown", () => {
  const report = buildSummary([
    { route: "POST /api/integration/orders/create", responseMs: 100, readDbCount: 1, writeDbCount: 1, status: 200 },
    { route: "POST /api/integration/orders/create", responseMs: 300, readDbCount: 2, writeDbCount: 1, status: 200 },
    { route: "GET /api/integration/layout", responseMs: 50, readDbCount: 1, writeDbCount: 0, status: 200 },
  ]);
  const orderRoute = report.routes.find((route) => route.route.includes("orders/create"));
  assert.equal(orderRoute.responseMs.p95, 300);
  assert.match(toMarkdown(report), /Baseline latency summary/);
});


test("dirty tracking summary evidenzia missing declarations e full fallback", () => {
  const summary = buildDirtyTrackingSummary({
    generatedAtMs: 123,
    counters: {
      appStateDirtyTrackingObservations: 3,
      appStateDirtyTrackingMissing: 1,
      appStateDirtyTrackingOverDeclared: 1,
      writeDbFullStateFallback: 2,
    },
    appState: {
      dirtyTracking: {
        observationsByLabel: {
          "orders.create": { count: 2, p95: 10, p99: 25, max: 25 },
        },
        missingByLabel: {
          "orders.create": { count: 1, p95: 10, p99: 10, max: 10 },
        },
        recentSamples: [
          {
            label: "orders.create",
            declaredDomains: ["sessions"],
            changedDomains: ["integration"],
            missingDeclaredDomains: ["integration"],
          },
        ],
      },
    },
  });
  assert.equal(summary.missingRatePct, 33.33);
  assert.equal(summary.fullFallbackCount, 2);
  assert.match(dirtyTrackingToMarkdown(summary), /orders\.create/);
});


test("command inbox summary calcola replay e conflitti", () => {
  const summary = buildCommandInboxSummary({
    generatedAtMs: 123,
    counters: {
      commandInboxClaims: 10,
      commandInboxCreated: 7,
      commandInboxReplays: 2,
      commandInboxConflicts: 1,
      commandInboxInProgress: 1,
      commandInboxCommitted: 6,
      commandInboxRejected: 1,
      commandInboxFailed: 0,
    },
  });
  assert.equal(summary.replayRatePct, 20);
  assert.equal(summary.conflictRatePct, 10);
  assert.equal(summary.status, "review");
  assert.match(commandInboxToMarkdown(summary), /Command inbox summary/);
});

async function createFiscalOutboxSmokeDb(dbPath, rows = []) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE fiscal_outbox (
        fiscal_id TEXT PRIMARY KEY,
        store_id TEXT,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payment_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        locked_by TEXT,
        locked_at TEXT,
        lock_expires_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        issued_at TEXT
      );
      CREATE TABLE fiscal_receipts (
        id TEXT PRIMARY KEY,
        payment_transaction_id TEXT,
        attempt_scope TEXT,
        fiscal_provider TEXT,
        fiscal_status TEXT
      );
    `);
    const insertOutbox = db.prepare(`
      INSERT INTO fiscal_outbox (
        fiscal_id, aggregate_type, aggregate_id, payment_id, payload_json,
        status, attempt_count, created_at, updated_at, issued_at,
        last_error_code, last_error_message
      ) VALUES (?, 'fiscal_receipt', ?, ?, '{}', ?, 0, ?, ?, ?, ?, ?)
    `);
    const insertReceipt = db.prepare(`
      INSERT INTO fiscal_receipts (
        id, payment_transaction_id, attempt_scope, fiscal_provider, fiscal_status
      ) VALUES (?, ?, 'issue', 'pos-fiscal-api', ?)
    `);
    for (const row of rows) {
      insertOutbox.run(
        row.fiscalId,
        row.aggregateId,
        row.paymentId,
        row.status,
        row.createdAt,
        row.updatedAt,
        row.issuedAt ?? null,
        row.lastErrorCode ?? null,
        row.lastErrorMessage ?? null,
      );
      insertReceipt.run(row.aggregateId, row.paymentId, row.receiptStatus ?? "ISSUED");
    }
  } finally {
    db.close();
  }
}

test("fiscal outbox staging smoke passa su coda pulita", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "relational.sqlite");
    await createFiscalOutboxSmokeDb(dbPath, [
      {
        fiscalId: "fiscal_out_1",
        aggregateId: "receipt_1",
        paymentId: "tx_1",
        status: "issued",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:00:02.000Z",
        issuedAt: "2026-07-07T10:00:02.000Z",
      },
    ]);
    const summary = await buildFiscalOutboxSmokeSummary({
      dbPath,
      baseUrl: "",
      requireBackend: false,
      timeoutMs: 1000,
      maxManualRequired: 0,
      maxFailed: 0,
      maxStaleReady: 0,
      maxReadyAgeMs: 120000,
      maxStaleProcessing: 0,
      maxProcessingAgeMs: 60000,
      nowIso: "2026-07-07T10:01:00.000Z",
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.statusCounts.issued, 1);
    assert.match(formatFiscalOutboxSmokeSummary(summary), /RESULT: OK/);
  });
});

test("fiscal outbox staging smoke salva report JSON", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "relational.sqlite");
    await createFiscalOutboxSmokeDb(dbPath, [
      {
        fiscalId: "fiscal_out_report",
        aggregateId: "receipt_report",
        paymentId: "tx_report",
        status: "issued",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:00:02.000Z",
        issuedAt: "2026-07-07T10:00:02.000Z",
      },
    ]);
    const summary = await buildFiscalOutboxSmokeSummary({
      dbPath,
      baseUrl: "",
      requireBackend: false,
      timeoutMs: 1000,
      maxManualRequired: 0,
      maxFailed: 0,
      maxStaleReady: 0,
      maxReadyAgeMs: 120000,
      maxStaleProcessing: 0,
      maxProcessingAgeMs: 60000,
      nowIso: "2026-07-07T10:01:00.000Z",
    });
    const reportPath = writeFiscalOutboxSmokeOutput(path.join(dir, "reports", "smoke.json"), summary);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.statusCounts.issued, 1);
    assert.equal(report.options.dbPath, dbPath);
  });
});

test("fiscal outbox staging smoke blocca manual_required inatteso", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "relational.sqlite");
    await createFiscalOutboxSmokeDb(dbPath, [
      {
        fiscalId: "fiscal_out_manual",
        aggregateId: "receipt_manual",
        paymentId: "tx_manual",
        status: "manual_required",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:00:02.000Z",
        lastErrorCode: "FISCAL_PROVIDER_DOWN",
        lastErrorMessage: "provider down",
        receiptStatus: "FAILED",
      },
    ]);
    const summary = await buildFiscalOutboxSmokeSummary({
      dbPath,
      baseUrl: "",
      requireBackend: false,
      timeoutMs: 1000,
      maxManualRequired: 0,
      maxFailed: 0,
      maxStaleReady: 0,
      maxReadyAgeMs: 120000,
      maxStaleProcessing: 0,
      maxProcessingAgeMs: 60000,
      nowIso: "2026-07-07T10:01:00.000Z",
    });
    assert.equal(summary.ok, false);
    assert.match(formatFiscalOutboxSmokeSummary(summary), /manual_required: 1\/0/);
  });
});
