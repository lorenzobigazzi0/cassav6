export type RuntimeFeatureFlags = Record<string, boolean>;

export type RuntimeConfig = {
  appName: string;
  apiBaseUrl: string;
  sseBaseUrl: string;
  defaultOrderStation: string;
  features: RuntimeFeatureFlags;
};

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  appName: "mobile",
  apiBaseUrl: "/api",
  sseBaseUrl: "/api",
  defaultOrderStation: "",
  features: {},
};

let runtimeConfig: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const nonEmptyString = (value: unknown, fallback: string) => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

function normalizeFeatures(value: unknown): RuntimeFeatureFlags {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, boolean] => {
      const [key, flag] = entry;
      return Boolean(key.trim()) && typeof flag === "boolean";
    })
  );
}

function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  const source = isRecord(value) ? value : {};
  return {
    appName: nonEmptyString(source.appName, DEFAULT_RUNTIME_CONFIG.appName),
    apiBaseUrl: nonEmptyString(source.apiBaseUrl, DEFAULT_RUNTIME_CONFIG.apiBaseUrl),
    sseBaseUrl: nonEmptyString(source.sseBaseUrl, DEFAULT_RUNTIME_CONFIG.sseBaseUrl),
    defaultOrderStation: nonEmptyString(
      source.defaultOrderStation,
      DEFAULT_RUNTIME_CONFIG.defaultOrderStation
    ),
    features: normalizeFeatures(source.features),
  };
}

function envString(name: string) {
  const value = import.meta.env[name] as string | undefined;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function withEnvOverrides(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    apiBaseUrl: envString("VITE_API_BASE_URL") || config.apiBaseUrl,
    sseBaseUrl: envString("VITE_SSE_BASE_URL") || config.sseBaseUrl,
    defaultOrderStation: envString("VITE_DEFAULT_ORDER_STATION") || config.defaultOrderStation,
  };
}

function configCandidates() {
  const base =
    import.meta.env.BASE_URL && import.meta.env.BASE_URL !== "/" ? import.meta.env.BASE_URL : "/";
  const baseConfig = `${base.replace(/\/$/, "")}/config.json`;
  return Array.from(new Set([baseConfig, "/config.json"]));
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    runtimeConfig = withEnvOverrides(DEFAULT_RUNTIME_CONFIG);
    return runtimeConfig;
  }

  for (const path of configCandidates()) {
    try {
      const response = await window.fetch(path, { cache: "no-store" });
      if (!response.ok) continue;
      runtimeConfig = withEnvOverrides(normalizeRuntimeConfig(await response.json()));
      return runtimeConfig;
    } catch {
      // Try the next public config location before falling back.
    }
  }

  runtimeConfig = withEnvOverrides(DEFAULT_RUNTIME_CONFIG);
  return runtimeConfig;
}

export function getRuntimeConfig() {
  return runtimeConfig;
}

function normalizeFeatureName(name: string) {
  return name.trim().replace(/[-_]+([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function isRuntimeFeatureEnabled(name: string, fallback = false) {
  const rawName = name.trim();
  if (!rawName) return fallback;
  const config = getRuntimeConfig();
  const candidates = [
    rawName,
    normalizeFeatureName(rawName),
    rawName.toUpperCase().replace(/-/g, "_"),
  ];
  for (const candidate of candidates) {
    if (config.features[candidate] === true) return true;
    if (config.features[candidate] === false) return false;
  }
  const viteKey = `VITE_${rawName.toUpperCase().replace(/[-.]/g, "_")}`;
  const envValue = import.meta.env[viteKey] as string | boolean | undefined;
  if (typeof envValue === "boolean") return envValue;
  if (typeof envValue === "string") {
    return ["1", "true", "yes", "on"].includes(envValue.trim().toLowerCase());
  }
  return fallback;
}
