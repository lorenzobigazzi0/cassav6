import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  B5CampaignSupervisorError,
  appendB5CampaignSupervisorAttempt,
  appendB5CampaignSupervisorResume,
  createInitialB5CampaignSupervisorLedger,
  executeB5CampaignSupervisorAction,
  parseB5CampaignSupervisorLedger,
  runSupervisorSelfTest,
  validB5CampaignSupervisorLedgerFixture
} from "../scripts/run-b5-campaign-supervisor.mjs";
import {
  createInitialCollectorState,
  parseCollectorState
} from "../scripts/collect-b5-direct-control-session.mjs";
import {
  validCollectorCampaignStateFixture,
  validPhysicalReportFixture
} from "../scripts/run-b5-hundred-session-gate.mjs";
import { validB5AccountDeviceBindingFixture } from "../../scripts/b5-account-device-commitment.mjs";

const CAMPAIGN_RUN_ID = "00000000-0000-4000-8000-000000000055";

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function evidenceRecords(count) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const report = validPhysicalReportFixture(sequence);
    return {
      sequence,
      sourceReportSha256: digest(JSON.stringify(report)),
      report
    };
  });
}

function collectorState(count, campaignRunId = CAMPAIGN_RUN_ID) {
  if (count === 0) {
    return createInitialCollectorState({
      campaignRunId,
      now: "2026-07-20T23:58:00.000Z",
      accountDeviceBinding: validB5AccountDeviceBindingFixture({
        campaignId: campaignRunId
      })
    });
  }
  return {
    ...validCollectorCampaignStateFixture(evidenceRecords(count), {
      campaignRunId
    }),
    createdAt: "2026-07-20T23:58:00.000Z"
  };
}

function writePrivateJson(location, value) {
  fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(location), 0o700);
  fs.writeFileSync(location, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  fs.chmodSync(location, 0o600);
}

function readJson(location) {
  return JSON.parse(fs.readFileSync(location, "utf8"));
}

function noLock() {
  return async () => {};
}

function runtimeWithTimes(times, extra = {}) {
  let index = 0;
  return {
    acquireLock: async () => noLock(),
    randomUUID: () => crypto.randomUUID(),
    now: () => times[Math.min(index++, times.length - 1)],
    ...extra
  };
}

async function initializeWorkspace(prefix = "v6-b5-supervisor-") {
  const directory = temporaryDirectory(prefix);
  const privateDirectory = path.join(directory, "private");
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  const state = path.join(privateDirectory, "collector.json");
  const ledger = path.join(privateDirectory, "supervisor.json");
  writePrivateJson(state, collectorState(0));
  const options = { ledger, state };
  const report = await executeB5CampaignSupervisorAction(
    { ...options, mode: "INIT" },
    runtimeWithTimes(["2026-07-20T23:58:00.000Z"])
  );
  return { directory, ledger, state, options, report };
}

function nextAttemptInput(ledger, {
  outcome,
  errorCode,
  cleanupVerified,
  countDelta = outcome === "COMMITTED" ? 1 : 0
}) {
  const parsed = parseB5CampaignSupervisorLedger(ledger);
  const startedAt = new Date(parsed.updatedAtMs + 1_000).toISOString();
  return {
    eventId: crypto.randomUUID(),
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
    outcome,
    errorCode,
    cleanupVerified,
    collectorCountBefore: parsed.committedSessions,
    collectorCountAfter: parsed.committedSessions + countDelta
  };
}

function appendTimeout(ledger, cleanupVerified = true) {
  return appendB5CampaignSupervisorAttempt(
    ledger,
    nextAttemptInput(ledger, {
      outcome: cleanupVerified ? "RADIO_TIMEOUT" : "INVALIDATED",
      errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
      cleanupVerified
    })
  );
}

function appendCommitted(ledger) {
  return appendB5CampaignSupervisorAttempt(
    ledger,
    nextAttemptInput(ledger, {
      outcome: "COMMITTED",
      errorCode: null,
      cleanupVerified: true
    })
  );
}

