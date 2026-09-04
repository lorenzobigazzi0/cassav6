import { MenuSettingsRelationalRepository } from "../../db/relational/index.js";

function createPrimaryError(domain, reason = "") {
  const suffix = reason ? `: ${reason}` : "";
  return new Error(`DB relazionale primary non disponibile per ${domain}${suffix}`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

export function createMenuSettingsRepository(options = {}) {
  const relationalRuntime = options.relationalRuntime ?? null;

  function isPrimaryDomain(domain) {
    return Boolean(relationalRuntime?.isPrimaryDomain?.(domain));
  }

  function requireRelationalDb(domain) {
    const db = relationalRuntime?.db ?? null;
    if (!db) {
      throw createPrimaryError(domain, "connessione non inizializzata");
    }
    return db;
  }

  function runPrimaryRead(callback) {
    try {
      return callback(new MenuSettingsRelationalRepository(requireRelationalDb("menuSettings")));
    } catch (error) {
      if (error?.message?.startsWith("DB relazionale primary non disponibile")) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw createPrimaryError("menuSettings", reason);
    }
  }

  function getMenuItems(appState) {
    if (isPrimaryDomain("menuSettings")) {
      return runPrimaryRead((repo) => repo.listMenuItemsInAppStateOrder());
    }
    return asArray(appState?.menuItems);
  }

  function getPaymentMethods(appState) {
    if (isPrimaryDomain("menuSettings")) {
      return runPrimaryRead((repo) => repo.listPaymentMethods());
    }
    return asArray(appState?.posSettings?.paymentMethods);
  }

  function getStaticPosSettings(appState) {
    if (!isPrimaryDomain("menuSettings")) {
      return appState?.posSettings;
    }
    return runPrimaryRead((repo) => ({
      ...clonePlainObject(appState?.posSettings),
      paymentMethods: repo.listPaymentMethods(),
      rooms: repo.listRooms(),
      tables: repo.listTables(),
    }));
  }

  return {
    getMenuItems,
    getPaymentMethods,
    getStaticPosSettings,
    isPrimaryDomain,
  };
}
