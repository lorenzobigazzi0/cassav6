import {
  assertPrimaryRelationalAvailable,
  isDomainReadPrimary,
  isDomainWritePrimary,
  normalizePersistenceDomainName,
} from "./persistence-mode.js";

function resolveAppStateRepository(options, appState) {
  if (typeof options.appStateRepositoryFactory === "function") {
    return options.appStateRepositoryFactory(appState);
  }
  return options.appStateRepository ?? null;
}

function resolveRelationalRepository(options) {
  const db = options.relationalDb ?? options.relationalRuntime?.db ?? null;
  if (typeof options.relationalRepositoryFactory === "function") {
    return options.relationalRepositoryFactory(db);
  }
  return options.relationalRepository ?? null;
}

export function createDomainStore(options = {}) {
  const domain = normalizePersistenceDomainName(options.domain);

  function persistenceOptions() {
    if (options.relationalRuntime?.config) {
      return { config: options.relationalRuntime.config };
    }
    return { env: options.env };
  }

  function isReadPrimary() {
    if (typeof options.relationalRuntime?.isPrimaryDomain === "function") {
      return options.relationalRuntime.isPrimaryDomain(domain);
    }
    return isDomainReadPrimary(domain, persistenceOptions());
  }

  function isWritePrimary() {
    return isDomainWritePrimary(domain, persistenceOptions());
  }

  function getReadRepository(appState) {
    if (isReadPrimary()) {
      assertPrimaryRelationalAvailable(domain, {
        ...persistenceOptions(),
        relationalRuntime: options.relationalRuntime,
        relationalDb: options.relationalDb,
      });
      return resolveRelationalRepository(options);
    }
    return resolveAppStateRepository(options, appState);
  }

  function getWriteRepository(appState) {
    return resolveAppStateRepository(options, appState);
  }

  return {
    domain,
    getReadRepository,
    getWriteRepository,
    isReadPrimary,
    isWritePrimary,
  };
}

export function createDomainStoreRegistry(definitions = {}, options = {}) {
  const stores = {};
  for (const [domain, definition] of Object.entries(definitions)) {
    stores[domain] = createDomainStore({
      ...options,
      ...definition,
      domain,
    });
  }
  return stores;
}

