const KIBIBYTE = 1_024;
const MEBIBYTE = 1_024 ** 2;
const GIBIBYTE = 1_024 ** 3;

export const V5BT_HOST_PRESSURE_THRESHOLDS_BYTES = Object.freeze({
  micro: Object.freeze({
    memAvailable: 1 * GIBIBYTE,
    swapFree: 512 * MEBIBYTE,
  }),
  smoke: Object.freeze({
    memAvailable: 3 * GIBIBYTE,
    swapFree: 2 * GIBIBYTE,
  }),
  full: Object.freeze({
    memAvailable: 4 * GIBIBYTE,
    swapFree: 3 * GIBIBYTE,
  }),
});
export const V5BT_HOST_PRESSURE_MAX_LOAD_PER_CPU = 0.75;

function bytesFromLinuxKilobytes(value) {
  const kilobytes = Number(value);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) return null;
  const bytes = kilobytes * KIBIBYTE;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function parseLinuxMeminfo(source) {
  const values = new Map();
  for (const line of String(source || "").split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_()]+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return {
    memAvailableBytes: bytesFromLinuxKilobytes(values.get("MemAvailable")),
    swapFreeBytes: bytesFromLinuxKilobytes(values.get("SwapFree")),
  };
}

export function parseLinuxLoadavg(source) {
  const token = String(source || "").trim().split(/\s+/)[0];
  const loadAverage1m = Number(token);
  return {
    loadAverage1m:
      Number.isFinite(loadAverage1m) && loadAverage1m >= 0
        ? loadAverage1m
        : null,
  };
}

function validReading(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateV5btHostPressure({
  platform,
  mode,
  dryRun = false,
  memAvailableBytes = null,
  swapFreeBytes = null,
  loadAverage1m = null,
  logicalCpuCount = null,
  overrideValue = "",
}) {
  const thresholds = V5BT_HOST_PRESSURE_THRESHOLDS_BYTES[mode];
  if (!thresholds) throw new Error(`Modalita preflight host non valida: ${mode}.`);

  const overrideRequested = overrideValue === "1";
  const validLogicalCpuCount =
    Number.isSafeInteger(logicalCpuCount) && logicalCpuCount > 0;
  const validLoadAverage =
    Number.isFinite(loadAverage1m) && loadAverage1m >= 0;
  const loadAverage1mPerCpu =
    validLoadAverage && validLogicalCpuCount
      ? loadAverage1m / logicalCpuCount
      : null;
  const checks = {
    memAvailable: {
      observedBytes: validReading(memAvailableBytes) ? memAvailableBytes : null,
      minimumBytes: thresholds.memAvailable,
      ok: validReading(memAvailableBytes)
        ? memAvailableBytes >= thresholds.memAvailable
        : false,
    },
    swapFree: {
      observedBytes: validReading(swapFreeBytes) ? swapFreeBytes : null,
      minimumBytes: thresholds.swapFree,
      ok: validReading(swapFreeBytes)
        ? swapFreeBytes >= thresholds.swapFree
        : false,
    },
    schedulerLoad: {
      observedLoadAverage1m: validLoadAverage ? loadAverage1m : null,
      logicalCpuCount: validLogicalCpuCount ? logicalCpuCount : null,
      observedLoadAverage1mPerCpu: loadAverage1mPerCpu,
      maximumLoadAverage1mPerCpu: V5BT_HOST_PRESSURE_MAX_LOAD_PER_CPU,
      ok:
        loadAverage1mPerCpu !== null
          ? loadAverage1mPerCpu <= V5BT_HOST_PRESSURE_MAX_LOAD_PER_CPU
          : false,
    },
  };

  if (platform !== "linux") {
    return {
      schemaVersion: 2,
      platform,
      mode,
      source: "linux-proc-meminfo+loadavg",
      status: "NOT_APPLICABLE",
      enforced: false,
      sufficient: null,
      launchAllowed: true,
      overrideRequested,
      overrideApplied: false,
      checks,
      reasonCodes: [],
    };
  }

  const reasonCodes = [];
  if (checks.memAvailable.observedBytes === null) {
    reasonCodes.push("MEM_AVAILABLE_UNREADABLE");
  } else if (!checks.memAvailable.ok) {
    reasonCodes.push("MEM_AVAILABLE_BELOW_MINIMUM");
  }
  if (checks.swapFree.observedBytes === null) {
    reasonCodes.push("SWAP_FREE_UNREADABLE");
  } else if (!checks.swapFree.ok) {
    reasonCodes.push("SWAP_FREE_BELOW_MINIMUM");
  }
  if (
    checks.schedulerLoad.observedLoadAverage1m === null ||
    checks.schedulerLoad.logicalCpuCount === null
  ) {
    reasonCodes.push("SCHEDULER_LOAD_UNREADABLE");
  } else if (!checks.schedulerLoad.ok) {
    reasonCodes.push("SCHEDULER_LOAD_ABOVE_MAXIMUM");
  }

  const sufficient = reasonCodes.length === 0;
  const overrideApplied = !dryRun && !sufficient && overrideRequested;
  const launchAllowed = dryRun || sufficient || overrideApplied;
  const status = sufficient
    ? "PASS"
    : dryRun
      ? "DRY_RUN_WARNING"
      : overrideApplied
        ? "OVERRIDDEN"
        : "BLOCKED";

  return {
    schemaVersion: 2,
    platform,
    mode,
    source: "linux-proc-meminfo+loadavg",
    status,
    enforced: !dryRun,
    sufficient,
    launchAllowed,
    overrideRequested,
    overrideApplied,
    checks,
    reasonCodes,
  };
}
