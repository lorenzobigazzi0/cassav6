import { readLocalPreference, writeLocalPreference } from "../shared/storage/preferenceStorage";

const DEVICE_UUID_KEY = "pos_device_uuid";

const makeFallbackId = () => {
  const rnd = Math.random().toString(36).slice(2);
  return `dev_${Date.now()}_${rnd}`;
};

export function getOrCreateDeviceUuid() {
  const existing = readLocalPreference(DEVICE_UUID_KEY);
  if (existing && existing.trim()) return existing;

  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : makeFallbackId();

  writeLocalPreference(DEVICE_UUID_KEY, generated);
  return generated;
}
