#!/usr/bin/env node

import {
  constants as fsConstants
} from "node:fs";
import {
  lstat,
  open,
  realpath
} from "node:fs/promises";
import {
  createServer
} from "node:https";
import path from "node:path";
import {
  pathToFileURL
} from "node:url";

import {
  DeviceRegistryV2
} from "../../shared/provisioning/device-registry-v2.mjs";
import {
  createEnrollmentRequestHandler as createEnrollmentRequestHandlerV1,
  DEFAULT_MAX_CONCURRENT_ENROLLMENTS,
  isCanonicalEnrollmentEndpointId
} from "../../shared/provisioning/enrollment-transport-v1.mjs";
import {
  createEnrollmentRequestHandler as createEnrollmentRequestHandlerV2
} from "../../shared/provisioning/enrollment-transport-v2.mjs";
import {
  createPeerTrustDirectoryRequestHandlerV1
} from "../../shared/provisioning/peer-trust-transport-v1.mjs";
import {
  loadPeerTrustAuthorityFromFileV1
} from "../dist/security/PeerTrustAuthorityKeyFileV1.js";
import {
  PeerTrustDirectoryRuntimeV1
} from "../dist/security/PeerTrustDirectoryRuntimeV1.js";
import {
  PeerTrustPublishedDirectoryStoreV1
} from "../dist/security/PeerTrustPublishedDirectoryStoreV1.js";

const REQUIRED_PRIVATE_MODE = 0o600;
const DEFAULT_PORT = 9443;
const MAX_CONNECTIONS = 32;
export const V6_STATE_ROOT = "/var/lib/cassav6-bluetooth";
const FORBIDDEN_V4_STATE_ROOT = "/var/lib/cassav6-bluetooth";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("CASSA_BT_ENROLLMENT_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

export function validateConfiguredStateRoot(stateRootValue) {
  if (
    stateRootValue !== undefined &&
    stateRootValue.trim() !== "" &&
    path.resolve(stateRootValue) !== V6_STATE_ROOT
  ) {
    throw new Error("CASSA_BT_STATE_ROOT cannot redefine the V6 state root");
  }
  return V6_STATE_ROOT;
}

export async function isolatedRegistryPath(
  registryValue,
  { stateRoot = V6_STATE_ROOT } = {}
) {
  const registryPath = path.resolve(registryValue);
  const resolvedStateRoot = path.resolve(stateRoot);
  const forbiddenRoot = path.resolve(FORBIDDEN_V4_STATE_ROOT);
  if (
    resolvedStateRoot === forbiddenRoot ||
    isWithin(resolvedStateRoot, forbiddenRoot) ||
    registryPath === forbiddenRoot ||
    isWithin(registryPath, forbiddenRoot) ||
    !isWithin(registryPath, resolvedStateRoot)
  ) {
    throw new Error("CASSA_BT_DEVICE_REGISTRY must stay inside the V6 state root");
  }

  const registryParent = path.dirname(registryPath);
  const [stateRootStat, parentStat, registryStat] = await Promise.all([
    lstat(resolvedStateRoot),
    lstat(registryParent),
    lstat(registryPath)
  ]);
  const currentUserId =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    stateRootStat.isSymbolicLink() ||
    !stateRootStat.isDirectory() ||
    (stateRootStat.mode & 0o777) !== 0o700 ||
    (currentUserId !== undefined && stateRootStat.uid !== currentUserId)
  ) {
    throw new Error("V6 state root must be an owned 0700 directory");
  }
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    (parentStat.mode & 0o077) !== 0 ||
    (currentUserId !== undefined && parentStat.uid !== currentUserId)
  ) {
    throw new Error("V6 registry parent must be a private owned directory");
  }
  if (
    registryStat.isSymbolicLink() ||
    !registryStat.isFile() ||
    registryStat.nlink !== 1 ||
    (registryStat.mode & 0o777) !== REQUIRED_PRIVATE_MODE ||
    (currentUserId !== undefined && registryStat.uid !== currentUserId)
  ) {
    throw new Error("V6 registry must be an owned single-link 0600 file");
  }
  const [canonicalRoot, canonicalParent, canonicalRegistry] = await Promise.all([
    realpath(resolvedStateRoot),
    realpath(registryParent),
    realpath(registryPath)
  ]);
  if (
    canonicalRoot !== resolvedStateRoot ||
    canonicalParent !== registryParent ||
    canonicalRegistry !== registryPath ||
    (
      canonicalParent !== canonicalRoot &&
      !isWithin(canonicalParent, canonicalRoot)
    )
  ) {
    throw new Error("V6 registry path must not traverse symbolic links");
  }
  return registryPath;
}

