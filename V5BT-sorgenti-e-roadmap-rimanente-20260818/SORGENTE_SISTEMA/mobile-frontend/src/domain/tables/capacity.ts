export const MIN_TABLE_COVERS = 1;
export const MAX_TABLE_COVERS = 100;

type NormalizeTableCoversOptions = {
  minimum?: number;
  fallback?: number;
};

const finiteRoundedInteger = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

export function normalizeTableCovers(
  value: unknown,
  options: NormalizeTableCoversOptions = {}
) {
  const minimum = Math.max(
    0,
    Math.min(MAX_TABLE_COVERS, finiteRoundedInteger(options.minimum, MIN_TABLE_COVERS))
  );
  const fallback = Math.max(
    minimum,
    Math.min(MAX_TABLE_COVERS, finiteRoundedInteger(options.fallback, minimum))
  );
  return Math.max(
    minimum,
    Math.min(MAX_TABLE_COVERS, finiteRoundedInteger(value, fallback))
  );
}
