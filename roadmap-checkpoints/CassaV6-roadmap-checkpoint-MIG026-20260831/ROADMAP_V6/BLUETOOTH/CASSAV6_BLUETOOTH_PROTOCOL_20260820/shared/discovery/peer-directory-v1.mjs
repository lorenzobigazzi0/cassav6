import {
  ADVERTISEMENT_SEQUENCE_RELATIONS,
  ProtocolValidationError,
  compareAdvertisementSequence,
  decodeNodeAdvertisement
} from "../protocol/advertisement-v1.mjs";

export const PEER_RSSI_FLOOR_DBM = -88;
export const PEER_FRESH_BEFORE_MS = 5_000;
export const PEER_AGING_THROUGH_MS = 15_000;
export const MAX_PEER_STREAMS = 1_024;
export const PEER_PRUNE_INTERVAL_MS = 1_000;
export const PEER_NEW_STREAM_WINDOW_MS = 10_000;
export const MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW = 2_048;
export const PEER_REPLACEMENT_RSSI_MARGIN_DB = 6;

export const PEER_SOFT_STATES = Object.freeze({
  FRESH: "fresh",
  AGING: "aging",
  EXPIRED: "expired"
});

export const PEER_OBSERVATION_OUTCOMES = Object.freeze({
  INSERTED: "inserted",
  DUPLICATE_REFRESHED: "duplicate-refreshed",
  NEWER_REPLACED: "newer-replaced",
  BELOW_RSSI_FLOOR: "below-rssi-floor",
  INVALID_OBSERVATION: "invalid-observation",
  INVALID_PAYLOAD: "invalid-payload",
  SEQUENCE_CONFLICT: "sequence-conflict",
  OLDER_REJECTED: "older-rejected",
  AMBIGUOUS_REJECTED: "ambiguous-rejected",
  CAPACITY_REJECTED: "capacity-rejected",
  NEW_STREAM_RATE_REJECTED: "new-stream-rate-rejected",
  CAPACITY_EVICTED_INSERTED: "capacity-evicted-inserted"
});

export class DiscoveryStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiscoveryStateError";
    this.code = code;
  }
}

function defaultMonotonicClock() {
  const now = globalThis.performance?.now?.();
  if (!Number.isFinite(now)) {
    throw new DiscoveryStateError(
      "MONOTONIC_CLOCK_UNAVAILABLE",
      "a monotonic clock must be supplied"
    );
  }
  return now;
}

function freezeResult(value) {
  return Object.freeze(value);
}

function sameAdvertisementSemantics(left, right) {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.nodeKind === right.nodeKind &&
    left.rotatingAlias === right.rotatingAlias &&
    left.bootId === right.bootId &&
    left.capabilities === right.capabilities &&
    left.serverReachable === right.serverReachable &&
    left.sequence === right.sequence
  );
}

export function peerStreamKey({ rotatingAlias, bootId }) {
  return `${rotatingAlias}:${bootId}`;
}

export function classifyPeerAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    throw new DiscoveryStateError(
      "INVALID_PEER_AGE",
      "peer age must be a finite, non-negative number"
    );
  }
  if (ageMs < PEER_FRESH_BEFORE_MS) {
    return PEER_SOFT_STATES.FRESH;
  }
  if (ageMs <= PEER_AGING_THROUGH_MS) {
    return PEER_SOFT_STATES.AGING;
  }
  return PEER_SOFT_STATES.EXPIRED;
}

function peerView(peer, nowMs) {
  const ageMs = nowMs - peer.lastSeenMs;
  return freezeResult({
    streamKey: peer.streamKey,
    advertisement: peer.advertisement,
    firstSeenMs: peer.firstSeenMs,
    lastSeenMs: peer.lastSeenMs,
    lastRssiDbm: peer.lastRssiDbm,
    acceptedObservations: peer.acceptedObservations,
    semanticGeneration: peer.semanticGeneration,
    ageMs,
    state: classifyPeerAge(ageMs)
  });
}

