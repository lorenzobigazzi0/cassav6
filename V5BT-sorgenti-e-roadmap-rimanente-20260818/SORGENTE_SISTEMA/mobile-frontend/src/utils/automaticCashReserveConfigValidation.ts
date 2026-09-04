import type {
  CashFloatReserveConfigFile,
  CashFloatReserveConfigSummary,
} from "../types/automaticCash";

export type AutomaticCashReserveConfigValidationResult = {
  ok: boolean;
  config: CashFloatReserveConfigFile | null;
  summary: CashFloatReserveConfigSummary | null;
  errors: string[];
  warnings: string[];
};

const ALLOWED_DENOMINATIONS = new Set([2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const toInteger = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const empty = (errors: string[] = []): AutomaticCashReserveConfigValidationResult => ({
  ok: false,
  config: null,
  summary: null,
  errors,
  warnings: [],
});

export function validateAutomaticCashReserveConfigFile(
  value: unknown
): AutomaticCashReserveConfigValidationResult {
  if (!isRecord(value)) {
    return empty(["Il file riserva deve contenere un oggetto JSON."]);
  }

  const errors: string[] = [];
  const config = value as Partial<CashFloatReserveConfigFile>;
  if (config.schema_version !== 1) errors.push("schema_version deve essere 1.");
  if (!String(config.id ?? "").trim()) errors.push("id mancante.");
  if (!String(config.nome ?? "").trim()) errors.push("nome mancante.");
  if (config.valuta !== "EUR") errors.push("valuta deve essere EUR.");
  if (config.enabled !== true) errors.push("La configurazione riserva deve essere abilitata.");
  if (config.missing_denomination_policy !== "reject") {
    errors.push("missing_denomination_policy deve essere reject.");
  }

  const denominations = isRecord(config.denominazioni_centesimi)
    ? config.denominazioni_centesimi
    : {};
  const reserves = isRecord(config.riserva_minima_pezzi)
    ? config.riserva_minima_pezzi
    : {};
  if (Object.keys(denominations).length === 0) {
    errors.push("denominazioni_centesimi non contiene tagli.");
  }
  if (Object.keys(reserves).length === 0) {
    errors.push("riserva_minima_pezzi non contiene tagli.");
  }

  let minimumPiecesTotal = 0;
  Object.entries(denominations).forEach(([label, rawCents]) => {
    const cents = toInteger(rawCents);
    if (!ALLOWED_DENOMINATIONS.has(cents ?? 0)) {
      errors.push(`Taglio non supportato: ${label}/${String(rawCents)}.`);
    }
    const reserve = toInteger(reserves[label]);
    if (reserve === null || reserve < 0) {
      errors.push(`Riserva non valida per ${label}.`);
    } else {
      minimumPiecesTotal += reserve;
    }
  });

  Object.keys(reserves).forEach((label) => {
    if (!(label in denominations)) {
      errors.push(`Riserva senza denominazione: ${label}.`);
    }
  });

  if (errors.length > 0) return empty(errors);

  const normalized = config as CashFloatReserveConfigFile;
  return {
    ok: true,
    config: normalized,
    summary: {
      id: normalized.id.trim(),
      name: normalized.nome.trim(),
      currency: "EUR",
      enabled: true,
      missingDenominationPolicy: "reject",
      denominationsCount: Object.keys(denominations).length,
      minimumPiecesTotal,
    },
    errors: [],
    warnings: [],
  };
}
