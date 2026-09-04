import { readFileSync } from "node:fs";

function readJsonFile(relativeUrl, label) {
  try {
    return JSON.parse(
      readFileSync(new URL(relativeUrl, import.meta.url), "utf-8"),
    );
  } catch (error) {
    throw new Error(`Impossibile caricare ${label}: ${error.message}`, {
      cause: error,
    });
  }
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} mancante.`);
  }
  return normalized;
}

function validateVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error(
      "Il catalogo Drink Premium deve definire almeno una variante.",
    );
  }

  const ids = new Set();
  return variants.map((variant, index) => {
    const id = requiredText(
      variant?.id,
      `ID variante Drink Premium #${index + 1}`,
    );
    const name = requiredText(
      variant?.name,
      `Nome variante Drink Premium #${index + 1}`,
    );
    const priceDelta = Number(variant?.priceDelta);
    if (!Number.isFinite(priceDelta)) {
      throw new Error(
        `Variazione prezzo non valida per la variante "${name}".`,
      );
    }
    if (ids.has(id)) {
      throw new Error(`ID variante Drink Premium duplicato: ${id}.`);
    }
    ids.add(id);
    return { id, name, priceDelta };
  });
}

export function buildDrinkPremiumItems(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Configurazione Drink Premium non valida.");
  }

  const category = requiredText(config.category, "Categoria Drink Premium");
  const defaults =
    config.defaults && typeof config.defaults === "object"
      ? config.defaults
      : {};
  const variants = validateVariants(defaults.variants);
  const sections = Array.isArray(config.sections) ? config.sections : [];
  if (sections.length === 0) {
    throw new Error("Il catalogo Drink Premium non contiene sezioni.");
  }

  const sectionNames = new Set();
  const itemIds = new Set();
  const itemNames = new Set();
  const items = [];

  sections.forEach((section, sectionIndex) => {
    const sectionName = requiredText(
      section?.name,
      `Nome sezione Drink Premium #${sectionIndex + 1}`,
    );
    const sectionKey = sectionName.toLocaleLowerCase("it-IT");
    if (sectionNames.has(sectionKey)) {
      throw new Error(`Sezione Drink Premium duplicata: ${sectionName}.`);
    }
    sectionNames.add(sectionKey);
    const sectionCategory = requiredText(
      section?.category ?? category,
      `Categoria della sezione Drink Premium "${sectionName}"`,
    );

    if (!Array.isArray(section?.items) || section.items.length === 0) {
      throw new Error(
        `La sezione Drink Premium "${sectionName}" non contiene articoli.`,
      );
    }

    section.items.forEach((item, itemIndex) => {
      const itemLabel = `articolo #${itemIndex + 1} della sezione "${sectionName}"`;
      const id = requiredText(item?.id, `ID ${itemLabel}`);
      const name = requiredText(item?.name, `Nome ${itemLabel}`);
      const price = Number(item?.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          `Prezzo non valido per l'articolo Drink Premium "${name}".`,
        );
      }

      const nameKey = name.toLocaleLowerCase("it-IT");
      if (itemIds.has(id)) {
        throw new Error(`ID articolo Drink Premium duplicato: ${id}.`);
      }
      if (itemNames.has(nameKey)) {
        throw new Error(`Nome articolo Drink Premium duplicato: ${name}.`);
      }
      itemIds.add(id);
      itemNames.add(nameKey);

      items.push({
        ...defaults,
        ...item,
        id,
        name,
        price,
        category: sectionCategory,
        section: sectionName,
        variants: variants.map((variant) => ({ ...variant })),
      });
    });
  });

  return items;
}

export function replaceMenuCategoryItems(
  baseItems,
  replacementItems,
  category,
) {
  if (!Array.isArray(baseItems)) {
    throw new Error("Catalogo menu di base non valido.");
  }
  if (!Array.isArray(replacementItems) || replacementItems.length === 0) {
    throw new Error(`Catalogo sostitutivo "${category}" non valido o vuoto.`);
  }

  const categoryName = requiredText(category, "Categoria da sostituire");
  const replacementIds = new Set(
    replacementItems.map((item, index) =>
      requiredText(item?.id, `ID articolo sostitutivo #${index + 1}`),
    ),
  );
  const isManagedItem = (item) =>
    String(item?.category ?? "").trim() === categoryName ||
    replacementIds.has(String(item?.id ?? "").trim());
  const firstManagedIndex = baseItems.findIndex(isManagedItem);
  const insertionIndex =
    firstManagedIndex < 0
      ? baseItems.length
      : baseItems
          .slice(0, firstManagedIndex)
          .filter((item) => !isManagedItem(item)).length;
  const withoutCategory = baseItems.filter((item) => !isManagedItem(item));
  const merged = [
    ...withoutCategory.slice(0, insertionIndex),
    ...replacementItems,
    ...withoutCategory.slice(insertionIndex),
  ];

  const ids = new Set();
  merged.forEach((item, index) => {
    const id = requiredText(item?.id, `ID articolo menu #${index + 1}`);
    if (ids.has(id)) {
      throw new Error(`ID articolo menu duplicato dopo la fusione: ${id}.`);
    }
    ids.add(id);
  });

  return merged;
}

const BASE_DEFAULT_MENU_ITEMS = readJsonFile(
  "../../default-menu-items.json",
  "il menu di default",
);
export const DEFAULT_DRINK_PREMIUM_CONFIG = readJsonFile(
  "../../default-drink-premium-items.json",
  "il catalogo Drink Premium",
);
export const DEFAULT_DRINK_PREMIUM_ITEMS = buildDrinkPremiumItems(
  DEFAULT_DRINK_PREMIUM_CONFIG,
);
export const DEFAULT_MENU_ITEMS = replaceMenuCategoryItems(
  BASE_DEFAULT_MENU_ITEMS,
  DEFAULT_DRINK_PREMIUM_ITEMS,
  DEFAULT_DRINK_PREMIUM_CONFIG.category,
);
