import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPrintSpoolRetentionPlan,
  cleanupPrintSpoolRetention,
} from "../modules/print-spool/retention.js";
import { createRuntimeMetrics } from "../modules/runtime-metrics.js";

const HOUR_MS = 60 * 60 * 1000;

test("M6 blocca i default post-K della print spool retention", () => {
  const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(
    serverSource,
    /const PRINT_SPOOL_MAX_JOBS = parsePositiveInt\([\s\S]+process\.env\.PRINT_SPOOL_MAX_JOBS,[\s\S]+1_200,/,
    "post-K il buffer record spool deve restare sopra il picco endurance osservato",
  );
  assert.match(
    serverSource,
    /const PRINT_SPOOL_RETENTION_TERMINAL_HOURS = parsePositiveInt\([\s\S]+process\.env\.PRINT_SPOOL_RETENTION_TERMINAL_HOURS,[\s\S]+24,/,
    "i file terminali restano disponibili per debug nella stessa giornata",
  );
  assert.match(
    serverSource,
    /const PRINT_SPOOL_RETENTION_ORPHAN_HOURS = parsePositiveInt\([\s\S]+process\.env\.PRINT_SPOOL_RETENTION_ORPHAN_HOURS,[\s\S]+12,/,
    "gli orfani senza record DB devono essere puliti prima dei terminali referenziati",
  );
});

test("print spool retention cancella solo terminali/orfani oltre soglia", () => {
  const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
  const files = [
    { fileName: "active.txt", mtimeMs: nowMs - 48 * HOUR_MS, size: 1 },
    { fileName: "printed-old.txt", mtimeMs: nowMs - 48 * HOUR_MS, size: 1 },
    { fileName: "printed-recent.txt", mtimeMs: nowMs - 2 * HOUR_MS, size: 1 },
    { fileName: "orphan-old.txt", mtimeMs: nowMs - 48 * HOUR_MS, size: 1 },
    { fileName: "orphan-recent.txt", mtimeMs: nowMs - 2 * HOUR_MS, size: 1 },
  ];
  const jobs = [
    {
      id: "active",
      status: "queued",
      fileName: "active.txt",
      requestedAt: "2026-06-29T12:00:00.000Z",
    },
    {
      id: "printed-old",
      status: "printed",
      fileName: "printed-old.txt",
      processedAt: "2026-06-29T12:00:00.000Z",
    },
    {
      id: "printed-recent",
      status: "printed",
      fileName: "printed-recent.txt",
      processedAt: "2026-07-01T10:00:00.000Z",
    },
  ];

  const plan = buildPrintSpoolRetentionPlan({
    jobs,
    files,
    nowMs,
    terminalRetentionMs: 24 * HOUR_MS,
    orphanRetentionMs: 24 * HOUR_MS,
  });

  assert.equal(plan.orphanFiles, 2);
  assert.deepEqual(
    plan.deleteFiles.map((file) => file.fileName).sort(),
    ["orphan-old.txt", "printed-old.txt"],
  );
});

test("print spool retention M6 tiene terminali 24h e pulisce orfani dopo 12h", () => {
  const nowMs = Date.parse("2026-07-03T12:00:00.000Z");
  const files = [
    { fileName: "active-old.txt", mtimeMs: nowMs - 72 * HOUR_MS, size: 1 },
    { fileName: "printed-18h.txt", mtimeMs: nowMs - 18 * HOUR_MS, size: 1 },
    { fileName: "printed-25h.txt", mtimeMs: nowMs - 25 * HOUR_MS, size: 1 },
    { fileName: "orphan-8h.txt", mtimeMs: nowMs - 8 * HOUR_MS, size: 1 },
    { fileName: "orphan-13h.txt", mtimeMs: nowMs - 13 * HOUR_MS, size: 1 },
  ];
  const jobs = [
    {
      id: "active-old",
      status: "queued",
      fileName: "active-old.txt",
      requestedAt: "2026-06-30T12:00:00.000Z",
    },
    {
      id: "printed-18h",
      status: "printed",
      fileName: "printed-18h.txt",
      processedAt: "2026-07-02T18:00:00.000Z",
    },
    {
      id: "printed-25h",
      status: "printed",
      fileName: "printed-25h.txt",
      processedAt: "2026-07-02T11:00:00.000Z",
    },
  ];

  const plan = buildPrintSpoolRetentionPlan({
    jobs,
    files,
    nowMs,
    terminalRetentionMs: 24 * HOUR_MS,
    orphanRetentionMs: 12 * HOUR_MS,
  });

  assert.equal(plan.orphanFiles, 2);
  assert.deepEqual(
    plan.deleteFiles.map((file) => file.fileName).sort(),
    ["orphan-13h.txt", "printed-25h.txt"],
  );
});

test("print spool retention rimuove i file selezionati", async () => {
  const spoolDir = await mkdtemp(path.join(os.tmpdir(), "print-spool-retention-"));
  const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
  const oldDate = new Date(nowMs - 48 * HOUR_MS);
  const recentDate = new Date(nowMs - 2 * HOUR_MS);
  try {
    await writeFile(path.join(spoolDir, "done.txt"), "done", "utf8");
    await writeFile(path.join(spoolDir, "queued.txt"), "queued", "utf8");
    await writeFile(path.join(spoolDir, "orphan.txt"), "orphan", "utf8");
    await utimes(path.join(spoolDir, "done.txt"), oldDate, oldDate);
    await utimes(path.join(spoolDir, "queued.txt"), oldDate, oldDate);
    await utimes(path.join(spoolDir, "orphan.txt"), oldDate, oldDate);

    const summary = await cleanupPrintSpoolRetention({
      spoolDir,
      nowMs,
      terminalRetentionMs: 24 * HOUR_MS,
      orphanRetentionMs: 24 * HOUR_MS,
      jobs: [
        {
          id: "done",
          status: "printed",
          fileName: "done.txt",
          processedAt: "2026-06-29T12:00:00.000Z",
        },
        {
          id: "queued",
          status: "queued",
          fileName: "queued.txt",
          requestedAt: "2026-06-29T12:00:00.000Z",
        },
        {
          id: "recent",
          status: "printed",
          fileName: "recent-missing.txt",
          processedAt: recentDate.toISOString(),
        },
      ],
    });

    assert.equal(summary.deletedCount, 2);
    assert.deepEqual(summary.deletedFiles.sort(), ["done.txt", "orphan.txt"]);
    assert.equal(await readFile(path.join(spoolDir, "queued.txt"), "utf8"), "queued");
    await assert.rejects(readFile(path.join(spoolDir, "done.txt"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(spoolDir, "orphan.txt"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(spoolDir, { recursive: true, force: true });
  }
});

test("runtime metrics espone gauge orfani e counter retention", () => {
  const metrics = createRuntimeMetrics({ enabled: true, now: () => 1 });
  metrics.setGauge("printSpoolOrphanFiles", 7);
  metrics.incrementCounter("printSpoolRetentionRuns");
  metrics.incrementCounter("printSpoolRetentionDeletedFiles", 3);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.gauges.printSpoolOrphanFiles, 7);
  assert.equal(snapshot.counters.printSpoolRetentionRuns, 1);
  assert.equal(snapshot.counters.printSpoolRetentionDeletedFiles, 3);
});
