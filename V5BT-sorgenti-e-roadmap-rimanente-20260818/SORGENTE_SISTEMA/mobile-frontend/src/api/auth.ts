import type { AuthPermission, LoginRequest, LoginResponse } from "../types/auth";
import { sleep } from "../utils/sleep";
import { clearStoredRoomPreference, rememberRoomPreference } from "../utils/roomPreferences";
import { apiFetch } from "./baseUrl";

const BACKEND_TIMEOUT_MS = 30000;

export function isMockAuthEnabled() {
  const explicit = String(import.meta.env.VITE_ENABLE_MOCK_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "true" || explicit === "1" || explicit === "yes") return true;
  return import.meta.env.DEV === true || import.meta.env.MODE === "test";
}

const normalize = (value: string) => value.trim().toLowerCase();
const toTitle = (value: string) =>
  value
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const resolveFullName = (username: string) => {
  const value = normalize(username);
  if (value === "lorenzo") return "Lorenzo Bigazzi";
  const titled = toTitle(username);
  return titled || "Operatore";
};

const AUTH_PERMISSION_SET: Record<AuthPermission, true> = {
  collect_payments: true,
  approve_room_change: true,
  manage_menu: true,
  view_analytics: true,
  manage_sale_sessions: true,
  automatic_cash_admin: true,
  counter_mode: true,
  fiscal_operations: true,
};

const USER_ROLE_SET = new Set(["operator", "responsabile", "admin"]);

export function resolveMockRole(username: string) {
  const value = normalize(username);
  if (value === "lorenzo") {
    return { role: "responsabile" as const, roleLabel: "Responsabile" };
  }
  if (value.includes("admin")) {
    return { role: "admin" as const, roleLabel: "Amministratore" };
  }
  if (
    value.includes("resp") ||
    value.includes("manager") ||
    value.includes("capo") ||
    value.includes("super")
  ) {
    return { role: "responsabile" as const, roleLabel: "Responsabile" };
  }
  return { role: "operator" as const, roleLabel: "Operatore" };
}

function resolveMockPermissions(role: "operator" | "responsabile" | "admin"): AuthPermission[] {
  if (role === "admin") {
    return [
      "collect_payments",
      "approve_room_change",
      "manage_menu",
      "view_analytics",
      "automatic_cash_admin",
      "counter_mode",
      "fiscal_operations",
    ];
  }
  if (role === "responsabile") {
    return ["collect_payments", "approve_room_change", "view_analytics"];
  }
  return [];
}

const normalizePermissions = (value: unknown): AuthPermission[] => {
  if (!Array.isArray(value)) return [];
  const permissions = value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry): entry is AuthPermission =>
      Boolean(AUTH_PERMISSION_SET[entry as AuthPermission])
    );
  return Array.from(new Set(permissions));
};

const parseLoginSessionStartedAt = (value: unknown) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const parseBackendLoginResponse = (payload: unknown): LoginResponse => {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Risposta backend non valida." };
  }
  const source = payload as Record<string, unknown>;
  if (source.ok !== true) {
    const error =
      typeof source.error === "string" && source.error.trim().length > 0
        ? source.error.trim()
        : "Credenziali non valide.";
    return { ok: false, error };
  }

  const token = String(source.token ?? "").trim();
  const rawUser = source.user;
  if (!token || !rawUser || typeof rawUser !== "object") {
    return { ok: false, error: "Risposta backend non valida." };
  }

  const userSource = rawUser as Record<string, unknown>;
  const id = String(userSource.id ?? "").trim();
  const username = String(userSource.username ?? "").trim();
  const fullName = String(userSource.fullName ?? username).trim();
  const roleRaw = String(userSource.role ?? "").trim();
  const role = USER_ROLE_SET.has(roleRaw)
    ? (roleRaw as "operator" | "responsabile" | "admin")
    : "operator";
  const roleLabel = String(userSource.roleLabel ?? toTitle(role)).trim() || toTitle(role);
  const permissions = normalizePermissions(userSource.permissions);
  const hasServerSessionEpoch = source.sessionStartedAt !== undefined;
  const sessionStartedAt = hasServerSessionEpoch
    ? parseLoginSessionStartedAt(source.sessionStartedAt)
    : Date.now();
  if (!id || !username || !fullName || sessionStartedAt === null) {
    return { ok: false, error: "Risposta backend non valida." };
  }

  return {
    ok: true,
    token,
    sessionStartedAt,
    user: {
      id,
      username,
      fullName,
      role,
      roleLabel,
      permissions,
    },
  };
};

const applyLoginRoomPreference = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const source = payload as Record<string, unknown>;
  if (source.ok !== true || !source.user || typeof source.user !== "object") return;
  const userId = String((source.user as Record<string, unknown>).id ?? "").trim();
  const initialRoom =
    source.initialRoom && typeof source.initialRoom === "object"
      ? (source.initialRoom as Record<string, unknown>)
      : null;
  const directInitialRoom =
    initialRoom && initialRoom.authorized === true && initialRoom.requiresAdminAuth !== true
      ? initialRoom
      : null;
  if (directInitialRoom) {
    rememberRoomPreference(userId, directInitialRoom);
  } else {
    clearStoredRoomPreference();
  }
};

