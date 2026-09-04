import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { MenuCatalog } from "../../../../api/menu";
import { fetchActiveStationCount } from "../../../../api/stations";
import { fetchTopSoldProducts, type TopSoldProduct } from "../../../../api/topSoldProducts";
import {
  formatNextPriceChangeLabel,
  getProductDisplayPricing,
  getTimedPricingBadgeLabel,
  type ProductClientPriceSnapshot,
} from "../../../../shared/pricing/productPricing";
import {
  readSessionPreference,
  writeSessionPreference,
} from "../../../../shared/storage/preferenceStorage";
import {
  buildMenuProductSectionEntries,
  sortMenuProductsBySection,
} from "../../../../shared/menu/productSections";
import { GlassDropdown } from "./GlassDropdown";
import {
  applyCartAdjustmentToSubmitLines,
  cartAdjustmentReduction,
  removeCartAdjustmentLine,
  resolveAdjustedLineTotal,
  type CartAdjustment,
} from "../payment/cartAdjustment";
import { CartReductionRow } from "./CartReductionRow";
import { CartItemDetails } from "./CartItemDetails";
import { triggerLongPressHaptic } from "../../../../utils/haptics";
import {
  buildBestSellerRankByProductId,
  ORDER_BEST_SELLER_LIMIT,
  sortProductsByBestSellerRank,
} from "../../../../utils/orderBestSellers";
import {
  getOrderBestSellersEnabled,
  getOrderFiltersEnabled,
  subscribeOrderFilters,
} from "../../../../utils/orderPreferences";
import {
  hasProductSearchQuery,
  normalizeProductSearchText,
} from "../../../../utils/productSearch";
import {
  buildOrderDraftSubmit,
  createProductClientPriceSnapshot,
  getDraftUnitBasePrice,
  refreshDraftPricingSnapshots,
  restoreProductClientPriceSnapshot,
  type TableOrderSubmitPayload,
} from "../orderDraftPricing";
import { isApericenaBeverageProduct } from "./beverageApericenaCategory";
import {
  MENU_SUPPLEMENT_LABEL,
  MENU_UNDER4_UI_LABEL,
  computeMenuSupplement,
  computeMenuTarget,
  getMenuSupplementSubmitLabel,
  getMenuSupplementUiLabel,
  normalizeSupplementType,
  shouldWriteMenuSupplementNote,
  type SupplementContext,
  type SupplementType,
} from "./menuSupplementPricing";
import { useSubmitLongPressAction } from "./useSubmitLongPressAction";
import {
  getProductVariants,
  isOrderableProduct,
  productMatchesOrderSearch,
  productRequiresVariantSelection,
} from "./orderComposerProductPolicy";
export type { TableOrderSubmitPayload } from "../orderDraftPricing";
type DraftItem = {
  id: string;
  productId: string;
  variantId: string;
  note: string;
  quantity: number;
  supplement: SupplementType;
  customName?: string;
  customPrice?: number;
  clientPriceSnapshot?: ProductClientPriceSnapshot;
};
type MenuProduct = MenuCatalog["products"][number];
type DraftEditPatch = Partial<Pick<DraftItem, "variantId" | "supplement">>;
type SubmitBundle = { payload: TableOrderSubmitPayload; draftItemIds: string[] };
type ItemEditChoice = {
  itemId: string;
  patch: DraftEditPatch;
  reason: "variant" | "supplement";
};
type QuickAddState =
  | {
      kind: "product";
      productId: string;
      variantId: string;
      note: string;
      supplement: SupplementType;
    }
  | {
      kind: "custom";
      name: string;
      price: string;
      note: string;
      supplement: SupplementType;
    };
