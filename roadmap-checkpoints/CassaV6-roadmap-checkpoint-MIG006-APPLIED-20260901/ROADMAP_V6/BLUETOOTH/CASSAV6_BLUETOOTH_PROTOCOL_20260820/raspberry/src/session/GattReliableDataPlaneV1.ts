import {
  RELIABLE_FRAME_TYPES,
  decodeReliableFragmentV1,
  type ReliableFrameType,
  type ReliableMessageV1
} from "../protocol/FrameCodec.js";
import {
  ReliableChannelV1,
  type ReliableChannelStoreV1
} from "../protocol/ReliableChannel.js";
import type { GattHelloExchangeV1 } from "./GattHelloExchangeV1.js";

export const GATT_RELIABLE_TRANSMITTERS = Object.freeze({
  DATA: "dataTx",
  ACK: "ackTx"
} as const);

export type GattReliableTransmitter =
  (typeof GATT_RELIABLE_TRANSMITTERS)[keyof typeof GATT_RELIABLE_TRANSMITTERS];

export class GattReliableDataPlaneError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GattReliableDataPlaneError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new GattReliableDataPlaneError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

export class GattReliableDataPlaneV1 {
  readonly #enabled: boolean;
  readonly #helloExchange: GattHelloExchangeV1;
  readonly #store: ReliableChannelStoreV1;
  #publish: ((output: Readonly<{
    transmitter: GattReliableTransmitter;
    value: Buffer;
  }>) => void | Promise<void>) | null;
  readonly #onMessage: (
    message: ReliableMessageV1
  ) => void | Promise<void>;
  readonly #now: () => number;
  readonly #subscriptions = new Set<GattReliableTransmitter>();
  #channel: ReliableChannelV1 | null = null;
  #devicePath: string | null = null;
  #peerTrustId: string | null = null;
  #receivedFragments = 0;
  #publishedFragments = 0;
  #sessionBinds = 0;
  #resets = 0;
  #failures = 0;

  constructor(input: {
    readonly enabled: boolean;
    readonly helloExchange: GattHelloExchangeV1;
    readonly store: ReliableChannelStoreV1;
    readonly publish?: (output: Readonly<{
      transmitter: GattReliableTransmitter;
      value: Buffer;
    }>) => void | Promise<void>;
    readonly onMessage: (
      message: ReliableMessageV1
    ) => void | Promise<void>;
    readonly now?: () => number;
  }) {
    this.#enabled = input.enabled;
    this.#helloExchange = input.helloExchange;
    this.#store = input.store;
    this.#publish = input.publish ?? null;
    this.#onMessage = input.onMessage;
    this.#now = input.now ?? Date.now;
    if (this.#enabled && !this.#helloExchange.directControlEnabled) {
      fail(
        "INVALID_DATA_PLANE_CONFIGURATION",
        "reliable data requires authenticated direct control"
      );
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setPublisher(
    publisher: ((output: Readonly<{
      transmitter: GattReliableTransmitter;
      value: Buffer;
    }>) => void | Promise<void>) | null
  ): void {
    if (publisher !== null && typeof publisher !== "function") {
      fail("INVALID_PUBLISHER", "data-plane publisher must be a function");
    }
    this.#publish = publisher;
  }

  setSubscription(
    transmitter: GattReliableTransmitter,
    enabled: boolean
  ): void {
    if (!Object.values(GATT_RELIABLE_TRANSMITTERS).includes(transmitter)) {
      fail("INVALID_TRANSMITTER", "GATT transmitter is not assigned");
    }
    if (!this.#enabled) {
      fail("DATA_PLANE_DISABLED", "reliable GATT data plane is disabled");
    }
    if (enabled) this.#subscriptions.add(transmitter);
    else this.#subscriptions.delete(transmitter);
  }

  async receive(devicePath: string, value: Uint8Array): Promise<Readonly<{
    complete: boolean;
    delivered: boolean;
    duplicate: boolean;
  }>> {
    this.#assertEnabled();
    if (!this.#subscriptions.has(GATT_RELIABLE_TRANSMITTERS.ACK)) {
      fail("ACK_SUBSCRIPTION_REQUIRED", "subscribe to ackTx before writing dataRx");
    }
    const channel = this.#bind(devicePath);
    this.#receivedFragments += 1;
    try {
      return await channel.receiveFragment(value);
    } catch (error) {
      this.#failures += 1;
      throw error;
    }
  }

  async send(input: {
    readonly devicePath: string;
    readonly type: ReliableFrameType;
    readonly payload: Uint8Array;
    readonly durable?: boolean;
    readonly ttlMs?: number;
  }): Promise<Readonly<{ messageId: string; durableCommitted: boolean }>> {
    this.#assertEnabled();
    if (input.type === RELIABLE_FRAME_TYPES.ACK) {
      fail("ACK_RESERVED", "ACK is emitted only by ReliableChannelV1");
    }
    if (!this.#subscriptions.has(GATT_RELIABLE_TRANSMITTERS.DATA)) {
      fail("DATA_SUBSCRIPTION_REQUIRED", "subscribe to dataTx before server send");
    }
    const channel = this.#bind(input.devicePath);
    try {
      return await channel.send({
        type: input.type,
        payload: input.payload,
        durable: input.durable,
        ttlMs: input.ttlMs
      });
    } catch (error) {
      this.#failures += 1;
      throw error;
    }
  }

  async sendBound(input: {
    readonly type: ReliableFrameType;
    readonly payload: Uint8Array;
    readonly durable?: boolean;
    readonly ttlMs?: number;
  }): Promise<Readonly<{ messageId: string; durableCommitted: boolean }>> {
    this.#assertEnabled();
    if (this.#devicePath === null || this.#channel === null) {
      return Promise.reject(
        new GattReliableDataPlaneError(
          "RELIABLE_CHANNEL_NOT_BOUND",
          "reliable data plane has no authenticated bound peer"
        )
      );
    }
    return this.send({ devicePath: this.#devicePath, ...input });
  }

  async restore(devicePath: string): Promise<number> {
    this.#assertEnabled();
    if (!this.#subscriptions.has(GATT_RELIABLE_TRANSMITTERS.DATA)) {
      fail("DATA_SUBSCRIPTION_REQUIRED", "dataTx subscription is required");
    }
    return this.#bind(devicePath).restoreDurableOutbox();
  }

  async restoreBound(): Promise<number> {
    this.#assertEnabled();
    if (this.#devicePath === null || this.#channel === null) {
      return Promise.reject(
        new GattReliableDataPlaneError(
          "RELIABLE_CHANNEL_NOT_BOUND",
          "reliable data plane has no authenticated bound peer"
        )
      );
    }
    return this.restore(this.#devicePath);
  }

  tick(): Promise<Readonly<{
    retried: number;
    suspended: number;
    expired: number;
  }>> {
    this.#assertEnabled();
    if (this.#channel === null) {
      return Promise.resolve(Object.freeze({ retried: 0, suspended: 0, expired: 0 }));
    }
    return this.#channel.tick();
  }

  reset(): void {
    this.#channel?.close();
    this.#channel = null;
    this.#devicePath = null;
    this.#peerTrustId = null;
    this.#subscriptions.clear();
    this.#resets += 1;
  }

  snapshot(): Readonly<{
    enabled: boolean;
    bound: boolean;
    dataSubscribed: boolean;
    ackSubscribed: boolean;
    receivedFragments: number;
    publishedFragments: number;
    sessionBinds: number;
    resets: number;
    failures: number;
    channel: ReturnType<ReliableChannelV1["snapshot"]> | null;
  }> {
    return Object.freeze({
      enabled: this.#enabled,
      bound: this.#channel !== null,
      dataSubscribed: this.#subscriptions.has(GATT_RELIABLE_TRANSMITTERS.DATA),
      ackSubscribed: this.#subscriptions.has(GATT_RELIABLE_TRANSMITTERS.ACK),
      receivedFragments: this.#receivedFragments,
      publishedFragments: this.#publishedFragments,
      sessionBinds: this.#sessionBinds,
      resets: this.#resets,
      failures: this.#failures,
      channel: this.#channel?.snapshot() ?? null
    });
  }

  #bind(devicePath: string): ReliableChannelV1 {
    if (this.#channel !== null) {
      if (this.#devicePath !== devicePath) {
        fail(
          "SESSION_ARBITRATION_CONFLICT",
          "one data plane cannot bind two device contexts"
        );
      }
      // Revalidate authorization on every operation, not only first bind.
      const fresh = this.#helloExchange.reliableChannelContext(devicePath);
      try {
        if (fresh.peerTrustId !== this.#peerTrustId) {
          this.reset();
          fail(
            "PEER_TRUST_MISMATCH",
            "bound session changed peer trust context"
          );
        }
        return this.#channel;
      } finally {
        fresh.material.clientToServer.key.fill(0);
        fresh.material.clientToServer.noncePrefix.fill(0);
        fresh.material.serverToClient.key.fill(0);
        fresh.material.serverToClient.noncePrefix.fill(0);
      }
    }
    const context = this.#helloExchange.reliableChannelContext(devicePath);
    try {
      this.#channel = new ReliableChannelV1({
        transport: {
          send: async (frame) => {
            const decoded = decodeReliableFragmentV1(frame);
            const transmitter =
              decoded.type === RELIABLE_FRAME_TYPES.ACK
                ? GATT_RELIABLE_TRANSMITTERS.ACK
                : GATT_RELIABLE_TRANSMITTERS.DATA;
            if (!this.#subscriptions.has(transmitter)) {
              fail(
                "TRANSMITTER_NOT_SUBSCRIBED",
                `${transmitter} is not subscribed`
              );
            }
            if (this.#publish === null) {
              fail("PUBLISHER_NOT_READY", "data-plane publisher is not bound");
            }
            await this.#publish({ transmitter, value: Buffer.from(frame) });
            this.#publishedFragments += 1;
          }
        },
        store: this.#store,
        peerTrustId: context.peerTrustId,
        mtu: context.mtu,
        txKey: context.material.serverToClient.key,
        rxKey: context.material.clientToServer.key,
        txNoncePrefix: context.material.serverToClient.noncePrefix,
        rxNoncePrefix: context.material.clientToServer.noncePrefix,
        onMessage: this.#onMessage,
        now: this.#now
      });
      this.#devicePath = devicePath;
      this.#peerTrustId = context.peerTrustId;
      this.#sessionBinds += 1;
      return this.#channel;
    } finally {
      context.material.clientToServer.key.fill(0);
      context.material.clientToServer.noncePrefix.fill(0);
      context.material.serverToClient.key.fill(0);
      context.material.serverToClient.noncePrefix.fill(0);
    }
  }

  #assertEnabled(): void {
    if (!this.#enabled) {
      fail("DATA_PLANE_DISABLED", "reliable GATT data plane is disabled");
    }
  }
}
