function normalizedId(value) {
  return String(value ?? "").trim();
}

function authorizedRoomIdsForDevice(device) {
  const roomIds = device?.session?.user?.authorizedRoomIds;
  if (!Array.isArray(roomIds)) return new Set();
  return new Set(roomIds.map(normalizedId).filter(Boolean));
}

function tableIsAuthorized(table, authorizedRoomIds) {
  return (
    authorizedRoomIds.size === 0 ||
    authorizedRoomIds.has(normalizedId(table?.roomId))
  );
}

function uniqueEligibleTables(tables, excludedTableIds) {
  const unique = [];
  const seen = new Set();
  for (const table of Array.isArray(tables) ? tables : []) {
    const tableId = normalizedId(table?.id);
    if (!tableId || seen.has(tableId) || excludedTableIds.has(tableId)) continue;
    seen.add(tableId);
    unique.push(table);
  }
  return unique;
}

export function ensureV6OrderTableCapacity({
  handhelds,
  orderTables,
  runtimeTables,
  excludedTableIds = new Set(),
  minimumPerHandheld,
}) {
  const minimum = Number(minimumPerHandheld);
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error("minimumPerHandheld deve essere un intero positivo.");
  }

  const excluded = new Set(
    excludedTableIds instanceof Set
      ? [...excludedTableIds].map(normalizedId).filter(Boolean)
      : [],
  );
  const selected = uniqueEligibleTables(orderTables, excluded);
  const selectedIds = new Set(selected.map((table) => normalizedId(table.id)));
  const runtimeCandidates = uniqueEligibleTables(runtimeTables, excluded);
  const addedTables = [];

  const devices = (Array.isArray(handhelds) ? handhelds : [])
    .filter((device) => device?.kind === "handheld")
    .map((device, index) => {
      const authorizedRoomIds = authorizedRoomIdsForDevice(device);
      const availableRuntime = runtimeCandidates.filter((table) =>
        tableIsAuthorized(table, authorizedRoomIds),
      ).length;
      return { device, index, authorizedRoomIds, availableRuntime };
    })
    .sort(
      (left, right) =>
        left.availableRuntime - right.availableRuntime || left.index - right.index,
    );

  for (const [deviceIndex, { device, authorizedRoomIds }] of devices.entries()) {
    let authorizedCount = selected.filter((table) =>
      tableIsAuthorized(table, authorizedRoomIds),
    ).length;

    if (authorizedCount < minimum) {
      for (const table of runtimeCandidates) {
        const tableId = normalizedId(table?.id);
        if (
          authorizedCount >= minimum ||
          selectedIds.has(tableId) ||
          !tableIsAuthorized(table, authorizedRoomIds)
        ) {
          continue;
        }
        selected.push(table);
        selectedIds.add(tableId);
        addedTables.push(table);
        authorizedCount += 1;
      }
    }

    const deviceId = normalizedId(device?.id) || `handheld-${deviceIndex + 1}`;
    if (authorizedCount < minimum) {
      throw new Error(
        `Tavoli order autorizzati insufficienti per ${deviceId} dopo l'isolamento fixture (${authorizedCount}/${minimum}).`,
      );
    }
  }

  const capacityByHandheld = devices.map(
    ({ device, authorizedRoomIds }, index) => ({
      deviceId: normalizedId(device?.id) || `handheld-${index + 1}`,
      authorizedTables: selected.filter((table) =>
        tableIsAuthorized(table, authorizedRoomIds),
      ).length,
    }),
  );
  capacityByHandheld.sort((left, right) =>
    left.deviceId.localeCompare(right.deviceId),
  );
  return {
    orderTables: selected,
    addedTables,
    minimumPerHandheld: minimum,
    capacityByHandheld,
  };
}
