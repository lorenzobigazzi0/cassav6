import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HELLO_V1_MINIMUM_MTU,
  HELLO_V1_WIRE_BYTES,
  HelloV1Error,
  decodeHelloV1,
  encodeHelloV1,
  generateHelloNonceV1,
  generateHelloSessionIdV1,
  normalizeHelloV1
} from "./hello-v1.mjs";

const vectors = JSON.parse(
  await readFile(
    new URL("../../contracts/PROTOCOL_TEST_VECTORS.json", import.meta.url),
    "utf8"
  )
);
const vector = vectors.helloWire;

test("HELLO v1 frozen vector round-trips through the exact 51-byte wire format", () => {
  const encoded = encodeHelloV1(vector.request);

  assert.equal(HELLO_V1_WIRE_BYTES, 51);
  assert.equal(HELLO_V1_MINIMUM_MTU, 54);
  assert.equal(encoded.byteLength, vector.wireBytes);
  assert.equal(encoded.toString("hex"), vector.requestHex);
  assert.deepEqual(decodeHelloV1(encoded), vector.request);
});

test("HELLO v1 rejects unknown fields and non-canonical bindings", () => {
  assert.throws(
    () => normalizeHelloV1({ ...vector.request, extra: true }),
    (error) =>
      error instanceof HelloV1Error &&
      error.code === "INVALID_HELLO_FIELDS"
  );
  for (const invalid of [
    { protocolVersion: 2 },
    { sessionId: "short" },
    { nodeId: vector.request.nodeId.toUpperCase() },
    { bootId: 0 },
    { capabilities: 128 },
    { nonce: "AAAAAAAAAAAAAAAAAAAAAA" }
  ]) {
    assert.throws(
      () => normalizeHelloV1({ ...vector.request, ...invalid }),
      HelloV1Error
    );
  }
});

test("HELLO v1 rejects truncation, extension and reserved capability bits", () => {
  const encoded = encodeHelloV1(vector.request);

  for (const malformed of [
    encoded.subarray(0, encoded.length - 1),
    Buffer.concat([encoded, Buffer.from([0])]),
    Buffer.from(encoded).fill(0x80, 34, 35)
  ]) {
    assert.throws(() => decodeHelloV1(malformed), HelloV1Error);
  }
});

test("HELLO random identifiers require exact entropy and canonical output", () => {
  let seed = 0;
  const randomBytes = (length) =>
    Uint8Array.from({ length }, () => (seed++ % 255) + 1);

  assert.match(
    generateHelloSessionIdV1(randomBytes),
    /^[A-Za-z0-9_-]{21}[AQgw]$/
  );
  assert.match(
    generateHelloNonceV1(randomBytes),
    /^[A-Za-z0-9_-]{21}[AQgw]$/
  );
  assert.throws(
    () => generateHelloSessionIdV1(() => new Uint8Array(15)),
    /wrong size/
  );
  assert.throws(
    () => generateHelloNonceV1(() => new Uint8Array(16)),
    /all zero/
  );
});
