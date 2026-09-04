import { sleep } from "../utils/sleep";
import { apiFetch } from "./baseUrl";
import { getRuntimeConfig } from "../config/runtimeConfig";
import {
  normalizeProductPricing,
  parseOptionalMoney,
  parseTimedPriceSchedule,
  type ProductPricingMeta,
  type ProductTimedPriceRange,
} from "../shared/pricing/productPricing";
import { dedupeMenuCatalogProducts } from "./menuDedupe";
import { normalizeAllergenList } from "../domain/allergens";
import { resolveOfflineConfigurationScope } from "./offlineConfigurationScope";
import { readOfflineMenu, recordOfflineMenu } from "../domain/offlineConfiguration/repository";
import type {
  MenuCatalog,
  MenuCatalogPatch,
  MenuCatalogSnapshot,
  MenuCatalogUpdates,
  MenuCategory,
  MenuDepartment,
  MenuProduct,
  MenuProductVariant,
  MenuSessionRequest,
} from "./menuTypes";

export type {
  MenuCatalog,
  MenuCatalogPatch,
  MenuCatalogSnapshot,
  MenuCatalogUpdates,
  MenuCategory,
  MenuDepartment,
  MenuProduct,
  MenuProductVariant,
  MenuSessionRequest,
} from "./menuTypes";

export const menuCatalogQueryKey = (roomId: string) => ["menu-catalog", roomId] as const;

const DEPARTMENTS: MenuDepartment[] = [
  { id: "dept_drinks", name: "Bevande e Drink" },
  { id: "dept_food", name: "Ristorazione" },
  { id: "dept_bar", name: "Bar" },
];

const CATEGORIES: MenuCategory[] = [
  { id: "cat_coffee", departmentId: "dept_drinks", name: "Caffetteria" },
  { id: "cat_juices", departmentId: "dept_drinks", name: "Succhi di frutta" },
  { id: "cat_bibite", departmentId: "dept_drinks", name: "Bibite" },
  { id: "cat_wine", departmentId: "dept_drinks", name: "Vino" },
  { id: "cat_soft_drink", departmentId: "dept_drinks", name: "Soft Drink" },
  { id: "cat_alcolici", departmentId: "dept_drinks", name: "Alcolici" },
  { id: "cat_alcolici_premium", departmentId: "dept_drinks", name: "Alcolici Premium" },
  { id: "cat_whisky_rum", departmentId: "dept_drinks", name: "Wisky e Rum" },
  { id: "cat_amari", departmentId: "dept_drinks", name: "Amari" },
  { id: "cat_beers", departmentId: "dept_drinks", name: "Birre" },
  { id: "cat_antipasti", departmentId: "dept_food", name: "Antipasti" },
  { id: "cat_pinze", departmentId: "dept_food", name: "Pinze" },
  { id: "cat_taglieri", departmentId: "dept_food", name: "Taglieri" },
  { id: "cat_sfiziosita", departmentId: "dept_food", name: "Sfiziosita" },
  { id: "cat_dolci", departmentId: "dept_food", name: "Dolci" },
  { id: "cat_menu_fissi", departmentId: "dept_food", name: "Menu Fissi" },
  { id: "cat_pasticceria", departmentId: "dept_bar", name: "Pasticceria" },
  { id: "cat_panini_salati", departmentId: "dept_bar", name: "Panini e Salati" },
  { id: "cat_patatine", departmentId: "dept_bar", name: "Patatine" },
  { id: "cat_gelati", departmentId: "dept_bar", name: "Gelati" },
  { id: "cat_caramelle", departmentId: "dept_bar", name: "Caramelle e Gomme" },
];

type ProductSeed = {
  categoryId: string;
  name: string;
  price: number;
  available?: boolean;
  isFrozen?: boolean;
  allergens?: string[];
  ingredients?: string[];
  variants?: MenuProductVariant[];
  description?: string;
  sku?: string;
};

const v = (id: string, name: string, priceDelta: number): MenuProductVariant => ({
  id,
  name,
  priceDelta,
});

const normalizePricingText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const normalizePricingMeta = (value: unknown): ProductPricingMeta | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : null;

const normalizeVatRate = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? Math.round(parsed * 1000) / 1000
    : null;
};

