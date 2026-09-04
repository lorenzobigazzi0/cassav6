function tableId(table) {
  return String(table?.id ?? "").trim();
}

export function availableV6FixtureTables(
  tables,
  { reservedTableIds = null, allowReuse = false } = {},
) {
  const candidates = (Array.isArray(tables) ? tables : []).filter((table) =>
    Boolean(tableId(table)),
  );
  if (!(reservedTableIds instanceof Set)) return candidates;

  const available = candidates.filter(
    (table) => !reservedTableIds.has(tableId(table)),
  );
  if (available.length > 0 || !allowReuse || candidates.length === 0) {
    return available;
  }

  for (const table of candidates) reservedTableIds.delete(tableId(table));
  return candidates;
}
