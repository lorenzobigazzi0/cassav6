import {
  verifyPeerTrustDirectoryV1
} from "../../../shared/provisioning/peer-trust-directory-v1.mjs";

import {
  PeerTrustDirectoryPublisherV1,
  type PeerTrustAuthoritySignerV1,
  type PublicPeerTrustRegistryV1
} from "./PeerTrustDirectoryPublisherV1.js";
import { PeerTrustPublishedDirectoryStoreV1 } from
  "./PeerTrustPublishedDirectoryStoreV1.js";

export class PeerTrustDirectoryRuntimeV1 {
  readonly #publisher: PeerTrustDirectoryPublisherV1;
  readonly #store: PeerTrustPublishedDirectoryStoreV1;
  readonly #authorityPublicKeySpki: Buffer;
  readonly #clock: () => Date;
  readonly #epochSeconds: number;
  readonly #lifetimeMs: number;
  #cached: Buffer | null = null;
  #active: Promise<Buffer> | null = null;

  constructor(input: Readonly<{
    registry: PublicPeerTrustRegistryV1;
    signer: PeerTrustAuthoritySignerV1;
    authorityPublicKeySpki: Uint8Array;
    store: PeerTrustPublishedDirectoryStoreV1;
    issuerId: string;
    clock?: () => Date;
    epochSeconds?: number;
    lifetimeMs?: number;
  }>) {
    this.#epochSeconds = input.epochSeconds ?? 60;
    this.#lifetimeMs = input.lifetimeMs ?? 180_000;
    if (
      !Number.isSafeInteger(this.#lifetimeMs) ||
      this.#lifetimeMs < 60_000 ||
      this.#lifetimeMs > 86_400_000
    ) {
      throw new TypeError("peer trust lifetime must be 60 seconds to 24 hours");
    }
    this.#publisher = new PeerTrustDirectoryPublisherV1({
      registry: input.registry,
      signer: input.signer,
      issuerId: input.issuerId,
      epochSeconds: this.#epochSeconds
    });
    this.#store = input.store;
    this.#authorityPublicKeySpki = Buffer.from(input.authorityPublicKeySpki);
    this.#clock = input.clock ?? (() => new Date());
  }

  async readCurrentDirectory(): Promise<Buffer> {
    if (this.#active === null) {
      this.#active = this.#refresh().finally(() => {
        this.#active = null;
      });
    }
    return Buffer.from(await this.#active);
  }

  async #refresh(): Promise<Buffer> {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("peer trust runtime clock is invalid");
    }
    const aliasEpoch = Math.floor(now.getTime() / 1000 / this.#epochSeconds);
    const memory = this.#cached === null
      ? null
      : this.#verifyForReuse(this.#cached, now, aliasEpoch);
    if (memory !== null) return memory;

    const stored = await this.#store.read();
    let previousRevision = 0;
    let previousIssuedAt = 0;
    if (stored !== null) {
      const parsed = JSON.parse(stored.toString("utf8"));
      const issuedAt = new Date(parsed.issuedAt);
      const verified = verifyPeerTrustDirectoryV1(
        stored,
        this.#authorityPublicKeySpki,
        { now: issuedAt }
      );
      previousRevision = verified.revision;
      previousIssuedAt = Date.parse(verified.issuedAt);
      const reusable = this.#verifyForReuse(stored, now, aliasEpoch);
      if (reusable !== null) {
        this.#replaceCache(reusable);
        stored.fill(0);
        return Buffer.from(checkNotNull(this.#cached));
      }
    }
    if (now.getTime() < previousIssuedAt) {
      stored?.fill(0);
      throw new Error("peer trust runtime clock regressed");
    }
    const revision = Math.max(previousRevision + 1, now.getTime());
    const expiresAt = new Date(now.getTime() + this.#lifetimeMs);
    const wire = await this.#publisher.publish({ revision, issuedAt: now, expiresAt });
    await this.#store.writeAtomically(wire);
    const committed = await this.#store.read();
    stored?.fill(0);
    if (committed === null || !committed.equals(wire)) {
      committed?.fill(0);
      wire.fill(0);
      throw new Error("peer trust publication was not committed atomically");
    }
    verifyPeerTrustDirectoryV1(committed, this.#authorityPublicKeySpki, {
      now,
      minimumRevision: revision
    });
    this.#replaceCache(committed);
    committed.fill(0);
    wire.fill(0);
    return Buffer.from(checkNotNull(this.#cached));
  }

  #verifyForReuse(wire: Buffer, now: Date, aliasEpoch: number): Buffer | null {
    try {
      const verified = verifyPeerTrustDirectoryV1(
        wire,
        this.#authorityPublicKeySpki,
        { now }
      );
      if (verified.aliasEpoch !== aliasEpoch) return null;
      return Buffer.from(wire);
    } catch {
      return null;
    }
  }

  #replaceCache(value: Buffer) {
    this.#cached?.fill(0);
    this.#cached = Buffer.from(value);
  }

  close() {
    this.#cached?.fill(0);
    this.#cached = null;
    this.#authorityPublicKeySpki.fill(0);
  }
}

function checkNotNull<T>(value: T | null): T {
  if (value === null) throw new Error("peer trust runtime cache is unavailable");
  return value;
}
