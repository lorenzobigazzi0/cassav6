/**
 * Write model delle due route radio che scrivono (P2b, dominio `configuration`).
 *
 * Possiede l'unico accesso all'app-state per queste route: gli handler non
 * vedono piu `db`. I corpi arrivano invariati da `radio.handlers.js`, compreso
 * il dettaglio che qui `touchSettingsMetadata` riceve il timestamp esplicito,
 * a differenza delle scritture di `settings`.
 *
 * Gli errori restano `HttpError` lanciati: il dispatcher li converte gia in
 * risposta HTTP.
 */
import {
  sanitizeRadioChannels,
  sanitizeRadioPreferences,
  sanitizeRadioSlots,
  upsertRadioPreference,
} from "./radio.domain.js";
import {
  buildMobileRadioResponse,
  buildSettingsRadioResponse,
  enabledChannels,
  mergeRadioChannelTimestamps,
  userDisplayId,
} from "./radio.handlers.js";

export function createRadioWriteModel({
  HttpError,
  hasPermission,
  isPosPrivilegedRole,
  nowIso,
  readDb,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  touchSettingsMetadata,
  validateSessionContext,
  writeDb,
}) {
  const responseHelpers = { resolveSettingsLastWriteAt, resolveSettingsVersion };

  async function saveSettingsRadio(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (!isPosPrivilegedRole(user.role) && !hasPermission(user, "manage_settings")) {
      throw new HttpError(403, "Utente non autorizzato alla configurazione radio.");
    }

    const currentSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const updatedAt = typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const updatedBy = userDisplayId(user);
    const radioChannels = mergeRadioChannelTimestamps(
      sanitizeRadioChannels(payload.channels),
      currentSettings.radioChannels,
      updatedAt,
      updatedBy
    );
    const radioPreferences = sanitizeRadioPreferences(currentSettings.radioPreferences, radioChannels);
    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        radioChannels,
        radioPreferences,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      }
    );

    db.posSettings = settings;
    touchSettingsMetadata(db, updatedAt);
    await writeDb(db);

    return buildSettingsRadioResponse(db, settings, responseHelpers);
  }

  async function saveMobileRadioConfig(payload) {
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    const deviceUuid = String(payload.deviceUuid ?? session?.deviceUuid ?? "").trim();
    if (!deviceUuid) {
      throw new HttpError(400, "Palmare non valido.");
    }
    const currentSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const channels = enabledChannels(currentSettings);
    const updatedAt = typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const updatedBy = userDisplayId(user);
    const preferenceSettings = upsertRadioPreference(currentSettings, {
      userId: user.id,
      deviceUuid,
      slots: sanitizeRadioSlots(payload.slots, channels),
      updatedAt,
      updatedBy,
    });
    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        radioChannels: currentSettings.radioChannels,
        radioPreferences: preferenceSettings.radioPreferences,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      }
    );

    db.posSettings = settings;
    touchSettingsMetadata(db, updatedAt);
    await writeDb(db);

    return buildMobileRadioResponse(db, settings, user.id, deviceUuid, responseHelpers);
  }

  return { saveMobileRadioConfig, saveSettingsRadio };
}
