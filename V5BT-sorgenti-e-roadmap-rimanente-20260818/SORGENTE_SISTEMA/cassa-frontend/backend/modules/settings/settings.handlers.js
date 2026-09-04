import { buildConfigurationSnapshot } from "../configuration/index.js";

function normalizeRoomId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeIp(value) {
  const firstValue =
    String(value ?? "")
      .split(",")[0]
      ?.trim() ?? "";
  return firstValue
    .replace(/^::ffff:/i, "")
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
}

export function looksLikeIpAddress(value) {
  const normalized = normalizeIp(value);
  return (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || normalized.includes(":")
  );
}

function normalizeCounterCashDefaultSource(value) {
  return String(value ?? "").trim() === "automatic" ? "automatic" : "wallet";
}

export function readUserPaymentPreferences(user) {
  const source =
    user?.preferences && typeof user.preferences === "object"
      ? user.preferences
      : {};
  const payments =
    source.payments && typeof source.payments === "object"
      ? source.payments
      : {};
  return {
    counterCashDefaultSource: normalizeCounterCashDefaultSource(
      payments.counterCashDefaultSource ?? source.counterCashDefaultSource,
    ),
  };
}

export function writeUserPaymentPreferences(user, patch, updatedAt) {
  const currentPreferences =
    user.preferences && typeof user.preferences === "object"
      ? user.preferences
      : {};
  const currentPayments =
    currentPreferences.payments &&
    typeof currentPreferences.payments === "object"
      ? currentPreferences.payments
      : {};
  user.preferences = {
    ...currentPreferences,
    payments: {
      ...currentPayments,
      counterCashDefaultSource: normalizeCounterCashDefaultSource(
        patch?.counterCashDefaultSource,
      ),
    },
  };
  user.updatedAt = updatedAt;
  return readUserPaymentPreferences(user);
}

function buildConfiguredRoomLookup(...settingsList) {
  const lookup = new Map();
  for (const settings of settingsList) {
    for (const area of Array.isArray(settings?.areas) ? settings.areas : []) {
      const roomId = normalizeRoomId(area?.id ?? area?.roomId ?? "");
      if (!roomId) continue;
      lookup.set(roomId, roomId);
      for (const value of [area?.name, area?.label, area?.roomName]) {
        const key = normalizeRoomId(value);
        if (key && !lookup.has(key)) {
          lookup.set(key, roomId);
        }
      }
    }
  }
  return lookup;
}

function deriveRoomIdFromTable(table, configuredRoomLookup) {
  const explicitRoomId = normalizeRoomId(table?.roomId ?? table?.areaId ?? "");
  if (explicitRoomId) return explicitRoomId;
  const typeKey = normalizeRoomId(table?.type ?? "");
  if (!typeKey) return "";
  return configuredRoomLookup?.get(typeKey) ?? "";
}

function resolveMinimumTables(area) {
  const parsed = Number(
    area?.minimumTables ??
      area?.tableCount ??
      area?.tablesCount ??
      area?.defaultTableCount ??
      area?.defaultTables ??
      0,
  );
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(Math.min(Math.trunc(parsed), 500), 0);
}

function tableBelongsToRoom(table, roomId, configuredRoomLookup) {
  return deriveRoomIdFromTable(table, configuredRoomLookup) === roomId;
}

function isOccupiedTable(table) {
  const status = String(table?.status ?? "free")
    .trim()
    .toLowerCase();
  if (status && !["free", "available"].includes(status)) return true;
  if (Number(table?.totalDue ?? table?.amountDue ?? 0) > 0) return true;
  if (Number(table?.covers ?? 0) > 0) return true;
  if (String(table?.seatedAt ?? "").trim()) return true;
  if (table?.workLock && typeof table.workLock === "object") return true;
  if (Array.isArray(table?.pendingBills) && table.pendingBills.length > 0)
    return true;
  if (Array.isArray(table?.ordersTaken) && table.ordersTaken.length > 0)
    return true;
  if (
    Array.isArray(table?.ordersInProgress) &&
    table.ordersInProgress.length > 0
  )
    return true;
  return false;
}

function collectRoomTables(settings, roomId, configuredRoomLookup) {
  return (Array.isArray(settings?.tables) ? settings.tables : []).filter(
    (table) => tableBelongsToRoom(table, roomId, configuredRoomLookup),
  );
}

function collectActiveRoomUsers(db, roomId, collectActiveWaitersInRoom) {
  if (typeof collectActiveWaitersInRoom !== "function") return [];
  const users = collectActiveWaitersInRoom(db, roomId);
  return Array.isArray(users) ? users : [];
}

