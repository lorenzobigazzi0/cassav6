export function createMobileDeviceConfigHelpers(options = {}) {
  const {
    normalizeConfigId = (value, fallback = "config") => String(value ?? "").trim() || fallback,
  } = options;

  function sanitizeMobileDeviceSetting(entry, fallbackId = "mobile_device") {
    if (!entry || typeof entry !== "object") return null;
    const deviceId = String(
      entry.deviceId ??
        entry.deviceUuid ??
        entry.id ??
        entry.uuid ??
        entry.clientIp ??
        entry.ip ??
        ""
    ).trim().slice(0, 120);
    if (!deviceId) return null;
    const deviceName = String(
      entry.deviceName ??
        entry.name ??
        entry.label ??
        entry.device ??
        deviceId
    ).trim().slice(0, 120) || deviceId;
    const fiscalEnabled = entry.fiscalEnabled !== false;
    return {
      id: normalizeConfigId(entry.id ?? deviceId, fallbackId),
      deviceId,
      deviceName,
      deviceUuid: String(entry.deviceUuid ?? entry.uuid ?? "").trim().slice(0, 120),
      clientIp: String(entry.clientIp ?? entry.ip ?? "").trim().slice(0, 80),
      fiscalEnabled,
      electronicPaymentEnabled: fiscalEnabled && entry.electronicPaymentEnabled !== false && entry.posPaymentEnabled !== false,
      cashPaymentEnabled: fiscalEnabled && entry.cashPaymentEnabled === true,
      updatedAt: String(entry.updatedAt ?? "").trim(),
      updatedBy: String(entry.updatedBy ?? "").trim().slice(0, 80),
    };
  }

  function sanitizeMobileDeviceSettings(value) {
    const byDeviceId = new Map();
    (Array.isArray(value) ? value : [])
      .map((entry, index) => sanitizeMobileDeviceSetting(entry, `mobile_device_${index + 1}`))
      .filter((entry) => entry !== null)
      .forEach((entry) => {
        byDeviceId.set(entry.deviceId, entry);
      });
    return [...byDeviceId.values()].sort((left, right) =>
      left.deviceName.localeCompare(right.deviceName, "it-IT", { sensitivity: "base" })
    );
  }

  return {
    sanitizeMobileDeviceSetting,
    sanitizeMobileDeviceSettings,
  };
}
