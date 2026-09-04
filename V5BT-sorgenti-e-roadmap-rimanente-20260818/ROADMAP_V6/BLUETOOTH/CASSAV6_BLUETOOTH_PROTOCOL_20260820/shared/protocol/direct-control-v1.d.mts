import type { KeyObject } from "node:crypto";
import type { MutualAuthBindingV1 } from "./mutual-auth-v1.mjs";

export const DIRECT_CONTROL_V1_PROTOCOL_VERSION: 1;
export const DIRECT_CONTROL_V1_SESSION_ID_BYTES: 16;
export const DIRECT_CONTROL_V1_X25519_SPKI_BYTES: 44;
export const DIRECT_CONTROL_V1_AUTH_BYTES: 32;
export const DIRECT_CONTROL_V1_HEADER_BYTES: 18;
export const DIRECT_CONTROL_V1_CLIENT_KEY_SHARE_WIRE_BYTES: 94;
export const DIRECT_CONTROL_V1_SERVER_KEY_SHARE_WIRE_BYTES: 94;
export const DIRECT_CONTROL_V1_CLIENT_KEY_CONFIRM_WIRE_BYTES: 50;
export const DIRECT_CONTROL_V1_HEARTBEAT_WIRE_BYTES: 54;
export const DIRECT_CONTROL_V1_CLOSE_WIRE_BYTES: 55;
export const DIRECT_CONTROL_V1_MINIMUM_MTU: 101;
export const DIRECT_CONTROL_V1_MAX_SEQUENCE: number;
export const DIRECT_CONTROL_V1_X25519_SPKI_PREFIX_HEX:
  "302a300506032b656e032100";

export const DIRECT_CONTROL_V1_MESSAGE_TYPES: Readonly<{
  CLIENT_KEY_SHARE: 4;
  SERVER_KEY_SHARE: 5;
  CLIENT_KEY_CONFIRM: 6;
  PING: 7;
  PONG: 8;
  CLOSE: 9;
  CLOSE_ACK: 10;
}>;

export const DIRECT_CONTROL_V1_CLOSE_REASONS: Readonly<{
  NORMAL: 1;
  HEARTBEAT_TIMEOUT: 2;
  SERVICE_STOP: 3;
  PROTOCOL_ERROR: 4;
}>;

export const DIRECT_CONTROL_V1_CONTEXTS: Readonly<{
  CLIENT_KEY_SHARE: "CASSA_V6-BT-KEY-CLIENT-SHARE-V1\0";
  SESSION_KEY_BINDER: "CASSA_V6-BT-KEY-SALT-V1\0";
  SESSION_TRANSCRIPT: "CASSA_V6-BT-KEY-TRANSCRIPT-V1\0";
  HKDF_INFO: "CASSA_V6-BT-KEYS-V1\0";
  SERVER_CONFIRMATION: "CASSA_V6-BT-KEY-SERVER-CONFIRM-V1\0";
  CLIENT_CONFIRMATION: "CASSA_V6-BT-KEY-CLIENT-CONFIRM-V1\0";
  AUTHENTICATED_CONTROL: "CASSA_V6-BT-CONTROL-V1\0";
}>;

export type DirectControlMessageTypeV1 =
  (typeof DIRECT_CONTROL_V1_MESSAGE_TYPES)[keyof typeof DIRECT_CONTROL_V1_MESSAGE_TYPES];
export type DirectControlHeartbeatTypeV1 = 7 | 8;
export type DirectControlCloseTypeV1 = 9 | 10;
export type DirectControlCloseReasonV1 =
  (typeof DIRECT_CONTROL_V1_CLOSE_REASONS)[keyof typeof DIRECT_CONTROL_V1_CLOSE_REASONS];

export interface ClientKeyShareV1 {
  readonly sessionId: string;
  readonly publicKeySpki: Uint8Array;
  readonly clientBinder: Uint8Array;
}

export interface DecodedClientKeyShareV1 extends ClientKeyShareV1 {
  readonly protocolVersion: 1;
  readonly messageType: 4;
  readonly publicKeySpki: Buffer;
  readonly clientBinder: Buffer;
}

export interface ServerKeyShareV1 {
  readonly sessionId: string;
  readonly publicKeySpki: Uint8Array;
  readonly confirmation: Uint8Array;
}

export interface DecodedServerKeyShareV1 extends ServerKeyShareV1 {
  readonly protocolVersion: 1;
  readonly messageType: 5;
  readonly publicKeySpki: Buffer;
  readonly confirmation: Buffer;
}

export interface ClientKeyConfirmV1 {
  readonly sessionId: string;
  readonly confirmation: Uint8Array;
}

export interface DecodedClientKeyConfirmV1 extends ClientKeyConfirmV1 {
  readonly protocolVersion: 1;
  readonly messageType: 6;
  readonly confirmation: Buffer;
}

