export function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parseBooleanEnv(rawValue, fallback = false) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export const HOST = process.env.BACKEND_HOST ?? "0.0.0.0";
export const PORT = parsePositiveInt(process.env.PORT ?? process.env.BACKEND_PORT, 5281);
export const MAX_BODY_SIZE = 1_000_000;
export const APP_ENV = String(process.env.NODE_ENV ?? process.env.APP_ENV ?? "development").trim().toLowerCase();
export const IS_PRODUCTION = APP_ENV === "production" || APP_ENV === "prod";
export const IS_TEST = APP_ENV === "test";
export const ENABLE_DEBUG_ENDPOINTS = process.env.ENABLE_DEBUG_ENDPOINTS === "1";
export const ENABLE_MAINTENANCE_ENDPOINTS = process.env.ENABLE_MAINTENANCE_ENDPOINTS === "1";
export const ENABLE_MOCK_MENU = process.env.ENABLE_MOCK_MENU === "1";
export const ENABLE_DEMO_PRODUCTS = process.env.ENABLE_DEMO_PRODUCTS === "1";
export const EXTERNAL_FETCH_TIMEOUT_MS = parsePositiveInt(process.env.EXTERNAL_FETCH_TIMEOUT_MS, 5_000);
export const SESSION_TTL_MS = parsePositiveInt(process.env.SESSION_TTL_MS, 12 * 60 * 60 * 1000);
// Ogni quante scritture eseguire l'audit completo dei domini sporchi: serializza tutto lo
// stato e in modalita diversa da "enforce" e sola telemetria. Su un banco isolato con 600
// comande il campionamento a 20 porta la scrittura da 24 ms a 1,6 ms, ma sul percorso reale
// dei pagamenti (che non usa il fast path esternalizzato) non ha mostrato effetti: il
// default resta quindi 1, cioe il comportamento storico, e il campionamento e opt-in.
export const APP_STATE_DIRTY_TRACKING_AUDIT_SAMPLE = Math.max(1, parsePositiveInt(process.env.APP_STATE_DIRTY_TRACKING_AUDIT_SAMPLE, 1));
export const SESSION_IDLE_TIMEOUT_MS = parsePositiveInt(process.env.SESSION_IDLE_TIMEOUT_MS, 2 * 60 * 60 * 1000);
export const PRINTING_ENABLED = process.env.PRINTING_ENABLED === "1";
export const CARD_PAYMENT_PROVIDER = ["mock", "disabled"].includes(
  String(process.env.CARD_PAYMENT_PROVIDER ?? "disabled").trim().toLowerCase()
)
  ? String(process.env.CARD_PAYMENT_PROVIDER ?? "disabled").trim().toLowerCase()
  : "disabled";
export const CARD_PAYMENT_MOCK_ENABLED = parseBooleanEnv(process.env.CARD_PAYMENT_MOCK_ENABLED, false);

export const DEV_CORS_ALLOWED_ORIGINS = [
  "http://localhost:5280",
  "http://127.0.0.1:5280",
  "http://192.168.1.166:5280",
  "http://localhost:5182",
  "http://127.0.0.1:5182",
];

export function parseCsvEnv(rawValue) {
  return String(rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const CORS_ALLOWED_ORIGINS = parseCsvEnv(process.env.CORS_ALLOWED_ORIGINS);

// Compatibilita legacy: token in query solo fuori produzione o se esplicitamente riabilitati.
// In produzione i token devono viaggiare in Authorization/header o body JSON per ridurre leakage in log/cache/referrer.
export const ALLOW_AUTH_QUERY_TOKEN = parseBooleanEnv(process.env.ALLOW_AUTH_QUERY_TOKEN, !IS_PRODUCTION);
export const ALLOW_SERVICE_TOKEN_QUERY_PARAM = parseBooleanEnv(process.env.ALLOW_SERVICE_TOKEN_QUERY_PARAM, !IS_PRODUCTION);

export function getAllowedCorsOrigins() {
  if (CORS_ALLOWED_ORIGINS.length > 0) return CORS_ALLOWED_ORIGINS;
  if (IS_PRODUCTION) return [];
  return DEV_CORS_ALLOWED_ORIGINS;
}

export function validateRuntimeConfig(options = {}) {
  const env = String(options.env ?? APP_ENV).trim().toLowerCase();
  const production = env === "production" || env === "prod";
  const tokenSecret = String(options.backendTokenSecret ?? process.env.BACKEND_TOKEN_SECRET ?? "").trim();
  const smartReaderMode = String(options.smartCardReaderMode ?? process.env.SMART_CARD_READER_MODE ?? "hybrid")
    .trim()
    .toLowerCase();
  const smartPushToken = String(options.smartCardPushToken ?? process.env.SMART_CARD_PUSH_TOKEN ?? "").trim();
  const fiscalProvider = String(options.fiscalProvider ?? process.env.FISCAL_PROVIDER ?? "").trim().toLowerCase();

  if (production) {
    if (!tokenSecret || tokenSecret.length < 32 || tokenSecret === "dev-only-change-me") {
      throw new Error("BACKEND_TOKEN_SECRET must be set to a non-default value of at least 32 characters in production.");
    }
    if ((smartReaderMode === "push" || smartReaderMode === "hybrid") && !smartPushToken) {
      throw new Error("SMART_CARD_PUSH_TOKEN is required in production when smart-card push mode is enabled.");
    }
    if (!fiscalProvider || fiscalProvider === "mock") {
      throw new Error("FISCAL_PROVIDER must be explicitly configured to a real provider in production.");
    }
  }

  return {
    env,
    production,
    tokenSecret,
    fiscalProvider,
  };
}
