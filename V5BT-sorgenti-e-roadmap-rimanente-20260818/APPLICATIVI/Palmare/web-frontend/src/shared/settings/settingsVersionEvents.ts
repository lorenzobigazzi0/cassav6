export const SETTINGS_VERSION_EVENT = "pos:settings-version";

export type SettingsVersionEventDetail = {
  version: number;
  source?: string;
};

export function resolveSettingsVersion(payload: unknown) {
  if (!payload || typeof payload !== "object") return 0;
  const source = payload as Record<string, unknown>;
  const raw =
    source.settingsVersion != null ? Number(source.settingsVersion) : Number(source.version);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function publishSettingsVersion(payload: unknown, source: string) {
  if (typeof window === "undefined") return;
  const version = resolveSettingsVersion(payload);
  if (version <= 0) return;
  window.dispatchEvent(
    new CustomEvent<SettingsVersionEventDetail>(SETTINGS_VERSION_EVENT, {
      detail: { version, source },
    })
  );
}
