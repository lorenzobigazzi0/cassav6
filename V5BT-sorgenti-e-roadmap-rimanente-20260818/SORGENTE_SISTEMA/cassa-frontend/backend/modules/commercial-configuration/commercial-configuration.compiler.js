import { COMMERCIAL_SCOPE_SPECIFICITY } from "./constants.js";
import { normalizeCommercialConfiguration } from "./commercial-configuration.normalization.js";
import { sha256, stableStringify } from "./commercial-configuration.utils.js";
import { validateCommercialConfiguration } from "./commercial-configuration.validation.js";

function buildObjectById(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry]));
}

function resolveEffectivePriceListEntries(listId, listsById, memo, visiting) {
  if (memo[listId]) return memo[listId];
  if (visiting.has(listId)) return {};
  visiting.add(listId);
  const list = listsById[listId];
  const inherited = list?.inheritsFromId
    ? resolveEffectivePriceListEntries(list.inheritsFromId, listsById, memo, visiting)
    : {};
  const effective = { ...inherited };
  for (const entry of Array.isArray(list?.entries) ? list.entries : []) {
    if (entry.enabled === false) continue;
    effective[`${entry.sellableType}:${entry.sellableId}`] = entry;
  }
  visiting.delete(listId);
  memo[listId] = effective;
  return effective;
}

function buildNameIndex(entries) {
  const index = {};
  for (const entry of entries) {
    const key = String(entry.name ?? "").trim().toLocaleLowerCase("it-IT");
    if (!key) continue;
    if (!index[key]) index[key] = [];
    index[key].push(entry.id);
  }
  return index;
}

export function compileCommercialConfiguration(input, options = {}) {
  const validation = validateCommercialConfiguration(input, options);
  if (!validation.ok && options.allowInvalid !== true) {
    const error = new Error("Configurazione commerciale non valida.");
    error.code = "COMMERCIAL_CONFIGURATION_INVALID";
    error.validation = validation;
    throw error;
  }
  const config = normalizeCommercialConfiguration(validation.configuration);
  const productsById = buildObjectById(config.products);
  const offersById = buildObjectById(config.offers);
  const catalogsById = buildObjectById(config.catalogs);
  const priceListsById = buildObjectById(config.priceLists);
  const directPriceListEntries = {};
  const effectivePriceListEntries = {};
  for (const list of config.priceLists) {
    directPriceListEntries[list.id] = Object.fromEntries(
      (Array.isArray(list.entries) ? list.entries : [])
        .filter((entry) => entry.enabled !== false)
        .map((entry) => [`${entry.sellableType}:${entry.sellableId}`, entry]),
    );
    effectivePriceListEntries[list.id] = resolveEffectivePriceListEntries(
      list.id,
      priceListsById,
      effectivePriceListEntries,
      new Set(),
    );
  }
  const assignments = config.assignments
    .map((entry) => ({
      ...entry,
      specificity: COMMERCIAL_SCOPE_SPECIFICITY[entry.scopeType] ?? 0,
    }))
    .sort((left, right) =>
      left.specificity - right.specificity ||
      left.priority - right.priority ||
      left.id.localeCompare(right.id),
    );
  const compiledAt = options.compiledAt ?? new Date().toISOString();
  const sourceChecksum = sha256(config);
  const compiled = {
    schemaVersion: config.schemaVersion,
    sourceChecksum,
    compiledAt,
    configurationId: config.id,
    configurationName: config.name,
    currency: config.currency,
    settings: config.settings,
    productsById,
    productNameIndex: buildNameIndex(config.products),
    offersById,
    offerNameIndex: buildNameIndex(config.offers),
    catalogsById,
    priceListsById,
    directPriceListEntries,
    effectivePriceListEntries,
    assignments,
    validation: {
      warnings: validation.warnings,
      summary: validation.summary,
    },
  };
  return {
    configuration: config,
    compiled,
    checksum: sha256(stableStringify(compiled)),
    validation,
  };
}
