export const HACCP_ALLERGEN_OPTIONS = [
  "Glutine",
  "Crostacei",
  "Uova",
  "Pesce",
  "Arachidi",
  "Soia",
  "Latte",
  "Frutta a guscio",
  "Sedano",
  "Senape",
  "Semi di sesamo",
  "Solfiti",
  "Lupini",
  "Molluschi",
] as const;

export type HaccpAllergen = (typeof HACCP_ALLERGEN_OPTIONS)[number];

const normalizeAllergenKey = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

const CANONICAL_ALLERGEN_BY_KEY = new Map<string, string>(
  HACCP_ALLERGEN_OPTIONS.map((label) => [normalizeAllergenKey(label), label])
);

CANONICAL_ALLERGEN_BY_KEY.set("sesamo", "Semi di sesamo");
CANONICAL_ALLERGEN_BY_KEY.set("semi sesamo", "Semi di sesamo");
CANONICAL_ALLERGEN_BY_KEY.set("frutta secca", "Frutta a guscio");

export const normalizeAllergenLabel = (value: string) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return CANONICAL_ALLERGEN_BY_KEY.get(normalizeAllergenKey(normalized)) ?? normalized;
};

export const normalizeAllergenList = (values: readonly string[] | null | undefined) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const label = normalizeAllergenLabel(String(value ?? ""));
    if (!label) continue;
    const key = normalizeAllergenKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(label);
  }
  return normalized;
};
