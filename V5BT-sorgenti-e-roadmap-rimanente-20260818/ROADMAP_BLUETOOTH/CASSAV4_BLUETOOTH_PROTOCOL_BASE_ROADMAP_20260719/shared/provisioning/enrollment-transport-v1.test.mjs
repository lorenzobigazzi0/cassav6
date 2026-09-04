import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import {
  readFile
} from "node:fs/promises";
import test from "node:test";

import {
  EnrollmentTransportError,
  buildEnrollmentProofBytes,
  createEnrollmentRequestHandler,
  parseEnrollmentRequestJson,
  processEnrollmentRequest,
  validateEnrollmentRequest
} from "./enrollment-transport-v1.mjs";

const ENDPOINT_ID = "raspberry-lab-v5bt";
const NODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const TOKEN = `c5e1_${Buffer.alloc(32, 0x4a).toString("base64url")}`;

function requestFixture(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const request = {
    protocolVersion: 1,
    enrollmentEndpointId: ENDPOINT_ID,
    token: TOKEN,
    nodeId: NODE_ID,
    publicKeyAlgorithm: "Ed25519",
    publicKeySpkiDerBase64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    proofAlgorithm: "Ed25519",
    proofSignatureBase64: ""
  };
  Object.assign(request, overrides);
  request.proofSignatureBase64 = sign(
    null,
    buildEnrollmentProofBytes(request),
    privateKey
  ).toString("base64");
  return request;
}

test("strict parser accepts the complete flat request", () => {
  const request = requestFixture();
  assert.deepEqual(
    { ...parseEnrollmentRequestJson(JSON.stringify(request)) },
    request
  );
});

test("strict parser rejects literal and escaped duplicate keys", () => {
  assert.throws(
    () => parseEnrollmentRequestJson('{"nodeId":"a","nodeId":"b"}'),
    (error) => error instanceof EnrollmentTransportError &&
      error.code === "DUPLICATE_JSON_KEY"
  );
  assert.throws(
    () => parseEnrollmentRequestJson('{"nodeId":"a","node\\u0049d":"b"}'),
    (error) => error instanceof EnrollmentTransportError &&
      error.code === "DUPLICATE_JSON_KEY"
  );
});

test("strict parser rejects nested, trailing and oversized input", () => {
  assert.throws(() => parseEnrollmentRequestJson('{"x":{}}'));
  assert.throws(() => parseEnrollmentRequestJson('{"x":"y"} trailing'));
  assert.throws(
    () => parseEnrollmentRequestJson('{"x":"y",'),
    (error) => error.code === "INVALID_JSON"
  );
  assert.throws(
    () => parseEnrollmentRequestJson(`{"x":"${"a".repeat(5000)}"}`),
    (error) => error.code === "REQUEST_TOO_LARGE"
  );
});

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

function postRequest(body) {
  return {
    method: "POST",
    url: "/v1/enroll",
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, "utf8");
    }
  };
}

test("HTTP handler health reflects registry readiness without exposing details", async () => {
  const readyResponse = responseRecorder();
  await createEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async inspect() {
        return { devices: [] };
      }
    }
  })(
    { method: "GET", url: "/health", headers: {} },
    readyResponse
  );
  assert.equal(readyResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(readyResponse.body), {
    ok: true,
    component: "cassav5bt-bluetooth-enrollment",
    protocolVersion: 1,
    registryReady: true
  });
  assert.equal(readyResponse.headers["cache-control"], "no-store");

  const unavailableResponse = responseRecorder();
  await createEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async inspect() {
        throw new Error(`registry path and ${TOKEN} must stay private`);
      }
    }
  })(
    { method: "GET", url: "/health", headers: {} },
    unavailableResponse
  );
  assert.equal(unavailableResponse.statusCode, 503);
  assert.deepEqual(JSON.parse(unavailableResponse.body), {
    ok: false,
    component: "cassav5bt-bluetooth-enrollment",
    code: "NOT_READY"
  });
  assert.equal(unavailableResponse.body.includes(TOKEN), false);
});

