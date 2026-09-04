import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  timingSafeEqual,
  type KeyObject
} from "node:crypto";

import {
  DIRECT_CONTROL_V1_AUTH_BYTES,
  DIRECT_CONTROL_V1_MESSAGE_TYPES,
  DIRECT_CONTROL_V1_X25519_SPKI_BYTES,
  buildClientKeyShareBinderMessageV1,
  buildSessionKeyBinderMessageV1,
  buildSessionTranscriptHashV1,
  createServerKeyConfirmationV1,
  decodeClientKeyConfirmV1,
  decodeClientKeyShareV1,
  decodeCloseV1,
  decodeHeartbeatV1,
  deriveDirectControlKeysV1,
  encodeCloseV1,
  encodeHeartbeatV1,
  encodeServerKeyShareV1,
  verifyClientKeyConfirmationV1
} from "../../../shared/protocol/direct-control-v1.mjs";
import type { DirectControlCloseReasonV1 } from "../../../shared/protocol/direct-control-v1.mjs";
import type { MutualAuthBindingV1 } from "../../../shared/protocol/mutual-auth-v1.mjs";
import { deriveReliableChannelDirectionMaterialV1 } from "../protocol/FrameCodec.js";

export const DIRECT_CONTROL_SERVER_SESSION_STATES = Object.freeze({
  AWAITING_CLIENT_CONFIRMATION: "AWAITING_CLIENT_CONFIRMATION",
  KEY_ESTABLISHED: "KEY_ESTABLISHED",
  FAILED: "FAILED",
  DESTROYED: "DESTROYED"
} as const);

export type DirectControlServerSessionState =
  (typeof DIRECT_CONTROL_SERVER_SESSION_STATES)[keyof typeof DIRECT_CONTROL_SERVER_SESSION_STATES];

export interface AuthorizedDeviceControlKeyPortV1 {
  createAuthorizedDeviceMac(input: {
    readonly nodeId: string;
    readonly certificateId: string;
    readonly message: Uint8Array;
  }): Promise<Buffer>;
  verifyAuthorizedDeviceMac(input: {
    readonly nodeId: string;
    readonly certificateId: string;
    readonly message: Uint8Array;
    readonly proof: Uint8Array;
  }): Promise<boolean>;
}

export interface X25519KeyAgreementPortV1 {
  generateKeyPair(): Readonly<{
    publicKey: KeyObject;
    privateKey: KeyObject;
  }>;
  importPublicKey(spki: Uint8Array): KeyObject;
  deriveSecret(privateKey: KeyObject, publicKey: KeyObject): Buffer;
  exportPublicKey(publicKey: KeyObject): Buffer;
}

export interface DirectControlHandshakeOptionsV1 {
  readonly keyAgreement?: X25519KeyAgreementPortV1;
}

export interface BeginDirectControlHandshakeInputV1 {
  readonly binding: MutualAuthBindingV1;
  readonly clientPublicKeySpki: Uint8Array;
  readonly clientBinder: Uint8Array;
}

export interface AcceptClientShareInputV1 {
  readonly binding: MutualAuthBindingV1;
  readonly sessionId: string;
  readonly wire: Uint8Array;
}

export interface DirectControlServerKeyShareV1 {
  readonly publicKeySpki: Buffer;
  readonly confirmation: Buffer;
}

export interface DirectControlReliableChannelMaterialV1 {
  readonly clientToServer: Readonly<{
    key: Buffer;
    noncePrefix: Buffer;
  }>;
  readonly serverToClient: Readonly<{
    key: Buffer;
    noncePrefix: Buffer;
  }>;
}

export class DirectControlHandshakeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectControlHandshakeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new DirectControlHandshakeError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function exactBuffer(
  value: Uint8Array,
  expectedLength: number,
  code: string,
  field: string
): Buffer {
  if (!(value instanceof Uint8Array)) {
    fail(code, `${field} must be a byte array`);
  }
  const copy = Buffer.from(value);
  if (copy.byteLength !== expectedLength) {
    copy.fill(0);
    fail(code, `${field} must contain exactly ${expectedLength} bytes`);
  }
  return copy;
}