function startedTransaction(parsed, overrides = {}) {
  return {
    schemaVersion: 1,
    harnessVersion: "1.0.0",
    product: "V6",
    phase: "B5",
    mode: "PHYSICAL_B5_SUPERVISOR_TRANSACTION",
    campaignRunId: parsed.campaignRunId,
    phaseState: "STARTED",
    eventId: crypto.randomUUID(),
    ledgerHeadBefore: parsed.headSha256,
    slot: parsed.ledger.nextSlot,
    attempt: 1,
    startedAt: "2026-07-21T00:00:00.500Z",
    collectorCountBefore: parsed.committedSessions,
    result: null,
    ...overrides
  };
}

test("supervisor exports a fail-closed complete ledger contract", () => {
  const parsed = parseB5CampaignSupervisorLedger(
    validB5CampaignSupervisorLedgerFixture({ campaignRunId: CAMPAIGN_RUN_ID })
  );
  assert.equal(parsed.campaignRunId, CAMPAIGN_RUN_ID);
  assert.equal(parsed.status, "COMPLETE");
  assert.equal(parsed.committedSessions, 100);
  assert.equal(parsed.committedAttemptCount, 100);
  assert.equal(parsed.invalidatedAttemptCount, 0);
  assert.equal(parsed.radioTimeoutCount, 0);
  assert.equal(parsed.finalConsecutiveTimeouts, 0);
  assert.equal(parsed.events.length, 100);
  assert.ok(parsed.coverageFromMs !== null);
  assert.ok(parsed.coverageUntilMs > parsed.coverageFromMs);
});

