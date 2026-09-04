import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_BITS,
  encodeNodeAdvertisement
} from "../../shared/protocol/advertisement-v1.mjs";
import { PeerDirectoryV1 } from "../../shared/discovery/peer-directory-v1.mjs";
import {
  BluetoothNodeRegistryProjection
} from "../dist/backend/BluetoothNodeRegistryProjection.js";

test("diagnostic projection exposes useful state without aliases, boot IDs or RSSI", () => {
  let now = 1_000;
  const directory = new PeerDirectoryV1({ clock: () => now });
  const full =
    CAPABILITY_BITS.SCAN |
    CAPABILITY_BITS.ADVERTISE |
    CAPABILITY_BITS.GATT_CLIENT |
    CAPABILITY_BITS.GATT_SERVER;
  directory.observeServiceData({
    payload: encodeNodeAdvertisement({
      protocolVersion: 1,
      nodeKind: "handheld",
      rotatingAlias: "001122334455",
      bootId: 17,
      capabilities: full,
      serverReachable: true,
      sequence: 1
    }),
    rssiDbm: -55
  });
  now += 6_000;
  const report = new BluetoothNodeRegistryProjection().project(directory.snapshot());
  assert.deepEqual(report, {
    schemaVersion: 1,
    nodeCount: 1,
    stateCounts: { fresh: 0, aging: 1, expired: 0 },
    nodes: [{
      slot: 1,
      nodeKind: "handheld",
      state: "aging",
      serverReachable: true,
      capabilityClass: "FULL_NODE",
      rssiBucket: "STRONG"
    }],
    privateIdentifiersExposed: false
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("001122334455"), false);
  assert.equal(serialized.includes("bootId"), false);
  assert.equal(serialized.includes("-55"), false);
  assert.equal(serialized.includes("streamKey"), false);
});