function wipe(value: Uint8Array | ArrayBuffer | null | undefined): void {
  if (value === null || value === undefined) return;
  if (value instanceof ArrayBuffer) {
    new Uint8Array(value).fill(0);
    return;
  }
  value.fill(0);
}

function safeKeyCopy(value: unknown, field: string): Buffer {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
    fail("KEY_DERIVATION_FAILED", `${field} was not derived`);
  }
  const copy = Buffer.from(new Uint8Array(value));
  if (copy.byteLength !== DIRECT_CONTROL_V1_AUTH_BYTES) {
    copy.fill(0);
    fail("KEY_DERIVATION_FAILED", `${field} has an invalid length`);
  }
  return copy;
}

function canonicalX25519PublicKey(
  port: X25519KeyAgreementPortV1,
  spki: Buffer
): KeyObject {
  let publicKey: KeyObject;
  try {
    publicKey = port.importPublicKey(spki);
  } catch (error) {
    fail("INVALID_CLIENT_X25519_KEY", "client X25519 key is invalid", error);
  }
  if (publicKey.asymmetricKeyType !== "x25519") {
    fail("INVALID_CLIENT_X25519_KEY", "client key must use X25519");
  }
  let canonical: Buffer | null = null;
  try {
    canonical = port.exportPublicKey(publicKey);
    if (
      canonical.byteLength !== spki.byteLength ||
      !timingSafeEqual(canonical, spki)
    ) {
      fail(
        "INVALID_CLIENT_X25519_KEY",
        "client X25519 key must use canonical SPKI encoding"
      );
    }
  } finally {
    canonical?.fill(0);
  }
  return publicKey;
}

const defaultX25519KeyAgreement: X25519KeyAgreementPortV1 = {
  generateKeyPair() {
    return generateKeyPairSync("x25519");
  },
  importPublicKey(spki) {
    return createPublicKey({
      key: Buffer.from(spki),
      format: "der",
      type: "spki"
    });
  },
  deriveSecret(privateKey, publicKey) {
    return diffieHellman({ privateKey, publicKey });
  },
  exportPublicKey(publicKey) {
    return publicKey.export({ format: "der", type: "spki" });
  }
};

export class DirectControlServerSessionV1 {
  #state: DirectControlServerSessionState =
    DIRECT_CONTROL_SERVER_SESSION_STATES.AWAITING_CLIENT_CONFIRMATION;
  #serverPublicKeySpki: Buffer | null;
  #serverConfirmation: Buffer | null;
  #clientToServerControlKey: Buffer | null;
  #serverToClientControlKey: Buffer | null;
  #clientConfirmationKey: Buffer | null;
  #serverConfirmationKey: Buffer | null;
  #transcriptHash: Buffer | null;
  #acceptedConfirmationHash: Buffer | null = null;
  #sessionId: string | null;

  constructor(input: {
    readonly sessionId: string;
    readonly serverPublicKeySpki: Buffer;
    readonly serverConfirmation: Buffer;
    readonly clientToServerControlKey: Buffer;
    readonly serverToClientControlKey: Buffer;
    readonly clientConfirmationKey: Buffer;
    readonly serverConfirmationKey: Buffer;
    readonly transcriptHash: Buffer;
  }) {
    this.#sessionId = input.sessionId;
    this.#serverPublicKeySpki = input.serverPublicKeySpki;
    this.#serverConfirmation = input.serverConfirmation;
    this.#clientToServerControlKey = input.clientToServerControlKey;
    this.#serverToClientControlKey = input.serverToClientControlKey;
    this.#clientConfirmationKey = input.clientConfirmationKey;
    this.#serverConfirmationKey = input.serverConfirmationKey;
    this.#transcriptHash = input.transcriptHash;
  }

  get state(): DirectControlServerSessionState {
    return this.#state;
  }

