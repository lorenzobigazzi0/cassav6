function itemMatchesCorrectionLineId(item, lineId) {
  const safeLineId = String(lineId ?? "").trim();
  if (!item || !safeLineId) return false;
  const itemLineId = String(item.lineId ?? "").trim();
  if (itemLineId && itemLineId === safeLineId) return true;
  const itemId = String(item.id ?? "").trim();
  return !itemLineId && itemId && itemId === safeLineId;
}

function readEffectiveItemUnitPrice(item, fallback = 0) {
  const applied = Number(item?.unitPriceApplied);
  if (
    Number.isFinite(applied) &&
    applied >= 0 &&
    (applied > 0 || item?.priceOverrideApplied === true)
  ) {
    return applied;
  }
  const list = Number(item?.listPriceAtTime);
  return Number.isFinite(list) && list >= 0 ? list : fallback;
}

function findMenuProductForAddedItem(db, item, helpers) {
  const product = helpers.resolveMenuProductForPayload(db, item);
  const requestedPrice = Number(item?.unitPrice ?? item?.price);
  if (product) {
    return Number.isFinite(requestedPrice) && requestedPrice >= 0
      ? { ...product, price: helpers.roundMoney(requestedPrice) }
      : product;
  }
  const productId = String(item?.productId ?? "").trim();
  const productName = String(item?.productName ?? item?.name ?? "").trim();
  if (!productId && !productName) return null;
  return {
    id: productId || helpers.slugifyId(productName, "product"),
    name: productName || productId,
    price: Number(item?.unitPrice ?? item?.price) || 0,
  };
}

