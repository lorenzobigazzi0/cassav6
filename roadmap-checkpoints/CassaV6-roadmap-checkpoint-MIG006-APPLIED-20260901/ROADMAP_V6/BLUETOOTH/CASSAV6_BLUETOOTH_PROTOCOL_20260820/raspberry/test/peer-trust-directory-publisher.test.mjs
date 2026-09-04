import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  LocalPeerTrustAuthoritySignerV1,
  PeerTrustDirectoryPublisherV1
} from "../dist/security/PeerTrustDirectoryPublisherV1.js";
import { verifyPeerTrustDirectoryV1 } from "../../shared/provisioning/peer-trust-directory-v1.mjs";

test("publisher derives only current and next public aliases and enforces revision", async () => {
  const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const peer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const aliases = [];
  const registry = {
    async inspect() {
      return {
        devices: [
          {
            nodeId: "11111111-1111-4111-8111-111111111111",
            certificateId: "22222222-2222-4222-8222-222222222222",
            publicKeyAlgorithm: "EC-P256",
            publicKeySpkiDerBase64: peer.publicKey
              .export({ format: "der", type: "spki" }).toString("base64"),
            revokedAt: null
          }
        ]
      };
    },
    async deriveRotatingAliasForNode(input) {
      aliases.push(input);
      return input.timestampSeconds % 120 === 0
        ? "001122334455"
        : "8899aabbccdd";
    }
  };
  const publisher = new PeerTrustDirectoryPublisherV1({
    registry,
    signer: new LocalPeerTrustAuthoritySignerV1(authority.privateKey),
    issuerId: "raspberry-lab-cassav6"
  });
  const wire = await publisher.publish({
    revision: 7,
    issuedAt: new Date("2026-08-18T10:00:00.000Z"),
    expiresAt: new Date("2026-08-19T10:00:00.000Z")
  });
  const verified = verifyPeerTrustDirectoryV1(wire, authority.publicKey, {
    now: new Date("2026-08-18T12:00:00.000Z")
  });
  assert.equal(verified.devices[0].currentAlias, "001122334455");
  assert.equal(verified.devices[0].nextAlias, "8899aabbccdd");
  assert.equal(aliases.length, 2);
  assert.doesNotMatch(wire.toString("utf8"), /aliasKey/);
  assert.deepEqual(publisher.snapshot(), {
    lastRevision: 7,
    exposesAliasKey: false
  });
  await assert.rejects(
    publisher.publish({
      revision: 7,
      issuedAt: new Date("2026-08-18T10:01:00.000Z"),
      expiresAt: new Date("2026-08-19T10:01:00.000Z")
    }),
    /increase monotonically/
  );
});