const normalizeVatCode = (value: unknown): string | null => String(value ?? "").trim() || null;

const PRODUCT_SEEDS: ProductSeed[] = [
  {
    categoryId: "cat_coffee",
    name: "Espresso",
    price: 1.3,
    ingredients: ["Miscela 100% Arabica"],
    description: "Caffe espresso estrazione rapida.",
  },
  {
    categoryId: "cat_coffee",
    name: "Cappuccino",
    price: 2.2,
    allergens: ["latte"],
    ingredients: ["Espresso", "Latte fresco"],
    description: "Espresso con crema di latte.",
  },
  {
    categoryId: "cat_juices",
    name: "Succo Arancia",
    price: 3.2,
    ingredients: ["Succo di arancia 100%"],
    description: "Succo fresco di arancia senza zuccheri aggiunti.",
  },
  {
    categoryId: "cat_juices",
    name: "Succo Ananas",
    price: 3.2,
    ingredients: ["Succo di ananas"],
    description: "Succo tropicale servito freddo.",
  },
  {
    categoryId: "cat_bibite",
    name: "Cola Classica",
    price: 3.5,
    ingredients: ["Acqua", "Estratti naturali", "Zucchero"],
    description: "Bibita gassata classica in bottiglia.",
  },
  {
    categoryId: "cat_bibite",
    name: "Aranciata",
    price: 3.4,
    ingredients: ["Acqua", "Succo d'arancia", "Anidride carbonica"],
    description: "Bibita gassata all'arancia.",
  },
  {
    categoryId: "cat_wine",
    name: "Chianti DOCG",
    price: 6.5,
    allergens: ["solfiti"],
    ingredients: ["Uve Sangiovese"],
    description: "Calice di vino rosso toscano.",
    variants: [v("vin_1", "Calice", 0), v("vin_2", "Bottiglia", 18)],
  },
  {
    categoryId: "cat_wine",
    name: "Prosecco Brut",
    price: 6,
    allergens: ["solfiti"],
    ingredients: ["Uve Glera"],
    description: "Calice di prosecco brut.",
    variants: [v("vin_3", "Calice", 0), v("vin_4", "Bottiglia", 20)],
  },
  {
    categoryId: "cat_soft_drink",
    name: "Acqua Naturale 0.5L",
    price: 1.8,
    ingredients: ["Acqua minerale naturale"],
    description: "Bottiglia acqua naturale 0.5L.",
  },
  {
    categoryId: "cat_soft_drink",
    name: "Acqua Frizzante 0.5L",
    price: 1.8,
    ingredients: ["Acqua minerale frizzante"],
    description: "Bottiglia acqua frizzante 0.5L.",
  },
  {
    categoryId: "cat_alcolici",
    name: "Gin Tonic",
    price: 8,
    description: "Drink classico con gin e tonica.",
    ingredients: ["Gin", "Acqua tonica", "Lime"],
    variants: [v("alk_1", "Gin standard", 0), v("alk_2", "Gin premium", 2.5)],
  },
  {
    categoryId: "cat_alcolici",
    name: "Moscow Mule",
    price: 8.5,
    description: "Vodka, ginger beer e lime.",
    ingredients: ["Vodka", "Ginger beer", "Lime"],
  },
  {
    categoryId: "cat_alcolici_premium",
    name: "Negroni Premium",
    price: 11,
    description: "Versione premium del classico Negroni.",
    ingredients: ["Gin premium", "Vermouth", "Bitter"],
    variants: [v("prm_1", "Classico", 0), v("prm_2", "Barrel aged", 3)],
  },
  {
    categoryId: "cat_alcolici_premium",
    name: "Vodka Riserva",
    price: 10.5,
    available: false,
    description: "Servita liscia o on the rocks.",
    ingredients: ["Vodka riserva"],
  },
  {
    categoryId: "cat_whisky_rum",
    name: "Whisky 12 Anni",
    price: 9.5,
    description: "Single malt 12 anni.",
    ingredients: ["Distillato di cereali"],
  },
  {
    categoryId: "cat_whisky_rum",
    name: "Rum Riserva",
    price: 10,
    description: "Rum scuro invecchiato.",
    ingredients: ["Distillato di canna da zucchero"],
  },
  {
    categoryId: "cat_amari",
    name: "Amaro Classico",
    price: 4.5,
    description: "Digestivo alle erbe.",
    ingredients: ["Infuso di erbe aromatiche"],
  },
  {
    categoryId: "cat_amari",
    name: "Limoncello",
    price: 4.2,
    description: "Liquore al limone servito freddo.",
    ingredients: ["Infuso di scorze di limone"],
    isFrozen: true,
  },
  {
    categoryId: "cat_beers",
    name: "Birra Lager",
    price: 5,
    description: "Lager chiara a bassa fermentazione.",
    ingredients: ["Acqua", "Malto d'orzo", "Luppolo"],
    allergens: ["glutine"],
    variants: [v("bir_1", "0.33L", 0), v("bir_2", "0.5L", 1.4)],
  },
  {
    categoryId: "cat_beers",
    name: "Birra IPA",
    price: 6,
    description: "IPA aromatica con note agrumate.",
    ingredients: ["Acqua", "Malto d'orzo", "Luppolo"],
    allergens: ["glutine"],
    variants: [v("bir_3", "0.33L", 0), v("bir_4", "0.5L", 1.6)],
  },
  {
    categoryId: "cat_antipasti",
    name: "Bruschette Miste",
    price: 7.5,
    description: "Bruschette con pomodoro, olive e basilico.",
    ingredients: ["Pane", "Pomodoro", "Basilico", "Olio EVO"],
    allergens: ["glutine"],
  },
  {
    categoryId: "cat_antipasti",
    name: "Polpettine Croccanti",
    price: 8.5,
    description: "Polpettine di carne con salsa della casa.",
    ingredients: ["Carne bovina", "Pane", "Spezie"],
    allergens: ["glutine", "uova"],
  },
  {
    categoryId: "cat_pinze",
    name: "Pinza Margherita",
    price: 9,
    description: "Pomodoro, mozzarella e basilico.",
    ingredients: ["Farina", "Pomodoro", "Mozzarella", "Basilico"],
    allergens: ["glutine", "latte"],
  },
  {
    categoryId: "cat_pinze",
    name: "Pinza Diavola",
    price: 10.5,
    description: "Pomodoro, mozzarella e salame piccante.",
    ingredients: ["Farina", "Pomodoro", "Mozzarella", "Salame piccante"],
    allergens: ["glutine", "latte"],
  },
  {
    categoryId: "cat_taglieri",
    name: "Tagliere Salumi",
    price: 14,
    description: "Selezione salumi tipici.",
    ingredients: ["Salumi misti", "Pane"],
    allergens: ["glutine"],
  },
  {
    categoryId: "cat_taglieri",
    name: "Tagliere Formaggi",
    price: 15,
    description: "Selezione formaggi stagionati e freschi.",
    ingredients: ["Formaggi misti", "Miele", "Pane"],
    allergens: ["latte", "glutine"],
  },
  {
    categoryId: "cat_sfiziosita",
    name: "Olive Ascolane",
    price: 6.5,
    description: "Olive ripiene e fritte.",
    ingredients: ["Olive", "Carne", "Panatura"],
    allergens: ["glutine", "uova"],
    isFrozen: true,
  },
  {
    categoryId: "cat_sfiziosita",
    name: "Crocchette di Patate",
    price: 5.8,
    description: "Crocchette dorate servite calde.",
    ingredients: ["Patate", "Panatura", "Formaggio"],
    allergens: ["glutine", "latte"],
    isFrozen: true,
  },
  {
    categoryId: "cat_dolci",
    name: "Tiramisu",
    price: 6,
    description: "Dessert al caffe della casa.",
    ingredients: ["Savoiardi", "Mascarpone", "Caffe", "Cacao"],
    allergens: ["glutine", "latte", "uova"],
  },
  {
    categoryId: "cat_dolci",
    name: "Cheesecake Frutti Rossi",
    price: 6.5,
    description: "Cheesecake artigianale ai frutti rossi.",
    ingredients: ["Biscotto", "Formaggio cremoso", "Frutti rossi"],
    allergens: ["glutine", "latte"],
  },
  {
    categoryId: "cat_menu_fissi",
    name: "Apericena",
    price: 12,
    description: "Menu fisso apericena. Drink premium con supplemento.",
    ingredients: ["Drink base", "Selezione tapas"],
    variants: [
      v("menu_ap_prenotazione", "Prenotazione (+2 EUR)", 2),
      v("menu_ap_premium", "Drink premium (+5 EUR)", 5),
    ],
  },
  {
    categoryId: "cat_pasticceria",
    name: "Cornetto Crema",
    price: 2.2,
    description: "Cornetto sfogliato con crema pasticcera.",
    ingredients: ["Farina", "Burro", "Crema pasticcera"],
    allergens: ["glutine", "latte", "uova"],
  },
  {
    categoryId: "cat_pasticceria",
    name: "Muffin Cioccolato",
    price: 2.8,
    description: "Muffin soffice con gocce di cioccolato.",
    ingredients: ["Farina", "Cacao", "Uova", "Latte"],
    allergens: ["glutine", "latte", "uova"],
  },
  {
    categoryId: "cat_panini_salati",
    name: "Panino Prosciutto e Formaggio",
    price: 5.5,
    description: "Panino caldo con prosciutto cotto e formaggio.",
    ingredients: ["Pane", "Prosciutto cotto", "Formaggio"],
    allergens: ["glutine", "latte"],
  },
  {
    categoryId: "cat_panini_salati",
    name: "Tramezzino Vegetariano",
    price: 4.8,
    description: "Pane morbido con verdure grigliate e crema.",
    ingredients: ["Pane", "Verdure grigliate", "Crema vegetale"],
    allergens: ["glutine"],
  },
  {
    categoryId: "cat_patatine",
    name: "Patatine Classiche",
    price: 2.5,
    description: "Chips classiche in busta.",
    ingredients: ["Patate", "Olio di semi", "Sale"],
  },
  {
    categoryId: "cat_patatine",
    name: "Nachos Piccanti",
    price: 3.2,
    description: "Snack di mais gusto piccante.",
    ingredients: ["Mais", "Olio", "Spezie"],
  },
  {
    categoryId: "cat_gelati",
    name: "Coppa Vaniglia",
    price: 4,
    description: "Gelato artigianale gusto vaniglia.",
    ingredients: ["Latte", "Panna", "Zucchero"],
    allergens: ["latte"],
    isFrozen: true,
  },
  {
    categoryId: "cat_gelati",
    name: "Stecco Cioccolato",
    price: 3.5,
    description: "Gelato su stecco ricoperto al cacao.",
    ingredients: ["Latte", "Cacao", "Zucchero"],
    allergens: ["latte"],
    isFrozen: true,
  },
  {
    categoryId: "cat_caramelle",
    name: "Caramelle Menta",
    price: 1.8,
    description: "Caramelle dure gusto menta.",
    ingredients: ["Zucchero", "Aromi naturali"],
  },
  {
    categoryId: "cat_caramelle",
    name: "Gomme Frutta",
    price: 2.2,
    description: "Gomme morbide alla frutta assortita.",
    ingredients: ["Sciroppo di glucosio", "Gelatina", "Aromi"],
    allergens: ["frutta a guscio"],
  },
];

