import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CAPABILITY_BITS } from "../protocol/advertisement-v1.mjs";
import {
  ANDROID_PEER_ROLES_V1,
  AndroidPeerRoleElectionError,
  electAndroidPeerRolesV1,
  orderedAndroidNodePairV1,
  selectCanonicalAndroidPeerConnectionV1
} from "./android-peer-role-election-v1.mjs";

const FULL =
  CAPABILITY_BITS.SCAN |
  CAPABILITY_BITS.ADVERTISE |
  CAPABILITY_BITS.GATT_CLIENT |
  CAPABILITY_BITS.GATT_SERVER;
const A = "123e4567-e89b-42d3-a456-426614174000";
const B = "223e4567-e89b-42d3-a456-426614174000";
const GOLDEN = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/golden-vectors/android-peer-role-election-v1.json",
      import.meta.url
    ),
    "utf8"
  )
);

test("shared role election and arbitration consume the common golden vectors", () => {
  assert.equal(GOLDEN.schemaVersion, 1);
  assert.equal(GOLDEN.fullNodeCapabilities, FULL);
  for (const vector of GOLDEN.roleCases) {
    const operation = () => electAndroidPeerRolesV1({
      local: {
        aliasEpoch: vector.localAliasEpoch,
        rotatingAlias: vector.localAlias,
        capabilities: vector.localCapabilities
      },
      remote: {
        aliasEpoch: vector.remoteAliasEpoch,
        rotatingAlias: vector.remoteAlias,
        capabilities: vector.remoteCapabilities
      }
    });
    if (vector.expectedError !== null) {
      assert.throws(
        operation,
        (error) =>
          error instanceof AndroidPeerRoleElectionError &&
          error.code === vector.expectedError,
        vector.name
      );
      continue;
    }
    assert.equal(
      operation().localRole.replace("GATT_", ""),
      vector.expectedLocalRole,
      vector.name
    );
  }
  for (const vector of GOLDEN.arbitrationCases) {
    const result = selectCanonicalAndroidPeerConnectionV1({
      localNodeId: vector.firstNodeId,
      remoteNodeId: vector.secondNodeId,
      candidates: [
        {
          connectionId: vector.existingConnectionIdHex,
          initiatorNodeId: vector.firstNodeId,
          responderNodeId: vector.secondNodeId
        },
        {
          connectionId: vector.candidateConnectionIdHex,
          initiatorNodeId: vector.secondNodeId,
          responderNodeId: vector.firstNodeId
        }
      ]
    });
    assert.equal(
      result.keepConnectionId,
      vector.expectedKeepConnectionIdHex,
      vector.name
    );
  }
});

test("same-epoch FULL_NODE aliases elect exactly one server", () => {
  const first = electAndroidPeerRolesV1({
    local: { aliasEpoch: 10, rotatingAlias: "001122334455", capabilities: FULL },
    remote: { aliasEpoch: 10, rotatingAlias: "ffeeddccbbaa", capabilities: FULL }
  });
  const second = electAndroidPeerRolesV1({
    local: { aliasEpoch: 10, rotatingAlias: "ffeeddccbbaa", capabilities: FULL },
    remote: { aliasEpoch: 10, rotatingAlias: "001122334455", capabilities: FULL }
  });
  assert.equal(first.localRole, ANDROID_PEER_ROLES_V1.GATT_SERVER);
  assert.equal(first.localShouldInitiate, false);
  assert.equal(second.localRole, ANDROID_PEER_ROLES_V1.GATT_CLIENT);
  assert.equal(second.localShouldInitiate, true);
});

test("CLIENT_ONLY is fail closed even when the peer is FULL_NODE", () => {
  for (const [localCapabilities, remoteCapabilities] of [
    [CAPABILITY_BITS.SCAN | CAPABILITY_BITS.GATT_CLIENT, FULL],
    [FULL, CAPABILITY_BITS.SCAN | CAPABILITY_BITS.GATT_CLIENT],
    [CAPABILITY_BITS.GATT_CLIENT, CAPABILITY_BITS.GATT_CLIENT]
  ]) {
    assert.throws(
      () => electAndroidPeerRolesV1({
        local: {
          aliasEpoch: 4,
          rotatingAlias: "112233445566",
          capabilities: localCapabilities
        },
        remote: {
          aliasEpoch: 4,
          rotatingAlias: "665544332211",
          capabilities: remoteCapabilities
        }
      }),
      (error) =>
        error instanceof AndroidPeerRoleElectionError &&
        error.code === "CLIENT_ONLY_NOT_ELIGIBLE"
    );
  }
});

test("epoch mismatch and alias collision never guess a role", () => {
  for (const remote of [
    { aliasEpoch: 11, rotatingAlias: "ffeeddccbbaa", capabilities: FULL },
    { aliasEpoch: 10, rotatingAlias: "001122334455", capabilities: FULL }
  ]) {
    assert.throws(
      () => electAndroidPeerRolesV1({
        local: { aliasEpoch: 10, rotatingAlias: "001122334455", capabilities: FULL },
        remote
      }),
      AndroidPeerRoleElectionError
    );
  }
});

test("ordered node pair resolves duplicate opposite-direction connections", () => {
  assert.deepEqual(orderedAndroidNodePairV1(B, A), [A, B]);
  const result = selectCanonicalAndroidPeerConnectionV1({
    localNodeId: A,
    remoteNodeId: B,
    candidates: [
      { connectionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", initiatorNodeId: A, responderNodeId: B },
      { connectionId: "cccccccccccccccccccccccccccccccc", initiatorNodeId: B, responderNodeId: A },
      { connectionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", initiatorNodeId: B, responderNodeId: A }
    ]
  });
  assert.equal(result.keepConnectionId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(result.closeConnectionIds, [
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "cccccccccccccccccccccccccccccccc"
  ]);
});

test("duplicate arbitration keeps the lowest connection id regardless of direction", () => {
  const result = selectCanonicalAndroidPeerConnectionV1({
    localNodeId: A,
    remoteNodeId: B,
    candidates: [
      {
        connectionId: "00000000000000000000000000000001",
        initiatorNodeId: A,
        responderNodeId: B
      },
      {
        connectionId: "ffffffffffffffffffffffffffffffff",
        initiatorNodeId: B,
        responderNodeId: A
      }
    ]
  });
  assert.equal(result.keepConnectionId, "00000000000000000000000000000001");
  assert.deepEqual(result.closeConnectionIds, [
    "ffffffffffffffffffffffffffffffff"
  ]);
});

test("a single established connection is retained even when direction is nonpreferred", () => {
  const result = selectCanonicalAndroidPeerConnectionV1({
    localNodeId: A,
    remoteNodeId: B,
    candidates: [
      { connectionId: "dddddddddddddddddddddddddddddddd", initiatorNodeId: A, responderNodeId: B }
    ]
  });
  assert.equal(result.keepConnectionId, "dddddddddddddddddddddddddddddddd");
  assert.deepEqual(result.closeConnectionIds, []);
});
