const normalizeLabel = (value: string) =>
  value
    .replace(/\u00C2\u00B7/g, "\u00B7")
    .replace(/\u00C3\u201A\u00B7/g, "\u00B7")
    .replace(/\u00C2(?=\s*[\u00B7\u2022|,])/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function splitMenuStationLabel(value: string) {
  const normalized = normalizeLabel(value);
  if (!normalized) return null;

  const parts = normalized.split(/\s*(?:\u00B7|\u2022|\||,)\s*/).filter(Boolean);
  if (parts.length < 2) return null;

  const badgeLabel = normalizeLabel(parts.shift() ?? "").toLocaleUpperCase("it-IT");
  const mainLabel = normalizeLabel(parts.join(" \u00B7 "));
  if (!badgeLabel || !mainLabel) return null;

  return { fullLabel: normalized, badgeLabel, mainLabel };
}
