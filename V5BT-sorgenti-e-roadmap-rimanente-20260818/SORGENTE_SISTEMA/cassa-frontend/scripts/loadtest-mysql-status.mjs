function sharedNumericKeys(start, end) {
  return Object.keys(end || {}).filter(
    (key) => Number.isFinite(end?.[key]) && Number.isFinite(start?.[key]),
  );
}

export function calculateMysqlStatusDelta(start, end) {
  const keys = sharedNumericKeys(start, end);
  const serverRestarted =
    Number.isFinite(start?.Uptime) &&
    Number.isFinite(end?.Uptime) &&
    end.Uptime < start.Uptime;
  const resetKeys = [];
  const delta = {};

  for (const key of keys) {
    const counterReset = serverRestarted || end[key] < start[key];
    if (counterReset) {
      delta[key] = null;
      resetKeys.push(key);
      continue;
    }
    delta[key] = end[key] - start[key];
  }

  return {
    delta,
    resetKeys: [...new Set(resetKeys)].sort(),
    serverRestarted,
  };
}
