import { constants as fsConstants } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import { open, unlink } from "node:fs/promises";

import { LocalPeerTrustAuthoritySignerV1 } from "./PeerTrustDirectoryPublisherV1.js";

export async function loadPeerTrustAuthoritySignerFromFileV1(
  filePath: string
): Promise<LocalPeerTrustAuthoritySignerV1> {
  return (await loadPeerTrustAuthorityFromFileV1(filePath)).signer;
}

export async function loadPeerTrustAuthorityFromFileV1(
  filePath: string
): Promise<Readonly<{
  signer: LocalPeerTrustAuthoritySignerV1;
  publicKeySpki: Buffer;
}>> {
  if (typeof filePath !== "string" || filePath.trim() !== filePath || filePath === "") {
    throw new TypeError("peer trust authority key path is invalid");
  }
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  let bytes: Buffer | null = null;
  try {
    const stat = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (uid !== undefined && stat.uid !== uid) ||
      stat.size < 1 ||
      stat.size > 16_384
    ) {
      throw new Error(
        "peer trust authority key must be an owned single-link 0600 file"
      );
    }
    bytes = await handle.readFile();
    const key = createPrivateKey(bytes);
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("peer trust authority key must use P-256");
    }
    return Object.freeze({
      signer: new LocalPeerTrustAuthoritySignerV1(key),
      publicKeySpki: Buffer.from(
        createPublicKey(key).export({ format: "der", type: "spki" })
      )
    });
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

export async function initializePeerTrustAuthorityFilesV1(input: Readonly<{
  privateKeyPath: string;
  publicSpkiPath: string;
  publicPinPath: string;
}>): Promise<Readonly<{
  publicKeySpkiBase64: string;
  publicKeyPin: string;
  authorityKeyId: string;
}>> {
  const paths = [input.privateKeyPath, input.publicSpkiPath, input.publicPinPath];
  if (
    paths.some((value) =>
      typeof value !== "string" || value.trim() !== value || value === ""
    ) ||
    new Set(paths).size !== paths.length
  ) {
    throw new TypeError("peer trust authority output paths must be distinct and valid");
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateBytes = Buffer.from(
    pair.privateKey.export({ format: "pem", type: "pkcs8" })
  );
  const publicSpki = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" })
  );
  const publicKeySpkiBase64 = publicSpki.toString("base64");
  const digest = createHash("sha256").update(publicSpki).digest();
  const publicKeyPin = `sha256/${digest.toString("base64")}`;
  const authorityKeyId = digest.toString("hex");
  const created: string[] = [];
  try {
    await writeExclusivePrivateFile(input.privateKeyPath, privateBytes);
    created.push(input.privateKeyPath);
    await writeExclusivePrivateFile(
      input.publicSpkiPath,
      Buffer.from(`${publicKeySpkiBase64}\n`, "ascii")
    );
    created.push(input.publicSpkiPath);
    await writeExclusivePrivateFile(
      input.publicPinPath,
      Buffer.from(`${publicKeyPin}\n`, "ascii")
    );
    created.push(input.publicPinPath);
    return Object.freeze({ publicKeySpkiBase64, publicKeyPin, authorityKeyId });
  } catch (error) {
    await Promise.all(created.map(async (filePath) => {
      await unlink(filePath).catch(() => undefined);
    }));
    throw error;
  } finally {
    privateBytes.fill(0);
    publicSpki.fill(0);
    digest.fill(0);
  }
}

async function writeExclusivePrivateFile(filePath: string, bytes: Buffer) {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  let complete = false;
  try {
    const stat = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      throw new Error("authority output must be an owned single-link 0600 file");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(filePath).catch(() => undefined);
  }
}
