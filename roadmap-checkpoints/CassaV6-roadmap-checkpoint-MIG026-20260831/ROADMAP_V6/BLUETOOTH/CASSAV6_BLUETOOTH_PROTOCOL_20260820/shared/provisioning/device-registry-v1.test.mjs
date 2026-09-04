import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALIAS_KEY_BYTES,
  DeviceRegistryError,
  DeviceRegistryV1
} from "./device-registry-v1.mjs";

const CLI_PATH = fileURLToPath(
  new URL("../../raspberry/scripts/device-registry.mjs", import.meta.url)
);

function resolveLocalRef(rootSchema, ref) {
  assert.match(ref, /^#\//);
  return ref
    .slice(2)
    .split("/")
    .reduce(
      (current, segment) =>
        current[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
      rootSchema
    );
}

function assertContractSchema(value, schema, rootSchema = schema, location = "$") {
  if (schema.$ref !== undefined) {
    assertContractSchema(
      value,
      resolveLocalRef(rootSchema, schema.$ref),
      rootSchema,
      location
    );
    return;
  }

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        assertContractSchema(value, candidate, rootSchema, location);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${location} must match exactly one schema`);
    return;
  }

  if ("const" in schema) {
    assert.deepEqual(value, schema.const, `${location} has an invalid constant`);
  }

  const acceptedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type === undefined
      ? []
      : [schema.type];
  if (acceptedTypes.length > 0) {
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value;
    assert.ok(
      acceptedTypes.includes(actualType),
      `${location} must have type ${acceptedTypes.join("|")}`
    );
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined) {
      assert.match(value, new RegExp(schema.pattern), `${location} pattern mismatch`);
    }
    if (schema.format === "date-time") {
      assert.equal(
        new Date(value).toISOString(),
        value,
        `${location} must be a canonical UTC date`
      );
    }
    if (schema.format === "uuid") {
      assert.match(
        value,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        `${location} must be a canonical UUID`
      );
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      assertContractSchema(item, schema.items, rootSchema, `${location}[${index}]`)
    );
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      assert.ok(
        Object.hasOwn(value, required),
        `${location}.${required} is required`
      );
    }
    if (schema.additionalProperties === false) {
      const permitted = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        assert.ok(permitted.has(key), `${location}.${key} is not permitted`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        assertContractSchema(
          value[key],
          propertySchema,
          rootSchema,
          `${location}.${key}`
        );
      }
    }
  }
}

async function testRegistry(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cassav6-b1-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "devices.json");
  const registry = new DeviceRegistryV1(registryPath, options);
  await registry.initialize();
  return { directory, registry, registryPath };
}

function ed25519KeyPair() {
  return generateKeyPairSync("ed25519");
}

function publicPem(key) {
  return key.export({ type: "spki", format: "pem" });
}

function androidNodeId(index) {
  return `550e8400-e29b-41d4-a716-${index.toString(16).padStart(12, "0")}`;
}

function runCli(arguments_) {
  return spawnSync(process.execPath, [CLI_PATH, ...arguments_], {
    encoding: "utf8"
  });
}

async function pathDoesNotExist(filePath) {
  await assert.rejects(stat(filePath), (error) => error?.code === "ENOENT");
}

test("happy path creates a 0600 registry and enrolls only public Android material", async (t) => {
  const { registry, registryPath } = await testRegistry(t);
  const { publicKey, privateKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-raspberry-01",
    ttlSeconds: 300
  });

  assert.deepEqual(Object.keys(issued.qr).sort(), [
    "enrollmentEndpointId",
    "token",
    "version"
  ]);
  assert.equal(issued.qr.version, 1);
  assert.equal(JSON.parse(issued.qrPayload).token, issued.qr.token);
  const enrollmentQrSchema = JSON.parse(
    await readFile(
      new URL("../../contracts/enrollment-qr-v1.schema.json", import.meta.url),
      "utf8"
    )
  );
  assert.match(issued.qr.token, new RegExp(enrollmentQrSchema.properties.token.pattern));
  assertContractSchema(issued.qr, enrollmentQrSchema);

  const deviceNodeId = androidNodeId(1);
  const enrolled = await registry.enrollDevice({
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    publicKey: publicPem(publicKey),
    nodeId: deviceNodeId
  });

  assert.equal(enrolled.nodeId, deviceNodeId);
  assert.equal(enrolled.aliasKeyEncoding, "base64url-unpadded");
  assert.match(
    enrolled.aliasKeyBase64url,
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
  );
  assert.equal(
    Buffer.from(enrolled.aliasKeyBase64url, "base64url").byteLength,
    ALIAS_KEY_BYTES
  );
  assert.equal(enrolled.publicKeyAlgorithm, "Ed25519");
  const enrollmentResponseSchema = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/enrollment-response-v1.schema.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  assert.deepEqual(
    Object.keys(enrolled).sort(),
    [...enrollmentResponseSchema.required].sort()
  );
  assert.match(
    enrolled.aliasKeyBase64url,
    new RegExp(
      enrollmentResponseSchema.properties.aliasKeyBase64url.pattern
    )
  );
  assertContractSchema(enrolled, enrollmentResponseSchema);

  const registryStat = await stat(registryPath);
  assert.equal(registryStat.mode & 0o777, 0o600);

  const raw = await readFile(registryPath, "utf8");
  const registryDocument = JSON.parse(raw);
  const registrySchema = JSON.parse(
    await readFile(
      new URL("../../contracts/device-registry-v1.schema.json", import.meta.url),
      "utf8"
    )
  );
  assert.match(
    registryDocument.devices[0].publicKeySpkiDerBase64,
    new RegExp(
      registrySchema.$defs.device.properties.publicKeySpkiDerBase64.pattern
    )
  );
  assert.match(
    registryDocument.devices[0].aliasKeyBase64url,
    new RegExp(registrySchema.$defs.device.properties.aliasKeyBase64url.pattern)
  );
  assertContractSchema(registryDocument, registrySchema);
  assert.equal(raw.includes(issued.qr.token), false, "plaintext token leaked to registry");
  assert.equal(raw.includes("PRIVATE KEY"), false, "private key leaked to registry");
  assert.equal(
    raw.includes(privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")),
    false,
    "private key bytes leaked to registry"
  );

  const inspection = await registry.inspect();
  assert.equal(inspection.devices.length, 1);
  assert.equal("aliasKeyBase64url" in inspection.devices[0], false);
  assert.equal(inspection.enrollmentTokens[0].status, "CONSUMED");
  assert.equal("tokenHashBase64" in inspection.enrollmentTokens[0], false);

  const authorized = await registry.getAuthorizedDevice(enrolled.nodeId);
  assert.equal("aliasKeyBase64url" in authorized, false);
  assert.equal(authorized.publicKeySpkiDerBase64, enrolled.publicKeySpkiDerBase64);
  assert.deepEqual(
    await registry.verifyIssuedTokenCommit({
      tokenId: issued.tokenId,
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token
    }),
    { recordExists: true, matches: true }
  );
  assert.deepEqual(await registry.verifyProvisioningCommit(enrolled), {
    recordExists: true,
    matches: true
  });
  const differentAliasBytes = Buffer.from(
    enrolled.aliasKeyBase64url,
    "base64url"
  );
  differentAliasBytes[0] ^= 0x01;
  const differentAlias = differentAliasBytes.toString("base64url");
  assert.deepEqual(
    await registry.verifyProvisioningCommit({
      ...enrolled,
      aliasKeyBase64url: differentAlias
    }),
    { recordExists: true, matches: false }
  );
  assert.match(
    await registry.deriveRotatingAliasForNode({
      nodeId: enrolled.nodeId,
      timestampSeconds: 1_720_000_000
    }),
    /^[0-9a-f]{12}$/
  );
});

test("authorized crypto operations verify the enrolled identity without exporting its secret", async (t) => {
  const { registry } = await testRegistry(t);
  const { publicKey, privateKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-auth-01",
    ttlSeconds: 300
  });
  const enrolled = await registry.enrollDevice({
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    publicKey: publicPem(publicKey),
    nodeId: androidNodeId(91)
  });
  const message = Buffer.from("mutual-auth-bound-message", "utf8");
  const signature = sign(null, message, privateKey);

  assert.equal(
    await registry.verifyAuthorizedDeviceSignature({
      nodeId: enrolled.nodeId,
      certificateId: enrolled.certificateId,
      message,
      signature
    }),
    true
  );
  const tampered = Buffer.from(message);
  tampered[0] ^= 0x01;
  assert.equal(
    await registry.verifyAuthorizedDeviceSignature({
      nodeId: enrolled.nodeId,
      certificateId: enrolled.certificateId,
      message: tampered,
      signature
    }),
    false
  );

  const expectedProof = createHmac(
    "sha256",
    Buffer.from(enrolled.aliasKeyBase64url, "base64url")
  ).update(message).digest();
  assert.deepEqual(
    await registry.createAuthorizedDeviceMac({
      nodeId: enrolled.nodeId,
      certificateId: enrolled.certificateId,
      message
    }),
    expectedProof
  );
  assert.equal(
    await registry.verifyAuthorizedDeviceMac({
      nodeId: enrolled.nodeId,
      certificateId: enrolled.certificateId,
      message,
      proof: expectedProof
    }),
    true
  );

  await assert.rejects(
    registry.createAuthorizedDeviceMac({
      nodeId: enrolled.nodeId,
      certificateId: "123e4567-e89b-12d3-a456-426614174000",
      message
    }),
    (error) =>
      error instanceof DeviceRegistryError &&
      error.code === "CERTIFICATE_BINDING_MISMATCH"
  );
  await registry.revokeDevice(enrolled.nodeId);
  await assert.rejects(
    registry.verifyAuthorizedDeviceSignature({
      nodeId: enrolled.nodeId,
      certificateId: enrolled.certificateId,
      message,
      signature
    }),
    (error) =>
      error instanceof DeviceRegistryError && error.code === "REVOKED_NODE"
  );
});

test("enrollment requires the Android NodeId and never generates one", async (t) => {
  const { registry } = await testRegistry(t);
  const { publicKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-required-node-id",
    ttlSeconds: 300
  });

  await assert.rejects(
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey)
    }),
    (error) => error?.code === "INVALID_NODE_ID"
  );

  const inspection = await registry.inspect();
  assert.equal(inspection.devices.length, 0);
  assert.equal(inspection.enrollmentTokens[0].status, "ACTIVE");
});

test("expired enrollment tokens cannot be consumed", async (t) => {
  let now = Date.parse("2026-07-19T10:00:00.000Z");
  const { registry } = await testRegistry(t, { clock: () => new Date(now) });
  const { publicKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-expiry",
    ttlSeconds: 60
  });

  now += 60_000;
  await assert.rejects(
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId: androidNodeId(2)
    }),
    (error) => error?.code === "ENROLLMENT_TOKEN_EXPIRED"
  );

  const inspection = await registry.inspect();
  assert.equal(inspection.devices.length, 0);
  assert.equal(inspection.enrollmentTokens[0].status, "EXPIRED");
});

test("clock rollback cannot consume a token issued in the future", async (t) => {
  let now = Date.parse("2026-07-19T10:00:00.000Z");
  const { registry } = await testRegistry(t, { clock: () => new Date(now) });
  const { publicKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-clock-rollback",
    ttlSeconds: 60
  });

  now -= 1;
  await assert.rejects(
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId: androidNodeId(19)
    }),
    (error) => error?.code === "REGISTRY_CLOCK_ROLLBACK"
  );
  assert.equal((await registry.inspect()).devices.length, 0);
});

test("concurrent replay consumes a one-time token exactly once", async (t) => {
  const { registry } = await testRegistry(t);
  const firstKey = ed25519KeyPair();
  const secondKey = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-replay",
    ttlSeconds: 300
  });

  const attempts = await Promise.allSettled([
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(firstKey.publicKey),
      nodeId: androidNodeId(3)
    }),
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(secondKey.publicKey),
      nodeId: androidNodeId(4)
    })
  ]);

  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "ENROLLMENT_TOKEN_REPLAY");

  const inspection = await registry.inspect();
  assert.equal(inspection.devices.length, 1);
  assert.equal(inspection.enrollmentTokens[0].status, "CONSUMED");
});

test("the same signed transport can recover one committed response for ten minutes", async (t) => {
  let now = Date.parse("2026-07-19T16:00:00.000Z");
  const { registry } = await testRegistry(t, {
    clock: () => new Date(now)
  });
  const { publicKey } = ed25519KeyPair();
  const endpointId = "lab-network-recovery";
  const nodeId = androidNodeId(18);
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: endpointId,
    ttlSeconds: 300
  });
  const committed = await registry.enrollDevice({
    enrollmentEndpointId: endpointId,
    token: issued.qr.token,
    publicKey: publicPem(publicKey),
    nodeId
  });

  const recovered = await registry.recoverCommittedEnrollment({
    enrollmentEndpointId: endpointId,
    token: issued.qr.token,
    publicKey: publicPem(publicKey),
    nodeId
  });
  assert.deepEqual(recovered, committed);

  const otherKey = ed25519KeyPair();
  await assert.rejects(
    registry.recoverCommittedEnrollment({
      enrollmentEndpointId: endpointId,
      token: issued.qr.token,
      publicKey: publicPem(otherKey.publicKey),
      nodeId
    }),
    (error) => error?.code === "ENROLLMENT_RECOVERY_REJECTED"
  );

  now += 600_000;
  assert.deepEqual(
    await registry.recoverCommittedEnrollment({
      enrollmentEndpointId: endpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId
    }),
    committed
  );

  now -= 600_001;
  await assert.rejects(
    registry.recoverCommittedEnrollment({
      enrollmentEndpointId: endpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId
    }),
    (error) => error?.code === "REGISTRY_CLOCK_ROLLBACK"
  );

  now += 600_002;
  await assert.rejects(
    registry.recoverCommittedEnrollment({
      enrollmentEndpointId: endpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId
    }),
    (error) => error?.code === "ENROLLMENT_RECOVERY_EXPIRED"
  );
});

test("a failed secure-output sink does not commit a token or enrollment", async (t) => {
  const { registry } = await testRegistry(t);
  const sinkFailure = new Error("simulated secure output failure");

  await assert.rejects(
    registry.issueEnrollmentToken({
      enrollmentEndpointId: "lab-output-failure",
      ttlSeconds: 300,
      onTokenReady: async () => {
        throw sinkFailure;
      }
    }),
    sinkFailure
  );
  assert.equal((await registry.inspect()).enrollmentTokens.length, 0);

  const { publicKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-output-failure",
    ttlSeconds: 300
  });
  await assert.rejects(
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId: androidNodeId(5),
      onProvisioningReady: async () => {
        throw sinkFailure;
      }
    }),
    sinkFailure
  );

  const afterFailure = await registry.inspect();
  assert.equal(afterFailure.devices.length, 0);
  assert.equal(afterFailure.enrollmentTokens[0].status, "ACTIVE");
});

test("post-commit lock cleanup failure reports committed state without losing enrollment", async (t) => {
  const { registry, registryPath } = await testRegistry(t);
  const { publicKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-post-commit",
    ttlSeconds: 300
  });
  let stagedProvisioning;

  await assert.rejects(
    registry.enrollDevice({
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      publicKey: publicPem(publicKey),
      nodeId: androidNodeId(6),
      onProvisioningReady: async (value) => {
        stagedProvisioning = value;
        await unlink(`${registryPath}.lock`);
        await writeFile(`${registryPath}.lock`, "foreign-lock\n", {
          mode: 0o600,
          flag: "wx"
        });
      }
    }),
    (error) =>
      error?.code === "REGISTRY_LOCK_CLEANUP_FAILED" &&
      error?.registryCommitted === true
  );

  assert.equal(
    Buffer.from(stagedProvisioning.aliasKeyBase64url, "base64url").byteLength,
    ALIAS_KEY_BYTES
  );
  const inspection = await registry.inspect();
  assert.equal(inspection.devices[0].nodeId, stagedProvisioning.nodeId);
  assert.equal(inspection.enrollmentTokens[0].status, "CONSUMED");
  assert.equal(
    await readFile(`${registryPath}.lock`, "utf8"),
    "foreign-lock\n",
    "cleanup removed or altered a lock it did not own"
  );
});

test("offline CLI keeps secrets out of normal output and preserves an existing output file", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const { publicKey } = ed25519KeyPair();
  const publicKeyPath = path.join(directory, "android-public.pem");
  const tokenOutputPath = path.join(directory, "token.json");
  const provisioningOutputPath = path.join(directory, "provisioning.json");
  const deviceNodeId = androidNodeId(7);
  await writeFile(publicKeyPath, publicPem(publicKey), { mode: 0o600 });

  const issue = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "issue-token",
      "--registry",
      registryPath,
      "--endpoint-id",
      "lab-cli",
      "--ttl-seconds",
      "300",
      "--output",
      tokenOutputPath
    ],
    { encoding: "utf8" }
  );
  assert.equal(issue.status, 0, issue.stderr);
  const issued = JSON.parse(await readFile(tokenOutputPath, "utf8"));
  assert.equal(issue.stdout.includes(issued.qr.token), false);
  assert.equal((await stat(tokenOutputPath)).mode & 0o777, 0o600);

  const enroll = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "enroll",
      "--registry",
      registryPath,
      "--token-file",
      tokenOutputPath,
      "--public-key-file",
      publicKeyPath,
      "--node-id",
      deviceNodeId,
      "--output",
      provisioningOutputPath
    ],
    { encoding: "utf8" }
  );
  assert.equal(enroll.status, 0, enroll.stderr);
  const provisioned = JSON.parse(
    await readFile(provisioningOutputPath, "utf8")
  );
  assert.equal(provisioned.nodeId, deviceNodeId);
  assert.equal(enroll.stdout.includes(provisioned.aliasKeyBase64url), false);
  assert.equal((await stat(provisioningOutputPath)).mode & 0o777, 0o600);

  const list = spawnSync(
    process.execPath,
    [CLI_PATH, "list", "--registry", registryPath],
    { encoding: "utf8" }
  );
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.includes(provisioned.aliasKeyBase64url), false);

  const existingOutputPath = path.join(directory, "must-not-delete.txt");
  await writeFile(existingOutputPath, "keep-me\n", { mode: 0o600 });
  const duplicateOutput = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "issue-token",
      "--registry",
      registryPath,
      "--endpoint-id",
      "lab-cli",
      "--output",
      existingOutputPath
    ],
    { encoding: "utf8" }
  );
  assert.equal(duplicateOutput.status, 1);
  assert.equal(await readFile(existingOutputPath, "utf8"), "keep-me\n");
  assert.equal((await registry.inspect()).enrollmentTokens.length, 1);
  await pathDoesNotExist(`${tokenOutputPath}.pending`);
  await pathDoesNotExist(`${provisioningOutputPath}.pending`);
});

test("CLI recovers committed token output from .pending without issuing twice", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const outputPath = path.join(directory, "recover-token.json");
  const pendingPath = `${outputPath}.pending`;
  let staged;

  const committed = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-token-recovery",
    ttlSeconds: 300,
    onTokenReady: async (value) => {
      staged = value;
      await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
    }
  });
  assert.equal(staged.tokenId, committed.tokenId);

  const recovered = runCli([
    "issue-token",
    "--registry",
    registryPath,
    "--endpoint-id",
    "lab-token-recovery",
    "--ttl-seconds",
    "300",
    "--output",
    outputPath
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.recovered, true);
  assert.equal(result.registryCommitState, "COMMITTED");
  assert.equal(result.tokenId, committed.tokenId);
  assert.deepEqual(
    JSON.parse(await readFile(outputPath, "utf8")),
    committed
  );
  await pathDoesNotExist(pendingPath);
  assert.equal((await registry.inspect()).enrollmentTokens.length, 1);
});

test("CLI finishes an interrupted hard-link promotion idempotently", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const outputPath = path.join(directory, "linked-token.json");
  const pendingPath = `${outputPath}.pending`;
  const committed = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-linked-recovery",
    ttlSeconds: 300,
    onTokenReady: async (value) => {
      await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
    }
  });
  await link(pendingPath, outputPath);
  assert.equal((await stat(outputPath)).nlink, 2);

  const recovered = runCli([
    "issue-token",
    "--registry",
    registryPath,
    "--endpoint-id",
    committed.qr.enrollmentEndpointId,
    "--output",
    outputPath
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).recovered, true);
  await pathDoesNotExist(pendingPath);
  assert.equal((await stat(outputPath)).nlink, 1);
  assert.deepEqual(
    JSON.parse(await readFile(outputPath, "utf8")),
    committed
  );
  assert.equal((await registry.inspect()).enrollmentTokens.length, 1);
});

test("CLI removes a verified uncommitted .pending token and starts a new transaction", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const outputPath = path.join(directory, "retry-token.json");
  const pendingPath = `${outputPath}.pending`;
  let abandoned;
  const sinkFailure = new Error("simulated crash before registry commit");

  await assert.rejects(
    registry.issueEnrollmentToken({
      enrollmentEndpointId: "lab-token-retry",
      ttlSeconds: 300,
      onTokenReady: async (value) => {
        abandoned = value;
        await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx"
        });
        throw sinkFailure;
      }
    }),
    sinkFailure
  );
  assert.equal((await registry.inspect()).enrollmentTokens.length, 0);

  const retried = runCli([
    "issue-token",
    "--registry",
    registryPath,
    "--endpoint-id",
    "lab-token-retry",
    "--ttl-seconds",
    "300",
    "--output",
    outputPath
  ]);
  assert.equal(retried.status, 0, retried.stderr);
  const replacement = JSON.parse(await readFile(outputPath, "utf8"));
  assert.notEqual(replacement.tokenId, abandoned.tokenId);
  await pathDoesNotExist(pendingPath);
  assert.equal((await registry.inspect()).enrollmentTokens.length, 1);
});

test("CLI preserves .pending and reports UNCERTAIN when registry state cannot be read", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const outputPath = path.join(directory, "uncertain-token.json");
  const pendingPath = `${outputPath}.pending`;
  const sinkFailure = new Error("simulated crash before registry commit");

  await assert.rejects(
    registry.issueEnrollmentToken({
      enrollmentEndpointId: "lab-token-uncertain",
      ttlSeconds: 300,
      onTokenReady: async (value) => {
        await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx"
        });
        throw sinkFailure;
      }
    }),
    sinkFailure
  );
  await chmod(registryPath, 0o644);

  const uncertain = runCli([
    "issue-token",
    "--registry",
    registryPath,
    "--endpoint-id",
    "lab-token-uncertain",
    "--output",
    outputPath
  ]);
  assert.equal(uncertain.status, 1);
  const error = JSON.parse(uncertain.stderr);
  assert.equal(error.code, "REGISTRY_COMMIT_UNCERTAIN");
  assert.equal(error.registryCommitState, "UNCERTAIN");
  assert.equal(error.sensitiveOutputPreserved, pendingPath);
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  await pathDoesNotExist(outputPath);
  await chmod(registryPath, 0o600);
});

test("CLI never promotes a committed token record with a mismatched pending secret", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const outputPath = path.join(directory, "mismatched-token.json");
  const pendingPath = `${outputPath}.pending`;
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-token-secret-match",
    ttlSeconds: 300
  });
  const mismatchedToken = `c6e1_${Buffer.alloc(32, 0xa5).toString("base64url")}`;
  const altered = {
    ...issued,
    qr: { ...issued.qr, token: mismatchedToken }
  };
  altered.qrPayload = JSON.stringify(altered.qr);
  await writeFile(pendingPath, `${JSON.stringify(altered, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });

  const uncertain = runCli([
    "issue-token",
    "--registry",
    registryPath,
    "--endpoint-id",
    issued.qr.enrollmentEndpointId,
    "--output",
    outputPath
  ]);
  assert.equal(uncertain.status, 1);
  const error = JSON.parse(uncertain.stderr);
  assert.equal(error.code, "REGISTRY_COMMIT_UNCERTAIN");
  assert.equal(error.registryCommitState, "UNCERTAIN");
  assert.equal(error.sensitiveOutputPreserved, pendingPath);
  await pathDoesNotExist(outputPath);
  assert.deepEqual(
    JSON.parse(await readFile(pendingPath, "utf8")),
    altered
  );
  assert.equal((await registry.inspect()).enrollmentTokens.length, 1);
});

test("CLI idempotently promotes committed enrollment provisioning from .pending", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const { publicKey } = ed25519KeyPair();
  const publicKeyPath = path.join(directory, "recover-public.pem");
  const tokenPath = path.join(directory, "recover-issued.json");
  const outputPath = path.join(directory, "recover-provisioning.json");
  const pendingPath = `${outputPath}.pending`;
  const nodeId = androidNodeId(9);
  await writeFile(publicKeyPath, publicPem(publicKey), { mode: 0o600 });
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-enrollment-recovery",
    ttlSeconds: 300
  });
  await writeFile(tokenPath, `${JSON.stringify(issued, null, 2)}\n`, {
    mode: 0o600
  });

  const committed = await registry.enrollDevice({
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    publicKey: publicPem(publicKey),
    nodeId,
    onProvisioningReady: async (value) => {
      await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
    }
  });

  const recovered = runCli([
    "enroll",
    "--registry",
    registryPath,
    "--token-file",
    tokenPath,
    "--public-key-file",
    publicKeyPath,
    "--node-id",
    nodeId,
    "--output",
    outputPath
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.recovered, true);
  assert.equal(result.registryCommitState, "COMMITTED");
  assert.equal(result.certificateId, committed.certificateId);
  assert.deepEqual(
    JSON.parse(await readFile(outputPath, "utf8")),
    committed
  );
  await pathDoesNotExist(pendingPath);
  const inspection = await registry.inspect();
  assert.equal(inspection.devices.length, 1);
  assert.equal(inspection.enrollmentTokens[0].status, "CONSUMED");
});