  serverKeyShare(): Readonly<DirectControlServerKeyShareV1> {
    if (
      this.#state !==
        DIRECT_CONTROL_SERVER_SESSION_STATES.AWAITING_CLIENT_CONFIRMATION ||
      this.#serverPublicKeySpki === null ||
      this.#serverConfirmation === null
    ) {
      fail(
        "SERVER_KEY_SHARE_UNAVAILABLE",
        "server key share is no longer available"
      );
    }
    return Object.freeze({
      publicKeySpki: Buffer.from(this.#serverPublicKeySpki),
      confirmation: Buffer.from(this.#serverConfirmation)
    });
  }

  verifyClientConfirmation(confirmation: Uint8Array): void {
    let candidate: Buffer;
    try {
      candidate = exactBuffer(
      confirmation,
      DIRECT_CONTROL_V1_AUTH_BYTES,
        "INVALID_CLIENT_KEY_CONFIRMATION",
        "client confirmation"
      );
    } catch (error) {
      this.#failAndDestroy();
      throw error;
    }
    try {
      if (
        this.#state === DIRECT_CONTROL_SERVER_SESSION_STATES.KEY_ESTABLISHED &&
        this.#acceptedConfirmationHash !== null
      ) {
        const fingerprint = createHash("sha256").update(candidate).digest();
        try {
          if (!timingSafeEqual(fingerprint, this.#acceptedConfirmationHash)) {
            this.#failAndDestroy();
            fail(
              "CLIENT_KEY_CONFIRMATION_REPLAY",
              "client key confirmation conflicts with the established key"
            );
          }
          return;
        } finally {
          fingerprint.fill(0);
        }
      }
      if (
        this.#state !==
          DIRECT_CONTROL_SERVER_SESSION_STATES.AWAITING_CLIENT_CONFIRMATION ||
        this.#clientConfirmationKey === null ||
        this.#transcriptHash === null ||
        this.#serverConfirmation === null
      ) {
        fail(
          "KEY_CONTEXT_UNAVAILABLE",
          "direct-control key context is unavailable"
        );
      }

      let verified: boolean;
      try {
        verified = verifyClientKeyConfirmationV1({
          clientConfirmationKey: this.#clientConfirmationKey,
          transcriptHash: this.#transcriptHash,
          serverConfirmation: this.#serverConfirmation,
          confirmation: candidate
        });
      } catch (error) {
        this.#failAndDestroy();
        fail(
          "INVALID_CLIENT_KEY_CONFIRMATION",
          "client key confirmation is invalid",
          error
        );
      }
      if (!verified) {
        this.#failAndDestroy();
        fail(
          "CLIENT_KEY_CONFIRMATION_INVALID",
          "client did not confirm the derived session key"
        );
      }
      this.#acceptedConfirmationHash = createHash("sha256")
        .update(candidate)
        .digest();
      this.#clientConfirmationKey.fill(0);
      this.#clientConfirmationKey = null;
      this.#serverConfirmationKey?.fill(0);
      this.#serverConfirmationKey = null;
      this.#serverPublicKeySpki?.fill(0);
      this.#serverPublicKeySpki = null;
      this.#serverConfirmation.fill(0);
      this.#serverConfirmation = null;
      this.#state = DIRECT_CONTROL_SERVER_SESSION_STATES.KEY_ESTABLISHED;
    } finally {
      candidate.fill(0);
    }
  }

  acceptClientConfirmationWire(wire: Uint8Array): void {
    let decoded: ReturnType<typeof decodeClientKeyConfirmV1> | null = null;
    try {
      decoded = decodeClientKeyConfirmV1(wire);
      if (this.#sessionId === null || decoded.sessionId !== this.#sessionId) {
        fail(
          "SESSION_BINDING_CONFLICT",
          "client key confirmation does not match the active session"
        );
      }
      this.verifyClientConfirmation(decoded.confirmation);
    } catch (error) {
      this.#failAndDestroy();
      if (error instanceof DirectControlHandshakeError) throw error;
      fail(
        "INVALID_CLIENT_KEY_CONFIRMATION",
        "client key confirmation wire is invalid",
        error
      );
    } finally {
      decoded?.confirmation.fill(0);
    }
  }

  encodePing(sequence: number): Buffer {
    const context = this.#establishedControlContext();
    try {
      return encodeHeartbeatV1({
        messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
        sessionId: context.sessionId,
        sequence,
        authenticationKey: context.serverToClientKey
      });
    } catch (error) {
      return this.#controlFailure("PING_ENCODING_FAILED", error);
    }
  }

  acceptPong(wire: Uint8Array, expectedSequence: number): number {
    const context = this.#establishedControlContext();
    try {
      const decoded = decodeHeartbeatV1(wire, {
        authenticationKey: context.clientToServerKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
        expectedSequence
      });
      this.#assertSessionId(decoded.sessionId);
      return decoded.sequence;
    } catch (error) {
      return this.#controlFailure("PONG_VERIFICATION_FAILED", error);
    }
  }

  encodeClose(sequence: number, reason: DirectControlCloseReasonV1): Buffer {
    const context = this.#establishedControlContext();
    try {
      return encodeCloseV1({
        messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
        sessionId: context.sessionId,
        sequence,
        reason,
        authenticationKey: context.serverToClientKey
      });
    } catch (error) {
      return this.#controlFailure("CLOSE_ENCODING_FAILED", error);
    }
  }

  acceptCloseAck(
    wire: Uint8Array,
    expectedSequence: number,
    expectedReason: DirectControlCloseReasonV1
  ): Readonly<{ sequence: number; reason: DirectControlCloseReasonV1 }> {
    const context = this.#establishedControlContext();
    try {
      const decoded = decodeCloseV1(wire, {
        authenticationKey: context.clientToServerKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
        expectedSequence,
        expectedReason
      });
      this.#assertSessionId(decoded.sessionId);
      return Object.freeze({
        sequence: decoded.sequence,
        reason: decoded.reason
      });
    } catch (error) {
      return this.#controlFailure("CLOSE_ACK_VERIFICATION_FAILED", error);
    }
  }

  acceptClose(
    wire: Uint8Array,
    expectedSequence?: number
  ): Readonly<{ sequence: number; reason: DirectControlCloseReasonV1 }> {
    const context = this.#establishedControlContext();
    try {
      const decoded = decodeCloseV1(wire, {
        authenticationKey: context.clientToServerKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
        ...(expectedSequence === undefined ? {} : { expectedSequence })
      });
      this.#assertSessionId(decoded.sessionId);
      return Object.freeze({
        sequence: decoded.sequence,
        reason: decoded.reason
      });
    } catch (error) {
      return this.#controlFailure("CLOSE_VERIFICATION_FAILED", error);
    }
  }

  encodeCloseAck(
    sequence: number,
    reason: DirectControlCloseReasonV1
  ): Buffer {
    const context = this.#establishedControlContext();
    try {
      return encodeCloseV1({
        messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
        sessionId: context.sessionId,
        sequence,
        reason,
        authenticationKey: context.serverToClientKey
      });
    } catch (error) {
      return this.#controlFailure("CLOSE_ACK_ENCODING_FAILED", error);
    }
  }

  exportReliableChannelMaterial(): Readonly<DirectControlReliableChannelMaterialV1> {
    const context = this.#establishedControlContext();
    const clientToServer = deriveReliableChannelDirectionMaterialV1(
      context.clientToServerKey
    );
    try {
      const serverToClient = deriveReliableChannelDirectionMaterialV1(
        context.serverToClientKey
      );
      return Object.freeze({
        clientToServer,
        serverToClient
      });
    } catch (error) {
      clientToServer.key.fill(0);
      clientToServer.noncePrefix.fill(0);
      throw error;
    }
  }

  #establishedControlContext(): Readonly<{
    sessionId: string;
    clientToServerKey: Buffer;
    serverToClientKey: Buffer;
  }> {
    if (
      this.#state !== DIRECT_CONTROL_SERVER_SESSION_STATES.KEY_ESTABLISHED ||
      this.#sessionId === null ||
      this.#clientToServerControlKey === null ||
      this.#serverToClientControlKey === null
    ) {
      this.#failAndDestroy();
      fail(
        "KEY_CONTEXT_UNAVAILABLE",
        "authenticated control requires an established session key"
      );
    }
    return {
      sessionId: this.#sessionId,
      clientToServerKey: this.#clientToServerControlKey,
      serverToClientKey: this.#serverToClientControlKey
    };
  }

  #assertSessionId(value: string): void {
    if (this.#sessionId === null || value !== this.#sessionId) {
      fail(
        "SESSION_BINDING_CONFLICT",
        "authenticated control does not match the active session"
      );
    }
  }

  #controlFailure<T>(code: string, cause: unknown): T {
    this.#failAndDestroy();
    if (cause instanceof DirectControlHandshakeError) throw cause;
    fail(code, "authenticated direct control failed", cause);
  }

