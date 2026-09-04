export const DEVICE_REGISTRY_SCHEMA_VERSION: 2;
export const DEVICE_REGISTRY_KIND: "cassav6.bluetooth.device-registry";
export const ENROLLMENT_QR_VERSION: 2;
export const ALIAS_KEY_BYTES: 32;
export const ENROLLMENT_TOKEN_BYTES: 32;
export const DEFAULT_ENROLLMENT_TTL_SECONDS: 600;
export const MAX_ENROLLMENT_TTL_SECONDS: 86400;
export const ENROLLMENT_RESPONSE_RECOVERY_SECONDS: 600;

export class DeviceRegistryError extends Error {
  readonly code: string;
  readonly registryCommitted: boolean;
}

export interface DeviceRegistryOptions {
  clock?: () => Date | string | number;
  randomBytes?: (length: number) => Uint8Array;
  randomUUID?: () => string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export type DevicePublicKeyAlgorithm = "Ed25519" | "EC-P256";
export type DevicePublicKeyInput = string | Uint8Array;
export type EnrollmentProtocolVersion = 1 | 2;

export interface IssueEnrollmentTokenInput {
  enrollmentEndpointId: string;
  protocolVersion?: EnrollmentProtocolVersion;
  ttlSeconds?: number;
  onTokenReady?: (token: IssuedEnrollmentToken) => void | Promise<void>;
}

export interface EnrollmentQrV1 {
  version: 1;
  enrollmentEndpointId: string;
  token: string;
}

export interface EnrollmentQrV2 {
  version: 2;
  enrollmentEndpointId: string;
  token: string;
}

export interface IssuedEnrollmentToken {
  tokenId: string;
  expiresAt: string;
  qr: EnrollmentQrV1 | EnrollmentQrV2;
  qrPayload: string;
}

export interface EnrollDeviceInput {
  protocolVersion?: EnrollmentProtocolVersion;
  enrollmentEndpointId: string;
  token: string;
  publicKey: DevicePublicKeyInput;
  publicKeyAlgorithm?: DevicePublicKeyAlgorithm;
  nodeId: string;
  onProvisioningReady?: (
    device: ProvisionedDeviceSecrets
  ) => void | Promise<void>;
}

export interface ProvisionedDeviceSecrets {
  protocolVersion: EnrollmentProtocolVersion;
  nodeId: string;
  certificateId: string;
  publicKeyAlgorithm: DevicePublicKeyAlgorithm;
  publicKeySpkiDerBase64: string;
  aliasKeyAlgorithm: "HMAC-SHA256";
  aliasKeyEncoding: "base64url-unpadded";
  aliasKeyBase64url: string;
  enrolledAt: string;
}

export interface PublicAuthorizedDevice {
  nodeId: string;
  certificateId: string;
  publicKeyAlgorithm: DevicePublicKeyAlgorithm;
  publicKeySpkiDerBase64: string;
  enrollmentEndpointId: string;
  enrolledAt: string;
  revokedAt: string | null;
}

export class DeviceRegistryV2 {
  constructor(registryPath: string, options?: DeviceRegistryOptions);
  initialize(): Promise<object>;
  issueEnrollmentToken(input: IssueEnrollmentTokenInput): Promise<IssuedEnrollmentToken>;
  enrollDevice(input: EnrollDeviceInput): Promise<ProvisionedDeviceSecrets>;
  recoverCommittedEnrollment(
    input: EnrollDeviceInput
  ): Promise<ProvisionedDeviceSecrets>;
  revokeDevice(nodeId: string): Promise<object>;
  getAuthorizedDevice(nodeId: string): Promise<PublicAuthorizedDevice>;
  verifyAuthorizedDeviceSignature(input: {
    nodeId: string;
    certificateId: string;
    message: Uint8Array;
    signature: Uint8Array;
  }): Promise<boolean>;
  createAuthorizedDeviceMac(input: {
    nodeId: string;
    certificateId: string;
    message: Uint8Array;
  }): Promise<Buffer>;
  verifyAuthorizedDeviceMac(input: {
    nodeId: string;
    certificateId: string;
    message: Uint8Array;
    proof: Uint8Array;
  }): Promise<boolean>;
  deriveRotatingAliasForNode(input: {
    nodeId: string;
    timestampSeconds: number;
    epochSeconds?: number;
  }): Promise<string>;
  inspect(): Promise<object>;
  verifyIssuedTokenCommit(input: {
    tokenId: string;
    enrollmentEndpointId: string;
    token: string;
    protocolVersion?: EnrollmentProtocolVersion;
  }): Promise<{ recordExists: boolean; matches: boolean }>;
  verifyProvisioningCommit(
    input: ProvisionedDeviceSecrets
  ): Promise<{ recordExists: boolean; matches: boolean }>;
}