const CUSTOM_PRODUCT_ID = "custom_varie";
const CUSTOM_PRODUCT_LABEL = "Varie";
const LONG_PRESS_MS = 1000;
const SWIPE_MAX = 120;
const SWIPE_OPEN = 56;
const SWIPE_MIN = 20;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isSwipeHitTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest(".table-order-swipe-hit"));
interface TableOrderComposerProps {
  open: boolean;
  busy: boolean;
  catalog: MenuCatalog | null;
  persistKey?: string;
  title?: string;
  submitLabel?: string;
  submittingLabel?: string;
  inlineStatus?: { tone: "notice" | "error"; message: string } | null;
  resetNonce?: number;
  showCloseButton?: boolean;
  /** Rettifica di pagamento applicata al carrello (Banco). */
  adjustment?: CartAdjustment | null;
  onAdjustmentChange?: (next: CartAdjustment | null) => void;
  onClose: () => void;
  onSubmit: (payload: TableOrderSubmitPayload) => Promise<void>;
  onSubmitLongPress?: (
    payload: TableOrderSubmitPayload,
    meta: { draftItemIds: string[] }
  ) => Promise<void> | void;
}
type OrderComposerSnapshot = {
  departmentId: string;
  categoryId: string;
  search: string;
  draft: DraftItem[];
  drawerOpen: boolean;
  orderNote: string;
  orderComment: string;
  expandedItemId: string | null;
};
const makeDraftId = () => `ord_d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const buildDraftKey = (item: DraftItem) => {
  const base = [
    item.productId,
    item.variantId || "",
    item.note.trim(),
    item.supplement,
    item.customName?.trim() || "",
    Number.isFinite(item.customPrice) ? String(item.customPrice) : "",
  ];
  return base.join("|");
};
const mergeDraftItems = (items: DraftItem[]) => {
  const map = new Map<string, DraftItem>();
  const order: string[] = [];
  for (const item of items) {
    const key = buildDraftKey(item);
    if (map.has(key)) {
      const existing = map.get(key)!;
      existing.quantity = Math.max(1, existing.quantity + item.quantity);
      existing.clientPriceSnapshot = item.clientPriceSnapshot ?? existing.clientPriceSnapshot;
    } else {
      map.set(key, { ...item });
      order.push(key);
    }
  }
  return order.map((key) => map.get(key)!);
};
const buildDraftGroupKey = (item: DraftItem) => {
  if (item.productId === CUSTOM_PRODUCT_ID) {
    const name = item.customName?.trim() || CUSTOM_PRODUCT_LABEL;
    const price = Number.isFinite(item.customPrice) ? String(item.customPrice) : "";
    return `${item.productId}|${name}|${price}`;
  }
  return item.productId;
};
const normalizeDraftItems = (items: DraftItem[]) => {
  const merged = mergeDraftItems(items);
  const groups = new Map<string, DraftItem[]>();
  const groupOrder: string[] = [];
  for (const item of merged) {
    const groupKey = buildDraftGroupKey(item);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      groupOrder.push(groupKey);
    }
    groups.get(groupKey)!.push(item);
  }
  return groupOrder.flatMap((key) => groups.get(key)!);
};
export function TableOrderComposer({
  open,
  busy,
  catalog,
  persistKey,
  title = "Nuova Comanda",
  submitLabel = "Invia",
  submittingLabel = "Invio...",
  inlineStatus = null,
  resetNonce = 0,
  showCloseButton = true,
  adjustment = null,
  onAdjustmentChange,
  onClose,
  onSubmit,
  onSubmitLongPress,
}: TableOrderComposerProps) {
  const [departmentId, setDepartmentId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const effectiveSearch = normalizeProductSearchText(search).length <= 1 ? search : deferredSearch;
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quickAdd, setQuickAdd] = useState<QuickAddState | null>(null);
  const [bestSellersActive, setBestSellersActive] = useState(false);
  const [topSoldItems, setTopSoldItems] = useState<TopSoldProduct[]>([]);
  const [topSoldLoading, setTopSoldLoading] = useState(false);
  const [topSoldError, setTopSoldError] = useState("");
  const [orderNote, setOrderNote] = useState("");
  const [orderComment, setOrderComment] = useState("");
  const [showFilters, setShowFilters] = useState<boolean>(() => getOrderFiltersEnabled());
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [itemEditChoice, setItemEditChoice] = useState<ItemEditChoice | null>(null);
  const [noActiveStations, setNoActiveStations] = useState(false);
  const [stationWarningVisible, setStationWarningVisible] = useState(false);
  const [swipeX, setSwipeX] = useState<Record<string, number>>({});
  const [activeSwipeId, setActiveSwipeId] = useState<string | null>(null);
  const [reflow, setReflow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressTargetRef = useRef<string | null>(null);
  const previousResetNonceRef = useRef(resetNonce);
  const stationWarningAckedRef = useRef(false);
  const previousNoActiveStationsRef = useRef(false);
  const swipeRef = useRef<{ id: string; startX: number; startY: number; swiping: boolean } | null>(
    null
  );
  const prevCountRef = useRef(draft.length);
  useEffect(() => {
    if (!open) {
      setDrawerOpen(false);
      setQuickAdd(null);
      setBestSellersActive(false);
      setTopSoldError("");
      setOrderNote("");
      setOrderComment("");
      setExpandedItemId(null);
      setItemEditChoice(null);
      setSwipeX({});
      setActiveSwipeId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || previousResetNonceRef.current === resetNonce) return;
    previousResetNonceRef.current = resetNonce;
    setDraft([]);
    setOrderNote("");
    setOrderComment("");
    setDrawerOpen(false);
    setQuickAdd(null);
    setTopSoldError("");
    setExpandedItemId(null);
    setItemEditChoice(null);
  }, [open, resetNonce]);
  useEffect(() => {
    if (open) {
      setShowFilters(getOrderFiltersEnabled());
      setBestSellersActive(getOrderBestSellersEnabled());
      stationWarningAckedRef.current = false;
      previousNoActiveStationsRef.current = false;
    } else {
      setNoActiveStations(false);
      setStationWarningVisible(false);
      stationWarningAckedRef.current = false;
      previousNoActiveStationsRef.current = false;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    let checking = false;
    const checkStations = async () => {
      if (checking) return;
      checking = true;
      let activeCount: number | null = null;
      try {
        activeCount = await fetchActiveStationCount();
      } finally {
        checking = false;
      }
      if (!active || activeCount === null) return;

      if (activeCount > 0) {
        previousNoActiveStationsRef.current = false;
        stationWarningAckedRef.current = false;
        setNoActiveStations(false);
        setStationWarningVisible(false);
        return;
      }

      const nextNoActiveStations = activeCount === 0;
      setNoActiveStations(nextNoActiveStations);
      const changedAvailability = previousNoActiveStationsRef.current !== nextNoActiveStations;
      previousNoActiveStationsRef.current = nextNoActiveStations;
      if (changedAvailability && !stationWarningAckedRef.current) {
        setStationWarningVisible(true);
      }
    };
    void checkStations();
    const timer = window.setInterval(() => {
      void checkStations();
    }, 750);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open]);
  const dismissNoActiveStationsWarning = useCallback(() => {
    stationWarningAckedRef.current = true;
    setStationWarningVisible(false);
  }, []);
  useEffect(() => {
    if (!open || !persistKey) return;
    try {
      const raw = readSessionPreference(persistKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<OrderComposerSnapshot>;
      const restoredDraft = Array.isArray(parsed.draft)
        ? parsed.draft
            .filter((entry): entry is DraftItem => Boolean(entry && typeof entry === "object"))
            .map((entry) => {
              const supplement: SupplementType = normalizeSupplementType(entry.supplement);
              return {
                id: typeof entry.id === "string" && entry.id.trim() ? entry.id : makeDraftId(),
                productId: typeof entry.productId === "string" ? entry.productId : "",
                variantId: typeof entry.variantId === "string" ? entry.variantId : "",
                note: typeof entry.note === "string" ? entry.note : "",
                quantity: Math.max(1, Math.min(99, Math.round(Number(entry.quantity) || 1))),
                supplement,
                customName: typeof entry.customName === "string" ? entry.customName : undefined,
                customPrice:
                  typeof entry.customPrice === "number" && Number.isFinite(entry.customPrice)
                    ? Math.max(0, entry.customPrice)
                    : undefined,
                clientPriceSnapshot: restoreProductClientPriceSnapshot(entry.clientPriceSnapshot),
              };
            })
            .filter((entry) => entry.productId.trim().length > 0)
        : [];
      setDepartmentId(typeof parsed.departmentId === "string" ? parsed.departmentId : "");
      setCategoryId(typeof parsed.categoryId === "string" ? parsed.categoryId : "");
      setSearch(typeof parsed.search === "string" ? parsed.search : "");
      setDraft(restoredDraft);
      setDrawerOpen(Boolean(parsed.drawerOpen));
      setOrderNote(typeof parsed.orderNote === "string" ? parsed.orderNote : "");
      setOrderComment(typeof parsed.orderComment === "string" ? parsed.orderComment : "");
      setExpandedItemId(
        typeof parsed.expandedItemId === "string" && parsed.expandedItemId.trim()
          ? parsed.expandedItemId
          : null
      );
    } catch {
      // ignore malformed persisted state
    }
  }, [open, persistKey]);
  useEffect(() => {
    return subscribeOrderFilters(() => {
      setShowFilters(getOrderFiltersEnabled());
    });
  }, []);
  useEffect(() => {
    if (!persistKey) return;
    const payload: OrderComposerSnapshot = {
      departmentId,
      categoryId,
      search,
      draft,
      drawerOpen,
      orderNote,
      orderComment,
      expandedItemId,
    };
    try {
      writeSessionPreference(persistKey, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  }, [
    categoryId,
    departmentId,
    draft,
    drawerOpen,
    expandedItemId,
    orderComment,
    orderNote,
    persistKey,
    search,
  ]);
  useEffect(() => {
    if (!showFilters) {
      setDepartmentId("");
      setCategoryId("");
    }
  }, [showFilters]);
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (expandedItemId && !draft.some((item) => item.id === expandedItemId)) {
      setExpandedItemId(null);
    }
  }, [draft, expandedItemId]);
  useEffect(() => {
    setSwipeX((prev) => {
      const next: Record<string, number> = {};
      draft.forEach((item) => {
        if (prev[item.id]) next[item.id] = prev[item.id];
      });
      return next;
    });
    if (activeSwipeId && !draft.some((item) => item.id === activeSwipeId)) {
      setActiveSwipeId(null);
    }
    if (itemEditChoice && !draft.some((item) => item.id === itemEditChoice.itemId)) {
      setItemEditChoice(null);
    }
  }, [activeSwipeId, draft, itemEditChoice]);
  useEffect(() => {
    const prevCount = prevCountRef.current;
    if (draft.length < prevCount) {
      setReflow(true);
      const timer = window.setTimeout(() => setReflow(false), 260);
      prevCountRef.current = draft.length;
      return () => window.clearTimeout(timer);
    }
    prevCountRef.current = draft.length;
  }, [draft.length]);
  useEffect(() => {
    if (!quickAdd) {
      longPressTriggeredRef.current = false;
      longPressTargetRef.current = null;
    }
  }, [quickAdd]);
  const departments = catalog?.departments ?? [];
  const categories = catalog?.categories ?? [];
  const products = catalog?.products ?? [];
  const departmentsById = useMemo(
    () => new Map(departments.map((department) => [department.id, department])),
    [departments]
  );
  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories]
  );
  const effectiveDepartmentId = showFilters ? departmentId || departments[0]?.id || "" : "";
  const availableCategories = useMemo(() => {
    if (!showFilters) return categories;
    return categories.filter((item) => item.departmentId === effectiveDepartmentId);
  }, [categories, effectiveDepartmentId, showFilters]);
  const effectiveCategoryId = showFilters ? categoryId || availableCategories[0]?.id || "" : "";
  const filteredProducts = useMemo(() => {
    const query = effectiveSearch;
    const hasSearchQuery = hasProductSearchQuery(query);
    return products
      .filter(isOrderableProduct)
      .filter((item) => {
        if (hasSearchQuery) return true;
        return showFilters && effectiveDepartmentId
          ? item.departmentId === effectiveDepartmentId
          : true;
      })
      .filter((item) => {
        if (hasSearchQuery) return true;
        return showFilters && effectiveCategoryId ? item.categoryId === effectiveCategoryId : true;
      })
      .filter((item) =>
        hasSearchQuery
          ? productMatchesOrderSearch(
              item,
              query,
              categoriesById.get(item.categoryId)?.name,
              departmentsById.get(item.departmentId)?.name
            )
          : true
      );
  }, [
    products,
    categoriesById,
    departmentsById,
    effectiveDepartmentId,
    effectiveCategoryId,
    effectiveSearch,
    showFilters,
  ]);
  const bestSellerRankByProductId = useMemo(
    () => buildBestSellerRankByProductId(topSoldItems),
    [topSoldItems]
  );
  const useNormalProductSectionOrder =
    showFilters &&
    Boolean(effectiveCategoryId) &&
    !hasProductSearchQuery(effectiveSearch);
  const showProductSectionDividers = useNormalProductSectionOrder && !bestSellersActive;
  const orderedProducts = useMemo(() => {
    const normalProducts = useNormalProductSectionOrder
      ? sortMenuProductsBySection(filteredProducts, products)
      : [...filteredProducts].sort((left, right) => left.name.localeCompare(right.name, "it"));
    if (bestSellersActive) {
      return sortProductsByBestSellerRank(normalProducts, bestSellerRankByProductId);
    }
    return normalProducts;
  }, [
    bestSellerRankByProductId,
    bestSellersActive,
    filteredProducts,
    products,
    useNormalProductSectionOrder,
  ]);
  const displayProducts = useMemo(
    () => [
      { kind: "custom" as const, id: CUSTOM_PRODUCT_ID, name: CUSTOM_PRODUCT_LABEL },
      ...buildMenuProductSectionEntries(orderedProducts, showProductSectionDividers),
    ],
    [orderedProducts, showProductSectionDividers]
  );
  const departmentOptions = useMemo(
    () => departments.map((department) => ({ value: department.id, label: department.name })),
    [departments]
  );
  const categoryOptions = useMemo(
    () => availableCategories.map((category) => ({ value: category.id, label: category.name })),
    [availableCategories]
  );
  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
  useEffect(() => {
    if (!open || !bestSellersActive) return undefined;
    let active = true;
    setTopSoldLoading(true);
    setTopSoldError("");
    void fetchTopSoldProducts({ days: 15, limit: ORDER_BEST_SELLER_LIMIT })
      .then((items) => {
        if (!active) return;
        setTopSoldItems(items);
      })
      .catch((error) => {
        if (!active) return;
        setTopSoldError(error instanceof Error ? error.message : "Top venduti non disponibili.");
      })
      .finally(() => {
        if (active) setTopSoldLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bestSellersActive, open]);
  useEffect(() => {
    if (!open || draft.length === 0) return;
    const refreshed = refreshDraftPricingSnapshots(draft, productsById, CUSTOM_PRODUCT_ID);
    if (refreshed.changed) {
      setDraft(refreshed.items);
    }
  }, [draft, open, productsById]);
  const startLongPress = useCallback((productId: string) => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }
    longPressTriggeredRef.current = false;
    longPressTargetRef.current = productId;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      triggerLongPressHaptic();
      setQuickAdd({
        kind: "product",
        productId,
        variantId: "",
        note: "",
        supplement: "none",
      });
      longPressTimerRef.current = null;
    }, LONG_PRESS_MS);
  }, []);
  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);
  const closeOtherSwipes = (currentId: string, keepCurrent = true) => {
    setSwipeX((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      Object.entries(prev).forEach(([id, value]) => {
        if (id === currentId) {
          next[id] = keepCurrent ? value : 0;
          if (!keepCurrent && value !== 0) changed = true;
          return;
        }
        next[id] = 0;
        if (value !== 0) changed = true;
      });
      return changed ? next : prev;
    });
  };
  const handleSwipeStart = (id: string) => (event: PointerEvent<HTMLDivElement>) => {
    if (isSwipeHitTarget(event.target)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select")) return;
    closeOtherSwipes(id, false);
    swipeRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      swiping: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleSwipeMove = (id: string) => (event: PointerEvent<HTMLDivElement>) => {
    const current = swipeRef.current;
    if (!current || current.id !== id) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.swiping) {
      if (dx < -6 && Math.abs(dx) > Math.abs(dy)) {
        current.swiping = true;
        setActiveSwipeId(id);
      } else {
        return;
      }
    }
    event.preventDefault();
    const nextX = clamp(dx, -SWIPE_MAX, 0);
    setSwipeX((prev) => ({ ...prev, [id]: nextX }));
  };
  const handleSwipeEnd = (id: string) => (event: PointerEvent<HTMLDivElement>) => {
    const current = swipeRef.current;
    if (!current || current.id !== id) return;
    const dx = event.clientX - current.startX;
    const finalX = clamp(dx, -SWIPE_MAX, 0);
    if (current.swiping && finalX <= -SWIPE_MIN) {
      setSwipeX((prev) => ({ ...prev, [id]: -SWIPE_OPEN }));
    } else {
      setSwipeX((prev) => ({ ...prev, [id]: 0 }));
    }
    swipeRef.current = null;
    setActiveSwipeId(null);
  };
  const openCustomQuickAdd = useCallback(() => {
    setQuickAdd({
      kind: "custom",
      name: "",
      price: "",
      note: "",
      supplement: "none",
    });
  }, []);
  const openProductQuickAdd = useCallback((productId: string) => {
    setQuickAdd({
      kind: "product",
      productId,
      variantId: "",
      note: "",
      supplement: "none",
    });
  }, []);
  const pushDraftItem = (item: DraftItem) => {
    setDraft((prev) => normalizeDraftItems([...prev, item]));
  };
  const addProduct = useCallback(
    (productId: string) => {
      const product = productsById.get(productId);
      if (!product || product.available === false) return;
      pushDraftItem({
        id: makeDraftId(),
        productId: product.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "none",
        clientPriceSnapshot: createProductClientPriceSnapshot(product),
      });
    },
    [productsById]
  );
  const handleProductClick = useCallback(
    (productId: string) => {
      if (longPressTriggeredRef.current && longPressTargetRef.current === productId) {
        longPressTriggeredRef.current = false;
        return;
      }
      const product = productsById.get(productId);
      if (
        product &&
        productRequiresVariantSelection(product, categoriesById.get(product.categoryId)?.name)
      ) {
        openProductQuickAdd(productId);
        return;
      }
      addProduct(productId);
    },
    [addProduct, categoriesById, openProductQuickAdd, productsById]
  );
  const draftQuantityByProductId = useMemo(() => {
    const quantities = new Map<string, number>();
    draft.forEach((item) => {
      const productId = item.productId.trim();
      if (!productId) return;
      const quantity = Math.max(1, Math.min(99, Math.round(Number(item.quantity) || 1)));
      quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
    });
    return quantities;
  }, [draft]);
  const productRows = useMemo(
    () =>
      displayProducts.map((entry, displayIndex) => {
        if (entry.kind === "section") {
          return (
            <div
              key={entry.id}
              className="menu-product-section-divider table-order-product-section-divider"
              role="separator"
              aria-label={`Sezione ${entry.name}`}
            >
              <span>{entry.name}</span>
            </div>
          );
        }
        if (entry.kind === "custom") {
          const draftQuantity = draftQuantityByProductId.get(CUSTOM_PRODUCT_ID) ?? 0;
          return (
            <button
              type="button"
              key={entry.id}
              className={`table-order-product-row is-custom${draftQuantity > 0 ? " has-draft-qty" : ""}`}
              data-draft-qty={draftQuantity > 0 ? String(draftQuantity) : undefined}
              onClick={openCustomQuickAdd}
            >
              <span className="table-order-product-name">{entry.name}</span>
              <div className="table-order-product-meta">
                <strong className="table-order-product-price">Prezzo a scelta</strong>
              </div>
              {draftQuantity > 0 && (
                <span
                  className="mobile-order-draft-qty-badge"
                  aria-label={`${draftQuantity} articoli gia aggiunti`}
                  title={`${draftQuantity} articoli gia aggiunti`}
                >
                  {draftQuantity > 99 ? "99+" : `x${draftQuantity}`}
                </span>
              )}
            </button>
          );
        }
        const product = entry.product;
        const unavailableStations = product.unavailableStations ?? [];
        const isStationLimited =
          product.availabilityScope === "station" && unavailableStations.length > 0;
        const isDisabled = product.available === false || product.availabilityScope === "global";
        const draftQuantity = draftQuantityByProductId.get(product.id) ?? 0;
        const stationNote = isStationLimited
          ? `Non disponibile: ${unavailableStations.join(", ")}`
          : "";
        const pricing = getProductDisplayPricing(product);
        const timedPricingLabel = getTimedPricingBadgeLabel(pricing);
        const nextPriceChangeLabel = formatNextPriceChangeLabel(pricing.nextPriceChangeAt);
        const bestSellerRank = bestSellersActive && displayIndex <= ORDER_BEST_SELLER_LIMIT
          ? bestSellerRankByProductId.get(product.id)
          : undefined;
        return (
          <button
            type="button"
            key={product.id}
            className={`table-order-product-row${isDisabled ? " is-disabled is-global-terminated" : ""}${
              isStationLimited ? " is-station-limited" : ""
            }${draftQuantity > 0 ? " has-draft-qty" : ""}${bestSellerRank ? " is-best-seller" : ""}`}
            data-draft-qty={draftQuantity > 0 ? String(draftQuantity) : undefined}
            onPointerDown={() => !isDisabled && startLongPress(product.id)}
            onPointerUp={() => !isDisabled && clearLongPress()}
            onPointerLeave={() => !isDisabled && clearLongPress()}
            onPointerCancel={() => !isDisabled && clearLongPress()}
            onClick={() => !isDisabled && handleProductClick(product.id)}
            disabled={isDisabled}
            aria-disabled={isDisabled}
            title={isDisabled ? `${product.name}: non disponibile` : stationNote || product.name}
          >
            <span className="table-order-product-name">{product.name}</span>
            <div className="table-order-product-meta">
              <strong className="table-order-product-price">
                {pricing.displayPrice.toFixed(2)} EUR
              </strong>
              {timedPricingLabel ? (
                <span
                  className="table-order-timed-price-badge"
                  title={nextPriceChangeLabel ?? timedPricingLabel}
                  aria-label={nextPriceChangeLabel ?? timedPricingLabel}
                >
                  {timedPricingLabel}
                </span>
              ) : null}
              {isDisabled && <span className="table-order-product-badge is-off">Terminato</span>}
              {isStationLimited && (
                <span className="mobile-menu-availability-chip is-warning">Attenzione</span>
              )}
            </div>
            {stationNote ? (
              <span className="mobile-menu-availability-note">{stationNote}</span>
            ) : null}
            {nextPriceChangeLabel ? (
              <span className="table-order-price-change-note">{nextPriceChangeLabel}</span>
            ) : null}
            {bestSellerRank ? (
              <span
                className="table-order-product-best-seller-star"
                title={`Best-seller n. ${bestSellerRank}`}
                aria-label={`Best-seller n. ${bestSellerRank}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2.6l2.75 5.58 6.16.9-4.46 4.35 1.05 6.14L12 16.68l-5.5 2.89 1.05-6.14L3.1 9.08l6.15-.9L12 2.6z" />
                </svg>
              </span>
            ) : null}
            {draftQuantity > 0 && (
              <span
                className="mobile-order-draft-qty-badge"
                aria-label={`${draftQuantity} articoli gia aggiunti`}
                title={`${draftQuantity} articoli gia aggiunti`}
              >
                {draftQuantity > 99 ? "99+" : `x${draftQuantity}`}
              </span>
            )}
          </button>
        );
      }),
    [
      bestSellerRankByProductId,
      bestSellersActive,
      clearLongPress,
      displayProducts,
      draftQuantityByProductId,
      handleProductClick,
      openCustomQuickAdd,
      startLongPress,
    ]
  );
  const addCustomProduct = (payload: {
    name: string;
    price: number;
    note: string;
    supplement: SupplementType;
  }) => {
    pushDraftItem({
      id: makeDraftId(),
      productId: CUSTOM_PRODUCT_ID,
      variantId: "",
      note: payload.note,
      quantity: 1,
      supplement: payload.supplement,
      customName: payload.name,
      customPrice: payload.price,
    });
  };
  const updateDraft = (itemId: string, patch: Partial<DraftItem>) => {
    setDraft((prev) => {
      const next = prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
      return normalizeDraftItems(next);
    });
  };
  const requestItemEdit = (
    item: DraftItem,
    patch: DraftEditPatch,
    reason: ItemEditChoice["reason"]
  ) => {
    const touchesVariant = Object.prototype.hasOwnProperty.call(patch, "variantId");
    const touchesSupplement = Object.prototype.hasOwnProperty.call(patch, "supplement");
    if (!touchesVariant && !touchesSupplement) return;
    if (touchesVariant && !touchesSupplement && patch.variantId === item.variantId) {
      return;
    }
    if (touchesSupplement && !touchesVariant && patch.supplement === item.supplement) {
      return;
    }
    if (
      touchesVariant &&
      touchesSupplement &&
      patch.variantId === item.variantId &&
      patch.supplement === item.supplement
    ) {
      return;
    }
    if (item.quantity > 1) {
      setItemEditChoice({ itemId: item.id, patch, reason });
      return;
    }
    updateDraft(item.id, patch);
  };
  const requestVariantChange = (item: DraftItem, nextVariantId: string) => {
    requestItemEdit(item, { variantId: nextVariantId }, "variant");
  };
  const removeDraft = (itemId: string) => {
    setDraft((prev) => prev.filter((item) => item.id !== itemId));
  };
  const removeDraftFromSwipe = (itemId: string) => {
    removeDraft(itemId);
    setSwipeX((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    if (activeSwipeId === itemId) setActiveSwipeId(null);
  };
  const setDraftQuantity = (itemId: string, nextValue: number) => {
    const normalized = Math.max(1, Math.min(99, Math.round(nextValue) || 1));
    setDraft((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, quantity: normalized } : item))
    );
  };
  const adjustDraftQuantity = (itemId: string, delta: number) => {
    setDraft((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        const nextValue = Math.max(1, Math.min(99, item.quantity + delta));
        return { ...item, quantity: nextValue };
      })
    );
  };
  const getUnitBasePrice = (item: DraftItem) => {
    return getDraftUnitBasePrice(item, productsById, CUSTOM_PRODUCT_ID);
  };
  const getSupplementContextForProduct = (product: MenuProduct | null | undefined) => ({
    isBeverage: isApericenaBeverageProduct(
      product,
      product ? categoriesById.get(product.categoryId)?.name : ""
    ),
  });
  const getSupplementContextForItem = (item: DraftItem) => {
    const product =
      item.productId === CUSTOM_PRODUCT_ID ? null : (productsById.get(item.productId) ?? null);
    return getSupplementContextForProduct(product);
  };
  const getSupplementAmount = (
    basePrice: number,
    supplement: SupplementType,
    context: SupplementContext = { isBeverage: false }
  ) => computeMenuSupplement(basePrice, supplement, context);
  const getUnitTotalPrice = (item: DraftItem) => {
    const base = getUnitBasePrice(item);
    return base + getSupplementAmount(base, item.supplement, getSupplementContextForItem(item));
  };
  const totalItemsCount = useMemo(
    () => draft.reduce((sum, item) => sum + item.quantity, 0),
    [draft]
  );
  const total = useMemo(() => {
    const itemsTotal = draft.reduce((sum, item) => {
      const lineTotal = getUnitTotalPrice(item) * item.quantity;
      return sum + resolveAdjustedLineTotal(adjustment, item.id, lineTotal).total;
    }, 0);
    // L'abbuono non tocca gli articoli: si scala qui, dal totale.
    const allowance = adjustment && !adjustment.affectsItems ? adjustment.totalReduction : 0;
    return Math.max(0, Math.round((itemsTotal - allowance) * 100) / 100);
  }, [draft, adjustment, productsById, categoriesById, departmentsById]);
  const interactionBusy = busy || submitting;
  const buildSubmit = useCallback((): SubmitBundle | null => {
    const {
      lines: rawLines,
      total: draftTotal,
      draftItemIds,
    } = buildOrderDraftSubmit(draft, productsById, {
      customProductId: CUSTOM_PRODUCT_ID,
      customProductLabel: CUSTOM_PRODUCT_LABEL,
      menuSupplementLabel: MENU_SUPPLEMENT_LABEL,
      getSupplementLabel: getMenuSupplementSubmitLabel,
      computeSupplementAmount: (basePrice, supplement, context) =>
        getSupplementAmount(
          basePrice,
          normalizeSupplementType(supplement),
          getSupplementContextForProduct(context.product)
        ),
      shouldIncludeSupplementNote: (basePrice, supplement, context) =>
        shouldWriteMenuSupplementNote(
          basePrice,
          normalizeSupplementType(supplement),
          getSupplementContextForProduct(context.product)
        ),
    });
    if (rawLines.length === 0) return null;

    const { lines, total } = applyCartAdjustmentToSubmitLines(rawLines, draftItemIds, adjustment);
    const title = lines
      .slice(0, 3)
      .map((line) => `${line.qty}x ${line.name}`)
      .join(" | ");
    return {
      draftItemIds,
      payload: {
        title: title || `Comanda ${lines.length} articoli`,
        total: adjustment ? total : draftTotal,
        orderNote: orderNote.trim() || undefined,
        orderComment: orderComment.trim() || undefined,
        lines,
      },
    };
  }, [adjustment, draft, orderComment, orderNote, productsById]);
  const submitPayloadReady = useMemo(() => buildSubmit() !== null, [buildSubmit]);

  const submitOrder = async () => {
    if (interactionBusy) return;
    const payload = buildSubmit()?.payload ?? null;
    if (!payload) return;
    setSubmitting(true);
    try {
      await onSubmit(payload);
      setDraft([]);
      setOrderNote("");
      setOrderComment("");
    } catch {
      // L'errore viene mostrato dal parent: qui preserviamo la bozza per il retry operatore.
    } finally {
      setSubmitting(false);
    }
  };

  const submitLongPress = useSubmitLongPressAction<SubmitBundle>({
    enabled: Boolean(onSubmitLongPress),
    busy: interactionBusy,
    hasPayload: submitPayloadReady,
    delayMs: LONG_PRESS_MS,
    buildPayload: buildSubmit,
    onLongPress: onSubmitLongPress
      ? (entry) => onSubmitLongPress(entry.payload, { draftItemIds: entry.draftItemIds })
      : undefined,
  });

  const handleSubmitClick = () => {
    if (submitLongPress.consumeTriggered()) return;
    void submitOrder();
  };
  const confirmQuickAdd = () => {
    if (!quickAdd) return;
    if (quickAdd.kind === "custom") {
      const name = quickAdd.name.trim();
      const hasPrice = quickAdd.price.trim() !== "";
      const priceValue = Number(quickAdd.price);
      if (!name || !hasPrice || Number.isNaN(priceValue)) return;
      addCustomProduct({
        name,
        price: Math.max(0, priceValue),
        note: quickAdd.note.trim(),
        supplement: quickAdd.supplement,
      });
      setQuickAdd(null);
      return;
    }
    const product = productsById.get(quickAdd.productId);
    if (!product || product.available === false) {
      setQuickAdd(null);
      return;
    }
    if (
      productRequiresVariantSelection(product, categoriesById.get(product.categoryId)?.name) &&
      !quickAdd.variantId
    ) {
      return;
    }
    pushDraftItem({
      id: makeDraftId(),
      productId: product.id,
      variantId: quickAdd.variantId,
      note: quickAdd.note.trim(),
      quantity: 1,
      supplement: quickAdd.supplement,
      clientPriceSnapshot: createProductClientPriceSnapshot(product),
    });
    setQuickAdd(null);
  };
  const quickProduct =
    quickAdd?.kind === "product" ? (productsById.get(quickAdd.productId) ?? null) : null;
  const quickVariant =
    quickAdd?.kind === "product" && quickProduct
      ? (quickProduct.variants.find((entry) => entry.id === quickAdd.variantId) ?? null)
      : null;
  const quickVariantRequired =
    quickAdd?.kind === "product" && quickProduct
      ? productRequiresVariantSelection(
          quickProduct,
          categoriesById.get(quickProduct.categoryId)?.name
        )
      : false;
  const quickBasePrice =
    quickAdd?.kind === "product"
      ? quickProduct
        ? getProductDisplayPricing(quickProduct).displayPrice + (quickVariant?.priceDelta ?? 0)
        : 0
      : quickAdd?.kind === "custom"
        ? Math.max(0, Number(quickAdd.price) || 0)
        : 0;
  const formatSupplementOptionLabel = (
    basePrice: number,
    supplement: SupplementType,
    context: SupplementContext
  ) => {
    if (context.isBeverage && supplement === "menu_apericena_under4") {
      return `${MENU_UNDER4_UI_LABEL} (prezzo drink ${basePrice.toFixed(2)} EUR)`;
    }
    const supplementAmount = computeMenuSupplement(basePrice, supplement, context);
    const supplementTarget = computeMenuTarget(basePrice, supplement, context);
    const label = getMenuSupplementUiLabel(supplement);
    return supplementAmount > 0 && supplementTarget
      ? `${label} (+${supplementAmount.toFixed(2)} EUR -> ${supplementTarget.toFixed(2)} EUR)`
      : `${label} (non disponibile)`;
  };
  const quickCustomReady =
    quickAdd?.kind === "custom"
      ? quickAdd.name.trim().length > 0 &&
        quickAdd.price.trim() !== "" &&
        !Number.isNaN(Number(quickAdd.price))
      : true;
  const quickReady =
    quickAdd?.kind === "product"
      ? !quickVariantRequired || Boolean(quickAdd.variantId)
      : quickCustomReady;
  const buildSupplementOptions = (
    basePrice: number,
    product: MenuProduct | null | undefined = null
  ) => {
    const context = getSupplementContextForProduct(product);
    if (context.isBeverage) {
      return [
        { value: "none", label: "Nessuno" },
        {
          value: "menu_apericena",
          label: formatSupplementOptionLabel(basePrice, "menu_apericena", context),
          disabled: computeMenuSupplement(basePrice, "menu_apericena", context) <= 0,
        },
        {
          value: "menu_apericena_under4",
          label: formatSupplementOptionLabel(basePrice, "menu_apericena_under4", context),
        },
      ];
    }
    return [
      { value: "none", label: "Nessuno" },
      {
        value: "menu_apericena",
        label: formatSupplementOptionLabel(basePrice, "menu_apericena", context),
        disabled: computeMenuSupplement(basePrice, "menu_apericena", context) <= 0,
      },
      {
        value: "menu_apericena_prenotazione",
        label: formatSupplementOptionLabel(basePrice, "menu_apericena_prenotazione", context),
        disabled: computeMenuSupplement(basePrice, "menu_apericena_prenotazione", context) <= 0,
      },
    ];
  };
  const itemEditTarget = itemEditChoice
    ? (draft.find((item) => item.id === itemEditChoice.itemId) ?? null)
    : null;
  const itemEditTargetLabel = useMemo(() => {
    if (!itemEditTarget) return "";
    if (itemEditTarget.productId === CUSTOM_PRODUCT_ID) {
      return itemEditTarget.customName?.trim() || CUSTOM_PRODUCT_LABEL;
    }
    return productsById.get(itemEditTarget.productId)?.name ?? "Articolo";
  }, [itemEditTarget, productsById]);
  const itemEditReasonLabel = itemEditChoice?.reason === "supplement" ? "supplemento" : "variante";
  const applyEditToAll = () => {
    if (!itemEditChoice) return;
    updateDraft(itemEditChoice.itemId, itemEditChoice.patch);
    setItemEditChoice(null);
  };
  const applyEditToOne = () => {
    if (!itemEditChoice) return;
    setDraft((prev) => {
      const target = prev.find((item) => item.id === itemEditChoice.itemId);
      if (!target || target.quantity <= 1) return prev;
      const updated = prev.map((item) =>
        item.id === target.id ? { ...item, quantity: Math.max(1, item.quantity - 1) } : item
      );
      const nextItem: DraftItem = {
        ...target,
        id: makeDraftId(),
        quantity: 1,
        ...itemEditChoice.patch,
      };
      return normalizeDraftItems([...updated, nextItem]);
    });
    setItemEditChoice(null);
  };
  const closeItemEditChoice = () => {
    setItemEditChoice(null);
  };
  if (!open) return null;
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (interactionBusy || event.target !== event.currentTarget) return;
    onClose();
  };
  const stopComposerClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };
  return (
    <div className="table-order-composer-backdrop" onClick={closeFromBackdrop}>
      <section className="table-order-composer" onClick={stopComposerClick}>
        <header className="table-order-head">
          <h4>{title}</h4>
          {showCloseButton ? (
            <button
              type="button"
              className="smallbtn table-order-close-btn"
              disabled={interactionBusy}
              onClick={onClose}
              aria-label="Chiudi"
              title="Chiudi"
            >
              <svg viewBox="0 0 24 24" className="table-order-close-icon" aria-hidden="true">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </button>
          ) : null}
        </header>
        {inlineStatus?.message ? (
          <div className={`table-order-inline-status is-${inlineStatus.tone}`}>
            {inlineStatus.message}
          </div>
        ) : null}
        <div className={`table-order-filters ${showFilters ? "" : "is-compact"}`}>
          {showFilters && (
            <GlassDropdown
              value={effectiveDepartmentId}
              options={departmentOptions}
              ariaLabel="Reparto"
              disabled={interactionBusy || departmentOptions.length === 0}
              onChange={(event) => {
                setDepartmentId(event);
                setCategoryId("");
              }}
            />
          )}
          {showFilters && (
            <GlassDropdown
              value={effectiveCategoryId}
              options={categoryOptions}
              ariaLabel="Categoria"
              disabled={interactionBusy || categoryOptions.length === 0}
              onChange={setCategoryId}
            />
          )}
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cerca prodotto"
          />
          <button
            type="button"
            className={`table-order-top-sold-toggle${bestSellersActive ? " is-active" : ""}`}
            disabled={interactionBusy}
            onClick={() => setBestSellersActive((current) => !current)}
            aria-label={bestSellersActive ? "Disattiva best-seller" : "Attiva best-seller"}
            aria-pressed={bestSellersActive}
            aria-busy={topSoldLoading}
            title={
              bestSellersActive && topSoldError
                ? "Best-seller temporaneamente non disponibili"
                : "Mostra best-seller"
            }
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.6l2.75 5.58 6.16.9-4.46 4.35 1.05 6.14L12 16.68l-5.5 2.89 1.05-6.14L3.1 9.08l6.15-.9L12 2.6z" />
            </svg>
          </button>
        </div>
        <div className="table-order-grid">
          <div className="table-order-products table-order-products-main">
            {productRows}
            {filteredProducts.length === 0 && (
              <div className="table-order-empty">
                Nessun prodotto disponibile con questi filtri.
              </div>
            )}
          </div>
        </div>
        <div className={`table-order-drawer ${drawerOpen ? "is-open" : ""}`}>
          <button
            type="button"
            className="table-order-drawer-toggle"
            onClick={() => setDrawerOpen((prev) => !prev)}
            aria-expanded={drawerOpen}
          >
            <span>Comanda ({totalItemsCount})</span>
            <strong>{total.toFixed(2)} EUR</strong>
            <svg
              viewBox="0 0 24 24"
              className={`table-order-drawer-icon ${drawerOpen ? "is-open" : ""}`}
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {drawerOpen && (
            <div className="table-order-cart table-order-cart-drawer">
              <div className="table-order-notes table-order-notes-drawer">
                <label>
                  Nota d'ordine
                  <textarea
                    value={orderNote}
                    rows={2}
                    maxLength={200}
                    onChange={(event) => setOrderNote(event.target.value)}
                    placeholder="Nota generale per la comanda"
                  />
                </label>
                <label>
                  Commento d'ordine
                  <textarea
                    value={orderComment}
                    rows={2}
                    maxLength={200}
                    onChange={(event) => setOrderComment(event.target.value)}
                    placeholder="Commento interno o indicazioni extra"
                  />
                </label>
              </div>
              {draft.length === 0 && (
                <div className="table-order-empty">Seleziona prodotti dal menu.</div>
              )}
              {draft.map((item) => {
                const isCustom = item.productId === CUSTOM_PRODUCT_ID;
                const product = isCustom ? null : productsById.get(item.productId);
                if (!isCustom && !product) return null;
                const variantOptions = product
                  ? [
                      { value: "", label: "Nessuna variante" },
                      ...product.variants.map((entry) => ({
                        value: entry.id,
                        label: `${entry.name} (${entry.priceDelta >= 0 ? "+" : ""}${entry.priceDelta.toFixed(2)} EUR)`,
                      })),
                    ]
                  : [];
                const basePrice = getUnitBasePrice(item);
                const rawLineTotal = getUnitTotalPrice(item) * item.quantity;
                const { total: lineTotal, adjusted: lineAdjusted } = resolveAdjustedLineTotal(
                  adjustment,
                  item.id,
                  rawLineTotal
                );
                const lineReduction = lineAdjusted ? rawLineTotal - lineTotal : 0;
                const itemName = isCustom
                  ? item.customName?.trim() || CUSTOM_PRODUCT_LABEL
                  : (product?.name ?? "Articolo");
                const isExpanded = expandedItemId === item.id;
                const swipe = swipeX[item.id] ?? 0;
                const swipeDir = swipe < -6 ? "left" : "none";
                return (
                  <Fragment key={item.id}>
                  <div
                    className={`table-order-swipe-row ${reflow ? "is-reflow" : ""}`}
                    data-swipe={swipeDir}
                    onPointerDown={handleSwipeStart(item.id)}
                    onPointerMove={handleSwipeMove(item.id)}
                    onPointerUp={handleSwipeEnd(item.id)}
                    onPointerCancel={handleSwipeEnd(item.id)}
                  >
                    <div className="table-order-swipe-action">
                      <button
                        type="button"
                        className="table-order-swipe-hit"
                        aria-label="Elimina articolo"
                        onPointerDown={(event) => event.stopPropagation()}
                        onPointerUp={(event) => event.stopPropagation()}
                        onPointerCancel={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeDraftFromSwipe(item.id);
                        }}
                      >
                        <svg
                          className="table-order-swipe-icon"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="M4 7h16" />
                          <path d="M9 7V5h6v2" />
                          <rect x="7" y="7" width="10" height="12" rx="2" />
                        </svg>
                      </button>
                    </div>
                    <div
                      className={`table-order-item ${isExpanded ? "is-open" : ""} ${
                        activeSwipeId === item.id ? "is-swiping" : ""
                      }`}
                      style={{ transform: `translateX(${swipe}px)` }}
                    >
                      <div className="table-order-item-main">
                        <button
                          type="button"
                          className="table-order-item-toggle"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedItemId((prev) => (prev === item.id ? null : item.id));
                          }}
                          aria-label={
                            isExpanded ? "Riduci dettaglio articolo" : "Espandi dettaglio articolo"
                          }
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className={`table-order-item-chevron ${isExpanded ? "is-open" : ""}`}
                            aria-hidden="true"
                          >
                            <path d="M7 10l5 5 5-5" />
                          </svg>
                        </button>
                        <div className="table-order-item-info">
                          <strong>{itemName}</strong>
                        </div>
                        <div className="table-order-item-qty">
                          <button
                            type="button"
                            className="table-order-qty-btn is-minus"
                            onClick={(event) => {
                              event.stopPropagation();
                              adjustDraftQuantity(item.id, -1);
                            }}
                            aria-label="Riduci quantità"
                          >
                            -
                          </button>
                          <input
                            type="number"
                            min={1}
                            max={99}
                            value={item.quantity}
                            onChange={(event) =>
                              setDraftQuantity(item.id, Number(event.target.value))
                            }
                            onClick={(event) => event.stopPropagation()}
                          />
                          <button
                            type="button"
                            className="table-order-qty-btn is-plus"
                            onClick={(event) => {
                              event.stopPropagation();
                              adjustDraftQuantity(item.id, 1);
                            }}
                            aria-label="Aumenta quantità"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div
                        className={`table-order-item-total ${lineAdjusted ? "is-adjusted" : ""}`}
                        title={lineAdjusted ? `Prezzo rettificato (era ${rawLineTotal.toFixed(2)} EUR)` : undefined}
                      >
                        {lineTotal.toFixed(2)} EUR
                      </div>
                      {isExpanded && (
                        <CartItemDetails
                          item={item}
                          product={product ?? null}
                          isCustom={isCustom}
                          variantOptions={variantOptions}
                          supplementOptions={buildSupplementOptions(basePrice, product ?? null)}
                          interactionBusy={interactionBusy}
                          updateDraft={updateDraft}
                          requestVariantChange={requestVariantChange}
                          requestItemEdit={requestItemEdit}
                        />
                      )}
                    </div>
                  </div>
                  {adjustment?.scope === "line" && lineReduction > 0.004 && (
                    <CartReductionRow
                      label="Riduzione importo Articolo"
                      amount={lineReduction}
                      perLine
                      onRemove={
                        onAdjustmentChange
                          ? () => onAdjustmentChange(removeCartAdjustmentLine(adjustment, item.id))
                          : undefined
                      }
                    />
                  )}
                  </Fragment>
                );
              })}
              {adjustment && adjustment.scope === "total" && (
                <CartReductionRow
                  label="Riduzione importo"
                  amount={cartAdjustmentReduction(adjustment)}
                  note={adjustment.reason}
                  onRemove={onAdjustmentChange ? () => onAdjustmentChange(null) : undefined}
                />
              )}
            </div>
          )}
        </div>
        {quickAdd && (
          <div className="table-order-quick-backdrop" onClick={() => setQuickAdd(null)}>
            <div className="table-order-quick-card" onClick={(event) => event.stopPropagation()}>
              <header className="table-order-quick-head">
                <div className="table-order-quick-title">
                  {quickAdd.kind === "custom"
                    ? CUSTOM_PRODUCT_LABEL
                    : (quickProduct?.name ?? "Articolo")}
                </div>
                <button
                  type="button"
                  className="smallbtn table-order-quick-close"
                  onClick={() => setQuickAdd(null)}
                  aria-label="Chiudi"
                >
                  <svg viewBox="0 0 24 24" className="table-order-close-icon" aria-hidden="true">
                    <path d="M6 6l12 12M18 6l-12 12" />
                  </svg>
                </button>
              </header>
              <div className="table-order-quick-body">
                {quickAdd.kind === "custom" ? (
                  <>
                    <label>
                      Nome articolo
                      <input
                        type="text"
                        value={quickAdd.name}
                        maxLength={48}
                        onChange={(event) =>
                          setQuickAdd((prev) =>
                            prev && prev.kind === "custom"
                              ? { ...prev, name: event.target.value }
                              : prev
                          )
                        }
                        placeholder="Es. Aperitivo special"
                      />
                    </label>
                    <label>
                      Prezzo
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={quickAdd.price}
                        onChange={(event) =>
                          setQuickAdd((prev) =>
                            prev && prev.kind === "custom"
                              ? { ...prev, price: event.target.value }
                              : prev
                          )
                        }
                        placeholder="0.00"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <div className="table-order-quick-meta">
                      <span>Prezzo base</span>
                      <strong>{quickBasePrice.toFixed(2)} EUR</strong>
                    </div>
                    <label
                      className={`table-order-variant-field ${
                        quickVariantRequired && !quickAdd.variantId ? "is-required-missing" : ""
                      }`.trim()}
                    >
                      Variante
                      <GlassDropdown
                        value={quickAdd.variantId}
                        options={[
                          { value: "", label: "Nessuna variante" },
                          ...(quickProduct ? getProductVariants(quickProduct) : []).map(
                            (entry) => ({
                              value: entry.id,
                              label: `${entry.name} (${entry.priceDelta >= 0 ? "+" : ""}${entry.priceDelta.toFixed(2)} EUR)`,
                            })
                          ),
                        ]}
                        ariaLabel={`Variante ${quickProduct?.name ?? "articolo"}`}
                        disabled={interactionBusy}
                        onChange={(nextValue) =>
                          setQuickAdd((prev) =>
                            prev && prev.kind === "product"
                              ? { ...prev, variantId: nextValue }
                              : prev
                          )
                        }
                      />
                      {quickVariantRequired && !quickAdd.variantId ? (
                        <span className="table-order-required-hint">
                          Variante obbligatoria per Drink Premium
                        </span>
                      ) : null}
                    </label>
                  </>
                )}
                <label className="table-order-supplement-field">
                  Supplemento
                  <GlassDropdown
                    className="table-order-supplement-dropdown"
                    value={quickAdd.supplement}
                    options={buildSupplementOptions(quickBasePrice, quickProduct)}
                    ariaLabel="Supplemento"
                    disabled={interactionBusy}
                    onChange={(nextValue) =>
                      setQuickAdd((prev) =>
                        prev ? { ...prev, supplement: nextValue as SupplementType } : prev
                      )
                    }
                  />
                </label>
                <label>
                  Nota riga
                  <input
                    type="text"
                    value={quickAdd.note}
                    maxLength={120}
                    onChange={(event) =>
                      setQuickAdd((prev) => (prev ? { ...prev, note: event.target.value } : prev))
                    }
                    placeholder="Es. senza ghiaccio"
                  />
                </label>
              </div>
              <footer className="table-order-quick-foot">
                <button type="button" className="smallbtn" onClick={() => setQuickAdd(null)}>
                  Annulla
                </button>
                <button
                  type="button"
                  className="smallbtn table-order-quick-confirm"
                  onClick={confirmQuickAdd}
                  disabled={interactionBusy || !quickReady}
                >
                  Aggiungi
                </button>
              </footer>
            </div>
          </div>
        )}
        {itemEditChoice && itemEditTarget && (
          <div className="table-order-variant-backdrop" onClick={closeItemEditChoice}>
            <div className="table-order-variant-card" onClick={(event) => event.stopPropagation()}>
              <div className="table-order-variant-head">
                <strong>Modifica multipla</strong>
                <button
                  type="button"
                  className="smallbtn table-order-variant-close"
                  onClick={closeItemEditChoice}
                  aria-label="Chiudi"
                >
                  <svg viewBox="0 0 24 24" className="table-order-close-icon" aria-hidden="true">
                    <path d="M6 6l12 12M18 6l-12 12" />
                  </svg>
                </button>
              </div>
              <div className="table-order-variant-body">
                <div>Applica il {itemEditReasonLabel} a:</div>
                <strong>{itemEditTargetLabel}</strong>
                <span>Quantita attuale: {itemEditTarget.quantity}</span>
              </div>
              <div className="table-order-variant-actions">
                <button type="button" className="smallbtn" onClick={applyEditToOne}>
                  Solo 1
                </button>
                <button
                  type="button"
                  className="smallbtn table-order-variant-confirm"
                  onClick={applyEditToAll}
                >
                  Tutti
                </button>
              </div>
            </div>
          </div>
        )}
        {noActiveStations && stationWarningVisible && (
          <div className="mobile-no-active-stations-backdrop" role="presentation">
            <section
              className="mobile-no-active-stations-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="mobile-no-active-stations-title"
            >
              <header className="mobile-no-active-stations-head">
                <div className="mobile-no-active-stations-icon" aria-hidden="true">
                  !
                </div>
                <div
                  className="mobile-no-active-stations-title"
                  id="mobile-no-active-stations-title"
                >
                  Nessuna postazione attiva
                </div>
              </header>
              <div className="mobile-no-active-stations-body">
                <strong>Attenzione:</strong> nessuna postazione attiva, gli ordini andranno in coda
                ma non verranno preparati fino alla riattivazione di almeno una postazione.
              </div>
              <footer className="mobile-no-active-stations-actions">
                <button
                  type="button"
                  className="mobile-no-active-stations-ok"
                  onClick={dismissNoActiveStationsWarning}
                >
                  OK
                </button>
              </footer>
            </section>
          </div>
        )}
        <footer className="table-order-footer">
          <strong>Totale comanda: {total.toFixed(2)} EUR</strong>
          <button
            type="button"
            className="smallbtn table-order-submit"
            onPointerDown={submitLongPress.onPointerDown}
            onPointerUp={submitLongPress.onPointerEnd}
            onPointerCancel={submitLongPress.onPointerEnd}
            onTouchStart={submitLongPress.onTouchStart}
            onTouchEnd={submitLongPress.onTouchEnd}
            onTouchCancel={submitLongPress.onTouchCancel}
            onContextMenu={(event) => event.preventDefault()}
            onClick={handleSubmitClick}
            disabled={interactionBusy || !submitPayloadReady}
          >
            <svg className="table-order-submit-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 11.5l17-8-4.2 17-2.9-6.6L3 11.5z" />
              <path d="M12.9 13.4l6.1-9.9" />
            </svg>
            {submitting ? submittingLabel : submitLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
