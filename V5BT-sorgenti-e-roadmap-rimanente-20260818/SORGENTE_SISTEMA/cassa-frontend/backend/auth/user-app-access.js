import { HttpError } from "../core/http.js";

export const USER_APP_IDS = Object.freeze(["cassa", "postazione", "palmare"]);

const USER_APP_ALIASES = new Map([
  ["cassa", "cassa"],
  ["cassa-frontend", "cassa"],
  ["cassa_frontend", "cassa"],
  ["cash-frontend", "cassa"],
  ["postazione", "postazione"],
  ["postazione-advanced", "postazione"],
  ["palmare", "palmare"],
  ["palmare-advanced", "palmare"],
  ["mobile-frontend", "palmare"],
  ["mobile_frontend", "palmare"],
  ["pos-frontend", "palmare"],
  ["pos_frontend", "palmare"],
]);

const UNSCOPED_CLIENT_APPS = new Map([
  ["settings-frontend", "settings-frontend"],
  ["settings_frontend", "settings-frontend"],
  ["monitor-frontend", "monitor-frontend"],
  ["monitor_frontend", "monitor-frontend"],
]);

const ANDROID_RADIO_COMPANION = "android-background-radio";

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeUserAppId(value) {
  const normalized = normalizeKey(value);
  const exact = USER_APP_ALIASES.get(normalized);
  if (exact) return exact;
  if (/^(mobile|pos|palmare)-/.test(normalized)) return "palmare";
  if (/^postazione-/.test(normalized)) return "postazione";
  if (/^(cassa|cash)-/.test(normalized)) return "cassa";
  return "";
}

export function sanitizeUserEnabledAppIds(value) {
  if (!Array.isArray(value)) return [...USER_APP_IDS];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const appId = normalizeUserAppId(entry);
    if (!appId || seen.has(appId)) continue;
    seen.add(appId);
    result.push(appId);
  }
  return USER_APP_IDS.filter((appId) => result.includes(appId));
}

export function resolveUserAppIdFromClientApp(clientApp) {
  const normalized = normalizeKey(clientApp);
  if (!normalized) return "cassa";
  return normalizeUserAppId(normalized);
}

export function isUserAppEnabled(user, clientApp) {
  const normalizedClientApp = normalizeKey(clientApp);
  if (UNSCOPED_CLIENT_APPS.has(normalizedClientApp)) return true;
  const appId = resolveUserAppIdFromClientApp(clientApp);
  if (!appId) return false;
  return sanitizeUserEnabledAppIds(user?.enabledAppIds).includes(appId);
}

function userAppBoundary(clientApp) {
  const normalized = normalizeKey(clientApp);
  if (!normalized) return "cassa";
  const appId = resolveUserAppIdFromClientApp(normalized);
  if (appId) return appId;
  return UNSCOPED_CLIENT_APPS.get(normalized) ?? "";
}

export function assertUserClientAppAllowed(user, clientApp, options = {}) {
  if (isUserAppEnabled(user, clientApp)) return;
  const rawClientApp = String(clientApp ?? "").trim();
  const appId =
    resolveUserAppIdFromClientApp(clientApp) ||
    (rawClientApp ? "unknown" : "cassa");
  const sessionValidation = options.sessionValidation === true;
  throw new HttpError(
    sessionValidation ? 401 : 403,
    sessionValidation
      ? "Sessione login non valida o scaduta."
      : "Utente non abilitato per questa applicazione.",
    {
      code: "USER_APP_NOT_ALLOWED",
      details: { appId },
    },
  );
}

export function assertUserSessionAppAllowed(
  user,
  sessionClientApp,
  requestedClientApp,
) {
  assertUserClientAppAllowed(user, sessionClientApp, {
    sessionValidation: true,
  });
  const requested = normalizeKey(requestedClientApp);
  if (!requested) return;
  const sessionBoundary = userAppBoundary(sessionClientApp);
  if (requested === ANDROID_RADIO_COMPANION) {
    if (sessionBoundary === "palmare" || sessionBoundary === "postazione") return;
    throw new HttpError(401, "Sessione login non valida o scaduta.", {
      code: "SESSION_CLIENT_APP_MISMATCH",
    });
  }
  assertUserClientAppAllowed(user, requested, { sessionValidation: true });
  const requestedBoundary = userAppBoundary(requested);
  if (sessionBoundary !== requestedBoundary) {
    throw new HttpError(401, "Sessione login non valida o scaduta.", {
      code: "SESSION_CLIENT_APP_MISMATCH",
    });
  }
}
