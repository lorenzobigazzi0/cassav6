import { SessionsRelationalRepository, UsersRelationalRepository } from "../../db/relational/index.js";

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function createPrimaryError(domain, reason = "") {
  const suffix = reason ? `: ${reason}` : "";
  return new Error(`DB relazionale primary non disponibile per ${domain}${suffix}`);
}

export function createAuthRepository(options = {}) {
  const relationalRuntime = options.relationalRuntime ?? null;
  const normalizeUsername =
    typeof options.normalizeUsername === "function"
      ? options.normalizeUsername
      : (value) => asTrimmedString(value).toLowerCase();

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

  function usersRepo() {
    return new UsersRelationalRepository(requireRelationalDb("users"));
  }

  function sessionsRepo() {
    return new SessionsRelationalRepository(requireRelationalDb("sessions"));
  }

  function listUsers(appState) {
    if (isPrimaryDomain("users")) {
      return usersRepo().list();
    }
    return Array.isArray(appState?.users) ? appState.users : [];
  }

  function getUserById(appState, id) {
    const safeId = asTrimmedString(id);
    if (!safeId) return null;
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
    isPrimaryDomain,
    listUsers,
  };
}