const categoryMap = new Map(CATEGORIES.map((category) => [category.id, category]));

const PRODUCTS: MenuProduct[] = PRODUCT_SEEDS.map((seed, index) => {
  const category = categoryMap.get(seed.categoryId);
  if (!category) {
    throw new Error(`Categoria non valida per il prodotto ${seed.name}.`);
  }

  const displayPricing = normalizeProductPricing({ price: seed.price }, { fallbackPrice: 0 });
  return {
    id: `prd_${(index + 1).toString().padStart(4, "0")}`,
    sku: seed.sku ?? `SKU-${(index + 1).toString().padStart(4, "0")}`,
    departmentId: category.departmentId,
    categoryId: seed.categoryId,
    name: seed.name,
    description: seed.description ?? "Prodotto disponibile a menu.",
    ingredients: seed.ingredients ?? [],
    allergens: normalizeAllergenList(seed.allergens ?? []),
    isFrozen: Boolean(seed.isFrozen),
    variants: seed.variants ?? [],
    available: seed.available ?? true,
    price: seed.price,
    displayPricing,
    imageUrl: null,
  };
});

type RoomMenuState = {
  version: number;
  catalog: MenuCatalog;
  patches: Array<{ version: number; patch: MenuCatalogPatch }>;
};

const ROOM_ALLOWED_DEPARTMENTS: Record<string, string[] | undefined> = {};

