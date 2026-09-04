import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceRegistryV2 } from "./device-registry-v2.mjs";

import {
  EnrollmentTransportError,
  buildEnrollmentProofBytes,
  createEnrollmentRequestHandler,
  parseEnrollmentRequestJson,
  processEnrollmentRequest,
  validateEnrollmentRequest
} from "./enrollment-transport-v2.mjs";

const ENDPOINT_ID = "raspberry-lab-v5bt";
const NODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const TOKEN = `c5e2_${Buffer.alloc(32, 0x4a).toString("base64url")}`;
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;
const GOLDEN_VECTOR_URL = new URL(
  "../../contracts/golden-vectors/enrollment-v2-p256-v1.json",
  import.meta.url
);

function scalar(bytes) {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function writeScalar(value, output) {
  let remaining = value;
  for (let index = output.byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function lowS(signature) {
  const canonical = Buffer.from(signature);
  const s = scalar(canonical.subarray(32));
  if (s > P256_HALF_ORDER) {
    writeScalar(P256_ORDER - s, canonical.subarray(32));
  }
  return canonical;
}

function requestFixture(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const request = {
    protocolVersion: 2,
    enrollmentEndpointId: ENDPOINT_ID,
    token: TOKEN,
    nodeId: NODE_ID,
    publicKeyAlgorithm: "EC-P256",
    publicKeySpkiDerBase64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    proofAlgorithm: "ECDSA-P256-SHA256-P1363",
    proofSignatureBase64: ""
  };
  Object.assign(request, overrides);
  request.proofSignatureBase64 = lowS(sign(
    "sha256",
    buildEnrollmentProofBytes(request),
    { key: privateKey, dsaEncoding: "ieee-p1363" }
  )).toString("base64");
  return { request, privateKey, publicKey };
}

function responseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = Buffer.from(body).toString("utf8");
    }
  };
}

function postRequest(body, url = "/v2/enroll") {
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, "utf8");
    }
  };
}

test("v2 parser retains duplicate detection and accepts the exact flat request", () => {
  const { request } = requestFixture();
  assert.deepEqual(
    { ...parseEnrollmentRequestJson(JSON.stringify(request)) },
    request
  );
  assert.throws(
    () => parseEnrollmentRequestJson('{"nodeId":"a","node\\u0049d":"b"}'),
    (error) =>
      error instanceof EnrollmentTransportError &&
      error.code === "DUPLICATE_JSON_KEY"
  );
});

test("v2 proof validates canonical P-256 SPKI and low-S P1363", () => {
  const { request } = requestFixture();
  assert.equal(Buffer.from(request.publicKeySpkiDerBase64, "base64").length, 91);
  assert.equal(Buffer.from(request.proofSignatureBase64, "base64").length, 64);
  assert.equal(validateEnrollmentRequest(request, ENDPOINT_ID), request);
});

test("v2 matches the shared Android and Node P-256 golden vector", async () => {
  const fixture = JSON.parse(await readFile(GOLDEN_VECTOR_URL, "utf8"));
  assert.deepEqual(Object.keys(fixture).sort(), [
    "enrollmentEndpointId",
    "kind",
    "nodeId",
    "proofAlgorithm",
    "proofSignatureBase64",
    "proofTranscriptSha256",
    "proofTranscriptUtf8Base64",
    "protocolVersion",
    "publicKeyAlgorithm",
    "publicKeySpkiDerBase64",
    "requestJsonUtf8Base64",
    "schemaVersion",
    "token"
  ].sort());
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(
    fixture.kind,
    "cassav5bt.bluetooth.enrollment-v2-p256-golden-vector"
  );
  const request = {
    protocolVersion: fixture.protocolVersion,
    enrollmentEndpointId: fixture.enrollmentEndpointId,
    token: fixture.token,
    nodeId: fixture.nodeId,
    publicKeyAlgorithm: fixture.publicKeyAlgorithm,
    publicKeySpkiDerBase64: fixture.publicKeySpkiDerBase64,
    proofAlgorithm: fixture.proofAlgorithm,
    proofSignatureBase64: fixture.proofSignatureBase64
  };
  assert.equal(
    Buffer.from(JSON.stringify(request), "utf8").toString("base64"),
    fixture.requestJsonUtf8Base64
  );
  const transcript = buildEnrollmentProofBytes(request);
  assert.equal(
    transcript.toString("base64"),
    fixture.proofTranscriptUtf8Base64
  );
  assert.equal(
    createHash("sha256").update(transcript).digest("hex"),
    fixture.proofTranscriptSha256
  );
  assert.equal(validateEnrollmentRequest(request, fixture.enrollmentEndpointId), request);
});

