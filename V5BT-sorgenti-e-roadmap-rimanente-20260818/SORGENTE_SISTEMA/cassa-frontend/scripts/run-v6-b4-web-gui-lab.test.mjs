import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  B4WebGuiLabError,
  HEARTBEAT_FRESHNESS_MS,
  LAB_STATION_HEARTBEAT_INTERVAL_MS,
  LAB_STATION_HEARTBEAT_FAILURE_LIMIT,
  LAB_STATION_REQUEST_TIMEOUT_MS,
  PRIVATE_JSON_MAX_BYTES,
  WORKLOAD_REQUEST_FRESHNESS_MS,
  assertFreshWorkloadRequest,
  assertLedgerUnchanged,
  assertSafePrivateDirectory,
  assertSafeRegularFile,
  buildPublicReport,
  buildWebPalmarePlan,
  captureLedgerSnapshot,
  countHealthySinglePageDevices,
  ensurePrivateDirectory,
  PRIVATE_UMASK,
  WEB_PALMARE_CONTEXT_OPTIONS,
  publicStatus,
  readPrivateJson,
  seedWebPalmari,
  startIsolatedStationHeartbeat,
  validatePublicReport,
} from "./run-v6-b4-web-gui-lab.mjs";

function physicalState() {
  return {
    schemaVersion: 2,
    records: [
      { ordinal: 1, deviceDigest: "a".repeat(64) },
      { ordinal: 2, deviceDigest: "b".repeat(64) },
    ],
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v6-b4-web-gui-"));
  const ledgerPath = path.join(directory, "state.json");
  await fs.writeFile(ledgerPath, `${JSON.stringify(physicalState())}\n`, {
    mode: 0o600,
  });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, ledgerPath };
}

