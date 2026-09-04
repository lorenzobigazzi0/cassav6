import {
  RELIABLE_FRAME_TYPES,
  type ReliableFrameType,
  type ReliableMessageV1
} from "../protocol/FrameCodec.js";
import {
  BackendHealthProbe,
  type BackendHealthResult
} from "../backend/BackendHealthProbe.js";
import {
  BluetoothShadowIngressV1,
  type BluetoothShadowMessageV1
} from "../backend/BluetoothShadowIngress.js";
import {
  ROUTE_ADVERTISEMENT_KINDS,
  ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET,
  RouteAdvertisementPublisherV1,
  batteryBucketV1,
  decodeRouteAdvertisementV1,
  queueDepthBucketV1,
  serverRttBucketV1
} from "../routing/RouteAdvertisementV1.js";
import type { RaspberryRouteHealthV1 } from "../bluez/LeAdvertiser.js";
import type { GattReliableDataPlaneV1 } from "../session/GattReliableDataPlaneV1.js";
import type {
  BluetoothTransportStoreV1,
  StoredRouteAdvertisementV1
} from "../storage/BluetoothTransportStore.js";

export const BLUETOOTH_TRANSPORT_RUNTIME_STATES = Object.freeze({
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  FAILED: "FAILED",
  STOPPED: "STOPPED"
} as const);

export type BluetoothTransportRuntimeState =
  (typeof BLUETOOTH_TRANSPORT_RUNTIME_STATES)[keyof typeof BLUETOOTH_TRANSPORT_RUNTIME_STATES];

export interface BluetoothTransportMetricsSnapshotV1 {
  readonly framesTx: number | null;
  readonly framesRx: number | null;
  readonly retries: number | null;
  readonly duplicates: number | null;
  readonly outboxDepth: number;
}

export interface BluetoothTransportRuntimeSchedulerV1 {
  set(handler: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

interface ReliableDataPlanePortV1 {
  readonly enabled: boolean;
  tick(): Promise<Readonly<{ retried: number; suspended: number; expired: number }>>;
  restoreBound(): Promise<number>;
  sendBound(input: {
    readonly type: ReliableFrameType;
    readonly payload: Uint8Array;
    readonly durable?: boolean;
    readonly ttlMs?: number;
  }): Promise<Readonly<{ messageId: string; durableCommitted: boolean }>>;
  reset(): void;
  snapshot(): ReturnType<GattReliableDataPlaneV1["snapshot"]>;
}

interface TransportStorePortV1 {
  reserveRouteAdvertisementSequence(): number;
  routeAdvertisementSequenceHighWatermark(): number;
  storeLastServerAdvertisement(value: StoredRouteAdvertisementV1): void;
  snapshot(): ReturnType<BluetoothTransportStoreV1["snapshot"]>;
}

const defaultScheduler: BluetoothTransportRuntimeSchedulerV1 = {
  set(handler, intervalMs) {
    return setInterval(handler, intervalMs);
  },
  clear(handle) {
    clearInterval(handle as NodeJS.Timeout);
  }
};

export class BluetoothTransportRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BluetoothTransportRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new BluetoothTransportRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function assertInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_RUNTIME_CONFIGURATION", `${field} is outside its canonical range`);
  }
}

