import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DeviceRegistryV1
} from "../../shared/provisioning/device-registry-v1.mjs";
import {
  DeviceRegistryV2
} from "../../shared/provisioning/device-registry-v2.mjs";
import {
  buildEnrollmentProofBytes as buildEnrollmentProofBytesV1
} from "../../shared/provisioning/enrollment-transport-v1.mjs";
import {
  buildEnrollmentProofBytes as buildEnrollmentProofBytesV2
} from "../../shared/provisioning/enrollment-transport-v2.mjs";
import {
  createPeerTrustDirectoryRequestHandlerV1
} from "../../shared/provisioning/peer-trust-transport-v1.mjs";
import {
  createDualEnrollmentRequestHandler,
  inspectEnrollmentRegistry,
  isolatedRegistryPath,
  listenForEnrollment,
  validateConfiguredStateRoot,
  validateEndpointId
} from "./enrollment-server.mjs";

async function privateDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("startup accepts only a canonical endpoint and the fixed V6 root", () => {
  assert.equal(validateEndpointId("raspberry-lab-cassav6"), "raspberry-lab-cassav6");
  assert.throws(() => validateEndpointId("../invalid"));
  assert.equal(
    validateConfiguredStateRoot("/var/lib/cassav6-bluetooth"),
    "/var/lib/cassav6-bluetooth"
  );
  assert.throws(
    () => validateConfiguredStateRoot("/var/lib/cassav6-bluetooth")
  );
});

test("registry preflight requires an initialized private V6 registry", async (t) => {
  const stateRoot = await privateDirectory(t, "cassav6-state-");
  const registryPath = path.join(stateRoot, "devices.json");
  await assert.rejects(
    inspectEnrollmentRegistry(registryPath, { stateRoot }),
    (error) => error?.code === "ENOENT"
  );

  await writeFile(registryPath, "{}\n", { mode: 0o600 });
  await assert.rejects(
    inspectEnrollmentRegistry(registryPath, { stateRoot })
  );

  await rm(registryPath);
  const registry = new DeviceRegistryV2(registryPath);
  await registry.initialize();
  const inspected = await inspectEnrollmentRegistry(
    registryPath,
    { stateRoot }
  );
  assert.ok(inspected instanceof DeviceRegistryV2);
});

test("registry preflight rejects V4, intermediate symlink and hard-link escapes", async (t) => {
  await assert.rejects(
    isolatedRegistryPath(
      "/var/lib/cassav6-bluetooth/devices.json",
      { stateRoot: "/var/lib/cassav6-bluetooth" }
    )
  );

  const stateRoot = await privateDirectory(t, "cassav6-state-");
  const outside = await privateDirectory(t, "cassav6-outside-");
  const outsideRegistry = path.join(outside, "devices.json");
  await new DeviceRegistryV2(outsideRegistry).initialize();
  await symlink(outside, path.join(stateRoot, "linked-state"));
  await assert.rejects(
    isolatedRegistryPath(
      path.join(stateRoot, "linked-state", "devices.json"),
      { stateRoot }
    )
  );

  const localRegistry = path.join(stateRoot, "devices.json");
  await new DeviceRegistryV2(localRegistry).initialize();
  const hardLink = path.join(stateRoot, "devices-hard-link.json");
  await link(localRegistry, hardLink);
  await assert.rejects(
    isolatedRegistryPath(localRegistry, { stateRoot })
  );
});

test("registry preflight migrates a valid v1 file without changing credentials", async (t) => {
  const stateRoot = await privateDirectory(t, "cassav6-state-migration-");
  const registryPath = path.join(stateRoot, "devices.json");
  const legacy = new DeviceRegistryV1(registryPath);
  await legacy.initialize();
  const registry = await inspectEnrollmentRegistry(registryPath, { stateRoot });
  const inspected = await registry.inspect();
  assert.equal(inspected.schemaVersion, 2);
  assert.equal(inspected.kind, "cassav6.bluetooth.device-registry");
});

const ENDPOINT_ID = "raspberry-lab-cassav6";
const NODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;

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
  const result = Buffer.from(signature);
  const s = scalar(result.subarray(32));
  if (s > P256_HALF_ORDER) {
    writeScalar(P256_ORDER - s, result.subarray(32));
  }
  return result;
}

