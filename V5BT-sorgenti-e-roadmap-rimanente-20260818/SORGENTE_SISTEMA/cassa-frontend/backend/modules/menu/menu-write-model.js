/**
 * Write model delle impostazioni menu (P2b, dominio `catalog`).
 *
 * `resolvePosMenuSettings` porta dentro entrambi i rami della route
 * `settings.menu`: senza `items` nel payload la route si comporta da lettura e
 * ritorna presto, altrimenti verifica `manage_menu` e scrive. I due rami sono
 * la stessa route e restano una sola funzione.
 *
 * `validateSessionContext` resta qui dentro: su sessione scaduta rimuove la
 * sessione, registra l'audit e aggiorna `meta.lastWriteAt` in memoria prima di
 * sollevare 401, quindi non e una lettura pura.
 */
import { buildMenuSettingsPayload } from "./menu.handlers.js";

export function createMenuWriteModel({
  HttpError,
  appendAuditEvent,
  buildAuditActor,
  hasPermission,
  normalizeMenuItem,
  normalizeMenuItemVariants,
  nowIso,
  publishIntegrationNotificationStreamRefresh,
  readDb,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizeMenuItem,
  sanitizePosSettings,
  touchSettingsMetadata,
  validateSessionContext,
  writeDb,
}) {
  function publishMenuSettingsUpdated(db) {
    if (typeof publishIntegrationNotificationStreamRefresh !== "function")
      return;
    const lastWriteAt = resolveSettingsLastWriteAt(db?.meta);
    const version = resolveSettingsVersion(db?.meta);
    publishIntegrationNotificationStreamRefresh("settings_updated", {
      source: "menu-settings",
      lastWriteAt,
      version,
      settingsVersion: version,
    });
  }

  async function resolvePosMenuSettings(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);

    if (!Array.isArray(payload.items)) {
      const settings = sanitizePosSettings(db.posSettings, { menuItems: db.menuItems, users: db.users });
      return buildMenuSettingsPayload({
        db,
        settings,
        sanitizeMenuItem,
        resolveSettingsLastWriteAt,
        resolveSettingsVersion,
      });
    }

    if (!hasPermission(user, "manage_menu")) {
      throw new HttpError(403, "Utente non autorizzato alla gestione menu.");
    }

    const requestedItems = payload.items;
    const nextItems = [];
    const now = nowIso();
    const existingById = new Map(
      db.menuItems.map((entry) => [String(entry?.id ?? "").trim(), entry]).filter(([id]) => id.length > 0)
    );
    const seenIds = new Set();
    const seenNames = new Set();

    for (let index = 0; index < requestedItems.length; index += 1) {
      const rawItem = requestedItems[index];
      if (!rawItem || typeof rawItem !== "object") {
        throw new HttpError(400, `Voce menu #${index + 1} non valida.`);
      }

      const normalizedName = String(rawItem.name ?? "").trim();
      const normalizedCategory = String(rawItem.category ?? "Altro").trim() || "Altro";
      const normalizedPrice = Number(rawItem.price);
      const normalizedIdRaw = String(rawItem.id ?? "").trim();
      const normalizedEnabled = rawItem.enabled !== false;
      const normalizedSection = String(rawItem.section ?? rawItem.subcategory ?? "").trim().slice(0, 48);
      const normalizedType =
        String(rawItem.type ?? rawItem.kind ?? "").trim().toLowerCase() === "divider"
          ? "divider"
          : "";
      const normalizedImageUrl =
        typeof rawItem.imageUrl === "string" && rawItem.imageUrl.trim()
          ? rawItem.imageUrl.trim()
          : null;
      const normalizedDescription =
        typeof rawItem.description === "string"
          ? rawItem.description
          : typeof rawItem.desc === "string"
            ? rawItem.desc
            : undefined;
      const normalizedIngredients =
        rawItem.ingredients !== undefined
          ? rawItem.ingredients
          : rawItem.ingredienti !== undefined
            ? rawItem.ingredienti
            : undefined;
      const normalizedDepartment =
        typeof rawItem.department === "string"
          ? rawItem.department.trim()
          : typeof rawItem.reparto === "string"
            ? rawItem.reparto.trim()
            : undefined;
      const normalizedReparto =
        typeof rawItem.reparto === "string"
          ? rawItem.reparto.trim()
          : typeof rawItem.department === "string"
            ? rawItem.department.trim()
            : undefined;
      const normalizedVatRate =
        rawItem.vatRate !== undefined
          ? rawItem.vatRate
          : rawItem.iva !== undefined
            ? rawItem.iva
            : rawItem.taxRate;
      const normalizedVatCode =
        rawItem.vatCode !== undefined
          ? rawItem.vatCode
          : rawItem.ivaCode !== undefined
            ? rawItem.ivaCode
            : rawItem.taxCode;

      if (!normalizedName) {
        throw new HttpError(400, `Nome mancante per articolo #${index + 1}.`);
      }
      if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
        throw new HttpError(400, `Prezzo non valido per articolo \"${normalizedName}\".`);
      }

      const normalizedId = normalizedIdRaw || `menu_item_${index + 1}`;
      if (seenIds.has(normalizedId)) {
        throw new HttpError(400, `ID articolo duplicato: ${normalizedId}.`);
      }

      const existing = existingById.get(normalizedId);
      const effectiveSection =
        rawItem.section !== undefined || rawItem.subcategory !== undefined
          ? normalizedSection
          : String(existing?.section ?? existing?.subcategory ?? "").trim().slice(0, 48);
      const effectiveType =
        rawItem.type !== undefined || rawItem.kind !== undefined
          ? normalizedType
          : String(existing?.type ?? existing?.kind ?? "").trim().toLowerCase() === "divider"
            ? "divider"
            : "";
      const effectiveImageUrl =
        rawItem.imageUrl !== undefined
          ? normalizedImageUrl
          : typeof existing?.imageUrl === "string" && existing.imageUrl.trim()
            ? existing.imageUrl.trim()
            : null;
      const effectiveDescription =
        normalizedDescription !== undefined
          ? normalizedDescription
          : typeof existing?.description === "string"
            ? existing.description
            : typeof existing?.desc === "string"
              ? existing.desc
              : "";
      const effectiveIngredients =
        normalizedIngredients !== undefined
          ? normalizedIngredients
          : existing?.ingredients !== undefined
            ? existing.ingredients
            : existing?.ingredienti;
      const effectiveDepartment =
        normalizedDepartment !== undefined
          ? normalizedDepartment
          : typeof existing?.department === "string"
            ? existing.department.trim()
            : typeof existing?.reparto === "string"
              ? existing.reparto.trim()
              : "";
      const effectiveReparto =
        normalizedReparto !== undefined
          ? normalizedReparto
          : typeof existing?.reparto === "string"
            ? existing.reparto.trim()
            : typeof existing?.department === "string"
              ? existing.department.trim()
              : "";
      const effectivePriceSchedule =
        rawItem.priceSchedule !== undefined
          ? rawItem.priceSchedule
          : rawItem.timedPrices !== undefined
            ? rawItem.timedPrices
            : rawItem.timePriceSchedule !== undefined
              ? rawItem.timePriceSchedule
              : existing?.priceSchedule;
      const normalizedVariants = Array.isArray(rawItem.variants)
        ? normalizeMenuItemVariants(rawItem.variants)
        : normalizeMenuItemVariants(existing?.variants);
      const normalizedVariantRequired =
        normalizedVariants.length > 0 &&
        (rawItem.variantRequired === true ||
          rawItem.requiresVariant === true ||
          (rawItem.variantRequired === undefined &&
            rawItem.requiresVariant === undefined &&
            existing?.variantRequired === true));
      const nextItem = {
        id: normalizedId,
        name: normalizedName,
        price: normalizedPrice,
        category: normalizedCategory,
        enabled: normalizedEnabled,
        imageUrl: effectiveImageUrl,
        ...(String(effectiveDescription ?? "").trim() ? { description: effectiveDescription } : {}),
        ...(effectiveIngredients !== undefined ? { ingredients: effectiveIngredients } : {}),
        ...(effectiveDepartment ? { department: effectiveDepartment } : {}),
        ...(effectiveReparto ? { reparto: effectiveReparto } : {}),
        ...(normalizedVariants.length ? { variants: normalizedVariants } : {}),
        ...(normalizedVariantRequired ? { variantRequired: true } : {}),
        ...(effectiveSection ? { section: effectiveSection } : {}),
        ...(effectiveType ? { type: effectiveType } : {}),
        ...(effectivePriceSchedule !== undefined ? { priceSchedule: effectivePriceSchedule } : {}),
        ...(normalizedVatRate !== undefined ? { vatRate: normalizedVatRate } : {}),
        ...(normalizedVatCode !== undefined ? { vatCode: normalizedVatCode } : {}),
        ...(rawItem.priceListPrices !== undefined ? { priceListPrices: rawItem.priceListPrices } : {}),
        ...(rawItem.workstationIds !== undefined ? { workstationIds: rawItem.workstationIds } : {}),
        ...(rawItem.stationIds !== undefined || rawItem.stations !== undefined
          ? { stationIds: rawItem.stationIds ?? rawItem.stations }
          : {}),
        ...(rawItem.menuIds !== undefined ? { menuIds: rawItem.menuIds } : {}),
        ...(rawItem.categoryIds !== undefined ? { categoryIds: rawItem.categoryIds } : {}),
        ...(rawItem.allergens !== undefined || rawItem.allergeni !== undefined
          ? { allergens: rawItem.allergens ?? rawItem.allergeni }
          : {}),
        ...(rawItem.tags !== undefined ? { tags: rawItem.tags } : {}),
        ...(rawItem.sku !== undefined || rawItem.code !== undefined ? { sku: rawItem.sku ?? rawItem.code } : {}),
        ...(rawItem.barcode !== undefined || rawItem.ean !== undefined ? { barcode: rawItem.barcode ?? rawItem.ean } : {}),
        ...(rawItem.unit !== undefined || rawItem.um !== undefined ? { unit: rawItem.unit ?? rawItem.um } : {}),
        createdByUserId: String(existing?.createdByUserId ?? user.id),
        createdAt: String(existing?.createdAt ?? now),
        updatedAt: now,
      };

      seenIds.add(normalizedId);
      const safeNameKey = normalizedName.toLowerCase();
      if (seenNames.has(safeNameKey)) {
        throw new HttpError(400, `Nome articolo duplicato: ${normalizedName}.`);
      }
      seenNames.add(safeNameKey);
      nextItems.push(normalizeMenuItem(nextItem, normalizedId));
    }

    const beforeById = new Map(db.menuItems.map((entry) => [String(entry.id), entry]));
    const afterById = new Map(nextItems.map((entry) => [String(entry.id), entry]));
    const auditActor = buildAuditActor(user, payload);

    db.menuItems.forEach((previous) => {
      const after = afterById.get(String(previous.id));
      if (!after) {
        appendAuditEvent(db, {
          ...auditActor,
          action: "menu.item_deleted",
          entityType: "menu_item",
          entityId: String(previous.id),
          payload: sanitizeMenuItem(previous),
          before: sanitizeMenuItem(previous),
        });
        return;
      }
      const beforeSanitized = sanitizeMenuItem(previous);
      const afterSanitized = sanitizeMenuItem(after);
      if (JSON.stringify(beforeSanitized) !== JSON.stringify(afterSanitized)) {
        appendAuditEvent(db, {
          ...auditActor,
          action: "menu.item_updated",
          entityType: "menu_item",
          entityId: String(after.id),
          payload: {
            before: beforeSanitized,
            after: afterSanitized,
          },
          before: beforeSanitized,
          after: afterSanitized,
        });
      }
    });

    nextItems.forEach((entry) => {
      const id = String(entry.id);
      const before = beforeById.get(id);
      if (!before) {
        appendAuditEvent(db, {
          ...auditActor,
          action: "menu.item_created",
          entityType: "menu_item",
          entityId: id,
          payload: sanitizeMenuItem(entry),
          after: sanitizeMenuItem(entry),
        });
      }
    });

    db.menuItems = nextItems;
    const nextPosSettings = sanitizePosSettings(
      {
        ...db.posSettings,
        menus: payload.menus ?? db.posSettings?.menus,
        areaMenus: payload.areaMenus ?? db.posSettings?.areaMenus,
        priceLists: payload.priceLists ?? db.posSettings?.priceLists,
        priceListSchedules: payload.priceListSchedules ?? db.posSettings?.priceListSchedules,
        menuSchedules: payload.menuSchedules ?? db.posSettings?.menuSchedules,
      },
      { menuItems: db.menuItems, users: db.users }
    );
    db.posSettings = {
      sideBars: nextPosSettings.sideBars,
      locale: nextPosSettings.locale,
      locales: nextPosSettings.locales,
      activities: nextPosSettings.activities,
      activityRoomBindings: nextPosSettings.activityRoomBindings,
      paymentMethods: nextPosSettings.paymentMethods,
      smartCash: nextPosSettings.smartCash,
      tables: nextPosSettings.tables,
      menus: nextPosSettings.menus,
      areaMenus: nextPosSettings.areaMenus,
      priceLists: nextPosSettings.priceLists,
      priceListSchedules: nextPosSettings.priceListSchedules,
      menuSchedules: nextPosSettings.menuSchedules,
      printers: nextPosSettings.printers,
      fiscalDevices: nextPosSettings.fiscalDevices,
      workstations: nextPosSettings.workstations,
      areas: nextPosSettings.areas,
      orderWorkflow: nextPosSettings.orderWorkflow,
      printPreferences: nextPosSettings.printPreferences,
    };
    touchSettingsMetadata(db);
    await writeDb(db);
    publishMenuSettingsUpdated(db);

    return buildMenuSettingsPayload({
      db,
      settings: nextPosSettings,
      sanitizeMenuItem,
      resolveSettingsLastWriteAt,
      resolveSettingsVersion,
    });
  }

  return {
    resolvePosMenuSettings,
  };
}
