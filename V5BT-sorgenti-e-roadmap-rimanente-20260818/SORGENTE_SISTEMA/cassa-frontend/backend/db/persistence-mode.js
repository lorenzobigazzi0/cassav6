export const RELATIONAL_MODES = new Set(["off", "shadow", "primary"]);

export const RELATIONAL_DOMAINS = new Set([
  "auditEvents",
  "users",
  "sessions",
  "saleSessions",
  "payments",
  "menuSettings",
  "orders",
  "tablesBills",
  "reservations",
]);

export const RELATIONAL_READ_PRIMARY_DOMAINS = new Set([
  "users",
  "sessions",
  "menuSettings",
  "saleSessions",
]);

const RELATIONAL_DOMAIN_LABEL = Array.from(RELATIONAL_DOMAINS).join(", ");
const RELATIONAL_READ_PRIMARY_DOMAIN_LABEL = Array.from(RELATIONAL_READ_PRIMARY_DOMAINS).join(", ");

export function normalizePersistenceDomainName(value) {
  const normalized = String(value ?? "").trim();
  const compact = normalized.toLowerCase().replace(/[-_\s]+/g, "");
  if (compact === "auditevents") return "auditEvents";
  if (compact === "users") return "users";
  if (compact === "sessions") return "sessions";
  if (compact === "salesessions") return "saleSessions";
  if (compact === "payments") return "payments";
  if (compact === "menusettings") return "menuSettings";
  if (compact === "orders") return "orders";
  if (compact === "tablesbills") return "tablesBills";
  if (compact === "reservations") return "reservations";
  return normalized;
}

export function parsePersistenceDomainList(value, options = {}) {
  const allowedDomains = options.allowedDomains ?? RELATIONAL_DOMAINS;
  const envName = options.envName ?? "BACKEND_RELATIONAL_PRIMARY_DOMAINS";
  const allowedLabel = options.allowedLabel ?? Array.from(allowedDomains).join(", ");
  const domains = new Set();

  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const domain = normalizePersistenceDomainName(entry);
      if (!allowedDomains.has(domain)) {
        throw new Error(`${envName} non valido: '${entry}'. Valori ammessi: ${allowedLabel}.`);
      }
      domains.add(domain);
    });

  return domains;
}

function cloneDomainSet(value) {
  const domains = new Set();
  if (!value) return domains;
  for (const entry of value) {
    const domain = normalizePersistenceDomainName(entry);
    if (domain) domains.add(domain);
  }
  return domains;
}

function normalizeFromConfig(config) {
  const enabled = Boolean(config?.enabled);
  const mode = enabled ? String(config?.mode ?? "off") : "off";
  const readPrimaryDomains = cloneDomainSet(config?.readPrimaryDomains ?? config?.primaryDomains);
  const requestedWritePrimaryDomains = cloneDomainSet(config?.requestedWritePrimaryDomains);
  return {
    enabled,
    mode,
    primaryDomains: readPrimaryDomains,
    readPrimaryDomains,
    requestedWritePrimaryDomains,
    writePrimaryDomains: new Set(),
  };
}

export function normalizePersistenceMode(options = {}) {
  if (options.config) {
    return normalizeFromConfig(options.config);
  }

  const env = options.env ?? process.env;
  const enabled = String(env.BACKEND_RELATIONAL_ENABLED ?? "").trim() === "1";
  const modeRaw = String(env.BACKEND_RELATIONAL_MODE ?? "off").trim().toLowerCase() || "off";

  const requestedWritePrimaryDomains = parsePersistenceDomainList(
    env.BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS,
    {
      allowedDomains: RELATIONAL_DOMAINS,
      allowedLabel: RELATIONAL_DOMAIN_LABEL,
      envName: "BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS",
    }
  );

  if (requestedWritePrimaryDomains.size > 0 && options.failOnUnsupportedWritePrimary) {
    throw new Error(
      `BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS non e' ancora supportato. ` +
        `Domini richiesti: ${Array.from(requestedWritePrimaryDomains).join(", ")}.`
    );
  }

  if (!RELATIONAL_MODES.has(modeRaw)) {
    if (!enabled) {
      return {
        enabled: false,
        mode: "off",
        primaryDomains: new Set(),
        readPrimaryDomains: new Set(),
        requestedWritePrimaryDomains,
        writePrimaryDomains: new Set(),
      };
    }
    throw new Error(`BACKEND_RELATIONAL_MODE non valido: '${modeRaw}'. Valori ammessi: off, shadow, primary.`);
  }

  if (!enabled) {
    return {
      enabled: false,
      mode: "off",
      primaryDomains: new Set(),
      readPrimaryDomains: new Set(),
      requestedWritePrimaryDomains,
      writePrimaryDomains: new Set(),
    };
  }

  const readPrimaryDomains =
    modeRaw === "primary"
      ? parsePersistenceDomainList(env.BACKEND_RELATIONAL_PRIMARY_DOMAINS, {
          allowedDomains: RELATIONAL_READ_PRIMARY_DOMAINS,
          allowedLabel: RELATIONAL_READ_PRIMARY_DOMAIN_LABEL,
          envName: "BACKEND_RELATIONAL_PRIMARY_DOMAINS",
        })
      : new Set();

  return {
    enabled,
    mode: modeRaw,
    primaryDomains: readPrimaryDomains,
    readPrimaryDomains,
    requestedWritePrimaryDomains,
    writePrimaryDomains: new Set(),
  };
}

export function getRelationalMode(options = {}) {
  return normalizePersistenceMode(options).mode;
}

export function isRelationalEnabled(options = {}) {
  return normalizePersistenceMode(options).enabled;
}

export function isDomainReadPrimary(domain, options = {}) {
  const config = normalizePersistenceMode(options);
  return (
    config.enabled &&
    config.mode === "primary" &&
    config.readPrimaryDomains.has(normalizePersistenceDomainName(domain))
  );
}

export function isDomainWritePrimary() {
  return false;
}

export function assertPrimaryRelationalAvailable(domain, options = {}) {
  const normalizedDomain = normalizePersistenceDomainName(domain);
  const access = String(options.access ?? options.operation ?? "read").trim().toLowerCase();
  const config = normalizePersistenceMode(options);

  if (access === "write") {
    if (config.requestedWritePrimaryDomains.has(normalizedDomain)) {
      throw new Error(`write-primary relazionale per ${normalizedDomain} non e' ancora supportato.`);
    }
    throw new Error(`write-primary relazionale per ${normalizedDomain} non e' abilitato.`);
  }

  if (!isDomainReadPrimary(normalizedDomain, { config })) {
    throw new Error(`read-primary relazionale per ${normalizedDomain} non e' abilitato.`);
  }

  if ("relationalRuntime" in options || "db" in options || "relationalDb" in options) {
    const db = options.db ?? options.relationalDb ?? options.relationalRuntime?.db ?? null;
    if (!db) {
      throw new Error(`DB relazionale primary non disponibile per ${normalizedDomain}: connessione non inizializzata.`);
    }
  }

  return true;
}
