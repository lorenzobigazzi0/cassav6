const STORAGE_KEYS = Object.freeze({
  token: ["pos_token", "auth_token", "token"],
  userId: ["pos_user_id", "user_id"],
  username: ["pos_user", "username"],
  deviceUuid: ["pos_device_uuid", "device_uuid"],
  clientApp: ["pos_client_app"],
});

function readFirst(keys) {
  for (const key of keys) {
    const value = globalThis.localStorage?.getItem(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function readSession() {
  return {
    token: readFirst(STORAGE_KEYS.token),
    userId: readFirst(STORAGE_KEYS.userId),
    username: readFirst(STORAGE_KEYS.username),
    deviceUuid: readFirst(STORAGE_KEYS.deviceUuid),
    clientApp: readFirst(STORAGE_KEYS.clientApp) || "settings-frontend",
  };
}

export function writeSession(input = {}) {
  const values = {
    pos_token: String(input.token ?? "").trim(),
    pos_user_id: String(input.userId ?? input.user?.id ?? "").trim(),
    pos_user: String(input.username ?? input.user?.username ?? "").trim(),
    pos_full_name: String(input.fullName ?? input.user?.fullName ?? "").trim(),
    pos_role: String(input.role ?? input.user?.role ?? "").trim(),
    pos_permissions: JSON.stringify(input.permissions ?? input.user?.permissions ?? []),
    pos_device_uuid: String(input.deviceUuid ?? input.session?.deviceUuid ?? "").trim(),
    pos_client_app: "settings-frontend",
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) globalThis.localStorage?.setItem(key, value);
  }
}

export function clearSession() {
  for (const keys of Object.values(STORAGE_KEYS)) {
    for (const key of keys) globalThis.localStorage?.removeItem(key);
  }
  ["pos_full_name", "pos_role", "pos_permissions"].forEach((key) => globalThis.localStorage?.removeItem(key));
}

function requestId(prefix = "settings") {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

export class ApiError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = body?.code ?? body?.details?.code ?? "API_ERROR";
  }
}

export async function postJson(path, body = {}, options = {}) {
  const session = readSession();
  const payload = {
    ...body,
    token: body.token ?? session.token,
    userId: body.userId ?? session.userId,
    deviceUuid: body.deviceUuid ?? session.deviceUuid,
    clientApp: body.clientApp ?? session.clientApp,
    requestId: body.requestId ?? requestId(),
  };
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(session.userId ? { "X-User-Id": session.userId } : {}),
      ...(session.deviceUuid ? { "X-Device-Uuid": session.deviceUuid } : {}),
      "X-Client-App": "settings-frontend",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  let result = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    const message = result?.error ?? result?.message ?? `Errore HTTP ${response.status}`;
    throw new ApiError(message, response.status, result);
  }
  return result;
}

export const commercialApi = Object.freeze({
  login: (input) => postJson("/api/auth/login", { ...input, clientApp: "settings-frontend" }),
  logout: () => postJson("/api/auth/logout", {}),
  workspace: () => postJson("/api/settings/commercial/snapshot", {}),
  createDraft: (input = {}) => postJson("/api/settings/commercial/draft/create", input),
  saveDraft: (input) => postJson("/api/settings/commercial/draft/save", input),
  validateDraft: (input) => postJson("/api/settings/commercial/draft/validate", input),
  publishDraft: (input) => postJson("/api/settings/commercial/draft/publish", input),
  versions: (input = {}) => postJson("/api/settings/commercial/versions/list", input),
  diff: (input) => postJson("/api/settings/commercial/versions/diff", input),
  rollback: (input) => postJson("/api/settings/commercial/versions/rollback", input),
  simulate: (input) => postJson("/api/settings/commercial/simulate", input),
  exportVersion: (input = {}) => postJson("/api/settings/commercial/export", input),
  importSnapshot: (input) => postJson("/api/settings/commercial/import", input),
  bootstrapLegacy: (input = {}) => postJson("/api/settings/commercial/bootstrap/legacy", input),
});

export { requestId as createRequestId };
