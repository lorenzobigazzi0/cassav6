export function createPrecontoBrandingHelpers(options = {}) {
  const {
    centerPrintText = (value) => String(value ?? "").trim(),
    defaultPrintPreferences = {},
    sanitizePosPrintPreferences = (value) => value && typeof value === "object" ? value : {},
    toPrintSafeUppercase = (value) => String(value ?? "").trim().toLocaleUpperCase("it-IT"),
    wrapPrintText = (value) => [String(value ?? "").trim()].filter(Boolean),
  } = options;

  function buildIntegrationPrecontoBrandingHeader(preferences, width) {
    const lines = [];
    const safePreferences = sanitizePosPrintPreferences(preferences ?? defaultPrintPreferences);
    const branding = safePreferences.branding ?? {};
    const preconto = safePreferences.preconto ?? {};
    if (preconto.showVenueName && branding.venueName) {
      lines.push(centerPrintText(toPrintSafeUppercase(branding.venueName), width));
    }
    if (preconto.showAddress && branding.address) {
      wrapPrintText(branding.address, width).forEach((entry) => {
        lines.push(centerPrintText(entry, width));
      });
    }
    if (preconto.showPhone && branding.phone) {
      lines.push(centerPrintText(`TEL ${toPrintSafeUppercase(branding.phone)}`, width));
    }
    return lines.filter(Boolean);
  }

  function buildIntegrationPrecontoBrandingFooter(preferences, width) {
    const lines = [];
    const safePreferences = sanitizePosPrintPreferences(preferences ?? defaultPrintPreferences);
    const branding = safePreferences.branding ?? {};
    const preconto = safePreferences.preconto ?? {};
    if (preconto.showCompanyName && branding.companyName) {
      wrapPrintText(branding.companyName, width).forEach((entry) => {
        lines.push(centerPrintText(entry, width));
      });
    }
    if (preconto.showVatNumber && branding.vatNumber) {
      lines.push(centerPrintText(`P.IVA ${toPrintSafeUppercase(branding.vatNumber)}`, width));
    }
    return lines.filter(Boolean);
  }

  return {
    buildIntegrationPrecontoBrandingFooter,
    buildIntegrationPrecontoBrandingHeader,
  };
}
