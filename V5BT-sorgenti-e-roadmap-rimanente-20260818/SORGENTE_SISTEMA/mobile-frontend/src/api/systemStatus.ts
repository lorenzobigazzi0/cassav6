import { apiFetch } from "./baseUrl";

export type BackendHealthResult = {
  ok: boolean;
};

export function parseBackendHealthPayload(payload: unknown): BackendHealthResult {
  if (!payload || typeof payload !== "object") return { ok: false };
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return { ok: false };

  const database = record.database;
  if (!database || typeof database !== "object") return { ok: false };
  const databaseRecord = database as Record<string, unknown>;
  return { ok: databaseRecord.ok === true };
}

export async function fetchBackendHealth(): Promise<BackendHealthResult> {
  try {
    const response = await apiFetch(
      `/api/health?_=${Date.now()}`,
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      },
      {
        retryAttempts: 0,
        timeoutMs: 4_000,
      }
    );
    if (!response.ok) return { ok: false };
    return parseBackendHealthPayload(await response.json().catch(() => null));
  } catch {
    return { ok: false };
  }
}
