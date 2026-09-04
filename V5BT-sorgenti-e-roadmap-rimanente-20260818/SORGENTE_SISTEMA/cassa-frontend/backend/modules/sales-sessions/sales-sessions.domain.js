function pad2(value) {
  return String(value).padStart(2, "0");
}

export function localDateKeyFromDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function timeToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ""));
  if (!match) return null;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

export function isOvernightWindow(startMinutes, endMinutes) {
  return endMinutes <= startMinutes;
}

export function isNowInsideWindow(nowMinutes, startMinutes, endMinutes) {
  if (isOvernightWindow(startMinutes, endMinutes)) {
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

function parseLocalDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ""));
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  const date = new Date(year, monthIndex, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function getSessionInterval(session, nowMs = Date.now()) {
  const startedAtMs = new Date(session.startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }

  const endedAtMs = session.endedAt ? new Date(session.endedAt).getTime() : nowMs;
  const safeEndedAtMs = Number.isFinite(endedAtMs) ? endedAtMs : nowMs;
  return {
    startedAtMs,
    endedAtMs: Math.max(safeEndedAtMs, startedAtMs),
  };
}

export function sessionIntersectsLocalDay(session, key, nowMs = Date.now()) {
  const dayStart = parseLocalDateKey(key);
  if (!dayStart) return false;
  const dayStartMs = dayStart.getTime();
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const dayEndMs = dayEnd.getTime();

  const interval = getSessionInterval(session, nowMs);
  if (!interval) return false;

  return interval.startedAtMs < dayEndMs && interval.endedAtMs > dayStartMs;
}

export function collectSessionSolarDayKeys(session, nowMs = Date.now()) {
  const interval = getSessionInterval(session, nowMs);
  if (!interval) return [];

  const keys = [];
  const cursor = new Date(interval.startedAtMs);
  cursor.setHours(0, 0, 0, 0);
  const endExclusiveMs = Math.max(interval.endedAtMs, interval.startedAtMs + 1);

  while (cursor.getTime() < endExclusiveMs) {
    keys.push(localDateKeyFromDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys;
}

export function computeBusinessDateForStart(startedAtIso, template) {
  const startedAt = new Date(startedAtIso);
  const startMinutes = timeToMinutes(template.startTime);
  const endMinutes = timeToMinutes(template.endTime);

  if (startMinutes === null || endMinutes === null) {
    return localDateKeyFromDate(startedAt);
  }

  const nowMinutes = startedAt.getHours() * 60 + startedAt.getMinutes();
  if (isOvernightWindow(startMinutes, endMinutes) && nowMinutes < endMinutes) {
    const previousDay = new Date(startedAt);
    previousDay.setDate(previousDay.getDate() - 1);
    return localDateKeyFromDate(previousDay);
  }

  return localDateKeyFromDate(startedAt);
}

export function sanitizeSaleSessionTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    startTime: template.startTime,
    endTime: template.endTime,
    enabled: Boolean(template.enabled),
  };
}

export function sanitizeSaleSession(session) {
  return {
    id: session.id,
    templateId: session.templateId,
    templateName: session.templateName,
    scheduledStart: session.scheduledStart,
    scheduledEnd: session.scheduledEnd,
    businessDate: session.businessDate,
    startedAt: session.startedAt,
    startedByUserId: session.startedByUserId,
    startedByUsername: session.startedByUsername,
    endedAt: session.endedAt ?? null,
    endedByUserId: session.endedByUserId ?? null,
    endedByUsername: session.endedByUsername ?? null,
  };
}

export function sanitizeSolarClosure(closure) {
  return {
    id: closure.id,
    key: closure.key,
    transmittedAt: closure.transmittedAt,
    closedAt: closure.closedAt,
    printerStatus: closure.printerStatus,
    printerResponseCode: closure.printerResponseCode,
    printerResponseMessage: closure.printerResponseMessage,
    totalSaleSessions: Number.isFinite(closure.totalSaleSessions) ? closure.totalSaleSessions : 0,
    saleSessionIds: Array.isArray(closure.saleSessionIds) ? [...closure.saleSessionIds] : [],
  };
}

export function findActiveSaleSession(db) {
  const active = db.saleSessions.filter((session) => !session.endedAt);
  if (!active.length) return null;
  active.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return active[0];
}

export function suggestSaleSessionTemplate(templates, now = new Date()) {
  const enabled = templates.filter((template) => template.enabled !== false);
  if (!enabled.length) return null;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let bestTemplate = enabled[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const template of enabled) {
    const startMinutes = timeToMinutes(template.startTime);
    const endMinutes = timeToMinutes(template.endTime);
    if (startMinutes === null || endMinutes === null) continue;

    const inWindow = isNowInsideWindow(nowMinutes, startMinutes, endMinutes);
    const deltaToStart = (startMinutes - nowMinutes + 1440) % 1440;
    const score = inWindow ? Math.abs(nowMinutes - startMinutes) : 1000 + deltaToStart;

    if (score < bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  }

  return bestTemplate;
}

export function buildDaySummary(kind, key, saleSessions) {
  const nowMs = Date.now();
  const filtered = saleSessions
    .filter((session) => {
      if (kind === "solar") {
        return sessionIntersectsLocalDay(session, key, nowMs);
      }
      return session.businessDate === key;
    })
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const startedAt = filtered.length ? filtered[0].startedAt : null;
  const active = filtered.some((session) => !session.endedAt);

  let endedAt = null;
  if (!active && filtered.length) {
    endedAt = filtered.reduce((latest, session) => {
      if (!session.endedAt) return latest;
      if (!latest) return session.endedAt;
      return new Date(session.endedAt).getTime() > new Date(latest).getTime() ? session.endedAt : latest;
    }, null);
  }

  return {
    kind,
    key,
    startedAt,
    endedAt,
    totalSaleSessions: filtered.length,
    active,
    saleSessionIds: filtered.map((session) => session.id),
  };
}

export function createSaleSessionStatusBuilder({ hasPermission }) {
  return function buildSaleSessionStatus(db, user) {
    const active = findActiveSaleSession(db);
    const templates = db.saleSessionTemplates
      .map(sanitizeSaleSessionTemplate)
      .sort((a, b) => a.name.localeCompare(b.name));

    const suggestedTemplate = suggestSaleSessionTemplate(templates);

    const now = new Date();
    const solarKey = localDateKeyFromDate(now);

    const fallbackBusinessKey =
      suggestedTemplate !== null
        ? computeBusinessDateForStart(now.toISOString(), suggestedTemplate)
        : localDateKeyFromDate(now);

    const businessKey = active ? active.businessDate : fallbackBusinessKey;

    const recent = [...db.saleSessions]
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 8)
      .map(sanitizeSaleSession);

    const recentSolarClosures = [...db.solarClosures]
      .sort((a, b) => {
        const aTs = new Date(a.transmittedAt).getTime();
        const bTs = new Date(b.transmittedAt).getTime();
        if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
          return bTs - aTs;
        }
        return b.key.localeCompare(a.key);
      })
      .slice(0, 6)
      .map(sanitizeSolarClosure);

    const currentSolarClosureRaw = db.solarClosures.find((closure) => closure.key === solarKey);
    const currentSolarClosure = currentSolarClosureRaw ? sanitizeSolarClosure(currentSolarClosureRaw) : null;

    return {
      ok: true,
      canManageSaleSessions: hasPermission(user, "manage_sale_sessions"),
      activeSaleSession: active ? sanitizeSaleSession(active) : null,
      suggestedTemplate: suggestedTemplate ? sanitizeSaleSessionTemplate(suggestedTemplate) : null,
      templates,
      solarDaySession: buildDaySummary("solar", solarKey, db.saleSessions),
      businessDaySession: buildDaySummary("business", businessKey, db.saleSessions),
      recentSaleSessions: recent,
      currentSolarClosure,
      latestSolarClosure: recentSolarClosures[0] ?? null,
      recentSolarClosures,
    };
  };
}
