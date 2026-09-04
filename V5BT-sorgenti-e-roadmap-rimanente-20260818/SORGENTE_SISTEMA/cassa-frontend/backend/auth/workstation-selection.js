const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function workstationDescriptor(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeText(entry.id ?? entry.stationId ?? entry.workstationId);
  const stationName = normalizeText(
    entry.stationName ?? entry.station ?? entry.name ?? entry.label ?? id,
  );
  if (!id || !stationName) return null;
  if (entry.enabled === false || entry.active === false || entry.status === "disabled") {
    return null;
  }
  return {
    id,
    name: normalizeText(entry.name ?? entry.label ?? stationName) || stationName,
    stationName,
  };
}

export function collectLoginWorkstations(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const entries = [
    ...(Array.isArray(source.workstations) ? source.workstations : []),
  ];
  for (const area of Array.isArray(source.areas) ? source.areas : []) {
    entries.push(...(Array.isArray(area?.workstations) ? area.workstations : []));
  }
  for (const room of Array.isArray(source.rooms) ? source.rooms : []) {
    entries.push(...(Array.isArray(room?.workstations) ? room.workstations : []));
  }

  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const descriptor = workstationDescriptor(entry);
    if (!descriptor || seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    result.push(descriptor);
  }
  return result;
}

export function resolveUserLoginWorkstations(user, settings) {
  const configured = collectLoginWorkstations(settings);
  if (!Array.isArray(user?.workstationIds)) {
    return configured;
  }
  const allowedIds = new Set(
    user.workstationIds.map(normalizeText).filter(Boolean),
  );
  return configured.filter((entry) => allowedIds.has(entry.id));
}

export function findUserLoginWorkstation(user, settings, workstationId) {
  const expectedId = normalizeText(workstationId);
  if (!expectedId) return null;
  return (
    resolveUserLoginWorkstations(user, settings).find(
      (entry) => entry.id === expectedId,
    ) ?? null
  );
}
