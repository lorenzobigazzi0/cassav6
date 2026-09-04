#!/usr/bin/env node

import {
  constants as fsConstants,
  writeFileSync
} from "node:fs";
import { createPublicKey } from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";

import { DeviceRegistryV1 } from "../../shared/provisioning/device-registry-v1.mjs";
import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";

function usage() {
  return `CASSA V5BT Bluetooth B1 device registry (offline administrative CLI)

Usage:
  node raspberry/scripts/device-registry.mjs init --registry PATH [--protocol-version 2]
  node raspberry/scripts/device-registry.mjs issue-token --registry PATH \\
    --endpoint-id ID --protocol-version 2 --ttl-seconds 600 --output SECURE_JSON
  node raspberry/scripts/device-registry.mjs enroll --registry PATH \\
    --token-file SECURE_JSON --public-key-file ANDROID_PUBLIC_PEM \\
    --node-id ANDROID_NODE_UUID --output PROVISIONING_JSON
  node raspberry/scripts/device-registry.mjs enroll --registry PATH \\
    --endpoint-id ID --token-stdin --public-key-file ANDROID_PUBLIC_PEM \\
    --node-id ANDROID_NODE_UUID --output PROVISIONING_JSON
  node raspberry/scripts/device-registry.mjs list --registry PATH
  node raspberry/scripts/device-registry.mjs revoke --registry PATH --node-id UUID

Sensitive token and aliasKey values are written only to new mode-0600 files.
Interrupted writes remain in OUTPUT.pending and are recovered idempotently when
the same command is retried with the same OUTPUT transaction path.
The CLI never starts Bluetooth, the Raspberry runtime, or any business flow.
`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate option: ${name}`);
    }
    if (name === "--token-stdin") {
      options.set(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    options.set(name, value);
    index += 1;
  }
  return { command, options };
}

function requiredOption(options, name, fallback = undefined) {
  const value = options.get(name) ?? fallback;
  if (typeof value !== "string" || value === "") {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > 4096) {
      throw cliError(
        "INVALID_ENROLLMENT_TOKEN",
        "Enrollment token stdin exceeds 4096 bytes"
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

const COMMIT_STATE = Object.freeze({
  COMMITTED: "COMMITTED",
  NOT_COMMITTED: "NOT_COMMITTED",
  UNCERTAIN: "UNCERTAIN"
});
const MAX_SENSITIVE_JSON_BYTES = 64 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENROLLMENT_TOKEN_PATTERN =
  /^c5e[12]_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ALIAS_KEY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const FORBIDDEN_V4_STATE_ROOT = "/var/lib/cassav4-bluetooth";

function cliError(code, message, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : {});
  error.code = code;
  error.registryCommitState = options.registryCommitState;
  error.sensitiveOutputPreserved = options.sensitiveOutputPreserved;
  return error;
}

function sameFileIdentity(first, second) {
  return (
    first !== undefined &&
    second !== undefined &&
    first.dev === second.dev &&
    first.ino === second.ino
  );
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function resolveThroughExistingAncestor(candidatePath) {
  let current = candidatePath;
  const missingSegments = [];
  while (true) {
    try {
      const canonical = await realpath(current);
      return path.join(canonical, ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function assertV5BtRegistryIsolation(registryValue) {
  const registryPath = path.resolve(registryValue);
  const forbiddenRoot = path.resolve(FORBIDDEN_V4_STATE_ROOT);
  if (
    registryPath === forbiddenRoot ||
    isWithin(registryPath, forbiddenRoot)
  ) {
    throw cliError(
      "V4_STATE_FORBIDDEN",
      "The V5BT CLI cannot access the V4 device registry"
    );
  }
  const canonicalCandidate =
    await resolveThroughExistingAncestor(registryPath);
  if (
    canonicalCandidate === forbiddenRoot ||
    isWithin(canonicalCandidate, forbiddenRoot)
  ) {
    throw cliError(
      "V4_STATE_FORBIDDEN",
      "The V5BT CLI cannot traverse into the V4 state directory"
    );
  }
  try {
    const registryStat = await lstat(registryPath);
    if (registryStat.nlink !== 1) {
      throw cliError(
        "INSECURE_REGISTRY_FILE",
        "The V5BT registry must not be a hard link"
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return registryPath;
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw cliError("INVALID_SENSITIVE_JSON", `${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw cliError(
      "INVALID_SENSITIVE_JSON",
      `${label} contains missing or unexpected properties`
    );
  }
}

