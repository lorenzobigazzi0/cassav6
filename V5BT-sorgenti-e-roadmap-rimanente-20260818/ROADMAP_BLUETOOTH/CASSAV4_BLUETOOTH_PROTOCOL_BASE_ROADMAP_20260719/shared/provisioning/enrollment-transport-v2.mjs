import {
  createPublicKey,
  verify as verifySignature
} from "node:crypto";
import {
  TextDecoder
} from "node:util";

export const ENROLLMENT_PROTOCOL_VERSION = 2;
export const ENROLLMENT_PATH = "/v2/enroll";
export const ENROLLMENT_HEALTH_PATH = "/health";
export const ENROLLMENT_PROOF_CONTEXT =
  "CASSAV5BT-BT-ENROLLMENT-PROOF-V2";
export const MAX_ENROLLMENT_REQUEST_BYTES = 4096;
export const DEFAULT_MAX_CONCURRENT_ENROLLMENTS = 4;

const EXPECTED_REQUEST_FIELDS = new Set([
  "protocolVersion",
  "enrollmentEndpointId",
  "token",
  "nodeId",
  "publicKeyAlgorithm",
  "publicKeySpkiDerBase64",
  "proofAlgorithm",
  "proofSignatureBase64"
]);
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^c5e2_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SPKI_PATTERN = /^[A-Za-z0-9+/]{121}[AQgw]==$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{85}[AQgw]==$/;
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TERMINAL_REGISTRY_REJECTION_CODES = new Set([
  "ENROLLMENT_PROTOCOL_MISMATCH",
  "ENROLLMENT_RECOVERY_EXPIRED",
  "ENROLLMENT_RECOVERY_REJECTED",
  "ENROLLMENT_TOKEN_EXPIRED",
  "ENROLLMENT_TOKEN_REPLAY",
  "INVALID_ENROLLMENT_ENDPOINT",
  "INVALID_ENROLLMENT_TOKEN",
  "INVALID_PUBLIC_KEY",
  "INVALID_PUBLIC_KEY_ALGORITHM",
  "NODE_ALREADY_ENROLLED",
  "PUBLIC_KEY_ALREADY_ENROLLED"
]);

export class EnrollmentTransportError extends Error {
  constructor(code, message, httpStatus = 400, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "EnrollmentTransportError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function transportError(code, message, httpStatus = 400, options = {}) {
  return new EnrollmentTransportError(code, message, httpStatus, options);
}

function skipWhitespace(text, state) {
  while (
    state.index < text.length &&
    (
      text[state.index] === " " ||
      text[state.index] === "\t" ||
      text[state.index] === "\r" ||
      text[state.index] === "\n"
    )
  ) {
    state.index += 1;
  }
}

function parseJsonStringToken(text, state) {
  if (text[state.index] !== "\"") {
    throw transportError("INVALID_JSON", "Expected a JSON string");
  }
  const start = state.index;
  state.index += 1;
  while (state.index < text.length) {
    const character = text[state.index];
    if (character === "\"") {
      state.index += 1;
      const token = text.slice(start, state.index);
      try {
        const value = JSON.parse(token);
        if (typeof value !== "string") {
          throw new Error("not a string");
        }
        return value;
      } catch (error) {
        throw transportError(
          "INVALID_JSON",
          "Invalid JSON string",
          400,
          { cause: error }
        );
      }
    }
    if (character === "\\") {
      state.index += 1;
      if (state.index >= text.length) {
        break;
      }
      if (text[state.index] === "u") {
        const hex = text.slice(state.index + 1, state.index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw transportError("INVALID_JSON", "Invalid JSON unicode escape");
        }
        state.index += 5;
        continue;
      }
      if (!"\"\\/bfnrt".includes(text[state.index])) {
        throw transportError("INVALID_JSON", "Invalid JSON escape");
      }
      state.index += 1;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      throw transportError("INVALID_JSON", "Unescaped JSON control character");
    }
    state.index += 1;
  }
  throw transportError("INVALID_JSON", "Unterminated JSON string");
}

function parseJsonNumberToken(text, state) {
  const match = text.slice(state.index).match(
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/
  );
  if (match === null) {
    throw transportError(
      "INVALID_JSON_TYPE",
      "Enrollment fields must be strings or numbers"
    );
  }
  state.index += match[0].length;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    throw transportError("INVALID_JSON", "JSON number is not finite");
  }
  return value;
}