test("HTTP handler bounds concurrent enrollment work", async () => {
  const request = requestFixture();
  let releaseFirst;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const handler = createEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    maxConcurrentEnrollments: 1,
    registry: {
      async enrollDevice(input) {
        markEntered();
        await release;
        return {
          protocolVersion: 1,
          nodeId: input.nodeId,
          certificateId: "123e4567-e89b-42d3-a456-426614174000",
          publicKeyAlgorithm: "Ed25519",
          publicKeySpkiDerBase64:
            Buffer.from(input.publicKey).toString("base64"),
          aliasKeyAlgorithm: "HMAC-SHA256",
          aliasKeyEncoding: "base64url-unpadded",
          aliasKeyBase64url: Buffer.alloc(32, 0x6a).toString("base64url"),
          enrolledAt: "2026-07-19T16:00:00.000Z"
        };
      }
    }
  });
  const firstResponse = responseRecorder();
  const first = handler(postRequest(JSON.stringify(request)), firstResponse);
  await entered;

  const busyResponse = responseRecorder();
  await handler(postRequest(JSON.stringify(request)), busyResponse);
  assert.equal(busyResponse.statusCode, 503);
  assert.deepEqual(JSON.parse(busyResponse.body), {
    ok: false,
    code: "ENROLLMENT_BUSY"
  });
  assert.equal(busyResponse.headers.connection, "close");
  assert.equal(busyResponse.headers["retry-after"], "1");

  releaseFirst();
  await first;
  assert.equal(firstResponse.statusCode, 201);
  assert.throws(
    () =>
      createEnrollmentRequestHandler({
        expectedEndpointId: ENDPOINT_ID,
        registry: {},
        maxConcurrentEnrollments: 0
      }),
    /maxConcurrentEnrollments/
  );
});

test("HTTP rejection observer receives only redacted error metadata", async () => {
  const request = requestFixture();
  request.nodeId = request.nodeId.replace(/0$/, "1");
  const observed = [];
  const response = responseRecorder();
  const handler = createEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async enrollDevice() {
        throw new Error("registry must not receive an invalid proof");
      }
    },
    onRejected(value) {
      observed.push(value);
    }
  });

  await handler(postRequest(JSON.stringify(request)), response);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(observed, [
    {
      code: "INVALID_ENROLLMENT_PROOF",
      httpStatus: 403
    }
  ]);
  assert.equal(JSON.stringify(observed).includes(TOKEN), false);
});

test("strict parser accepts only JSON whitespace and valid UTF-8", () => {
  const request = requestFixture();
  assert.deepEqual(
    {
      ...parseEnrollmentRequestJson(
        Buffer.from(` \t\r\n${JSON.stringify(request)}\n`, "utf8")
      )
    },
    request
  );
  assert.throws(
    () => parseEnrollmentRequestJson(`\u00a0${JSON.stringify(request)}`),
    (error) => error?.code === "INVALID_JSON"
  );
  assert.throws(
    () => parseEnrollmentRequestJson(Buffer.from([0x7b, 0x22, 0xc3, 0x28])),
    (error) => error?.code === "INVALID_JSON"
  );
});

test("validation binds endpoint, exact fields, key and proof", () => {
  const request = requestFixture();
  assert.equal(validateEnrollmentRequest(request, ENDPOINT_ID), request);
  assert.throws(
    () => validateEnrollmentRequest(request, "other-endpoint"),
    (error) => error.code === "INVALID_REQUEST"
  );
  assert.throws(
    () => validateEnrollmentRequest({ ...request, extra: "x" }, ENDPOINT_ID),
    (error) => error.code === "INVALID_REQUEST_STRUCTURE"
  );
  assert.throws(
    () => validateEnrollmentRequest(
      { ...request, nodeId: request.nodeId.replace(/0$/, "1") },
      ENDPOINT_ID
    ),
    (error) => error.code === "INVALID_ENROLLMENT_PROOF"
  );
});

test("frozen cross-language Ed25519 enrollment proof validates exactly", async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL("../../contracts/PROTOCOL_TEST_VECTORS.json", import.meta.url),
      "utf8"
    )
  );
  const vector = vectors.enrollmentProof;
  const request = {
    protocolVersion: vector.protocolVersion,
    enrollmentEndpointId: vector.enrollmentEndpointId,
    token: vector.token,
    nodeId: vector.nodeId,
    publicKeyAlgorithm: vector.algorithm,
    publicKeySpkiDerBase64: vector.publicKeySpkiDerBase64,
    proofAlgorithm: vector.algorithm,
    proofSignatureBase64: vector.proofSignatureBase64
  };
  const proof = buildEnrollmentProofBytes(request);
  assert.equal(proof.toString("base64"), vector.proofUtf8Base64);
  assert.equal(
    verify(
      null,
      proof,
      createPublicKey({
        key: Buffer.from(vector.publicKeySpkiDerBase64, "base64"),
        format: "der",
        type: "spki"
      }),
      Buffer.from(vector.proofSignatureBase64, "base64")
    ),
    true
  );
  assert.equal(
    validateEnrollmentRequest(request, vector.enrollmentEndpointId),
    request
  );
});

