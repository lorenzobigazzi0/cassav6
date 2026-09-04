export const SCAN_POLICY_MODES = Object.freeze({
  STABLE: "stable",
  FAILOVER: "failover"
});

export const DEFAULT_SCAN_WINDOW_POLICY_V1 = Object.freeze({
  stable: Object.freeze({
    windowMs: 3_000,
    periodMs: 30_000
  }),
  failover: Object.freeze({
    windowMs: 8_000,
    periodMs: 10_000
  })
});

export const MAX_SCAN_PERIOD_MS = 3_600_000;

export class ScanPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScanPolicyError";
    this.code = code;
  }
}

function defaultMonotonicClock() {
  const now = globalThis.performance?.now?.();
  if (!Number.isFinite(now)) {
    throw new ScanPolicyError(
      "MONOTONIC_CLOCK_UNAVAILABLE",
      "a monotonic clock must be supplied"
    );
  }
  return now;
}

function validateMode(mode) {
  if (!Object.values(SCAN_POLICY_MODES).includes(mode)) {
    throw new ScanPolicyError(
      "INVALID_SCAN_MODE",
      "scan mode must be stable or failover"
    );
  }
}

export function validateScanWindowPolicyV1(policy) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new ScanPolicyError(
      "INVALID_SCAN_POLICY",
      "scan policy must be an object"
    );
  }

  const normalized = {};
  for (const mode of Object.values(SCAN_POLICY_MODES)) {
    const schedule = policy[mode];
    if (
      !Object.hasOwn(policy, mode) ||
      schedule === null ||
      typeof schedule !== "object" ||
      Array.isArray(schedule)
    ) {
      throw new ScanPolicyError(
        "INVALID_SCAN_SCHEDULE",
        `${mode} scan schedule must be an object`
      );
    }
    const scheduleKeys = Object.keys(schedule);
    const unknownScheduleKeys = scheduleKeys.filter(
      (key) => key !== "windowMs" && key !== "periodMs"
    );
    if (
      unknownScheduleKeys.length > 0 ||
      !scheduleKeys.includes("windowMs") ||
      !scheduleKeys.includes("periodMs")
    ) {
      throw new ScanPolicyError(
        "INVALID_SCAN_SCHEDULE_FIELDS",
        `${mode} scan schedule must contain only windowMs and periodMs`
      );
    }
    if (
      !Number.isSafeInteger(schedule.windowMs) ||
      !Number.isSafeInteger(schedule.periodMs) ||
      schedule.windowMs <= 0 ||
      schedule.periodMs <= 0 ||
      schedule.windowMs > MAX_SCAN_PERIOD_MS ||
      schedule.periodMs > MAX_SCAN_PERIOD_MS
    ) {
      throw new ScanPolicyError(
        "INVALID_SCAN_SCHEDULE",
        `${mode} scan window and period must be safe integers from 1 to ${MAX_SCAN_PERIOD_MS}`
      );
    }
    if (schedule.windowMs >= schedule.periodMs) {
      throw new ScanPolicyError(
        "CONTINUOUS_SCAN_FORBIDDEN",
        `${mode} scan window must be shorter than its period`
      );
    }
    normalized[mode] = Object.freeze({
      windowMs: schedule.windowMs,
      periodMs: schedule.periodMs
    });
  }

  const extraModes = Object.keys(policy).filter(
    (mode) => !Object.values(SCAN_POLICY_MODES).includes(mode)
  );
  if (extraModes.length > 0) {
    throw new ScanPolicyError(
      "UNKNOWN_SCAN_MODE",
      `unknown scan policy mode: ${extraModes.join(", ")}`
    );
  }

  return Object.freeze(normalized);
}

function initialMetrics() {
  return {
    evaluationsTotal: 0,
    stableEvaluationsTotal: 0,
    failoverEvaluationsTotal: 0,
    scanningDecisionsTotal: 0,
    idleDecisionsTotal: 0,
    startCommandsTotal: 0,
    stopCommandsTotal: 0,
    restartCommandsTotal: 0,
    missedBoundaryRecoveriesTotal: 0,
    observedStateTransitionsTotal: 0,
    modeChangesTotal: 0,
    clockRegressionTotal: 0
  };
}

export class ScanWindowPolicyV1 {
  #clock;
  #lastClockMs = null;
  #mode;
  #modeStartedAtMs;
  #lastDecisionScanning = false;
  #lastDecisionMode = null;
  #lastDecisionWindowIndex = null;
  #policy;
  #metrics = initialMetrics();