function initialMetrics() {
  return {
    observationsTotal: 0,
    acceptedTotal: 0,
    rejectedTotal: 0,
    insertedTotal: 0,
    duplicateRefreshedTotal: 0,
    newerReplacedTotal: 0,
    belowRssiFloorTotal: 0,
    invalidObservationTotal: 0,
    invalidPayloadTotal: 0,
    sequenceConflictTotal: 0,
    olderRejectedTotal: 0,
    ambiguousRejectedTotal: 0,
    capacityRejectedTotal: 0,
    newStreamRateRejectedTotal: 0,
    capacityEvictedTotal: 0,
    newStreamAttemptsTotal: 0,
    newStreamAdmissionsTotal: 0,
    newStreamWindowsStartedTotal: 0,
    expiredRemovedTotal: 0,
    prunePassesTotal: 0,
    clockRegressionTotal: 0,
    capacityHighWatermarkStreams: 0
  };
}

export class PeerDirectoryV1 {
  #clock;
  #lastClockMs;
  #maxNewStreamAttemptsPerWindow;
  #maxStreams;
  #newStreamAttemptsInWindow = 0;
  #newStreamWindowMs;
  #newStreamWindowStartedAtMs = null;
  #nextPruneAtMs = null;
  #peers = new Map();
  #pruneIntervalMs;
  #replacementRssiMarginDb;
  #metrics = initialMetrics();

  constructor({
    clock = defaultMonotonicClock,
    maxStreams = MAX_PEER_STREAMS,
    pruneIntervalMs = PEER_PRUNE_INTERVAL_MS,
    newStreamWindowMs = PEER_NEW_STREAM_WINDOW_MS,
    maxNewStreamAttemptsPerWindow =
      MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW,
    replacementRssiMarginDb = PEER_REPLACEMENT_RSSI_MARGIN_DB
  } = {}) {
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    if (
      !Number.isSafeInteger(maxStreams) ||
      maxStreams <= 0 ||
      maxStreams > MAX_PEER_STREAMS
    ) {
      throw new TypeError(`maxStreams must be from 1 to ${MAX_PEER_STREAMS}`);
    }
    if (
      !Number.isSafeInteger(pruneIntervalMs) ||
      pruneIntervalMs <= 0 ||
      pruneIntervalMs > PEER_AGING_THROUGH_MS
    ) {
      throw new TypeError(
        `pruneIntervalMs must be from 1 to ${PEER_AGING_THROUGH_MS}`
      );
    }
    if (
      !Number.isSafeInteger(newStreamWindowMs) ||
      newStreamWindowMs <= 0 ||
      newStreamWindowMs > 60_000
    ) {
      throw new TypeError("newStreamWindowMs must be from 1 to 60000");
    }
    if (
      !Number.isSafeInteger(maxNewStreamAttemptsPerWindow) ||
      maxNewStreamAttemptsPerWindow < maxStreams ||
      maxNewStreamAttemptsPerWindow > MAX_PEER_STREAMS * 16
    ) {
      throw new TypeError(
        `maxNewStreamAttemptsPerWindow must be from maxStreams to ${MAX_PEER_STREAMS * 16}`
      );
    }
    if (
      !Number.isFinite(replacementRssiMarginDb) ||
      replacementRssiMarginDb < 0 ||
      replacementRssiMarginDb > 100
    ) {
      throw new TypeError(
        "replacementRssiMarginDb must be a finite number from 0 to 100"
      );
    }
    this.#clock = clock;
    this.#lastClockMs = null;
    this.#maxStreams = maxStreams;
    this.#pruneIntervalMs = pruneIntervalMs;
    this.#newStreamWindowMs = newStreamWindowMs;
    this.#maxNewStreamAttemptsPerWindow =
      maxNewStreamAttemptsPerWindow;
    this.#replacementRssiMarginDb = replacementRssiMarginDb;
  }

