export const HELLO_V1_PROTOCOL_VERSION: 1;
export const HELLO_V1_SESSION_ID_BYTES: 16;
export const HELLO_V1_NONCE_BYTES: 16;
export const HELLO_V1_WIRE_BYTES: 51;
export const HELLO_V1_ATT_HEADER_BYTES: 3;
export const HELLO_V1_MINIMUM_MTU: 54;
export const HELLO_V1_MAX_CAPABILITIES: 127;
export const HELLO_V1_NODE_ID_PATTERN_SOURCE: string;
export const HELLO_V1_NONCE_PATTERN_SOURCE: string;

export interface HelloV1 {
  readonly protocolVersion: 1;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly bootId: number;
  readonly capabilities: number;
  readonly nonce: string;
}

export class HelloV1Error extends Error {
  readonly code: string;
}

export function normalizeHelloV1(value: unknown): Readonly<HelloV1>;
export function encodeHelloV1(value: HelloV1): Buffer;
export function decodeHelloV1(value: Uint8Array): Readonly<HelloV1>;
export function generateHelloSessionIdV1(
  randomBytes: (length: number) => Uint8Array
): string;
export function generateHelloNonceV1(
  randomBytes: (length: number) => Uint8Array
): string;
