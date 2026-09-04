import {
  createAutomaticCashConfigSet,
  createAutomaticCashReserveConfigSet,
  sanitizeAutomaticCashSettings,
} from "./automatic-cash.domain.js";

function buildAutomaticCashSimulatorReserveConfig() {
  return {
    schema_version: 1,
    id: "reserve-simulatore-v1",
    nome: "Riserva simulatore cassa automatica",
    valuta: "EUR",
    enabled: true,
    missing_denomination_policy: "reject",
    denominazioni_centesimi: {
      "20_euro": 2000,
      "10_euro": 1000,
      "5_euro": 500,
      "2_euro": 200,
      "1_euro": 100,
      "50_cent": 50,
      "20_cent": 20,
      "10_cent": 10,
      "5_cent": 5,
      "2_cent": 2,
      "1_cent": 1,
    },
    riserva_minima_pezzi: {
      "20_euro": 1,
      "10_euro": 1,
      "5_euro": 1,
      "2_euro": 1,
      "1_euro": 1,
      "50_cent": 1,
      "20_cent": 1,
      "10_cent": 1,
      "5_cent": 1,
      "2_cent": 0,
      "1_cent": 0,
    },
  };
}

export async function loadAutomaticCashSimulatorRuntimeDefaults(options = {}) {
  const {
    configPath,
    enabled = false,
    fs,
    logger = console,
    nowIso,
    path,
  } = options;

  if (!enabled) return null;
  try {
    const config = JSON.parse(await fs.readFile(path.resolve(configPath), "utf8"));
    const uploadedAt = nowIso();
    const uploadedBy = "simulatore-cassa-automatica";
    const { validation: configValidation, configSet } =
      createAutomaticCashConfigSet({
        config,
        uploadedAt,
        uploadedBy,
      });
    if (!configValidation.ok || !configSet) {
      throw new Error(configValidation.errors.join("; "));
    }

    const { validation: reserveValidation, reserveConfig } =
      createAutomaticCashReserveConfigSet({
        config: buildAutomaticCashSimulatorReserveConfig(),
        uploadedAt,
        uploadedBy,
      });
    if (!reserveValidation.ok || !reserveConfig) {
      throw new Error(reserveValidation.errors.join("; "));
    }

    logger.log?.(
      `[automatic-cash] seed simulatore attivo: ${configSet.combinationsCount} combinazioni, riserva ${reserveConfig.id}`,
    );
    return sanitizeAutomaticCashSettings({
      enabled: true,
      gatewayConfigured: true,
      feedbackEnabled: true,
      warningThresholdCents: 1000,
      dangerThresholdCents: 1000,
      autoCashFloatMode: "random_file",
      configSetId: configSet.id,
      configSet,
      configSets: [configSet],
      reserveConfigId: reserveConfig.id,
      reserveConfig,
      reserveConfigs: [reserveConfig],
    });
  } catch (error) {
    logger.warn?.(
      `[automatic-cash] seed simulatore non caricato: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
