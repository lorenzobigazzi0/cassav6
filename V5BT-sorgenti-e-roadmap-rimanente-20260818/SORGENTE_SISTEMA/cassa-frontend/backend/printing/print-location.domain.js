export function createPrintLocationHelpers(options = {}) {
  const {
    findPosRoomById = () => null,
    formatIntegrationPrintDisplayName = (value) => String(value ?? "").trim(),
    formatIntegrationPrintOrderId = (value) => `#${String(value ?? "").trim() || "-"}`,
    sanitizeIntegrationOrder = (order) => (order && typeof order === "object" ? order : {}),
    sanitizeIntegrationTableLabel = (value) => String(value ?? "").trim(),
    toPrintSafeUppercase = (value) => String(value ?? "").trim().toLocaleUpperCase("it-IT"),
  } = options;

  function buildPrecontoReferenceLabel(rawValue, fallback = "BANCO") {
    const raw = String(rawValue ?? "").trim();
    if (raw.replace(/\D/g, "")) {
      return formatIntegrationPrintOrderId(raw);
    }
    return fallback;
  }

  function buildPrecontoLocationLabel(tableNumber, roomLabel) {
    const safeTableNumber = String(tableNumber ?? "").trim();
    const safeRoomLabel = String(roomLabel ?? "").trim();
    if (safeTableNumber && safeRoomLabel) {
      return `TAV. ${safeTableNumber} ${safeRoomLabel}`;
    }
    if (safeTableNumber) {
      return `TAV. ${safeTableNumber}`;
    }
    return safeRoomLabel;
  }

  function resolvePrintRoomLabel(settings, roomId, fallback = "") {
    const room = roomId && settings ? findPosRoomById(settings, roomId) : null;
    const rawRoomName =
      String(room?.name ?? fallback ?? "").trim() ||
      (roomId ? formatIntegrationPrintDisplayName(roomId) : "");
    return toPrintSafeUppercase(formatIntegrationPrintDisplayName(rawRoomName));
  }

  function resolvePrintTableDisplayLabelFromOrder(order) {
    const safeOrder = order && typeof order === "object" ? order : {};
    const logicalTableLabel = sanitizeIntegrationTableLabel(
      safeOrder.tableLabel ?? safeOrder.logicalTableLabel
    );
    if (logicalTableLabel) return logicalTableLabel;
    if (Number.isFinite(Number(safeOrder.tableNumber)) && Number(safeOrder.tableNumber) > 0) {
      return String(Math.trunc(Number(safeOrder.tableNumber)));
    }
    if (Number.isFinite(Number(safeOrder.table)) && Number(safeOrder.table) > 0) {
      return String(Math.trunc(Number(safeOrder.table)));
    }
    return "";
  }

  function buildPrintLocationLabel({ tableLabel = "", tableNumber = "", roomLabel = "" } = {}) {
    const safeTableLabel = sanitizeIntegrationTableLabel(tableLabel) || String(tableNumber ?? "").trim();
    const safeRoomLabel = toPrintSafeUppercase(formatIntegrationPrintDisplayName(roomLabel));
    return buildPrecontoLocationLabel(safeTableLabel, safeRoomLabel);
  }

  function buildIntegrationOrderLocationLabel(order, settings = null, fallbackRoomName = "") {
    const safeOrder = sanitizeIntegrationOrder(order, String(order?.id ?? "order").trim() || "order");
    const roomLabel = resolvePrintRoomLabel(
      settings,
      safeOrder.roomId,
      fallbackRoomName || safeOrder.roomName || safeOrder.station || safeOrder.ownerStation
    );
    return buildPrintLocationLabel({
      tableLabel: resolvePrintTableDisplayLabelFromOrder(safeOrder),
      roomLabel,
    });
  }

  function buildTableLocationLabel(table, roomId, settings = null, fallbackRoomName = "") {
    const safeTable = table && typeof table === "object" ? table : {};
    const tableLabel = sanitizeIntegrationTableLabel(safeTable.tableLabel ?? safeTable.logicalTableLabel) ||
      (Number.isFinite(Number(safeTable.number)) && Number(safeTable.number) > 0
        ? String(Math.trunc(Number(safeTable.number)))
        : String(safeTable.id ?? "").trim());
    const roomLabel = resolvePrintRoomLabel(settings, roomId, fallbackRoomName);
    return buildPrintLocationLabel({ tableLabel, roomLabel });
  }

  return {
    buildIntegrationOrderLocationLabel,
    buildPrecontoLocationLabel,
    buildPrecontoReferenceLabel,
    buildPrintLocationLabel,
    buildTableLocationLabel,
    resolvePrintRoomLabel,
    resolvePrintTableDisplayLabelFromOrder,
  };
}