  destroy(): void {
    if (this.#state === DIRECT_CONTROL_SERVER_SESSION_STATES.DESTROYED) return;
    this.#wipeAll();
    this.#state = DIRECT_CONTROL_SERVER_SESSION_STATES.DESTROYED;
  }

  clear(): void {
    this.destroy();
  }

  #failAndDestroy(): void {
    this.#wipeAll();
    if (this.#state !== DIRECT_CONTROL_SERVER_SESSION_STATES.DESTROYED) {
      this.#state = DIRECT_CONTROL_SERVER_SESSION_STATES.FAILED;
    }
  }

  #wipeAll(): void {
    this.#serverPublicKeySpki?.fill(0);
    this.#serverConfirmation?.fill(0);
    this.#clientToServerControlKey?.fill(0);
    this.#serverToClientControlKey?.fill(0);
    this.#clientConfirmationKey?.fill(0);
    this.#serverConfirmationKey?.fill(0);
    this.#transcriptHash?.fill(0);
    this.#acceptedConfirmationHash?.fill(0);
    this.#serverPublicKeySpki = null;
    this.#serverConfirmation = null;
    this.#clientToServerControlKey = null;
    this.#serverToClientControlKey = null;
    this.#clientConfirmationKey = null;
    this.#serverConfirmationKey = null;
    this.#transcriptHash = null;
    this.#acceptedConfirmationHash = null;
    this.#sessionId = null;
  }

  snapshot(): Readonly<{
    state: DirectControlServerSessionState;
    keyEstablished: boolean;
    controlKeysReady: boolean;
    retainedSecretBufferCount: number;
  }> {
    const retainedSecretBufferCount = [
      this.#clientToServerControlKey,
      this.#serverToClientControlKey,
      this.#clientConfirmationKey,
      this.#serverConfirmationKey
    ].filter((value) => value !== null).length;
    return Object.freeze({
      state: this.#state,
      keyEstablished:
        this.#state === DIRECT_CONTROL_SERVER_SESSION_STATES.KEY_ESTABLISHED,
      controlKeysReady:
        this.#clientToServerControlKey !== null &&
        this.#serverToClientControlKey !== null,
      retainedSecretBufferCount
    });
  }
}