export function applyOrderCorrectionItemChanges({
  db,
  currentOrder,
  payload,
  options = {},
  helpers,
}) {
  const {
    HttpError,
    clampInt,
    cloneJson,
    makeIntegrationOrderItemFromProduct,
    nextIntegrationOrderLineId,
    normalizeCorrectionReason,
    nowIso,
    roundMoney,
  } = helpers;
  let nextItems = currentOrder.items.map((item) => ({ ...item }));
  const addedItems = [];
  const removedItems = [];
  const changedItems = [];
  const preserveRemovedItems = options.preserveRemovedItems === true;
  const removedAt =
    typeof options.removedAt === "string" && options.removedAt.trim().length > 0
      ? options.removedAt.trim()
      : nowIso();
  const removedBy =
    typeof options.removedBy === "string" && options.removedBy.trim().length > 0
      ? options.removedBy.trim()
      : "";
  const correctionReason = normalizeCorrectionReason(
    options.reason ?? payload.reason ?? "",
  );

  for (const raw of Array.isArray(payload.removedItems)
    ? payload.removedItems
    : []) {
    const lineId = String(raw?.lineId ?? "").trim();
    if (!lineId) continue;
    const qtyToRemove = clampInt(raw?.quantity ?? raw?.qty, 1, 999, 1);
    const matching = nextItems.filter(
      (item) => itemMatchesCorrectionLineId(item, lineId) && !item.voidedAt,
    );
    if (!matching.length) {
      throw new HttpError(400, "Riga da rimuovere non trovata.");
    }
    const removeCount = Math.min(qtyToRemove, matching.length);
    let removed = 0;
    if (preserveRemovedItems) {
      nextItems = nextItems.map((item) => {
        if (
          !itemMatchesCorrectionLineId(item, lineId) ||
          item.voidedAt ||
          removed >= removeCount
        ) {
          return item;
        }
        removed += 1;
        return {
          ...item,
          done: false,
          doneQty: 0,
          voidedAt: item.voidedAt || removedAt,
          voidedBy: item.voidedBy || removedBy || null,
          correctionStatus: "removed",
          correctionReason,
          voidReason: correctionReason,
        };
      });
    } else {
      nextItems = nextItems.filter((item) => {
        if (
          !itemMatchesCorrectionLineId(item, lineId) ||
          item.voidedAt ||
          removed >= removeCount
        ) {
          return true;
        }
        removed += 1;
        return false;
      });
    }
    const sample = matching[0];
    const unitPrice = roundMoney(
      Math.max(
        readEffectiveItemUnitPrice(sample, Number(raw?.unitPrice) || 0),
        0,
      ),
    );
    removedItems.push({
      lineId,
      productId: String(sample.productId ?? raw?.productId ?? "").trim(),
      productName: String(
        sample.productNameSnapshot ?? sample.name ?? raw?.productName ?? "",
      ).trim(),
      quantity: removeCount,
      unitPrice,
      lineTotal: roundMoney(unitPrice * removeCount),
      preservedInOrder: preserveRemovedItems,
    });
  }

  for (const raw of Array.isArray(payload.changedItems)
    ? payload.changedItems
    : []) {
    const lineId = String(raw?.lineId ?? "").trim();
    if (!lineId) continue;
    const matching = nextItems.filter(
      (item) => itemMatchesCorrectionLineId(item, lineId) && !item.voidedAt,
    );
    if (!matching.length) {
      throw new HttpError(400, "Riga da modificare non trovata.");
    }
    const matchingUnits = matching.flatMap((item) =>
      Array.from(
        { length: Math.max(Math.trunc(Number(item?.qty) || 1), 1) },
        (_, unitOffset) => ({ item, unitOffset }),
      ),
    );
    const nextQuantity = clampInt(
      raw?.nextQuantity ?? raw?.quantity ?? raw?.qty,
      1,
      999,
      matchingUnits.length,
    );
    const sample = matching[0];
    const previousQuantity = matchingUnits.length;
    const nextVariant = String(
      raw?.nextVariant ??
        raw?.variant ??
        raw?.variantName ??
        sample.variant ??
        "",
    ).trim();
    const nextModifiers =
      raw?.nextModifiers && typeof raw.nextModifiers === "object"
        ? cloneJson(raw.nextModifiers, {})
        : cloneJson(sample.variants, {});
    const requestedUnitPrice = Number(
      raw?.nextUnitPrice ?? raw?.unitPrice ?? raw?.unitPriceApplied,
    );
    const nextUnitPrices = Array.isArray(raw?.nextUnitPrices)
      ? raw.nextUnitPrices.map((value) => Number(value))
      : null;
    if (
      nextUnitPrices &&
      (nextUnitPrices.length !== nextQuantity ||
        nextUnitPrices.some((value) => !Number.isFinite(value) || value < 0))
    ) {
      throw new HttpError(
        400,
        "Ripartizione prezzi unita non valida per la riga da modificare.",
        { code: "INVALID_CORRECTION_UNIT_PRICES" },
      );
    }
    const previousUnitPrice = roundMoney(
      Math.max(readEffectiveItemUnitPrice(sample), 0),
    );
    const normalizedUnitPrices = nextUnitPrices
      ? nextUnitPrices.map((value) => roundMoney(value))
      : null;
    const nextUnitPrice = normalizedUnitPrices
      ? normalizedUnitPrices[0]
      : Number.isFinite(requestedUnitPrice)
        ? roundMoney(Math.max(requestedUnitPrice, 0))
        : previousUnitPrice;
    const preparedCount = Math.min(
      nextQuantity,
      matchingUnits.filter(
        ({ item, unitOffset }) =>
          item?.done === true ||
          Math.max(Math.trunc(Number(item?.doneQty) || 0), 0) > unitOffset,
      ).length,
    );
    const firstMatchingIndex = nextItems.findIndex(
      (item) => itemMatchesCorrectionLineId(item, lineId) && !item.voidedAt,
    );
    const matchingSet = new Set(matching);
    const retainedItems = nextItems.filter((item) => !matchingSet.has(item));
    const usedItemIds = new Set(
      retainedItems
        .map((item) => String(item?.id ?? "").trim())
        .filter(Boolean),
    );
    const replacementItems = [];
    for (let index = 0; index < nextQuantity; index += 1) {
      const sourceUnit =
        matchingUnits[index] ?? matchingUnits[matchingUnits.length - 1];
      const sourceItem = sourceUnit?.item ?? sample;
      const sourcePrepared =
        sourceItem?.done === true ||
        Math.max(Math.trunc(Number(sourceItem?.doneQty) || 0), 0) >
          (sourceUnit?.unitOffset ?? 0);
      let nextItemId =
        index < matchingUnits.length && (sourceUnit?.unitOffset ?? 0) === 0
          ? String(sourceItem?.id ?? "").trim()
          : "";
      let itemIdIndex = retainedItems.length + replacementItems.length + 1;
      while (!nextItemId || usedItemIds.has(nextItemId)) {
        nextItemId = `oi_${itemIdIndex}`;
        itemIdIndex += 1;
      }
      usedItemIds.add(nextItemId);
      const unitPrice = normalizedUnitPrices?.[index] ?? nextUnitPrice;
      const listPriceAtTime = normalizedUnitPrices
        ? roundMoney(
            Math.max(
              Number(sourceItem?.listPriceAtTime) ||
                Number(sample?.listPriceAtTime) ||
                unitPrice,
              0,
            ),
          )
        : unitPrice;
      replacementItems.push({
        ...sourceItem,
        id: nextItemId,
        lineId:
          String(sourceItem?.lineId ?? sample.lineId ?? "").trim() || lineId,
        qty: 1,
        done:
          index < matchingUnits.length ? sourcePrepared : index < preparedCount,
        doneQty:
          index < matchingUnits.length
            ? sourcePrepared
              ? 1
              : 0
            : index < preparedCount
              ? 1
              : 0,
        unitPriceApplied: unitPrice,
        listPriceAtTime,
        priceOverrideApplied:
          normalizedUnitPrices !== null || Number.isFinite(requestedUnitPrice),
        notes: String(
          raw?.nextNotes ?? sourceItem?.notes ?? sourceItem?.note ?? "",
        ).trim(),
        note: String(
          raw?.nextNotes ?? sourceItem?.note ?? sourceItem?.notes ?? "",
        ).trim(),
        variants: nextModifiers,
        variant: nextVariant,
        selectedVariantName: nextVariant || null,
        lineTotal: unitPrice,
        finalLinePrice: unitPrice,
      });
    }
    retainedItems.splice(
      Math.max(0, Math.min(firstMatchingIndex, retainedItems.length)),
      0,
      ...replacementItems,
    );
    nextItems = retainedItems;
    changedItems.push({
      lineId,
      productId: String(sample.productId ?? raw?.productId ?? "").trim(),
      productName: String(
        sample.productNameSnapshot ?? sample.name ?? raw?.productName ?? "",
      ).trim(),
      previousQuantity,
      nextQuantity,
      previousNotes: String(sample.notes ?? sample.note ?? "").trim(),
      nextNotes: String(
        raw?.nextNotes ?? sample.notes ?? sample.note ?? "",
      ).trim(),
      previousVariant: String(
        sample.variant ?? sample.selectedVariantName ?? "",
      ).trim(),
      nextVariant,
      previousModifiers: cloneJson(sample.variants, {}),
      nextModifiers,
      previousUnitPrice,
      nextUnitPrice,
      previousUnitPrices: matchingUnits.map(({ item }) =>
        roundMoney(Math.max(readEffectiveItemUnitPrice(item), 0)),
      ),
      ...(normalizedUnitPrices ? { nextUnitPrices: normalizedUnitPrices } : {}),
      previousPreparedQuantity: matching.filter(
        (item) =>
          item?.done === true ||
          Math.max(Math.trunc(Number(item?.doneQty) || 0), 0) > 0,
      ).length,
      nextPreparedQuantity: preparedCount,
    });
  }

  for (const raw of Array.isArray(payload.addedItems)
    ? payload.addedItems
    : []) {
    const product = findMenuProductForAddedItem(db, raw, helpers);
    if (!product) {
      throw new HttpError(400, "Prodotto da aggiungere non valido.");
    }
    const quantity = clampInt(raw?.quantity ?? raw?.qty, 1, 999, 1);
    const lineId = nextIntegrationOrderLineId({ items: nextItems });
    for (let index = 0; index < quantity; index += 1) {
      nextItems.push(
        makeIntegrationOrderItemFromProduct({
          id: `oi_${nextItems.length + 1}`,
          lineId,
          product,
          quantity: 1,
          unitPrice: product.price,
          note: raw?.notes ?? raw?.note,
          modifiers: raw?.modifiers,
        }),
      );
    }
    addedItems.push({
      lineId,
      productId: String(product.id ?? raw?.productId ?? "").trim(),
      productName: String(
        product.name ?? raw?.productName ?? raw?.name ?? "",
      ).trim(),
      quantity,
      notes: String(raw?.notes ?? raw?.note ?? "").trim(),
      modifiers:
        raw?.modifiers && typeof raw.modifiers === "object"
          ? cloneJson(raw.modifiers, {})
          : {},
    });
  }

  if (
    !options.allowNoItemChanges &&
    !addedItems.length &&
    !removedItems.length &&
    !changedItems.length
  ) {
    throw new HttpError(400, "Nessuna modifica da applicare.", {
      code: "NO_CORRECTION_CHANGES",
    });
  }

  return { nextItems, addedItems, removedItems, changedItems };
}