test("v2 validation binds every transcript field", () => {
  const { request } = requestFixture();
  for (const mutation of [
    { enrollmentEndpointId: "other-endpoint" },
    { token: `c5e2_${Buffer.alloc(32, 0x4b).toString("base64url")}` },
    { nodeId: NODE_ID.replace(/0$/, "1") },
    { publicKeyAlgorithm: "Ed25519" },
    { proofAlgorithm: "Ed25519" }
  ]) {
    assert.throws(
      () => validateEnrollmentRequest({ ...request, ...mutation }, ENDPOINT_ID)
    );
  }
});

test("v2 signature cryptographically binds both algorithm identifiers", () => {
  const { request, publicKey, privateKey } = requestFixture();
  const signature = Buffer.from(request.proofSignatureBase64, "base64");
  assert.equal(verify(
    "sha256",
    buildEnrollmentProofBytes(request),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature
  ), true);

  for (const altered of [
    { ...request, publicKeyAlgorithm: "Ed25519" },
    { ...request, proofAlgorithm: "ECDSA-P256-SHA512-P1363" }
  ]) {
    assert.equal(verify(
      "sha256",
      buildEnrollmentProofBytes(altered),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature
    ), false);
  }

  const obsoleteProof = Buffer.from([
    "CASSAV5BT-BT-ENROLLMENT-PROOF-V2",
    "2",
    request.enrollmentEndpointId,
    request.token,
    request.nodeId,
    request.publicKeySpkiDerBase64
  ].join("\u0000"), "utf8");
  const obsoleteSignature = lowS(sign(
    "sha256",
    obsoleteProof,
    { key: privateKey, dsaEncoding: "ieee-p1363" }
  ));
  assert.throws(
    () => validateEnrollmentRequest({
      ...request,
      proofSignatureBase64: obsoleteSignature.toString("base64")
    }, ENDPOINT_ID),
    (error) => error?.code === "INVALID_ENROLLMENT_PROOF"
  );
});

test("v2 rejects high-S malleability and malformed scalars", () => {
  const { request } = requestFixture();
  const signature = Buffer.from(request.proofSignatureBase64, "base64");
  const s = scalar(signature.subarray(32));
  writeScalar(P256_ORDER - s, signature.subarray(32));
  assert.ok(scalar(signature.subarray(32)) > P256_HALF_ORDER);
  assert.throws(
    () => validateEnrollmentRequest({
      ...request,
      proofSignatureBase64: signature.toString("base64")
    }, ENDPOINT_ID),
    (error) => error?.code === "INVALID_REQUEST"
  );

  const zeroR = Buffer.from(request.proofSignatureBase64, "base64");
  zeroR.fill(0, 0, 32);
  assert.throws(
    () => validateEnrollmentRequest({
      ...request,
      proofSignatureBase64: zeroR.toString("base64")
    }, ENDPOINT_ID),
    (error) => error?.code === "INVALID_REQUEST"
  );
});

test("v2 rejects a valid signature from the wrong P-256 key", () => {
  const first = requestFixture();
  const second = requestFixture();
  assert.throws(
    () => validateEnrollmentRequest({
      ...first.request,
      proofSignatureBase64: second.request.proofSignatureBase64
    }, ENDPOINT_ID),
    (error) => error?.code === "INVALID_ENROLLMENT_PROOF"
  );
});

