export const MAX_TABLE_COVERS = 100;

function finiteInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function normalizeTableCovers(value, { minimum = 0, fallback = minimum } = {}) {
  const safeMinimum = Math.max(
    0,
    Math.min(MAX_TABLE_COVERS, finiteInteger(minimum, 0)),
  );
  const safeFallback = Math.max(
    safeMinimum,
    Math.min(MAX_TABLE_COVERS, finiteInteger(fallback, safeMinimum)),
  );
  return Math.max(
    safeMinimum,
    Math.min(MAX_TABLE_COVERS, finiteInteger(value, safeFallback)),
  );
}