function assertCanonicalUtc(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw cliError("INVALID_SENSITIVE_JSON", `${label} must be canonical UTC`);
  }
}

function validateEnrollmentQr(qr) {
  assertExactKeys(qr, ["version", "enrollmentEndpointId", "token"], "qr");
  const protocolVersion = Number(String(qr?.token ?? "").slice(3, 4));
  const tokenPrefix = `c5e${protocolVersion}_`;
  const tokenBytes =
    typeof qr?.token === "string"
      ? Buffer.from(qr.token.slice(tokenPrefix.length), "base64url")
      : Buffer.alloc(0);
  if (
    ![1, 2].includes(qr.version) ||
    qr.version !== protocolVersion ||
    typeof qr.enrollmentEndpointId !== "string" ||
    !ENDPOINT_ID_PATTERN.test(qr.enrollmentEndpointId) ||
    typeof qr.token !== "string" ||
    !ENROLLMENT_TOKEN_PATTERN.test(qr.token) ||
    tokenBytes.byteLength !== 32 ||
    `${tokenPrefix}${tokenBytes.toString("base64url")}` !== qr.token
  ) {
    throw cliError(
      "INVALID_SENSITIVE_JSON",
      "The enrollment QR does not match a supported protocol contract"
    );
  }
  return qr;
}

function validateIssuedToken(value) {
  assertExactKeys(
    value,
    ["tokenId", "expiresAt", "qr", "qrPayload"],
    "issued token output"
  );
  if (typeof value.tokenId !== "string" || !UUID_PATTERN.test(value.tokenId)) {
    throw cliError("INVALID_SENSITIVE_JSON", "tokenId must be a canonical UUID");
  }
  assertCanonicalUtc(value.expiresAt, "expiresAt");
  validateEnrollmentQr(value.qr);
  if (value.qrPayload !== JSON.stringify(value.qr)) {
    throw cliError(
      "INVALID_SENSITIVE_JSON",
      "qrPayload must be the exact canonical serialization of qr"
    );
  }
  return value;
}