export interface HeartbeatV1 {
  readonly messageType: DirectControlHeartbeatTypeV1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly authenticationKey: Uint8Array;
}

export interface DecodedHeartbeatV1 {
  readonly protocolVersion: 1;
  readonly messageType: DirectControlHeartbeatTypeV1;
  readonly sessionId: string;
  readonly sequence: number;
}

export interface HeartbeatDecodeOptionsV1 {
  readonly authenticationKey: Uint8Array;
  readonly expectedMessageType?: DirectControlHeartbeatTypeV1;
  readonly expectedSequence?: number;
}

export interface CloseV1 {
  readonly messageType: DirectControlCloseTypeV1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly reason: DirectControlCloseReasonV1;
  readonly authenticationKey: Uint8Array;
}

export interface DecodedCloseV1 {
  readonly protocolVersion: 1;
  readonly messageType: DirectControlCloseTypeV1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly reason: DirectControlCloseReasonV1;
}

export interface CloseDecodeOptionsV1 {
  readonly authenticationKey: Uint8Array;
  readonly expectedMessageType?: DirectControlCloseTypeV1;
  readonly expectedSequence?: number;
  readonly expectedReason?: DirectControlCloseReasonV1;
}

export interface DirectControlKeysV1 {
  readonly clientToServerControlKey: Buffer;
  readonly serverToClientControlKey: Buffer;
  readonly clientConfirmationKey: Buffer;
  readonly serverConfirmationKey: Buffer;
}

export class DirectControlV1Error extends Error {
  readonly code: string;
}

export function normalizeX25519PublicKeySpkiV1(value: Uint8Array): Buffer;
export function generateX25519KeyPairV1(): Readonly<{
  privateKey: KeyObject;
  publicKeySpki: Buffer;
}>;
export function deriveX25519SharedSecretV1(
  privateKey: KeyObject,
  peerPublicKeySpki: Uint8Array
): Buffer;

export function buildClientKeyShareBinderMessageV1(
  binding: MutualAuthBindingV1,
  clientPublicKeySpki: Uint8Array
): Buffer;
export function buildSessionKeyBinderMessageV1(
  binding: MutualAuthBindingV1,
  clientPublicKeySpki: Uint8Array,
  clientBinder: Uint8Array,
  serverPublicKeySpki: Uint8Array
): Buffer;
export function buildSessionTranscriptHashV1(
  binding: MutualAuthBindingV1,
  clientPublicKeySpki: Uint8Array,
  clientBinder: Uint8Array,
  serverPublicKeySpki: Uint8Array
): Buffer;
export function deriveDirectControlKeysV1(input: {
  readonly sharedSecret: Uint8Array;
  readonly sessionKeyBinder: Uint8Array;
  readonly transcriptHash: Uint8Array;
}): Readonly<DirectControlKeysV1>;
export function clearDirectControlKeysV1(keys: DirectControlKeysV1): void;

export function buildServerKeyConfirmationMessageV1(
  transcriptHash: Uint8Array
): Buffer;
export function createServerKeyConfirmationV1(input: {
  readonly serverConfirmationKey: Uint8Array;
  readonly transcriptHash: Uint8Array;
}): Buffer;
export function verifyServerKeyConfirmationV1(input: {
  readonly serverConfirmationKey: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly confirmation: Uint8Array;
}): boolean;
export function buildClientKeyConfirmationMessageV1(
  transcriptHash: Uint8Array,
  serverConfirmation: Uint8Array
): Buffer;
export function createClientKeyConfirmationV1(input: {
  readonly clientConfirmationKey: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly serverConfirmation: Uint8Array;
}): Buffer;
export function verifyClientKeyConfirmationV1(input: {
  readonly clientConfirmationKey: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly serverConfirmation: Uint8Array;
  readonly confirmation: Uint8Array;
}): boolean;

export function encodeClientKeyShareV1(value: ClientKeyShareV1): Buffer;
export function decodeClientKeyShareV1(
  value: Uint8Array
): Readonly<DecodedClientKeyShareV1>;
export function encodeServerKeyShareV1(value: ServerKeyShareV1): Buffer;
export function decodeServerKeyShareV1(
  value: Uint8Array
): Readonly<DecodedServerKeyShareV1>;
export function encodeClientKeyConfirmV1(value: ClientKeyConfirmV1): Buffer;
export function decodeClientKeyConfirmV1(
  value: Uint8Array
): Readonly<DecodedClientKeyConfirmV1>;
export function encodeHeartbeatV1(value: HeartbeatV1): Buffer;
export function decodeHeartbeatV1(
  value: Uint8Array,
  options: HeartbeatDecodeOptionsV1
): Readonly<DecodedHeartbeatV1>;
export function encodeCloseV1(value: CloseV1): Buffer;
export function decodeCloseV1(
  value: Uint8Array,
  options: CloseDecodeOptionsV1
): Readonly<DecodedCloseV1>;