test("valid request reaches the registry without logging or reshaping secrets", async () => {
  const request = requestFixture();
  let received;
  const response = {
    protocolVersion: 1,
    nodeId: request.nodeId,
    certificateId: "123e4567-e89b-42d3-a456-426614174000",
    publicKeyAlgorithm: "Ed25519",
    publicKeySpkiDerBase64: request.publicKeySpkiDerBase64,
    aliasKeyAlgorithm: "HMAC-SHA256",
    aliasKeyEncoding: "base64url-unpadded",
    aliasKeyBase64url: Buffer.alloc(32, 0x7b).toString("base64url"),
    enrolledAt: "2026-07-19T16:00:00.000Z"
  };
  const result = await processEnrollmentRequest({
    rawBody: JSON.stringify(request),
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async enrollDevice(value) {
        received = value;
        return response;
      }
    }
  });
  assert.deepEqual(result, response);
  assert.equal(received.enrollmentEndpointId, ENDPOINT_ID);
  assert.equal(received.token, TOKEN);
  assert.equal(received.nodeId, NODE_ID);
  assert.deepEqual(
    received.publicKey,
    Buffer.from(request.publicKeySpkiDerBase64, "base64")
  );
});

test("registry errors are reduced to a non-enumerating rejection", async () => {
  const request = requestFixture();
  await assert.rejects(
    processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry: {
        async enrollDevice() {
          const error = new Error(`unknown token ${TOKEN}`);
          error.code = "INVALID_ENROLLMENT_TOKEN";
          throw error;
        }
      }
    }),
    (error) =>
      error.code === "ENROLLMENT_REJECTED" &&
      error.httpStatus === 403 &&
      !error.message.includes(TOKEN)
  );
});

test("a replay recovers only the exact already committed response", async () => {
  const request = requestFixture();
  const response = {
    protocolVersion: 1,
    nodeId: request.nodeId,
    certificateId: "123e4567-e89b-42d3-a456-426614174000",
    publicKeyAlgorithm: "Ed25519",
    publicKeySpkiDerBase64: request.publicKeySpkiDerBase64,
    aliasKeyAlgorithm: "HMAC-SHA256",
    aliasKeyEncoding: "base64url-unpadded",
    aliasKeyBase64url: Buffer.alloc(32, 0x6d).toString("base64url"),
    enrolledAt: "2026-07-19T16:00:00.000Z"
  };
  let recoveryInput;
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
        recoveryInput = input;
        return response;
      }
    }
  });
  assert.deepEqual(result, response);
  assert.equal(recoveryInput.token, TOKEN);
  assert.equal(recoveryInput.nodeId, NODE_ID);
  assert.equal(recoveryInput.enrollmentEndpointId, ENDPOINT_ID);
});

test("post-commit lock failures use only exact committed recovery", async () => {
  const request = requestFixture();
  for (const code of [
    "REGISTRY_LOCK_CLEANUP_FAILED",
    "REGISTRY_BUSY"
  ]) {
    let recoveryCalls = 0;
    const result = await processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry: {
        async enrollDevice() {
          const error = new Error(code);
          error.code = code;
          throw error;
        },
        async recoverCommittedEnrollment(input) {
          recoveryCalls += 1;
          assert.equal(input.token, TOKEN);
          return { recovered: code };
        }
      }
    });
    assert.deepEqual(result, { recovered: code });
    assert.equal(recoveryCalls, 1);
  }

  await assert.rejects(
    processEnrollmentRequest({
      rawBody: JSON.stringify(request),
      expectedEndpointId: ENDPOINT_ID,
      registry: {
        async enrollDevice() {
          const error = new Error("durability uncertain");
          error.code = "REGISTRY_DURABILITY_UNCERTAIN";
          throw error;
        },
        async recoverCommittedEnrollment() {
          throw new Error("must not be called");
        }
      }
    }),
    (error) => error?.code === "ENROLLMENT_REJECTED"
  );
});