function validateProvisioning(value) {
  assertExactKeys(
    value,
    [
      "protocolVersion",
      "nodeId",
      "certificateId",
      "publicKeyAlgorithm",
      "publicKeySpkiDerBase64",
      "aliasKeyAlgorithm",
      "aliasKeyEncoding",
      "aliasKeyBase64url",
      "enrolledAt"
    ],
    "provisioning output"
  );
  if (
    ![1, 2].includes(value.protocolVersion) ||
    !UUID_PATTERN.test(value.nodeId ?? "") ||
    !UUID_PATTERN.test(value.certificateId ?? "") ||
    !["Ed25519", "EC-P256"].includes(value.publicKeyAlgorithm) ||
    (value.protocolVersion === 1 && value.publicKeyAlgorithm !== "Ed25519") ||
    (value.protocolVersion === 2 && value.publicKeyAlgorithm !== "EC-P256") ||
    value.aliasKeyAlgorithm !== "HMAC-SHA256" ||
    value.aliasKeyEncoding !== "base64url-unpadded" ||
    !ALIAS_KEY_PATTERN.test(value.aliasKeyBase64url ?? "") ||
    Buffer.from(value.aliasKeyBase64url ?? "", "base64url").byteLength !== 32 ||
    Buffer.from(value.aliasKeyBase64url ?? "", "base64url").toString("base64url") !==
      value.aliasKeyBase64url
  ) {
    throw cliError(
      "INVALID_SENSITIVE_JSON",
      "The provisioning output does not match a supported protocol contract"
    );
  }
  assertCanonicalUtc(value.enrolledAt, "enrolledAt");
  let publicKey;
  try {
    const der = Buffer.from(value.publicKeySpkiDerBase64, "base64");
    const expectedBytes = value.publicKeyAlgorithm === "Ed25519" ? 44 : 91;
    if (
      der.byteLength !== expectedBytes ||
      der.toString("base64") !== value.publicKeySpkiDerBase64
    ) {
      throw new Error("non-canonical public key SPKI");
    }
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (error) {
    throw cliError(
      "INVALID_SENSITIVE_JSON",
      "publicKeySpkiDerBase64 is not canonical device SPKI",
      { cause: error }
    );
  }
  if (
    (value.publicKeyAlgorithm === "Ed25519" &&
      publicKey.asymmetricKeyType !== "ed25519") ||
    (value.publicKeyAlgorithm === "EC-P256" &&
      (
        publicKey.asymmetricKeyType !== "ec" ||
        publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      ))
  ) {
    throw cliError(
      "INVALID_SENSITIVE_JSON",
      "publicKeySpkiDerBase64 does not match publicKeyAlgorithm"
    );
  }
  return value;
}

async function openTrustedDirectory(directory) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | noFollow | directoryOnly
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0) {
      throw cliError(
        "INSECURE_OUTPUT_DIRECTORY",
        "Sensitive output directory must be a non-group/world-writable directory"
      );
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertSecureFileMetadata(
  metadata,
  label,
  sensitive,
  maxBytes,
  allowTransactionLinks = false
) {
  if (!metadata.isFile()) {
    throw cliError("INSECURE_INPUT_FILE", `${label} must be a regular file`);
  }
  const mode = metadata.mode & 0o777;
  if (
    (sensitive && mode !== 0o600) ||
    (!sensitive && (mode & 0o022) !== 0)
  ) {
    throw cliError(
      "INSECURE_INPUT_FILE",
      sensitive
        ? `${label} must have mode 0600`
        : `${label} must not be group/world writable`
    );
  }
  if (
    sensitive &&
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw cliError(
      "INSECURE_INPUT_FILE",
      `${label} must be owned by the current user`
    );
  }
  if (sensitive && !allowTransactionLinks && metadata.nlink !== 1) {
    throw cliError(
      "INSECURE_INPUT_FILE",
      `${label} must have exactly one filesystem link`
    );
  }
  if (metadata.size < 1 || metadata.size > maxBytes) {
    throw cliError(
      "INVALID_INPUT_FILE",
      `${label} size must be between 1 and ${maxBytes} bytes`
    );
  }
}

async function readSecureFile(
  filePath,
  {
    label,
    sensitive,
    maxBytes,
    keepOpen = false,
    allowTransactionLinks = false
  }
) {
  const resolved = path.resolve(filePath);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    assertSecureFileMetadata(
      metadata,
      label,
      sensitive,
      maxBytes,
      allowTransactionLinks
    );
    const text = await handle.readFile({ encoding: "utf8" });
    if (keepOpen) {
      return { handle, metadata, path: resolved, text };
    }
    await handle.close();
    return { path: resolved, text };
  } catch (error) {
    await handle?.close();
    if (error?.code === "ELOOP") {
      throw cliError(
        "INSECURE_INPUT_FILE",
        `${label} must not be a symbolic link`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function readSecureJson(
  filePath,
  label,
  validator,
  keepOpen = false,
  allowTransactionLinks = false
) {
  const opened = await readSecureFile(filePath, {
    label,
    sensitive: true,
    maxBytes: MAX_SENSITIVE_JSON_BYTES,
    keepOpen,
    allowTransactionLinks
  });
  try {
    const value = validator(JSON.parse(opened.text));
    if (opened.text !== `${JSON.stringify(value, null, 2)}\n`) {
      throw cliError(
        "INVALID_SENSITIVE_JSON",
        `${label} must use the canonical CLI JSON serialization`
      );
    }
    return { ...opened, value };
  } catch (error) {
    await opened.handle?.close();
    if (error?.code === "INVALID_SENSITIVE_JSON") {
      throw error;
    }
    throw cliError("INVALID_SENSITIVE_JSON", `${label} is not valid JSON`, {
      cause: error
    });
  }
}

async function assertOwnedPath(filePath, handle, ownedIdentity) {
  const handleIdentity = await handle.stat();
  const pathIdentity = await lstat(filePath);
  if (
    !handleIdentity.isFile() ||
    !sameFileIdentity(handleIdentity, ownedIdentity) ||
    !pathIdentity.isFile() ||
    !sameFileIdentity(pathIdentity, ownedIdentity)
  ) {
    throw cliError(
      "SENSITIVE_OUTPUT_OWNERSHIP_LOST",
      `Sensitive pathname no longer belongs to this transaction: ${filePath}`
    );
  }
}

async function unlinkOwnedPath(filePath, handle, ownedIdentity) {
  await assertOwnedPath(filePath, handle, ownedIdentity);
  await unlink(filePath);
}

async function closeQuietly(...handles) {
  await Promise.all(
    handles.filter(Boolean).map((handle) => handle.close().catch(() => {}))
  );
}

async function promotePending({
  finalPath,
  pendingPath,
  pendingHandle,
  pendingIdentity,
  directoryHandle
}) {
  try {
    await link(pendingPath, finalPath);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const finalIdentity = await lstat(finalPath);
    if (!sameFileIdentity(finalIdentity, pendingIdentity)) {
      throw cliError(
        "SENSITIVE_OUTPUT_CONFLICT",
        `Refusing to overwrite existing sensitive output: ${finalPath}`
      );
    }
  }
  const finalIdentity = await lstat(finalPath);
  if (!sameFileIdentity(finalIdentity, pendingIdentity)) {
    throw cliError(
      "SENSITIVE_OUTPUT_OWNERSHIP_LOST",
      "Promoted output does not refer to the staged sensitive file"
    );
  }
  await directoryHandle.sync();
  await assertOwnedPath(finalPath, pendingHandle, pendingIdentity);
  await unlinkOwnedPath(pendingPath, pendingHandle, pendingIdentity);
  await directoryHandle.sync();
}

async function createSensitiveStage(outputPath) {
  const finalPath = path.resolve(outputPath);
  const pendingPath = `${finalPath}.pending`;
  const directoryHandle = await openTrustedDirectory(path.dirname(finalPath));
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let pendingHandle;
  let pendingIdentity;
  try {
    pendingHandle = await open(
      pendingPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600
    );
    await pendingHandle.chmod(0o600);
    pendingIdentity = await pendingHandle.stat();
    if (
      !pendingIdentity.isFile() ||
      (pendingIdentity.mode & 0o777) !== 0o600
    ) {
      throw cliError(
        "INSECURE_OUTPUT_FILE",
        "Staged sensitive output must be a regular mode-0600 file"
      );
    }
    await directoryHandle.sync();
  } catch (error) {
    if (pendingHandle && pendingIdentity) {
      await unlinkOwnedPath(
        pendingPath,
        pendingHandle,
        pendingIdentity
      ).catch(() => {});
    }
    await closeQuietly(pendingHandle, directoryHandle);
    throw error;
  }

  let staged = false;
  return {
    path: finalPath,
    pendingPath,
    async write(value) {
      if (staged) {
        throw cliError(
          "SENSITIVE_OUTPUT_STATE",
          "Sensitive output is already staged"
        );
      }
      await pendingHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await pendingHandle.sync();
      await directoryHandle.sync();
      staged = true;
    },
    async promote() {
      if (!staged) {
        throw cliError(
          "SENSITIVE_OUTPUT_STATE",
          "Sensitive output was not staged"
        );
      }
      await promotePending({
        finalPath,
        pendingPath,
        pendingHandle,
        pendingIdentity,
        directoryHandle
      });
      await closeQuietly(pendingHandle, directoryHandle);
    },
    async abort() {
      try {
        await unlinkOwnedPath(
          pendingPath,
          pendingHandle,
          pendingIdentity
        ).catch((error) => {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        });
        await directoryHandle.sync();
      } finally {
        await closeQuietly(pendingHandle, directoryHandle);
      }
    },
    async preserve() {
      await closeQuietly(pendingHandle, directoryHandle);
    }
  };
}

async function determineCommitState(registry, operation, value, error) {
  if (error?.registryCommitted === true) {
    return COMMIT_STATE.COMMITTED;
  }
  try {
    if (operation === "issue-token") {
      const verification = await registry.verifyIssuedTokenCommit({
        tokenId: value.tokenId,
        enrollmentEndpointId: value.qr.enrollmentEndpointId,
        token: value.qr.token
      });
      if (!verification.recordExists) {
        return COMMIT_STATE.NOT_COMMITTED;
      }
      return verification.matches
        ? COMMIT_STATE.COMMITTED
        : COMMIT_STATE.UNCERTAIN;
    }

    const verification = await registry.verifyProvisioningCommit(value);
    if (!verification.recordExists) {
      return COMMIT_STATE.NOT_COMMITTED;
    }
    return verification.matches
      ? COMMIT_STATE.COMMITTED
      : COMMIT_STATE.UNCERTAIN;
  } catch {
    return COMMIT_STATE.UNCERTAIN;
  }
}

function assertRecoveredRequest(operation, value, expected) {
  if (
    operation === "issue-token" &&
    (
      value.qr.enrollmentEndpointId !== expected.enrollmentEndpointId ||
      value.qr.version !== expected.protocolVersion
    )
  ) {
    throw cliError(
      "SENSITIVE_OUTPUT_CONFLICT",
      "Existing output belongs to a different enrollment endpoint"
    );
  }
  if (
    operation === "enroll" &&
    (value.nodeId !== expected.nodeId ||
      value.publicKeySpkiDerBase64 !== expected.publicKeySpkiDerBase64)
  ) {
    throw cliError(
      "SENSITIVE_OUTPUT_CONFLICT",
      "Existing output belongs to a different Android identity"
    );
  }
}

async function recoverSensitiveOutput({
  outputPath,
  registry,
  operation,
  validator,
  expected
}) {
  const finalPath = path.resolve(outputPath);
  const pendingPath = `${finalPath}.pending`;
  let finalExists = false;
  let pendingExists = false;
  try {
    await lstat(finalPath);
    finalExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await lstat(pendingPath);
    pendingExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!finalExists && !pendingExists) {
    return null;
  }

  const directoryHandle = await openTrustedDirectory(path.dirname(finalPath));
  let final;
  let pending;
  try {
    if (finalExists) {
      final = await readSecureJson(
        finalPath,
        "sensitive output",
        validator,
        true,
        true
      );
    }
    if (pendingExists) {
      pending = await readSecureJson(
        pendingPath,
        "pending sensitive output",
        validator,
        true,
        true
      );
    }
    if (
      final &&
      pending &&
      !sameFileIdentity(final.metadata, pending.metadata)
    ) {
      throw cliError(
        "SENSITIVE_OUTPUT_CONFLICT",
        "Final and pending sensitive outputs have different identities"
      );
    }
    if (
      (final && pending && final.metadata.nlink !== 2) ||
      ((final === undefined || pending === undefined) &&
        (final ?? pending).metadata.nlink !== 1)
    ) {
      throw cliError(
        "INSECURE_INPUT_FILE",
        "Sensitive output has unexpected additional filesystem links"
      );
    }

    const recovered = final ?? pending;
    assertRecoveredRequest(operation, recovered.value, expected);
    const commitState = await determineCommitState(
      registry,
      operation,
      recovered.value
    );

    if (commitState === COMMIT_STATE.UNCERTAIN) {
      throw cliError(
        "REGISTRY_COMMIT_UNCERTAIN",
        "Registry state cannot be verified; sensitive output was preserved",
        {
          registryCommitState: commitState,
          sensitiveOutputPreserved: recovered.path
        }
      );
    }
    if (final) {
      await assertOwnedPath(final.path, final.handle, final.metadata);
      if (commitState !== COMMIT_STATE.COMMITTED) {
        throw cliError(
          "SENSITIVE_OUTPUT_ORPHAN",
          "Final sensitive output exists but its registry commit is absent",
          {
            registryCommitState: commitState,
            sensitiveOutputPreserved: final.path
          }
        );
      }
      if (pending) {
        await directoryHandle.sync();
        await unlinkOwnedPath(
          pending.path,
          pending.handle,
          pending.metadata
        );
        await directoryHandle.sync();
      }
      return {
        recovered: true,
        value: final.value,
        path: final.path,
        registryCommitState: commitState
      };
    }
    if (commitState === COMMIT_STATE.NOT_COMMITTED) {
      await unlinkOwnedPath(
        pending.path,
        pending.handle,
        pending.metadata
      );
      await directoryHandle.sync();
      return null;
    }

    await promotePending({
      finalPath,
      pendingPath,
      pendingHandle: pending.handle,
      pendingIdentity: pending.metadata,
      directoryHandle
    });
    return {
      recovered: true,
      value: pending.value,
      path: finalPath,
      registryCommitState: commitState
    };
  } finally {
    await closeQuietly(final?.handle, pending?.handle, directoryHandle);
  }
}

function canonicalPublicKeyBase64(publicKeyText, publicKeyAlgorithm) {
  try {
    const publicKey = createPublicKey(publicKeyText);
    if (
      (publicKeyAlgorithm === "Ed25519" &&
        publicKey.asymmetricKeyType !== "ed25519") ||
      (publicKeyAlgorithm === "EC-P256" &&
        (
          publicKey.asymmetricKeyType !== "ec" ||
          publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
        ))
    ) {
      throw new Error(`not ${publicKeyAlgorithm}`);
    }
    return Buffer.from(
      publicKey.export({ format: "der", type: "spki" })
    ).toString("base64");
  } catch (error) {
    throw cliError(
      "INVALID_PUBLIC_KEY",
      `Public key file must contain a ${publicKeyAlgorithm} public key`,
      { cause: error }
    );
  }
}

function print(value) {
  writeFileSync(
    process.stdout.fd,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === undefined || command === "help" || options.has("--help")) {
    writeFileSync(process.stdout.fd, usage(), "utf8");
    return;
  }

  const registryPath = await assertV5BtRegistryIsolation(
    requiredOption(
      options,
      "--registry",
      process.env.CASSA_BT_DEVICE_REGISTRY
    )
  );
  const registryV1 = new DeviceRegistryV1(registryPath);
  const registryV2 = new DeviceRegistryV2(registryPath);
  const existingRegistry = async () => {
    try {
      await registryV2.inspect();
      return registryV2;
    } catch (error) {
      if (error?.code !== "REGISTRY_MIGRATION_REQUIRED") throw error;
      await registryV1.inspect();
      return registryV1;
    }
  };
  const registryForProtocol = async (protocolVersion) => {
    if (![1, 2].includes(protocolVersion)) {
      throw cliError(
        "INVALID_ENROLLMENT_PROTOCOL",
        "Enrollment protocol must be 1 or 2"
      );
    }
    const selected = await existingRegistry();
    if (selected === registryV1 && protocolVersion === 2) {
      throw cliError(
        "REGISTRY_MIGRATION_REQUIRED",
        "Protocol v2 requires explicit init --protocol-version 2 migration"
      );
    }
    return selected;
  };
  const registry = {
    issueEnrollmentToken: async (input) =>
      (await registryForProtocol(input.protocolVersion ?? 1))
        .issueEnrollmentToken(input),
    enrollDevice: async (input) =>
      (await registryForProtocol(input.protocolVersion ?? 1))
        .enrollDevice(input),
    verifyIssuedTokenCommit: async (input) =>
      (await registryForProtocol(
        Number(String(input.token).slice(3, 4))
      )).verifyIssuedTokenCommit(input),
    verifyProvisioningCommit: async (input) =>
      (await registryForProtocol(input.protocolVersion ?? 1))
        .verifyProvisioningCommit(input),
    inspect: async () => (await existingRegistry()).inspect(),
    revokeDevice: async (nodeId) =>
      (await existingRegistry()).revokeDevice(nodeId)
  };

  switch (command) {
    case "init": {
      const protocolVersion = Number(options.get("--protocol-version") ?? 1);
      if (![1, 2].includes(protocolVersion)) {
        throw new Error("--protocol-version must be 1 or 2");
      }
      const result = await (
        protocolVersion === 2 ? registryV2 : registryV1
      ).initialize();
      print({ ok: true, registry: path.resolve(registryPath), ...result });
      return;
    }
    case "issue-token": {
      const output = requiredOption(options, "--output");
      const enrollmentEndpointId = requiredOption(options, "--endpoint-id");
      const protocolVersion = Number(options.get("--protocol-version") ?? 1);
      if (![1, 2].includes(protocolVersion)) {
        throw new Error("--protocol-version must be 1 or 2");
      }
      const ttlSeconds = Number(options.get("--ttl-seconds") ?? 600);
      const recovered = await recoverSensitiveOutput({
        outputPath: output,
        registry,
        operation: "issue-token",
        validator: validateIssuedToken,
        expected: { enrollmentEndpointId, protocolVersion }
      });
      if (recovered) {
        print({
          ok: true,
          recovered: true,
          tokenId: recovered.value.tokenId,
          expiresAt: recovered.value.expiresAt,
          registryCommitState: recovered.registryCommitState,
          sensitiveOutput: recovered.path
        });
        return;
      }

      const destination = await createSensitiveStage(output);
      let issued;
      let stagedIssued;
      try {
        issued = await registry.issueEnrollmentToken({
          enrollmentEndpointId,
          protocolVersion,
          ttlSeconds,
          onTokenReady: async (value) => {
            stagedIssued = value;
            await destination.write(value);
          }
        });
      } catch (error) {
        const commitState =
          stagedIssued === undefined
            ? COMMIT_STATE.NOT_COMMITTED
            : await determineCommitState(
                registry,
                "issue-token",
                stagedIssued,
                error
              );
        error.registryCommitState = commitState;
        if (commitState === COMMIT_STATE.NOT_COMMITTED) {
          await destination.abort();
        } else if (commitState === COMMIT_STATE.COMMITTED) {
          try {
            await destination.promote();
            error.sensitiveOutputPreserved = destination.path;
          } catch (promotionError) {
            await destination.preserve();
            promotionError.registryCommitState = commitState;
            promotionError.sensitiveOutputPreserved = destination.pendingPath;
            throw promotionError;
          }
        } else {
          await destination.preserve();
          error.sensitiveOutputPreserved = destination.pendingPath;
        }
        throw error;
      }
      try {
        await destination.promote();
      } catch (error) {
        await destination.preserve();
        error.registryCommitState = COMMIT_STATE.COMMITTED;
        error.sensitiveOutputPreserved = destination.pendingPath;
        throw error;
      }
      print({
        ok: true,
        tokenId: issued.tokenId,
        expiresAt: issued.expiresAt,
        registryCommitState: COMMIT_STATE.COMMITTED,
        sensitiveOutput: destination.path
      });
      return;
    }
    case "enroll": {
      const output = requiredOption(options, "--output");
      const publicKeyFile = requiredOption(options, "--public-key-file");
      const nodeId = requiredOption(options, "--node-id");
      const tokenFile = options.get("--token-file");
      const tokenStdin = options.get("--token-stdin") === true;
      if ((tokenFile === undefined) === !tokenStdin) {
        throw new Error("Use exactly one of --token-file or --token-stdin");
      }

      let token;
      let protocolVersion;
      let enrollmentEndpointId = options.get("--endpoint-id");
      if (typeof tokenFile === "string") {
        const issued = await readSecureJson(
          tokenFile,
          "enrollment token file",
          validateIssuedToken
        );
        token = issued.value.qr.token;
        protocolVersion = issued.value.qr.version;
        if (
          enrollmentEndpointId !== undefined &&
          enrollmentEndpointId !== issued.value.qr.enrollmentEndpointId
        ) {
          throw cliError(
            "ENROLLMENT_ENDPOINT_MISMATCH",
            "--endpoint-id does not match the secure token file"
          );
        }
        enrollmentEndpointId ??= issued.value.qr.enrollmentEndpointId;
      } else {
        token = await readStdin();
        protocolVersion = Number(String(token).slice(3, 4));
      }

      if (![1, 2].includes(protocolVersion)) {
        throw cliError(
          "INVALID_ENROLLMENT_TOKEN",
          "Enrollment token must be bound to protocol v1 or v2"
        );
      }
      const publicKeyAlgorithm =
        protocolVersion === 1 ? "Ed25519" : "EC-P256";

      if (!UUID_PATTERN.test(nodeId)) {
        throw cliError(
          "INVALID_NODE_ID",
          "--node-id must be a canonical lowercase RFC 4122 UUID"
        );
      }
      const publicKeyInput = await readSecureFile(publicKeyFile, {
        label: "Android public key file",
        sensitive: false,
        maxBytes: MAX_PUBLIC_KEY_BYTES
      });
      const publicKey = publicKeyInput.text;
      const publicKeySpkiDerBase64 = canonicalPublicKeyBase64(
        publicKey,
        publicKeyAlgorithm
      );
      const recovered = await recoverSensitiveOutput({
        outputPath: output,
        registry,
        operation: "enroll",
        validator: validateProvisioning,
        expected: { nodeId, publicKeySpkiDerBase64 }
      });
      if (recovered) {
        print({
          ok: true,
          recovered: true,
          nodeId: recovered.value.nodeId,
          certificateId: recovered.value.certificateId,
          registryCommitState: recovered.registryCommitState,
          sensitiveOutput: recovered.path
        });
        return;
      }

      const destination = await createSensitiveStage(output);
      let provisioned;
      let stagedProvisioning;
      try {
        provisioned = await registry.enrollDevice({
          protocolVersion,
          enrollmentEndpointId,
          token,
          publicKey,
          publicKeyAlgorithm,
          nodeId,
          onProvisioningReady: async (value) => {
            stagedProvisioning = value;
            await destination.write(value);
          }
        });
      } catch (error) {
        const commitState =
          stagedProvisioning === undefined
            ? COMMIT_STATE.NOT_COMMITTED
            : await determineCommitState(
                registry,
                "enroll",
                stagedProvisioning,
                error
              );
        error.registryCommitState = commitState;
        if (commitState === COMMIT_STATE.NOT_COMMITTED) {
          await destination.abort();
        } else if (commitState === COMMIT_STATE.COMMITTED) {
          try {
            await destination.promote();
            error.sensitiveOutputPreserved = destination.path;
          } catch (promotionError) {
            await destination.preserve();
            promotionError.registryCommitState = commitState;
            promotionError.sensitiveOutputPreserved = destination.pendingPath;
            throw promotionError;
          }
        } else {
          await destination.preserve();
          error.sensitiveOutputPreserved = destination.pendingPath;
        }
        throw error;
      }
      try {
        await destination.promote();
      } catch (error) {
        await destination.preserve();
        error.registryCommitState = COMMIT_STATE.COMMITTED;
        error.sensitiveOutputPreserved = destination.pendingPath;
        throw error;
      }
      print({
        ok: true,
        nodeId: provisioned.nodeId,
        certificateId: provisioned.certificateId,
        registryCommitState: COMMIT_STATE.COMMITTED,
        sensitiveOutput: destination.path
      });
      return;
    }
    case "list": {
      print({ ok: true, ...(await registry.inspect()) });
      return;
    }
    case "revoke": {
      const nodeId = requiredOption(options, "--node-id");
      print({ ok: true, device: await registry.revokeDevice(nodeId) });
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  writeFileSync(
    process.stderr.fd,
    `${JSON.stringify(
      {
        ok: false,
        code: error?.code ?? "CLI_ERROR",
        error: error?.message ?? String(error),
        registryCommitted: error?.registryCommitted === true,
        registryCommitState: error?.registryCommitState,
        sensitiveOutputPreserved: error?.sensitiveOutputPreserved
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  process.exitCode = 1;
});
