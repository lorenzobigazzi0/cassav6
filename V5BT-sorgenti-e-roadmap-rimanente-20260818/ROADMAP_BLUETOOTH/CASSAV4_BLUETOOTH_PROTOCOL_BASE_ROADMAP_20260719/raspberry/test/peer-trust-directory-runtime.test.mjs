import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPeerTrustDirectoryV1 } from
  "../../shared/provisioning/peer-trust-directory-v1.mjs";
import {
  LocalPeerTrustAuthoritySignerV1
} from "../dist/security/PeerTrustDirectoryPublisherV1.js";
import { PeerTrustDirectoryRuntimeV1 } from
  "../dist/security/PeerTrustDirectoryRuntimeV1.js";
import { PeerTrustPublishedDirectoryStoreV1 } from
  "../dist/security/PeerTrustPublishedDirectoryStoreV1.js";

test("runtime persists one signed revision, reuses it after restart and advances by epoch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v5bt-peer-runtime-"));
  await chmod(root, 0o700);
  const store = new PeerTrustPublishedDirectoryStoreV1(
    path.join(root, "peer-trust.json")
  );
  const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const peer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let now = new Date("2026-08-18T10:00:00.000Z");
  let aliasCalls = 0;
  const registry = {
    async inspect() {
      return {
        devices: [{
          nodeId: "11111111-1111-4111-8111-111111111111",
          certificateId: "22222222-2222-4222-8222-222222222222",
          publicKeyAlgorithm: "EC-P256",
          publicKeySpkiDerBase64: peer.publicKey
            .export({ format: "der", type: "spki" }).toString("base64"),
          revokedAt: null
        }]
      };
    },
    async deriveRotatingAliasForNode(input) {
      aliasCalls += 1;
      return input.timestampSeconds % 120 === 0
        ? "001122334455"
        : "8899aabbccdd";
    }
  };
  const input = {
    registry,
    signer: new LocalPeerTrustAuthoritySignerV1(authority.privateKey),
    authorityPublicKeySpki: authority.publicKey.export({ format: "der", type: "spki" }),
    store,
    issuerId: "raspberry-lab-v5bt",
    clock: () => new Date(now)
  };
  const firstRuntime = new PeerTrustDirectoryRuntimeV1(input);
  const first = await firstRuntime.readCurrentDirectory();
  const same = await firstRuntime.readCurrentDirectory();
  assert.deepEqual(same, first);
  assert.equal(aliasCalls, 2);
  firstRuntime.close();

  const restarted = new PeerTrustDirectoryRuntimeV1(input);
  const recovered = await restarted.readCurrentDirectory();
  assert.deepEqual(recovered, first);
  assert.equal(aliasCalls, 2);
  now = new Date("2026-08-18T10:01:00.000Z");
  const advanced = await restarted.readCurrentDirectory();
  assert.notDeepEqual(advanced, first);
  const oldDirectory = verifyPeerTrustDirectoryV1(first, authority.publicKey, {
    now: new Date("2026-08-18T10:00:01.000Z")
  });
  const newDirectory = verifyPeerTrustDirectoryV1(advanced, authority.publicKey, {
    now
  });
  assert.ok(newDirectory.revision > oldDirectory.revision);
  assert.equal(newDirectory.aliasEpoch, oldDirectory.aliasEpoch + 1);
  assert.equal(aliasCalls, 4);
  restarted.close();
});

test("runtime rejects clock rollback behind the committed directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v5bt-peer-rollback-"));
  await chmod(root, 0o700);
  const store = new PeerTrustPublishedDirectoryStoreV1(path.join(root, "trust.json"));
  const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const peer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let now = new Date("2026-08-18T10:05:00.000Z");
  const registry = {
    async inspect() {
      return { devices: [{
        nodeId: "11111111-1111-4111-8111-111111111111",
        certificateId: "22222222-2222-4222-8222-222222222222",
        publicKeyAlgorithm: "EC-P256",
        publicKeySpkiDerBase64: peer.publicKey
          .export({ format: "der", type: "spki" }).toString("base64"),
        revokedAt: null
      }] };
    },
    async deriveRotatingAliasForNode(input) {
      return input.timestampSeconds % 120 === 0
        ? "001122334455"
        : "8899aabbccdd";
    }
  };
  const createRuntime = () => new PeerTrustDirectoryRuntimeV1({
    registry,
    signer: new LocalPeerTrustAuthoritySignerV1(authority.privateKey),
    authorityPublicKeySpki: authority.publicKey.export({ format: "der", type: "spki" }),
    store,
    issuerId: "raspberry-lab-v5bt",
    clock: () => new Date(now)
  });
  const first = createRuntime();
  await first.readCurrentDirectory();
  first.close();
  now = new Date("2026-08-18T10:03:00.000Z");
  await assert.rejects(createRuntime().readCurrentDirectory(), /clock regressed/);
});