test("plan creates exactly eight distinct web Palmare for slots 3 through 10", () => {
  const plan = buildWebPalmarePlan();
  assert.equal(plan.length, 8);
  assert.deepEqual(
    plan.map((entry) => entry.slot),
    [3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(new Set(plan.map((entry) => entry.username)).size, 8);
  assert.equal(new Set(plan.map((entry) => entry.deviceUuid)).size, 8);
});

test("plan rejects seven or nine simulated web Palmare", () => {
  for (const count of [7, 9]) {
    assert.throws(
      () => buildWebPalmarePlan(count),
      (error) =>
        error instanceof B4WebGuiLabError &&
        error.code === "WEB_PALMARE_COUNT_INVALID",
    );
  }
});

test("detached lab applies the private-only umask", () => {
  assert.equal(PRIVATE_UMASK, 0o077);
});

test("all graphical Palmare use fixed touch mobile emulation", () => {
  assert.deepEqual(WEB_PALMARE_CONTEXT_OPTIONS.viewport, {
    width: 390,
    height: 844,
  });
  assert.equal(WEB_PALMARE_CONTEXT_OPTIONS.isMobile, true);
  assert.equal(WEB_PALMARE_CONTEXT_OPTIONS.hasTouch, true);
  assert.equal(WEB_PALMARE_CONTEXT_OPTIONS.deviceScaleFactor, 1);
});

test("graphical Palmare seed includes every permission required by the DOM workload", () => {
  const state = { users: [], posSettings: { mobileDevices: [] } };
  seedWebPalmari(state, buildWebPalmarePlan());
  assert.equal(state.users.length, 8);
  for (const user of state.users) {
    assert.equal(user.permissions.includes("counter_mode"), true);
    assert.equal(user.permissions.includes("manage_tables"), true);
    assert.deepEqual(user.enabledAppIds, ["palmare"]);
  }
});

test("isolated Postazione heartbeat stays on loopback and closes its session", async () => {
  const calls = [];
  let intervalCallback = null;
  let clearedTimer = null;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const activeStation = {
    ok: true,
    station: {
      station: "BAR-1",
      active: true,
      realStation: true,
      deviceUuid: "station-test-device",
    },
  };
  const responses = [
    { token: "t".repeat(32), user: { id: "u_cashier" } },
    { ok: true },
    activeStation,
    activeStation,
    activeStation,
    { ok: true, station: { station: "BAR-1", active: false } },
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    const body = responses.shift();
    return { ok: true, json: async () => body };
  };

  const heartbeat = await startIsolatedStationHeartbeat("http://127.0.0.1:3210", {
    fetchImpl,
    deviceUuid: "station-test-device",
    setIntervalImpl: (callback, milliseconds) => {
      assert.equal(milliseconds, LAB_STATION_HEARTBEAT_INTERVAL_MS);
      intervalCallback = callback;
      return timer;
    },
    clearIntervalImpl: (value) => {
      clearedTimer = value;
    },
  });

  assert.equal(timer.unrefCalled, true);
  assert.equal(LAB_STATION_REQUEST_TIMEOUT_MS < LAB_STATION_HEARTBEAT_INTERVAL_MS, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      "/api/auth/login",
      "/api/auth/workstation/select",
      "/api/integration/stations/state",
    ],
  );
  assert.equal(calls.every(({ url }) => new URL(url).hostname === "127.0.0.1"), true);
  assert.equal(calls[2].body.active, true);
  assert.equal(calls[2].body.station, "BAR-1");
  assert.equal(calls[2].options.signal instanceof AbortSignal, true);
  assert.equal("token" in heartbeat, false);
  assert.equal("deviceUuid" in heartbeat, false);

  intervalCallback();
  await heartbeat.heartbeatNow();
  await heartbeat.close();
  assert.equal(clearedTimer, timer);
  assert.equal(calls.at(-1).body.active, false);
});

test("isolated Postazione heartbeat rejects a 200 response for an inactive station", async () => {
  const responses = [
    { token: "t".repeat(32), user: { id: "u_cashier" } },
    { ok: true },
    {
      ok: true,
      station: {
        station: "BAR-1",
        active: false,
        realStation: false,
        deviceUuid: "station-inactive-device",
      },
    },
  ];
  await assert.rejects(
    startIsolatedStationHeartbeat("http://127.0.0.1:3210", {
      deviceUuid: "station-inactive-device",
      fetchImpl: async () => ({
        ok: true,
        json: async () => responses.shift(),
      }),
    }),
    (error) =>
      error instanceof B4WebGuiLabError &&
      error.code === "LAB_STATION_HEARTBEAT_REJECTED",
  );
});

test("isolated Postazione heartbeat tolerates transient load but fails closed at the bounded limit", async () => {
  let intervalCallback = null;
  const failures = [];
  const responses = [
    { token: "t".repeat(32), user: { id: "u_cashier" } },
    { ok: true },
    {
      ok: true,
      station: {
        station: "BAR-1",
        active: true,
        realStation: true,
        deviceUuid: "station-bounded-failure-device",
      },
    },
  ];
  const heartbeat = await startIsolatedStationHeartbeat("http://127.0.0.1:3210", {
    deviceUuid: "station-bounded-failure-device",
    fetchImpl: async () => {
      const body = responses.shift();
      if (body) return { ok: true, json: async () => body };
      throw new Error("backend busy");
    },
    setIntervalImpl: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalImpl: () => undefined,
    onFailure: (error) => failures.push(error),
  });

  for (let attempt = 1; attempt <= LAB_STATION_HEARTBEAT_FAILURE_LIMIT; attempt += 1) {
    await intervalCallback();
    assert.equal(failures.length, attempt === LAB_STATION_HEARTBEAT_FAILURE_LIMIT ? 1 : 0);
  }
  await heartbeat.close();
});

test("isolated Postazione heartbeat rejects every non-loopback origin", async () => {
  await assert.rejects(
    startIsolatedStationHeartbeat("https://example.test"),
    (error) =>
      error instanceof B4WebGuiLabError &&
      error.code === "LAB_STATION_ORIGIN_INVALID",
  );
});

test("workload requests must be fresh when the server accepts them", () => {
  const now = Date.now();
  assert.equal(
    assertFreshWorkloadRequest({ requestedAt: new Date(now).toISOString() }, now),
    true,
  );
  for (const requestedAt of [
    new Date(now - WORKLOAD_REQUEST_FRESHNESS_MS - 1).toISOString(),
    new Date(now + 1).toISOString(),
    "invalid",
  ]) {
    assert.throws(
      () => assertFreshWorkloadRequest({ requestedAt }, now),
      (error) =>
        error instanceof B4WebGuiLabError &&
        error.code === "WEB_WORKLOAD_REQUEST_STALE",
    );
  }
});

test("browser isolation requires exactly one expected page per context", () => {
  const mainPage = { isClosed: () => false };
  const healthy = {
    page: mainPage,
    context: { pages: () => [mainPage] },
  };
  const popup = { isClosed: () => false };
  const extraPage = {
    page: mainPage,
    context: { pages: () => [mainPage, popup] },
  };
  const wrongMain = {
    page: mainPage,
    context: { pages: () => [popup] },
  };
  assert.equal(countHealthySinglePageDevices([healthy]), 1);
  assert.equal(countHealthySinglePageDevices([healthy, extraPage, wrongMain]), 1);
});

test("public status exposes only the redacted ledger and pilot outcome", () => {
  const status = publicStatus({
    pid: process.pid,
    status: "ACTIVE",
    readyWebPalmari: 8,
    ledgerUnchanged: true,
    b5WebPilotStatus: "NON_GATE_PASS",
    webWorkloadStatus: "RUNNING",
    webWorkloadActionsCompleted: 48,
    webWorkloadOrdersCompleted: 19,
    heartbeatAt: new Date().toISOString(),
    frontendUrl: "http://127.0.0.1:12345/mobile/",
  });
  assert.equal(status.status, "ACTIVE");
  assert.equal(status.ledgerUnchanged, true);
  assert.equal(status.b5WebPilotStatus, "NON_GATE_PASS");
  assert.equal(status.webWorkloadStatus, "RUNNING");
  assert.deepEqual(status.webWorkloadProgress, {
    completedActions: 48,
    totalActions: 160,
    completedOrders: 19,
    totalOrders: 64,
  });
  assert.equal(JSON.stringify(status).includes("pid"), false);
});

test("public status hides stale or unavailable browser sessions", () => {
  const common = {
    status: "ACTIVE",
    readyWebPalmari: 8,
    ledgerUnchanged: true,
    b5WebPilotStatus: "NON_GATE_PASS",
    webWorkloadStatus: "RUNNING",
    frontendUrl: "http://127.0.0.1:12345/mobile/",
  };
  const stale = publicStatus({
    ...common,
    pid: process.pid,
    heartbeatAt: new Date(Date.now() - HEARTBEAT_FRESHNESS_MS - 1_000).toISOString(),
  });
  const unavailable = publicStatus({
    ...common,
    pid: Number.MAX_SAFE_INTEGER,
    heartbeatAt: new Date().toISOString(),
  });
  for (const status of [stale, unavailable]) {
    assert.equal(status.status, "INACTIVE");
    assert.equal(status.webPalmari, "0/8");
    assert.equal(status.logicalCoverage, "INCOMPLETE");
    assert.equal(status.ledgerUnchanged, false);
    assert.equal(status.frontendUrl, "");
    assert.equal(status.b5WebPilotStatus, "NON_GATE_PASS");
    assert.equal(status.webWorkloadStatus, "NON_GATE_FAIL");
  }
});

test("private file validator rejects a different owner", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1_000;
  assert.throws(
    () =>
      assertSafeRegularFile(
        {
          isFile: () => true,
          isSymbolicLink: () => false,
          nlink: 1,
          uid: uid + 1,
          mode: 0o100600,
        },
        0o600,
        "PRIVATE_FILE_INVALID",
      ),
    (error) =>
      error instanceof B4WebGuiLabError && error.code === "PRIVATE_FILE_INVALID",
  );
});

