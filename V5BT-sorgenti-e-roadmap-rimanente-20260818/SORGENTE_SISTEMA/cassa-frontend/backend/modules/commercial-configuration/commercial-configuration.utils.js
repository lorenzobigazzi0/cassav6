import { createHash, randomUUID } from "node:crypto";

export function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function asString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function normalizeId(value, fallback = "") {
  const normalized = asString(value, fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

export function normalizeExternalId(value, fallback = "") {
  const normalized = asString(value, fallback)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 160);
  return normalized || fallback;
}

export function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "active"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled", "inactive"].includes(normalized)) return false;
  return fallback;
}

export function clampInteger(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function centsFromMoney(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") {
    const normalized = value
      .replace(/[^\d,.-]/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : fallback;
}

export function normalizeCents(value, fallback = 0, { min = 0, max = 999_999_999 } = {}) {
  const direct = Number(value);
  if (!Number.isFinite(direct)) return fallback;
  return Math.max(min, Math.min(max, Math.round(direct)));
}

export function moneyFromCents(value) {
  return Math.round(Number(value) || 0) / 100;
}

export function uniqueStrings(value, { limit = 500, normalize = asString } = {}) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;]+/)
      : value == null
        ? []
        : [value];
  const seen = new Set();
  const result = [];
  for (const entry of source) {
    const normalized = normalize(entry, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

export function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) throw new TypeError("Struttura circolare non serializzabile.");
    seen.add(entry);
    if (Array.isArray(entry)) {
      const result = entry.map(normalize);
      seen.delete(entry);
      return result;
    }
    const result = {};
    for (const key of Object.keys(entry).sort()) {
      const normalized = normalize(entry[key]);
      if (normalized !== undefined) result[key] = normalized;
    }
    seen.delete(entry);
    return result;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function createOpaqueId(prefix = "id") {
  return `${normalizeId(prefix, "id")}_${randomUUID().replace(/-/g, "")}`;
}

export function nowIso(value = null) {
  if (typeof value === "function") return nowIso(value());
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export function normalizeIsoDateTime(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

export function compareText(left, right) {
  return asString(left).localeCompare(asString(right), "it-IT", { sensitivity: "base" });
}

export function assertPlainObject(value, label = "valore") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} deve essere un oggetto.`);
  }
  return value;
}

export function buildActor(input = {}) {
  return {
    userId: normalizeExternalId(input.userId ?? input.id, "system"),
    username: asString(input.username ?? input.name, "system").slice(0, 120),
    deviceUuid: normalizeExternalId(input.deviceUuid, ""),
    clientApp: normalizeExternalId(input.clientApp, ""),
  };
}
