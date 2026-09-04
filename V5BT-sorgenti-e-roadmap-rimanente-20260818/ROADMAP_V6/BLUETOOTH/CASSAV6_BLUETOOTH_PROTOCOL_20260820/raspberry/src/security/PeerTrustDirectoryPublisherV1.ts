import {
  encodePeerTrustDirectoryV1,
  signPeerTrustDirectoryV1
} from "../../../shared/provisioning/peer-trust-directory-v1.mjs";

export interface PublicPeerTrustRegistryV1 {
  inspect(): Promise<Readonly<{
    devices: readonly Readonly<{
      nodeId: string;
      certificateId: string;
      publicKeyAlgorithm: "Ed25519" | "EC-P256";
      publicKeySpkiDerBase64: string;
      revokedAt: string | null;
    }>[];
  }>>;
  deriveRotatingAliasForNode(input: Readonly<{
    nodeId: string;
    timestampSeconds: number;
    epochSeconds: number;
  }>): Promise<string>;
}

export interface PeerTrustAuthoritySignerV1 {
  sign(unsignedDirectory: Readonly<Record<string, unknown>>): unknown;
}

export class LocalPeerTrustAuthoritySignerV1
implements PeerTrustAuthoritySignerV1 {
  readonly #privateKey: unknown;

  constructor(privateKey: unknown) {
    this.#privateKey = privateKey;
  }

  sign(unsignedDirectory: Readonly<Record<string, unknown>>): unknown {
    return signPeerTrustDirectoryV1(unsignedDirectory, this.#privateKey);
  }

  toString(): string {
    return "LocalPeerTrustAuthoritySignerV1(privateKey=<redacted>)";
  }
}

export class PeerTrustDirectoryPublisherV1 {
  readonly #registry: PublicPeerTrustRegistryV1;
  readonly #signer: PeerTrustAuthoritySignerV1;
  readonly #issuerId: string;
  readonly #epochSeconds: number;
  #lastRevision = 0;

  constructor(input: Readonly<{
    registry: PublicPeerTrustRegistryV1;
    signer: PeerTrustAuthoritySignerV1;
    issuerId: string;
    epochSeconds?: number;
  }>) {
    if (!input.registry || typeof input.registry.inspect !== "function" ||
        typeof input.registry.deriveRotatingAliasForNode !== "function") {
      throw new TypeError("registry must expose public inspection and alias derivation");
    }
    if (!input.signer || typeof input.signer.sign !== "function") {
      throw new TypeError("signer must expose sign()");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.issuerId)) {
      throw new TypeError("issuerId has an invalid format");
    }
    const epochSeconds = input.epochSeconds ?? 60;
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 30 || epochSeconds > 3600) {
      throw new TypeError("epochSeconds must be an integer from 30 to 3600");
    }
    this.#registry = input.registry;
    this.#signer = input.signer;
    this.#issuerId = input.issuerId;
    this.#epochSeconds = epochSeconds;
  }

  async publish(input: Readonly<{
    revision: number;
    issuedAt: Date;
    expiresAt: Date;
  }>): Promise<Buffer> {
    if (!Number.isSafeInteger(input.revision) || input.revision <= this.#lastRevision) {
      throw new Error("peer trust directory revision must increase monotonically");
    }
    const issuedAt = canonicalDate(input.issuedAt, "issuedAt");
    const expiresAt = canonicalDate(input.expiresAt, "expiresAt");
    const aliasEpoch = Math.floor(input.issuedAt.getTime() / 1000 / this.#epochSeconds);
    const registry = await this.#registry.inspect();
    if (!Array.isArray(registry.devices)) {
      throw new Error("public registry inspection is invalid");
    }
    const devices = [];
    for (const device of [...registry.devices].sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId)
    )) {
      const revoked = device.revokedAt !== null;
      let currentAlias: string | null = null;
      let nextAlias: string | null = null;
      if (!revoked) {
        currentAlias = await this.#registry.deriveRotatingAliasForNode({
          nodeId: device.nodeId,
          timestampSeconds: aliasEpoch * this.#epochSeconds,
          epochSeconds: this.#epochSeconds
        });
        nextAlias = await this.#registry.deriveRotatingAliasForNode({
          nodeId: device.nodeId,
          timestampSeconds: (aliasEpoch + 1) * this.#epochSeconds,
          epochSeconds: this.#epochSeconds
        });
      }
      devices.push({
        nodeId: device.nodeId,
        certificateId: device.certificateId,
        publicKeyAlgorithm: device.publicKeyAlgorithm,
        publicKeySpkiDerBase64: device.publicKeySpkiDerBase64,
        status: revoked ? "REVOKED" : "ACTIVE",
        currentAlias,
        nextAlias
      });
    }
    const signed = this.#signer.sign({
      schemaVersion: 1,
      kind: "cassav6.bluetooth.peer-trust-directory",
      issuerId: this.#issuerId,
      revision: input.revision,
      issuedAt,
      expiresAt,
      aliasEpoch,
      authorityKeyId: "0".repeat(64),
      signatureAlgorithm: "ECDSA-P256-SHA256-P1363",
      devices
    });
    const wire = encodePeerTrustDirectoryV1(signed);
    this.#lastRevision = input.revision;
    return wire;
  }

  snapshot(): Readonly<{ lastRevision: number; exposesAliasKey: false }> {
    return Object.freeze({ lastRevision: this.#lastRevision, exposesAliasKey: false });
  }
}

function canonicalDate(value: Date, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return value.toISOString();
}