test("CLI rejects symlinked, permissive and structurally altered token files", async (t) => {
  const { directory, registry, registryPath } = await testRegistry(t);
  const { publicKey } = ed25519KeyPair();
  const publicKeyPath = path.join(directory, "validation-public.pem");
  const tokenPath = path.join(directory, "validation-token.json");
  const tokenSymlinkPath = path.join(directory, "validation-token-link.json");
  const outputPath = path.join(directory, "must-not-exist.json");
  const nodeId = androidNodeId(10);
  await writeFile(publicKeyPath, publicPem(publicKey), { mode: 0o600 });
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-file-validation",
    ttlSeconds: 300
  });
  await writeFile(tokenPath, `${JSON.stringify(issued, null, 2)}\n`, {
    mode: 0o600
  });
  await symlink(tokenPath, tokenSymlinkPath);

  const baseArguments = [
    "enroll",
    "--registry",
    registryPath,
    "--public-key-file",
    publicKeyPath,
    "--node-id",
    nodeId,
    "--output",
    outputPath
  ];
  const symlinked = runCli([
    ...baseArguments,
    "--token-file",
    tokenSymlinkPath
  ]);
  assert.equal(symlinked.status, 1);
  assert.equal(JSON.parse(symlinked.stderr).code, "INSECURE_INPUT_FILE");

  await chmod(tokenPath, 0o644);
  const permissive = runCli([...baseArguments, "--token-file", tokenPath]);
  assert.equal(permissive.status, 1);
  assert.equal(JSON.parse(permissive.stderr).code, "INSECURE_INPUT_FILE");

  const altered = { ...issued, unexpected: true };
  await writeFile(tokenPath, `${JSON.stringify(altered, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(tokenPath, 0o600);
  const malformed = runCli([...baseArguments, "--token-file", tokenPath]);
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stderr).code, "INVALID_SENSITIVE_JSON");

  await pathDoesNotExist(outputPath);
  await pathDoesNotExist(`${outputPath}.pending`);
  assert.equal((await registry.inspect()).enrollmentTokens[0].status, "ACTIVE");
});

test("invalid, non-Ed25519 and private keys are rejected without consuming the token", async (t) => {
  const { registry } = await testRegistry(t);
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-invalid-key",
    ttlSeconds: 300
  });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ed25519 = ed25519KeyPair();
  const baseRequest = {
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    nodeId: androidNodeId(8)
  };

  for (const publicKey of [
    "not-a-public-key",
    publicPem(rsa.publicKey),
    ed25519.privateKey.export({ type: "pkcs8", format: "pem" })
  ]) {
    await assert.rejects(
      registry.enrollDevice({ ...baseRequest, publicKey }),
      (error) => error?.code === "INVALID_PUBLIC_KEY"
    );
  }

  const beforeValidEnrollment = await registry.inspect();
  assert.equal(beforeValidEnrollment.enrollmentTokens[0].status, "ACTIVE");
  await registry.enrollDevice({
    ...baseRequest,
    publicKey: publicPem(ed25519.publicKey)
  });
  assert.equal((await registry.inspect()).enrollmentTokens[0].status, "CONSUMED");
});

test("runtime and schema reject non-canonical stored UUID and base64url text", async (t) => {
  const { registry, registryPath } = await testRegistry(t);
  const { publicKey } = ed25519KeyPair();
  const issued = await registry.issueEnrollmentToken({
    enrollmentEndpointId: "lab-canonical-storage",
    ttlSeconds: 300
  });
  const provisioned = await registry.enrollDevice({
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    publicKey: publicPem(publicKey),
    nodeId: "550e8400-e29b-41d4-a716-446655440000"
  });
  const canonicalDocument = JSON.parse(await readFile(registryPath, "utf8"));
  const registrySchema = JSON.parse(
    await readFile(
      new URL("../../contracts/device-registry-v1.schema.json", import.meta.url),
      "utf8"
    )
  );

  const uppercaseDocument = structuredClone(canonicalDocument);
  uppercaseDocument.devices[0].nodeId = provisioned.nodeId.toUpperCase();
  uppercaseDocument.enrollmentTokens[0].consumedByNodeId =
    provisioned.nodeId.toUpperCase();
  assert.equal(
    new RegExp(registrySchema.$defs.uuid.pattern).test(
      uppercaseDocument.devices[0].nodeId
    ),
    false
  );
  assert.throws(() => assertContractSchema(uppercaseDocument, registrySchema));
  await writeFile(
    registryPath,
    `${JSON.stringify(uppercaseDocument, null, 2)}\n`,
    "utf8"
  );
  await assert.rejects(
    registry.inspect(),
    (error) => error?.code === "CORRUPT_REGISTRY"
  );

  const nonCanonicalAliasDocument = structuredClone(canonicalDocument);
  const alias = nonCanonicalAliasDocument.devices[0].aliasKeyBase64url;
  const base64urlAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = base64urlAlphabet.indexOf(alias.at(-1));
  const nonCanonicalAlias = `${alias.slice(0, -1)}${base64urlAlphabet[finalIndex + 1]}`;
  assert.deepEqual(
    Buffer.from(nonCanonicalAlias, "base64url"),
    Buffer.from(alias, "base64url")
  );
  assert.equal(
    new RegExp(
      registrySchema.$defs.device.properties.aliasKeyBase64url.pattern
    ).test(nonCanonicalAlias),
    false
  );
  nonCanonicalAliasDocument.devices[0].aliasKeyBase64url = nonCanonicalAlias;
  assert.throws(() =>
    assertContractSchema(nonCanonicalAliasDocument, registrySchema)
  );
  await writeFile(
    registryPath,
    `${JSON.stringify(nonCanonicalAliasDocument, null, 2)}\n`,
    "utf8"
  );
  await assert.rejects(
    registry.inspect(),
    (error) => error?.code === "CORRUPT_REGISTRY"
  );
});

test("registry operations reject files that are not exactly mode 0600", async (t) => {
  const { registry, registryPath } = await testRegistry(t);
  await chmod(registryPath, 0o644);

  await assert.rejects(
    registry.inspect(),
    (error) => error?.code === "INSECURE_REGISTRY_PERMISSIONS"
  );
  await assert.rejects(
    registry.issueEnrollmentToken({
      enrollmentEndpointId: "lab-permissions",
      ttlSeconds: 60
    }),
    (error) => error?.code === "INSECURE_REGISTRY_PERMISSIONS"
  );
});

test("V6 CLI rejects direct legacy state and hard-linked registries", async (t) => {
  for (const registryPath of [
    "/var/lib/cassav5bt-bluetooth/devices.json",
    "/var/lib/cassav4-bluetooth/devices.json"
  ]) {
    const directLegacy = runCli(["list", "--registry", registryPath]);
    assert.equal(directLegacy.status, 1);
    assert.equal(
      JSON.parse(directLegacy.stderr).code,
      "LEGACY_STATE_FORBIDDEN"
    );
  }

  const { directory, registryPath } = await testRegistry(t);
  const linkedPath = path.join(directory, "devices-linked.json");
  await link(registryPath, linkedPath);
  const hardLinked = runCli([
    "list",
    "--registry",
    linkedPath
  ]);
  assert.equal(hardLinked.status, 1);
  assert.equal(
    JSON.parse(hardLinked.stderr).code,
    "INSECURE_REGISTRY_FILE"
  );
});
