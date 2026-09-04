import { CAPABILITY_BITS } from "../protocol/advertisement-v1.mjs";

export const ANDROID_PEER_ROLES_V1 = Object.freeze({
  GATT_SERVER: "GATT_SERVER",
  GATT_CLIENT: "GATT_CLIENT"
});

const FULL_NODE_MASK =
  CAPABILITY_BITS.SCAN |
  CAPABILITY_BITS.ADVERTISE |
  CAPABILITY_BITS.GATT_CLIENT |
  CAPABILITY_BITS.GATT_SERVER;
const ALIAS_PATTERN = /^[0-9a-f]{12}$/;
const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{32}$/;

export class AndroidPeerRoleElectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AndroidPeerRoleElectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AndroidPeerRoleElectionError(code, message);
}

function node(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_NODE", `${field} must be an object`);
  }
  if (!Number.isSafeInteger(value.aliasEpoch) || value.aliasEpoch < 0) {
    fail("INVALID_ALIAS_EPOCH", `${field}.aliasEpoch is invalid`);
  }
  if (typeof value.rotatingAlias !== "string" || !ALIAS_PATTERN.test(value.rotatingAlias)) {
    fail("INVALID_ALIAS", `${field}.rotatingAlias is not canonical`);
  }
  if (!Number.isSafeInteger(value.capabilities) || value.capabilities < 0 || value.capabilities > 0x7f) {
    fail("INVALID_CAPABILITIES", `${field}.capabilities is invalid`);
  }
  const fullNode = (value.capabilities & FULL_NODE_MASK) === FULL_NODE_MASK;
  const clientCapable = (value.capabilities & CAPABILITY_BITS.GATT_CLIENT) !== 0;
  const serverCapable = (value.capabilities & CAPABILITY_BITS.GATT_SERVER) !== 0;
  if (!clientCapable && !serverCapable) {
    fail("NODE_NOT_CONNECTABLE", `${field} has no direct-session capability`);
  }
  return Object.freeze({
    aliasEpoch: value.aliasEpoch,
    rotatingAlias: value.rotatingAlias,
    capabilities: value.capabilities,
    fullNode,
    clientCapable,
    serverCapable
  });
}

export function electAndroidPeerRolesV1(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_ELECTION", "role election input must be an object");
  }
  const local = node(input.local, "local");
  const remote = node(input.remote, "remote");
  if (local.aliasEpoch !== remote.aliasEpoch) {
    fail("EPOCH_MISMATCH", "role election requires aliases from the same epoch");
  }
  if (!local.fullNode || !remote.fullNode) {
    if (
      (local.clientCapable && !local.serverCapable) ||
      (remote.clientCapable && !remote.serverCapable)
    ) {
      fail(
        "CLIENT_ONLY_NOT_ELIGIBLE",
        "CLIENT_ONLY Android nodes cannot participate in peer sessions"
      );
    }
    fail("FULL_NODE_REQUIRED", "Android peer sessions require two FULL_NODE peers");
  }

  if (local.rotatingAlias === remote.rotatingAlias) {
    fail("ALIAS_COLLISION", "equal rotating aliases cannot elect a role safely");
  }
  const localRole =
    local.rotatingAlias < remote.rotatingAlias
      ? ANDROID_PEER_ROLES_V1.GATT_SERVER
      : ANDROID_PEER_ROLES_V1.GATT_CLIENT;
  return Object.freeze({
    aliasEpoch: local.aliasEpoch,
    localRole,
    remoteRole:
      localRole === ANDROID_PEER_ROLES_V1.GATT_SERVER
        ? ANDROID_PEER_ROLES_V1.GATT_CLIENT
        : ANDROID_PEER_ROLES_V1.GATT_SERVER,
    localShouldInitiate: localRole === ANDROID_PEER_ROLES_V1.GATT_CLIENT,
    fullNodePair: local.fullNode && remote.fullNode
  });
}

function canonicalNodeId(value, field) {
  if (typeof value !== "string" || !NODE_ID_PATTERN.test(value)) {
    fail("INVALID_NODE_ID", `${field} is not a canonical node UUID`);
  }
  return value;
}

export function orderedAndroidNodePairV1(first, second) {
  const a = canonicalNodeId(first, "firstNodeId");
  const b = canonicalNodeId(second, "secondNodeId");
  if (a === b) fail("IDENTICAL_NODE_IDS", "peer node IDs must be distinct");
  return Object.freeze(a < b ? [a, b] : [b, a]);
}

export function selectCanonicalAndroidPeerConnectionV1(input) {
  const pair = orderedAndroidNodePairV1(input.localNodeId, input.remoteNodeId);
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    fail("NO_CONNECTION_CANDIDATES", "at least one connection is required");
  }
  const candidates = input.candidates.map((candidate, index) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof candidate.connectionId !== "string" ||
      !CONNECTION_ID_PATTERN.test(candidate.connectionId)
    ) {
      fail("INVALID_CONNECTION", `candidate ${index} is invalid`);
    }
    const initiator = canonicalNodeId(candidate.initiatorNodeId, "initiatorNodeId");
    const responder = canonicalNodeId(candidate.responderNodeId, "responderNodeId");
    const candidatePair = orderedAndroidNodePairV1(initiator, responder);
    if (candidatePair[0] !== pair[0] || candidatePair[1] !== pair[1]) {
      fail("CONNECTION_PAIR_MISMATCH", "candidate belongs to another node pair");
    }
    return Object.freeze({
      connectionId: candidate.connectionId,
      initiatorNodeId: initiator,
      responderNodeId: responder
    });
  });
  const keep = [...candidates].sort((a, b) =>
    a.connectionId.localeCompare(b.connectionId)
  )[0];
  return Object.freeze({
    orderedNodePair: pair,
    keepConnectionId: keep.connectionId,
    closeConnectionIds: Object.freeze(
      candidates
        .filter((candidate) => candidate.connectionId !== keep.connectionId)
        .map((candidate) => candidate.connectionId)
        .sort()
    )
  });
}