export function findRoomTableExpansionViolations({
  currentSettings,
  nextSettings,
  db,
  collectActiveWaitersInRoom,
}) {
  const violations = [];
  const configuredRoomLookup = buildConfiguredRoomLookup(
    currentSettings,
    nextSettings,
  );
  for (const area of Array.isArray(nextSettings?.areas)
    ? nextSettings.areas
    : []) {
    const roomId = normalizeRoomId(area?.id ?? area?.roomId ?? "");
    if (!roomId) continue;
    const requestedMinimum = resolveMinimumTables(area);
    if (requestedMinimum <= 0) continue;

    const currentTables = collectRoomTables(
      currentSettings,
      roomId,
      configuredRoomLookup,
    );
    if (requestedMinimum <= currentTables.length) continue;

    const occupiedTables = currentTables.filter(isOccupiedTable);
    const activeUsers = collectActiveRoomUsers(
      db,
      roomId,
      collectActiveWaitersInRoom,
    );
    if (occupiedTables.length === 0 && activeUsers.length === 0) continue;

    violations.push({
      roomId,
      requestedMinimum,
      currentTableCount: currentTables.length,
      occupiedTableIds: occupiedTables
        .map((table) => String(table?.id ?? "").trim())
        .filter(Boolean),
      activeUserIds: activeUsers
        .map((user) => String(user?.userId ?? user?.id ?? "").trim())
        .filter(Boolean),
      activeUsernames: activeUsers
        .map((user) => String(user?.username ?? "").trim())
        .filter(Boolean),
    });
  }
  return violations;
}

export function createSettingsHandlers({
  ringMobileDevice,
  saveGeneralSettings,
  saveMobileDevices,
  savePaymentMethods,
  savePrintPreferences,
  saveUserPaymentPreferences,
  saveposAreas,
  readConfigurationSnapshotView,
  readPosAreasView,
  readPosSettingsView,
  readUserPaymentPreferencesView,
  HttpError,
  buildPosAreasPayload,
  buildPosSettingsPayload,
  collectActiveWaitersInRoom,
  hasPermission,
  isPosPrivilegedRole,
  nowIso,
  publishIntegrationNotificationStreamRefresh,
  queueIntegrationNotification,
  readDb,
  readJsonBody,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  sendJson,
  touchSettingsMetadata,
  validateSessionContext,
  writeDb,
}) {
  function publishSettingsUpdated(db, source) {
    if (typeof publishIntegrationNotificationStreamRefresh !== "function")
      return;
    const lastWriteAt = resolveSettingsLastWriteAt(db?.meta);
    const version = resolveSettingsVersion(db?.meta);
    publishIntegrationNotificationStreamRefresh("settings_updated", {
      source: String(source || "settings").trim() || "settings",
      lastWriteAt,
      version,
      settingsVersion: version,
    });
  }

  async function handlePosSettings(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readPosSettingsView(payload));
  }

  async function handleConfigurationSnapshot(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readConfigurationSnapshotView(payload));
  }

  async function handlePosAreas(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readPosAreasView(payload));
  }

  async function handleSavePosAreas(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveposAreas(payload));
  }

  async function handleSavePosPrintPreferences(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await savePrintPreferences(payload));
  }

  async function handleSavePosGeneralSettings(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveGeneralSettings(payload));
  }

  async function handleSavePaymentMethods(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await savePaymentMethods(payload));
  }

  async function handleUserPaymentPreferences(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readUserPaymentPreferencesView(payload));
  }

  async function handleSaveUserPaymentPreferences(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveUserPaymentPreferences(payload));
  }

  async function handleSaveMobileDevices(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveMobileDevices(payload));
  }

  async function handleRingMobileDevice(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await ringMobileDevice(payload));
  }

  return {
    "settings.configurationSnapshot": handleConfigurationSnapshot,
    "settings.pos": handlePosSettings,
    "settings.posAreas": handlePosAreas,
    "settings.savePosAreas": handleSavePosAreas,
    "settings.savePrintPreferences": handleSavePosPrintPreferences,
    "settings.saveGeneral": handleSavePosGeneralSettings,
    "settings.savePaymentMethods": handleSavePaymentMethods,
    "settings.userPaymentPreferences": handleUserPaymentPreferences,
    "settings.saveUserPaymentPreferences": handleSaveUserPaymentPreferences,
    "settings.saveMobileDevices": handleSaveMobileDevices,
    "settings.ringMobileDevice": handleRingMobileDevice,
  };
}
