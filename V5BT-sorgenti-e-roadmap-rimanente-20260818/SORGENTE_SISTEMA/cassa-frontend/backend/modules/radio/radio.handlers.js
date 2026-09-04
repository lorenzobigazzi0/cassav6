import {
  resolveRadioPreference,
  sanitizeRadioChannel,
  sanitizeRadioChannels,
  sanitizeRadioPreferences,
  sanitizeRadioSlots,
  upsertRadioPreference,
} from "./radio.domain.js";

export function userDisplayId(user) {
  return String(user?.username ?? user?.id ?? "").trim() || "system";
}

function resolveLastWriteAt(db, resolveSettingsLastWriteAt) {
  if (typeof resolveSettingsLastWriteAt === "function") {
    return resolveSettingsLastWriteAt(db?.meta);
  }
  return String(db?.meta?.settingsLastWriteAt ?? db?.meta?.lastWriteAt ?? "").trim();
}

function resolveVersion(db, resolveSettingsVersion) {
  if (typeof resolveSettingsVersion === "function") {
    return resolveSettingsVersion(db?.meta);
  }
  const version = new Date(resolveLastWriteAt(db)).getTime();
  return Number.isFinite(version) ? version : Date.now();
}

export function enabledChannels(settings) {
  return sanitizeRadioChannels(settings?.radioChannels).filter((channel) => channel.enabled);
}

export function buildSettingsRadioResponse(db, settings, helpers) {
  return {
    ok: true,
    channels: sanitizeRadioChannels(settings?.radioChannels),
    lastWriteAt: resolveLastWriteAt(db, helpers.resolveSettingsLastWriteAt),
    version: resolveVersion(db, helpers.resolveSettingsVersion),
  };
}

export function buildMobileRadioResponse(db, settings, userId, deviceUuid, helpers) {
  const channels = enabledChannels(settings);
  const preference = resolveRadioPreference(
    {
      radioChannels: channels,
      radioPreferences: settings?.radioPreferences,
    },
    userId,
    deviceUuid
  );
  return {
    ok: true,
    channels,
    slots: preference.slots,
    preference,
    lastWriteAt: resolveLastWriteAt(db, helpers.resolveSettingsLastWriteAt),
    version: resolveVersion(db, helpers.resolveSettingsVersion),
  };
}

export function mergeRadioChannelTimestamps(channels, currentChannels, now, updatedBy) {
  const currentById = new Map(sanitizeRadioChannels(currentChannels).map((channel) => [channel.id, channel]));
  return channels.map((channel, index) => {
    const current = currentById.get(channel.id);
    return sanitizeRadioChannel(
      {
        ...channel,
        createdAt: channel.createdAt ?? current?.createdAt ?? now,
        updatedAt: now,
        updatedBy,
      },
      index
    );
  }).filter((channel) => channel !== null);
}

export function createRadioHandlers({
  saveMobileRadioConfig,
  saveSettingsRadio,
  readMobileRadioConfigView,
  readSettingsRadioView,
  HttpError,
  hasPermission,
  isPosPrivilegedRole,
  nowIso,
  readDb,
  readJsonBody,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  sendJson,
  touchSettingsMetadata,
  validateSessionContext,
  writeDb,
}) {
  const responseHelpers = {
    resolveSettingsLastWriteAt,
    resolveSettingsVersion,
  };

  async function handleSettingsRadio(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readSettingsRadioView(payload));
  }

  async function handleSaveSettingsRadio(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveSettingsRadio(payload));
  }

  async function handleMobileRadioConfig(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readMobileRadioConfigView(payload));
  }

  async function handleSaveMobileRadioConfig(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveMobileRadioConfig(payload));
  }

  return {
    "settings.radio": handleSettingsRadio,
    "settings.saveRadio": handleSaveSettingsRadio,
    "mobile.radioConfig": handleMobileRadioConfig,
    "mobile.saveRadioConfig": handleSaveMobileRadioConfig,
  };
}
