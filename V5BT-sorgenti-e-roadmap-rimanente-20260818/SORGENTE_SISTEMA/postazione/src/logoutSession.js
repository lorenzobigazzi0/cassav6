export async function performPostazioneLogout({
  authSnapshot,
  station,
  reason,
  sessionInvalid,
  completeLocalLogout,
  requestBackendLogout,
  requestStationOffline,
  onBackendUnavailable,
}) {
  completeLocalLogout(reason);

  try {
    if (sessionInvalid) {
      await requestStationOffline(authSnapshot, station);
      return { ok: true, sessionInvalid: true };
    }

    const result = await requestBackendLogout(authSnapshot, station);
    if (!result?.ok) {
      onBackendUnavailable?.(result);
      return result || { ok: false };
    }
    if (result.sessionInvalid) {
      await requestStationOffline(authSnapshot, station);
    }
    return result;
  } catch (error) {
    const result = { ok: false, error };
    onBackendUnavailable?.(result);
    return result;
  }
}

export function isAuthenticatedPostazioneSession(auth) {
  return Boolean(
    auth?.loggedIn === true &&
      String(auth.token || "").trim() &&
      String(auth.userId || auth.username || "").trim() &&
      String(auth.deviceUuid || "").trim()
  );
}

export function isCurrentPostazioneSession(
  capturedGeneration,
  currentGeneration,
  auth
) {
  return (
    capturedGeneration === currentGeneration &&
    isAuthenticatedPostazioneSession(auth)
  );
}

export function canStartPostazioneLogin(logoutInFlight) {
  return logoutInFlight !== true;
}
