import {
  collectSessionSolarDayKeys,
  localDateKeyFromDate,
  sessionIntersectsLocalDay,
} from "./sales-sessions.domain.js";

export const SALE_SESSION_MAX_MS = 24 * 60 * 60 * 1000;

function defaultNowIso() {
  return new Date().toISOString();
}

export function closeExpiredSaleSessions(db, nowMs = Date.now()) {
  let changed = false;
  for (const session of db.saleSessions) {
    if (session.endedAt) continue;
    const startedAtMs = new Date(session.startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) {
      session.endedAt = new Date(nowMs).toISOString();
      session.endedByUserId = "system_auto";
      session.endedByUsername = "system";
      changed = true;
      continue;
    }

    if (nowMs >= startedAtMs + SALE_SESSION_MAX_MS) {
      session.endedAt = new Date(startedAtMs + SALE_SESSION_MAX_MS).toISOString();
      session.endedByUserId = "system_auto";
      session.endedByUsername = "system";
      changed = true;
    }
  }
  return changed;
}

export function createSolarClosureRecord(dayKey, saleSessions, options = {}) {
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : defaultNowIso;
  const transmittedAt = nowIso();
  return {
    id: `solar_${dayKey.replace(/-/g, "")}`,
    key: dayKey,
    transmittedAt,
    closedAt: transmittedAt,
    printerStatus: "accepted",
    printerResponseCode: "RT_OK",
    printerResponseMessage: "Trasmissione fiscale e chiusura solare completate.",
    totalSaleSessions: saleSessions.length,
    saleSessionIds: saleSessions.map((session) => session.id),
  };
}

export function processAutomaticSolarClosures(db, nowMs = Date.now(), options = {}) {
  const todayKey = localDateKeyFromDate(new Date(nowMs));
  const closureByKey = new Map(
    db.solarClosures
      .filter((closure) => closure && typeof closure.key === "string")
      .map((closure) => [closure.key, closure])
  );
  const candidateDayKeys = new Set();

  for (const session of db.saleSessions) {
    for (const dayKey of collectSessionSolarDayKeys(session, nowMs)) {
      if (dayKey < todayKey) {
        candidateDayKeys.add(dayKey);
      }
    }
  }

  let changed = false;
  for (const dayKey of candidateDayKeys) {
    if (closureByKey.has(dayKey)) continue;

    const daySessions = db.saleSessions.filter((session) =>
      sessionIntersectsLocalDay(session, dayKey, nowMs)
    );
    if (!daySessions.length) continue;

    db.solarClosures.push(createSolarClosureRecord(dayKey, daySessions, options));
    changed = true;
  }

  if (changed) {
    db.solarClosures.sort((a, b) => b.key.localeCompare(a.key));
  }

  return changed;
}

export function runAutomaticSaleLifecycle(db, nowMs = Date.now(), options = {}) {
  const expiredChanged = closeExpiredSaleSessions(db, nowMs);
  const solarChanged = processAutomaticSolarClosures(db, nowMs, options);
  return expiredChanged || solarChanged;
}