export class BluetoothTransportRuntimeV1 {
  readonly #routeAdvertisementEnabled: boolean;
  readonly #shadowEnabled: boolean;
  readonly #store: TransportStorePortV1;
  readonly #healthProbe: BackendHealthProbe;
  readonly #routePublisher: RouteAdvertisementPublisherV1;
  readonly #shadowIngress: BluetoothShadowIngressV1;
  readonly #scheduler: BluetoothTransportRuntimeSchedulerV1;
  readonly #tickIntervalMs: number;
  readonly #healthIntervalMs: number;
  readonly #now: () => number;
  readonly #onFatal: (error: unknown) => void;
  readonly #onRouteHealth: (
    health: Readonly<RaspberryRouteHealthV1>
  ) => void | Promise<void>;
  #dataPlane: ReliableDataPlanePortV1 | null = null;
  #timer: unknown | null = null;
  #tail: Promise<void> = Promise.resolve();
  #state: BluetoothTransportRuntimeState =
    BLUETOOTH_TRANSPORT_RUNTIME_STATES.IDLE;
  #lastNowEpochMs = 0;
  #lastHealthProbeAtEpochMs: number | null = null;
  #lastRouteChangeAtEpochMs = 0;
  #lastReachable = false;
  #lastHealth: BackendHealthResult | null = null;
  #lastHealthSampleAtEpochMs: number | null = null;
  #lastRouteHealth: Readonly<RaspberryRouteHealthV1> | null = null;
  #routeHealthGeneration = 0;
  #restoredSessionBinds = 0;
  #ticks = 0;
  #tickFailures = 0;
  #restoredDurableMessages = 0;
  #routesSent = 0;
  #routesReceived = 0;
  #controlMessagesReceived = 0;
  #businessMessagesRejected = 0;

  constructor(input: {
    readonly routeAdvertisementEnabled: boolean;
    readonly shadowEnabled: boolean;
    readonly store: TransportStorePortV1;
    readonly healthProbe: BackendHealthProbe;
    readonly shadowHandler: (
      message: BluetoothShadowMessageV1
    ) => void | Promise<void>;
    readonly routePublisher?: RouteAdvertisementPublisherV1;
    readonly scheduler?: BluetoothTransportRuntimeSchedulerV1;
    readonly tickIntervalMs?: number;
    readonly healthIntervalMs?: number;
    readonly now?: () => number;
    readonly onFatal?: (error: unknown) => void;
    readonly onRouteHealth?: (
      health: Readonly<RaspberryRouteHealthV1>
    ) => void | Promise<void>;
  }) {
    if (input.shadowEnabled && !input.routeAdvertisementEnabled) {
      fail(
        "INVALID_RUNTIME_CONFIGURATION",
        "Bluetooth shadow requires route advertisement"
      );
    }
    this.#routeAdvertisementEnabled = input.routeAdvertisementEnabled;
    this.#shadowEnabled = input.shadowEnabled;
    this.#store = input.store;
    this.#healthProbe = input.healthProbe;
    this.#routePublisher =
      input.routePublisher ?? new RouteAdvertisementPublisherV1(5_000, input.store);
    this.#scheduler = input.scheduler ?? defaultScheduler;
    this.#tickIntervalMs = input.tickIntervalMs ?? 250;
    this.#healthIntervalMs = input.healthIntervalMs ?? 5_000;
    this.#now = input.now ?? Date.now;
    this.#onFatal = input.onFatal ?? (() => undefined);
    this.#onRouteHealth = input.onRouteHealth ?? (() => undefined);
    assertInteger(this.#tickIntervalMs, 50, 5_000, "tickIntervalMs");
    assertInteger(this.#healthIntervalMs, 1_000, 60_000, "healthIntervalMs");
    this.#shadowIngress = new BluetoothShadowIngressV1({
      enabled: this.#shadowEnabled,
      handler: input.shadowHandler,
      now: this.#now
    });
  }

  attachDataPlane(dataPlane: ReliableDataPlanePortV1): void {
    if (this.#dataPlane !== null || !dataPlane.enabled) {
      fail(
        "INVALID_DATA_PLANE_BINDING",
        "runtime requires exactly one enabled reliable data plane"
      );
    }
    this.#dataPlane = dataPlane;
  }

  start(): void {
    if (this.#state === BLUETOOTH_TRANSPORT_RUNTIME_STATES.RUNNING) return;
    if (
      this.#state === BLUETOOTH_TRANSPORT_RUNTIME_STATES.FAILED ||
      this.#dataPlane === null
    ) {
      fail("RUNTIME_NOT_STARTABLE", "Bluetooth transport runtime is not startable");
    }
    this.#state = BLUETOOTH_TRANSPORT_RUNTIME_STATES.RUNNING;
    this.#lastRouteChangeAtEpochMs = this.#checkedNow();
    this.#timer = this.#scheduler.set(() => this.#queueTick(), this.#tickIntervalMs);
    this.#queueTick();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      this.#scheduler.clear(this.#timer);
      this.#timer = null;
    }
    await this.#tail;
    this.#dataPlane?.reset();
    if (this.#state !== BLUETOOTH_TRANSPORT_RUNTIME_STATES.FAILED) {
      this.#state = BLUETOOTH_TRANSPORT_RUNTIME_STATES.STOPPED;
    }
  }

  async handleMessage(message: ReliableMessageV1): Promise<void> {
    if (this.#state !== BLUETOOTH_TRANSPORT_RUNTIME_STATES.RUNNING) {
      fail("RUNTIME_NOT_RUNNING", "upper-layer delivery requires a running runtime");
    }
    switch (message.type) {
      case RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT: {
        const decoded = decodeRouteAdvertisementV1(message.payload);
        this.#store.storeLastServerAdvertisement({
          ...decoded,
          observedAtEpochMs: this.#checkedNow()
        });
        this.#routesReceived += 1;
        return;
      }
      case RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC:
        await this.#shadowIngress.accept({ authenticated: true, message });
        return;
      case RELIABLE_FRAME_TYPES.CLOSE:
      case RELIABLE_FRAME_TYPES.ERROR:
        this.#controlMessagesReceived += 1;
        return;
      case RELIABLE_FRAME_TYPES.DATA:
        this.#businessMessagesRejected += 1;
        fail(
          "BUSINESS_MESSAGE_FORBIDDEN",
          "B10 shadow never accepts or routes Bluetooth business messages"
        );
      case RELIABLE_FRAME_TYPES.ACK:
        fail("ACK_NOT_DELIVERABLE", "ACK frames are consumed by the reliable channel");
      default:
        fail("UNASSIGNED_MESSAGE_TYPE", "reliable message type is not assigned");
    }
  }

  metricsSnapshot(): Readonly<BluetoothTransportMetricsSnapshotV1> {
    const channel = this.#dataPlane?.snapshot().channel ?? null;
    return Object.freeze({
      framesTx: channel?.framesTx ?? null,
      framesRx: channel?.framesRx ?? null,
      retries: channel?.retries ?? null,
      duplicates: channel?.duplicates ?? null,
      outboxDepth: this.#store.snapshot().outboxDepth
    });
  }

  snapshot(): Readonly<{
    state: BluetoothTransportRuntimeState;
    routeAdvertisementEnabled: boolean;
    shadowEnabled: boolean;
    ticks: number;
    tickFailures: number;
    restoredDurableMessages: number;
    routesSent: number;
    routesReceived: number;
    controlMessagesReceived: number;
    businessMessagesRejected: number;
    businessMessagesForwarded: 0;
    routeReachable: boolean;
    routeHealth: Readonly<{
      generation: number;
      routeKind: RaspberryRouteHealthV1["routeKind"];
      serverRttBucket: number;
      queueDepthBucket: number;
      batteryBucket: number;
    }> | null;
    health: ReturnType<BackendHealthProbe["snapshot"]>;
    shadow: ReturnType<BluetoothShadowIngressV1["snapshot"]>;
    store: ReturnType<BluetoothTransportStoreV1["snapshot"]>;
  }> {
    return Object.freeze({
      state: this.#state,
      routeAdvertisementEnabled: this.#routeAdvertisementEnabled,
      shadowEnabled: this.#shadowEnabled,
      ticks: this.#ticks,
      tickFailures: this.#tickFailures,
      restoredDurableMessages: this.#restoredDurableMessages,
      routesSent: this.#routesSent,
      routesReceived: this.#routesReceived,
      controlMessagesReceived: this.#controlMessagesReceived,
      businessMessagesRejected: this.#businessMessagesRejected,
      businessMessagesForwarded: 0,
      routeReachable: this.#lastReachable,
      routeHealth:
        this.#lastRouteHealth === null
          ? null
          : Object.freeze({
              generation: this.#lastRouteHealth.generation,
              routeKind: this.#lastRouteHealth.routeKind,
              serverRttBucket: this.#lastRouteHealth.serverRttBucket,
              queueDepthBucket: this.#lastRouteHealth.queueDepthBucket,
              batteryBucket: this.#lastRouteHealth.batteryBucket
            }),
      health: this.#healthProbe.snapshot(),
      shadow: this.#shadowIngress.snapshot(),
      store: this.#store.snapshot()
    });
  }

  #queueTick(): void {
    if (this.#state !== BLUETOOTH_TRANSPORT_RUNTIME_STATES.RUNNING) return;
    const result = this.#tail.then(() => this.#tick());
    this.#tail = result.catch((error) => this.#failClosed(error));
  }

  async #tick(): Promise<void> {
    const dataPlane = this.#dataPlane;
    if (dataPlane === null) {
      fail("DATA_PLANE_MISSING", "reliable data plane was detached");
    }
    this.#ticks += 1;
    await dataPlane.tick();
    let dataSnapshot = dataPlane.snapshot();
    if (
      dataSnapshot.bound &&
      dataSnapshot.sessionBinds > this.#restoredSessionBinds
    ) {
      this.#restoredDurableMessages += await dataPlane.restoreBound();
      this.#restoredSessionBinds = dataSnapshot.sessionBinds;
      dataSnapshot = dataPlane.snapshot();
    }

    let now = this.#checkedNow();
    let routeChanged = false;
    if (
      this.#lastHealthProbeAtEpochMs === null ||
      now - this.#lastHealthProbeAtEpochMs >= this.#healthIntervalMs
    ) {
      const health = await this.#healthProbe.probe();
      now = this.#checkedNow();
      if (
        health.sampledAtEpochMs > now ||
        (this.#lastHealthSampleAtEpochMs !== null &&
          health.sampledAtEpochMs < this.#lastHealthSampleAtEpochMs)
      ) {
        fail("CLOCK_REGRESSION", "backend health sample clock moved backwards");
      }
      this.#lastHealthProbeAtEpochMs = now;
      this.#lastHealthSampleAtEpochMs = health.sampledAtEpochMs;
      if (health.canReachServer !== this.#lastReachable) {
        this.#lastReachable = health.canReachServer;
        this.#lastRouteChangeAtEpochMs = now;
        routeChanged = true;
      }
      this.#lastHealth = health;
      this.#routeHealthGeneration += 1;
      const storeSnapshot = this.#store.snapshot();
      const routeHealth = Object.freeze({
        generation: this.#routeHealthGeneration,
        observedAtEpochMs: health.sampledAtEpochMs,
        canReachServer: health.canReachServer,
        routeKind: health.canReachServer
          ? ROUTE_ADVERTISEMENT_KINDS.LAN
          : ROUTE_ADVERTISEMENT_KINDS.NONE,
        serverRttBucket: serverRttBucketV1(
          health.canReachServer ? health.rttMs : null
        ),
        queueDepthBucket: queueDepthBucketV1(storeSnapshot.outboxDepth),
        batteryBucket: batteryBucketV1(null)
      });
      this.#lastRouteHealth = routeHealth;
      await this.#onRouteHealth(routeHealth);
    }

    if (
      !this.#routeAdvertisementEnabled ||
      !dataSnapshot.bound ||
      !dataSnapshot.dataSubscribed ||
      dataSnapshot.channel === null ||
      (dataSnapshot.channel.pendingMessages !== 0 && !routeChanged)
    ) {
      return;
    }
    const payload = this.#routePublisher.build({
      nowEpochMs: now,
      force: routeChanged,
      canReachServer: this.#lastReachable,
      routeKind: this.#lastReachable
        ? ROUTE_ADVERTISEMENT_KINDS.LAN
        : ROUTE_ADVERTISEMENT_KINDS.NONE,
      serverRttMs: this.#lastHealth?.rttMs ?? null,
      lastRouteChangeAtEpochMs: this.#lastRouteChangeAtEpochMs,
      queueDepth: this.#store.snapshot().outboxDepth,
      batteryPercent: null
    });
    if (payload === null) return;
    try {
      await dataPlane.sendBound({
        type: RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT,
        payload,
        durable: false,
        ttlMs: 15_000
      });
      this.#routesSent += 1;
    } finally {
      payload.fill(0);
    }
  }

  #checkedNow(): number {
    const now = this.#now();
    assertInteger(now, 0, Number.MAX_SAFE_INTEGER, "clock");
    if (now < this.#lastNowEpochMs) {
      fail("CLOCK_REGRESSION", "transport runtime clock moved backwards");
    }
    this.#lastNowEpochMs = now;
    return now;
  }

  async #failClosed(error: unknown): Promise<void> {
    if (this.#state === BLUETOOTH_TRANSPORT_RUNTIME_STATES.FAILED) return;
    this.#tickFailures += 1;
    if (this.#timer !== null) {
      this.#scheduler.clear(this.#timer);
      this.#timer = null;
    }
    this.#lastReachable = false;
    this.#routeHealthGeneration += 1;
    const failedHealth = Object.freeze({
      generation: this.#routeHealthGeneration,
      observedAtEpochMs: this.#lastNowEpochMs,
      canReachServer: false,
      routeKind: ROUTE_ADVERTISEMENT_KINDS.NONE,
      serverRttBucket: ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET,
      queueDepthBucket: (() => {
        try {
          return queueDepthBucketV1(this.#store.snapshot().outboxDepth);
        } catch {
          return 0;
        }
      })(),
      batteryBucket: ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET
    });
    this.#lastRouteHealth = failedHealth;
    try {
      await this.#onRouteHealth(failedHealth);
    } catch {
      // The fatal shutdown remains authoritative if advertising also failed.
    }
    this.#dataPlane?.reset();
    this.#state = BLUETOOTH_TRANSPORT_RUNTIME_STATES.FAILED;
    this.#onFatal(error);
  }
}