const roomMenus = new Map<string, RoomMenuState>();

const cloneVariant = (variant: MenuProductVariant): MenuProductVariant => ({ ...variant });
const cloneSchedule = (schedule: ProductTimedPriceRange[] | undefined) =>
  schedule?.map((entry) => ({
    ...entry,
    daysOfWeek: entry.daysOfWeek ? [...entry.daysOfWeek] : undefined,
  }));
const cloneProduct = (product: MenuProduct): MenuProduct => ({
  ...product,
  ingredients: [...product.ingredients],
  allergens: normalizeAllergenList(product.allergens),
  variants: product.variants.map(cloneVariant),
  stations: [...(product.stations ?? [])],
  unavailableStations: [...(product.unavailableStations ?? [])],
  availabilityScope: product.availabilityScope ?? null,
  unavailableForStation: product.unavailableForStation === true,
  priceSchedule: cloneSchedule(product.priceSchedule),
  timedPrices: cloneSchedule(product.timedPrices),
  timePriceSchedule: cloneSchedule(product.timePriceSchedule),
  listinoTemporizzato: cloneSchedule(product.listinoTemporizzato),
  pricingMeta: product.pricingMeta ? { ...product.pricingMeta } : null,
  displayPricing: product.displayPricing
    ? { ...product.displayPricing }
    : normalizeProductPricing(product, { fallbackPrice: 0 }),
});
const cloneCatalog = (catalog: MenuCatalog): MenuCatalog => ({
  departments: catalog.departments.map((department) => ({ ...department })),
  categories: catalog.categories.map((category) => ({ ...category })),
  products: catalog.products.map(cloneProduct),
});

