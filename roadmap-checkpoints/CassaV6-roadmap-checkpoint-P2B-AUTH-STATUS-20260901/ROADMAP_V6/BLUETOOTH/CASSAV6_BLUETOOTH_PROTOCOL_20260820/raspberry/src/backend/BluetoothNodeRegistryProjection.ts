import { CAPABILITY_BITS } from "../../../shared/protocol/advertisement-v1.mjs";
import type { PeerDirectorySnapshotV1 } from "../../../shared/discovery/peer-directory-v1.mjs";

export const BLUETOOTH_NODE_PROJECTION_VERSION = 1;

function capabilityClass(capabilities: number): "FULL_NODE" | "CLIENT_ONLY" | "OTHER" {
  const fullMask =
    CAPABILITY_BITS.SCAN |
    CAPABILITY_BITS.ADVERTISE |
    CAPABILITY_BITS.GATT_CLIENT |
    CAPABILITY_BITS.GATT_SERVER;
  if ((capabilities & fullMask) === fullMask) return "FULL_NODE";
  if (
    (capabilities & CAPABILITY_BITS.GATT_CLIENT) !== 0 &&
    (capabilities & CAPABILITY_BITS.GATT_SERVER) === 0
  ) {
    return "CLIENT_ONLY";
  }
  return "OTHER";
}

function rssiBucket(rssiDbm: number): "STRONG" | "MEDIUM" | "WEAK" {
  if (rssiDbm >= -60) return "STRONG";
  if (rssiDbm >= -75) return "MEDIUM";
  return "WEAK";
}

export class BluetoothNodeRegistryProjection {
  project(snapshot: PeerDirectorySnapshotV1): Readonly<{
    schemaVersion: 1;
    nodeCount: number;
    stateCounts: Readonly<{ fresh: number; aging: number; expired: number }>;
    nodes: readonly Readonly<{
      slot: number;
      nodeKind: "raspberry" | "handheld" | "station";
      state: "fresh" | "aging" | "expired";
      serverReachable: boolean;
      capabilityClass: "FULL_NODE" | "CLIENT_ONLY" | "OTHER";
      rssiBucket: "STRONG" | "MEDIUM" | "WEAK";
    }>[];
    privateIdentifiersExposed: false;
  }> {
    const rows = snapshot.peers
      .map((peer) => ({
        nodeKind: peer.advertisement.nodeKind,
        state: peer.state,
        serverReachable: peer.advertisement.serverReachable,
        capabilityClass: capabilityClass(peer.advertisement.capabilities),
        rssiBucket: rssiBucket(peer.lastRssiDbm)
      }))
      .sort((left, right) =>
        [
          left.nodeKind,
          left.state,
          String(left.serverReachable),
          left.capabilityClass,
          left.rssiBucket
        ].join(":").localeCompare(
          [
            right.nodeKind,
            right.state,
            String(right.serverReachable),
            right.capabilityClass,
            right.rssiBucket
          ].join(":")
        )
      )
      .map((row, index) => Object.freeze({ slot: index + 1, ...row }));
    return Object.freeze({
      schemaVersion: BLUETOOTH_NODE_PROJECTION_VERSION,
      nodeCount: rows.length,
      stateCounts: Object.freeze({ ...snapshot.stateCounts }),
      nodes: Object.freeze(rows),
      privateIdentifiersExposed: false
    });
  }
}
