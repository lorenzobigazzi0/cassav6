import { randomBytes } from "node:crypto";

import {
  RELIABLE_FRAME_TYPES,
  type ReliableMessageV1
} from "../protocol/FrameCodec.js";
import { ReliableChannelV1 } from "../protocol/ReliableChannel.js";
import {
  BLUETOOTH_SHADOW_KINDS,
  BluetoothShadowIngressV1,
  encodeBluetoothShadowMessageV1,
  type BluetoothShadowKind
} from "./BluetoothShadowIngress.js";

export class CommandBusShadowAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandBusShadowAdapterError";
    this.code = code;
  }
}

export class CommandBusShadowAdapterV1 {
  readonly #enabled: boolean;
  readonly #channel: ReliableChannelV1;
  readonly #ingress: BluetoothShadowIngressV1;
  readonly #now: () => number;
  #diagnosticsSent = 0;
  #businessRouteAttemptsRejected = 0;

  constructor(input: {
    readonly enabled?: boolean;
    readonly channel: ReliableChannelV1;
    readonly ingress: BluetoothShadowIngressV1;
    readonly now?: () => number;
  }) {
    this.#enabled = input.enabled === true;
    this.#channel = input.channel;
    this.#ingress = input.ingress;
    this.#now = input.now ?? Date.now;
  }

  async emitDiagnostic(input: {
    readonly kind: BluetoothShadowKind;
    readonly body: string;
    readonly lanLatencyMs?: number | null;
  }): Promise<Readonly<{
    shadowSent: boolean;
    businessTransport: "LAN_HTTP_SSE";
  }>> {
    if (!this.#enabled) {
      return Object.freeze({
        shadowSent: false,
        businessTransport: "LAN_HTTP_SSE"
      });
    }
    if (!Object.values(BLUETOOTH_SHADOW_KINDS).includes(input.kind)) {
      throw new CommandBusShadowAdapterError(
        "BUSINESS_MESSAGE_REJECTED",
        "only health, ping and test can enter the Bluetooth shadow"
      );
    }
    const payload = encodeBluetoothShadowMessageV1({
      schemaVersion: 1,
      kind: input.kind,
      correlationId: randomBytes(16).toString("hex"),
      sentAtEpochMs: this.#now(),
      lanLatencyMs: input.lanLatencyMs ?? null,
      body: input.body
    });
    try {
      await this.#channel.send({
        type: RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC,
        payload,
        durable: false,
        ttlMs: 30_000
      });
      this.#diagnosticsSent += 1;
    } finally {
      payload.fill(0);
    }
    return Object.freeze({
      shadowSent: true,
      businessTransport: "LAN_HTTP_SSE"
    });
  }

  ingest(message: ReliableMessageV1): Promise<Readonly<{
    accepted: boolean;
    duplicate: boolean;
  }>> {
    return this.#ingress.accept({ authenticated: true, message });
  }

  routeBusinessCommand(): never {
    this.#businessRouteAttemptsRejected += 1;
    throw new CommandBusShadowAdapterError(
      "BUSINESS_ROUTING_FORBIDDEN",
      "B10 never routes business commands over Bluetooth"
    );
  }

  snapshot(): Readonly<{
    enabled: boolean;
    diagnosticsSent: number;
    businessRouteAttemptsRejected: number;
    businessMessagesForwarded: 0;
    businessTransport: "LAN_HTTP_SSE";
    ingress: ReturnType<BluetoothShadowIngressV1["snapshot"]>;
  }> {
    return Object.freeze({
      enabled: this.#enabled,
      diagnosticsSent: this.#diagnosticsSent,
      businessRouteAttemptsRejected: this.#businessRouteAttemptsRejected,
      businessMessagesForwarded: 0,
      businessTransport: "LAN_HTTP_SSE",
      ingress: this.#ingress.snapshot()
    });
  }
}
