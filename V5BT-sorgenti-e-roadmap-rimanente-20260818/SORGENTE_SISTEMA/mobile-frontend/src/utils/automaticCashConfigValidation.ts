import type {
  AutomaticCashCurrency,
  CashFloatCombination,
  CashFloatConfigFile,
  CashFloatConfigSummary,
} from "../types/automaticCash";

export type AutomaticCashConfigValidationResult = {
  ok: boolean;
  config: CashFloatConfigFile | null;
  summary: CashFloatConfigSummary | null;
  errors: string[];
  warnings: string[];
};

const LOW_COMBINATION_WARNING_THRESHOLD = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeName = (config: CashFloatConfigFile) =>
  String(config.nome || config.name || "Configurazione fondo cassa").trim();

const toInteger = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
};

const buildSummaryId = (name: string) =>
  `client_${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "fondo_cassa"}`;

function validateDenominations(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("denominazioni_centesimi deve essere un oggetto.");
    return null;
  }
  const denominations: Record<string, number> = {};
  Object.entries(value).forEach(([label, rawCents]) => {
    const cents = toInteger(rawCents);
    if (cents === null || cents <= 0) {
      errors.push(`Denominazione non valida: ${label}.`);
      return;
    }
    denominations[label] = cents;
  });
  if (Object.keys(denominations).length === 0) {
    errors.push("denominazioni_centesimi non contiene tagli validi.");
  }
  return denominations;
}

function validateCombination(input: {
  combination: CashFloatCombination;
  index: number;
  denominations: Record<string, number>;
  ids: Set<string>;
  totals: number[];
  errors: string[];
}) {
  const { combination, index, denominations, ids, totals, errors } = input;
  const label = combination.id || `#${index + 1}`;
  const id = String(combination.id || "").trim();
  if (!id) {
    errors.push(`Combinazione ${index + 1}: id mancante.`);
  } else if (ids.has(id)) {
    errors.push(`Combinazione duplicata: ${id}.`);
  } else {
    ids.add(id);
  }

  if (!isRecord(combination.tagli)) {
    errors.push(`Combinazione ${label}: tagli mancante o non valido.`);
    return;
  }

  let computedTotalCents = 0;
  let computedPieces = 0;
  Object.entries(combination.tagli).forEach(([denominationLabel, rawQuantity]) => {
    const cents = denominations[denominationLabel];
    if (!Number.isInteger(cents)) {
      errors.push(`Combinazione ${label}: denominazione non riconosciuta ${denominationLabel}.`);
      return;
    }
    const quantity = toInteger(rawQuantity);
    if (quantity === null || quantity < 0) {
      errors.push(`Combinazione ${label}: quantita non valida per ${denominationLabel}.`);
      return;
    }
    computedTotalCents += cents * quantity;
    computedPieces += quantity;
  });

  const declaredTotal = toInteger(combination.totale_centesimi);
  if (declaredTotal === null || declaredTotal <= 0) {
    errors.push(`Combinazione ${label}: totale_centesimi non valido.`);
  } else {
    totals.push(declaredTotal);
    if (computedTotalCents !== declaredTotal) {
      errors.push(
        `Combinazione ${label}: totale calcolato ${computedTotalCents} diverso da ${declaredTotal}.`
      );
    }
  }

  const declaredPieces = toInteger(combination.pezzi_totali ?? combination.totale_pezzi);
  if (declaredPieces === null || declaredPieces < 0) {
    errors.push(`Combinazione ${label}: pezzi_totali non valido.`);
  } else if (computedPieces !== declaredPieces) {
    errors.push(
      `Combinazione ${label}: pezzi calcolati ${computedPieces} diversi da ${declaredPieces}.`
    );
  }
}

export function validateAutomaticCashConfigFile(
  value: unknown
): AutomaticCashConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      config: null,
      summary: null,
      errors: ["Il file deve contenere un oggetto JSON."],
      warnings,
    };
  }

  const config = value as CashFloatConfigFile;
  if (config.valuta !== ("EUR" satisfies AutomaticCashCurrency)) {
    errors.push("valuta deve essere EUR.");
  }
  const denominations = validateDenominations(config.denominazioni_centesimi, errors);
  const combinations = Array.isArray(config.combinazioni) ? config.combinazioni : [];
  if (combinations.length === 0) {
    errors.push("combinazioni deve essere un array non vuoto.");
  }

  const ids = new Set<string>();
  const totals: number[] = [];
  if (denominations) {
    combinations.forEach((combination, index) =>
      validateCombination({
        combination,
        index,
        denominations,
        ids,
        totals,
        errors,
      })
    );
  }

  if (combinations.length > 0 && combinations.length < LOW_COMBINATION_WARNING_THRESHOLD) {
    warnings.push(
      `Il file contiene ${combinations.length} combinazioni: massimo ${combinations.length} operatori unici nella stessa serata prima dell'esaurimento.`
    );
  }

  const minTotalCents = totals.length > 0 ? Math.min(...totals) : 0;
  const maxTotalCents = totals.length > 0 ? Math.max(...totals) : 0;
  const name = normalizeName(config);
  const summary: CashFloatConfigSummary | null =
    errors.length === 0
      ? {
          id: buildSummaryId(name),
          name,
          currency: "EUR",
          combinationsCount: combinations.length,
          minTotalCents,
          maxTotalCents,
          uniquePerUserPerBusinessEvening: true,
        }
      : null;

  return {
    ok: errors.length === 0,
    config: errors.length === 0 ? config : null,
    summary,
    errors,
    warnings,
  };
}