  constructor({
    clock = defaultMonotonicClock,
    initialMode = SCAN_POLICY_MODES.STABLE,
    policy = DEFAULT_SCAN_WINDOW_POLICY_V1
  } = {}) {
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    validateMode(initialMode);
    this.#clock = clock;
    this.#policy = validateScanWindowPolicyV1(policy);
    this.#mode = initialMode;
    this.#modeStartedAtMs = this.#readNow();
  }

  get mode() {
    return this.#mode;
  }

  get policy() {
    return this.#policy;
  }

  #readNow() {
    const nowMs = this.#clock();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new ScanPolicyError(
        "INVALID_MONOTONIC_CLOCK",
        "monotonic clock must return a finite, non-negative number"
      );
    }
    if (this.#lastClockMs !== null && nowMs < this.#lastClockMs) {
      this.#metrics.clockRegressionTotal += 1;
      throw new ScanPolicyError(
        "MONOTONIC_CLOCK_REGRESSION",
        `monotonic clock moved backwards from ${this.#lastClockMs} to ${nowMs}`
      );
    }
    this.#lastClockMs = nowMs;
    return nowMs;
  }

  setMode(mode) {
    validateMode(mode);
    const nowMs = this.#readNow();
    if (mode === this.#mode) {
      return Object.freeze({
        changed: false,
        mode,
        modeStartedAtMs: this.#modeStartedAtMs
      });
    }

    this.#mode = mode;
    this.#modeStartedAtMs = nowMs;
    this.#metrics.modeChangesTotal += 1;
    return Object.freeze({
      changed: true,
      mode,
      modeStartedAtMs: nowMs
    });
  }

  evaluate() {
    const nowMs = this.#readNow();
    const schedule = this.#policy[this.#mode];
    const elapsedMs = nowMs - this.#modeStartedAtMs;
    const windowIndex = Math.floor(elapsedMs / schedule.periodMs);
    const windowStartAtMs =
      this.#modeStartedAtMs + windowIndex * schedule.periodMs;
    const windowEndAtMs = windowStartAtMs + schedule.windowMs;
    const scanning = nowMs < windowEndAtMs;
    const nextScanStartAtMs = scanning
      ? windowStartAtMs
      : windowStartAtMs + schedule.periodMs;
    const nextTransitionAtMs = scanning
      ? windowEndAtMs
      : nextScanStartAtMs;

    let command = "none";
    if (scanning !== this.#lastDecisionScanning) {
      command = scanning ? "start" : "stop";
      this.#metrics.observedStateTransitionsTotal += 1;
      this.#metrics[
        scanning ? "startCommandsTotal" : "stopCommandsTotal"
      ] += 1;
    } else if (
      scanning &&
      this.#lastDecisionMode !== null &&
      (this.#mode !== this.#lastDecisionMode ||
        windowIndex !== this.#lastDecisionWindowIndex)
    ) {
      // A delayed callback crossed an unobserved stop boundary. A compound
      // restart prevents the platform scanner from becoming continuous.
      command = "restart";
      this.#metrics.restartCommandsTotal += 1;
      this.#metrics.missedBoundaryRecoveriesTotal += 1;
      this.#metrics.stopCommandsTotal += 1;
      this.#metrics.startCommandsTotal += 1;
      this.#metrics.observedStateTransitionsTotal += 2;
    }
    this.#lastDecisionScanning = scanning;
    this.#lastDecisionMode = this.#mode;
    this.#lastDecisionWindowIndex = windowIndex;

    this.#metrics.evaluationsTotal += 1;
    this.#metrics[
      this.#mode === SCAN_POLICY_MODES.STABLE
        ? "stableEvaluationsTotal"
        : "failoverEvaluationsTotal"
    ] += 1;
    this.#metrics[
      scanning ? "scanningDecisionsTotal" : "idleDecisionsTotal"
    ] += 1;

    return Object.freeze({
      evaluatedAtMs: nowMs,
      mode: this.#mode,
      scanning,
      command,
      windowIndex,
      windowMs: schedule.windowMs,
      periodMs: schedule.periodMs,
      dutyCycle: schedule.windowMs / schedule.periodMs,
      windowStartAtMs,
      windowEndAtMs,
      nextTransitionAtMs,
      nextScanStartAtMs,
      timeUntilNextScanMs: scanning ? 0 : nextScanStartAtMs - nowMs
    });
  }

  metrics() {
    return Object.freeze({
      ...this.#metrics,
      currentMode: this.#mode,
      nonContinuousWindows: Object.values(this.#policy).every(
        ({ windowMs, periodMs }) => windowMs < periodMs
      )
    });
  }
}
