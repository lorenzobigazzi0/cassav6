/**
 * Reader identity della route `users.list` (P2b.3).
 *
 * Possiede l'unico accesso all'app-state per questa route e restituisce il corpo
 * della risposta gia composto: il handler non vede piu `db`.
 *
 * `validateSessionContext` non e una lettura pura: su sessione scaduta rimuove la
 * sessione, registra l'evento di audit e aggiorna `meta.lastWriteAt` in memoria,
 * poi solleva 401. Per conservare il comportamento la validazione resta qui,
 * sull'app-state reale.
 */
export function createUsersListReader({
  POS_PERMISSION_DEFINITIONS,
  buildPosSettingsUsersPayload,
  hasPermission,
  readDb,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizeUser,
  validateSessionContext,
}) {
  async function readUsersListView(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (!hasPermission(user, "manage_users")) {
      return {
        ok: true,
        users: [sanitizeUser(user, db.posSettings)],
        permissions: POS_PERMISSION_DEFINITIONS.map((definition) => ({ ...definition })),
        lastWriteAt: resolveSettingsLastWriteAt(db.meta),
        version: resolveSettingsVersion(db.meta),
        readOnly: true,
      };
    }
    return buildPosSettingsUsersPayload(db);
  }

  return { readUsersListView };
}
