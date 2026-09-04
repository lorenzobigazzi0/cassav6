export const DIRECT_SESSION_PROTOCOL_VERSION = 1;
export const MINIMUM_GATT_MTU = 23;
export const MAXIMUM_GATT_MTU = 517;
export const DEFAULT_PREFERRED_GATT_MTU = 247;
export const DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE = 3;
export const MAX_HEARTBEAT_SEQUENCE = 0xffff_ffff;
export const DIRECT_SESSION_ID_PATTERN_SOURCE =
  "^[A-Za-z0-9_-]{21}[AQgw]$";

export const DIRECT_SESSION_ROLES = Object.freeze({
  ANDROID_CLIENT: "android-client",
  RASPBERRY_SERVER: "raspberry-server"
});

export const DIRECT_SESSION_STATES = Object.freeze({
  IDLE: "IDLE",
  GATT_CONNECTED: "GATT_CONNECTED",
  SERVICES_DISCOVERED: "SERVICES_DISCOVERED",
  MTU_NEGOTIATED: "MTU_NEGOTIATED",
  HELLO_EXCHANGED: "HELLO_EXCHANGED",
  AUTHENTICATING: "AUTHENTICATING",
  AUTHENTICATED: "AUTHENTICATED",
  KEY_ESTABLISHED: "KEY_ESTABLISHED",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  CLOSED: "CLOSED",
  FAILED: "FAILED"
});

export const DIRECT_SESSION_EVENTS = Object.freeze({
  GATT_CONNECTED: "GATT_CONNECTED",
  SERVICES_DISCOVERED: "SERVICES_DISCOVERED",
  MTU_NEGOTIATED: "MTU_NEGOTIATED",
  HELLO_ACCEPTED: "HELLO_ACCEPTED",
  AUTH_STARTED: "AUTH_STARTED",
  AUTH_VERIFIED: "AUTH_VERIFIED",
  SESSION_KEY_ESTABLISHED: "SESSION_KEY_ESTABLISHED",
  HEARTBEAT_STARTED: "HEARTBEAT_STARTED",
  PING_SENT: "PING_SENT",
  PONG_RECEIVED: "PONG_RECEIVED",
  HEARTBEAT_MISSED: "HEARTBEAT_MISSED",
  CLOSE_REQUESTED: "CLOSE_REQUESTED",
  TRANSPORT_CLOSED: "TRANSPORT_CLOSED",
  FAIL: "FAIL",
  RESET: "RESET"
});

export const DIRECT_SESSION_DISPOSITIONS = Object.freeze({
  TRANSITIONED: "TRANSITIONED",
  UPDATED: "UPDATED",
  IDEMPOTENT: "IDEMPOTENT",
  FAILED_CLOSED: "FAILED_CLOSED",
  REJECTED: "REJECTED"
});

const SESSION_ID_PATTERN = new RegExp(DIRECT_SESSION_ID_PATTERN_SOURCE);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const TERMINAL_STATES = new Set([
  DIRECT_SESSION_STATES.CLOSED,
  DIRECT_SESSION_STATES.FAILED
]);
const KNOWN_EVENTS = new Set(Object.values(DIRECT_SESSION_EVENTS));

export class DirectSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DirectSessionError";
    this.code = code;
  }
}

function defaultMonotonicClock() {
  const now = globalThis.performance?.now?.();
  if (!Number.isFinite(now)) {
    throw new DirectSessionError(
      "MONOTONIC_CLOCK_UNAVAILABLE",
      "a monotonic clock must be supplied"
    );
  }
  return now;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRole(role) {
  if (!Object.values(DIRECT_SESSION_ROLES).includes(role)) {
    throw new DirectSessionError(
      "INVALID_SESSION_ROLE",
      "role must be android-client or raspberry-server"
    );
  }
}

function validateBoundedInteger(value, name, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    const codeName = name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase();
    throw new DirectSessionError(
      `INVALID_${codeName}`,
      `${name} must be an integer from ${minimum} to ${maximum}`
    );
  }
}