test("v2 process passes the explicit protocol and algorithm to the registry", async () => {
  const { request } = requestFixture();
  let received;
  const expected = { protocolVersion: 2, certificateId: "certificate" };
  const result = await processEnrollmentRequest({
    rawBody: JSON.stringify(request),
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async enrollDevice(input) {
        received = input;
        return expected;
      }
    }
  });
  assert.deepEqual(result, expected);
  assert.equal(received.protocolVersion, 2);
  assert.equal(received.publicKeyAlgorithm, "EC-P256");
  assert.equal(received.token, TOKEN);
  assert.deepEqual(
    received.publicKey,
    Buffer.from(request.publicKeySpkiDerBase64, "base64")
  );
});

test("v2 exact committed recovery remains protocol and algorithm bound", async () => {
  const { request } = requestFixture();
  let recovery;
  const result = await processEnrollmentRequest({
    rawBody: JSON.stringify(request),
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async enrollDevice() {
        const error = new Error("already consumed");
        error.code = "ENROLLMENT_TOKEN_REPLAY";
        throw error;
      },
      async recoverCommittedEnrollment(input) {
        recovery = input;
        return { protocolVersion: 2, recovered: true };
      }
    }
  });
  assert.deepEqual(result, { protocolVersion: 2, recovered: true });
  assert.equal(recovery.protocolVersion, 2);
  assert.equal(recovery.publicKeyAlgorithm, "EC-P256");
});

test("v2 busy without a commit is retryable and the same request can succeed", async () => {
  const { request } = requestFixture();
  let enrollmentCalls = 0;
  let recoveryCalls = 0;
  const registry = {
    async enrollDevice() {
      enrollmentCalls += 1;
      if (enrollmentCalls === 1) {
        const error = new Error("registry busy");
        error.code = "REGISTRY_BUSY";
        throw error;
      }
      return { protocolVersion: 2, enrolled: true };
    },
    async recoverCommittedEnrollment() {
      recoveryCalls += 1;
      const error = new Error("nothing committed");
      error.code = "ENROLLMENT_RECOVERY_REJECTED";
      throw error;
    }
  };

  await assert.rejects(
    processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry
    }),
    (error) =>
      error instanceof EnrollmentTransportError &&
      error.code === "ENROLLMENT_RETRYABLE" &&
      error.httpStatus === 503
  );
  assert.deepEqual(
    await processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry
    }),
    { protocolVersion: 2, enrolled: true }
  );
  assert.equal(enrollmentCalls, 2);
  assert.equal(recoveryCalls, 1);
});

test("v2 durability uncertainty recovers a present commit or remains retryable", async () => {
  const { request } = requestFixture();
  for (const committed of [true, false]) {
    let recoveryCalls = 0;
    const operation = processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry: {
        async enrollDevice() {
          const error = new Error("directory sync uncertain");
          error.code = "REGISTRY_DURABILITY_UNCERTAIN";
          error.registryCommitted = true;
          throw error;
        },
        async recoverCommittedEnrollment(input) {
          recoveryCalls += 1;
          assert.equal(input.protocolVersion, 2);
          assert.equal(input.publicKeyAlgorithm, "EC-P256");
          if (committed) {
            return { protocolVersion: 2, recovered: true };
          }
          const error = new Error("commit absent");
          error.code = "ENROLLMENT_RECOVERY_REJECTED";
          throw error;
        }
      }
    });

    if (committed) {
      assert.deepEqual(await operation, { protocolVersion: 2, recovered: true });
    } else {
      await assert.rejects(
        operation,
        (error) =>
          error instanceof EnrollmentTransportError &&
          error.code === "ENROLLMENT_RETRYABLE" &&
          error.httpStatus === 503
      );
    }
    assert.equal(recoveryCalls, 1);
  }
});

test("v2 registry lock read corruption and clock failures never become 403", async () => {
  const { request } = requestFixture();
  for (const code of [
    "REGISTRY_LOCK_FAILED",
    "REGISTRY_LOCK_OWNERSHIP_LOST",
    "REGISTRY_READ_FAILED",
    "CORRUPT_REGISTRY",
    "INVALID_CLOCK",
    "REGISTRY_CLOCK_ROLLBACK"
  ]) {
    let recoveryCalls = 0;
    await assert.rejects(
      processEnrollmentRequest({
        rawBody: JSON.stringify(request),
        expectedEndpointId: ENDPOINT_ID,
        registry: {
          async enrollDevice() {
            const error = new Error(code);
            error.code = code;
            throw error;
          },
          async recoverCommittedEnrollment() {
            recoveryCalls += 1;
            throw new Error("not committed");
          }
        }
      }),
      (error) =>
        error instanceof EnrollmentTransportError &&
        error.code === "ENROLLMENT_RETRYABLE" &&
        error.httpStatus === 503
    );
    assert.equal(recoveryCalls, 1);
  }
});

