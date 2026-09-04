import { normalizeAllergenList } from "../../domain/allergens";

export const sanitizeTableName = (value: string | undefined, fallback: string) => {
  const next = (value ?? "").trim().slice(0, 16);
  return next || fallback;
};

export const sanitizePhone = (value: string | undefined) =>
  (value ?? "").trim().slice(0, 24);

export const sanitizeAllergens = (list: string[] | undefined) => {
  if (!list || list.length === 0) return [];
  return normalizeAllergenList(list).slice(0, 12);
};

export const sanitizeManualIntolerance = (value: string | undefined) =>
  (value ?? "").trim().slice(0, 64);
