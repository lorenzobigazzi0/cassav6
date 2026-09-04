/**
 * Modello di `health` e `monitor.overview` (P2b, dominio `app_meta`).
 *
 * Sono le due route di stato che leggevano l'app-state dal corpo del handler.
 * Entrambe leggono con `allowMigrations: false` e **non validano la sessione**:
 * `monitor.overview` e dichiarata pubblica e `health` pure. Le due differenze
 * sono conservate qui.
 *
 * `resolveHealthSettingsVersion` porta dentro **tutta** la scelta, non solo la
 * lettura: la versione arriva dallo snapshot di salute quando c'e, e solo
 * altrimenti da `db.meta`. Spezzarla lascerebbe al handler il compito di
 * sapere quando serve l'app-state, che e esattamente cio che P2b toglie.
 *
 * `monitor.control` non e qui: il suo grappolo di funzioni locali -- 23
 * funzioni per 476 righe -- va estratto in un passo dedicato.
 */
export function createAppMetaModel({
  buildMonitorOverview,
  getHealthSnapshot,
  readDb,
  resolveSettingsVersion,
}) {
  async function resolveHealthSettingsVersion() {
    const snapshot = typeof getHealthSnapshot === "function" ? getHealthSnapshot() : null;
    if (Number.isFinite(Number(snapshot?.settingsVersion))) {
      return Number(snapshot.settingsVersion);
    }
    return resolveSettingsVersion((await readDb({ allowMigrations: false }))?.meta);
  }

  async function readMonitorOverviewView() {
    const db = await readDb({ allowMigrations: false });
    return buildMonitorOverview(db);
  }

  return {
    resolveHealthSettingsVersion,
    readMonitorOverviewView,
  };
}
