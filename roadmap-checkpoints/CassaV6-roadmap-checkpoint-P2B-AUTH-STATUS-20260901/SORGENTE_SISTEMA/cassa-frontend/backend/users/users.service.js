export function createUsersService({
  POS_PERMISSION_DEFINITIONS,
  normalizeUserRole,
  normalizeUsername,
  roleLabelFromRole,
  sanitizePermissionList,
  sanitizeAuthorizedRoomIds,
  sanitizeEnabledRoomIds,
  sanitizeUserGroupIds,
  sanitizeUserWorkstationIds,
  sanitizeUserEnabledAppIds,
  sanitizeUser,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  toTitle,
}) {
  function buildPosSettingsUsersPayload(db) {
    const users = Array.isArray(db.users) ? db.users.map((item) => sanitizeUser(item, db.posSettings)) : [];
    const groups = (Array.isArray(db.userGroups) ? db.userGroups : []).map((group, index) =>
      normalizeSettingsUserGroupDraft(group, index, db.posSettings)
    ).filter(Boolean);
    users.sort((a, b) => {
      const byName = String(a.fullName ?? "").localeCompare(String(b.fullName ?? ""), "it-IT");
      if (byName !== 0) return byName;
      return String(a.username ?? "").localeCompare(String(b.username ?? ""), "it-IT");
    });
    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    return {
      ok: true,
      users,
      groups,
      permissions: POS_PERMISSION_DEFINITIONS.map((definition) => ({ ...definition })),
      lastWriteAt,
      version: resolveSettingsVersion(db.meta),
    };
  }

  function normalizeRoomIdDraftList(value) {
    const seen = new Set();
    const result = [];
    if (!Array.isArray(value)) return result;
    value.forEach((entry) => {
      const roomId = String(entry ?? "").trim();
      if (!roomId || seen.has(roomId)) return;
      seen.add(roomId);
      result.push(roomId);
    });
    return result;
  }

  function normalizePaymentMethodIdDraftList(value) {
    const seen = new Set();
    const result = [];
    if (!Array.isArray(value)) return result;
    value.forEach((entry) => {
      const methodId = String(entry ?? "").trim();
      if (!methodId || seen.has(methodId)) return;
      seen.add(methodId);
      result.push(methodId);
    });
    return result;
  }

  function normalizeStringDraftList(value) {
    const seen = new Set();
    const result = [];
    if (!Array.isArray(value)) return result;
    value.forEach((entry) => {
      const id = String(entry ?? "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      result.push(id);
    });
    return result;
  }

  function normalizeSettingsUserGroupDraft(rawGroup, fallbackIndex = 0, settings = null) {
    if (!rawGroup || typeof rawGroup !== "object") return null;
    const name = String(rawGroup.name ?? rawGroup.label ?? "").trim() || `Gruppo ${fallbackIndex + 1}`;
    const idRaw = String(rawGroup.id ?? rawGroup.code ?? "").trim();
    const id = idRaw || `group_${fallbackIndex + 1}`;
    const permissions = sanitizePermissionList(rawGroup.permissions, {
      role: "operator",
      includeRoleDefaults: false,
    });
    const enabledRoomIds = sanitizeEnabledRoomIds(normalizeRoomIdDraftList(rawGroup.enabledRoomIds), settings);
    const enabledRoomSet = new Set(enabledRoomIds);
    const authorizedRoomIds = sanitizeAuthorizedRoomIds(normalizeRoomIdDraftList(rawGroup.authorizedRoomIds), settings)
      .filter((roomId) => enabledRoomSet.has(roomId));
    return {
      id,
      name,
      description: String(rawGroup.description ?? "").trim().slice(0, 240),
      permissions,
      enabledRoomIds,
      authorizedRoomIds,
      workstationIds: sanitizeUserWorkstationIds(normalizeStringDraftList(rawGroup.workstationIds), settings),
      active: rawGroup.active !== false,
    };
  }

  function normalizeSettingsUserDraft(rawUser, fallbackIndex = 0) {
    if (!rawUser || typeof rawUser !== "object") return null;
    const role = normalizeUserRole(rawUser.role);
    const usernameRaw = String(rawUser.username ?? "").trim();
    const normalizedUsername = normalizeUsername(usernameRaw);
    const username = usernameRaw || normalizedUsername;
    const fullName = String(rawUser.fullName ?? "").trim() || toTitle(username) || `Operatore ${fallbackIndex + 1}`;
    const id = typeof rawUser.id === "string" && rawUser.id.trim() ? rawUser.id.trim() : "";
    const pin = typeof rawUser.pin === "string" ? rawUser.pin.trim() : "";
    const permissions = sanitizePermissionList(rawUser.permissions, {
      role,
      includeRoleDefaults: false,
    });
    const extraPermissionIds = sanitizePermissionList(rawUser.extraPermissionIds ?? rawUser.permissions, {
      role,
      includeRoleDefaults: false,
    });
    const enabledRoomIds = normalizeRoomIdDraftList(rawUser.enabledRoomIds);
    const enabledRoomSet = new Set(enabledRoomIds);
    const authorizedRoomIds = normalizeRoomIdDraftList(rawUser.authorizedRoomIds).filter((roomId) =>
      enabledRoomSet.size === 0 || enabledRoomSet.has(roomId)
    );
    const allowedPaymentMethodIds = normalizePaymentMethodIdDraftList(rawUser.allowedPaymentMethodIds);
    const enabledAppIds = sanitizeUserEnabledAppIds(rawUser.enabledAppIds);
    return {
      id,
      username,
      normalizedUsername,
      fullName,
      role,
      roleLabel: roleLabelFromRole(role),
      permissions,
      extraPermissionIds,
      enabledRoomIds,
      hasEnabledRoomIds: Array.isArray(rawUser.enabledRoomIds),
      authorizedRoomIds,
      hasAuthorizedRoomIds: Array.isArray(rawUser.authorizedRoomIds),
      allowedPaymentMethodIds,
      hasAllowedPaymentMethodIds: Array.isArray(rawUser.allowedPaymentMethodIds),
      groupIds: normalizeStringDraftList(rawUser.groupIds),
      hasGroupIds: Array.isArray(rawUser.groupIds),
      workstationIds: normalizeStringDraftList(rawUser.workstationIds),
      hasWorkstationIds: Array.isArray(rawUser.workstationIds),
      enabledAppIds,
      hasEnabledAppIds: Array.isArray(rawUser.enabledAppIds),
      waiterPauseSettings:
        rawUser.waiterPauseSettings && typeof rawUser.waiterPauseSettings === "object"
          ? { ...rawUser.waiterPauseSettings }
          : rawUser.pauseSettings && typeof rawUser.pauseSettings === "object"
            ? { ...rawUser.pauseSettings }
            : null,
      pin,
    };
  }

  function buildUniqueUserId(baseUsername, usedIds) {
    const base = normalizeUsername(baseUsername).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const fallbackBase = base ? `u_${base}` : `u_${Date.now().toString(36)}`;
    let candidate = fallbackBase;
    let counter = 1;
    while (usedIds.has(candidate)) {
      candidate = `${fallbackBase}_${counter}`;
      counter += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  return {
    buildPosSettingsUsersPayload,
    normalizeSettingsUserDraft,
    normalizeSettingsUserGroupDraft,
    buildUniqueUserId,
  };
}
