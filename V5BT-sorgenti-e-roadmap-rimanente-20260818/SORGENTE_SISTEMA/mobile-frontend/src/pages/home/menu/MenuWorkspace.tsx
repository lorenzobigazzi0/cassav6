import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchMenuCatalog,
  fetchMenuCatalogForSession,
  menuCatalogQueryKey,
} from "../../../api/menu";
import { GlassCard } from "../../../components/GlassCard";
import { HACCP_ALLERGEN_OPTIONS } from "../../../domain/allergens";
import {
  readSessionPreference,
  removeSessionPreference,
  writeSessionPreference,
} from "../../../shared/storage/preferenceStorage";
import { useRealtimeTransportStatus } from "../../../app/runtime/realtimeTransportStatus";
import { sortMenuProductsBySection } from "../../../shared/menu/productSections";
import { useAuthStore } from "../../../store/authStore";
import { MenuCategoryList } from "./components/MenuCategoryList";
import { MenuFilterBar } from "./components/MenuFilterBar";
import {
  buildAvailabilityOptions,
  isMenuProductActive,
  resolveMenuAvailabilityState,
  type MenuAvailabilityState,
} from "../../../shared/menu/productAvailability";
import { MenuProductDetail } from "./components/MenuProductDetail";
import { MenuProductList } from "./components/MenuProductList";
import { useMenuEdgeBack } from "./hooks/useMenuEdgeBack";
import { useTimedPricingRefresh } from "./hooks/useTimedPricingRefresh";
import { productMatchesSearch } from "./utils";
import {
  getMenuStationBadgeEnabled,
  subscribeMenuStationBadge,
} from "../../../utils/menuStationBadgePreferences";
import { hasProductSearchQuery } from "../../../utils/productSearch";

type MenuStage = "categories" | "products" | "search-results" | "product-detail";
type MenuProductScrollState = {
  savedAt: number;
  categoryTitle: string;
  productName: string;
  rowIndex: number;
  scrollTop: number;
  rowOffset: number;
};

const normalize = (value: string) => value.trim().toLowerCase();
const normalizeMenuText = (value: string | null | undefined) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const MENU_PRODUCT_SCROLL_KEY = "mobile:menu:product-scroll:v1";
const MENU_PRODUCT_SCROLL_MAX_AGE_MS = 10 * 60 * 1000;
const MENU_PRODUCT_SCROLL_RESTORE_ATTEMPTS = 22;
const MENU_PRODUCT_SCROLL_RESTORE_INTERVAL_MS = 45;
const MENU_CATALOG_SAFETY_REFRESH_MS = 90_000;

const ALLERGEN_OPTIONS = HACCP_ALLERGEN_OPTIONS;

