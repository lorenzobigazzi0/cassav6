function normalizeTableId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeTableIds(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [value])
        .map((entry) => normalizeTableId(entry?.tableId ?? entry?.id ?? entry))
        .filter(Boolean),
    ),
  ];
}

function normalizeRevision(value, fallback = 1) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export function buildOrderFinancialTableRevisionTokens({ getTableState, includeSnapshots = false, tableIds = [] } = {}) {
  const safeGetTableState = typeof getTableState === "function" ? getTableState : () => null;
  return normalizeTableIds(tableIds).map((tableId) => {
    const current = safeGetTableState(tableId);
    return {
      tableId,
      revision: normalizeRevision(current?.revision ?? current?.currentRevision, 1),
      exists: Boolean(current),
      ...(includeSnapshots && current && typeof current === "object" ? { tableSnapshot: current } : {}),
    };
  });
}

export function applyOrderFinancialTableRevisionTokens({ settings, tableIds = [], tokens = [] } = {}) {
  const safeSettings = settings && typeof settings === "object" ? settings : {};
  const sourceTables = Array.isArray(safeSettings.tables) ? safeSettings.tables : [];
  const targetIds = new Set(normalizeTableIds(tableIds));
  const tokenByTableId = new Map(
    (Array.isArray(tokens) ? tokens : [])
      .map((token) => {
        const tableId = normalizeTableId(token?.tableId);
        return tableId ? [tableId, token] : null;
      })
      .filter(Boolean),
  );
  if (targetIds.size === 0 || sourceTables.length === 0) {
    return {
      changed: false,
      settings: safeSettings,
      tableIds: [...targetIds],
      tokens: [...tokenByTableId.values()],
    };
  }

  let changed = false;
  const touchedTableIds = [];
  const nextTables = sourceTables.map((table) => {
    const tableId = normalizeTableId(table?.id ?? table?.tableId);
    if (!tableId || !targetIds.has(tableId)) return table;
    const token = tokenByTableId.get(tableId);
    const previousRevision = normalizeRevision(
      token?.revision ?? table?.revision ?? table?.currentRevision,
      1,
    );
    const nextRevision = previousRevision + 1;
    touchedTableIds.push(tableId);
    if (
      normalizeRevision(table?.revision ?? table?.currentRevision, 1) === nextRevision &&
      table?.currentRevision === undefined
    ) {
      return table;
    }
    changed = true;
    return {
      ...table,
      revision: nextRevision,
      ...(table?.currentRevision === undefined ? {} : { currentRevision: nextRevision }),
    };
  });

  return {
    changed,
    settings: changed ? { ...safeSettings, tables: nextTables } : safeSettings,
    tableIds: touchedTableIds,
    tokens: [...tokenByTableId.values()],
  };
}
