export function buildCorrectionPrintAnnotations(correctionRecord) {
  const addedByLineId = new Map();
  const changedByLineId = new Map();
  const removedLines = [];
  const safeRecord = correctionRecord && typeof correctionRecord === "object" ? correctionRecord : {};

  (Array.isArray(safeRecord.addedItems) ? safeRecord.addedItems : []).forEach((item) => {
    const lineId = String(item?.lineId ?? "").trim();
    if (lineId) addedByLineId.set(lineId, item);
  });

  (Array.isArray(safeRecord.changedItems) ? safeRecord.changedItems : []).forEach((item) => {
    const lineId = String(item?.lineId ?? "").trim();
    if (lineId) changedByLineId.set(lineId, item);
  });

  (Array.isArray(safeRecord.removedItems) ? safeRecord.removedItems : []).forEach((item, index) => {
    const lineId = String(item?.lineId ?? `removed_${index + 1}`).trim() || `removed_${index + 1}`;
    removedLines.push({
      lineId,
      productId: String(item?.productId ?? "").trim() || null,
      productNameSnapshot: String(item?.productName ?? item?.productId ?? item?.lineId ?? "Articolo").trim() || "Articolo",
      qty: Math.max(1, Math.trunc(Number(item?.quantity ?? item?.qty) || 1)),
      unitPriceApplied: 0,
      listPriceAtTime: 0,
      lineTotal: 0,
      variants: {},
      selectedVariantId: null,
      selectedVariantName: null,
      selectedVariantPriceDelta: 0,
      finalLinePrice: 0,
      notes: "",
      allergens: [],
      routeStations: [],
      correctionStatus: "removed",
    });
  });

  return { addedByLineId, changedByLineId, removedLines };
}
