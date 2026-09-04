function text(value) {
  return String(value ?? "").trim();
}

function positiveRevision(value, fallback = 0) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function itemCorrectionMarker(item) {
  if (!item || typeof item !== "object") return null;
  const correctionStatus = text(item.correctionStatus);
  const correctionId = text(item.correctionId);
  const voidedAt = text(item.voidedAt ?? item.cancelledAt ?? item.canceledAt);
  if (!correctionStatus && !correctionId && !voidedAt) return null;
  return {
    lineId: text(item.lineId ?? item.id),
    correctionId,
    correctionStatus,
    voidedAt,
  };
}

function markerKey(marker) {
  return [
    marker?.lineId ?? "",
    marker?.correctionId ?? "",
    marker?.correctionStatus ?? "",
    marker?.voidedAt ?? "",
  ].join("|");
}

export function buildOrderCorrectionReadModel(order) {
  const safeOrder = order && typeof order === "object" ? order : {};
  const markers = (Array.isArray(safeOrder.items) ? safeOrder.items : [])
    .map(itemCorrectionMarker)
    .filter(Boolean);
  const lastCorrectionId = text(safeOrder.lastCorrectionId);
  return {
    hasCorrections: Boolean(lastCorrectionId || markers.length > 0),
    lastCorrectionId,
    correctedItemCount: markers.length,
    markers,
  };
}

export function hasOrderCorrectionReadModel(order) {
  return buildOrderCorrectionReadModel(order).hasCorrections;
}

export function shouldPreferRelationalOrderCorrectionReadModel(appOrder, relationalOrder) {
  if (!relationalOrder?.id) return false;
  const appRevision = positiveRevision(appOrder?.revision ?? appOrder?.currentRevision);
  const relationalRevision = positiveRevision(
    relationalOrder.revision ?? relationalOrder.currentRevision,
  );
  if (relationalRevision > appRevision) return true;
  if (relationalRevision !== appRevision) return false;

  const relationalModel = buildOrderCorrectionReadModel(relationalOrder);
  if (!relationalModel.hasCorrections) return false;

  const appModel = buildOrderCorrectionReadModel(appOrder);
  if (!appModel.hasCorrections) return true;
  if (
    relationalModel.lastCorrectionId &&
    relationalModel.lastCorrectionId !== appModel.lastCorrectionId
  ) {
    return true;
  }
  if (relationalModel.correctedItemCount > appModel.correctedItemCount) {
    return true;
  }

  const appMarkerKeys = new Set(appModel.markers.map(markerKey));
  return relationalModel.markers.some((marker) => !appMarkerKeys.has(markerKey(marker)));
}
