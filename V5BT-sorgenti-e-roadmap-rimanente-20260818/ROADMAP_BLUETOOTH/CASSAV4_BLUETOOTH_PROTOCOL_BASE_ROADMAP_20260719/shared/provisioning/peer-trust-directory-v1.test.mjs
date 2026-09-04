import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  PeerTrustDirectoryV1Error,
  derivePeerTrustIdV1,
  encodePeerTrustDirectoryV1,
  isPeerTrustIdV1,
  signPeerTrustDirectoryV1,
  verifyPeerTrustDirectoryV1
} from "./peer-trust-directory-v1.mjs";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const AUTHORITY = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const DEVICE = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function unsigned(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "cassav5bt.bluetooth.peer-trust-directory",
    issuerId: "raspberry-lab-v5bt",
    revision: 42,
    issuedAt: "2026-08-18T10:00:00.000Z",
    expiresAt: "2026-08-19T10:00:00.000Z",
    aliasEpoch: 2_977_320,
    authorityKeyId: "0".repeat(64),
    signatureAlgorithm: "ECDSA-P256-SHA256-P1363",
    devices: [
      {
        nodeId: "11111111-1111-4111-8111-111111111111",
        certificateId: "22222222-2222-4222-8222-222222222222",
        publicKeyAlgorithm: "EC-P256",
        publicKeySpkiDerBase64: DEVICE.publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
        status: "ACTIVE",
        currentAlias: "001122334455",
        nextAlias: "8899aabbccdd"
      }
    ],
    ...overrides
  };
}

function signed(overrides = {}) {
  return signPeerTrustDirectoryV1(unsigned(overrides), AUTHORITY.privateKey);
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof PeerTrustDirectoryV1Error);
    assert.equal(error.code, code);
    return true;
  });
}

test("signed directory carries public trust and current/next aliases but no alias key", () => {
  const wire = encodePeerTrustDirectoryV1(signed());
  const verified = verifyPeerTrustDirectoryV1(wire, AUTHORITY.publicKey, {
    now: NOW
  });
  assert.equal(verified.revision, 42);
  assert.equal(verified.devices[0].status, "ACTIVE");
  assert.equal(verified.devices[0].nextAlias, "8899aabbccdd");
  assert.doesNotMatch(wire.toString("utf8"), /aliasKey|privateKey|token/i);
});

test("tamper, wrong authority, expiry and revision rollback fail closed", () => {
  const wire = encodePeerTrustDirectoryV1(signed());
  const tampered = Buffer.from(wire);
  tampered[tampered.indexOf(Buffer.from("00112233"))] ^= 1;
  expectCode("SIGNATURE_INVALID", () =>
    verifyPeerTrustDirectoryV1(tampered, AUTHORITY.publicKey, { now: NOW })
  );
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  expectCode("AUTHORITY_KEY_MISMATCH", () =>
    verifyPeerTrustDirectoryV1(wire, other.publicKey, { now: NOW })
  );
  expectCode("DIRECTORY_EXPIRED", () =>
    verifyPeerTrustDirectoryV1(wire, AUTHORITY.publicKey, {
      now: new Date("2026-08-19T10:00:00.000Z")
    })
  );
  expectCode("REVISION_ROLLBACK", () =>
    verifyPeerTrustDirectoryV1(wire, AUTHORITY.publicKey, {
      now: NOW,
      minimumRevision: 43
    })
  );
});

test("canonical wire rejects whitespace, duplicate fields and reordered devices", () => {
  const wire = encodePeerTrustDirectoryV1(signed());
  expectCode("NON_CANONICAL_WIRE", () =>
    verifyPeerTrustDirectoryV1(Buffer.concat([wire, Buffer.from("\n")]), AUTHORITY.publicKey, {
      now: NOW
    })
  );
  expectCode("NON_CANONICAL_WIRE", () =>
    verifyPeerTrustDirectoryV1(
      Buffer.from(wire.toString("utf8").replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1')),
      AUTHORITY.publicKey,
      { now: NOW }
    )
  );
  const second = {
    ...unsigned().devices[0],
    nodeId: "33333333-3333-4333-8333-333333333333",
    certificateId: "44444444-4444-4444-8444-444444444444",
    publicKeySpkiDerBase64: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
  expectCode("NON_CANONICAL_ORDER", () =>
    signPeerTrustDirectoryV1(
      unsigned({ devices: [second, unsigned().devices[0]] }),
      AUTHORITY.privateKey
    )
  );
});

test("revoked entries disclose no rotating aliases", () => {
  const revoked = {
    ...unsigned().devices[0],
    status: "REVOKED",
    currentAlias: null,
    nextAlias: null
  };
  const wire = encodePeerTrustDirectoryV1(signed({ devices: [revoked] }));
  const verified = verifyPeerTrustDirectoryV1(wire, AUTHORITY.publicKey, { now: NOW });
  assert.equal(verified.devices[0].status, "REVOKED");
  expectCode("INVALID_ALIAS", () =>
    signed({ devices: [{ ...revoked, currentAlias: "001122334455" }] })
  );
});

test("peerTrustId is a stable identity commitment and not an alias commitment", () => {
  const device = unsigned().devices[0];
  const spki = Buffer.from(device.publicKeySpkiDerBase64, "base64");
  const trustId = derivePeerTrustIdV1(
    device.nodeId,
    device.certificateId,
    device.publicKeyAlgorithm,
    spki
  );
  assert.equal(isPeerTrustIdV1(trustId), true);
  assert.equal(trustId.length, 64);
  assert.equal(
    derivePeerTrustIdV1(
      device.nodeId,
      device.certificateId,
      device.publicKeyAlgorithm,
      spki
    ),
    trustId
  );
  assert.equal(isPeerTrustIdV1(trustId.toUpperCase()), false);
});
