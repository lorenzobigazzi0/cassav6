export function createPosBillTableNormalization(dependencies = {}) {
  const {
    DEFAULT_VIRTUAL_WAITING_ROOM_ID,
    DEFAULT_VIRTUAL_WAITING_ROOM_NAME,
    DEFAULT_VIRTUAL_WAITING_ROOM_TABLE_COUNT,
    POS_TABLE_STATUSES,
    clampInt,
    isTableWorkLockExpired,
    normalizeConfigId,
    normalizePosRoomId,
    normalizeReservation,
    normalizeSeatedAtMs,
    normalizeStringList,
    normalizeTableCovers,
    nowIso,
    pad2,
    resolveConfiguredAreaMinimumTables,
    roundMoney,
    sanitizePaymentItem,
    sanitizeTableWorkLock,
  } = dependencies;

  function normalizePosBillLine(line) {
    if (!line || typeof line !== "object") return null;

    const name = String(line.name ?? "").trim();
    const qtyRaw = Number(line.qty);
    const qty = Number.isFinite(qtyRaw) ? Math.max(Math.trunc(qtyRaw), 0) : 0;
    if (!name || qty <= 0) return null;

    const unitPriceRaw = Number(line.unitPrice);
    const unitPrice = Number.isFinite(unitPriceRaw)
      ? roundMoney(Math.max(unitPriceRaw, 0))
      : 0;

    const lineTotalRaw = Number(line.lineTotal);
    const computedLineTotal = roundMoney(unitPrice * qty);
    const lineTotal = Number.isFinite(lineTotalRaw)
      ? roundMoney(Math.max(lineTotalRaw, 0))
      : computedLineTotal;
    if (lineTotal <= 0) return null;

    const description = String(line.description ?? "").trim();
    const variant = String(line.variant ?? "").trim();
    const note = String(line.note ?? "").trim();
    const articleUnitIds = normalizeStringList(line.articleUnitIds, 1000, 120);
    const productId = String(line.productId ?? "").trim();
    const lineId = String(line.lineId ?? "").trim();

    return {
      name,
      qty,
      unitPrice,
      lineTotal,
      ...(productId ? { productId } : {}),
      ...(lineId ? { lineId } : {}),
      ...(articleUnitIds.length > 0 ? { articleUnitIds } : {}),
      ...(description ? { description } : {}),
      ...(variant ? { variant } : {}),
      ...(note ? { note } : {}),
    };
  }

  function normalizePosBill(bill, fallbackId, fallbackSubtotal = 0) {
    if (!bill || typeof bill !== "object") {
      return null;
    }

    const lines = (Array.isArray(bill.lines) ? bill.lines : [])
      .map((line) => normalizePosBillLine(line))
      .filter((line) => line !== null);

    const linesSubtotal = roundMoney(
      lines.reduce((sum, line) => sum + line.lineTotal, 0),
    );

    const subtotalRaw = Number(bill.subtotal);
    let subtotal = Number.isFinite(subtotalRaw)
      ? roundMoney(Math.max(subtotalRaw, 0))
      : linesSubtotal;

    if (subtotal <= 0 && linesSubtotal > 0) {
      subtotal = linesSubtotal;
    }

    if (subtotal <= 0 && fallbackSubtotal > 0) {
      subtotal = roundMoney(Math.max(fallbackSubtotal, 0));
    }

    if (subtotal <= 0) {
      return null;
    }

    const createdAtRaw = String(bill.createdAt ?? "");
    const createdAtTs = new Date(createdAtRaw).getTime();
    const createdAt = Number.isFinite(createdAtTs)
      ? new Date(createdAtTs).toISOString()
      : nowIso();

    const safeLines = lines.length
      ? lines
      : [
          {
            name: "Conto",
            qty: 1,
            unitPrice: subtotal,
            lineTotal: subtotal,
          },
        ];

    return {
      id: String(bill.id ?? fallbackId),
      createdAt,
      subtotal,
      lines: safeLines,
      orderId: String(bill.orderId ?? "").trim(),
      orderIds: [
        ...new Set(
          (Array.isArray(bill.orderIds) ? bill.orderIds : [])
            .map((entry) => String(entry ?? "").trim())
            .filter(Boolean),
        ),
      ],
    };
  }

  function normalizePosTable(table, fallbackNumber) {
    const fallbackTableId = String(table.id ?? `tbl_${pad2(fallbackNumber)}`);
    const normalizedNumber = Number.isFinite(table.number)
      ? Number(table.number)
      : fallbackNumber;
    const status = String(table.status ?? "free");
    const safeStatus = POS_TABLE_STATUSES.has(status) ? status : "free";
    const normalizedTotalDue = Number.isFinite(table.totalDue)
      ? Math.max(roundMoney(Number(table.totalDue)), 0)
      : 0;
    const customerPhone = String(table.customerPhone ?? "")
      .trim()
      .slice(0, 24);
    const note = String(table.note ?? "")
      .trim()
      .slice(0, 240);
    const allergens = normalizeStringList(table.allergens, 12, 40);
    const manualIntolerance = String(table.manualIntolerance ?? "")
      .trim()
      .slice(0, 64);
    const seatedAt = normalizeSeatedAtMs(table.seatedAt);
    const workLock = sanitizeTableWorkLock(table.workLock);

    const pendingBills = (
      Array.isArray(table.pendingBills) ? table.pendingBills : []
    )
      .map((bill, index) =>
        normalizePosBill(bill, `${fallbackTableId}_bill_${pad2(index + 1)}`),
      )
      .filter((bill) => bill !== null);

    if (!pendingBills.length && normalizedTotalDue > 0) {
      const legacyBill = normalizePosBill(
        {
          id: `${fallbackTableId}_legacy`,
          createdAt: nowIso(),
          subtotal: normalizedTotalDue,
          lines: [
            {
              name: "Conto",
              qty: 1,
              unitPrice: normalizedTotalDue,
              lineTotal: normalizedTotalDue,
            },
          ],
        },
        `${fallbackTableId}_legacy`,
        normalizedTotalDue,
      );
      if (legacyBill) {
        pendingBills.push(legacyBill);
      }
    }

    const totalDue = pendingBills.length
      ? roundMoney(
          pendingBills.reduce(
            (sum, bill) => sum + Math.max(bill.subtotal, 0),
            0,
          ),
        )
      : normalizedTotalDue;

    return {
      id: fallbackTableId,
      revision: clampInt(
        table.revision ?? table.currentRevision,
        1,
        1_000_000,
        1,
      ),
      number: Math.max(Math.trunc(normalizedNumber), 1),
      type: String(table.type ?? "interno").trim() || "interno",
      roomId: normalizePosRoomId(table.roomId ?? table.areaId ?? ""),
      status: totalDue > 0 ? "payment_due" : safeStatus,
      guestName: String(table.guestName ?? "").trim(),
      covers: normalizeTableCovers(table.covers),
      totalDue,
      reservation: normalizeReservation(table.reservation),
      pendingBills,
      customerPhone,
      note,
      allergens,
      manualIntolerance,
      seatedAt,
      workLock: workLock && !isTableWorkLockExpired(workLock) ? workLock : null,
    };
  }

  function sanitizePosTable(table, fallbackNumber = 1) {
    const safeFallback = Number.isFinite(fallbackNumber)
      ? Math.max(Math.trunc(Number(fallbackNumber)), 1)
      : 1;
    return normalizePosTable(
      table && typeof table === "object" ? table : {},
      safeFallback,
    );
  }

  function ensureMinimumTablesForType(
    tables,
    typeLabel,
    minimumCount,
    options = {},
  ) {
    const safeType = String(typeLabel ?? "").trim();
    const safeMinimum = Number.isFinite(Number(minimumCount))
      ? Math.max(Math.trunc(Number(minimumCount)), 0)
      : 0;
    if (!safeType || safeMinimum <= 0) {
      return Array.isArray(tables) ? [...tables] : [];
    }

    const safeTypeKey = safeType.toLowerCase();
    const safeRoomId = normalizePosRoomId(options.roomId ?? "");
    const normalizedTables = Array.isArray(tables) ? [...tables] : [];
    const matchesRoom = (table) => {
      if (safeRoomId) {
        return (
          normalizePosRoomId(table?.roomId ?? table?.areaId ?? "") === safeRoomId
        );
      }
      return (
        String(table?.type ?? "")
          .trim()
          .toLowerCase() === safeTypeKey
      );
    };
    const presentNumbers = new Set(
      normalizedTables
        .filter((table) => matchesRoom(table))
        .map((table) => Math.max(Math.trunc(Number(table?.number) || 0), 0))
        .filter((number) => number > 0),
    );
    const roomSlug =
      safeRoomId ||
      `room_${
        safeTypeKey
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || "sala"
      }`;

    for (let tableNumber = 1; tableNumber <= safeMinimum; tableNumber += 1) {
      if (presentNumbers.has(tableNumber)) continue;
      normalizedTables.push(
        normalizePosTable(
          {
            id: `${roomSlug}_t${pad2(tableNumber)}`,
            number: tableNumber,
            type: safeType,
            roomId: safeRoomId,
            status: "free",
            guestName: "",
            covers: 0,
            totalDue: 0,
            reservation: null,
            pendingBills: [],
            customerPhone: "",
            note: "",
            allergens: [],
            manualIntolerance: "",
            seatedAt: null,
          },
          tableNumber,
        ),
      );
    }

    return normalizedTables;
  }

  function ensureMinimumTablesForConfiguredAreas(tables, areas) {
    return (Array.isArray(areas) ? areas : []).reduce(
      (currentTables, area) => {
        const roomId = normalizePosRoomId(area?.id ?? area?.roomId ?? "");
        const typeLabel = String(area?.name ?? area?.label ?? "").trim();
        const minimumTables = resolveConfiguredAreaMinimumTables(area);
        if (!roomId || !typeLabel || minimumTables <= 0) return currentTables;
        return ensureMinimumTablesForType(
          currentTables,
          typeLabel,
          minimumTables,
          { roomId },
        );
      },
      Array.isArray(tables) ? [...tables] : [],
    );
  }

  function buildCanonicalPosAreaIdByName(areas) {
    const byName = new Map();
    (Array.isArray(areas) ? areas : []).forEach((area) => {
      const id = normalizePosRoomId(area?.id ?? area?.roomId ?? "");
      const nameKey = normalizeConfigId(area?.name ?? area?.label ?? "", "");
      if (!id || !nameKey) return;
      const current = byName.get(nameKey);
      if (!current || (id.startsWith("room_") && !current.startsWith("room_"))) {
        byName.set(nameKey, id);
      }
    });
    return byName;
  }

  function resolveCanonicalPosTableRoomId(table, areasById, areaIdsByName) {
    const explicitRoomId = normalizePosRoomId(
      table?.roomId ?? table?.areaId ?? "",
    );
    if (explicitRoomId && areasById.has(explicitRoomId)) return explicitRoomId;
    const candidateKeys = [
      table?.type,
      table?.roomName,
      table?.areaName,
      table?.room,
      table?.sala,
      explicitRoomId.replace(/^room_/, "").replace(/^sala_/, ""),
    ]
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean);
    for (const key of candidateKeys) {
      const roomId = areaIdsByName.get(key);
      if (roomId) return roomId;
    }
    return explicitRoomId;
  }

  function scorePosTableForCanonicalDedupe(table, canonicalRoomId) {
    let score = 0;
    if (String(table?.status ?? "free") !== "free") score += 1000;
    if (Number(table?.totalDue) > 0) score += 800;
    if (Array.isArray(table?.pendingBills) && table.pendingBills.length > 0)
      score += 700;
    if (table?.reservation) score += 600;
    if (Number(table?.covers) > 0) score += 200;
    if (
      normalizePosRoomId(table?.roomId ?? table?.areaId ?? "") === canonicalRoomId
    )
      score += 50;
    if (String(table?.id ?? "").startsWith(`${canonicalRoomId}_`)) score += 25;
    return score;
  }

  function canonicalizeAndDedupePosTables(tables, areas) {
    const areasById = new Map(
      (Array.isArray(areas) ? areas : [])
        .map((area) => [normalizePosRoomId(area?.id ?? area?.roomId ?? ""), area])
        .filter(([id]) => Boolean(id)),
    );
    if (areasById.size === 0) return Array.isArray(tables) ? [...tables] : [];
    const areaIdsByName = buildCanonicalPosAreaIdByName([...areasById.values()]);
    const tablesByKey = new Map();
    for (const table of Array.isArray(tables) ? tables : []) {
      const canonicalRoomId = resolveCanonicalPosTableRoomId(
        table,
        areasById,
        areaIdsByName,
      );
      const tableNumber = Math.max(Math.trunc(Number(table?.number) || 0), 0);
      const nextTable = canonicalRoomId
        ? {
            ...table,
            roomId: canonicalRoomId,
            areaId: canonicalRoomId,
            roomName:
              areasById.get(canonicalRoomId)?.name ??
              table?.roomName ??
              table?.type ??
              canonicalRoomId,
          }
        : table;
      const key =
        canonicalRoomId && tableNumber > 0
          ? `${canonicalRoomId}:${tableNumber}`
          : `${normalizeConfigId(table?.type ?? "", "sala")}:${tableNumber}:${String(
              table?.id ?? "",
            )}`;
      const current = tablesByKey.get(key);
      if (
        !current ||
        scorePosTableForCanonicalDedupe(nextTable, canonicalRoomId) >
          scorePosTableForCanonicalDedupe(current, canonicalRoomId)
      ) {
        tablesByKey.set(key, nextTable);
      }
    }
    return [...tablesByKey.values()];
  }

  function scorePosAreaForCanonicalDedupe(area) {
    let score = 0;
    const id = normalizePosRoomId(area?.id ?? area?.roomId ?? "");
    if (id.startsWith("room_")) score += 100;
    if (!/_2$/.test(id)) score += 25;
    if (resolveConfiguredAreaMinimumTables(area) > 0) score += 1000;
    if (Array.isArray(area?.printerIds) && area.printerIds.length > 0)
      score += 200;
    if (Array.isArray(area?.waiterUserIds) && area.waiterUserIds.length > 0)
      score += 200;
    if (Array.isArray(area?.workstations) && area.workstations.length > 0)
      score += 100;
    return score;
  }

  function dedupeCanonicalPosAreas(areas) {
    const areasByName = new Map();
    for (const area of Array.isArray(areas) ? areas : []) {
      const id = normalizePosRoomId(area?.id ?? area?.roomId ?? "");
      const nameKey = normalizeConfigId(area?.name ?? area?.label ?? id, "");
      const key = nameKey || id;
      if (!key) continue;
      const current = areasByName.get(key);
      if (
        !current ||
        scorePosAreaForCanonicalDedupe(area) >
          scorePosAreaForCanonicalDedupe(current)
      ) {
        areasByName.set(key, area);
      }
    }
    return [...areasByName.values()];
  }

  function ensureDefaultVirtualWaitingRoomArea(areas) {
    const normalizedAreas = Array.isArray(areas) ? [...areas] : [];
    const existingIndex = normalizedAreas.findIndex(
      (area) =>
        normalizeConfigId(area?.id ?? area?.roomId, "") ===
        DEFAULT_VIRTUAL_WAITING_ROOM_ID,
    );
    const withMinimum = (area) => ({
      id: DEFAULT_VIRTUAL_WAITING_ROOM_ID,
      name:
        String(area?.name ?? DEFAULT_VIRTUAL_WAITING_ROOM_NAME).trim() ||
        DEFAULT_VIRTUAL_WAITING_ROOM_NAME,
      minimumTables: Math.max(
        resolveConfiguredAreaMinimumTables(area),
        DEFAULT_VIRTUAL_WAITING_ROOM_TABLE_COUNT,
      ),
      notes: String(
        area?.notes ?? "Sala virtuale di appoggio prima della sala reale finale.",
      )
        .trim()
        .slice(0, 240),
      menuIds: Array.isArray(area?.menuIds) ? area.menuIds : [],
      priceListIds: Array.isArray(area?.priceListIds) ? area.priceListIds : [],
      waiterUserIds: Array.isArray(area?.waiterUserIds) ? area.waiterUserIds : [],
      printerIds: Array.isArray(area?.printerIds) ? area.printerIds : [],
      menuSchedules: Array.isArray(area?.menuSchedules)
        ? area.menuSchedules
        : [],
      priceListSchedules: Array.isArray(area?.priceListSchedules)
        ? area.priceListSchedules
        : [],
      cashPoints: Array.isArray(area?.cashPoints) ? area.cashPoints : [],
      workstations: Array.isArray(area?.workstations) ? area.workstations : [],
    });

    if (existingIndex >= 0) {
      normalizedAreas[existingIndex] = {
        ...normalizedAreas[existingIndex],
        ...withMinimum(normalizedAreas[existingIndex]),
      };
      return normalizedAreas;
    }

    return [...normalizedAreas, withMinimum(null)];
  }

  function sumPosBillLines(lines) {
    return roundMoney(
      (Array.isArray(lines) ? lines : []).reduce(
        (sum, line) => sum + Math.max(Number(line?.lineTotal) || 0, 0),
        0,
      ),
    );
  }

  function getPosBillSubtotal(bill) {
    const linesTotal = sumPosBillLines(bill?.lines);
    const subtotalRaw = Number(bill?.subtotal);
    if (Number.isFinite(subtotalRaw) && subtotalRaw > 0) {
      return roundMoney(Math.max(subtotalRaw, linesTotal));
    }
    return linesTotal;
  }

  function clonePosBillLine(line, overrides = {}) {
    return {
      name: String(line?.name ?? ""),
      qty: Math.max(Math.trunc(Number(line?.qty) || 0), 0),
      unitPrice: roundMoney(Math.max(Number(line?.unitPrice) || 0, 0)),
      lineTotal: roundMoney(Math.max(Number(line?.lineTotal) || 0, 0)),
      ...(line?.productId ? { productId: String(line.productId).trim() } : {}),
      ...(line?.lineId ? { lineId: String(line.lineId).trim() } : {}),
      ...(normalizeStringList(line?.articleUnitIds, 1000, 120).length
        ? {
            articleUnitIds: normalizeStringList(
              line.articleUnitIds,
              1000,
              120,
            ),
          }
        : {}),
      ...(line?.description ? { description: String(line.description) } : {}),
      ...(line?.variant ? { variant: String(line.variant) } : {}),
      ...(line?.note ? { note: String(line.note) } : {}),
      ...overrides,
    };
  }

  function clonePosBill(bill, overrides = {}) {
    return {
      id: String(bill?.id ?? ""),
      createdAt: String(bill?.createdAt ?? nowIso()),
      subtotal: getPosBillSubtotal(bill),
      lines: (Array.isArray(bill?.lines) ? bill.lines : []).map((line) =>
        clonePosBillLine(line),
      ),
      orderId: String(bill?.orderId ?? "").trim(),
      orderIds: [
        ...new Set(
          (Array.isArray(bill?.orderIds) ? bill.orderIds : [])
            .map((entry) => String(entry ?? "").trim())
            .filter(Boolean),
        ),
      ],
      ...overrides,
    };
  }

  function buildLegacyPosPaymentBill(table) {
    const subtotal = roundMoney(Math.max(Number(table?.totalDue) || 0, 0));
    if (subtotal <= 0) return null;
    return {
      id: `${String(table?.id ?? "table")}_legacy`,
      createdAt: nowIso(),
      subtotal,
      lines: [
        {
          name: "Conto",
          qty: 1,
          unitPrice: subtotal,
          lineTotal: subtotal,
        },
      ],
    };
  }

  function buildResidualPosBill(bill, remainingAmount, splitMode) {
    const safeRemaining = roundMoney(Math.max(Number(remainingAmount) || 0, 0));
    const label =
      splitMode === "roman"
        ? "Residuo quota alla romana"
        : splitMode === "amount"
          ? "Residuo importo libero"
          : "Residuo comanda";
    return {
      id: String(bill?.id ?? ""),
      createdAt: String(bill?.createdAt ?? nowIso()),
      subtotal: safeRemaining,
      orderId: String(bill?.orderId ?? "").trim(),
      orderIds: [
        ...new Set(
          (Array.isArray(bill?.orderIds) ? bill.orderIds : [])
            .map((entry) => String(entry ?? "").trim())
            .filter(Boolean),
        ),
      ],
      lines: [
        {
          name: label,
          qty: 1,
          unitPrice: safeRemaining,
          lineTotal: safeRemaining,
        },
      ],
    };
  }

  function applyAmountPaymentToPosBills(bills, requestedAmount, splitMode) {
    const remainingBills = [];
    const paidItems = [];
    let remainingToConsume = roundMoney(
      Math.max(Number(requestedAmount) || 0, 0),
    );
    let amount = 0;

    for (const sourceBill of Array.isArray(bills) ? bills : []) {
      const bill = clonePosBill(sourceBill);
      const subtotal = getPosBillSubtotal(bill);
      if (subtotal <= 0) continue;
      if (remainingToConsume <= 0.0001) {
        remainingBills.push({ ...bill, subtotal });
        continue;
      }
      if (remainingToConsume + 0.0001 >= subtotal) {
        amount = roundMoney(amount + subtotal);
        remainingToConsume = roundMoney(remainingToConsume - subtotal);
        paidItems.push(
          ...(Array.isArray(bill.lines) ? bill.lines : [])
            .map((line) => sanitizePaymentItem(line))
            .filter((line) => line !== null),
        );
        continue;
      }
      const partialAmount = remainingToConsume;
      const remainingAmount = roundMoney(Math.max(subtotal - partialAmount, 0));
      amount = roundMoney(amount + partialAmount);
      remainingToConsume = 0;
      remainingBills.push(buildResidualPosBill(bill, remainingAmount, splitMode));
      const partialItem = sanitizePaymentItem({
        name:
          splitMode === "roman" ? "Quota alla romana" : "Quota importo libero",
        qty: 1,
        unitPrice: partialAmount,
        lineTotal: partialAmount,
      });
      if (partialItem) paidItems.push(partialItem);
    }

    return {
      amount,
      paidItems,
      remainingBills,
    };
  }

  function applyLineSelectionsToPosBills(bills, lineSelections) {
    const selectionMap = new Map();
    (Array.isArray(lineSelections) ? lineSelections : []).forEach((entry) => {
      const billId = String(entry?.billId ?? "").trim();
      const lineIndex = Math.max(Math.trunc(Number(entry?.lineIndex) || 0), 0);
      const qty = Math.max(Math.trunc(Number(entry?.qty) || 0), 0);
      if (!billId || qty <= 0) return;
      const key = `${billId}:${lineIndex}`;
      selectionMap.set(key, (selectionMap.get(key) ?? 0) + qty);
    });

    const remainingBills = [];
    const paidItems = [];
    let amount = 0;

    for (const sourceBill of Array.isArray(bills) ? bills : []) {
      const bill = clonePosBill(sourceBill);
      const remainingLines = [];
      (Array.isArray(bill.lines) ? bill.lines : []).forEach(
        (line, lineIndex) => {
          const safeQty = Math.max(Math.trunc(Number(line.qty) || 0), 0);
          const requestedQty = Math.min(
            selectionMap.get(`${bill.id}:${lineIndex}`) ?? 0,
            safeQty,
          );
          if (requestedQty <= 0) {
            remainingLines.push(clonePosBillLine(line));
            return;
          }
          const paidLineAmount =
            requestedQty >= safeQty
              ? roundMoney(Math.max(Number(line.lineTotal) || 0, 0))
              : roundMoney(
                  (Math.max(Number(line.lineTotal) || 0, 0) /
                    Math.max(safeQty, 1)) *
                    requestedQty,
                );
          const remainingQty = safeQty - requestedQty;
          const remainingAmount = roundMoney(
            Math.max((Number(line.lineTotal) || 0) - paidLineAmount, 0),
          );
          const lineArticleUnitIds = normalizeStringList(
            line.articleUnitIds,
            1000,
            120,
          ).slice(0, safeQty);
          const paidArticleUnitIds = lineArticleUnitIds.slice(0, requestedQty);
          const remainingArticleUnitIds = lineArticleUnitIds.slice(requestedQty);
          amount = roundMoney(amount + paidLineAmount);
          const paidItem = sanitizePaymentItem({
            ...line,
            qty: requestedQty,
            lineTotal: paidLineAmount,
            articleUnitIds: paidArticleUnitIds,
          });
          if (paidItem) paidItems.push(paidItem);
          if (remainingQty > 0 && remainingAmount > 0.0001) {
            remainingLines.push(
              clonePosBillLine(line, {
                qty: remainingQty,
                lineTotal: remainingAmount,
                articleUnitIds: remainingArticleUnitIds,
              }),
            );
          }
        },
      );
      const remainingSubtotal = sumPosBillLines(remainingLines);
      if (remainingSubtotal > 0.0001) {
        remainingBills.push({
          ...bill,
          subtotal: remainingSubtotal,
          lines: remainingLines,
        });
      }
    }

    return {
      amount,
      paidItems,
      remainingBills,
    };
  }

  return {
    applyAmountPaymentToPosBills,
    applyLineSelectionsToPosBills,
    buildCanonicalPosAreaIdByName,
    buildLegacyPosPaymentBill,
    buildResidualPosBill,
    canonicalizeAndDedupePosTables,
    clonePosBill,
    clonePosBillLine,
    dedupeCanonicalPosAreas,
    ensureDefaultVirtualWaitingRoomArea,
    ensureMinimumTablesForConfiguredAreas,
    ensureMinimumTablesForType,
    getPosBillSubtotal,
    normalizePosBill,
    normalizePosBillLine,
    normalizePosTable,
    resolveCanonicalPosTableRoomId,
    sanitizePosTable,
    scorePosAreaForCanonicalDedupe,
    scorePosTableForCanonicalDedupe,
    sumPosBillLines,
  };
}
