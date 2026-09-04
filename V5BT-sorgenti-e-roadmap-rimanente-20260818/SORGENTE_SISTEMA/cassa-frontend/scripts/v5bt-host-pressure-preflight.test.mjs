import assert from "node:assert/strict";
import test from "node:test";

import {
  V5BT_HOST_PRESSURE_MAX_LOAD_PER_CPU,
  V5BT_HOST_PRESSURE_THRESHOLDS_BYTES,
  evaluateV5btHostPressure,
  parseLinuxLoadavg,
  parseLinuxMeminfo,
} from "./v5bt-host-pressure-preflight.mjs";

const GIB = 1_024 ** 3;
const MIB = 1_024 ** 2;
const QUIET_HOST = { loadAverage1m: 1, logicalCpuCount: 4 };

test("il parser meminfo converte kB Linux in byte senza leggere il sistema", () => {
  assert.deepEqual(
    parseLinuxMeminfo("MemTotal: 8000000 kB\nMemAvailable: 4194304 kB\nSwapFree: 3145728 kB\n"),
    {
      memAvailableBytes: 4 * GIB,
      swapFreeBytes: 3 * GIB,
    },
  );
  assert.deepEqual(parseLinuxMeminfo("MemTotal: 1 kB\n"), {
    memAvailableBytes: null,
    swapFreeBytes: null,
  });
});

test("il parser loadavg legge soltanto la media a un minuto", () => {
  assert.deepEqual(parseLinuxLoadavg("2.50 4.00 6.00 1/123 456\n"), {
    loadAverage1m: 2.5,
  });
  assert.deepEqual(parseLinuxLoadavg("non-disponibile"), {
    loadAverage1m: null,
  });
});

test("la matrice usa le soglie conservative richieste per ogni profilo", () => {
  assert.deepEqual(V5BT_HOST_PRESSURE_THRESHOLDS_BYTES, {
    micro: { memAvailable: 1 * GIB, swapFree: 512 * MIB },
    smoke: { memAvailable: 3 * GIB, swapFree: 2 * GIB },
    full: { memAvailable: 4 * GIB, swapFree: 3 * GIB },
  });
});

test("una lettura esattamente in soglia autorizza lo smoke", () => {
  const result = evaluateV5btHostPressure({
    ...QUIET_HOST,
    platform: "linux",
    mode: "smoke",
    memAvailableBytes: 3 * GIB,
    swapFreeBytes: 2 * GIB,
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.sufficient, true);
  assert.equal(result.launchAllowed, true);
  assert.deepEqual(result.reasonCodes, []);
});

test("memoria insufficiente blocca lo smoke e swap insufficiente blocca il full", () => {
  const smoke = evaluateV5btHostPressure({
    ...QUIET_HOST,
    platform: "linux",
    mode: "smoke",
    memAvailableBytes: 3 * GIB - 1,
    swapFreeBytes: 2 * GIB,
  });
  const full = evaluateV5btHostPressure({
    ...QUIET_HOST,
    platform: "linux",
    mode: "full",
    memAvailableBytes: 4 * GIB,
    swapFreeBytes: 3 * GIB - 1,
  });

  assert.equal(smoke.status, "BLOCKED");
  assert.equal(smoke.launchAllowed, false);
  assert.deepEqual(smoke.reasonCodes, ["MEM_AVAILABLE_BELOW_MINIMUM"]);
  assert.equal(full.status, "BLOCKED");
  assert.equal(full.launchAllowed, false);
  assert.deepEqual(full.reasonCodes, ["SWAP_FREE_BELOW_MINIMUM"]);
});

test("anche il micro applica la propria soglia nelle esecuzioni reali", () => {
  const result = evaluateV5btHostPressure({
    ...QUIET_HOST,
    platform: "linux",
    mode: "micro",
    memAvailableBytes: 1 * GIB,
    swapFreeBytes: 512 * MIB - 1,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.launchAllowed, false);
  assert.deepEqual(result.reasonCodes, ["SWAP_FREE_BELOW_MINIMUM"]);
});

test("il dry-run resta informativo anche sotto pressione", () => {
  const result = evaluateV5btHostPressure({
    ...QUIET_HOST,
    platform: "linux",
    mode: "full",
    dryRun: true,
    memAvailableBytes: 1,
    swapFreeBytes: 1,
  });

  assert.equal(result.status, "DRY_RUN_WARNING");
  assert.equal(result.enforced, false);
  assert.equal(result.sufficient, false);
  assert.equal(result.launchAllowed, true);
  assert.deepEqual(result.reasonCodes, [
    "MEM_AVAILABLE_BELOW_MINIMUM",
    "SWAP_FREE_BELOW_MINIMUM",
  ]);
});

test("il carico scheduler e normalizzato per CPU e blocca oltre soglia", () => {
  const atThreshold = evaluateV5btHostPressure({
    platform: "linux",
    mode: "micro",
    memAvailableBytes: 1 * GIB,
    swapFreeBytes: 512 * MIB,
    loadAverage1m: V5BT_HOST_PRESSURE_MAX_LOAD_PER_CPU * 4,
    logicalCpuCount: 4,
  });
  const overloaded = evaluateV5btHostPressure({
    platform: "linux",
    mode: "micro",
    memAvailableBytes: 1 * GIB,
    swapFreeBytes: 512 * MIB,
    loadAverage1m: V5BT_HOST_PRESSURE_MAX_LOAD_PER_CPU * 4 + 0.01,
    logicalCpuCount: 4,
  });

  assert.equal(atThreshold.status, "PASS");
  assert.equal(atThreshold.schemaVersion, 2);
  assert.equal(atThreshold.checks.schedulerLoad.ok, true);
  assert.equal(overloaded.status, "BLOCKED");
  assert.deepEqual(overloaded.reasonCodes, ["SCHEDULER_LOAD_ABOVE_MAXIMUM"]);
});

test("soltanto il valore esplicito 1 abilita e attesta l'override", () => {
  const base = {
    ...QUIET_HOST,
    platform: "linux",
    mode: "smoke",
    memAvailableBytes: 1,
    swapFreeBytes: 1,
  };
  const accepted = evaluateV5btHostPressure({ ...base, overrideValue: "1" });
  const rejected = evaluateV5btHostPressure({ ...base, overrideValue: "true" });

  assert.equal(accepted.status, "OVERRIDDEN");
  assert.equal(accepted.overrideRequested, true);
  assert.equal(accepted.overrideApplied, true);
  assert.equal(accepted.launchAllowed, true);
  assert.equal(rejected.status, "BLOCKED");
  assert.equal(rejected.overrideRequested, false);
  assert.equal(rejected.overrideApplied, false);
  assert.equal(rejected.launchAllowed, false);
});

test("letture mancanti sono bloccanti e non Linux e dichiarato non applicabile", () => {
  const missing = evaluateV5btHostPressure({
    platform: "linux",
    mode: "full",
  });
  const otherPlatform = evaluateV5btHostPressure({
    platform: "win32",
    mode: "full",
  });

  assert.equal(missing.status, "BLOCKED");
  assert.deepEqual(missing.reasonCodes, [
    "MEM_AVAILABLE_UNREADABLE",
    "SWAP_FREE_UNREADABLE",
    "SCHEDULER_LOAD_UNREADABLE",
  ]);
  assert.equal(otherPlatform.status, "NOT_APPLICABLE");
  assert.equal(otherPlatform.sufficient, null);
  assert.equal(otherPlatform.launchAllowed, true);
});
