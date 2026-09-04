/**
 * Reader delle route radio di sola lettura (P2b, dominio `configuration`).
 *
 * Possiede l'unico accesso all'app-state per queste due route e restituisce il
 * corpo della risposta gia composto: gli handler non vedono piu `db`.
 *
 * Come negli altri reader del pilot, `validateSessionContext` resta qui dentro:
 * su sessione scaduta rimuove la sessione e aggiorna `meta.lastWriteAt` in
 * memoria prima di sollevare 401, quindi non e una lettura pura.
 */
import {
  buildMobileRadioResponse,
  buildSettingsRadioResponse,
} from "./radio.handlers.js";

export function createRadioReadModel({
  readDb,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  validateSessionContext,
}) {
  const responseHelpers = { resolveSettingsLastWriteAt, resolveSettingsVersion };

  async function leggiStatoSanitizzato(payload) {
    const db = await readDb();
    const contesto = validateSessionContext(db, payload);
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    return { db, settings, ...contesto };
  }

  async function readSettingsRadioView(payload) {
    const { db, settings } = await leggiStatoSanitizzato(payload);
    return buildSettingsRadioResponse(db, settings, responseHelpers);
  }

  async function readMobileRadioConfigView(payload) {
    const { db, settings, user, session } = await leggiStatoSanitizzato(payload);
    const deviceUuid = String(payload.deviceUuid ?? session?.deviceUuid ?? "").trim();
    return buildMobileRadioResponse(db, settings, user.id, deviceUuid, responseHelpers);
  }

  return { readMobileRadioConfigView, readSettingsRadioView };
}