const baseCatalog: MenuCatalog = {
  departments: DEPARTMENTS.map((department) => ({ ...department })),
  categories: CATEGORIES.map((category) => ({ ...category })),
  products: PRODUCTS.map(cloneProduct),
};

const assertValidSession = (params: MenuSessionRequest) => {
  if (!params.token || !params.userId || !params.deviceUuid || !params.roomId) {
    throw new Error("Sessione menu non valida.");
  }
};

const applyRoomRules = (roomId: string): MenuCatalog => {
  const allowedDepartments = ROOM_ALLOWED_DEPARTMENTS[roomId];
  if (!allowedDepartments || allowedDepartments.length === 0) {
    return cloneCatalog(baseCatalog);
  }

  const allowedDepartmentSet = new Set(allowedDepartments);
  const departments = baseCatalog.departments.filter((department) =>
    allowedDepartmentSet.has(department.id)
  );
  const categories = baseCatalog.categories.filter((category) =>
    allowedDepartmentSet.has(category.departmentId)
  );
  const categoryIds = new Set(categories.map((category) => category.id));
  const products = baseCatalog.products.filter((product) => categoryIds.has(product.categoryId));

  return cloneCatalog({ departments, categories, products });
};

const applyPatchToCatalog = (catalog: MenuCatalog, patch: MenuCatalogPatch): MenuCatalog => {
  if (patch.type === "replace_catalog") return cloneCatalog(patch.catalog);

  if (patch.type === "upsert_product") {
    const existingIndex = catalog.products.findIndex((product) => product.id === patch.product.id);
    const nextProduct = cloneProduct(patch.product);
    if (existingIndex >= 0) {
      const nextProducts = [...catalog.products];
      nextProducts[existingIndex] = nextProduct;
      return { ...catalog, products: nextProducts };
    }
    return { ...catalog, products: [...catalog.products, nextProduct] };
  }

  if (patch.type === "remove_product") {
    return {
      ...catalog,
      products: catalog.products.filter((product) => product.id !== patch.productId),
    };
  }

  return {
    ...catalog,
    products: catalog.products.map((product) =>
      product.id === patch.productId ? { ...product, available: patch.available } : product
    ),
  };
};