test("private directory validator rejects a different owner", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1_000;
  assert.throws(
    () =>
      assertSafePrivateDirectory({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: uid + 1,
      }),
    (error) =>
      error instanceof B4WebGuiLabError &&
      error.code === "RUNTIME_DIRECTORY_INVALID",
  );
});

test("private directory is validated before its mode is changed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v6-private-dir-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const privateDirectory = path.join(directory, "private");
  await fs.mkdir(privateDirectory, { mode: 0o755 });
  await ensurePrivateDirectory(privateDirectory);
  assert.equal((await fs.stat(privateDirectory)).mode & 0o777, 0o700);

  const target = path.join(directory, "target");
  const link = path.join(directory, "link");
  await fs.mkdir(target, { mode: 0o755 });
  await fs.symlink(target, link);
  await assert.rejects(
    ensurePrivateDirectory(link),
    (error) =>
      error instanceof B4WebGuiLabError &&
      error.code === "RUNTIME_DIRECTORY_INVALID",
  );
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
});

test("private JSON is read from a safe single file descriptor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v6-private-json-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "private.json");
  await fs.writeFile(filePath, '{"ok":true}\n', { mode: 0o600 });
  assert.deepEqual(await readPrivateJson(filePath), { ok: true });

  const linkPath = path.join(directory, "private-link.json");
  await fs.symlink(filePath, linkPath);
  await assert.rejects(
    readPrivateJson(linkPath),
    (error) => error.code === "PRIVATE_FILE_INVALID",
  );
});

