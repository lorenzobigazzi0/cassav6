export function createUsersHandlers({
  HttpError,
  appendAuditEvent,
  buildAuditActor,
  buildPosSettingsUsersPayload,
  buildUniqueUserId,
  hashPin,
  hasPermission,
  isUserAppEnabled,
  normalizeSettingsUserDraft,
  normalizeSettingsUserGroupDraft,
  normalizeWaiterPauseSettings,
  nowIso,
  readDb,
  readJsonBody,
  readUsersListView,
  redisVolatileStore = null,
  requireAuthSessionCacheInvalidation = () => false,
  sanitizeAuthorizedRoomIds,
  sanitizeEnabledRoomIds,
  sanitizeUser,
  sanitizeUserEnabledAppIds,
  sanitizeUserPaymentMethodIds,
  sendJson,
  touchSettingsMetadata,
  validateSessionContext,
  writeDb,
}) {
  async function handlePosSettingsUsers(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readUsersListView(payload));
  }

  async function handleSavePosSettingsUsers(req, res) {
    const payload = await readJsonBody(req);
    const payloadUsers = Array.isArray(payload.users) ? payload.users : null;
    if (!payloadUsers || payloadUsers.length === 0) {
      throw new HttpError(400, "Lista utenti non valida.");
    }

    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (!hasPermission(user, "manage_users")) {
      throw new HttpError(403, "Utente non autorizzato alla gestione utenti.");
    }

    const rawGroups = Array.isArray(payload.groups) ? payload.groups : Array.isArray(db.userGroups) ? db.userGroups : [];
    const nextGroups = [];
    const seenGroupIds = new Set();
    for (let index = 0; index < rawGroups.length; index += 1) {
      const group = normalizeSettingsUserGroupDraft(rawGroups[index], index, db.posSettings);
      if (!group) continue;
      if (seenGroupIds.has(group.id)) {
        throw new HttpError(400, `ID gruppo duplicato: ${group.id}.`);
      }
      seenGroupIds.add(group.id);
      nextGroups.push(group);
    }
    const groupsById = new Map(nextGroups.map((group) => [group.id, group]));
    const uniqueStrings = (values) => {
      const seen = new Set();
      const result = [];
      (Array.isArray(values) ? values : []).forEach((entry) => {
        const value = String(entry ?? "").trim();
        if (!value || seen.has(value)) return;
        seen.add(value);
        result.push(value);
      });
      return result;
    };

    const currentUsers = Array.isArray(db.users) ? db.users : [];
    const currentUsersById = new Map(
      currentUsers.map((entry) => [String(entry.id ?? "").trim(), entry]).filter(([id]) => id.length > 0)
    );
    const usedIds = new Set(currentUsersById.keys());
    const seenUsernames = new Set();
    const seenIncomingIds = new Set();
    const nextUsers = [];

    for (let index = 0; index < payloadUsers.length; index += 1) {
      const draft = normalizeSettingsUserDraft(payloadUsers[index], index);
      if (!draft) {
        throw new HttpError(400, `Utente #${index + 1} non valido.`);
      }
      if (!draft.normalizedUsername) {
        throw new HttpError(400, `Username utente #${index + 1} non valido.`);
      }
      if (seenUsernames.has(draft.normalizedUsername)) {
        throw new HttpError(400, `Username duplicato: ${draft.username}.`);
      }
      seenUsernames.add(draft.normalizedUsername);

      if (draft.id) {
        if (seenIncomingIds.has(draft.id)) {
          throw new HttpError(400, `ID utente duplicato: ${draft.id}.`);
        }
        seenIncomingIds.add(draft.id);
      }

      const existing = draft.id ? currentUsersById.get(draft.id) ?? null : null;
      let nextId = existing ? String(existing.id) : draft.id;
      if (!existing) {
        if (nextId) {
          if (usedIds.has(nextId)) {
            throw new HttpError(400, `ID utente duplicato: ${nextId}.`);
          }
          usedIds.add(nextId);
        } else {
          nextId = buildUniqueUserId(draft.username, usedIds);
        }
      } else {
        usedIds.add(nextId);
      }

      const hasPinInput = draft.pin.length > 0;
      if (!existing && !/^\d{4,6}$/.test(draft.pin)) {
        throw new HttpError(400, `PIN non valido per ${draft.username} (4-6 cifre).`);
      }
      if (existing && hasPinInput && !/^\d{4,6}$/.test(draft.pin)) {
        throw new HttpError(400, `PIN non valido per ${draft.username} (4-6 cifre).`);
      }

      const createdAt = String(existing?.createdAt ?? nowIso());
      const updatedAt = nowIso();
      const pinHash = existing
        ? hasPinInput
          ? hashPin(draft.pin)
          : existing.pinHash
        : hashPin(draft.pin);
      const rawGroupIds = draft.hasGroupIds ? draft.groupIds : existing?.groupIds;
      const groupIds = uniqueStrings(rawGroupIds).filter((groupId) => groupsById.has(groupId));
      const assignedGroups = groupIds.map((groupId) => groupsById.get(groupId)).filter(Boolean);
      const groupPermissionIds = assignedGroups.flatMap((group) => group.permissions ?? []);
      const groupEnabledRoomIds = assignedGroups.flatMap((group) => group.enabledRoomIds ?? []);
      const groupAuthorizedRoomIds = assignedGroups.flatMap((group) => group.authorizedRoomIds ?? []);
      const groupWorkstationIds = assignedGroups.flatMap((group) => group.workstationIds ?? []);
      const extraPermissionIds = [...draft.extraPermissionIds];
      const effectivePermissions = uniqueStrings([...groupPermissionIds, ...extraPermissionIds]);
      const enabledRoomIds = sanitizeEnabledRoomIds(
        uniqueStrings([
          ...(draft.hasEnabledRoomIds ? draft.enabledRoomIds : existing?.enabledRoomIds ?? []),
          ...groupEnabledRoomIds,
        ]),
        db.posSettings
      );
      const enabledRoomSet = new Set(enabledRoomIds);
      const rawAuthorized = draft.hasAuthorizedRoomIds ? draft.authorizedRoomIds : existing?.authorizedRoomIds;
      const authorizedRoomIds = sanitizeAuthorizedRoomIds(
        uniqueStrings([...(Array.isArray(rawAuthorized) ? rawAuthorized : []), ...groupAuthorizedRoomIds]),
        db.posSettings
      ).filter((roomId) => enabledRoomSet.has(roomId));
      const requestedDefaultRoomId = String(payloadUsers[index]?.defaultRoomId ?? existing?.defaultRoomId ?? "").trim();
      const defaultRoomId = requestedDefaultRoomId && enabledRoomSet.has(requestedDefaultRoomId)
        ? requestedDefaultRoomId
        : null;
      const allowedPaymentMethodIds = sanitizeUserPaymentMethodIds(
        draft.hasAllowedPaymentMethodIds ? draft.allowedPaymentMethodIds : existing?.allowedPaymentMethodIds,
        db.posSettings
      );
      const rawIncomingUser = payloadUsers[index] && typeof payloadUsers[index] === "object" ? payloadUsers[index] : {};
      const fiscalPolicy = String(rawIncomingUser.fiscalPolicy ?? existing?.fiscalPolicy ?? "").trim();
      const waiterPauseSettings = normalizeWaiterPauseSettings(
        rawIncomingUser.waiterPauseSettings && typeof rawIncomingUser.waiterPauseSettings === "object"
          ? rawIncomingUser
          : existing ?? {}
      );

      nextUsers.push({
        id: nextId,
        username: draft.username,
        fullName: draft.fullName,
        role: draft.role,
        roleLabel: draft.roleLabel,
        permissions: effectivePermissions,
        extraPermissionIds,
        groupIds,
        workstationIds: uniqueStrings([
          ...(draft.hasWorkstationIds ? draft.workstationIds : existing?.workstationIds ?? []),
          ...groupWorkstationIds,
        ]),
        enabledAppIds: sanitizeUserEnabledAppIds(
          draft.hasEnabledAppIds ? draft.enabledAppIds : existing?.enabledAppIds,
        ),
        allowedPaymentMethodIds,
        waiterPauseSettings,
        enabledRoomIds,
        authorizedRoomIds,
        defaultRoomId,
        lastSelectedRoomId: String(existing?.lastSelectedRoomId ?? "").trim() || null,
        lastSelectedRoomName: String(existing?.lastSelectedRoomName ?? "").trim() || null,
        lastSelectedRoomAt: String(existing?.lastSelectedRoomAt ?? "").trim() || null,
        lastSelectedRoomDeviceUuid: String(existing?.lastSelectedRoomDeviceUuid ?? "").trim() || null,
        pinHash,
        createdAt,
        updatedAt,
        ...(rawIncomingUser.fiscalExcluded === true || existing?.fiscalExcluded === true
          ? { fiscalExcluded: true }
          : {}),
        ...(fiscalPolicy ? { fiscalPolicy } : {}),
        ...(rawIncomingUser.autoPaidNoFiscal === true || existing?.autoPaidNoFiscal === true
          ? { autoPaidNoFiscal: true }
          : {}),
      });
    }

    const currentUserAfterSave = nextUsers.find((entry) => entry.id === user.id) ?? null;
    if (!currentUserAfterSave) {
      throw new HttpError(400, "Non puoi rimuovere il tuo utente durante una sessione attiva.");
    }
    if (!currentUserAfterSave.permissions.includes("manage_users")) {
      throw new HttpError(400, "Non puoi rimuovere il permesso gestione utenti dal tuo account attivo.");
    }
    if (!nextUsers.some((entry) => entry.permissions.includes("manage_users"))) {
      throw new HttpError(400, "Almeno un utente deve mantenere il permesso gestione utenti.");
    }

    const nextUsersById = new Map(nextUsers.map((entry) => [entry.id, entry]));
    const currentSessions = Array.isArray(db.sessions) ? db.sessions : [];
    const shouldRetainSession = (session) => {
      const sessionUser = nextUsersById.get(String(session.userId ?? "").trim());
      return Boolean(
        sessionUser && isUserAppEnabled(sessionUser, session.clientApp),
      );
    };
    const retainedSessions = currentSessions.filter(shouldRetainSession);
    const revokedSessions = currentSessions.filter(
      (session) => !shouldRetainSession(session),
    );
    if (requireAuthSessionCacheInvalidation() === true && revokedSessions.length > 0) {
      const invalidated = typeof redisVolatileStore?.deleteAuthSessions === "function"
        && await redisVolatileStore.deleteAuthSessions(revokedSessions);
      if (!invalidated) {
        throw new HttpError(503, "Impossibile revocare in sicurezza le sessioni utenti. Riprova tra poco.", {
          code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
        });
      }
    }
    await Promise.all(
      revokedSessions.map(async (session) => {
        if (typeof redisVolatileStore?.deleteSession !== "function") return;
        await redisVolatileStore.deleteSession({
          deviceUuid: session.deviceUuid,
          sessionId: session.id,
        });
      }),
    );
    const auditActor = buildAuditActor(user, payload);
    currentUsers.forEach((entry) => {
      const currentId = String(entry.id ?? "").trim();
      if (!currentId || nextUsersById.has(currentId)) return;
      appendAuditEvent(db, {
        ...auditActor,
        action: "security.admin_delete",
        entityType: "user",
        entityId: currentId,
        payload: {
          reason: String(payload.deleteReason ?? "user_removed").trim() || "user_removed",
          username: String(entry.username ?? ""),
        },
        before: sanitizeUser(entry, db.posSettings),
        after: null,
      });
    });
    nextUsers.forEach((entry) => {
      const previous = currentUsersById.get(entry.id) ?? null;
      if (!previous) {
        appendAuditEvent(db, {
          ...auditActor,
          action: "user.created",
          entityType: "user",
          entityId: entry.id,
          payload: sanitizeUser(entry, db.posSettings),
          after: sanitizeUser(entry, db.posSettings),
        });
        return;
      }
      const previousSanitized = sanitizeUser(previous, db.posSettings);
      const nextSanitized = sanitizeUser(entry, db.posSettings);
      if (JSON.stringify(previousSanitized) === JSON.stringify(nextSanitized)) return;
      appendAuditEvent(db, {
        ...auditActor,
        action: "user.updated",
        entityType: "user",
        entityId: entry.id,
        before: previousSanitized,
        after: nextSanitized,
      });
    });

    db.userGroups = nextGroups;
    db.users = nextUsers;
    db.sessions = retainedSessions;
    touchSettingsMetadata(db);
    await writeDb(db, {
      sessionsSync: { deleteMissing: true },
    });

    sendJson(res, 200, buildPosSettingsUsersPayload(db));
  }

  return {
    handlePosSettingsUsers,
    handleSavePosSettingsUsers,
  };
}