export function MenuWorkspace() {
  const { token, userId, deviceUuid, roomId } = useAuthStore();
  const realtimeTransport = useRealtimeTransportStatus();
  const menuContentRef = useRef<HTMLDivElement | null>(null);
  const restoreTimerRef = useRef<number | null>(null);
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [excludedAllergens, setExcludedAllergens] = useState<string[]>([]);
  const [searchInIngredients, setSearchInIngredients] = useState(false);
  const [hiddenAvailability, setHiddenAvailability] = useState<MenuAvailabilityState[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [navDirection, setNavDirection] = useState<"forward" | "backward">("forward");
  const [showStationBadges, setShowStationBadges] = useState(() => getMenuStationBadgeEnabled());

  const effectiveRoomId = roomId || "";
  const canLoadSessionMenu = Boolean(token && userId && deviceUuid && effectiveRoomId);

  const catalogQuery = useQuery({
    queryKey: menuCatalogQueryKey(effectiveRoomId),
    staleTime: 1000 * 60,
    refetchInterval: realtimeTransport.connected ? false : MENU_CATALOG_SAFETY_REFRESH_MS,
    queryFn: async () => {
      if (canLoadSessionMenu) {
        try {
          return await fetchMenuCatalogForSession({
            token: token || "",
            userId: userId || "",
            deviceUuid: deviceUuid || "",
            roomId: effectiveRoomId,
          });
        } catch {
          // Fallback al catalogo generale reale se la sessione sala non e' ancora pronta.
        }
      }
      const catalog = await fetchMenuCatalog();
      return { version: 0, catalog };
    },
  });

  const departments = catalogQuery.data?.catalog.departments ?? [];
  const categories = catalogQuery.data?.catalog.categories ?? [];
  const products = catalogQuery.data?.catalog.products ?? [];

  useTimedPricingRefresh({
    enabled: products.length > 0,
    products,
    onRefresh: () => catalogQuery.refetch(),
  });

  useEffect(() => {
    setQuery("");
    setExcludedAllergens([]);
    setSearchInIngredients(false);
    setSelectedCategoryId(null);
    setSelectedProductId(null);
    setFilterOpen(false);
    setNavDirection("forward");
  }, [effectiveRoomId]);

  useEffect(
    () => subscribeMenuStationBadge(() => setShowStationBadges(getMenuStationBadgeEnabled())),
    []
  );

  useEffect(
    () => () => {
      if (restoreTimerRef.current !== null) {
        window.clearInterval(restoreTimerRef.current);
      }
    },
    []
  );

  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories]
  );
  const departmentsById = useMemo(
    () => new Map(departments.map((department) => [department.id, department])),
    [departments]
  );
  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );

  const selectedProduct = selectedProductId ? (productsById.get(selectedProductId) ?? null) : null;
  const selectedCategory = selectedCategoryId
    ? (categoriesById.get(selectedCategoryId) ?? null)
    : selectedProduct
      ? (categoriesById.get(selectedProduct.categoryId) ?? null)
      : null;
  const selectedDepartment =
    selectedProduct || selectedCategory
      ? (departmentsById.get(
          selectedProduct?.departmentId ?? selectedCategory?.departmentId ?? ""
        ) ?? null)
      : null;

  // I prodotti disattivati in anagrafica non compaiono nel menu: il backend li
  // esclude gia' dal catalogo, questa e' la rete di sicurezza lato client.
  const activeProducts = useMemo(() => products.filter(isMenuProductActive), [products]);

  const searchMatchedProducts = useMemo(
    () =>
      activeProducts.filter((product) => productMatchesSearch(product, query, searchInIngredients)),
    [activeProducts, query, searchInIngredients]
  );

  const hiddenAvailabilityKey = hiddenAvailability.join("|");
  const filteredProducts = useMemo(() => {
    let current = searchMatchedProducts;
    if (excludedAllergens.length > 0) {
      const blocked = new Set(excludedAllergens.map(normalize));
      current = current.filter(
        (product) => !product.allergens.some((allergen) => blocked.has(normalize(allergen)))
      );
    }
    if (hiddenAvailability.length > 0) {
      const hidden = new Set(hiddenAvailability);
      current = current.filter((product) => !hidden.has(resolveMenuAvailabilityState(product)));
    }
    return current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatchedProducts, excludedAllergens, hiddenAvailabilityKey]);

  const availabilityOptions = useMemo(
    () => buildAvailabilityOptions(searchMatchedProducts),
    [searchMatchedProducts]
  );
  const hasSearchQuery = hasProductSearchQuery(query);

  const allergenOptions = useMemo(() => {
    const counters = new Map<string, number>();
    ALLERGEN_OPTIONS.forEach((name) => counters.set(normalize(name), 0));

    searchMatchedProducts.forEach((product) => {
      product.allergens.forEach((allergen) => {
        const key = normalize(allergen);
        if (counters.has(key)) {
          counters.set(key, (counters.get(key) ?? 0) + 1);
        }
      });
    });

    return ALLERGEN_OPTIONS.map((name) => {
      const id = normalize(name);
      const count = counters.get(id) ?? 0;
      return { id, name, count };
    }).filter((option) => option.count > 0);
  }, [searchMatchedProducts]);

  const categoryItems = useMemo(() => {
    return categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        productCount: filteredProducts.filter((product) => product.categoryId === category.id)
          .length,
      }))
      .filter((category) => category.productCount > 0);
  }, [categories, filteredProducts]);

  const productItems = useMemo(() => {
    const visibleProducts = hasSearchQuery
      ? filteredProducts
      : selectedCategory
        ? filteredProducts.filter((product) => product.categoryId === selectedCategory.id)
        : [];
    return hasSearchQuery
      ? [...visibleProducts].sort((a, b) => a.name.localeCompare(b.name, "it"))
      : sortMenuProductsBySection(visibleProducts, products);
  }, [filteredProducts, hasSearchQuery, products, selectedCategory]);

  const stage: MenuStage = selectedProduct
    ? "product-detail"
    : hasSearchQuery
      ? "search-results"
      : selectedCategory
        ? "products"
        : "categories";
  const canGoBack = stage !== "categories";

  const goBack = () => {
    if (selectedProduct) {
      setNavDirection("backward");
      setSelectedProductId(null);
      setFilterOpen(false);
      return;
    }
    if (stage === "search-results") {
      setQuery("");
      setFilterOpen(false);
      return;
    }
    if (selectedCategory) {
      setNavDirection("backward");
      setSelectedCategoryId(null);
      setFilterOpen(false);
      return;
    }
  };

  const edgeBackBind = useMenuEdgeBack(canGoBack, goBack);

  const stageTitle = (() => {
    if (stage === "categories") return "Categorie";
    if (stage === "search-results") return "Risultati ricerca";
    if (stage === "products") return selectedCategory?.name ?? "Prodotti";
    return selectedProduct?.name ?? "Scheda Prodotto";
  })();

  const stageKey = `${stage}:${selectedCategoryId ?? "none"}:${selectedProductId ?? "none"}`;

  const readMenuProductScrollState = () => {
    let parsed: Partial<MenuProductScrollState> | null = null;
    try {
      const raw = readSessionPreference(MENU_PRODUCT_SCROLL_KEY);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !Number.isFinite(Number(parsed.savedAt))) return null;
    if (Date.now() - Number(parsed.savedAt) > MENU_PRODUCT_SCROLL_MAX_AGE_MS) {
      clearMenuProductScrollState();
      return null;
    }
    return parsed as MenuProductScrollState;
  };

  const writeMenuProductScrollState = (state: MenuProductScrollState) => {
    try {
      writeSessionPreference(MENU_PRODUCT_SCROLL_KEY, JSON.stringify(state));
    } catch {
      // ignore storage failures
    }
  };

  const clearMenuProductScrollState = () => {
    try {
      removeSessionPreference(MENU_PRODUCT_SCROLL_KEY);
    } catch {
      // ignore storage failures
    }
  };

  const saveMenuProductScroll = (productId: string, row: HTMLButtonElement) => {
    const scroller = menuContentRef.current;
    const list = row.closest(".menu-product-list");
    if (!scroller || !list || !selectedCategory) return;

    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>(".menu-product-row"));
    const rowIndex = rows.indexOf(row);
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    writeMenuProductScrollState({
      savedAt: Date.now(),
      categoryTitle: normalizeMenuText(selectedCategory.name),
      productName: normalizeMenuText(productsById.get(productId)?.name),
      rowIndex,
      scrollTop: Number(scroller.scrollTop) || 0,
      rowOffset: rowRect.top - scrollerRect.top,
    });
  };

  const onOpenCategory = (categoryId: string) => {
    clearMenuProductScrollState();
    if (menuContentRef.current) {
      menuContentRef.current.scrollTop = 0;
    }
    setNavDirection("forward");
    setSelectedCategoryId(categoryId);
    setSelectedProductId(null);
    setFilterOpen(false);
  };

  const onOpenProduct = (productId: string, row: HTMLButtonElement) => {
    saveMenuProductScroll(productId, row);
    setNavDirection("forward");
    setSelectedProductId(productId);
    setFilterOpen(false);
  };

  useEffect(() => {
    if (stage === "categories") {
      clearMenuProductScrollState();
      return;
    }
    if (stage !== "products") return;

    const state = readMenuProductScrollState();
    if (!state) return;
    const currentTitle = normalizeMenuText(selectedCategory?.name);
    if (state.categoryTitle && currentTitle && state.categoryTitle !== currentTitle) return;

    if (restoreTimerRef.current !== null) {
      window.clearInterval(restoreTimerRef.current);
    }

    let attempts = 0;
    let firstAppliedAt = 0;
    restoreTimerRef.current = window.setInterval(() => {
      attempts += 1;
      const scroller = menuContentRef.current;
      const activeState = readMenuProductScrollState();
      if (!scroller || !activeState) {
        if (restoreTimerRef.current !== null) {
          window.clearInterval(restoreTimerRef.current);
          restoreTimerRef.current = null;
        }
        return;
      }

      const rows = Array.from(scroller.querySelectorAll<HTMLButtonElement>(".menu-product-row"));
      const targetRow =
        rows.find(
          (row) =>
            normalizeMenuText(row.querySelector(".menu-product-name")?.textContent) ===
            activeState.productName
        ) ??
        rows[activeState.rowIndex] ??
        null;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      let desiredTop = Number(activeState.scrollTop);
      const rowOffset = Number(activeState.rowOffset);
      if (targetRow && Number.isFinite(rowOffset)) {
        desiredTop =
          targetRow.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop -
          rowOffset;
      }
      desiredTop = Math.min(maxScroll, Math.max(0, Number.isFinite(desiredTop) ? desiredTop : 0));
      if (Math.abs(scroller.scrollTop - desiredTop) > 1) {
        scroller.scrollTop = desiredTop;
      }
      if (!firstAppliedAt) firstAppliedAt = Date.now();
      if (firstAppliedAt && Date.now() - firstAppliedAt > 700) {
        clearMenuProductScrollState();
      }
      if (attempts >= MENU_PRODUCT_SCROLL_RESTORE_ATTEMPTS || !readMenuProductScrollState()) {
        if (restoreTimerRef.current !== null) {
          window.clearInterval(restoreTimerRef.current);
          restoreTimerRef.current = null;
        }
      }
    }, MENU_PRODUCT_SCROLL_RESTORE_INTERVAL_MS);

    return () => {
      if (restoreTimerRef.current !== null) {
        window.clearInterval(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
    };
  }, [productItems.length, selectedCategory?.name, stage]);

  return (
    <GlassCard className="home-card workspace-card menu-workspace-card">
      <div className="card-body menu-card-body">
        <div className="menu-browser" {...edgeBackBind}>
          <div className="menu-browser-head">
            <div className="menu-nav-row">
              {canGoBack ? (
                <button type="button" className="menu-back-btn" onClick={goBack}>
                  <img
                    src="/mobile/assets/menu-back-indietro.png"
                    alt=""
                    className="menu-back-icon"
                    aria-hidden="true"
                  />
                  Indietro
                </button>
              ) : (
                <span className="menu-nav-spacer" aria-hidden="true" />
              )}
              <div className="menu-stage-title-wrap">
                <div className="menu-stage-title">{stageTitle}</div>
              </div>
            </div>

            {stage !== "product-detail" && (
              <MenuFilterBar
                query={query}
                onQueryChange={setQuery}
                filterOpen={filterOpen}
                onToggleFilter={() => setFilterOpen((prev) => !prev)}
                onCloseFilter={() => setFilterOpen(false)}
                allergens={allergenOptions}
                excludedAllergens={excludedAllergens}
                availability={availabilityOptions}
                hiddenAvailability={hiddenAvailability}
                searchInIngredients={searchInIngredients}
                onApplyExcludedAllergens={setExcludedAllergens}
                onApplyHiddenAvailability={setHiddenAvailability}
                onApplySearchInIngredients={setSearchInIngredients}
                onReset={() => {
                  setQuery("");
                  setExcludedAllergens([]);
                  setHiddenAvailability([]);
                  setSearchInIngredients(false);
                }}
              />
            )}
          </div>

          <div className="menu-browser-content" ref={menuContentRef}>
            {catalogQuery.isLoading && (
              <div className="menu-empty-state">Caricamento menu in corso...</div>
            )}
            {catalogQuery.isError && (
              <div className="menu-empty-state">
                Errore durante il caricamento del menu. Riprova.
              </div>
            )}
            {!catalogQuery.isLoading && !catalogQuery.isError && catalogQuery.data?.catalog && (
              <div key={stageKey} className={`menu-stage menu-stage-${navDirection} is-${stage}`}>
                {stage === "categories" && (
                  <MenuCategoryList
                    categories={categoryItems}
                    showStationBadges={showStationBadges}
                    onSelect={onOpenCategory}
                  />
                )}
                {(stage === "products" || stage === "search-results") && (
                  <MenuProductList
                    products={productItems}
                    showSectionDividers={stage === "products"}
                    onSelect={onOpenProduct}
                  />
                )}
                {stage === "product-detail" && selectedProduct && selectedCategory && (
                  <div className="menu-product-detail-scroll">
                    <MenuProductDetail
                      product={selectedProduct}
                      categoryName={selectedCategory.name}
                      departmentName={selectedDepartment?.name ?? "Non indicato"}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
