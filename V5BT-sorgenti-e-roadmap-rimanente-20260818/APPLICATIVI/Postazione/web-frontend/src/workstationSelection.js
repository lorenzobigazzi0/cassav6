const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

function normalizeWorkstationDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.active === false) return null;

  const id = normalizeText(value.id);
  const stationName = normalizeText(value.stationName);
  if (!id || !stationName) return null;

  return {
    id,
    name: normalizeText(value.name) || stationName,
    stationName,
  };
}

export function normalizeAvailableWorkstations(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  if (!Array.isArray(payload.availableWorkstations)) return [];

  const seen = new Set();
  const workstations = [];
  payload.availableWorkstations.forEach((value) => {
    const workstation = normalizeWorkstationDescriptor(value);
    if (!workstation || seen.has(workstation.id)) return;
    seen.add(workstation.id);
    workstations.push(workstation);
  });
  return workstations;
}

export function normalizeSelectedWorkstation(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return normalizeWorkstationDescriptor(payload.selectedWorkstation);
}

export function findAvailableWorkstation(workstations, workstationId) {
  const expectedId = normalizeText(workstationId);
  if (!expectedId || !Array.isArray(workstations)) return null;

  for (const value of workstations) {
    const workstation = normalizeWorkstationDescriptor(value);
    if (workstation?.id === expectedId) return workstation;
  }
  return null;
}
