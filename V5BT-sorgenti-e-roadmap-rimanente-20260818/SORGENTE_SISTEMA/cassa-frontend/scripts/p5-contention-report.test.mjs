import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeP5ContentionDirectory,
  evaluateP5ContentionGate,
} from "./p5-contention-report.mjs";

test("il gate contesa accetta una baseline pulita e limita coda e lane", () => {
  const gate = evaluateP5ContentionGate({
    requestCount: 10,
    invalidBaselineLines: 0,
    mysqlRetryRequestCount: 0,
    routes: [{
      queueWaitMs: { maxMs: 499 },
      laneWaitMs: { maxMs: 120 },
    }],
    logs: { starvationPromotions: 0, deadlockLines: 0, retryLines: 0 },
    mysql: { innodbDeadlocks: 0 },
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.observed.maxQueueWaitMs, 499);
  assert.deepEqual(gate.failures, []);
});

test("correla attese e retry alle route e produce report durevoli", async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "p5-contention-"));
  try {
    const rows = [
      {
        route: "POST /api/automatic-cash/deposit/start",
        queueWaitMs: 12,
        laneWaitMs: 0,
        responseMs: 30,
        mysqlRetryCount: 0,
      },
      {
        route: "POST /api/payments/table",
        queueWaitMs: 2,
        laneWaitMs: 25,
        responseMs: 80,
        mysqlRetryCount: 1,
        mysqlRetryCodes: ["ER_LOCK_DEADLOCK"],
        mysqlRetryScopes: ["payment"],
      },
    ];
    await fs.writeFile(
      path.join(reportDir, "backend-baseline.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(reportDir, "backend.log"),
      "[db:mutation] promozione anti-starvation\nRetry MySQL code=ER_LOCK_DEADLOCK deadlock\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(reportDir, "report.json"),
      JSON.stringify({
        monitor: {
          mysqlStatusDelta: {
            Innodb_deadlocks: 1,
            Innodb_row_lock_waits: 2,
          },
        },
      }),
      "utf8",
    );

    const result = await analyzeP5ContentionDirectory(reportDir);
    assert.equal(result.summary.requestCount, 2);
    assert.equal(result.summary.mysqlRetryRequestCount, 1);
    assert.equal(result.summary.logs.starvationPromotions, 1);
    assert.equal(result.summary.logs.deadlockLines, 1);
    assert.equal(result.summary.mysql.innodbDeadlocks, 1);
    assert.equal(result.summary.routes[0].queueWaitMs.maxMs, 12);
    assert.equal(result.summary.gate.ok, false);
    assert.deepEqual(result.summary.gate.failures.sort(), [
      "innodb_deadlocks",
      "mutation_starvation_promotions",
      "mysql_deadlock_log_lines",
      "mysql_retry_log_lines",
      "mysql_retry_requests",
    ]);
    assert.equal(await fs.stat(result.jsonPath).then(() => true), true);
    assert.equal(await fs.stat(result.markdownPath).then(() => true), true);
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});
