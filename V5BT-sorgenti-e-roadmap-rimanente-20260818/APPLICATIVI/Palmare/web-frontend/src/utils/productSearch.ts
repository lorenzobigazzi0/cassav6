export const normalizeProductSearchText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ck/g, "k")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const compactSearchText = (value: string) => value.replace(/\s+/g, "");

export const hasProductSearchQuery = (query: unknown) =>
  normalizeProductSearchText(query).length > 0;

export function textPartsMatchProductSearch(parts: unknown[], query: unknown) {
  const normalizedQuery = normalizeProductSearchText(query);
  if (!normalizedQuery) return true;

  const normalizedHaystack = normalizeProductSearchText(parts.join(" "));
  if (!normalizedHaystack) return false;

  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  const haystackWords = normalizedHaystack.split(" ").filter(Boolean);
  const matchesByWordPrefix = queryTerms.every((term) =>
    haystackWords.some((word) => word.startsWith(term))
  );
  if (matchesByWordPrefix) return true;

  const compactQuery = compactSearchText(normalizedQuery);
  if (compactQuery.length <= 1) return false;

  return (
    normalizedHaystack.includes(normalizedQuery) ||
    compactSearchText(normalizedHaystack).includes(compactQuery)
  );
}
