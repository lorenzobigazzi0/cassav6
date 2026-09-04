export function normalizeIntegrationObjectFieldNames(...sources) {
  return [
    ...new Set(
      sources
        .flatMap((source) => (Array.isArray(source) ? source : [source]))
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => /^[A-Za-z][A-Za-z0-9_]*$/.test(entry)),
    ),
  ];
}

export async function syncIntegrationObjectFieldsFastPath(
  repository,
  db,
  fieldNames = [],
) {
  const fields = normalizeIntegrationObjectFieldNames(fieldNames);
  if (fields.length === 0) return;
  for (const fieldName of fields) {
    await repository.syncObjectEntryFromAppState(db, "integration", fieldName);
  }
}
