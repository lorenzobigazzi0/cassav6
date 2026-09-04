export const ANDROID_PEER_AUTH_V2_VERSION: 2;
export const ANDROID_PEER_AUTH_V2_MINIMUM_MTU: 193;
export const ANDROID_PEER_AUTH_V2_CLIENT_INIT_BYTES: 158;
export const ANDROID_PEER_AUTH_V2_SERVER_REPLY_BYTES: 190;
export const ANDROID_PEER_AUTH_V2_CLIENT_FINISH_BYTES: 50;
export const ANDROID_PEER_AUTH_V2_TYPES: Readonly<{
  CLIENT_INIT: 1; SERVER_REPLY: 2; CLIENT_FINISH: 3;
}>;
export class AndroidPeerAuthV2Error extends Error { readonly code: string; }
export function normalizeAndroidPeerAuthBindingV2(value: unknown): unknown;
export function buildAndroidPeerClientSignatureMessageV2(
  binding: unknown, clientEphemeralSpki: Uint8Array
): Buffer;
export function buildAndroidPeerServerSignatureMessageV2(
  binding: unknown,
  clientEphemeralSpki: Uint8Array,
  clientSignature: Uint8Array,
  serverEphemeralSpki: Uint8Array
): Buffer;
export function buildAndroidPeerAuthTranscriptHashV2(
  binding: unknown,
  clientEphemeralSpki: Uint8Array,
  clientSignature: Uint8Array,
  serverEphemeralSpki: Uint8Array,
  serverSignature: Uint8Array
): Buffer;
export function encodeAndroidPeerClientInitV2(value: unknown): Buffer;
export function decodeAndroidPeerClientInitV2(value: Uint8Array): unknown;
export function encodeAndroidPeerServerReplyV2(value: unknown): Buffer;
export function decodeAndroidPeerServerReplyV2(value: Uint8Array): unknown;
export function encodeAndroidPeerClientFinishV2(value: unknown): Buffer;
export function decodeAndroidPeerClientFinishV2(value: Uint8Array): unknown;
export function createAndroidPeerEphemeralV2(): Readonly<{
  privateKey: unknown; publicKeySpki: Buffer;
}>;
export function computeAndroidPeerSharedSecretV2(
  privateKey: unknown, peerPublicKeySpki: Uint8Array
): Buffer;
export function verifyAndroidPeerIdentitySignatureV2(
  algorithm: string,
  publicKeySpki: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean;
export class AndroidPeerAuthKeyScheduleV2 {
  constructor(sharedSecret: Uint8Array, transcriptHash: Uint8Array);
  createServerConfirmation(): Buffer;
  verifyServerConfirmation(value: Uint8Array): boolean;
  createClientConfirmation(serverConfirmation: Uint8Array): Buffer;
  verifyClientConfirmation(
    serverConfirmation: Uint8Array,
    clientConfirmation: Uint8Array
  ): boolean;
  confirmClientFinishTransmitted(): void;
  exportReliableChannelControlKeys(): Readonly<{
    clientToServerControlKey: Buffer;
    serverToClientControlKey: Buffer;
  }>;
  close(): void;
}

