import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("test-safe real I/O flag blocks fiscal POS workers, scheduling and resume", () => {
  assert.match(serverSource, /CASSAV4_TEST_DISABLE_REAL_IO/);
  assert.match(serverSource, /const FISCAL_REAL_IO_DISABLED\s*=/);
  assert.match(
    serverSource,
    /const FISCAL_OUTBOX_WORKER_ENABLED =[\s\S]*!FISCAL_REAL_IO_DISABLED[\s\S]*BACKEND_FISCAL_OUTBOX_WORKER_ENABLED/,
  );
  assert.match(
    serverSource,
    /function schedulePosFiscalReceiptBackgroundJob[\s\S]*FISCAL_REAL_IO_DISABLED[\s\S]*job POS non schedulato/,
  );
  assert.match(
    serverSource,
    /async function resumePendingPosFiscalReceiptJobs\(\) \{[\s\S]*FISCAL_REAL_IO_DISABLED[\s\S]*ripresa job POS pendenti disabilitata/,
  );
  assert.match(
    serverSource,
    /async function maybeIssuePosFiscalReceipt[\s\S]*real_io_disabled_for_tests[\s\S]*nessun invio al dispositivo reale/,
  );
});

test("test-safe real I/O flag blocks POS fiscal reprints too", () => {
  assert.match(
    serverSource,
    /async function issueQueuedPosFiscalReprint[\s\S]*FISCAL_REAL_IO_DISABLED[\s\S]*ristampa POS non inviata/,
  );
  assert.match(
    serverSource,
    /function schedulePosFiscalReprintBackgroundJobs[\s\S]*FISCAL_REAL_IO_DISABLED[\s\S]*job ristampa POS non schedulati/,
  );
});
