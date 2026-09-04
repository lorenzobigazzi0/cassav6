import type { NodeMetricsSnapshot } from "./MetricsRegistry.js";
import type { BluetoothTransportMetricsSnapshotV1 } from "../node/BluetoothTransportRuntimeV1.js";

export const BLUETOOTH_METRICS_REPORTER_STATES = Object.freeze({
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  FAILED: "FAILED",
  STOPPED: "STOPPED"
} as const);

export type BluetoothMetricsReporterState =
  (typeof BLUETOOTH_METRICS_REPORTER_STATES)[keyof typeof BLUETOOTH_METRICS_REPORTER_STATES];

export const BLUETOOTH_METRIC_STATUSES = Object.freeze({
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE"
} as const);

export const BLUETOOTH_METRICS_MAX_REPORT_BYTES = 2_048;

export interface BluetoothMetricsReporterSchedulerV1 {
  set(handler: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

export interface BluetoothMetricsReportV1 {
  readonly schemaVersion: 1;
  readonly source: "V6_RASPBERRY_BLUETOOTH_METRICS";
  readonly component: "cassav6-bluetooth-node";
  readonly sampleSequence: number;
  readonly sampledAtEpochMs: number;
  readonly reporterStartedAtEpochMs: number;
  readonly metrics: Readonly<{
    discoveryLatencyMs: BluetoothMetricV1;
    connectLatencyMs: BluetoothMetricV1;
    authLatencyMs: BluetoothMetricV1;
    mtu: BluetoothMetricV1;
    rssi: BluetoothMetricV1;
    framesTx: BluetoothMetricV1;
    framesRx: BluetoothMetricV1;
    retries: BluetoothMetricV1;
    duplicates: BluetoothMetricV1;
    outboxDepth: BluetoothMetricV1;
    sessionDuration: BluetoothMetricV1;
    closeReason: BluetoothMetricV1;
    peerExpiryCount: BluetoothMetricV1;
  }>;
}

export type BluetoothMetricV1 =
  | Readonly<{
      status: typeof BLUETOOTH_METRIC_STATUSES.AVAILABLE;
      value: number;
    }>
  | Readonly<{
      status: typeof BLUETOOTH_METRIC_STATUSES.UNAVAILABLE;
    }>;

export class BluetoothMetricsReporterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BluetoothMetricsReporterError";
    this.code = code;
  }
}

const defaultScheduler: BluetoothMetricsReporterSchedulerV1 = {
  set(handler, intervalMs) {
    return setInterval(handler, intervalMs);
  },
  clear(handle) {
    clearInterval(handle as NodeJS.Timeout);
  }
};

const UNAVAILABLE_METRIC = Object.freeze({
  status: BLUETOOTH_METRIC_STATUSES.UNAVAILABLE
});

function fail(code: string, message: string, cause?: unknown): never {
  throw new BluetoothMetricsReporterError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function assertSafeCounter(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "INVALID_METRICS_SNAPSHOT",
      `${field} must be a non-negative safe integer`
    );
  }
}

function availableCounter(value: number, field: string): BluetoothMetricV1 {
  assertSafeCounter(value, field);
  return Object.freeze({
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value
  });
}

function optionalCounter(
  value: number | null,
  field: string
): BluetoothMetricV1 {
  return value === null ? UNAVAILABLE_METRIC : availableCounter(value, field);
}

export class BluetoothMetricsReporterV1 {
  readonly #intervalMs: number;
  readonly #nodeMetrics: () => Readonly<NodeMetricsSnapshot>;
  readonly #transportMetrics: () =>
    | Readonly<BluetoothTransportMetricsSnapshotV1>
    | null;
  readonly #publish: (report: Readonly<BluetoothMetricsReportV1>) => void;
  readonly #scheduler: BluetoothMetricsReporterSchedulerV1;
  readonly #now: () => number;
  readonly #onFatal: (error: unknown) => void;
  #state: BluetoothMetricsReporterState =
    BLUETOOTH_METRICS_REPORTER_STATES.IDLE;
  #timerHandle: unknown;
  #timerActive = false;
  #reporterStartedAtEpochMs: number | null = null;
  #lastClockEpochMs = 0;
  #lastSampledAtEpochMs: number | null = null;
  #sampleSequence = 0;
  #failuresTotal = 0;