function validateEventFields(event, required, optional = []) {
  const allowed = new Set(["type", ...required, ...optional]);
  const keys = Object.keys(event);
  const unknown = keys.filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(event, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new DirectSessionError(
      "INVALID_EVENT_FIELDS",
      `event ${event.type} has invalid fields`
    );
  }
}

function validateReasonCode(value, fieldName) {
  if (typeof value !== "string" || !REASON_CODE_PATTERN.test(value)) {
    throw new DirectSessionError(
      "INVALID_REASON_CODE",
      `${fieldName} must be an uppercase reason code`
    );
  }
}

function freezeResult(value) {
  return Object.freeze(value);
}

export class DirectSessionV1 {
  #activeSinceMs = null;
  #clock;
  #closeReason = null;
  #closedAtMs = null;
  #createdAtMs;
  #failureCode = null;
  #heartbeatMisses = 0;
  #heartbeatMissesBeforeClose;
  #idempotentEventCount = 0;
  #lastActivityAtMs;
  #lastClockMs = null;
  #negotiatedMtu = null;
  #pendingPingSequence = null;
  #preferredMtu;
  #rejectedEventCount = 0;
  #role;
  #sessionId = null;
  #state = DIRECT_SESSION_STATES.IDLE;
  #transitionCount = 0;
  #updatedEventCount = 0;

  constructor({
    role,
    clock = defaultMonotonicClock,
    preferredMtu = DEFAULT_PREFERRED_GATT_MTU,
    heartbeatMissesBeforeClose =
      DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE
  } = {}) {
    validateRole(role);
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    validateBoundedInteger(
      preferredMtu,
      "preferredMtu",
      MINIMUM_GATT_MTU,
      MAXIMUM_GATT_MTU
    );
    validateBoundedInteger(
      heartbeatMissesBeforeClose,
      "heartbeatMissesBeforeClose",
      1,
      10
    );
    this.#role = role;
    this.#clock = clock;
    this.#preferredMtu = preferredMtu;
    this.#heartbeatMissesBeforeClose = heartbeatMissesBeforeClose;
    this.#createdAtMs = this.#readNow();
    this.#lastActivityAtMs = this.#createdAtMs;
  }

  get state() {
    return this.#state;
  }

  get role() {
    return this.#role;
  }

  get sessionId() {
    return this.#sessionId;
  }

