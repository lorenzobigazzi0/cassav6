/**
 * Reader delle route di sola lettura del dominio `catalog` (P2b, MIG-032).
 *
 * Possiede l'unico accesso all'app-state per `menu.catalog`,
 * `settings.menuSuggestions`, `integration.menu` e `integration.menuTopSold`, e
 * restituisce il corpo della risposta gia composto: gli handler non vedono piu
 * `db`.
 *
 * `readIntegrationMenuView` dichiara anche *come* va inviata la risposta,
 * perche la cache veloce conserva il JSON gia serializzato: `json` per il corpo
 * gia stringa, `payload` per l'oggetto. Il handler resta il solo a scegliere fra
 * `sendJsonString` e `sendJson`, ed e l'unica differenza rispetto al codice di
 * partenza.
 *
 * `validateSessionContext` resta qui dentro: su sessione scaduta rimuove la
 * sessione, registra l'audit e aggiorna `meta.lastWriteAt` in memoria prima di
 * sollevare 401, quindi non e una lettura pura.
 */
import { applyPriceListsToMenuItems, resolveScheduledIds } from "./menu-configuration.js";
import { buildMenuCatalog, buildMenuSuggestionsPayload } from "./menu.handlers.js";

export function createMenuReadModel({
  HttpError,
  INTEGRATION_MENU_FAST_CACHE_MS,
  INTEGRATION_MENU_RESPONSE_CACHE_MAX,
  SHOW_DEMO_STATIONS,
  applyRuntimeMenuItemPrice = (item) => item,
  buildIntegrationItemAvailabilityList,
  buildIntegrationMenuCatalog,
  buildIntegrationStationStatesWithSessionRecovery,
  buildTopSoldMenuPayload,
  getActiveStations,
  hasPermission,
  integrationMenuFastResponseCache,
  integrationMenuResponseCache,
  menuPriceScheduleCacheBucket,
  menuSettingsRepository,
  nowIso,
  readDb,
  readFastJsonCache,
  resolveConfiguredIntegrationStations,
  sanitizeIntegrationItemAvailabilityMap,
  sanitizeMenuItem,
  sanitizePosSettings,
  shouldExposeMenuItemInRuntime,
  validateSessionContext,
  writeFastJsonCache,
}) {
  async function readMenuCatalogView(payload) {
    const db = await readDb();
    validateSessionContext(db, payload);
    const menuItems = menuSettingsRepository?.getMenuItems?.(db) ?? db.menuItems;
    const settings = sanitizePosSettings(db.posSettings, { menuItems, users: db.users });
    const activePriceListIds = resolveScheduledIds(settings.priceListSchedules, "priceListIds", new Date());
    const pricedMenuItems = applyPriceListsToMenuItems(menuItems, settings.priceLists, activePriceListIds);

    const catalog = buildMenuCatalog(pricedMenuItems, {
      applyRuntimeMenuItemPrice,
      sanitizeMenuItem,
      shouldExposeMenuItemInRuntime,
    });
    return {
      ok: true,
      activePriceListIds,
      categories: catalog.categories,
      items: catalog.items,
    };
  }

  async function readMenuSuggestionsView(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);

    if (!hasPermission(user, "manage_menu")) {
      throw new HttpError(403, "Utente non autorizzato alla gestione menu.");
    }

    return buildMenuSuggestionsPayload({
      db,
      threshold: payload?.threshold,
      limit: payload?.limit,
    });
  }

  async function readIntegrationMenuView({ method, requestedStation }) {
    const db = await readDb({ refreshExternalizedIntegrationStationStates: true });
    const priceScheduleBucket = menuPriceScheduleCacheBucket(db.menuItems);
    const itemAvailability = sanitizeIntegrationItemAvailabilityMap(
      db.integration?.itemAvailability,
    );
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const activePriceListIds = resolveScheduledIds(
      settings.priceListSchedules,
      "priceListIds",
      new Date(),
    );
    const runtimeMenuItems = applyPriceListsToMenuItems(
      db.menuItems,
      settings.priceLists,
      activePriceListIds,
    );
    const fastCacheKey = JSON.stringify({
      method,
      requestedStation,
      priceScheduleBucket,
      activePriceListIds,
    });
    const fastCached =
      method === "GET"
        ? readFastJsonCache(
            integrationMenuFastResponseCache,
            fastCacheKey,
            INTEGRATION_MENU_FAST_CACHE_MS,
          )
        : null;
    if (fastCached) {
      return { json: fastCached.json };
    }
    const stationStates = buildIntegrationStationStatesWithSessionRecovery(db);
    const activeStations = getActiveStations(
      { integration: { ...db.integration, stationStates } },
      { allowDemoStations: SHOW_DEMO_STATIONS },
    ).map((entry) => entry.station);
    const configuredStations = resolveConfiguredIntegrationStations(db);
    const lastWriteAt = String(db.meta?.lastWriteAt ?? nowIso());
    const version = new Date(lastWriteAt).getTime();
    const cacheKey = JSON.stringify({
      requestedStation,
      lastWriteAt,
      activeStations,
      priceScheduleBucket,
      activePriceListIds,
    });
    const cachedPayload = integrationMenuResponseCache.get(cacheKey);
    if (cachedPayload) {
      if (method === "GET") {
        const fastEntry = writeFastJsonCache(
          integrationMenuFastResponseCache,
          fastCacheKey,
          cachedPayload,
        );
        return { json: fastEntry.json };
      }
      return { payload: cachedPayload };
    }
    const integrationMenu = buildIntegrationMenuCatalog(
      runtimeMenuItems,
      itemAvailability,
      requestedStation,
      { activeStations, settings },
    );
    const responsePayload = {
      ok: true,
      version: Number.isFinite(version) ? version : Date.now(),
      lastWriteAt,
      stations: configuredStations,
      configuredStations,
      activeStations,
      activePriceListIds,
      departments: integrationMenu.departments,
      categories: integrationMenu.categories,
      products: integrationMenu.products,
      postazioneItems: integrationMenu.postazioneItems,
      itemAvailability: buildIntegrationItemAvailabilityList(
        itemAvailability,
        requestedStation,
      ),
    };
    integrationMenuResponseCache.set(cacheKey, responsePayload);
    while (
      integrationMenuResponseCache.size > INTEGRATION_MENU_RESPONSE_CACHE_MAX
    ) {
      integrationMenuResponseCache.delete(
        integrationMenuResponseCache.keys().next().value,
      );
    }
    if (method === "GET") {
      const fastEntry = writeFastJsonCache(
        integrationMenuFastResponseCache,
        fastCacheKey,
        responsePayload,
      );
      return { json: fastEntry.json };
    }
    return { payload: responsePayload };
  }

  async function readTopSoldMenuView({ days, limit }) {
    const db = await readDb();
    return buildTopSoldMenuPayload(db, { days, limit });
  }

  return {
    readIntegrationMenuView,
    readMenuCatalogView,
    readMenuSuggestionsView,
    readTopSoldMenuView,
  };
}