test("v2 replay remains retryable when exact recovery hits a registry fault", async () => {
  const { request } = requestFixture();
  await assert.rejects(
    processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry: {
        async enrollDevice() {
          const error = new Error("already consumed");
          error.code = "ENROLLMENT_TOKEN_REPLAY";
          throw error;
        },
        async recoverCommittedEnrollment() {
          const error = new Error("registry read failed");
          error.code = "REGISTRY_READ_FAILED";
          throw error;
        }
      }
    }),
    (error) =>
      error instanceof EnrollmentTransportError &&
      error.code === "ENROLLMENT_RETRYABLE" &&
      error.httpStatus === 503
  );
});

test("v2 committed response recovers only for the identical request within 600 seconds", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cassav5bt-v2-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-17T16:00:00.000Z");
  const registry = new DeviceRegistryV2(path.join(directory, "devices.json"), {
    clock: () => now
  });
  await registry.initialize();
  const issued = await registry.issueEnrollmentToken({
    protocolVersion: 2,
    enrollmentEndpointId: ENDPOINT_ID,
    ttlSeconds: 900
  });
  const { request, privateKey } = requestFixture({ token: issued.qr.token });
  const rawBody = JSON.stringify(request);
  const first = await processEnrollmentRequest({
    rawBody,
    expectedEndpointId: ENDPOINT_ID,
    registry
  });

  now = new Date("2026-08-17T16:09:59.999Z");
  const recovered = await processEnrollmentRequest({
    rawBody,
    expectedEndpointId: ENDPOINT_ID,
    registry
  });
  assert.deepEqual(recovered, first);
  assert.equal(recovered.protocolVersion, 2);
  assert.equal(recovered.publicKeyAlgorithm, "EC-P256");

  const substituted = {
    ...request,
    nodeId: request.nodeId.replace(/0$/, "1"),
    proofSignatureBase64: ""
  };
  substituted.proofSignatureBase64 = lowS(sign(
    "sha256",
    buildEnrollmentProofBytes(substituted),
    { key: privateKey, dsaEncoding: "ieee-p1363" }
  )).toString("base64");
  await assert.rejects(
    processEnrollmentRequest({
      rawBody: JSON.stringify(substituted),
      expectedEndpointId: ENDPOINT_ID,
      registry
    }),
    (error) => error?.code === "ENROLLMENT_REJECTED"
  );

  now = new Date("2026-08-17T16:10:00.001Z");
  await assert.rejects(
    processEnrollmentRequest({
      rawBody,
      expectedEndpointId: ENDPOINT_ID,
      registry
    }),
    (error) => error?.code === "ENROLLMENT_REJECTED"
  );
});

test("v2 handler exposes only the v2 route and redacted readiness", async () => {
  const handler = createEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async inspect() {
        return { devices: [] };
      }
    }
  });
  const health = responseRecorder();
  await handler({ method: "GET", url: "/health", headers: {} }, health);
  assert.deepEqual(JSON.parse(health.body), {
    ok: true,
    component: "cassav5bt-bluetooth-enrollment",
    protocolVersion: 2,
    registryReady: true
  });

  const wrongPath = responseRecorder();
  await handler(postRequest("{}", "/v1/enroll"), wrongPath);
  assert.equal(wrongPath.statusCode, 404);
});

test("v2 handler rejects invalid content before registry access", async () => {
  let calls = 0;
  const response = responseRecorder();
  await createEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async enrollDevice() {
        calls += 1;
      }
    }
  })(
    {
      method: "POST",
      url: "/v2/enroll",
      headers: { "content-type": "text/plain" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{}");
      }
    },
    response
  );
  assert.equal(response.statusCode, 415);
  assert.equal(calls, 0);
});