const loginViaBackend = async (req: LoginRequest): Promise<LoginResponse | null> => {
  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ...req,
        clientApp: "mobile-frontend",
      }),
      signal: ctrl.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const parsed = parseBackendLoginResponse(payload);
      if (!parsed.ok) return parsed;
      return { ok: false, error: `Errore login backend (${response.status}).` };
    }
    applyLoginRoomPreference(payload);
    return parseBackendLoginResponse(payload);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

type SessionStatusRequest = {
  token: string;
  userId: string;
  deviceUuid: string;
  clientApp?: string;
};

export type LogoutSessionRequest = {
  token: string | null;
  userId: string | null;
  deviceUuid: string | null;
  roomId: string | null;
  clientApp?: string;
};

type SessionStatusResult = "valid" | "invalid" | "unknown";

type ChangePinRequest = {
  token: string;
  userId: string;
  deviceUuid: string;
  currentPin: string;
  newPin: string;
  confirmPin: string;
};

type ChangePinResponse = {
  ok: boolean;
  error?: string;
};

export async function checkSessionStatus(req: SessionStatusRequest): Promise<SessionStatusResult> {
  const token = String(req.token ?? "").trim();
  const userId = String(req.userId ?? "").trim();
  const deviceUuid = String(req.deviceUuid ?? "").trim();
  if (!token || !userId || !deviceUuid) {
    return "invalid";
  }

  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const response = await apiFetch("/api/auth/session/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        token,
        userId,
        deviceUuid,
        clientApp: req.clientApp || "mobile-frontend",
      }),
      signal: ctrl.signal,
    });

    if (response.status === 401 || response.status === 400) {
      return "invalid";
    }
    if (!response.ok) {
      return "unknown";
    }

    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      valid?: unknown;
    } | null;
    if (!payload || payload.ok !== true || payload.valid !== true) {
      return "unknown";
    }

    return "valid";
  } catch {
    return "unknown";
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function logoutSession(req: LogoutSessionRequest): Promise<void> {
  const token = String(req.token ?? "").trim();
  const userId = String(req.userId ?? "").trim();
  const deviceUuid = String(req.deviceUuid ?? "").trim();
  if (!token || !deviceUuid) return;

  await apiFetch("/api/auth/logout", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-User-Id": userId,
      "X-Device-Uuid": deviceUuid,
    },
    body: JSON.stringify({
      token,
      userId,
      deviceUuid,
      roomId: String(req.roomId ?? "").trim(),
      clientApp: req.clientApp || "mobile-frontend",
    }),
    keepalive: true,
  }).then(() => undefined);
}

export async function changePin(req: ChangePinRequest): Promise<ChangePinResponse> {
  const token = String(req.token ?? "").trim();
  const userId = String(req.userId ?? "").trim();
  const deviceUuid = String(req.deviceUuid ?? "").trim();
  const currentPin = String(req.currentPin ?? "").trim();
  const newPin = String(req.newPin ?? "").trim();
  const confirmPin = String(req.confirmPin ?? "").trim();

  if (!token || !userId || !deviceUuid) {
    return { ok: false, error: "Sessione login non valida." };
  }
  if (!/^\d{4}$/.test(currentPin)) {
    return { ok: false, error: "PIN attuale non valido." };
  }
  if (!/^\d{4}$/.test(newPin)) {
    return { ok: false, error: "Il nuovo PIN deve essere di 4 cifre." };
  }
  if (newPin !== confirmPin) {
    return { ok: false, error: "Il nuovo PIN e la conferma non coincidono." };
  }

  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const response = await apiFetch("/api/auth/change-pin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        token,
        userId,
        deviceUuid,
        currentPin,
        newPin,
        confirmPin,
        clientApp: "mobile-frontend",
      }),
      signal: ctrl.signal,
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok || payload?.ok !== true) {
      return {
        ok: false,
        error:
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "Cambio PIN non riuscito.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Backend non raggiungibile." };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  if (!req.username.trim()) return { ok: false, error: "Inserisci il nome utente." };
  if (req.pin.length < 4) return { ok: false, error: "PIN troppo corto." };
  if (!req.deviceUuid.trim()) return { ok: false, error: "Dispositivo non riconosciuto." };

  const backendResponse = await loginViaBackend(req);
  if (backendResponse) {
    return backendResponse;
  }

  await sleep(320);

  // Fallback locale di sviluppo: mai attivo in produzione senza flag esplicito.
  if (!isMockAuthEnabled()) {
    return { ok: false, error: "Backend login non raggiungibile." };
  }

  if (normalize(req.username) === "lorenzo" && req.pin !== "1234") {
    return { ok: false, error: "Credenziali non valide." };
  }

  const username = req.username.trim();
  const fullName = resolveFullName(username);
  const { role, roleLabel } = resolveMockRole(username);
  const permissions = resolveMockPermissions(role);
  const safeId = normalize(username).replace(/[^a-z0-9]+/g, "_") || "u_1";

  return {
    ok: true,
    token: "fake_jwt_token_" + Math.random().toString(36).slice(2),
    sessionStartedAt: Date.now(),
    user: { id: `u_${safeId}`, username, fullName, role, roleLabel, permissions },
  };
}