const enqueuePatch = (state: RoomMenuState, patch: MenuCatalogPatch) => {
  state.version += 1;
  state.catalog = applyPatchToCatalog(state.catalog, patch);
  state.patches.push({ version: state.version, patch });
  if (state.patches.length > 240) {
    state.patches.splice(0, state.patches.length - 240);
  }
};

const getOrCreateRoomState = (roomId: string): RoomMenuState => {
  const existing = roomMenus.get(roomId);
  if (existing) return existing;

  const created: RoomMenuState = {
    version: 1,
    catalog: applyRoomRules(roomId),
    patches: [],
  };
  roomMenus.set(roomId, created);
  return created;
};

export function applyMenuCatalogPatches(
  catalog: MenuCatalog,
  patches: MenuCatalogPatch[]
): MenuCatalog {
  return patches.reduce((acc, patch) => applyPatchToCatalog(acc, patch), cloneCatalog(catalog));
}

const toMenuCatalogFromIntegrationPayload = (payload: unknown): MenuCatalog | null => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as {
    departments?: unknown;
    categories?: unknown;
    products?: unknown;
  };
  if (
    !Array.isArray(source.departments) ||
    !Array.isArray(source.categories) ||
    !Array.isArray(source.products)
  ) {
    return null;
  }

  const departments: MenuDepartment[] = source.departments
    .filter((item): item is { id?: unknown; name?: unknown } =>
      Boolean(item && typeof item === "object")
    )
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      name: String(item.name ?? "").trim(),
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);

  const categories: MenuCategory[] = source.categories
    .filter((item): item is { id?: unknown; departmentId?: unknown; name?: unknown } =>
      Boolean(item && typeof item === "object")
    )
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      departmentId: String(item.departmentId ?? "").trim(),
      name: String(item.name ?? "").trim(),
    }))
    .filter((item) => item.id.length > 0 && item.departmentId.length > 0 && item.name.length > 0);

  const toStringList = (value: unknown) =>
    Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];

  const toAvailabilityScope = (value: unknown): MenuProduct["availabilityScope"] => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (normalized === "global" || normalized === "station") return normalized;
    return null;
  };

  const products: MenuProduct[] = source.products
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const variantsRaw = Array.isArray(item.variants) ? item.variants : [];
      const variants: MenuProductVariant[] = variantsRaw
        .filter((variant): variant is Record<string, unknown> =>
          Boolean(variant && typeof variant === "object")
        )
        .map((variant) => ({
          id: String(variant.id ?? "").trim(),
          name: String(variant.name ?? "").trim(),
          priceDelta: Number(variant.priceDelta ?? 0) || 0,
        }))
        .filter((variant) => variant.id.length > 0 && variant.name.length > 0);
      const basePrice = parseOptionalMoney(item.basePrice);
      const activePrice = parseOptionalMoney(item.activePrice);
      const currentPrice = parseOptionalMoney(item.currentPrice);
      const priceSchedule = parseTimedPriceSchedule(item.priceSchedule);
      const timedPrices = parseTimedPriceSchedule(item.timedPrices);
      const timePriceSchedule = parseTimedPriceSchedule(item.timePriceSchedule);
      const listinoTemporizzato = parseTimedPriceSchedule(item.listinoTemporizzato);
      const pricingMeta = normalizePricingMeta(item.pricingMeta);
      const vatRate = normalizeVatRate(item.vatRate ?? item.iva ?? item.taxRate);
      const vatCode = normalizeVatCode(item.vatCode ?? item.ivaCode ?? item.taxCode);
      const price = parseOptionalMoney(item.price) ?? basePrice ?? activePrice ?? currentPrice ?? 0;
      const pricingInput = {
        price: item.price,
        basePrice: item.basePrice,
        activePrice: item.activePrice,
        currentPrice: item.currentPrice,
        nextPriceChangeAt: item.nextPriceChangeAt,
        pricingLabel: item.pricingLabel,
        pricingSource: item.pricingSource,
        pricingMeta,
        priceSchedule,
        timedPrices,
        timePriceSchedule,
        listinoTemporizzato,
      };
      const displayPricing = normalizeProductPricing(pricingInput, { fallbackPrice: price });

      return {
        id: String(item.id ?? "").trim(),
        sku: String(item.sku ?? item.id ?? "").trim(),
        departmentId: String(item.departmentId ?? "").trim(),
        categoryId: String(item.categoryId ?? "").trim(),
        type: String(item.type ?? "").trim(),
        section: String(item.section ?? item.subcategory ?? "").trim(),
        name: String(item.name ?? "").trim(),
        description: String(item.description ?? "").trim(),
        ingredients: Array.isArray(item.ingredients)
          ? item.ingredients.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          : [],
        allergens: normalizeAllergenList(Array.isArray(item.allergens) ? item.allergens : []),
        isFrozen: item.isFrozen === true,
        variants,
        variantRequired:
          item.variantRequired === true ||
          item.requiresVariant === true ||
          item.requiresVariantSelection === true,
        requiresVariant:
          item.requiresVariant === true ||
          item.variantRequired === true ||
          item.requiresVariantSelection === true,
        requiresVariantSelection:
          item.requiresVariantSelection === true ||
          item.variantRequired === true ||
          item.requiresVariant === true,
        isPremiumAlcohol: item.isPremiumAlcohol === true,
        available: item.available !== false,
        availabilityScope: toAvailabilityScope(item.availabilityScope),
        unavailableStations: toStringList(item.unavailableStations),
        unavailableForStation: item.unavailableForStation === true,
        stations: toStringList(item.stations),
        price,
        basePrice,
        priceSchedule: priceSchedule.length ? priceSchedule : undefined,
        timedPrices: timedPrices.length ? timedPrices : undefined,
        timePriceSchedule: timePriceSchedule.length ? timePriceSchedule : undefined,
        listinoTemporizzato: listinoTemporizzato.length ? listinoTemporizzato : undefined,
        activePrice: activePrice ?? null,
        currentPrice: currentPrice ?? null,
        vatRate,
        vatCode,
        nextPriceChangeAt: displayPricing.nextPriceChangeAt ?? null,
        pricingLabel: normalizePricingText(item.pricingLabel),
        pricingSource: normalizePricingText(item.pricingSource),
        pricingMeta,
        displayPricing,
        imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
      };
    })
    .filter(
      (item) =>
        item.id.length > 0 &&
        item.sku.length > 0 &&
        item.departmentId.length > 0 &&
        item.categoryId.length > 0 &&
        item.name.length > 0
    );

  if (source.departments.length > 0 && departments.length === 0) return null;
  if (source.categories.length > 0 && categories.length === 0) return null;
  if (source.products.length > 0 && products.length === 0) return null;
  if (categories.length > 0 && departments.length === 0) return null;
  if (products.length > 0 && (departments.length === 0 || categories.length === 0)) return null;
  return { departments, categories, products: dedupeMenuCatalogProducts(products) };
};