function enrollmentRequest(version) {
  const keyPair =
    version === 1
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const request = {
    protocolVersion: version,
    enrollmentEndpointId: ENDPOINT_ID,
    token: `c6e${version}_${Buffer.alloc(32, version).toString("base64url")}`,
    nodeId: NODE_ID,
    publicKeyAlgorithm: version === 1 ? "Ed25519" : "EC-P256",
    publicKeySpkiDerBase64: keyPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    proofAlgorithm:
      version === 1 ? "Ed25519" : "ECDSA-P256-SHA256-P1363",
    proofSignatureBase64: ""
  };
  const proof = version === 1
    ? buildEnrollmentProofBytesV1(request)
    : buildEnrollmentProofBytesV2(request);
  const signature = version === 1
    ? sign(null, proof, keyPair.privateKey)
    : lowS(sign(
        "sha256",
        proof,
        { key: keyPair.privateKey, dsaEncoding: "ieee-p1363" }
      ));
  request.proofSignatureBase64 = signature.toString("base64");
  return request;
}

function postRequest(version) {
  const body = Buffer.from(JSON.stringify(enrollmentRequest(version)));
  return {
    method: "POST",
    url: `/v${version}/enroll`,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield body;
    }
  };
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

test("dual handler serves v1 and v2 while keeping one shared concurrency cap", async () => {
  let release;
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const received = [];
  const handler = createDualEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    maxConcurrentEnrollments: 1,
    registry: {
      async enrollDevice(input) {
        received.push(input);
        if (received.length === 1) {
          entered();
          await wait;
        }
        return { protocolVersion: input.protocolVersion ?? 1 };
      }
    }
  });
  const v1Response = responseRecorder();
  const first = handler(postRequest(1), v1Response);
  await firstEntered;
  const busyResponse = responseRecorder();
  await handler(postRequest(2), busyResponse);
  assert.equal(busyResponse.statusCode, 503);
  assert.deepEqual(JSON.parse(busyResponse.body), {
    ok: false,
    code: "ENROLLMENT_BUSY"
  });
  release();
  await first;
  assert.equal(v1Response.statusCode, 201);

  const v2Response = responseRecorder();
  await handler(postRequest(2), v2Response);
  assert.equal(v2Response.statusCode, 201);
  assert.equal(received[0].protocolVersion, undefined);
  assert.equal(received[1].protocolVersion, 2);
  assert.equal(received[1].publicKeyAlgorithm, "EC-P256");
});

test("dual health reports both protocols and prefers v2", async () => {
  let inspections = 0;
  const handler = createDualEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: {
      async inspect() {
        inspections += 1;
        return { devices: [] };
      }
    }
  });
  const response = responseRecorder();
  await handler({ method: "GET", url: "/health", headers: {} }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    component: "cassav6-bluetooth-enrollment",
    protocolVersions: [1, 2],
    preferredProtocolVersion: 2,
    registryReady: true
  });
  assert.equal(inspections, 1);
});

test("dual TLS runtime delegates the read-only peer trust path and rejects cleartext", async () => {
  let reads = 0;
  const peerTrustHandler = createPeerTrustDirectoryRequestHandlerV1({
    enabled: true,
    readCurrentDirectory: async () => {
      reads += 1;
      return Buffer.from('{"signed":true}');
    }
  });
  const handler = createDualEnrollmentRequestHandler({
    expectedEndpointId: ENDPOINT_ID,
    registry: { async inspect() { return {}; } },
    peerTrustHandler
  });
  const clear = responseRecorder();
  await handler(
    {
      method: "GET",
      url: "/v1/peer-trust-directory",
      headers: {},
      socket: { encrypted: false }
    },
    clear
  );
  assert.equal(clear.statusCode, 403);
  assert.equal(reads, 0);
  const tls = responseRecorder();
  await handler(
    {
      method: "GET",
      url: "/v1/peer-trust-directory",
      headers: {},
      socket: { encrypted: true }
    },
    tls
  );
  assert.equal(tls.statusCode, 200);
  assert.equal(reads, 1);
  assert.equal(tls.headers["cache-control"], "no-store");
});

test("listen helper reports asynchronous bind errors", async (t) => {
  const first = createServer();
  t.after(() => new Promise((resolve) => {
    if (!first.listening) {
      resolve();
      return;
    }
    first.close(resolve);
  }));
  await listenForEnrollment(first, 0, "127.0.0.1");
  const address = first.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const second = createServer();
  t.after(() => new Promise((resolve) => {
    if (!second.listening) {
      resolve();
      return;
    }
    second.close(resolve);
  }));
  await assert.rejects(
    listenForEnrollment(second, address.port, "127.0.0.1"),
    (error) => error?.code === "EADDRINUSE"
  );
});