  constructor(input: {
    readonly intervalMs: number;
    readonly nodeMetrics: () => Readonly<NodeMetricsSnapshot>;
    readonly transportMetrics: () =>
      | Readonly<BluetoothTransportMetricsSnapshotV1>
      | null;
    readonly publish: (report: Readonly<BluetoothMetricsReportV1>) => void;
    readonly scheduler?: BluetoothMetricsReporterSchedulerV1;
    readonly now?: () => number;
    readonly onFatal?: (error: unknown) => void;
  }) {
    if (
      !Number.isSafeInteger(input.intervalMs) ||
      input.intervalMs < 1_000 ||
      input.intervalMs > 60_000
    ) {
      fail(
        "INVALID_REPORTER_CONFIGURATION",
        "intervalMs must be an integer from 1000 to 60000"
      );
    }
    this.#intervalMs = input.intervalMs;
    this.#nodeMetrics = input.nodeMetrics;
    this.#transportMetrics = input.transportMetrics;
    this.#publish = input.publish;
    this.#scheduler = input.scheduler ?? defaultScheduler;
    this.#now = input.now ?? Date.now;
    this.#onFatal = input.onFatal ?? (() => undefined);
  }

  start(): ReturnType<BluetoothMetricsReporterV1["snapshot"]> {
    if (this.#state === BLUETOOTH_METRICS_REPORTER_STATES.RUNNING) {
      return this.snapshot();
    }
    if (this.#state !== BLUETOOTH_METRICS_REPORTER_STATES.IDLE) {
      fail("REPORTER_NOT_STARTABLE", "metrics reporter is not startable");
    }

    try {
      this.#reporterStartedAtEpochMs = this.#checkedNow();
      this.#state = BLUETOOTH_METRICS_REPORTER_STATES.RUNNING;
      const handle = this.#scheduler.set(
        () => this.#sample(),
        this.#intervalMs
      );
      if (this.#state !== BLUETOOTH_METRICS_REPORTER_STATES.RUNNING) {
        this.#scheduler.clear(handle);
        fail(
          "REPORTER_START_FAILED",
          "metrics reporter failed during scheduler startup"
        );
      }
      this.#timerHandle = handle;
      this.#timerActive = true;
      return this.snapshot();
    } catch (error) {
      this.#state = BLUETOOTH_METRICS_REPORTER_STATES.FAILED;
      this.#timerActive = false;
      this.#timerHandle = undefined;
      this.#failuresTotal += 1;
      if (error instanceof BluetoothMetricsReporterError) throw error;
      fail(
        "REPORTER_START_FAILED",
        "metrics reporter scheduler startup failed",
        error
      );
    }
  }

  stop(): ReturnType<BluetoothMetricsReporterV1["snapshot"]> {
    if (this.#state === BLUETOOTH_METRICS_REPORTER_STATES.STOPPED) {
      return this.snapshot();
    }
    try {
      this.#clearTimer();
    } catch (error) {
      this.#state = BLUETOOTH_METRICS_REPORTER_STATES.FAILED;
      this.#failuresTotal += 1;
      fail(
        "REPORTER_STOP_FAILED",
        "metrics reporter timer cleanup failed",
        error
      );
    }
    if (this.#state !== BLUETOOTH_METRICS_REPORTER_STATES.FAILED) {
      this.#state = BLUETOOTH_METRICS_REPORTER_STATES.STOPPED;
    }
    return this.snapshot();
  }

  snapshot(): Readonly<{
    state: BluetoothMetricsReporterState;
    intervalMs: number;
    timerActive: boolean;
    reporterStartedAtEpochMs: number | null;
    lastSampledAtEpochMs: number | null;
    sampleSequence: number;
    failuresTotal: number;
  }> {
    return Object.freeze({
      state: this.#state,
      intervalMs: this.#intervalMs,
      timerActive: this.#timerActive,
      reporterStartedAtEpochMs: this.#reporterStartedAtEpochMs,
      lastSampledAtEpochMs: this.#lastSampledAtEpochMs,
      sampleSequence: this.#sampleSequence,
      failuresTotal: this.#failuresTotal
    });
  }

  #sample(): void {
    if (this.#state !== BLUETOOTH_METRICS_REPORTER_STATES.RUNNING) return;
    try {
      if (this.#sampleSequence === Number.MAX_SAFE_INTEGER) {
        fail("REPORT_SEQUENCE_EXHAUSTED", "metrics report sequence exhausted");
      }
      const sampledAtEpochMs = this.#checkedNow();
      const reporterStartedAtEpochMs = this.#reporterStartedAtEpochMs;
      if (reporterStartedAtEpochMs === null) {
        fail("REPORTER_NOT_STARTED", "metrics reporter start time is unavailable");
      }
      const node = this.#nodeMetrics();
      const transport = this.#transportMetrics();
      const report = Object.freeze({
        schemaVersion: 1 as const,
        source: "V6_RASPBERRY_BLUETOOTH_METRICS" as const,
        component: "cassav6-bluetooth-node" as const,
        sampleSequence: this.#sampleSequence + 1,
        sampledAtEpochMs,
        reporterStartedAtEpochMs,
        metrics: Object.freeze({
          discoveryLatencyMs: UNAVAILABLE_METRIC,
          connectLatencyMs: UNAVAILABLE_METRIC,
          authLatencyMs: UNAVAILABLE_METRIC,
          mtu: UNAVAILABLE_METRIC,
          rssi: UNAVAILABLE_METRIC,
          framesTx:
            transport === null
              ? UNAVAILABLE_METRIC
              : optionalCounter(transport.framesTx, "framesTx"),
          framesRx:
            transport === null
              ? UNAVAILABLE_METRIC
              : optionalCounter(transport.framesRx, "framesRx"),
          retries:
            transport === null
              ? UNAVAILABLE_METRIC
              : optionalCounter(transport.retries, "retries"),
          duplicates:
            transport === null
              ? UNAVAILABLE_METRIC
              : optionalCounter(transport.duplicates, "duplicates"),
          outboxDepth:
            transport === null
              ? UNAVAILABLE_METRIC
              : availableCounter(transport.outboxDepth, "outboxDepth"),
          sessionDuration: UNAVAILABLE_METRIC,
          closeReason: UNAVAILABLE_METRIC,
          peerExpiryCount: availableCounter(
            node.peersPrunedTotal,
            "peerExpiryCount"
          )
        })
      }) satisfies Readonly<BluetoothMetricsReportV1>;
      const encodedBytes = Buffer.byteLength(JSON.stringify(report), "utf8");
      if (encodedBytes > BLUETOOTH_METRICS_MAX_REPORT_BYTES) {
        fail(
          "REPORT_SIZE_EXCEEDED",
          "metrics report exceeded its fixed byte budget"
        );
      }
      this.#publish(report);
      this.#sampleSequence = report.sampleSequence;
      this.#lastSampledAtEpochMs = sampledAtEpochMs;
    } catch (error) {
      this.#failClosed(error);
    }
  }

  #checkedNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      fail("INVALID_CLOCK", "metrics reporter clock must be a safe epoch integer");
    }
    if (now < this.#lastClockEpochMs) {
      fail("CLOCK_REGRESSION", "metrics reporter clock moved backwards");
    }
    this.#lastClockEpochMs = now;
    return now;
  }

  #clearTimer(): void {
    if (!this.#timerActive) return;
    const handle = this.#timerHandle;
    this.#timerActive = false;
    this.#timerHandle = undefined;
    this.#scheduler.clear(handle);
  }

  #failClosed(error: unknown): void {
    if (this.#state === BLUETOOTH_METRICS_REPORTER_STATES.FAILED) return;
    this.#state = BLUETOOTH_METRICS_REPORTER_STATES.FAILED;
    this.#failuresTotal += 1;
    let fatal: unknown =
      error instanceof BluetoothMetricsReporterError
        ? error
        : new BluetoothMetricsReporterError(
            "METRICS_REPORT_FAILED",
            "periodic metrics report failed",
            { cause: error }
          );
    try {
      this.#clearTimer();
    } catch (cleanupError) {
      fatal = new BluetoothMetricsReporterError(
        "REPORTER_CLEANUP_FAILED",
        "periodic metrics reporter failed to release its timer",
        { cause: new AggregateError([fatal, cleanupError]) }
      );
    }
    try {
      this.#onFatal(fatal);
    } catch {
      // Reporter cleanup remains authoritative if the fatal observer fails.
    }
  }
}