  #readNow() {
    const nowMs = this.#clock();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new DirectSessionError(
        "INVALID_MONOTONIC_CLOCK",
        "monotonic clock must return a finite, non-negative number"
      );
    }
    if (this.#lastClockMs !== null && nowMs < this.#lastClockMs) {
      if (!TERMINAL_STATES.has(this.#state)) {
        this.#state = DIRECT_SESSION_STATES.FAILED;
        this.#failureCode = "MONOTONIC_CLOCK_REGRESSION";
        this.#closedAtMs = this.#lastClockMs;
        this.#transitionCount += 1;
      }
      throw new DirectSessionError(
        "MONOTONIC_CLOCK_REGRESSION",
        `monotonic clock moved backwards from ${this.#lastClockMs} to ${nowMs}`
      );
    }
    this.#lastClockMs = nowMs;
    return nowMs;
  }

  #result(eventType, from, disposition, details = {}) {
    return freezeResult({
      event: eventType,
      from,
      to: this.#state,
      disposition,
      changed: from !== this.#state,
      ...details
    });
  }

  #transition(eventType, nextState, nowMs, details = {}) {
    const from = this.#state;
    this.#state = nextState;
    this.#lastActivityAtMs = nowMs;
    if (from !== nextState) {
      this.#transitionCount += 1;
    }
    return this.#result(
      eventType,
      from,
      from === nextState
        ? DIRECT_SESSION_DISPOSITIONS.IDEMPOTENT
        : DIRECT_SESSION_DISPOSITIONS.TRANSITIONED,
      details
    );
  }

  #updated(eventType, nowMs, details = {}) {
    const from = this.#state;
    this.#lastActivityAtMs = nowMs;
    this.#updatedEventCount += 1;
    return this.#result(
      eventType,
      from,
      DIRECT_SESSION_DISPOSITIONS.UPDATED,
      details
    );
  }

  #idempotent(eventType, details = {}) {
    const from = this.#state;
    this.#idempotentEventCount += 1;
    return this.#result(
      eventType,
      from,
      DIRECT_SESSION_DISPOSITIONS.IDEMPOTENT,
      details
    );
  }

  #failClosed(eventType, nowMs, failureCode) {
    const from = this.#state;
    this.#rejectedEventCount += 1;
    if (TERMINAL_STATES.has(from)) {
      return this.#result(
        eventType,
        from,
        DIRECT_SESSION_DISPOSITIONS.REJECTED,
        { failureCode }
      );
    }
    this.#state = DIRECT_SESSION_STATES.FAILED;
    this.#failureCode = failureCode;
    this.#closedAtMs = nowMs;
    this.#pendingPingSequence = null;
    this.#lastActivityAtMs = nowMs;
    this.#transitionCount += 1;
    return this.#result(
      eventType,
      from,
      DIRECT_SESSION_DISPOSITIONS.FAILED_CLOSED,
      { failureCode }
    );
  }

  #dispatchGattConnected(event, nowMs) {
    validateEventFields(event, []);
    if (this.#state === DIRECT_SESSION_STATES.IDLE) {
      return this.#transition(event.type, DIRECT_SESSION_STATES.GATT_CONNECTED, nowMs);
    }
    if (this.#state === DIRECT_SESSION_STATES.GATT_CONNECTED) {
      return this.#idempotent(event.type);
    }
    return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
  }

  #dispatchServicesDiscovered(event, nowMs) {
    validateEventFields(event, []);
    if (this.#role !== DIRECT_SESSION_ROLES.ANDROID_CLIENT) {
      return this.#failClosed(event.type, nowMs, "ROLE_SEQUENCE_VIOLATION");
    }
    if (this.#state === DIRECT_SESSION_STATES.GATT_CONNECTED) {
      return this.#transition(
        event.type,
        DIRECT_SESSION_STATES.SERVICES_DISCOVERED,
        nowMs
      );
    }
    if (this.#state === DIRECT_SESSION_STATES.SERVICES_DISCOVERED) {
      return this.#idempotent(event.type);
    }
    return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
  }

  #dispatchMtuNegotiated(event, nowMs) {
    validateEventFields(event, ["mtu"]);
    validateBoundedInteger(
      event.mtu,
      "mtu",
      MINIMUM_GATT_MTU,
      MAXIMUM_GATT_MTU
    );
    const requiredState =
      this.#role === DIRECT_SESSION_ROLES.ANDROID_CLIENT
        ? DIRECT_SESSION_STATES.SERVICES_DISCOVERED
        : DIRECT_SESSION_STATES.GATT_CONNECTED;
    if (this.#state === requiredState) {
      this.#negotiatedMtu = event.mtu;
      return this.#transition(
        event.type,
        DIRECT_SESSION_STATES.MTU_NEGOTIATED,
        nowMs
      );
    }
    if (this.#state === DIRECT_SESSION_STATES.MTU_NEGOTIATED) {
      if (this.#negotiatedMtu === event.mtu) {
        return this.#idempotent(event.type);
      }
      return this.#failClosed(event.type, nowMs, "MTU_BINDING_CONFLICT");
    }
    return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
  }

  #dispatchHelloAccepted(event, nowMs) {
    validateEventFields(event, ["protocolVersion", "sessionId"]);
    if (event.protocolVersion !== DIRECT_SESSION_PROTOCOL_VERSION) {
      return this.#failClosed(event.type, nowMs, "PROTOCOL_VERSION_MISMATCH");
    }
    if (
      typeof event.sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(event.sessionId)
    ) {
      return this.#failClosed(event.type, nowMs, "INVALID_SESSION_ID");
    }
    if (this.#state === DIRECT_SESSION_STATES.MTU_NEGOTIATED) {
      this.#sessionId = event.sessionId;
      return this.#transition(
        event.type,
        DIRECT_SESSION_STATES.HELLO_EXCHANGED,
        nowMs
      );
    }
    if (this.#state === DIRECT_SESSION_STATES.HELLO_EXCHANGED) {
      if (this.#sessionId === event.sessionId) {
        return this.#idempotent(event.type);
      }
      return this.#failClosed(event.type, nowMs, "SESSION_BINDING_CONFLICT");
    }
    return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
  }

  #dispatchSimpleTransition(event, nowMs, fromState, toState) {
    validateEventFields(event, []);
    if (this.#state === fromState) {
      return this.#transition(event.type, toState, nowMs);
    }
    if (this.#state === toState) {
      return this.#idempotent(event.type);
    }
    return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
  }

  #dispatchHeartbeatStarted(event, nowMs) {
    validateEventFields(event, []);
    if (this.#state === DIRECT_SESSION_STATES.KEY_ESTABLISHED) {
      this.#activeSinceMs = nowMs;
      this.#heartbeatMisses = 0;
      return this.#transition(event.type, DIRECT_SESSION_STATES.ACTIVE, nowMs);
    }
    if (this.#state === DIRECT_SESSION_STATES.ACTIVE) {
      return this.#idempotent(event.type);
    }
    return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
  }

  #dispatchPingSent(event, nowMs) {
    validateEventFields(event, ["sequence"]);
    validateBoundedInteger(
      event.sequence,
      "heartbeatSequence",
      0,
      MAX_HEARTBEAT_SEQUENCE
    );
    if (this.#state !== DIRECT_SESSION_STATES.ACTIVE) {
      return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
    }
    if (this.#pendingPingSequence === null) {
      this.#pendingPingSequence = event.sequence;
      return this.#updated(event.type, nowMs);
    }
    if (this.#pendingPingSequence === event.sequence) {
      return this.#idempotent(event.type);
    }
    return this.#failClosed(event.type, nowMs, "PING_ALREADY_PENDING");
  }

  #dispatchPongReceived(event, nowMs) {
    validateEventFields(event, ["sequence"]);
    validateBoundedInteger(
      event.sequence,
      "heartbeatSequence",
      0,
      MAX_HEARTBEAT_SEQUENCE
    );
    if (this.#state !== DIRECT_SESSION_STATES.ACTIVE) {
      return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
    }
    if (this.#pendingPingSequence === null) {
      return this.#failClosed(event.type, nowMs, "UNSOLICITED_PONG");
    }
    if (this.#pendingPingSequence !== event.sequence) {
      return this.#failClosed(event.type, nowMs, "PONG_SEQUENCE_MISMATCH");
    }
    this.#pendingPingSequence = null;
    this.#heartbeatMisses = 0;
    return this.#updated(event.type, nowMs);
  }

  #dispatchHeartbeatMissed(event, nowMs) {
    validateEventFields(event, []);
    if (this.#state !== DIRECT_SESSION_STATES.ACTIVE) {
      return this.#failClosed(event.type, nowMs, "INVALID_TRANSITION");
    }
    if (this.#pendingPingSequence === null) {
      return this.#failClosed(event.type, nowMs, "NO_PENDING_HEARTBEAT");
    }
    this.#heartbeatMisses += 1;
    if (this.#heartbeatMisses < this.#heartbeatMissesBeforeClose) {
      return this.#updated(event.type, nowMs, {
        heartbeatMisses: this.#heartbeatMisses
      });
    }
    this.#closeReason = "HEARTBEAT_TIMEOUT";
    this.#pendingPingSequence = null;
    return this.#transition(
      event.type,
      DIRECT_SESSION_STATES.CLOSING,
      nowMs,
      { closeReason: this.#closeReason }
    );
  }

  #dispatchCloseRequested(event, nowMs) {
    validateEventFields(event, [], ["reason"]);
    const reason = event.reason ?? "LOCAL_CLOSE";
    validateReasonCode(reason, "reason");
    if (this.#state === DIRECT_SESSION_STATES.CLOSED) {
      return this.#idempotent(event.type);
    }
    if (this.#state === DIRECT_SESSION_STATES.FAILED) {
      return this.#result(
        event.type,
        this.#state,
        DIRECT_SESSION_DISPOSITIONS.REJECTED,
        { failureCode: this.#failureCode }
      );
    }
    if (this.#state === DIRECT_SESSION_STATES.CLOSING) {
      return this.#idempotent(event.type, {
        closeReason: this.#closeReason
      });
    }
    this.#closeReason = reason;
    this.#pendingPingSequence = null;
    if (this.#state === DIRECT_SESSION_STATES.IDLE) {
      this.#closedAtMs = nowMs;
      return this.#transition(
        event.type,
        DIRECT_SESSION_STATES.CLOSED,
        nowMs,
        { closeReason: reason }
      );
    }
    return this.#transition(
      event.type,
      DIRECT_SESSION_STATES.CLOSING,
      nowMs,
      { closeReason: reason }
    );
  }

  #dispatchTransportClosed(event, nowMs) {
    validateEventFields(event, [], ["reason"]);
    const reason = event.reason ?? this.#closeReason ?? "REMOTE_DISCONNECT";
    validateReasonCode(reason, "reason");
    if (this.#state === DIRECT_SESSION_STATES.CLOSED) {
      return this.#idempotent(event.type);
    }
    if (this.#state === DIRECT_SESSION_STATES.FAILED) {
      return this.#result(
        event.type,
        this.#state,
        DIRECT_SESSION_DISPOSITIONS.REJECTED,
        { failureCode: this.#failureCode }
      );
    }
    this.#closeReason = reason;
    this.#closedAtMs = nowMs;
    this.#pendingPingSequence = null;
    return this.#transition(
      event.type,
      DIRECT_SESSION_STATES.CLOSED,
      nowMs,
      { closeReason: reason }
    );
  }

  #dispatchFail(event, nowMs) {
    validateEventFields(event, ["code"]);
    validateReasonCode(event.code, "code");
    if (this.#state === DIRECT_SESSION_STATES.FAILED) {
      return this.#idempotent(event.type, {
        failureCode: this.#failureCode
      });
    }
    if (this.#state === DIRECT_SESSION_STATES.CLOSED) {
      this.#rejectedEventCount += 1;
      return this.#result(
        event.type,
        this.#state,
        DIRECT_SESSION_DISPOSITIONS.REJECTED,
        { failureCode: event.code }
      );
    }
    return this.#failClosed(event.type, nowMs, event.code);
  }

  #dispatchReset(event, nowMs) {
    validateEventFields(event, []);
    if (this.#state === DIRECT_SESSION_STATES.IDLE) {
      return this.#idempotent(event.type);
    }
    if (!TERMINAL_STATES.has(this.#state)) {
      return this.#failClosed(event.type, nowMs, "RESET_WHILE_ACTIVE");
    }
    const from = this.#state;
    this.#state = DIRECT_SESSION_STATES.IDLE;
    this.#sessionId = null;
    this.#negotiatedMtu = null;
    this.#heartbeatMisses = 0;
    this.#pendingPingSequence = null;
    this.#activeSinceMs = null;
    this.#closedAtMs = null;
    this.#closeReason = null;
    this.#failureCode = null;
    this.#createdAtMs = nowMs;
    this.#lastActivityAtMs = nowMs;
    this.#transitionCount += 1;
    return this.#result(
      event.type,
      from,
      DIRECT_SESSION_DISPOSITIONS.TRANSITIONED
    );
  }

  dispatch(event) {
    if (!isPlainObject(event) || typeof event.type !== "string") {
      throw new DirectSessionError(
        "INVALID_SESSION_EVENT",
        "session event must be a plain object with a type"
      );
    }
    if (!KNOWN_EVENTS.has(event.type)) {
      throw new DirectSessionError(
        "UNKNOWN_SESSION_EVENT",
        `unknown direct session event: ${event.type}`
      );
    }
    const nowMs = this.#readNow();

    switch (event.type) {
      case DIRECT_SESSION_EVENTS.GATT_CONNECTED:
        return this.#dispatchGattConnected(event, nowMs);
      case DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED:
        return this.#dispatchServicesDiscovered(event, nowMs);
      case DIRECT_SESSION_EVENTS.MTU_NEGOTIATED:
        return this.#dispatchMtuNegotiated(event, nowMs);
      case DIRECT_SESSION_EVENTS.HELLO_ACCEPTED:
        return this.#dispatchHelloAccepted(event, nowMs);
      case DIRECT_SESSION_EVENTS.AUTH_STARTED:
        return this.#dispatchSimpleTransition(
          event,
          nowMs,
          DIRECT_SESSION_STATES.HELLO_EXCHANGED,
          DIRECT_SESSION_STATES.AUTHENTICATING
        );
      case DIRECT_SESSION_EVENTS.AUTH_VERIFIED:
        return this.#dispatchSimpleTransition(
          event,
          nowMs,
          DIRECT_SESSION_STATES.AUTHENTICATING,
          DIRECT_SESSION_STATES.AUTHENTICATED
        );
      case DIRECT_SESSION_EVENTS.SESSION_KEY_ESTABLISHED:
        return this.#dispatchSimpleTransition(
          event,
          nowMs,
          DIRECT_SESSION_STATES.AUTHENTICATED,
          DIRECT_SESSION_STATES.KEY_ESTABLISHED
        );
      case DIRECT_SESSION_EVENTS.HEARTBEAT_STARTED:
        return this.#dispatchHeartbeatStarted(event, nowMs);
      case DIRECT_SESSION_EVENTS.PING_SENT:
        return this.#dispatchPingSent(event, nowMs);
      case DIRECT_SESSION_EVENTS.PONG_RECEIVED:
        return this.#dispatchPongReceived(event, nowMs);
      case DIRECT_SESSION_EVENTS.HEARTBEAT_MISSED:
        return this.#dispatchHeartbeatMissed(event, nowMs);
      case DIRECT_SESSION_EVENTS.CLOSE_REQUESTED:
        return this.#dispatchCloseRequested(event, nowMs);
      case DIRECT_SESSION_EVENTS.TRANSPORT_CLOSED:
        return this.#dispatchTransportClosed(event, nowMs);
      case DIRECT_SESSION_EVENTS.FAIL:
        return this.#dispatchFail(event, nowMs);
      case DIRECT_SESSION_EVENTS.RESET:
        return this.#dispatchReset(event, nowMs);
      default:
        throw new DirectSessionError(
          "UNKNOWN_SESSION_EVENT",
          `unknown direct session event: ${event.type}`
        );
    }
  }

  snapshot() {
    return freezeResult({
      protocolVersion: DIRECT_SESSION_PROTOCOL_VERSION,
      role: this.#role,
      state: this.#state,
      sessionBound: this.#sessionId !== null,
      negotiatedMtu: this.#negotiatedMtu,
      preferredMtu: this.#preferredMtu,
      active: this.#state === DIRECT_SESSION_STATES.ACTIVE,
      heartbeatMisses: this.#heartbeatMisses,
      heartbeatMissesBeforeClose: this.#heartbeatMissesBeforeClose,
      pingPending: this.#pendingPingSequence !== null,
      createdAtMs: this.#createdAtMs,
      lastActivityAtMs: this.#lastActivityAtMs,
      activeSinceMs: this.#activeSinceMs,
      closedAtMs: this.#closedAtMs,
      closeReason: this.#closeReason,
      failureCode: this.#failureCode,
      transitionCount: this.#transitionCount,
      updatedEventCount: this.#updatedEventCount,
      idempotentEventCount: this.#idempotentEventCount,
      rejectedEventCount: this.#rejectedEventCount
    });
  }
}
