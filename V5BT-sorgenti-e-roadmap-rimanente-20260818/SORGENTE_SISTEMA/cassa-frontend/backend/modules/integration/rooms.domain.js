export function createIntegrationRoomHelpers(options = {}) {
  const {
    normalizeConfigId = (value, fallback = "") => String(value ?? "").trim() || fallback,
    toTitle = (value) => String(value ?? "").trim(),
    nowDate = () => new Date(),
  } = options;

  function toIntegrationRoomSlug(value, fallback = "sala") {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || fallback;
  }

  function resolveIntegrationRoomFromType(typeRaw, usedRoomIds) {
    const typeLabel = String(typeRaw ?? "").trim() || "Sala";
    const normalized = toIntegrationRoomSlug(typeLabel, "sala");
    const baseId = `room_${normalized}`;
    const baseName = toTitle(typeLabel) || "Sala";

    let nextId = baseId;
    let suffix = 2;
    while (usedRoomIds.has(nextId)) {
      nextId = `${baseId}_${suffix}`;
      suffix += 1;
    }
    usedRoomIds.add(nextId);

    return {
      id: nextId,
      name: baseName,
      type: typeLabel,
    };
  }

  function normalizePosRoomId(value) {
    return normalizeConfigId(value, "");
  }

  function resolveIntegrationRoomFromTable(table, usedRoomIds, configuredAreasById = null) {
    const explicitRoomId = normalizePosRoomId(table?.roomId ?? table?.areaId ?? "");
    if (!explicitRoomId) {
      return resolveIntegrationRoomFromType(table?.type, usedRoomIds);
    }

    usedRoomIds.add(explicitRoomId);
    const configuredArea = configuredAreasById?.get(explicitRoomId) ?? null;
    const typeLabel = String(table?.type ?? configuredArea?.name ?? "").trim() || configuredArea?.name || "Sala";
    const name =
      String(configuredArea?.name ?? table?.roomName ?? table?.areaName ?? table?.type ?? "").trim() ||
      toTitle(explicitRoomId.replace(/^room_/, "").replace(/^sala_/, "").replace(/_/g, " ")) ||
      explicitRoomId;

    return {
      id: explicitRoomId,
      name,
      type: typeLabel,
    };
  }

  function parseIntegrationReservationAt(reservation) {
    if (!reservation || typeof reservation !== "object") return null;
    const time = String(reservation.time ?? "").trim();
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match) return null;
    const next = nowDate();
    next.setHours(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), 0, 0);
    return next.getTime();
  }

  return {
    normalizePosRoomId,
    parseIntegrationReservationAt,
    resolveIntegrationRoomFromTable,
    resolveIntegrationRoomFromType,
    toIntegrationRoomSlug,
  };
}
