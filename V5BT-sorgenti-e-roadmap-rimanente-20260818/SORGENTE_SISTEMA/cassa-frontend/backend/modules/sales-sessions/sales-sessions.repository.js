import { SaleSessionsRelationalRepository } from "../../db/relational/index.js";

function createPrimaryError(domain, reason = "") {
  const suffix = reason ? `: ${reason}` : "";
  return new Error(`DB relazionale primary non disponibile per ${domain}${suffix}`);
}

export function createSaleSessionsRepository(options = {}) {
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
      return callback(new SaleSessionsRelationalRepository(requireRelationalDb("saleSessions")));
    } catch (error) {
      if (error?.message?.startsWith("DB relazionale primary non disponibile")) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw createPrimaryError("saleSessions", reason);
    }
  }

  function buildStatusSource(appState) {
    if (!isPrimaryDomain("saleSessions")) {
      return appState;
    }
    return runPrimaryRead((repo) => ({
      ...appState,
      saleSessions: repo.list(),
      solarClosures: repo.listSolarClosures(),
    }));
  }

  return {
    buildStatusSource,
    isPrimaryDomain,
  };
}
