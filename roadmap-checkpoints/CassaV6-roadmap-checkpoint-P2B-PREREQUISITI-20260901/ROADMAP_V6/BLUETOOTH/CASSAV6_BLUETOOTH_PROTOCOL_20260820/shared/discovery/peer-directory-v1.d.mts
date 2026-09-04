import type { NodeAdvertisementV1 } from "../protocol/advertisement-v1.mjs";

export const PEER_SOFT_STATES: Readonly<{
  FRESH: "fresh";
  AGING: "aging";
  EXPIRED: "expired";
}>;

export interface PeerViewV1 {
  readonly streamKey: string;
  readonly advertisement: Readonly<NodeAdvertisementV1>;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  readonly lastRssiDbm: number;
  readonly acceptedObservations: number;
  readonly semanticGeneration: number;
  readonly ageMs: number;
  readonly state: "fresh" | "aging" | "expired";
}

export interface PeerObservationResultV1 {
  readonly accepted: boolean;
  readonly outcome: string;
  readonly streamKey?: string;
  readonly peer?: PeerViewV1;
  readonly protocolErrorCode?: string;
}

export interface PeerDirectorySnapshotV1 {
  readonly observedAtMs: number;
  readonly streamCount: number;
  readonly stateCounts: Readonly<{
    fresh: number;
    aging: number;
    expired: number;
  }>;
  readonly peers: readonly PeerViewV1[];
}

export interface PeerPruneResultV1 {
  readonly prunedAtMs: number;
  readonly removed: number;
  readonly remaining: number;
  readonly removedStreamKeys: readonly string[];
}

export interface PeerDirectoryOptionsV1 {
  clock?: () => number;
  maxStreams?: number;
  pruneIntervalMs?: number;
  newStreamWindowMs?: number;
  maxNewStreamAttemptsPerWindow?: number;
  replacementRssiMarginDb?: number;
}

export class PeerDirectoryV1 {
  constructor(options?: PeerDirectoryOptionsV1);
  readonly size: number;
  observeServiceData(observation: {
    payload: Uint8Array;
    rssiDbm: number;
  }): PeerObservationResultV1;
  snapshot(): PeerDirectorySnapshotV1;
  pruneExpired(): PeerPruneResultV1;
  metrics(): Readonly<Record<string, number>>;
}