  get size() {
    return this.#peers.size;
  }

  #readNow() {
    const nowMs = this.#clock();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new DiscoveryStateError(
        "INVALID_MONOTONIC_CLOCK",
        "monotonic clock must return a finite, non-negative number"
      );
    }
    if (this.#lastClockMs !== null && nowMs < this.#lastClockMs) {
      this.#metrics.clockRegressionTotal += 1;
      throw new DiscoveryStateError(
        "MONOTONIC_CLOCK_REGRESSION",
        `monotonic clock moved backwards from ${this.#lastClockMs} to ${nowMs}`
      );
    }
    this.#lastClockMs = nowMs;
    return nowMs;
  }

  #reject(outcome, metricName, details = {}) {
    this.#metrics.rejectedTotal += 1;
    this.#metrics[metricName] += 1;
    return freezeResult({
      accepted: false,
      outcome,
      ...details
    });
  }

  #removeExpiredAt(nowMs) {
    this.#metrics.prunePassesTotal += 1;
    const removedKeys = [];
    for (const [key, peer] of this.#peers) {
      if (
        classifyPeerAge(nowMs - peer.lastSeenMs) !== PEER_SOFT_STATES.EXPIRED
      ) {
        break;
      }
      this.#peers.delete(key);
      removedKeys.push(key);
    }
    this.#metrics.expiredRemovedTotal += removedKeys.length;
    return removedKeys;
  }

  #maybeRemoveExpiredAt(nowMs) {
    if (
      this.#nextPruneAtMs !== null &&
      nowMs < this.#nextPruneAtMs
    ) {
      return [];
    }
    const removedKeys = this.#removeExpiredAt(nowMs);
    this.#nextPruneAtMs = nowMs + this.#pruneIntervalMs;
    return removedKeys;
  }

  #canProcessNewStreamAttempt(nowMs) {
    if (
      this.#newStreamWindowStartedAtMs === null ||
      nowMs - this.#newStreamWindowStartedAtMs >= this.#newStreamWindowMs
    ) {
      this.#newStreamWindowStartedAtMs = nowMs;
      this.#newStreamAttemptsInWindow = 0;
      this.#metrics.newStreamWindowsStartedTotal += 1;
    }
    if (
      this.#newStreamAttemptsInWindow >=
      this.#maxNewStreamAttemptsPerWindow
    ) {
      return false;
    }
    this.#newStreamAttemptsInWindow += 1;
    this.#metrics.newStreamAttemptsTotal += 1;
    return true;
  }

  #oldestPeer() {
    const next = this.#peers.values().next();
    return next.done ? null : next.value;
  }

  #selectReplacementCandidate(nowMs, incomingRssiDbm) {
    const candidate = this.#oldestPeer();
    if (candidate === null) {
      return null;
    }
    const candidateState = classifyPeerAge(nowMs - candidate.lastSeenMs);
    const incomingIsStronger =
      incomingRssiDbm >=
      candidate.lastRssiDbm + this.#replacementRssiMarginDb;
    return candidateState === PEER_SOFT_STATES.AGING || incomingIsStronger
      ? candidate
      : null;
  }

  observeServiceData(observation) {
    const nowMs = this.#readNow();
    this.#metrics.observationsTotal += 1;

    if (
      observation === null ||
      typeof observation !== "object" ||
      Array.isArray(observation)
    ) {
      return this.#reject(
        PEER_OBSERVATION_OUTCOMES.INVALID_OBSERVATION,
        "invalidObservationTotal"
      );
    }

    let advertisement;
    try {
      advertisement = decodeNodeAdvertisement(observation.payload);
    } catch (error) {
      if (!(error instanceof ProtocolValidationError)) {
        throw error;
      }
      return this.#reject(
        PEER_OBSERVATION_OUTCOMES.INVALID_PAYLOAD,
        "invalidPayloadTotal",
        { protocolErrorCode: error.code }
      );
    }

    if (!Number.isFinite(observation.rssiDbm)) {
      return this.#reject(
        PEER_OBSERVATION_OUTCOMES.INVALID_OBSERVATION,
        "invalidObservationTotal",
        { streamKey: peerStreamKey(advertisement) }
      );
    }
    if (observation.rssiDbm < PEER_RSSI_FLOOR_DBM) {
      return this.#reject(
        PEER_OBSERVATION_OUTCOMES.BELOW_RSSI_FLOOR,
        "belowRssiFloorTotal",
        { streamKey: peerStreamKey(advertisement) }
      );
    }

    const key = peerStreamKey(advertisement);
    this.#maybeRemoveExpiredAt(nowMs);
    let current = this.#peers.get(key);
    if (
      current !== undefined &&
      classifyPeerAge(nowMs - current.lastSeenMs) === PEER_SOFT_STATES.EXPIRED
    ) {
      this.#peers.delete(key);
      this.#metrics.expiredRemovedTotal += 1;
      current = undefined;
    }

    if (current === undefined) {
      if (!this.#canProcessNewStreamAttempt(nowMs)) {
        return this.#reject(
          PEER_OBSERVATION_OUTCOMES.NEW_STREAM_RATE_REJECTED,
          "newStreamRateRejectedTotal",
          { streamKey: key }
        );
      }

      let replacementCandidate = null;
      if (this.#peers.size >= this.#maxStreams) {
        const oldest = this.#oldestPeer();
        if (
          oldest !== null &&
          classifyPeerAge(nowMs - oldest.lastSeenMs) ===
            PEER_SOFT_STATES.EXPIRED
        ) {
          this.#peers.delete(oldest.streamKey);
          this.#metrics.expiredRemovedTotal += 1;
        }
        if (this.#peers.size >= this.#maxStreams) {
          replacementCandidate = this.#selectReplacementCandidate(
            nowMs,
            observation.rssiDbm
          );
          if (replacementCandidate === null) {
            return this.#reject(
              PEER_OBSERVATION_OUTCOMES.CAPACITY_REJECTED,
              "capacityRejectedTotal",
              { streamKey: key }
            );
          }
        }
      }
      if (replacementCandidate !== null) {
        this.#peers.delete(replacementCandidate.streamKey);
        this.#metrics.capacityEvictedTotal += 1;
      }

      const inserted = Object.freeze({
        streamKey: key,
        advertisement,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        lastRssiDbm: observation.rssiDbm,
        acceptedObservations: 1,
        semanticGeneration: 1
      });
      this.#peers.set(key, inserted);
      this.#metrics.acceptedTotal += 1;
      this.#metrics.insertedTotal += 1;
      this.#metrics.newStreamAdmissionsTotal += 1;
      this.#metrics.capacityHighWatermarkStreams = Math.max(
        this.#metrics.capacityHighWatermarkStreams,
        this.#peers.size
      );
      return freezeResult({
        accepted: true,
        outcome:
          replacementCandidate === null
            ? PEER_OBSERVATION_OUTCOMES.INSERTED
            : PEER_OBSERVATION_OUTCOMES.CAPACITY_EVICTED_INSERTED,
        streamKey: key,
        ...(replacementCandidate === null
          ? {}
          : { evictedStreamKey: replacementCandidate.streamKey }),
        peer: peerView(inserted, nowMs)
      });
    }

    const relation = compareAdvertisementSequence(
      advertisement,
      current.advertisement
    );

    if (relation === ADVERTISEMENT_SEQUENCE_RELATIONS.DUPLICATE) {
      if (!sameAdvertisementSemantics(advertisement, current.advertisement)) {
        return this.#reject(
          PEER_OBSERVATION_OUTCOMES.SEQUENCE_CONFLICT,
          "sequenceConflictTotal",
          { streamKey: key }
        );
      }

      const refreshed = Object.freeze({
        ...current,
        lastSeenMs: nowMs,
        lastRssiDbm: observation.rssiDbm,
        acceptedObservations: current.acceptedObservations + 1
      });
      this.#peers.delete(key);
      this.#peers.set(key, refreshed);
      this.#metrics.acceptedTotal += 1;
      this.#metrics.duplicateRefreshedTotal += 1;
      return freezeResult({
        accepted: true,
        outcome: PEER_OBSERVATION_OUTCOMES.DUPLICATE_REFRESHED,
        streamKey: key,
        peer: peerView(refreshed, nowMs)
      });
    }

    if (relation === ADVERTISEMENT_SEQUENCE_RELATIONS.NEWER) {
      const replaced = Object.freeze({
        ...current,
        advertisement,
        lastSeenMs: nowMs,
        lastRssiDbm: observation.rssiDbm,
        acceptedObservations: current.acceptedObservations + 1,
        semanticGeneration: current.semanticGeneration + 1
      });
      this.#peers.delete(key);
      this.#peers.set(key, replaced);
      this.#metrics.acceptedTotal += 1;
      this.#metrics.newerReplacedTotal += 1;
      return freezeResult({
        accepted: true,
        outcome: PEER_OBSERVATION_OUTCOMES.NEWER_REPLACED,
        streamKey: key,
        peer: peerView(replaced, nowMs)
      });
    }

    if (relation === ADVERTISEMENT_SEQUENCE_RELATIONS.OLDER) {
      return this.#reject(
        PEER_OBSERVATION_OUTCOMES.OLDER_REJECTED,
        "olderRejectedTotal",
        { streamKey: key }
      );
    }

    if (relation === ADVERTISEMENT_SEQUENCE_RELATIONS.AMBIGUOUS) {
      return this.#reject(
        PEER_OBSERVATION_OUTCOMES.AMBIGUOUS_REJECTED,
        "ambiguousRejectedTotal",
        { streamKey: key }
      );
    }

    throw new DiscoveryStateError(
      "UNEXPECTED_SEQUENCE_RELATION",
      `unexpected sequence relation ${relation}`
    );
  }

  snapshot() {
    const nowMs = this.#readNow();
    const peers = [...this.#peers.values()]
      .map((peer) => peerView(peer, nowMs))
      .sort((left, right) => left.streamKey.localeCompare(right.streamKey));
    const stateCounts = {
      fresh: 0,
      aging: 0,
      expired: 0
    };
    for (const peer of peers) {
      stateCounts[peer.state] += 1;
    }
    return freezeResult({
      observedAtMs: nowMs,
      streamCount: peers.length,
      stateCounts: freezeResult(stateCounts),
      peers: Object.freeze(peers)
    });
  }

  pruneExpired() {
    const nowMs = this.#readNow();
    const removedKeys = this.#removeExpiredAt(nowMs);
    this.#nextPruneAtMs = nowMs + this.#pruneIntervalMs;
    return freezeResult({
      prunedAtMs: nowMs,
      removed: removedKeys.length,
      remaining: this.#peers.size,
      removedStreamKeys: Object.freeze(removedKeys)
    });
  }

  metrics() {
    const snapshot = this.snapshot();
    return freezeResult({
      ...this.#metrics,
      currentStreams: snapshot.streamCount,
      freshStreams: snapshot.stateCounts.fresh,
      agingStreams: snapshot.stateCounts.aging,
      expiredStreams: snapshot.stateCounts.expired,
      capacityLimitStreams: this.#maxStreams,
      capacityUtilization:
        snapshot.streamCount / this.#maxStreams,
      newStreamWindowMs: this.#newStreamWindowMs,
      maxNewStreamAttemptsPerWindow:
        this.#maxNewStreamAttemptsPerWindow,
      newStreamAttemptsInCurrentWindow:
        this.#newStreamAttemptsInWindow,
      pruneIntervalMs: this.#pruneIntervalMs,
      replacementRssiMarginDb: this.#replacementRssiMarginDb
    });
  }
}
