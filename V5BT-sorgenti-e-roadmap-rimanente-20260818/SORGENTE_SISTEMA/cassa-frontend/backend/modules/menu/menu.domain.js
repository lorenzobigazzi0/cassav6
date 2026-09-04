export function createMenuItemDomain({
  enableDemoProducts = false,
  enableMockMenu = false,
  isPremiumAlcoholText = () => false,
  normalizeMenuItemPriceSchedule = () => [],
  nowIso = () => new Date().toISOString(),
  slugifyId = (value, fallback = "item") =>
    String(value ?? "").trim() || fallback,
} = {}) {
  const haccpAllergenOptions = [
    "Glutine",
    "Crostacei",
    "Uova",
    "Pesce",
    "Arachidi",
    "Soia",
    "Latte",
    "Frutta a guscio",
    "Sedano",
    "Senape",
    "Semi di sesamo",
    "Solfiti",
    "Lupini",
    "Molluschi",
  ];
  const normalizeAllergenKey = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const canonicalAllergenByKey = new Map(
    haccpAllergenOptions.map((label) => [normalizeAllergenKey(label), label]),
  );
  canonicalAllergenByKey.set("sesamo", "Semi di sesamo");
  canonicalAllergenByKey.set("semi sesamo", "Semi di sesamo");
  canonicalAllergenByKey.set("frutta secca", "Frutta a guscio");

  function normalizeStringList(value, maxLength = 80) {
    const source = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\n,;]+/)
        : value == null
          ? []
          : [value];
    const seen = new Set();
    const out = [];
    source.forEach((entry) => {
      const text = String(entry ?? "")
        .trim()
        .slice(0, maxLength);
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function normalizeAllergenList(value, maxLength = 80) {
    const seen = new Set();
    const normalized = [];
    for (const entry of normalizeStringList(value, maxLength)) {
      const canonical =
        canonicalAllergenByKey.get(normalizeAllergenKey(entry)) ?? entry;
      const key = normalizeAllergenKey(canonical);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      normalized.push(canonical);
    }
    return normalized;
  }

  function normalizeVatRate(value) {
    const parsed = Number(String(value ?? "").replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.min(Math.round(parsed * 100) / 100, 100);
  }

  function normalizeProductPriceListPrices(value) {
    const source = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.entries(value).map(([priceListId, price]) => ({
            priceListId,
            price,
          }))
        : [];
    return source
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") return null;
        const priceListId = String(
          entry.priceListId ?? entry.listinoId ?? entry.id ?? "",
        ).trim();
        const parsedPrice = Number(
          String(entry.price ?? entry.value ?? entry.amount ?? "").replace(
            ",",
            ".",
          ),
        );
        if (!priceListId || !Number.isFinite(parsedPrice) || parsedPrice < 0)
          return null;
        return {
          id:
            String(entry.id ?? `${priceListId}_${index + 1}`)
              .trim()
              .slice(0, 80) || `${priceListId}_${index + 1}`,
          priceListId,
          price: Math.round(parsedPrice * 100) / 100,
          enabled: entry.enabled !== false,
        };
      })
      .filter(Boolean);
  }

  function normalizeMenuItemVariants(variants) {
    if (!Array.isArray(variants)) return [];
    const seen = new Set();
    const normalized = [];
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      if (!variant || typeof variant !== "object") continue;
      const name = String(variant.name ?? variant.label ?? "")
        .trim()
        .slice(0, 80);
      if (!name) continue;
      const nameKey = name.toLowerCase();
      if (seen.has(nameKey)) continue;
      seen.add(nameKey);
      const rawId = String(variant.id ?? variant.value ?? "").trim();
      const id = (rawId || `${slugifyId(name, "variant")}_${index + 1}`).slice(
        0,
        80,
      );
      const priceDelta = Number(
        variant.priceDelta ?? variant.delta ?? variant.price ?? 0,
      );
      const available =
        variant.enabled !== false && variant.available !== false;
      normalized.push({
        id,
        name,
        priceDelta: Number.isFinite(priceDelta)
          ? Math.round(priceDelta * 100) / 100
          : 0,
        ...(available ? {} : { enabled: false, available: false }),
      });
    }
    return normalized;
  }

  function isMockOrDemoMenuItem(item) {
    const source = String(
      item?.source ?? item?.menuSource ?? item?.catalogSource ?? "",
    )
      .trim()
      .toLowerCase();
    if (!source) return false;
    return source === "mock" || source === "demo" || source === "sample";
  }

  function shouldExposeMenuItemInRuntime(item) {
    if (!isMockOrDemoMenuItem(item)) return true;
    return enableMockMenu || enableDemoProducts;
  }

  function isPremiumAlcoholMenuItem(item) {
    return (
      item?.isPremiumAlcohol === true ||
      isPremiumAlcoholText(item?.name, item?.category)
    );
  }

  function menuItemRequiresVariantSelection(item) {
    const variants = normalizeMenuItemVariants(item?.variants);
    if (variants.length === 0) return false;
    return (
      item?.variantRequired === true ||
      item?.requiresVariant === true ||
      item?.requiresVariantSelection === true ||
      isPremiumAlcoholMenuItem(item)
    );
  }

  function normalizeMenuItemIngredients(ingredients) {
    if (Array.isArray(ingredients)) {
      return ingredients
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean);
    }
    const text = typeof ingredients === "string" ? ingredients : "";
    return text.trim() ? [text] : [];
  }

  function resolveMenuItemDescription(item) {
    const description = item?.description ?? item?.desc;
    return typeof description === "string" && description.trim()
      ? description
      : "";
  }

  function resolveMenuItemDepartment(item) {
    return String(item?.department ?? item?.reparto ?? "").trim();
  }

  function resolveMenuItemReparto(item) {
    return String(item?.reparto ?? item?.department ?? "").trim();
  }

  function sanitizeMenuItem(item) {
    const section = String(item.section ?? item.subcategory ?? "").trim();
    const itemType = String(item.type ?? item.kind ?? "")
      .trim()
      .toLowerCase();
    const variants = normalizeMenuItemVariants(item.variants);
    const variantRequired = menuItemRequiresVariantSelection(item);
    const source = String(
      item.source ?? item.menuSource ?? item.catalogSource ?? "",
    )
      .trim()
      .slice(0, 32);
    const premiumAlcohol = isPremiumAlcoholMenuItem(item);
    const description = resolveMenuItemDescription(item);
    const ingredients = normalizeMenuItemIngredients(
      item.ingredients ?? item.ingredienti,
    );
    const department = resolveMenuItemDepartment(item);
    const reparto = resolveMenuItemReparto(item);
    const priceSchedule = normalizeMenuItemPriceSchedule(
      item.priceSchedule ??
        item.timedPrices ??
        item.timePriceSchedule ??
        item.listinoTemporizzato,
    );
    const vatRate = normalizeVatRate(item.vatRate ?? item.iva ?? item.taxRate);
    const vatCode = String(item.vatCode ?? item.ivaCode ?? item.taxCode ?? "")
      .trim()
      .slice(0, 32);
    const priceListPrices = normalizeProductPriceListPrices(
      item.priceListPrices ?? item.listinoPrices,
    );
    const workstationIds = normalizeStringList(item.workstationIds, 80);
    const stationIds = normalizeStringList(
      item.stationIds ?? item.stations,
      80,
    );
    const menuIds = normalizeStringList(item.menuIds, 80);
    const categoryIds = normalizeStringList(item.categoryIds, 80);
    const allergens = normalizeAllergenList(
      item.allergens ?? item.allergeni,
      80,
    );
    const tags = normalizeStringList(item.tags, 80);
    const sku = String(item.sku ?? item.code ?? "")
      .trim()
      .slice(0, 80);
    const barcode = String(item.barcode ?? item.ean ?? "")
      .trim()
      .slice(0, 80);
    const unit = String(item.unit ?? item.um ?? "")
      .trim()
      .slice(0, 32);
    return {
      id: item.id,
      name: item.name,
      price: Number(item.price),
      category: item.category,
      enabled: item.enabled !== false,
      imageUrl:
        typeof item.imageUrl === "string" && item.imageUrl.trim()
          ? item.imageUrl.trim()
          : null,
      ...(description ? { description } : {}),
      ...(ingredients.length ? { ingredients } : {}),
      ...(department ? { department } : {}),
      ...(reparto ? { reparto } : {}),
      ...(variants.length ? { variants } : {}),
      ...(variantRequired
        ? {
            variantRequired: true,
            requiresVariant: true,
            requiresVariantSelection: true,
          }
        : {}),
      ...(premiumAlcohol ? { isPremiumAlcohol: true } : {}),
      ...(source ? { source } : {}),
      ...(section ? { section } : {}),
      ...(itemType === "divider" ? { type: "divider" } : {}),
      ...(priceSchedule.length ? { priceSchedule } : {}),
      ...(vatRate !== null ? { vatRate, iva: vatRate, taxRate: vatRate } : {}),
      ...(vatCode ? { vatCode } : {}),
      ...(priceListPrices.length ? { priceListPrices } : {}),
      ...(workstationIds.length ? { workstationIds } : {}),
      ...(stationIds.length ? { stationIds, stations: stationIds } : {}),
      ...(menuIds.length ? { menuIds } : {}),
      ...(categoryIds.length ? { categoryIds } : {}),
      ...(allergens.length ? { allergens } : {}),
      ...(tags.length ? { tags } : {}),
      ...(sku ? { sku } : {}),
      ...(barcode ? { barcode } : {}),
      ...(unit ? { unit } : {}),
    };
  }

  function normalizeMenuItem(item, fallbackId) {
    const now = nowIso();
    const parsedPrice = Number(item.price);
    const section = String(item.section ?? item.subcategory ?? "")
      .trim()
      .slice(0, 48);
    const itemType =
      String(item.type ?? item.kind ?? "")
        .trim()
        .toLowerCase() === "divider"
        ? "divider"
        : "product";
    const variants = normalizeMenuItemVariants(item.variants);
    const variantRequired = menuItemRequiresVariantSelection(item);
    const source = String(
      item.source ?? item.menuSource ?? item.catalogSource ?? "",
    )
      .trim()
      .slice(0, 32);
    const premiumAlcohol = isPremiumAlcoholMenuItem(item);
    const description = resolveMenuItemDescription(item);
    const ingredients = normalizeMenuItemIngredients(
      item.ingredients ?? item.ingredienti,
    );
    const department = resolveMenuItemDepartment(item);
    const reparto = resolveMenuItemReparto(item);
    const priceSchedule = normalizeMenuItemPriceSchedule(
      item.priceSchedule ??
        item.timedPrices ??
        item.timePriceSchedule ??
        item.listinoTemporizzato,
    );
    const vatRate = normalizeVatRate(item.vatRate ?? item.iva ?? item.taxRate);
    const vatCode = String(item.vatCode ?? item.ivaCode ?? item.taxCode ?? "")
      .trim()
      .slice(0, 32);
    const priceListPrices = normalizeProductPriceListPrices(
      item.priceListPrices ?? item.listinoPrices,
    );
    const workstationIds = normalizeStringList(item.workstationIds, 80);
    const stationIds = normalizeStringList(
      item.stationIds ?? item.stations,
      80,
    );
    const menuIds = normalizeStringList(item.menuIds, 80);
    const categoryIds = normalizeStringList(item.categoryIds, 80);
    const allergens = normalizeAllergenList(
      item.allergens ?? item.allergeni,
      80,
    );
    const tags = normalizeStringList(item.tags, 80);
    const sku = String(item.sku ?? item.code ?? "")
      .trim()
      .slice(0, 80);
    const barcode = String(item.barcode ?? item.ean ?? "")
      .trim()
      .slice(0, 80);
    const unit = String(item.unit ?? item.um ?? "")
      .trim()
      .slice(0, 32);
    return {
      id: String(item.id ?? fallbackId),
      name: String(item.name ?? "Articolo").trim() || "Articolo",
      price: Number.isFinite(parsedPrice)
        ? Math.max(Math.round(parsedPrice * 100) / 100, 0)
        : 0,
      category: String(item.category ?? "Altro").trim() || "Altro",
      enabled: item.enabled !== false,
      imageUrl:
        typeof item.imageUrl === "string" && item.imageUrl.trim()
          ? item.imageUrl.trim()
          : null,
      ...(description ? { description } : {}),
      ...(ingredients.length ? { ingredients } : {}),
      ...(department ? { department } : {}),
      ...(reparto ? { reparto } : {}),
      ...(variants.length ? { variants } : {}),
      ...(variantRequired
        ? { variantRequired: true, requiresVariantSelection: true }
        : {}),
      ...(premiumAlcohol ? { isPremiumAlcohol: true } : {}),
      ...(source ? { source } : {}),
      ...(section ? { section } : {}),
      ...(itemType === "divider" ? { type: "divider" } : {}),
      ...(priceSchedule.length ? { priceSchedule } : {}),
      ...(vatRate !== null ? { vatRate, iva: vatRate, taxRate: vatRate } : {}),
      ...(vatCode ? { vatCode } : {}),
      ...(priceListPrices.length ? { priceListPrices } : {}),
      ...(workstationIds.length ? { workstationIds } : {}),
      ...(stationIds.length ? { stationIds, stations: stationIds } : {}),
      ...(menuIds.length ? { menuIds } : {}),
      ...(categoryIds.length ? { categoryIds } : {}),
      ...(allergens.length ? { allergens } : {}),
      ...(tags.length ? { tags } : {}),
      ...(sku ? { sku } : {}),
      ...(barcode ? { barcode } : {}),
      ...(unit ? { unit } : {}),
      createdByUserId: String(item.createdByUserId ?? "system"),
      createdAt: String(item.createdAt ?? now),
      updatedAt: String(item.updatedAt ?? now),
    };
  }

  return {
    isMockOrDemoMenuItem,
    isPremiumAlcoholMenuItem,
    menuItemRequiresVariantSelection,
    normalizeMenuItem,
    normalizeMenuItemIngredients,
    normalizeMenuItemVariants,
    resolveMenuItemDepartment,
    resolveMenuItemDescription,
    resolveMenuItemReparto,
    sanitizeMenuItem,
    shouldExposeMenuItemInRuntime,
  };
}
