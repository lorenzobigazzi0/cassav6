import { createHmac } from "node:crypto";
import { bytesToHex } from "./advertisement-v1.mjs";

export const ROTATING_ALIAS_BYTES = 6;
export const ROTATING_ALIAS_KEY_BYTES = 32;
export const ROTATING_ALIAS_CONTEXT = "CASSAV4-BT-ALIAS-V1\0";
export const ROTATING_ALIAS_NODE_ID_UTF8_BYTES = 36;
export const ROTATING_ALIAS_EPOCH_BYTES = 8;

const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();

function assertSafeNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function encodeCanonicalNodeId(nodeId) {
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    throw new TypeError("nodeId must be a canonical lowercase RFC 4122 UUID");
  }
  const encodedNodeId = textEncoder.encode(nodeId);
  if (encodedNodeId.byteLength !== ROTATING_ALIAS_NODE_ID_UTF8_BYTES) {
    throw new TypeError(
      `nodeId must encode to exactly ${ROTATING_ALIAS_NODE_ID_UTF8_BYTES} UTF-8 bytes`
    );
  }
  return encodedNodeId;
}

function normalizeAliasKey(aliasKey) {
  if (!(aliasKey instanceof Uint8Array) || aliasKey.byteLength !== ROTATING_ALIAS_KEY_BYTES) {
    throw new TypeError(`aliasKey must be exactly ${ROTATING_ALIAS_KEY_BYTES} bytes`);
  }
  return new Uint8Array(aliasKey.buffer, aliasKey.byteOffset, aliasKey.byteLength);
}

export function rotatingAliasEpoch(timestampSeconds, epochSeconds = 60) {
  assertSafeNonNegativeInteger(timestampSeconds, "timestampSeconds");
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1 || epochSeconds > 86400) {
    throw new TypeError("epochSeconds must be an integer between 1 and 86400");
  }
  return Math.floor(timestampSeconds / epochSeconds);
}

export function buildRotatingAliasMessage({ nodeId, epoch }) {
  const encodedNodeId = encodeCanonicalNodeId(nodeId);
  assertSafeNonNegativeInteger(epoch, "epoch");

  const context = textEncoder.encode(ROTATING_ALIAS_CONTEXT);
  const epochBytes = new Uint8Array(ROTATING_ALIAS_EPOCH_BYTES);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch), false);

  const message = new Uint8Array(
    context.byteLength +
      ROTATING_ALIAS_NODE_ID_UTF8_BYTES +
      1 +
      ROTATING_ALIAS_EPOCH_BYTES
  );
  message.set(context, 0);
  message.set(encodedNodeId, context.byteLength);
  message[context.byteLength + ROTATING_ALIAS_NODE_ID_UTF8_BYTES] = 0;
  message.set(epochBytes, context.byteLength + ROTATING_ALIAS_NODE_ID_UTF8_BYTES + 1);
  return message;
}

export function deriveRotatingAlias({
  aliasKey,
  nodeId,
  timestampSeconds,
  epochSeconds = 60
}) {
  const key = normalizeAliasKey(aliasKey);
  const epoch = rotatingAliasEpoch(timestampSeconds, epochSeconds);
  const message = buildRotatingAliasMessage({ nodeId, epoch });
  const digest = createHmac("sha256", key).update(message).digest();
  return bytesToHex(digest.subarray(0, ROTATING_ALIAS_BYTES));
}
