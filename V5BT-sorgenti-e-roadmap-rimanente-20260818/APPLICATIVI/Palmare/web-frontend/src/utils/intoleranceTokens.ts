import { normalizeAllergenLabel } from "../domain/allergens";

export type IntoleranceTokenSource = string | readonly string[] | null | undefined;

export const parseIntoleranceTokens = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[,\n;]+/)
        .map((entry) => normalizeAllergenLabel(entry))
        .filter(Boolean)
    )
  );

export const composeIntoleranceTokens = (tokens: readonly string[]) =>
  Array.from(new Set(tokens.map((entry) => normalizeAllergenLabel(entry)).filter(Boolean))).join(
    ", "
  );

export const collectIntoleranceTokens = (...sources: IntoleranceTokenSource[]) =>
  Array.from(
    new Set(
      sources.flatMap((source) => {
        if (!source) return [];
        if (typeof source === "string") {
          return parseIntoleranceTokens(source);
        }
        return source.flatMap((entry) => parseIntoleranceTokens(String(entry ?? "")));
      })
    )
  );