test("complete supervisor fixture covers every collector capture window", () => {
  const state = validCollectorCampaignStateFixture(evidenceRecords(100), {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const parsed = parseB5CampaignSupervisorLedger(
    validB5CampaignSupervisorLedgerFixture({ campaignRunId: CAMPAIGN_RUN_ID })
  );
  parsed.events.forEach((event, index) => {
    const record = state.records[index];
    assert.ok(Date.parse(event.startedAt) <= Date.parse(record.captureStartedAt));
    assert.ok(Date.parse(event.completedAt) >= Date.parse(record.captureCompletedAt));
    assert.equal(event.collectorCountBefore, index);
    assert.equal(event.collectorCountAfter, index + 1);
  });
});

test("ledger parser rejects altered evidence, derived state and clock order", () => {
  const valid = validB5CampaignSupervisorLedgerFixture({
    campaignRunId: CAMPAIGN_RUN_ID
  });
  for (const mutate of [
    (value) => { value.events[0].cleanupVerified = false; },
    (value) => { value.committedSessions = 99; },
    (value) => { value.events[1].previousEventSha256 = "f".repeat(64); },
    (value) => { value.events[1].startedAt = value.events[0].startedAt; }
  ]) {
    const altered = structuredClone(valid);
    mutate(altered);
    assert.throws(
      () => parseB5CampaignSupervisorLedger(altered),
      (error) => error?.code === "SUPERVISOR_LEDGER_INVALID"
    );
  }
});

test("only verified orchestration timeouts are retryable and success resets the streak", () => {
  let ledger = createInitialB5CampaignSupervisorLedger({
    campaignRunId: CAMPAIGN_RUN_ID,
    now: "2026-07-21T00:00:00.000Z"
  });
  ledger = appendTimeout(ledger);
  ledger = appendTimeout(ledger);
  assert.equal(parseB5CampaignSupervisorLedger(ledger).finalConsecutiveTimeouts, 2);

  ledger = appendCommitted(ledger);
  assert.equal(parseB5CampaignSupervisorLedger(ledger).finalConsecutiveTimeouts, 0);
  ledger = appendTimeout(ledger);
  ledger = appendTimeout(ledger);
  ledger = appendTimeout(ledger);
  let parsed = parseB5CampaignSupervisorLedger(ledger);
  assert.equal(parsed.status, "SUSPENDED");
  assert.equal(parsed.finalConsecutiveTimeouts, 3);

  ledger = appendB5CampaignSupervisorResume(ledger, {
    eventId: crypto.randomUUID(),
    resumedAt: new Date(parsed.updatedAtMs + 1_000).toISOString(),
    collectorCount: parsed.committedSessions
  });
  ledger = appendCommitted(ledger);
  parsed = parseB5CampaignSupervisorLedger(ledger);
  assert.equal(parsed.status, "ACTIVE");
  assert.equal(parsed.finalConsecutiveTimeouts, 0);

  const unclean = createInitialB5CampaignSupervisorLedger({
    campaignRunId: CAMPAIGN_RUN_ID,
    now: "2026-07-21T00:00:00.000Z"
  });
  parsed = parseB5CampaignSupervisorLedger(appendTimeout(unclean, false));
  assert.equal(parsed.status, "INVALIDATED");
  assert.equal(parsed.invalidatedAttemptCount, 1);
});

test("init is owner-only, atomic and refuses overwrite", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-init-");
  try {
    const ledgerStatus = fs.lstatSync(workspace.ledger);
    assert.equal(ledgerStatus.isFile(), true);
    if (process.platform === "linux") {
      assert.equal(ledgerStatus.mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(workspace.ledger)).mode & 0o777, 0o700);
    }
    const before = fs.readFileSync(workspace.ledger);
    const inode = ledgerStatus.ino;
    await assert.rejects(
      () => executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "INIT" },
        runtimeWithTimes(["2026-07-21T00:00:01.000Z"])
      ),
      (error) => error?.code === "SUPERVISOR_OUTPUT_EXISTS"
    );
    assert.deepEqual(fs.readFileSync(workspace.ledger), before);
    if (process.platform === "linux") {
      assert.equal(fs.lstatSync(workspace.ledger).ino, inode);
    }
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("preflight is non-mutating and campaign binding is mandatory", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-preflight-");
  try {
    const ledgerBefore = fs.readFileSync(workspace.ledger);
    const stateBefore = fs.readFileSync(workspace.state);
    let preflightCalls = 0;
    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "PREFLIGHT" },
      runtimeWithTimes(["2026-07-21T00:00:01.000Z"], {
        preflightRunner: async () => { preflightCalls += 1; }
      })
    );
    assert.equal(report.operation, "PREFLIGHT");
    assert.equal(preflightCalls, 1);
    assert.deepEqual(fs.readFileSync(workspace.ledger), ledgerBefore);
    assert.deepEqual(fs.readFileSync(workspace.state), stateBefore);

    writePrivateJson(
      workspace.state,
      collectorState(0, "00000000-0000-4000-8000-000000000099")
    );
    await assert.rejects(
      () => executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "STATUS" }
      ),
      (error) => error?.code === "SUPERVISOR_CAMPAIGN_MISMATCH"
    );
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("capture retries exact clean timeouts, suspends at three and blocks further work", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-timeouts-");
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const parsed = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
      const start = new Date(parsed.updatedAtMs + 1_000).toISOString();
      const report = await executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "CAPTURE" },
        runtimeWithTimes(
          [start, new Date(Date.parse(start) + 1_000).toISOString()],
          {
            captureRunner: async () => ({
              success: false,
              errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
              cleanupVerified: true
            })
          }
        )
      );
      assert.equal(report.lastOutcome, "RADIO_TIMEOUT");
      assert.equal(report.campaign.consecutiveTimeouts, attempt);
    }
    const suspended = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
    assert.equal(suspended.status, "SUSPENDED");
    assert.equal(fs.existsSync(`${workspace.ledger}.pending`), false);
    await assert.rejects(
      () => executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "CAPTURE" },
        runtimeWithTimes([new Date(suspended.updatedAtMs + 1_000).toISOString()], {
          captureRunner: async () => assert.fail("runner must not execute")
        })
      ),
      (error) => error?.code === "SUPERVISOR_NOT_ACTIVE"
    );
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("a committed capture resets timeout streak and advances exactly one slot", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-commit-");
  try {
    const timeoutStart = "2026-07-20T23:59:00.000Z";
    await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "CAPTURE" },
      runtimeWithTimes([timeoutStart, "2026-07-20T23:59:01.000Z"], {
        captureRunner: async () => ({
          success: false,
          errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
          cleanupVerified: true
        })
      })
    );
    writePrivateJson(workspace.state, collectorState(0));
    const commitStart = "2026-07-21T00:00:00.500Z";
    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "CAPTURE" },
      runtimeWithTimes([commitStart, "2026-07-21T00:01:02.000Z"], {
        captureRunner: async () => {
          writePrivateJson(workspace.state, collectorState(1));
          return { success: true };
        }
      })
    );
    assert.equal(report.lastOutcome, "COMMITTED");
    assert.equal(report.campaign.committedSessions, 1);
    assert.equal(report.campaign.nextSlot, "002");
    assert.equal(report.campaign.consecutiveTimeouts, 0);
    assert.equal(parseCollectorState(readJson(workspace.state)).records.length, 1);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("unclean timeout and every other failure invalidate the campaign", async () => {
  for (const failure of [
    {
      errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
      cleanupVerified: false
    },
    { errorCode: "REPORT_SCHEMA_INVALID", cleanupVerified: true }
  ]) {
    const workspace = await initializeWorkspace("v6-b5-supervisor-invalid-");
    try {
      const report = await executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "CAPTURE" },
        runtimeWithTimes(
          ["2026-07-21T00:00:01.000Z", "2026-07-21T00:00:02.000Z"],
          { captureRunner: async () => ({ success: false, ...failure }) }
        )
      );
      assert.equal(report.lastOutcome, "INVALIDATED");
      assert.equal(report.campaign.status, "INVALIDATED");
      assert.equal(report.campaign.invalidatedAttempts, 1);
      assert.equal(fs.existsSync(`${workspace.ledger}.pending`), false);
    } finally {
      fs.rmSync(workspace.directory, { recursive: true, force: true });
    }
  }
});