export class DirectControlHandshakeV1 {
  readonly #registry: AuthorizedDeviceControlKeyPortV1;
  readonly #keyAgreement: X25519KeyAgreementPortV1;

  constructor(
    registry: AuthorizedDeviceControlKeyPortV1,
    options: DirectControlHandshakeOptionsV1 = {}
  ) {
    this.#registry = registry;
    this.#keyAgreement = options.keyAgreement ?? defaultX25519KeyAgreement;
  }

  async acceptClientShare(
    input: AcceptClientShareInputV1
  ): Promise<
    Readonly<{
      context: DirectControlServerSessionV1;
      response: Buffer;
    }>
  > {
    let decoded: ReturnType<typeof decodeClientKeyShareV1> | null = null;
    let context: DirectControlServerSessionV1 | null = null;
    let share: Readonly<DirectControlServerKeyShareV1> | null = null;
    try {
      decoded = decodeClientKeyShareV1(input.wire);
      if (
        decoded.sessionId !== input.sessionId ||
        input.binding.clientHello.sessionId !== input.sessionId ||
        input.binding.serverHello.sessionId !== input.sessionId
      ) {
        fail(
          "SESSION_BINDING_CONFLICT",
          "client key share does not match the authenticated session"
        );
      }
      context = await this.#begin({
        binding: input.binding,
        clientPublicKeySpki: decoded.publicKeySpki,
        clientBinder: decoded.clientBinder
      });
      share = context.serverKeyShare();
      const response = encodeServerKeyShareV1({
        sessionId: input.sessionId,
        publicKeySpki: share.publicKeySpki,
        confirmation: share.confirmation
      });
      const result = Object.freeze({ context, response });
      context = null;
      return result;
    } catch (error) {
      context?.clear();
      if (error instanceof DirectControlHandshakeError) throw error;
      fail(
        "CLIENT_KEY_SHARE_REJECTED",
        "client key share wire was rejected",
        error
      );
    } finally {
      decoded?.publicKeySpki.fill(0);
      decoded?.clientBinder.fill(0);
      share?.publicKeySpki.fill(0);
      share?.confirmation.fill(0);
    }
    fail("CLIENT_KEY_SHARE_UNREACHABLE", "client key share produced no result");
  }

  acceptClientConfirm(
    context: DirectControlServerSessionV1,
    wire: Uint8Array
  ): ReturnType<DirectControlServerSessionV1["snapshot"]> {
    context.acceptClientConfirmationWire(wire);
    return context.snapshot();
  }

  async #begin(
    input: BeginDirectControlHandshakeInputV1
  ): Promise<DirectControlServerSessionV1> {
    const clientSpki = exactBuffer(
      input.clientPublicKeySpki,
      DIRECT_CONTROL_V1_X25519_SPKI_BYTES,
      "INVALID_CLIENT_X25519_KEY",
      "client public key"
    );
    const clientBinder = exactBuffer(
      input.clientBinder,
      DIRECT_CONTROL_V1_AUTH_BYTES,
      "INVALID_CLIENT_KEY_BINDER",
      "client key binder"
    );
    let clientBinderMessage: Buffer | null = null;
    let sessionBinderMessage: Buffer | null = null;
    let sessionKeyBinder: Buffer | null = null;
    let transcriptHash: Buffer | null = null;
    let sharedSecret: Buffer | null = null;
    let serverSpki: Buffer | null = null;
    let serverConfirmation: Buffer | null = null;
    let clientToServerControlKey: Buffer | null = null;
    let serverToClientControlKey: Buffer | null = null;
    let clientConfirmationKey: Buffer | null = null;
    let serverConfirmationKey: Buffer | null = null;

    try {
      clientBinderMessage = buildClientKeyShareBinderMessageV1(
        input.binding,
        clientSpki
      );
      let clientBinderVerified: boolean;
      try {
        clientBinderVerified = await this.#registry.verifyAuthorizedDeviceMac({
          nodeId: input.binding.clientHello.nodeId,
          certificateId: input.binding.deviceCertificateId,
          message: clientBinderMessage,
          proof: clientBinder
        });
      } catch (error) {
        fail(
          "DEVICE_IDENTITY_REJECTED",
          "authorized client key share could not be verified",
          error
        );
      }
      if (!clientBinderVerified) {
        fail(
          "CLIENT_KEY_BINDER_INVALID",
          "client key share binder is invalid"
        );
      }

      const clientPublicKey = canonicalX25519PublicKey(
        this.#keyAgreement,
        clientSpki
      );
      let serverKeyPair: Readonly<{
        publicKey: KeyObject;
        privateKey: KeyObject;
      }>;
      try {
        serverKeyPair = this.#keyAgreement.generateKeyPair();
        if (
          serverKeyPair.publicKey.asymmetricKeyType !== "x25519" ||
          serverKeyPair.privateKey.asymmetricKeyType !== "x25519"
        ) {
          fail("KEY_AGREEMENT_FAILED", "generated key pair is not X25519");
        }
        serverSpki = this.#keyAgreement.exportPublicKey(serverKeyPair.publicKey);
        if (serverSpki.byteLength !== DIRECT_CONTROL_V1_X25519_SPKI_BYTES) {
          fail(
            "KEY_AGREEMENT_FAILED",
            "generated X25519 public key has an invalid encoding"
          );
        }
        sharedSecret = this.#keyAgreement.deriveSecret(
          serverKeyPair.privateKey,
          clientPublicKey
        );
      } catch (error) {
        if (error instanceof DirectControlHandshakeError) throw error;
        fail("KEY_AGREEMENT_FAILED", "X25519 key agreement failed", error);
      }
      if (
        sharedSecret.byteLength !== DIRECT_CONTROL_V1_AUTH_BYTES ||
        sharedSecret.every((byte) => byte === 0)
      ) {
        fail("KEY_AGREEMENT_FAILED", "X25519 produced an invalid shared secret");
      }

      sessionBinderMessage = buildSessionKeyBinderMessageV1(
        input.binding,
        clientSpki,
        clientBinder,
        serverSpki
      );
      try {
        sessionKeyBinder = await this.#registry.createAuthorizedDeviceMac({
          nodeId: input.binding.clientHello.nodeId,
          certificateId: input.binding.deviceCertificateId,
          message: sessionBinderMessage
        });
      } catch (error) {
        fail(
          "SERVER_KEY_BINDER_FAILED",
          "server session-key binder could not be created",
          error
        );
      }
      if (sessionKeyBinder.byteLength !== DIRECT_CONTROL_V1_AUTH_BYTES) {
        fail(
          "SERVER_KEY_BINDER_FAILED",
          "server session-key binder has an invalid length"
        );
      }
      transcriptHash = buildSessionTranscriptHashV1(
        input.binding,
        clientSpki,
        clientBinder,
        serverSpki
      );
      const keys = deriveDirectControlKeysV1({
        sharedSecret,
        sessionKeyBinder,
        transcriptHash
      });
      try {
        clientToServerControlKey = safeKeyCopy(
          keys.clientToServerControlKey,
          "clientToServerControlKey"
        );
        serverToClientControlKey = safeKeyCopy(
          keys.serverToClientControlKey,
          "serverToClientControlKey"
        );
        clientConfirmationKey = safeKeyCopy(
          keys.clientConfirmationKey,
          "clientConfirmationKey"
        );
        serverConfirmationKey = safeKeyCopy(
          keys.serverConfirmationKey,
          "serverConfirmationKey"
        );
      } finally {
        wipe(keys.clientToServerControlKey);
        wipe(keys.serverToClientControlKey);
        wipe(keys.clientConfirmationKey);
        wipe(keys.serverConfirmationKey);
      }
      serverConfirmation = createServerKeyConfirmationV1({
        serverConfirmationKey,
        transcriptHash
      });
      if (serverConfirmation.byteLength !== DIRECT_CONTROL_V1_AUTH_BYTES) {
        fail(
          "SERVER_KEY_CONFIRMATION_FAILED",
          "server key confirmation has an invalid length"
        );
      }

      const session = new DirectControlServerSessionV1({
        sessionId: input.binding.clientHello.sessionId,
        serverPublicKeySpki: serverSpki,
        serverConfirmation,
        clientToServerControlKey,
        serverToClientControlKey,
        clientConfirmationKey,
        serverConfirmationKey,
        transcriptHash
      });
      serverSpki = null;
      serverConfirmation = null;
      clientToServerControlKey = null;
      serverToClientControlKey = null;
      clientConfirmationKey = null;
      serverConfirmationKey = null;
      transcriptHash = null;
      return session;
    } catch (error) {
      if (error instanceof DirectControlHandshakeError) throw error;
      fail(
        "DIRECT_CONTROL_HANDSHAKE_FAILED",
        "direct-control key establishment failed",
        error
      );
    } finally {
      clientSpki.fill(0);
      clientBinder.fill(0);
      clientBinderMessage?.fill(0);
      sessionBinderMessage?.fill(0);
      sessionKeyBinder?.fill(0);
      transcriptHash?.fill(0);
      sharedSecret?.fill(0);
      serverSpki?.fill(0);
      serverConfirmation?.fill(0);
      clientToServerControlKey?.fill(0);
      serverToClientControlKey?.fill(0);
      clientConfirmationKey?.fill(0);
      serverConfirmationKey?.fill(0);
    }
    fail(
      "DIRECT_CONTROL_HANDSHAKE_UNREACHABLE",
      "direct-control handshake produced no result"
    );
  }
}