export function validateEndpointId(endpointId) {
  if (!isCanonicalEnrollmentEndpointId(endpointId)) {
    throw new Error("CASSA_BT_ENROLLMENT_ENDPOINT_ID is invalid");
  }
  return endpointId;
}

export async function inspectEnrollmentRegistry(
  registryValue,
  { stateRoot = V6_STATE_ROOT } = {}
) {
  const registryPath = await isolatedRegistryPath(
    registryValue,
    { stateRoot }
  );
  const registry = new DeviceRegistryV2(registryPath);
  await registry.initialize();
  await registry.inspect();
  return registry;
}

function writeJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

export function createDualEnrollmentRequestHandler({
  expectedEndpointId,
  registry,
  maxConcurrentEnrollments = DEFAULT_MAX_CONCURRENT_ENROLLMENTS,
  onRejected = null,
  peerTrustHandler = null
}) {
  if (
    !Number.isSafeInteger(maxConcurrentEnrollments) ||
    maxConcurrentEnrollments < 1 ||
    maxConcurrentEnrollments > 32
  ) {
    throw new TypeError("maxConcurrentEnrollments must be an integer from 1 to 32");
  }
  const common = {
    expectedEndpointId,
    registry,
    maxConcurrentEnrollments: 32,
    onRejected
  };
  const v1 = createEnrollmentRequestHandlerV1(common);
  const v2 = createEnrollmentRequestHandlerV2(common);
  let activeEnrollments = 0;

  return async (request, response) => {
    if (
      request.url === "/v1/peer-trust-directory" &&
      peerTrustHandler !== null
    ) {
      await peerTrustHandler(request, response);
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      try {
        if (typeof registry?.inspect !== "function") {
          throw new Error("registry unavailable");
        }
        await registry.inspect();
        writeJson(response, 200, {
          ok: true,
          component: "cassav6-bluetooth-enrollment",
          protocolVersions: [1, 2],
          preferredProtocolVersion: 2,
          registryReady: true
        });
      } catch {
        writeJson(response, 503, {
          ok: false,
          component: "cassav6-bluetooth-enrollment",
          code: "NOT_READY"
        });
      }
      return;
    }
    const handler =
      request.method === "POST" && request.url === "/v2/enroll"
        ? v2
        : v1;
    const isEnrollment =
      request.method === "POST" &&
      (request.url === "/v1/enroll" || request.url === "/v2/enroll");
    if (!isEnrollment) {
      await handler(request, response);
      return;
    }
    if (activeEnrollments >= maxConcurrentEnrollments) {
      writeJson(
        response,
        503,
        { ok: false, code: "ENROLLMENT_BUSY" },
        { connection: "close", "retry-after": "1" }
      );
      return;
    }
    activeEnrollments += 1;
    try {
      await handler(request, response);
    } finally {
      activeEnrollments -= 1;
    }
  };
}

export async function listenForEnrollment(server, port, host) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    server.once("error", onError);
    try {
      server.listen(port, host, () => {
        if (settled) return;
        settled = true;
        server.off("error", onError);
        resolve();
      });
    } catch (error) {
      server.off("error", onError);
      settled = true;
      reject(error);
    }
  });
}