test("private JSON rejects wrong mode, hardlinks and files over 64 KiB", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v6-private-limits-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const wrongModePath = path.join(directory, "wrong-mode.json");
  await fs.writeFile(wrongModePath, '{}\n', { mode: 0o644 });
  await assert.rejects(
    readPrivateJson(wrongModePath),
    (error) => error.code === "PRIVATE_FILE_INVALID",
  );

  const hardlinkPath = path.join(directory, "hardlink.json");
  const secondLinkPath = path.join(directory, "hardlink-second.json");
  await fs.writeFile(hardlinkPath, '{}\n', { mode: 0o600 });
  await fs.link(hardlinkPath, secondLinkPath);
  await assert.rejects(
    readPrivateJson(hardlinkPath),
    (error) => error.code === "PRIVATE_FILE_INVALID",
  );

  const oversizedPath = path.join(directory, "oversized.json");
  await fs.writeFile(oversizedPath, "x".repeat(PRIVATE_JSON_MAX_BYTES + 1), {
    mode: 0o600,
  });
  await assert.rejects(
    readPrivateJson(oversizedPath),
    (error) => error.code === "PRIVATE_FILE_INVALID",
  );
});

test("ledger snapshot accepts the existing schema-v2 two-record state", async (t) => {
  const { ledgerPath } = await fixture(t);
  const before = await captureLedgerSnapshot(ledgerPath);
  const after = await captureLedgerSnapshot(ledgerPath);
  assert.equal(before.physicalRecords, 2);
  assert.equal(assertLedgerUnchanged(before, after), true);
});

test("ledger snapshot rejects wrong permissions and hardlinks", async (t) => {
  const { directory, ledgerPath } = await fixture(t);
  await fs.chmod(ledgerPath, 0o644);
  await assert.rejects(
    captureLedgerSnapshot(ledgerPath),
    (error) => error.code === "LEDGER_SECURITY_INVALID",
  );
  await fs.chmod(ledgerPath, 0o600);
  await fs.link(ledgerPath, path.join(directory, "second-link.json"));
  await assert.rejects(
    captureLedgerSnapshot(ledgerPath),
    (error) => error.code === "LEDGER_SECURITY_INVALID",
  );
});

test("ledger snapshot rejects symlinks and a non-two record state", async (t) => {
  const { directory, ledgerPath } = await fixture(t);
  const symlinkPath = path.join(directory, "state-link.json");
  await fs.symlink(ledgerPath, symlinkPath);
  await assert.rejects(
    captureLedgerSnapshot(symlinkPath),
    (error) => error.code === "LEDGER_SECURITY_INVALID",
  );
  const invalidPath = path.join(directory, "invalid.json");
  const invalid = physicalState();
  invalid.records.pop();
  await fs.writeFile(invalidPath, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
  await assert.rejects(
    captureLedgerSnapshot(invalidPath),
    (error) => error.code === "LEDGER_PHYSICAL_COUNT_INVALID",
  );
});

test("ledger mutation is detected", async (t) => {
  const { ledgerPath } = await fixture(t);
  const before = await captureLedgerSnapshot(ledgerPath);
  const state = physicalState();
  state.extra = true;
  await fs.writeFile(ledgerPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const after = await captureLedgerSnapshot(ledgerPath);
  assert.throws(
    () => assertLedgerUnchanged(before, after),
    (error) => error.code === "LEDGER_CHANGED",
  );
});

test("public PASS report keeps every authoritative gate unchanged", () => {
  const report = buildPublicReport();
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.logicalCoverage.status, "SIMULATED_10_OF_10");
  assert.equal(report.gates.distinctPhysicalDevices, 2);
  assert.equal(report.gates.simulatedDevicesCountedTowardGate, 0);
  assert.equal(report.gates.b4TenPhysicalDeviceGate, "PENDING");
  assert.equal(report.gates.b5HundredSessionGate, "PENDING");
  assert.equal(report.gates.b6AndroidPairGate, "BLOCKED");
  assert.equal(report.authorization.b5OfficialCampaignAuthorized, false);
});

test("an incomplete browser bank can only produce NON_GATE_FAIL", () => {
  const report = buildPublicReport({ contexts: 7, pages: 7, sessions: 7 });
  assert.equal(report.verdict, "NON_GATE_FAIL");
  assert.equal(report.logicalCoverage.status, "INCOMPLETE");
  assert.equal(report.gates.b4TenPhysicalDeviceGate, "PENDING");
});

test("report validator rejects a forged physical promotion", () => {
  const report = JSON.parse(JSON.stringify(buildPublicReport()));
  report.gates.distinctPhysicalDevices = 10;
  report.gates.b4TenPhysicalDeviceGate = "PASS";
  assert.throws(
    () => validatePublicReport(report),
    (error) => error.code === "REPORT_CONTRACT_INVALID",
  );
});

test("public report contains no private identity or path fields", () => {
  const serialized = JSON.stringify(buildPublicReport());
  for (const forbidden of [
    "v6-b4-web-slot-03",
    "web_palmare_03",
    "/b4-physical-collection/",
    "a".repeat(64),
    "pos_token",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
