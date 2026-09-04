import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export function normalizeIpAddress(rawAddress) {
  const normalized = String(rawAddress ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.startsWith("::ffff:")) return normalized.slice("::ffff:".length);
  return normalized;
}

export function isLoopbackAddress(rawAddress) {
  const normalized = normalizeIpAddress(rawAddress);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function isPrivateNetworkAddress(rawAddress) {
  const normalized = normalizeIpAddress(rawAddress);
  if (!normalized) return false;
  if (isLoopbackAddress(normalized)) return true;
  if (normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;
  if (normalized.startsWith("169.254.")) return true;
  const octets = normalized.split(".");
  if (octets.length === 4 && octets[0] === "172") {
    const second = Number.parseInt(octets[1], 10);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80:")) return true;
  return false;
}

export function readHeaderValue(req, name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return "";
  const rawValue = req?.headers?.[key];
  if (Array.isArray(rawValue)) return typeof rawValue[0] === "string" ? rawValue[0].trim() : "";
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

export function extractBearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value ?? "").trim());
  return match ? match[1].trim() : "";
}

function digestToken(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

export function safeTokenEquals(provided, expected) {
  const safeProvided = String(provided ?? "").trim();
  const safeExpected = String(expected ?? "").trim();
  if (!safeProvided || !safeExpected) return false;
  // Confronta digest a lunghezza fissa per evitare scorciatoie basate sulla lunghezza del token.
  return timingSafeEqual(digestToken(safeProvided), digestToken(safeExpected));
}

export function hashOpaqueToken(token, secret) {
  const safeToken = String(token ?? "");
  const safeSecret = String(secret ?? "");
  if (!safeToken || !safeSecret) return "";
  return createHmac("sha256", safeSecret).update(safeToken).digest("hex");
}
