function normalizeIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function createPostazioneLogoutWriter({
  resolveStationStateId,
  runtimeMetrics,
  writeSessionAuditFastDb,
  writeStationPresenceDb,
  logger = console,
} = {}) {
  return async function writePostazioneLogout(db, options = {}) {
    const result =
      options.stationLogoutResult && typeof options.stationLogoutResult === "object"
        ? options.stationLogoutResult
        : {};
    const stationStateIds = normalizeIds(
      (Array.isArray(result.deactivatedStationStates)
        ? result.deactivatedStationStates
        : [])
        .map((entry) => resolveStationStateId?.(entry)),
    );
    const notificationIds = normalizeIds(result.notificationIds);
    const deletedSessionIds = normalizeIds(options.deletedSessionIds);
    const auditEventIds = normalizeIds(options.auditEventIds);
    const fastPathAvailable =
      result.changed === true &&
      stationStateIds.length > 0 &&
      deletedSessionIds.length > 0 &&
      typeof writeStationPresenceDb === "function" &&
      typeof writeSessionAuditFastDb === "function";

    if (!fastPathAvailable) {
      runtimeMetrics?.incrementCounter?.("postazioneLogoutFastFallbacks");
      return false;
    }

    try {
      const stationWritten = await writeStationPresenceDb(db, {
        stationStateIds,
        notificationIds,
        syncNoActiveStationsAlert: result.noActiveStationsAlertChanged === true,
      });
      if (!stationWritten) {
        runtimeMetrics?.incrementCounter?.("postazioneLogoutFastFallbacks");
        return false;
      }

      const sessionWritten = await writeSessionAuditFastDb(db, {
        deletedSessionIds,
        auditEventIds,
      });
      if (!sessionWritten) {
        runtimeMetrics?.incrementCounter?.("postazioneLogoutFastFallbacks");
        return false;
      }

      runtimeMetrics?.incrementCounter?.("postazioneLogoutFastWrites");
      return true;
    } catch (error) {
      runtimeMetrics?.incrementCounter?.("postazioneLogoutFastErrors");
      runtimeMetrics?.incrementCounter?.("postazioneLogoutFastFallbacks");
      logger?.warn?.(
        `[auth:logout] fast writer non disponibile, uso fallback completo: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };
}
