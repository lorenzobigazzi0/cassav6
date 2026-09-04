import {
  buildAuthFinishProofMessageV1,
  buildClientAuthProofMessageV1,
  buildServerAuthProofMessageV1,
  type MutualAuthBindingV1
} from "../../../shared/protocol/mutual-auth-v1.mjs";
import type { DeviceRegistryV2 } from "../../../shared/provisioning/device-registry-v2.mjs";
import { derivePeerTrustIdV1 } from "../../../shared/provisioning/peer-trust-directory-v1.mjs";

export interface AuthorizedDeviceAuthenticationPortV1 {
  getAuthorizedDevice?(nodeId: string): Promise<Readonly<{
    readonly nodeId: string;
    readonly certificateId: string;
    readonly publicKeyAlgorithm: "Ed25519" | "EC-P256";
    readonly publicKeySpkiDerBase64: string;
  }>>;
  verifyAuthorizedDeviceSignature(input: {
    readonly nodeId: string;
    readonly certificateId: string;
    readonly message: Uint8Array;
    readonly signature: Uint8Array;
  }): Promise<boolean>;
  createAuthorizedDeviceMac(input: {
    readonly nodeId: string;
    readonly certificateId: string;
    readonly message: Uint8Array;
  }): Promise<Buffer>;
  verifyAuthorizedDeviceMac(input: {
    readonly nodeId: string;
    readonly certificateId: string;
    readonly message: Uint8Array;
    readonly proof: Uint8Array;
  }): Promise<boolean>;
}

export class MutualAuthHandshakeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MutualAuthHandshakeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new MutualAuthHandshakeError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

export class MutualAuthHandshakeV1 {
  readonly #registry: AuthorizedDeviceAuthenticationPortV1;

  constructor(
    registry:
      | AuthorizedDeviceAuthenticationPortV1
      | Pick<
          DeviceRegistryV2,
          | "verifyAuthorizedDeviceSignature"
          | "createAuthorizedDeviceMac"
          | "verifyAuthorizedDeviceMac"
        >
  ) {
    this.#registry = registry;
  }

  async resolveAuthorizedPeerTrustId(
    binding: MutualAuthBindingV1
  ): Promise<string | null> {
    const getAuthorizedDevice = this.#registry.getAuthorizedDevice;
    if (getAuthorizedDevice === undefined) return null;
    let record: Awaited<ReturnType<NonNullable<
      AuthorizedDeviceAuthenticationPortV1["getAuthorizedDevice"]
    >>>;
    try {
      record = await getAuthorizedDevice.call(
        this.#registry,
        binding.clientHello.nodeId
      );
    } catch (error) {
      fail(
        "DEVICE_IDENTITY_REJECTED",
        "authorized Android trust record could not be resolved",
        error
      );
    }
    if (
      record.nodeId !== binding.clientHello.nodeId ||
      record.certificateId !== binding.deviceCertificateId
    ) {
      fail(
        "PEER_TRUST_BINDING_MISMATCH",
        "authorized Android trust record does not match the handshake"
      );
    }
    const publicKeySpkiDer = Buffer.from(record.publicKeySpkiDerBase64, "base64");
    try {
      if (publicKeySpkiDer.toString("base64") !== record.publicKeySpkiDerBase64) {
        fail(
          "PEER_TRUST_BINDING_MISMATCH",
          "authorized Android trust key is not canonical"
        );
      }
      return derivePeerTrustIdV1(
        record.nodeId,
        record.certificateId,
        record.publicKeyAlgorithm,
        publicKeySpkiDer
      );
    } catch (error) {
      if (error instanceof MutualAuthHandshakeError) throw error;
      fail(
        "PEER_TRUST_BINDING_MISMATCH",
        "authorized Android trust commitment could not be derived",
        error
      );
    } finally {
      publicKeySpkiDer.fill(0);
    }
  }

  async verifyClientAndCreateServerProof(input: {
    readonly binding: MutualAuthBindingV1;
    readonly clientSignature: Uint8Array;
  }): Promise<Buffer> {
    const clientMessage = buildClientAuthProofMessageV1(input.binding);
    try {
      let verified: boolean;
      try {
        verified = await this.#registry.verifyAuthorizedDeviceSignature({
          nodeId: input.binding.clientHello.nodeId,
          certificateId: input.binding.deviceCertificateId,
          message: clientMessage,
          signature: input.clientSignature
        });
      } catch (error) {
        fail(
          "DEVICE_IDENTITY_REJECTED",
          "authorized Android identity could not be verified",
          error
        );
      }
      if (!verified) {
        fail(
          "CLIENT_SIGNATURE_INVALID",
          "Android client signature is invalid"
        );
      }
    } finally {
      clientMessage.fill(0);
    }

    const serverMessage = buildServerAuthProofMessageV1(
      input.binding,
      input.clientSignature
    );
    try {
      try {
        return await this.#registry.createAuthorizedDeviceMac({
          nodeId: input.binding.clientHello.nodeId,
          certificateId: input.binding.deviceCertificateId,
          message: serverMessage
        });
      } catch (error) {
        fail(
          "SERVER_PROOF_FAILED",
          "Raspberry server proof could not be created",
          error
        );
      }
    } finally {
      serverMessage.fill(0);
    }
  }

  async verifyClientFinish(input: {
    readonly binding: MutualAuthBindingV1;
    readonly clientSignature: Uint8Array;
    readonly serverProof: Uint8Array;
    readonly finishProof: Uint8Array;
  }): Promise<void> {
    const finishMessage = buildAuthFinishProofMessageV1(
      input.binding,
      input.clientSignature,
      input.serverProof
    );
    try {
      let verified: boolean;
      try {
        verified = await this.#registry.verifyAuthorizedDeviceMac({
          nodeId: input.binding.clientHello.nodeId,
          certificateId: input.binding.deviceCertificateId,
          message: finishMessage,
          proof: input.finishProof
        });
      } catch (error) {
        fail(
          "DEVICE_IDENTITY_REJECTED",
          "authorized Android identity could not complete authentication",
          error
        );
      }
      if (!verified) {
        fail(
          "FINISH_PROOF_INVALID",
          "Android finish proof is invalid"
        );
      }
    } finally {
      finishMessage.fill(0);
    }
  }
}
