import { SessionsRelationalRepository, UsersRelationalRepository } from "../../db/relational/index.js";

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function createPrimaryError(domain, reason = "") {
  const suffix = reason ? `: ${reason}` : "";
  return new Error(`DB relazionale primary non disponibile per ${domain}${suffix}`);
}

function createIdentityUnavailableError(status) {
  const error = new Error("Store identity PostgreSQL non disponibile.");
  error.code = "IDENTITY_STORE_UNAVAILABLE";
  error.status = 503;
  error.details = {
    reason: status?.reason ?? "never_loaded",
    ageMs: status?.ageMs ?? null,
    maxStalenessMs: status?.maxStalenessMs ?? null,
  };
  return error;
}

function requireSynchronousIdentityResult(value, operation) {
  if (value && typeof value.then === "function") {
    const error = new Error(`Contratto store identity non valido per ${operation}: atteso risultato sincrono.`);
    error.code = "IDENTITY_STORE_CONTRACT_VIOLATION";
    error.status = 500;
    throw error;
  }
  return value;
}

export function createAuthRepository(options = {}) {
  const relationalRuntime = options.relationalRuntime ?? null;
  const identityStore = options.identityStore ?? null;
  const normalizeUsername =
    typeof options.normalizeUsername === "function"
      ? options.normalizeUsername
      : (value) => asTrimmedString(value).toLowerCase();

  function isPrimaryDomain(domain) {
    return Boolean(relationalRuntime?.isPrimaryDomain?.(domain));
  }

  function isIdentityPrimary(collection) {
    return Boolean(identityStore?.isPrimaryDomain?.(collection));
  }

  if (isIdentityPrimary("users") && isPrimaryDomain("users")) {
    throw new Error(
      "Conflitto di source of truth su 'users': BACKEND_POSTGRES_PRIMARY_DOMAINS " +
        "e BACKEND_RELATIONAL_PRIMARY_DOMAINS non possono essere attivi insieme.",
    );
  }

  function requireFreshIdentitySnapshot() {
    const status = identityStore?.snapshotStatus?.() ?? {
      ok: false,
      reason: "never_loaded",
      ageMs: null,
      maxStalenessMs: null,
    };
    if (!status.ok) throw createIdentityUnavailableError(status);
  }

  function requireRelationalDb(domain) {
    const db = relationalRuntime?.db ?? null;
    if (!db) {
      throw createPrimaryError(domain, "connessione non inizializzata");
    }
    return db;
  }

  function usersRepo() {
    return new UsersRelationalRepository(requireRelationalDb("users"));
  }

  function sessionsRepo() {
    return new SessionsRelationalRepository(requireRelationalDb("sessions"));
  }

  function listUsers(appState) {
    if (isIdentityPrimary("users")) {
      requireFreshIdentitySnapshot();
      return requireSynchronousIdentityResult(identityStore.listUsers(), "listUsers");
    }
    if (isPrimaryDomain("users")) {
      return usersRepo().list();
    }
    return Array.isArray(appState?.users) ? appState.users : [];
  }

  function getUserById(appState, id) {
    const safeId = asTrimmedString(id);
    if (!safeId) return null;
    if (isIdentityPrimary("users")) {
      requireFreshIdentitySnapshot();
      return requireSynchronousIdentityResult(identityStore.getUserById(safeId), "getUserById");
    }
    if (isPrimaryDomain("users")) {
      return usersRepo().getById(safeId);
    }
    return Array.isArray(appState?.users)
      ? appState.users.find((entry) => asTrimmedString(entry?.id) === safeId) ?? null
      : null;
  }

  function getUserByUsername(appState, username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    const users = listUsers(appState);
    return users.find((entry) => normalizeUsername(entry?.username) === normalized) ?? null;
  }

  function findSessionByTokenHash(appState, options = {}) {
    const tokenHash = asTrimmedString(options.tokenHash);
    const deviceUuid = asTrimmedString(options.deviceUuid);
    const userId = asTrimmedString(options.userId);
    if (!tokenHash || !deviceUuid) return null;

    if (isPrimaryDomain("sessions")) {
      const session = sessionsRepo().getByTokenHash(tokenHash);
      if (!session) return null;
      if (asTrimmedString(session.deviceUuid) !== deviceUuid) return null;
      if (userId && asTrimmedString(session.userId) !== userId) return null;
      return session;
    }

    const sessions = Array.isArray(appState?.sessions) ? appState.sessions : [];
    return (
      (userId
        ? sessions.find(
            (item) =>
              asTrimmedString(item?.tokenHash) === tokenHash &&
              asTrimmedString(item?.userId) === userId &&
              asTrimmedString(item?.deviceUuid) === deviceUuid
          )
        : null) ??
      sessions.find(
        (item) =>
          asTrimmedString(item?.tokenHash) === tokenHash &&
          asTrimmedString(item?.deviceUuid) === deviceUuid
      ) ??
      null
    );
  }

  return {
    findSessionByTokenHash,
    getUserById,
    getUserByUsername,
    isIdentityPrimary,
    isPrimaryDomain,
    listUsers,
  };
}