export const resolveOrderStationName = (station?: string | null) => {
  const explicit = String(station ?? "").trim();
  if (explicit) return explicit;
  return getRuntimeConfig().defaultOrderStation.trim();
};

const fetchMenuCatalogFromBackend = async (
  station = resolveOrderStationName(),
  context: { activityId?: string; roomId?: string } = {}
): Promise<{ version: number; catalog: MenuCatalog } | null> => {
  try {
    const search = new URLSearchParams();
    if (station.trim()) search.set("station", station.trim());
    if (context.activityId?.trim()) search.set("activityId", context.activityId.trim());
    if (context.roomId?.trim()) search.set("roomId", context.roomId.trim());
    const query = search.toString();
    const response = await apiFetch(`/api/integration/menu${query ? `?${query}` : ""}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      version?: unknown;
      departments?: unknown;
      categories?: unknown;
      products?: unknown;
    };
    const catalog = toMenuCatalogFromIntegrationPayload(payload);
    if (!catalog) return null;
    const version = Number(payload.version);
    return {
      version: Number.isFinite(version) ? Math.trunc(version) : Date.now(),
      catalog,
    };
  } catch {
    return null;
  }
};

export async function fetchMenuCatalogForSession(
  params: MenuSessionRequest
): Promise<MenuCatalogSnapshot> {
  await sleep(120);
  assertValidSession(params);
  const backendCatalog = await fetchMenuCatalogFromBackend(resolveOrderStationName(), {
    activityId: params.activityId,
    roomId: params.roomId,
  });
  if (backendCatalog) {
    const snapshot = {
      version: backendCatalog.version,
      catalog: cloneCatalog(backendCatalog.catalog),
    };
    const offlineScope = resolveOfflineConfigurationScope(params);
    if (offlineScope) await recordOfflineMenu(offlineScope, params.roomId, snapshot);
    return snapshot;
  }
  const offlineScope = resolveOfflineConfigurationScope(params);
  const offlineSnapshot = offlineScope ? await readOfflineMenu(offlineScope, params.roomId) : null;
  if (offlineSnapshot) {
    return {
      version: offlineSnapshot.version,
      catalog: cloneCatalog(offlineSnapshot.catalog),
    };
  }
  throw new Error(
    "Backend menu non disponibile: catalogo statico disabilitato in runtime operativo."
  );
}

export async function fetchMenuCatalogUpdatesForSession(
  params: MenuSessionRequest & { sinceVersion: number }
): Promise<MenuCatalogUpdates> {
  await sleep(90);
  assertValidSession(params);
  const backendCatalog = await fetchMenuCatalogFromBackend(resolveOrderStationName(), {
    activityId: params.activityId,
    roomId: params.roomId,
  });
  if (backendCatalog) {
    const snapshot = {
      version: backendCatalog.version,
      catalog: cloneCatalog(backendCatalog.catalog),
    };
    const offlineScope = resolveOfflineConfigurationScope(params);
    if (offlineScope) await recordOfflineMenu(offlineScope, params.roomId, snapshot);
    if (params.sinceVersion >= backendCatalog.version) {
      return {
        version: backendCatalog.version,
        updates: [],
      };
    }
    return {
      version: backendCatalog.version,
      updates: [{ type: "replace_catalog", catalog: cloneCatalog(backendCatalog.catalog) }],
    };
  }
  const offlineScope = resolveOfflineConfigurationScope(params);
  const offlineSnapshot = offlineScope ? await readOfflineMenu(offlineScope, params.roomId) : null;
  if (offlineSnapshot) {
    return {
      version: offlineSnapshot.version,
      updates:
        params.sinceVersion >= offlineSnapshot.version
          ? []
          : [{ type: "replace_catalog", catalog: cloneCatalog(offlineSnapshot.catalog) }],
    };
  }
  if (!import.meta.env.DEV) {
    throw new Error(
      "Backend menu non disponibile: aggiornamenti statici disabilitati in runtime operativo."
    );
  }
  const state = getOrCreateRoomState(params.roomId);
  return {
    version: state.version,
    updates: state.patches
      .filter((entry) => entry.version > params.sinceVersion)
      .map((entry) => entry.patch),
  };
}

export async function mockApiSetProductAvailability(params: {
  roomId: string;
  productId: string;
  available: boolean;
}) {
  await sleep(120);
  const state = getOrCreateRoomState(params.roomId);
  enqueuePatch(state, {
    type: "set_availability",
    productId: params.productId,
    available: params.available,
  });
}

export async function mockApiUpsertTemporaryProduct(params: {
  roomId: string;
  product: MenuProduct;
}) {
  await sleep(140);
  const state = getOrCreateRoomState(params.roomId);
  enqueuePatch(state, {
    type: "upsert_product",
    product: cloneProduct(params.product),
  });
}

export async function mockApiRemoveTemporaryProduct(params: { roomId: string; productId: string }) {
  await sleep(120);
  const state = getOrCreateRoomState(params.roomId);
  enqueuePatch(state, {
    type: "remove_product",
    productId: params.productId,
  });
}

export async function fetchMenuCatalog(): Promise<MenuCatalog> {
  await sleep(120);
  const backendCatalog = await fetchMenuCatalogFromBackend();
  if (backendCatalog) {
    return cloneCatalog(backendCatalog.catalog);
  }
  if (import.meta.env.DEV) return cloneCatalog(baseCatalog);
  throw new Error(
    "Backend menu non disponibile: catalogo statico disabilitato in runtime operativo."
  );
}
