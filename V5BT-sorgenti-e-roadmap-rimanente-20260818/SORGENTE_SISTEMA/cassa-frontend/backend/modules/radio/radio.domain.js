export const RADIO_SLOT_COUNT = 3;

const DEFAULT_RADIO_COLORS = [
  "#ff9f43",
  "#00d2ff",
  "#2ed573",
  "#a55eea",
  "#ff4757",
  "#ffa502",
];

function trimString(value, maxLength = 120) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function removeDiacritics(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeRadioChannelId(value, fallback = "") {
  const normalized = removeDiacritics(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "";
}

function normalizePreferenceKeyPart(value) {
  return removeDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function normalizeColor(value, fallback) {
  const candidate = trimString(value, 16).toLowerCase();
  return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : fallback;
}

function normalizeSortOrder(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(9999, Math.trunc(parsed)));
}

function channelNameFromId(id) {
  return String(id ?? "")
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
    .trim();
}

export function sanitizeRadioChannel(entry, fallbackIndex = 0) {
  if (!entry || typeof entry !== "object") return null;
  const rawName = trimString(entry.name ?? entry.label ?? "", 80);
  const rawId = entry.id ?? entry.channelId ?? entry.key;
  if (!trimString(rawId, 80) && !rawName) return null;
  const fallbackId = rawName || `canale_${fallbackIndex + 1}`;
  const id = normalizeRadioChannelId(rawId, fallbackId);
  if (!id) return null;
  const name = rawName || channelNameFromId(id) || `Canale ${fallbackIndex + 1}`;
  const color = normalizeColor(
    entry.color,
    DEFAULT_RADIO_COLORS[fallbackIndex % DEFAULT_RADIO_COLORS.length]
  );
  const channel = {
    id,
    name: name.slice(0, 80),
    enabled: entry.enabled !== false,
    color,
    sortOrder: normalizeSortOrder(entry.sortOrder, (fallbackIndex + 1) * 10),
  };
  for (const key of ["createdAt", "updatedAt", "updatedBy"]) {
    const value = trimString(entry[key], 120);
    if (value) channel[key] = value;
  }
  return channel;
}

export function sanitizeRadioChannels(entries) {
  const channelsById = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const channel = sanitizeRadioChannel(entry, index);
    if (channel) channelsById.set(channel.id, channel);
  });
  return [...channelsById.values()].sort((left, right) => {
    const sortOrder = left.sortOrder - right.sortOrder;
    if (sortOrder !== 0) return sortOrder;
    return left.name.localeCompare(right.name, "it-IT");
  });
}

function enabledChannelIds(channels) {
  return new Set(sanitizeRadioChannels(channels).filter((channel) => channel.enabled).map((channel) => channel.id));
}

export function sanitizeRadioSlots(slots, channels) {
  const allowedIds = enabledChannelIds(channels);
  const source = Array.isArray(slots) ? slots : [];
  const seen = new Set();
  return Array.from({ length: RADIO_SLOT_COUNT }, (_, index) => {
    const channelId = normalizeRadioChannelId(source[index]);
    if (!channelId || !allowedIds.has(channelId) || seen.has(channelId)) return null;
    seen.add(channelId);
    return channelId;
  });
}

export function buildRadioPreferenceId(userId, deviceUuid) {
  const safeUserId = normalizePreferenceKeyPart(userId);
  const safeDeviceUuid = normalizePreferenceKeyPart(deviceUuid);
  return safeUserId && safeDeviceUuid ? `${safeUserId}:${safeDeviceUuid}` : "";
}

export function sanitizeRadioPreference(entry, channels, fallback = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  const userId = normalizePreferenceKeyPart(source.userId ?? fallback.userId);
  const deviceUuid = normalizePreferenceKeyPart(source.deviceUuid ?? fallback.deviceUuid);
  const id = buildRadioPreferenceId(userId, deviceUuid);
  if (!id) return null;
  const preference = {
    id,
    userId,
    deviceUuid,
    slots: sanitizeRadioSlots(source.slots ?? fallback.slots, channels),
    updatedAt: trimString(source.updatedAt ?? fallback.updatedAt, 120),
  };
  const updatedBy = trimString(source.updatedBy ?? fallback.updatedBy, 120);
  if (updatedBy) preference.updatedBy = updatedBy;
  return preference;
}

export function sanitizeRadioPreferences(entries, channels) {
  const preferencesById = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const preference = sanitizeRadioPreference(entry, channels);
    if (preference) preferencesById.set(preference.id, preference);
  });
  return [...preferencesById.values()].sort((left, right) => left.id.localeCompare(right.id, "it-IT"));
}

function radioPreferenceTime(preference) {
  const parsed = Date.parse(String(preference?.updatedAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectRadioPreferenceForCurrentDevice(preference, fallback) {
  if (!preference) return fallback;
  if (!fallback.id) return preference;
  return {
    ...preference,
    id: fallback.id,
    userId: fallback.userId,
    deviceUuid: fallback.deviceUuid,
  };
}

export function resolveRadioPreference(settings, userId, deviceUuid) {
  const channels = sanitizeRadioChannels(settings?.radioChannels);
  const fallback =
    sanitizeRadioPreference(
      {
        userId,
        deviceUuid,
        slots: [null, null, null],
      },
      channels
    ) ?? {
      id: "",
      userId: normalizePreferenceKeyPart(userId),
      deviceUuid: normalizePreferenceKeyPart(deviceUuid),
      slots: [null, null, null],
      updatedAt: "",
    };
  const preferences = sanitizeRadioPreferences(settings?.radioPreferences, channels);
  const userPreference = preferences
    .filter((preference) => preference.userId && preference.userId === fallback.userId)
    .sort((left, right) => {
      const byTime = radioPreferenceTime(right) - radioPreferenceTime(left);
      if (byTime !== 0) return byTime;
      return right.id.localeCompare(left.id, "it-IT");
    })[0];

  return projectRadioPreferenceForCurrentDevice(userPreference, fallback);
}

export function upsertRadioPreference(settings, preference) {
  const channels = sanitizeRadioChannels(settings?.radioChannels);
  const safePreference = sanitizeRadioPreference(preference, channels);
  if (!safePreference) {
    return {
      ...settings,
      radioChannels: channels,
      radioPreferences: sanitizeRadioPreferences(settings?.radioPreferences, channels),
    };
  }
  const preferences = sanitizeRadioPreferences(settings?.radioPreferences, channels).filter(
    (entry) => entry.id !== safePreference.id
  );
  preferences.push(safePreference);
  return {
    ...settings,
    radioChannels: channels,
    radioPreferences: sanitizeRadioPreferences(preferences, channels),
  };
}
