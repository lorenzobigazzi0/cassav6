export interface PeerTrustDirectoryDeviceV1 {
  readonly nodeId: string;
  readonly certificateId: string;
  readonly publicKeyAlgorithm: "Ed25519" | "EC-P256";
  readonly publicKeySpkiDerBase64: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly currentAlias: string | null;
  readonly nextAlias: string | null;
}

export interface PeerTrustDirectoryV1 {
  readonly schemaVersion: 1;
  readonly kind: "cassav5bt.bluetooth.peer-trust-directory";
  readonly issuerId: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly aliasEpoch: number;
  readonly authorityKeyId: string;
  readonly signatureAlgorithm: "ECDSA-P256-SHA256-P1363";
  readonly devices: readonly PeerTrustDirectoryDeviceV1[];
  readonly signatureBase64: string;
}

export class PeerTrustDirectoryV1Error extends Error {
  readonly code: string;
}
export const PEER_TRUST_ID_CONTEXT: string;
export const PEER_TRUST_ID_PATTERN: RegExp;
export function derivePeerTrustIdV1(
  nodeId: string,
  certificateId: string,
  publicKeyAlgorithm: "Ed25519" | "EC-P256",
  publicKeySpkiDer: Uint8Array
): string;
export function isPeerTrustIdV1(value: unknown): boolean;

export function canonicalPeerTrustDirectoryPayloadV1(value: unknown): string;
export function peerTrustDirectorySigningMessageV1(value: unknown): Buffer;
export function peerTrustAuthorityKeyIdV1(publicKey: unknown): string;
export function signPeerTrustDirectoryV1(
  value: unknown,
  privateKey: unknown
): PeerTrustDirectoryV1;
export function encodePeerTrustDirectoryV1(value: unknown): Buffer;
export function verifyPeerTrustDirectoryV1(
  wire: Uint8Array,
  publicKey: unknown,
  options?: { readonly now?: Date | string | number; readonly minimumRevision?: number }
): PeerTrustDirectoryV1;
