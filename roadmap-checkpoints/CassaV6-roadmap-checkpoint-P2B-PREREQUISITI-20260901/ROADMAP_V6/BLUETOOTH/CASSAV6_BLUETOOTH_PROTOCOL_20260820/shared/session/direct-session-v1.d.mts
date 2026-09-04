export const DIRECT_SESSION_PROTOCOL_VERSION: 1;
export const MINIMUM_GATT_MTU: 23;
export const MAXIMUM_GATT_MTU: 517;
export const DEFAULT_PREFERRED_GATT_MTU: 247;
export const DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE: 3;
export const MAX_HEARTBEAT_SEQUENCE: number;
export const DIRECT_SESSION_ID_PATTERN_SOURCE:
  "^[A-Za-z0-9_-]{21}[AQgw]$";

export const DIRECT_SESSION_ROLES: Readonly<{
  ANDROID_CLIENT: "android-client";
  RASPBERRY_SERVER: "raspberry-server";
}>;

export const DIRECT_SESSION_STATES: Readonly<{
  IDLE: "IDLE";
  GATT_CONNECTED: "GATT_CONNECTED";
  SERVICES_DISCOVERED: "SERVICES_DISCOVERED";
  MTU_NEGOTIATED: "MTU_NEGOTIATED";
  HELLO_EXCHANGED: "HELLO_EXCHANGED";
  AUTHENTICATING: "AUTHENTICATING";
  AUTHENTICATED: "AUTHENTICATED";
  KEY_ESTABLISHED: "KEY_ESTABLISHED";
  ACTIVE: "ACTIVE";
  CLOSING: "CLOSING";
  CLOSED: "CLOSED";
  FAILED: "FAILED";
}>;

export const DIRECT_SESSION_EVENTS: Readonly<{
  GATT_CONNECTED: "GATT_CONNECTED";
  SERVICES_DISCOVERED: "SERVICES_DISCOVERED";
  MTU_NEGOTIATED: "MTU_NEGOTIATED";
  HELLO_ACCEPTED: "HELLO_ACCEPTED";
  AUTH_STARTED: "AUTH_STARTED";
  AUTH_VERIFIED: "AUTH_VERIFIED";
  SESSION_KEY_ESTABLISHED: "SESSION_KEY_ESTABLISHED";
  HEARTBEAT_STARTED: "HEARTBEAT_STARTED";
  PING_SENT: "PING_SENT";
  PONG_RECEIVED: "PONG_RECEIVED";
  HEARTBEAT_MISSED: "HEARTBEAT_MISSED";
  CLOSE_REQUESTED: "CLOSE_REQUESTED";
  TRANSPORT_CLOSED: "TRANSPORT_CLOSED";
  FAIL: "FAIL";
  RESET: "RESET";
}>;

export const DIRECT_SESSION_DISPOSITIONS: Readonly<{
  TRANSITIONED: "TRANSITIONED";
  UPDATED: "UPDATED";
  IDEMPOTENT: "IDEMPOTENT";
  FAILED_CLOSED: "FAILED_CLOSED";
  REJECTED: "REJECTED";
}>;

export type DirectSessionRoleV1 =
  (typeof DIRECT_SESSION_ROLES)[keyof typeof DIRECT_SESSION_ROLES];
export type DirectSessionStateV1 =
  (typeof DIRECT_SESSION_STATES)[keyof typeof DIRECT_SESSION_STATES];
export type DirectSessionEventTypeV1 =
  (typeof DIRECT_SESSION_EVENTS)[keyof typeof DIRECT_SESSION_EVENTS];
export type DirectSessionDispositionV1 =
  (typeof DIRECT_SESSION_DISPOSITIONS)[keyof typeof DIRECT_SESSION_DISPOSITIONS];

export type DirectSessionEventV1 =
  | { readonly type: "GATT_CONNECTED" }
  | { readonly type: "SERVICES_DISCOVERED" }
  | { readonly type: "MTU_NEGOTIATED"; readonly mtu: number }
  | {
      readonly type: "HELLO_ACCEPTED";
      readonly protocolVersion: 1;
      readonly sessionId: string;
    }
  | { readonly type: "AUTH_STARTED" }
  | { readonly type: "AUTH_VERIFIED" }
  | { readonly type: "SESSION_KEY_ESTABLISHED" }
  | { readonly type: "HEARTBEAT_STARTED" }
  | { readonly type: "PING_SENT"; readonly sequence: number }
  | { readonly type: "PONG_RECEIVED"; readonly sequence: number }
  | { readonly type: "HEARTBEAT_MISSED" }
  | { readonly type: "CLOSE_REQUESTED"; readonly reason?: string }
  | { readonly type: "TRANSPORT_CLOSED"; readonly reason?: string }
  | { readonly type: "FAIL"; readonly code: string }
  | { readonly type: "RESET" };

export interface DirectSessionTransitionV1 {
  readonly event: DirectSessionEventTypeV1;
  readonly from: DirectSessionStateV1;
  readonly to: DirectSessionStateV1;
  readonly disposition: DirectSessionDispositionV1;
  readonly changed: boolean;
  readonly failureCode?: string;
  readonly closeReason?: string;
  readonly heartbeatMisses?: number;
}

export interface DirectSessionSnapshotV1 {
  readonly protocolVersion: 1;
  readonly role: DirectSessionRoleV1;
  readonly state: DirectSessionStateV1;
  readonly sessionBound: boolean;
  readonly negotiatedMtu: number | null;
  readonly preferredMtu: number;
  readonly active: boolean;
  readonly heartbeatMisses: number;
  readonly heartbeatMissesBeforeClose: number;
  readonly pingPending: boolean;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  readonly activeSinceMs: number | null;
  readonly closedAtMs: number | null;
  readonly closeReason: string | null;
  readonly failureCode: string | null;
  readonly transitionCount: number;
  readonly updatedEventCount: number;
  readonly idempotentEventCount: number;
  readonly rejectedEventCount: number;
}

export interface DirectSessionOptionsV1 {
  readonly role: DirectSessionRoleV1;
  readonly clock?: () => number;
  readonly preferredMtu?: number;
  readonly heartbeatMissesBeforeClose?: number;
}

export class DirectSessionError extends Error {
  readonly code: string;
}

export class DirectSessionV1 {
  constructor(options: DirectSessionOptionsV1);
  readonly state: DirectSessionStateV1;
  readonly role: DirectSessionRoleV1;
  readonly sessionId: string | null;
  dispatch(event: DirectSessionEventV1): DirectSessionTransitionV1;
  snapshot(): Readonly<DirectSessionSnapshotV1>;
}