async function readRegularFile(filePath, { privateFile }) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${filePath} must be a regular single-link file`);
    }
    if (
      privateFile &&
      (
        (stat.mode & 0o777) !== REQUIRED_PRIVATE_MODE ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
    ) {
      throw new Error(`${filePath} must be owned by the service user with mode 0600`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function main() {
  if (process.env.CASSA_BT_ENROLLMENT_RUNTIME_ENABLED !== "1") {
    process.stdout.write(
      `${JSON.stringify({
        component: "cassav6-bluetooth-enrollment",
        enabled: false,
        reason: "CASSA_BT_ENROLLMENT_RUNTIME_ENABLED is not 1"
      })}\n`
    );
    return;
  }

  const host = process.env.CASSA_BT_ENROLLMENT_LISTEN_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.CASSA_BT_ENROLLMENT_PORT);
  const endpointId = validateEndpointId(
    requiredEnvironment("CASSA_BT_ENROLLMENT_ENDPOINT_ID")
  );
  validateConfiguredStateRoot(process.env.CASSA_BT_STATE_ROOT);
  const registry = await inspectEnrollmentRegistry(
    requiredEnvironment("CASSA_BT_DEVICE_REGISTRY")
  );
  const tlsKeyPath = requiredEnvironment("CASSA_BT_ENROLLMENT_TLS_KEY");
  const tlsCertificatePath = requiredEnvironment("CASSA_BT_ENROLLMENT_TLS_CERT");
  const [key, cert] = await Promise.all([
    readRegularFile(tlsKeyPath, { privateFile: true }),
    readRegularFile(tlsCertificatePath, { privateFile: false })
  ]);
  const peerTrustFlag =
    process.env.CASSA_BT_PEER_TRUST_DIRECTORY_ENABLED?.trim() || "0";
  if (peerTrustFlag !== "0" && peerTrustFlag !== "1") {
    throw new Error("CASSA_BT_PEER_TRUST_DIRECTORY_ENABLED must be 0 or 1");
  }
  let peerTrustRuntime = null;
  let peerTrustAuthorityPublicKey = null;
  let peerTrustHandler = createPeerTrustDirectoryRequestHandlerV1({
    enabled: false,
    readCurrentDirectory: async () => {
      throw new Error("peer trust directory is disabled");
    }
  });
  if (peerTrustFlag === "1") {
    const publishedPath = path.resolve(
      requiredEnvironment("CASSA_BT_PEER_TRUST_PUBLISHED_PATH")
    );
    if (!isWithin(publishedPath, V6_STATE_ROOT)) {
      throw new Error("peer trust published path must stay in the V6 state root");
    }
    const authority = await loadPeerTrustAuthorityFromFileV1(
      requiredEnvironment("CASSA_BT_PEER_TRUST_AUTHORITY_KEY_PATH")
    );
    peerTrustAuthorityPublicKey = authority.publicKeySpki;
    peerTrustRuntime = new PeerTrustDirectoryRuntimeV1({
      registry,
      signer: authority.signer,
      authorityPublicKeySpki: authority.publicKeySpki,
      store: new PeerTrustPublishedDirectoryStoreV1(publishedPath),
      issuerId: endpointId
    });
    peerTrustHandler = createPeerTrustDirectoryRequestHandlerV1({
      enabled: true,
      readCurrentDirectory: () => peerTrustRuntime.readCurrentDirectory()
    });
  }
  const server = createServer(
    {
      key,
      cert,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: false
    },
    createDualEnrollmentRequestHandler({
      expectedEndpointId: endpointId,
      registry,
      maxConcurrentEnrollments: DEFAULT_MAX_CONCURRENT_ENROLLMENTS,
      peerTrustHandler,
      onRejected: ({ code, httpStatus }) => {
        process.stderr.write(
          `${JSON.stringify({
            component: "cassav6-bluetooth-enrollment",
            code,
            httpStatus
          })}\n`
        );
      }
    })
  );
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 10;
  server.maxConnections = MAX_CONNECTIONS;
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  server.on("close", () => {
    peerTrustRuntime?.close();
    peerTrustAuthorityPublicKey?.fill(0);
    key.fill(0);
  });
  await listenForEnrollment(server, port, host);
  server.on("error", (error) => {
    process.stderr.write(
      `${JSON.stringify({
        component: "cassav6-bluetooth-enrollment",
        enabled: false,
        code: "RUNTIME_FAILED",
        error: error instanceof Error ? error.message : "unknown error"
      })}\n`
    );
    process.exitCode = 1;
    server.close();
  });
  process.stdout.write(
    `${JSON.stringify({
      component: "cassav6-bluetooth-enrollment",
      enabled: true,
      host,
      port,
      protocolVersions: [1, 2],
      preferredProtocolVersion: 2,
      peerTrustDirectoryEnabled: peerTrustFlag === "1"
    })}\n`
  );
}

const directInvocation =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === directInvocation) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        component: "cassav6-bluetooth-enrollment",
        enabled: false,
        code: "STARTUP_FAILED",
        error: error instanceof Error ? error.message : "unknown error"
      })}\n`
    );
    process.exitCode = 1;
  });
}
