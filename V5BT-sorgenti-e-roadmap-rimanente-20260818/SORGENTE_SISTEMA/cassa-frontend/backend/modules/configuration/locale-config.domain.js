export function createPosLocaleConfigHelpers(options = {}) {
  const {
    normalizeConfigId = (value, fallback = "config") => String(value ?? "").trim() || fallback,
  } = options;

  function sanitizePosLocale(entry) {
    const source = entry && typeof entry === "object" ? entry : {};
    const name = String(source.name ?? source.label ?? source.alias ?? "Locale").trim().slice(0, 80) || "Locale";
    return {
      id: normalizeConfigId(source.id ?? source.localeId, "locale_default"),
      name,
      alias: String(source.alias ?? source.shortName ?? name).trim().slice(0, 80) || name,
      businessName: String(source.businessName ?? source.ragioneSociale ?? source.companyName ?? "").trim().slice(0, 140),
      vatNumber: String(source.vatNumber ?? source.partitaIva ?? source.piva ?? "").trim().slice(0, 32),
      address: String(source.address ?? source.indirizzo ?? "").trim().slice(0, 180),
      sdiCode: String(source.sdiCode ?? source.codiceSdi ?? source.sdi ?? "").trim().slice(0, 16),
      legalRepresentative: String(source.legalRepresentative ?? source.legaleRappresentante ?? "").trim().slice(0, 120),
      status: source.status === "disabled" || source.enabled === false ? "disabled" : "active",
    };
  }

  function sanitizePosLocales(value, primaryLocale) {
    const source = Array.isArray(value) && value.length ? value : [primaryLocale];
    const byId = new Map();
    source.forEach((entry, index) => {
      const locale = sanitizePosLocale(entry ?? (index === 0 ? primaryLocale : null));
      if (!locale?.id) return;
      byId.set(locale.id, locale);
    });
    if (primaryLocale?.id && !byId.has(primaryLocale.id)) {
      byId.set(primaryLocale.id, primaryLocale);
    }
    return [...byId.values()].sort((left, right) => left.alias.localeCompare(right.alias, "it-IT"));
  }

  return {
    sanitizePosLocale,
    sanitizePosLocales,
  };
}
