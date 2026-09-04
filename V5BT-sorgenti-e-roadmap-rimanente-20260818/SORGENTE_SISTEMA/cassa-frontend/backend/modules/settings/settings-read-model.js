/**
 * Reader identity/configuration delle route di sola lettura di `settings`
 * (P2b, MIG-032 sul dominio `configuration`).
 *
 * Possiede l'unico accesso all'app-state per queste quattro route e restituisce
 * il corpo della risposta gia composto: gli handler non vedono piu `db`.
 *
 * Come per `backend/users/users-list-read-model.js`, `validateSessionContext`
 * resta qui dentro: non e una lettura pura, perche su sessione scaduta rimuove
 * la sessione, registra l'audit e aggiorna `meta.lastWriteAt` in memoria prima
 * di sollevare 401. Spostarla fuori cambierebbe il comportamento.
 */
import { buildConfigurationSnapshot } from "../configuration/index.js";
import { readUserPaymentPreferences } from "./settings.handlers.js";

export function createSettingsReadModel({
  buildPosAreasPayload,
  buildPosSettingsPayload,
  readDb,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  validateSessionContext,
}) {
  async function leggiStatoSanitizzato(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    return { db, user, settings };
  }

  async function readPosSettingsView(payload) {
    const { db, settings } = await leggiStatoSanitizzato(payload);
    return {
      ...buildPosSettingsPayload(settings),
      lastWriteAt: resolveSettingsLastWriteAt(db.meta),
      version: resolveSettingsVersion(db.meta),
    };
  }

  async function readConfigurationSnapshotView(payload) {
    const { db, settings } = await leggiStatoSanitizzato(payload);
    return buildConfigurationSnapshot({
      settings,
      rawSettings: db.posSettings,
      users: db.users,
      meta: db.meta,
    });
  }

  async function readPosAreasView(payload) {
    const { db, settings } = await leggiStatoSanitizzato(payload);
    return {
      ...buildPosAreasPayload(db, settings),
      lastWriteAt: resolveSettingsLastWriteAt(db.meta),
      version: resolveSettingsVersion(db.meta),
    };
  }

  async function readUserPaymentPreferencesView(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    return { ok: true, preferences: readUserPaymentPreferences(user) };
  }

  return {
    readConfigurationSnapshotView,
    readPosAreasView,
    readPosSettingsView,
    readUserPaymentPreferencesView,
  };
}