/**
 * Parses the deliberately flat enrollment object while retaining duplicate-key
 * detection. JSON.parse alone cannot distinguish a duplicate from an overwrite.
 */
export function parseEnrollmentRequestJson(rawBody) {
  let body = rawBody;
  if (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array) {
    try {
      body = UTF8_DECODER.decode(rawBody);
    } catch (error) {
      throw transportError(
        "INVALID_JSON",
        "Enrollment body must be valid UTF-8 JSON",
        400,
        { cause: error }
      );
    }
  }
  if (typeof body !== "string") {
    throw transportError("INVALID_JSON", "Enrollment body must be UTF-8 JSON");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_ENROLLMENT_REQUEST_BYTES) {
    throw transportError(
      "REQUEST_TOO_LARGE",
      "Enrollment request exceeds the byte limit",
      413
    );
  }

  const state = { index: 0 };
  const result = Object.create(null);
  const seen = new Set();
  let objectClosed = false;
  skipWhitespace(body, state);
  if (body[state.index] !== "{") {
    throw transportError("INVALID_JSON", "Enrollment body must be a JSON object");
  }
  state.index += 1;
  skipWhitespace(body, state);
  if (body[state.index] === "}") {
    state.index += 1;
    objectClosed = true;
  } else {
    while (state.index < body.length) {
      const key = parseJsonStringToken(body, state);
      if (seen.has(key)) {
        throw transportError(
          "DUPLICATE_JSON_KEY",
          "Enrollment request contains a duplicate JSON key"
        );
      }
      seen.add(key);
      skipWhitespace(body, state);
      if (body[state.index] !== ":") {
        throw transportError("INVALID_JSON", "Expected ':' after JSON key");
      }
      state.index += 1;
      skipWhitespace(body, state);
      const value =
        body[state.index] === "\""
          ? parseJsonStringToken(body, state)
          : parseJsonNumberToken(body, state);
      result[key] = value;
      skipWhitespace(body, state);
      if (body[state.index] === "}") {
        state.index += 1;
        objectClosed = true;
        break;
      }
      if (body[state.index] !== ",") {
        throw transportError("INVALID_JSON", "Expected ',' or '}'");
      }
      state.index += 1;
      skipWhitespace(body, state);
    }
  }
  if (!objectClosed) {
    throw transportError("INVALID_JSON", "Enrollment JSON object is not closed");
  }
  skipWhitespace(body, state);
  if (state.index !== body.length) {
    throw transportError("INVALID_JSON", "Trailing JSON content is forbidden");
  }
  return result;
}

export function isCanonicalEnrollmentEndpointId(value) {
  return typeof value === "string" && ENDPOINT_ID_PATTERN.test(value);
}

