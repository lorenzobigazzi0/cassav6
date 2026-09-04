import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AndroidPeerAuthKeyScheduleV2,
  buildAndroidPeerAuthTranscriptHashV2,
  buildAndroidPeerClientSignatureMessageV2,
  buildAndroidPeerServerSignatureMessageV2,
  encodeAndroidPeerClientFinishV2,
  encodeAndroidPeerClientInitV2,
  encodeAndroidPeerServerReplyV2,
  verifyAndroidPeerIdentitySignatureV2
} from "./android-peer-auth-v2.mjs";
import {
  derivePeerTrustIdV1,
  verifyPeerTrustDirectoryV1
} from "../provisioning/peer-trust-directory-v1.mjs";

const vectorPath = new URL(
  "../../contracts/golden-vectors/peer-trust-a2-v1.json",
  import.meta.url
);

function bytes(value, encoding = "base64") {
  return Buffer.from(value, encoding);
}

test("peer trust directory and A2 golden vector remain interoperable", () => {
  const vector = JSON.parse(readFileSync(vectorPath, "utf8"));
  const directoryWire = bytes(vector.directoryWireBase64);
  const authorityPublicKey = bytes(vector.authorityPublicKeySpkiBase64);
  const directory = verifyPeerTrustDirectoryV1(
    directoryWire,
    authorityPublicKey,
    { now: new Date("2026-08-18T12:00:00.000Z") }
  );
  assert.equal(directory.revision, 42);
  assert.equal(directory.devices.length, 2);
  assert.equal(
    derivePeerTrustIdV1(
      directory.devices[0].nodeId,
      directory.devices[0].certificateId,
      directory.devices[0].publicKeyAlgorithm,
      bytes(directory.devices[0].publicKeySpkiDerBase64)
    ),
    vector.clientPeerTrustId
  );
  assert.equal(
    derivePeerTrustIdV1(
      directory.devices[1].nodeId,
      directory.devices[1].certificateId,
      directory.devices[1].publicKeyAlgorithm,
      bytes(directory.devices[1].publicKeySpkiDerBase64)
    ),
    vector.serverPeerTrustId
  );

  const a2 = vector.a2;
  const clientEphemeral = bytes(a2.clientEphemeralSpkiBase64);
  const serverEphemeral = bytes(a2.serverEphemeralSpkiBase64);
  const clientSignature = bytes(a2.clientSignatureBase64);
  const serverSignature = bytes(a2.serverSignatureBase64);
  const serverConfirmation = bytes(a2.serverConfirmationHex, "hex");
  const clientConfirmation = bytes(a2.clientConfirmationHex, "hex");
  const clientMessage = buildAndroidPeerClientSignatureMessageV2(
    a2.binding,
    clientEphemeral
  );
  assert.equal(
    verifyAndroidPeerIdentitySignatureV2(
      "EC-P256",
      bytes(a2.clientIdentityPublicKeySpkiBase64),
      clientMessage,
      clientSignature
    ),
    true
  );
  const serverMessage = buildAndroidPeerServerSignatureMessageV2(
    a2.binding,
    clientEphemeral,
    clientSignature,
    serverEphemeral
  );
  assert.equal(
    verifyAndroidPeerIdentitySignatureV2(
      "EC-P256",
      bytes(a2.serverIdentityPublicKeySpkiBase64),
      serverMessage,
      serverSignature
    ),
    true
  );
  const transcript = buildAndroidPeerAuthTranscriptHashV2(
    a2.binding,
    clientEphemeral,
    clientSignature,
    serverEphemeral,
    serverSignature
  );
  assert.equal(transcript.toString("hex"), a2.transcriptHashHex);

  const schedule = new AndroidPeerAuthKeyScheduleV2(
    bytes(a2.sharedSecretHex, "hex"),
    transcript
  );
  assert.equal(
    schedule.createServerConfirmation().toString("hex"),
    a2.serverConfirmationHex
  );
  assert.equal(schedule.verifyServerConfirmation(serverConfirmation), true);
  assert.equal(
    schedule.createClientConfirmation(serverConfirmation).toString("hex"),
    a2.clientConfirmationHex
  );
  assert.equal(
    schedule.verifyClientConfirmation(serverConfirmation, clientConfirmation),
    true
  );
  const keys = schedule.exportReliableChannelControlKeys();
  assert.equal(
    keys.clientToServerControlKey.toString("hex"),
    a2.clientToServerControlKeyHex
  );
  assert.equal(
    keys.serverToClientControlKey.toString("hex"),
    a2.serverToClientControlKeyHex
  );

  assert.equal(
    encodeAndroidPeerClientInitV2({
      sessionId: a2.binding.clientHello.sessionId,
      clientCertificateId: a2.binding.clientCertificateId,
      serverCertificateId: a2.binding.serverCertificateId,
      clientEphemeralSpki: clientEphemeral,
      clientSignature
    }).toString("base64"),
    a2.clientInitWireBase64
  );
  assert.equal(
    encodeAndroidPeerServerReplyV2({
      sessionId: a2.binding.clientHello.sessionId,
      clientCertificateId: a2.binding.clientCertificateId,
      serverCertificateId: a2.binding.serverCertificateId,
      serverEphemeralSpki: serverEphemeral,
      serverSignature,
      serverConfirmation
    }).toString("base64"),
    a2.serverReplyWireBase64
  );
  assert.equal(
    encodeAndroidPeerClientFinishV2({
      sessionId: a2.binding.clientHello.sessionId,
      clientConfirmation
    }).toString("base64"),
    a2.clientFinishWireBase64
  );
  schedule.close();
});
