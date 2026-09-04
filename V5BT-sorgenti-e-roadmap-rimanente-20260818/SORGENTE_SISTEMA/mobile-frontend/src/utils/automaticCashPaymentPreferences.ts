import { readLocalPreference, writeLocalPreference } from "../shared/storage/preferenceStorage";

export type CounterCashDefaultSource = "wallet" | "automatic";

const COUNTER_CASH_DEFAULT_SOURCE_KEY = "mobile_counter_cash_default_source";
const CHANGE_EVENT = "mobile:counter-cash-default-source";

const normalizeCounterCashDefaultSource = (value: unknown): CounterCashDefaultSource =>
  String(value ?? "").trim() === "automatic" ? "automatic" : "wallet";

type CounterCashPreferenceSession = {
  token?: string | null;
  userId?: string | null;
  deviceUuid?: string | null;
};

type CounterCashPreferenceResponse = {
  ok?: boolean;
  preferences?: {
    counterCashDefaultSource?: unknown;
  };
};

const normalizePreferenceUserId = (value?: string | null) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const getCounterCashDefaultSourceKey = (userId?: string | null) => {
  const normalizedUserId = normalizePreferenceUserId(userId);
  return normalizedUserId
    ? `${COUNTER_CASH_DEFAULT_SOURCE_KEY}:${normalizedUserId}`
    : COUNTER_CASH_DEFAULT_SOURCE_KEY;
};

const buildPreferencePayload = (session: CounterCashPreferenceSession) => ({
  token: String(session.token ?? "").trim(),
  userId: String(session.userId ?? "").trim(),
  deviceUuid: String(session.deviceUuid ?? "").trim(),
});

export function getCounterCashDefaultSource(userId?: string | null): CounterCashDefaultSource {
  const scopedValue = readLocalPreference(getCounterCashDefaultSourceKey(userId));
  if (scopedValue !== null) return normalizeCounterCashDefaultSource(scopedValue);
  return normalizeCounterCashDefaultSource(readLocalPreference(COUNTER_CASH_DEFAULT_SOURCE_KEY));
}

export function setCounterCashDefaultSource(
  value: CounterCashDefaultSource,
  userId?: string | null
) {
  const normalized = normalizeCounterCashDefaultSource(value);
  writeLocalPreference(getCounterCashDefaultSourceKey(userId), normalized);
  window.dispatchEvent(
    new CustomEvent(CHANGE_EVENT, {
      detail: { value: normalized, userId: String(userId ?? "").trim() },
    })
  );
}

export function subscribeCounterCashDefaultSource(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export async function fetchCounterCashDefaultSourcePreference(
  session: CounterCashPreferenceSession
): Promise<CounterCashDefaultSource> {
  const { apiJson } = await import("../api/baseUrl");
  const payload = await apiJson<CounterCashPreferenceResponse>(
    "/api/settings/user/payment-preferences",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPreferencePayload(session)),
    }
  );
  return normalizeCounterCashDefaultSource(payload.preferences?.counterCashDefaultSource);
}

export async function syncCounterCashDefaultSourceFromDb(
  session: CounterCashPreferenceSession
): Promise<CounterCashDefaultSource> {
  const value = await fetchCounterCashDefaultSourcePreference(session);
  setCounterCashDefaultSource(value, session.userId);
  return value;
}

export async function saveCounterCashDefaultSourcePreference(
  value: CounterCashDefaultSource,
  session: CounterCashPreferenceSession
): Promise<CounterCashDefaultSource> {
  const normalized = normalizeCounterCashDefaultSource(value);
  setCounterCashDefaultSource(normalized, session.userId);
  const { apiJson } = await import("../api/baseUrl");
  const payload = await apiJson<CounterCashPreferenceResponse>(
    "/api/settings/user/payment-preferences/save",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...buildPreferencePayload(session),
        preferences: {
          counterCashDefaultSource: normalized,
        },
      }),
    }
  );
  const saved = normalizeCounterCashDefaultSource(payload.preferences?.counterCashDefaultSource);
  setCounterCashDefaultSource(saved, session.userId);
  return saved;
}