test("clock regression invalidates before invoking the collector", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-clock-");
  try {
    let runnerCalls = 0;
    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "CAPTURE" },
      runtimeWithTimes(
        ["2026-07-20T23:57:59.000Z", "2026-07-20T23:57:59.000Z"],
        { captureRunner: async () => { runnerCalls += 1; } }
      )
    );
    assert.equal(runnerCalls, 0);
    assert.equal(report.campaign.status, "INVALIDATED");
    assert.equal(readJson(workspace.ledger).events.at(-1).errorCode,
      "SUPERVISOR_CLOCK_REGRESSION");
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("resume with a regressed clock persists a hash-chained invalidation", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-resume-clock-");
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const parsed = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
      const startedAt = new Date(parsed.updatedAtMs + 1_000).toISOString();
      await executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "CAPTURE" },
        runtimeWithTimes(
          [startedAt, new Date(Date.parse(startedAt) + 1_000).toISOString()],
          {
            captureRunner: async () => ({
              success: false,
              errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
              cleanupVerified: true
            })
          }
        )
      );
    }

    const suspended = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
    assert.equal(suspended.status, "SUSPENDED");
    assert.equal(suspended.events.length, 3);
    const previousHead = suspended.headSha256;
    const regressedNow = new Date(suspended.updatedAtMs - 1).toISOString();

    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "RESUME" },
      runtimeWithTimes([regressedNow])
    );

    assert.equal(report.operation, "RESUME");
    assert.equal(report.lastOutcome, "INVALIDATED");
    assert.equal(report.campaign.status, "INVALIDATED");
    assert.equal(report.campaign.invalidatedAttempts, 1);
    assert.equal(report.campaign.committedSessions, 0);

    const persisted = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
    assert.equal(persisted.status, "INVALIDATED");
    assert.equal(persisted.events.length, 4);
    assert.equal(persisted.headSha256, persisted.events.at(-1).eventSha256);
    assert.notEqual(persisted.headSha256, previousHead);
    assert.deepEqual(
      {
        kind: persisted.events.at(-1).kind,
        attempt: persisted.events.at(-1).attempt,
        outcome: persisted.events.at(-1).outcome,
        errorCode: persisted.events.at(-1).errorCode,
        cleanupVerified: persisted.events.at(-1).cleanupVerified,
        previousEventSha256: persisted.events.at(-1).previousEventSha256,
        collectorCountBefore: persisted.events.at(-1).collectorCountBefore,
        collectorCountAfter: persisted.events.at(-1).collectorCountAfter
      },
      {
        kind: "ATTEMPT",
        attempt: 4,
        outcome: "INVALIDATED",
        errorCode: "SUPERVISOR_CLOCK_REGRESSION",
        cleanupVerified: false,
        previousEventSha256: previousHead,
        collectorCountBefore: 0,
        collectorCountAfter: 0
      }
    );
    assert.equal(persisted.events.at(-1).startedAt, suspended.ledger.updatedAt);
    assert.equal(persisted.events.at(-1).completedAt, suspended.ledger.updatedAt);
    assert.equal(fs.existsSync(`${workspace.ledger}.pending`), false);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("collector commit outside the attempt window invalidates the campaign", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-window-");
  try {
    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "CAPTURE" },
      runtimeWithTimes(
        ["2026-07-21T00:00:01.000Z", "2026-07-21T00:01:02.000Z"],
        {
          captureRunner: async () => {
            writePrivateJson(workspace.state, collectorState(1));
            return { success: true };
          }
        }
      )
    );
    assert.equal(report.campaign.status, "INVALIDATED");
    assert.equal(
      readJson(workspace.ledger).events.at(-1).errorCode,
      "SUPERVISOR_COLLECTOR_STATE_TRANSITION_INVALID"
    );
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("resume recovers collector commit left behind by an incomplete transaction", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-recovery-");
  try {
    const parsed = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
    const transaction = startedTransaction(parsed);
    writePrivateJson(`${workspace.ledger}.pending`, transaction);
    writePrivateJson(workspace.state, collectorState(1));

    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "RESUME" },
      runtimeWithTimes(["2026-07-21T00:01:02.000Z"])
    );
    assert.equal(report.recoveryPerformed, true);
    assert.equal(report.lastOutcome, "COMMITTED");
    assert.equal(report.campaign.committedSessions, 1);
    assert.equal(fs.existsSync(`${workspace.ledger}.pending`), false);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("resume removes a post-commit journal without duplicating the event", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-post-commit-");
  try {
    const initial = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
    const transaction = startedTransaction(initial);
    const committed = appendB5CampaignSupervisorAttempt(initial.ledger, {
      eventId: transaction.eventId,
      startedAt: transaction.startedAt,
      completedAt: "2026-07-21T00:01:01.250Z",
      outcome: "COMMITTED",
      errorCode: null,
      cleanupVerified: true,
      collectorCountBefore: 0,
      collectorCountAfter: 1
    });
    writePrivateJson(workspace.ledger, committed);
    writePrivateJson(`${workspace.ledger}.pending`, transaction);
    writePrivateJson(workspace.state, collectorState(1));

    const report = await executeB5CampaignSupervisorAction(
      { ...workspace.options, mode: "RESUME" },
      runtimeWithTimes(["2026-07-21T00:01:02.000Z"])
    );
    assert.equal(report.recoveryPerformed, true);
    assert.equal(report.campaign.committedSessions, 1);
    assert.equal(readJson(workspace.ledger).events.length, 1);
    assert.equal(fs.existsSync(`${workspace.ledger}.pending`), false);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("post-commit recovery rejects a journal that does not match its event", async () => {
  const workspace = await initializeWorkspace("v6-b5-supervisor-post-tamper-");
  try {
    const initial = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
    const transaction = startedTransaction(initial);
    const committed = appendB5CampaignSupervisorAttempt(initial.ledger, {
      eventId: transaction.eventId,
      startedAt: transaction.startedAt,
      completedAt: "2026-07-21T00:01:01.250Z",
      outcome: "COMMITTED",
      errorCode: null,
      cleanupVerified: true,
      collectorCountBefore: 0,
      collectorCountAfter: 1
    });
    writePrivateJson(workspace.ledger, committed);
    writePrivateJson(`${workspace.ledger}.pending`, {
      ...transaction,
      startedAt: "2026-07-21T00:00:00.600Z"
    });
    writePrivateJson(workspace.state, collectorState(1));
    await assert.rejects(
      () => executeB5CampaignSupervisorAction(
        { ...workspace.options, mode: "RESUME" },
        runtimeWithTimes(["2026-07-21T00:01:02.000Z"])
      ),
      (error) => error?.code === "SUPERVISOR_RECOVERY_CONFLICT"
    );
    assert.equal(fs.existsSync(`${workspace.ledger}.pending`), true);
    assert.equal(readJson(workspace.ledger).events.length, 1);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("lost result invalidates while malformed or tampered journals fail closed", async () => {
  for (const journalFactory of [
    (parsed) => startedTransaction(parsed),
    () => ({ schemaVersion: 1 }),
    (parsed) => startedTransaction(parsed, { ledgerHeadBefore: "f".repeat(64) })
  ]) {
    const workspace = await initializeWorkspace("v6-b5-supervisor-journal-");
    try {
      const parsed = parseB5CampaignSupervisorLedger(readJson(workspace.ledger));
      writePrivateJson(`${workspace.ledger}.pending`, journalFactory(parsed));
      if (Object.keys(readJson(`${workspace.ledger}.pending`)).length === 1 ||
          readJson(`${workspace.ledger}.pending`).ledgerHeadBefore === "f".repeat(64)) {
        await assert.rejects(
          () => executeB5CampaignSupervisorAction(
            { ...workspace.options, mode: "RESUME" },
            runtimeWithTimes(["2026-07-21T00:00:02.000Z"])
          ),
          (error) => error?.code === "SUPERVISOR_RECOVERY_CONFLICT"
        );
        assert.equal(fs.existsSync(`${workspace.ledger}.pending`), true);
      } else {
        const report = await executeB5CampaignSupervisorAction(
          { ...workspace.options, mode: "RESUME" },
          runtimeWithTimes(["2026-07-21T00:00:02.000Z"])
        );
        assert.equal(report.campaign.status, "INVALIDATED");
        assert.equal(readJson(workspace.ledger).events.at(-1).errorCode,
          "SUPERVISOR_ATTEMPT_RESULT_LOST");
      }
    } finally {
      fs.rmSync(workspace.directory, { recursive: true, force: true });
    }
  }
});

test("private ledger rejects hard links and symbolic links", async () => {
  const hardlinkWorkspace = await initializeWorkspace("v6-b5-supervisor-hardlink-");
  try {
    fs.linkSync(hardlinkWorkspace.ledger, `${hardlinkWorkspace.ledger}.alias`);
    await assert.rejects(
      () => executeB5CampaignSupervisorAction(
        { ...hardlinkWorkspace.options, mode: "STATUS" }
      ),
      (error) => error?.code === "SUPERVISOR_PRIVATE_FILE_INVALID"
    );
  } finally {
    fs.rmSync(hardlinkWorkspace.directory, { recursive: true, force: true });
  }

  const symlinkWorkspace = await initializeWorkspace("v6-b5-supervisor-symlink-");
  try {
    const realLedger = `${symlinkWorkspace.ledger}.real`;
    fs.renameSync(symlinkWorkspace.ledger, realLedger);
    fs.symlinkSync(realLedger, symlinkWorkspace.ledger);
    await assert.rejects(
      () => executeB5CampaignSupervisorAction(
        { ...symlinkWorkspace.options, mode: "STATUS" }
      ),
      (error) => error?.code === "SUPERVISOR_PRIVATE_FILE_INVALID"
    );
  } finally {
    fs.rmSync(symlinkWorkspace.directory, { recursive: true, force: true });
  }
});

test("synthetic supervisor self-test never accesses the physical radio", () => {
  const report = runSupervisorSelfTest();
  assert.equal(report.verdict, "PASS");
  assert.equal(report.syntheticCommittedAttempts, 100);
  assert.equal(report.physicalRadioAccessed, false);
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
  assert.equal(report.gate.b6, "PENDING");
  assert.equal(B5CampaignSupervisorError.prototype instanceof Error, true);
});