function decodeCanonicalBase64(value, expectedBytes, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw transportError("INVALID_REQUEST", `${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString("base64") !== value
  ) {
    throw transportError("INVALID_REQUEST", `${field} has invalid encoding`);
  }
  return decoded;
}

export function buildEnrollmentProofBytes(request) {
  return Buffer.from(
    [
      ENROLLMENT_PROOF_CONTEXT,
      String(request.protocolVersion),
      request.enrollmentEndpointId,
      request.token,
      request.nodeId,
      request.publicKeyAlgorithm,
      request.proofAlgorithm,
      request.publicKeySpkiDerBase64
    ].join("\u0000"),
    "utf8"
  );
}

function p1363Scalar(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function assertCanonicalP256Signature(signature) {
  const r = p1363Scalar(signature.subarray(0, 32));
  const s = p1363Scalar(signature.subarray(32, 64));
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s > P256_HALF_ORDER) {
    throw transportError(
      "INVALID_REQUEST",
      "proofSignatureBase64 must contain a canonical low-S P1363 signature"
    );
  }
}

export function validateEnrollmentRequest(request, expectedEndpointId) {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== EXPECTED_REQUEST_FIELDS.size ||
    Object.keys(request).some((field) => !EXPECTED_REQUEST_FIELDS.has(field))
  ) {
    throw transportError(
      "INVALID_REQUEST_STRUCTURE",
      "Enrollment request fields do not match protocol v2"
    );
  }
  if (
    !isCanonicalEnrollmentEndpointId(expectedEndpointId)
  ) {
    throw transportError(
      "SERVER_CONFIGURATION_INVALID",
      "Enrollment endpoint identifier is invalid",
      503
    );
  }
  if (
    request.protocolVersion !== ENROLLMENT_PROTOCOL_VERSION ||
    !isCanonicalEnrollmentEndpointId(request.enrollmentEndpointId) ||
    request.enrollmentEndpointId !== expectedEndpointId ||
    typeof request.token !== "string" ||
    !TOKEN_PATTERN.test(request.token) ||
    Buffer.from(request.token.slice(5), "base64url").toString("base64url") !==
      request.token.slice(5) ||
    typeof request.nodeId !== "string" ||
    !UUID_PATTERN.test(request.nodeId) ||
    request.publicKeyAlgorithm !== "EC-P256" ||
    request.proofAlgorithm !== "ECDSA-P256-SHA256-P1363"
  ) {
    throw transportError(
      "INVALID_REQUEST",
      "Enrollment request violates protocol v2"
    );
  }

  const publicKeyDer = decodeCanonicalBase64(
    request.publicKeySpkiDerBase64,
    91,
    SPKI_PATTERN,
    "publicKeySpkiDerBase64"
  );
  const signature = decodeCanonicalBase64(
    request.proofSignatureBase64,
    64,
    SIGNATURE_PATTERN,
    "proofSignatureBase64"
  );
  assertCanonicalP256Signature(signature);
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki"
    });
  } catch (error) {
    throw transportError(
      "INVALID_PUBLIC_KEY",
      "Enrollment public key is invalid",
      400,
      { cause: error }
    );
  }
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    !Buffer.from(
      publicKey.export({ format: "der", type: "spki" })
    ).equals(publicKeyDer)
  ) {
    throw transportError(
      "INVALID_PUBLIC_KEY",
      "Enrollment public key must be canonical P-256 SPKI"
    );
  }
  if (
    !verifySignature(
      "sha256",
      buildEnrollmentProofBytes(request),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature
    )
  ) {
    throw transportError(
      "INVALID_ENROLLMENT_PROOF",
      "Enrollment proof is invalid",
      403
    );
  }
  return request;
}

export async function processEnrollmentRequest({
  rawBody,
  expectedEndpointId,
  registry
}) {
  const request = validateEnrollmentRequest(
    parseEnrollmentRequestJson(rawBody),
    expectedEndpointId
  );
  if (registry === null || typeof registry?.enrollDevice !== "function") {
    throw transportError(
      "SERVER_CONFIGURATION_INVALID",
      "Enrollment registry is unavailable",
      503
    );
  }
  try {
    return await registry.enrollDevice({
      protocolVersion: ENROLLMENT_PROTOCOL_VERSION,
      enrollmentEndpointId: request.enrollmentEndpointId,
      token: request.token,
      nodeId: request.nodeId,
      publicKey: Buffer.from(request.publicKeySpkiDerBase64, "base64"),
      publicKeyAlgorithm: request.publicKeyAlgorithm
    });
  } catch (error) {
    let recoveryError;
    if (typeof registry.recoverCommittedEnrollment === "function") {
      try {
        return await registry.recoverCommittedEnrollment({
          protocolVersion: ENROLLMENT_PROTOCOL_VERSION,
          enrollmentEndpointId: request.enrollmentEndpointId,
          token: request.token,
          nodeId: request.nodeId,
          publicKey: Buffer.from(request.publicKeySpkiDerBase64, "base64"),
          publicKeyAlgorithm: request.publicKeyAlgorithm
        });
      } catch (candidateRecoveryError) {
        recoveryError = candidateRecoveryError;
        // Only terminal-versus-retryable state is exposed below.
      }
    }
    const originalIsTerminal =
      TERMINAL_REGISTRY_REJECTION_CODES.has(error?.code);
    const recoveryIsTerminal =
      recoveryError === undefined ||
      TERMINAL_REGISTRY_REJECTION_CODES.has(recoveryError?.code);
    if (!originalIsTerminal || !recoveryIsTerminal) {
      throw transportError(
        "ENROLLMENT_RETRYABLE",
        "Enrollment state is temporarily unavailable",
        503,
        { cause: recoveryError ?? error }
      );
    }
    throw transportError(
      "ENROLLMENT_REJECTED",
      "Enrollment was rejected",
      403,
      { cause: error }
    );
  }
}

function writeJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ENROLLMENT_REQUEST_BYTES) {
      throw transportError(
        "REQUEST_TOO_LARGE",
        "Enrollment request exceeds the byte limit",
        413
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function createEnrollmentRequestHandler({
  expectedEndpointId,
  registry,
  maxConcurrentEnrollments = DEFAULT_MAX_CONCURRENT_ENROLLMENTS,
  onRejected = null
}) {
  if (
    !Number.isSafeInteger(maxConcurrentEnrollments) ||
    maxConcurrentEnrollments < 1 ||
    maxConcurrentEnrollments > 32
  ) {
    throw new TypeError("maxConcurrentEnrollments must be an integer from 1 to 32");
  }
  if (onRejected !== null && typeof onRejected !== "function") {
    throw new TypeError("onRejected must be a function or null");
  }
  let activeEnrollments = 0;
  return async (request, response) => {
    try {
      if (request.method === "GET" && request.url === ENROLLMENT_HEALTH_PATH) {
        try {
          if (typeof registry?.inspect !== "function") {
            throw new Error("registry unavailable");
          }
          await registry.inspect();
          writeJson(response, 200, {
            ok: true,
            component: "cassav5bt-bluetooth-enrollment",
            protocolVersion: ENROLLMENT_PROTOCOL_VERSION,
            registryReady: true
          });
        } catch {
          writeJson(response, 503, {
            ok: false,
            component: "cassav5bt-bluetooth-enrollment",
            code: "NOT_READY"
          });
        }
        return;
      }
      if (request.method !== "POST" || request.url !== ENROLLMENT_PATH) {
        writeJson(response, 404, { ok: false, code: "NOT_FOUND" });
        return;
      }
      const contentType = String(request.headers["content-type"] ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw transportError(
          "UNSUPPORTED_MEDIA_TYPE",
          "Content-Type must be application/json",
          415
        );
      }
      if (activeEnrollments >= maxConcurrentEnrollments) {
        writeJson(
          response,
          503,
          { ok: false, code: "ENROLLMENT_BUSY" },
          { connection: "close", "retry-after": "1" }
        );
        return;
      }
      activeEnrollments += 1;
      try {
        const result = await processEnrollmentRequest({
          rawBody: await readRequestBody(request),
          expectedEndpointId,
          registry
        });
        writeJson(response, 201, result);
      } finally {
        activeEnrollments -= 1;
      }
    } catch (error) {
      const safeError =
        error instanceof EnrollmentTransportError
          ? error
          : transportError(
              "ENROLLMENT_INTERNAL_ERROR",
              "Enrollment failed",
              500,
              { cause: error }
            );
      if (onRejected !== null) {
        try {
          onRejected(Object.freeze({
            code: safeError.code,
            httpStatus: safeError.httpStatus
          }));
        } catch {
          // Diagnostic observers must never alter the enrollment response.
        }
      }
      writeJson(response, safeError.httpStatus, {
        ok: false,
        code: safeError.code
      });
    }
  };
}
