export function compactPersonName(rawValue, fallback = "Operatore") {
  const parts = String(rawValue ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0];

  const surnameInitial = Array.from(parts.at(-1))[0]?.toUpperCase() || "";
  return surnameInitial ? `${parts[0]} ${surnameInitial}.` : parts[0];
}

export function ownerDisplayLabel(order) {
  const station = String(order?.ownerStation ?? "").trim();
  if (!station) return "-";
  return `${compactPersonName(order?.ownerOperator)} - ${station}`;
}
