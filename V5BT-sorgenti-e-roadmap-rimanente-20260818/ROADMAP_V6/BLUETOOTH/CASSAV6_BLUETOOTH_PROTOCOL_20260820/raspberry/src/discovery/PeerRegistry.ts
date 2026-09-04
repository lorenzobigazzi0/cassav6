import {
  PeerDirectoryV1,
  type PeerDirectoryOptionsV1,
  type PeerDirectorySnapshotV1,
  type PeerObservationResultV1,
  type PeerPruneResultV1
} from "../../../shared/discovery/peer-directory-v1.mjs";

export class PeerRegistry {
  readonly #directory: PeerDirectoryV1;

  constructor(options: PeerDirectoryOptionsV1 = {}) {
    this.#directory = new PeerDirectoryV1(options);
  }

  get size(): number {
    return this.#directory.size;
  }

  observe(
    payload: Uint8Array,
    rssiDbm: number
  ): PeerObservationResultV1 {
    return this.#directory.observeServiceData({ payload, rssiDbm });
  }

  snapshot(): PeerDirectorySnapshotV1 {
    return this.#directory.snapshot();
  }

  pruneExpired(): PeerPruneResultV1 {
    return this.#directory.pruneExpired();
  }

  metrics(): Readonly<Record<string, number>> {
    return this.#directory.metrics();
  }
}
