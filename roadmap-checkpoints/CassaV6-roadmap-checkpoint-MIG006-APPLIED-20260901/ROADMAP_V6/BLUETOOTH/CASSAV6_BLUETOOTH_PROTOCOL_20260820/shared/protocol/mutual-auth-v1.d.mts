import type { HelloV1 } from "./hello-v1.mjs";

export const MUTUAL_AUTH_V1_PROTOCOL_VERSION: 1;
export const MUTUAL_AUTH_V1_SIGNATURE_BYTES: 64;
export const MUTUAL_AUTH_V1_PROOF_BYTES: 32;
export const MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES: 98;
export const MUTUAL_AUTH_V1_SERVER_PROOF_WIRE_BYTES: 66;
export const MUTUAL_AUTH_V1_FINISH_WIRE_BYTES: 50;
export const MUTUAL_AUTH_V1_ATT_HEADER_BYTES: 3;
export const MUTUAL_AUTH_V1_MINIMUM_MTU: 101;

export const MUTUAL_AUTH_V1_MESSAGE_TYPES: Readonly<{
  CLIENT_PROOF: 1;
  SERVER_PROOF: 2;
  FINISH: 3;
}>;

export interface MutualAuthBindingV1 {
  readonly clientHello: HelloV1;
  readonly serverHello: HelloV1;
  readonly deviceCertificateId: string;
}

export interface AuthClientProofV1 {
  readonly protocolVersion?: 1;
  readonly sessionId: string;
  readonly deviceCertificateId: string;
  readonly signature: Uint8Array;
}

export interface AuthServerProofV1 {
  readonly protocolVersion?: 1;
  readonly sessionId: string;
  readonly deviceCertificateId: string;
  readonly proof: Uint8Array;
}

export interface AuthFinishV1 {
  readonly protocolVersion?: 1;
  readonly sessionId: string;
  readonly proof: Uint8Array;
}

export class MutualAuthV1Error extends Error {
  readonly code: string;
}

export function normalizeMutualAuthBindingV1(
  value: unknown
): Readonly<MutualAuthBindingV1>;
export function buildClientAuthProofMessageV1(
  binding: MutualAuthBindingV1
): Buffer;
export function buildServerAuthProofMessageV1(
  binding: MutualAuthBindingV1,
  clientSignature: Uint8Array
): Buffer;
export function buildAuthFinishProofMessageV1(
  binding: MutualAuthBindingV1,
  clientSignature: Uint8Array,
  serverProof: Uint8Array
): Buffer;
export function encodeAuthClientProofV1(value: AuthClientProofV1): Buffer;
export function decodeAuthClientProofV1(
  value: Uint8Array
): Readonly<Required<AuthClientProofV1>>;
export function encodeAuthServerProofV1(value: AuthServerProofV1): Buffer;
export function decodeAuthServerProofV1(
  value: Uint8Array
): Readonly<Required<AuthServerProofV1>>;
export function encodeAuthFinishV1(value: AuthFinishV1): Buffer;
export function decodeAuthFinishV1(
  value: Uint8Array
): Readonly<Required<AuthFinishV1>>;
