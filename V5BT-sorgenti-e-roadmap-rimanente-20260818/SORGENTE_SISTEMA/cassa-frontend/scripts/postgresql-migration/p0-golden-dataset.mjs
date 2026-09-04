import { buildInitialAppState } from "../../backend/modules/app-state/initial-state.js";
import {
  buildCommercialConfigurationFromLegacy,
  compileCommercialConfiguration,
  resolveCommercialSellable,
} from "../../backend/modules/commercial-configuration/index.js";

const FIXED_DATASET_TIME = "2026-08-31T00:00:00.000Z";
const FIXED_PIN_HASH =
  "scrypt$16384$8$1$00112233445566778899aabbccddeeff$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function buildCatalogCoverage(appState) {
  const table = appState.posSettings.tables[0];
  const [coffee, correctedCoffee, decaffeinatedCoffee] = appState.menuItems;

  Object.assign(coffee, {
    price: 1.3,
    variants: [{ id: "large", name: "Grande", enabled: true, priceDelta: 0.5 }],
    tags: ["caffetteria", "golden"],
    ingredients: ["caffe"],
  });
  Object.assign(correctedCoffee, {
    price: 2,
    allergens: ["latte"],
    ingredients: ["caffe", "latte vaccino"],
    tags: ["caffetteria"],
  });
  Object.assign(decaffeinatedCoffee, {
    price: 1.3,
    allergens: ["solfiti"],
    ingredients: ["caffe decaffeinato"],
  });

  appState.posSettings.menus = [{
    id: "golden_menu_main",
    name: "Menu Golden",
    enabled: true,
    productIds: [coffee.id, correctedCoffee.id, decaffeinatedCoffee.id],
  }];
  appState.posSettings.priceLists = [
    {
      id: "price_list_evening",
      name: "Listino serale",
      inheritsFromId: "price_list_base",
      currency: "EUR",
      enabled: true,
      prices: [
        { id: "golden_evening_coffee", productId: coffee.id, price: 1.8 },
        { id: "golden_evening_corrected", productId: correctedCoffee.id, price: 2.2 },
      ],
    },
    {
      id: "price_list_night",
      name: "Listino notte",
      inheritsFromId: "price_list_evening",
      currency: "EUR",
      enabled: true,
      prices: [{ id: "golden_night_coffee", productId: coffee.id, price: 2 }],
    },
  ];
  appState.posSettings.priceListSchedules = [
    {
      id: "golden_schedule_evening",
      priceListId: "price_list_evening",
      days: ["mon"],
      start: "18:00",
      end: "23:59",
      priority: 10,
      enabled: true,
    },
    {
      id: "golden_schedule_overnight",
      priceListId: "price_list_night",
      days: ["mon"],
      start: "22:00",
      end: "02:00",
      priority: 20,
      enabled: true,
    },
  ];
  appState.posSettings.menuSchedules = [{
    id: "golden_menu_schedule_overnight",
    menuId: "golden_menu_main",
    days: ["mon"],
    start: "18:00",
    end: "02:00",
    enabled: true,
  }];
  appState.posSettings.areaMenus = [{
    id: "golden_area_menu",
    areaId: table.roomId,
    menuId: "golden_menu_main",
    enabled: true,
  }];

  return { table, coffee, correctedCoffee, decaffeinatedCoffee };
}

function buildIdentityCoverage(appState, table) {
  appState.userGroups = [{
    id: "golden_group_cashiers",
    name: "Cassieri Golden",
    permissions: ["sell", "take_payments"],
    enabledRoomIds: [table.roomId],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }];
  appState.users = [
    {
      id: "golden_user_cashier",
      username: "golden-cashier",
      fullName: "Cassiere Golden",
      role: "cashier",
      roleLabel: "Cassiere",
      permissions: ["sell", "take_payments"],
      groupIds: ["golden_group_cashiers"],
      enabledRoomIds: [table.roomId],
      authorizedRoomIds: [table.roomId],
      allowedPaymentMethodIds: ["pay_cash", "pay_card"],
      enabledAppIds: ["cassa"],
      active: true,
      pinHash: FIXED_PIN_HASH,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-30T18:00:00.000Z",
    },
    {
      id: "golden_user_waiter",
      username: "golden-waiter",
      fullName: "Cameriere Golden",
      role: "waiter",
      roleLabel: "Cameriere",
      permissions: ["sell"],
      groupIds: [],
      enabledRoomIds: [table.roomId],
      authorizedRoomIds: [table.roomId],
      enabledAppIds: ["mobile"],
      active: false,
      pinHash: FIXED_PIN_HASH,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-30T18:00:00.000Z",
    },
  ];
  appState.sessions = [
    {
      id: "golden_session_active",
      tokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      userId: "golden_user_cashier",
      deviceUuid: "golden-device-active",
      clientApp: "cassa",
      createdAt: "2026-08-31T08:00:00.000Z",
      lastSeenAt: "2026-08-31T20:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    },
    {
      id: "golden_session_revoked",
      tokenHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      userId: "golden_user_cashier",
      deviceUuid: "golden-device-revoked",
      clientApp: "cassa",
      createdAt: "2026-08-30T08:00:00.000Z",
      lastSeenAt: "2026-08-30T10:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
      revokedAt: "2026-08-30T10:05:00.000Z",
    },
    {
      id: "golden_session_expired",
      tokenHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      userId: "golden_user_waiter",
      deviceUuid: "golden-device-expired",
      clientApp: "mobile",
      createdAt: "2026-08-29T08:00:00.000Z",
      lastSeenAt: "2026-08-29T10:00:00.000Z",
      expiresAt: "2026-08-30T00:00:00.000Z",
    },
  ];
}

function buildOrderCoverage(appState, catalog) {
  const { table, coffee, correctedCoffee, decaffeinatedCoffee } = catalog;
  const grossCents = 850;
  const discountCents = 50;
  const totalCents = grossCents - discountCents;
  appState.integration.orders = [{
    id: "golden_order_0001",
    tableId: table.id,
    tableNumber: table.number,
    tableLabel: "Tavolo " + table.number,
    roomId: table.roomId,
    workflowStatus: "delivered",
    paymentStatus: "paid",
    source: "migration-golden-dataset",
    subtotal: grossCents / 100,
    subtotalCents: grossCents,
    discount: discountCents / 100,
    discountCents,
    discountReason: "Sconto fixture golden",
    total: totalCents / 100,
    totalCents,
    station: "BAR PRINCIPALE",
    assignedStationId: "BAR PRINCIPALE",
    createdByUserId: "golden_user_cashier",
    createdByUsername: "golden-cashier",
    createdByDeviceUuid: "golden-device-active",
    idempotencyKey: "golden-order-idem-0001",
    createdAt: "2026-08-30T18:30:00.000Z",
    updatedAt: "2026-08-30T18:35:00.000Z",
    revision: 2,
    currentRevision: 2,
    items: [
      {
        id: "golden_item_0001",
        lineId: "golden_line_0001",
        productId: coffee.id,
        productNameSnapshot: coffee.name,
        name: coffee.name,
        variantId: "large",
        variantName: "Grande",
        qty: 2,
        done: true,
        doneQty: 2,
        unitPriceApplied: 2.5,
        unitPriceCents: 250,
        listPriceAtTime: 2.5,
        lineTotal: 5,
        lineTotalCents: 500,
        routeStations: ["BAR PRINCIPALE"],
      },
      {
        id: "golden_item_0002",
        lineId: "golden_line_0002",
        productId: correctedCoffee.id,
        productNameSnapshot: correctedCoffee.name,
        name: correctedCoffee.name,
        qty: 1,
        done: true,
        doneQty: 1,
        unitPriceApplied: 2.2,
        unitPriceCents: 220,
        listPriceAtTime: 2.2,
        lineTotal: 2.2,
        lineTotalCents: 220,
        routeStations: ["BAR PRINCIPALE"],
      },
      {
        id: "golden_item_0003",
        lineId: "golden_line_0003",
        productId: decaffeinatedCoffee.id,
        productNameSnapshot: decaffeinatedCoffee.name,
        name: decaffeinatedCoffee.name,
        qty: 1,
        done: true,
        doneQty: 1,
        unitPriceApplied: 1.3,
        unitPriceCents: 130,
        listPriceAtTime: 1.3,
        lineTotal: 1.3,
        lineTotalCents: 130,
        routeStations: ["BAR PRINCIPALE"],
      },
    ],
    events: [{
      id: "golden_order_event_0001",
      type: "order.created",
      occurredAt: "2026-08-30T18:30:00.000Z",
      actorUserId: "golden_user_cashier",
      payload: { source: "golden-dataset" },
    }],
  }];
  appState.integration.sequence.order = 2;
  appState.integration.lastWriteAt = "2026-08-30T18:36:00.000Z";
  return { grossCents, discountCents, totalCents };
}

function paymentPart({ id, partNo, methodId, methodType, amountCents, createdAt }) {
  return {
    id,
    paymentId: "golden_payment_container_0001",
    partNo,
    methodId,
    methodType,
    amountCents,
    status: "PAID",
    createdAt,
  };
}

function paymentTransaction({ id, partId, method, amountCents, createdAt, tableId }) {
  return {
    id,
    paymentContainerId: "golden_payment_container_0001",
    partId,
    idempotencyKey: "golden-" + id + "-idem",
    tableId,
    billId: "golden_bill_0001",
    orderId: "golden_order_0001",
    method,
    amountCents,
    status: "settled",
    createdAt,
    updatedAt: "2026-08-30T18:36:10.000Z",
  };
}

function paymentRow({ id, partId, txId, methodId, methodLabel, amountCents, table }) {
  return {
    id,
    tableId: table.id,
    roomId: table.roomId,
    orderId: "golden_order_0001",
    orderIds: ["golden_order_0001"],
    billId: "golden_bill_0001",
    billIds: ["golden_bill_0001"],
    amount: amountCents / 100,
    amountCents,
    methodId,
    methodLabel,
    fiscal: true,
    source: "table_payment",
    createdAt: "2026-08-30T18:36:10.000Z",
    idempotencyKey: "golden-" + id + "-idem",
    clientPaymentId: "golden-client-" + id,
    paymentContainerId: "golden_payment_container_0001",
    paymentPartId: partId,
    paymentTxId: txId,
  };
}

function buildPaymentCoverage(appState, table, totalCents) {
  appState.paymentContainers = [{
    id: "golden_payment_container_0001",
    tableId: table.id,
    tableNumber: table.number,
    tableLabel: "Tavolo " + table.number,
    orderId: "golden_order_0001",
    orderIds: ["golden_order_0001"],
    billId: "golden_bill_0001",
    billIds: ["golden_bill_0001"],
    roomId: table.roomId,
    paymentMethod: "split",
    totalCents,
    paidCents: totalCents,
    dueCents: 0,
    status: "COMPLETED",
    splitType: "BY_AMOUNT",
    idempotencyKey: "golden-payment-container-idem-0001",
    clientPaymentId: "golden-client-payment-0001",
    createdAt: "2026-08-30T18:36:00.000Z",
    updatedAt: "2026-08-30T18:36:10.000Z",
  }];
  appState.paymentParts = [
    paymentPart({
      id: "golden_payment_part_0001",
      partNo: 1,
      methodId: "pay_cash",
      methodType: "CASH",
      amountCents: 300,
      createdAt: "2026-08-30T18:36:05.000Z",
    }),
    paymentPart({
      id: "golden_payment_part_0002",
      partNo: 2,
      methodId: "pay_card",
      methodType: "CARD",
      amountCents: 500,
      createdAt: "2026-08-30T18:36:06.000Z",
    }),
  ];
  appState.paymentTransactions = [
    paymentTransaction({
      id: "golden_payment_tx_0001",
      partId: "golden_payment_part_0001",
      method: "CASH",
      amountCents: 300,
      createdAt: "2026-08-30T18:36:06.000Z",
      tableId: table.id,
    }),
    paymentTransaction({
      id: "golden_payment_tx_0002",
      partId: "golden_payment_part_0002",
      method: "CARD",
      amountCents: 500,
      createdAt: "2026-08-30T18:36:07.000Z",
      tableId: table.id,
    }),
  ];
  appState.payments = [
    paymentRow({
      id: "golden_payment_0001",
      partId: "golden_payment_part_0001",
      txId: "golden_payment_tx_0001",
      methodId: "pay_cash",
      methodLabel: "Contanti",
      amountCents: 300,
      table,
    }),
    paymentRow({
      id: "golden_payment_0002",
      partId: "golden_payment_part_0002",
      txId: "golden_payment_tx_0002",
      methodId: "pay_card",
      methodLabel: "Carta",
      amountCents: 500,
      table,
    }),
  ];
}

function buildReservationAndBenefitCoverage(appState, table, totalCents) {
  appState.posReservationStates = [{
    key: table.roomId + ":2026-08-31",
    roomId: table.roomId,
    serviceDate: "2026-08-31",
    version: 1,
    reservations: [{
      id: "golden_reservation_0001",
      roomId: table.roomId,
      serviceDate: "2026-08-31",
      reservationAt: Date.parse("2026-08-31T19:30:00.000Z"),
      customerName: "Cliente Golden",
      customerPhone: "+39000000000",
      covers: 2,
      intolerances: "lattosio",
      note: "Fixture migrazione PostgreSQL",
      assignedTableId: table.id,
      assignedTableIds: [table.id],
      status: "confirmed",
      createdAt: Date.parse("2026-08-30T12:00:00.000Z"),
      updatedAt: Date.parse("2026-08-30T12:05:00.000Z"),
    }],
  }];
  appState.commercialBenefitCampaigns = [{
    id: "golden_benefit_campaign_0001",
    title: "Buono Golden 5 EUR",
    benefitKind: "value_voucher",
    faceValueCents: 500,
    residualPolicy: "keep_balance",
    status: "active",
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-12-31T23:59:59.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }];
  appState.commercialBenefitCoupons = [{
    id: "golden_benefit_coupon_0001",
    campaignId: "golden_benefit_campaign_0001",
    codeMasked: "GOLD-****-0001",
    faceValueCents: 500,
    balanceCents: 200,
    usageCount: 1,
    maxUsageCount: 5,
    residualPolicy: "keep_balance",
    status: "partially_redeemed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-30T18:36:10.000Z",
  }];
  appState.commercialBenefitApplications = [{
    id: "golden_benefit_application_0001",
    campaignId: "golden_benefit_campaign_0001",
    couponId: "golden_benefit_coupon_0001",
    tableId: table.id,
    payableBeforeCents: totalCents + 300,
    benefitAmountCents: 300,
    payableAfterCents: totalCents,
    status: "redeemed",
    createdAt: "2026-08-30T18:35:30.000Z",
    updatedAt: "2026-08-30T18:36:10.000Z",
  }];
  appState.commercialBenefitRedemptions = [{
    id: "golden_benefit_redemption_0001",
    applicationId: "golden_benefit_application_0001",
    campaignId: "golden_benefit_campaign_0001",
    couponId: "golden_benefit_coupon_0001",
    paymentId: "golden_payment_0002",
    amountCents: 300,
    createdAt: "2026-08-30T18:36:10.000Z",
  }];
}

function buildPricingCases(catalog) {
  return [
    {
      id: "monday-before-window",
      dateTime: "2026-08-31T17:30:00+02:00",
      productId: catalog.coffee.id,
      variantId: "large",
      expectedUnitPriceCents: 180,
      expectedPriceListChain: ["price_list_base"],
      expectedAssignmentIds: [],
    },
    {
      id: "monday-evening",
      dateTime: "2026-08-31T20:00:00+02:00",
      productId: catalog.coffee.id,
      variantId: "large",
      expectedUnitPriceCents: 230,
      expectedPriceListChain: ["price_list_base", "price_list_evening"],
      expectedAssignmentIds: ["golden_schedule_evening"],
    },
    {
      id: "monday-overlap-priority",
      dateTime: "2026-08-31T22:30:00+02:00",
      productId: catalog.coffee.id,
      variantId: "large",
      expectedUnitPriceCents: 250,
      expectedPriceListChain: ["price_list_base", "price_list_evening", "price_list_night"],
      expectedAssignmentIds: ["golden_schedule_evening", "golden_schedule_overnight"],
    },
    {
      id: "tuesday-overnight-previous-weekday",
      dateTime: "2026-09-01T00:30:00+02:00",
      productId: catalog.correctedCoffee.id,
      expectedUnitPriceCents: 220,
      expectedPriceListChain: ["price_list_base", "price_list_evening", "price_list_night"],
      expectedAssignmentIds: ["golden_schedule_overnight"],
    },
    {
      id: "tuesday-weekday-miss",
      dateTime: "2026-09-01T22:30:00+02:00",
      productId: catalog.coffee.id,
      variantId: "large",
      expectedUnitPriceCents: 180,
      expectedPriceListChain: ["price_list_base"],
      expectedAssignmentIds: [],
    },
  ];
}

export function buildGoldenDataset() {
  const appState = buildInitialAppState({
    createdAt: FIXED_DATASET_TIME,
    seedDemoData: false,
  });
  const catalog = buildCatalogCoverage(appState);
  buildIdentityCoverage(appState, catalog.table);
  const order = buildOrderCoverage(appState, catalog);
  buildPaymentCoverage(appState, catalog.table, order.totalCents);
  buildReservationAndBenefitCoverage(appState, catalog.table, order.totalCents);
  appState.meta.lastWriteAt = "2026-08-30T18:36:10.000Z";

  const commercialConfiguration = buildCommercialConfigurationFromLegacy(appState);
  commercialConfiguration.metadata.migratedFromLegacyAt = FIXED_DATASET_TIME;
  const pricingCases = buildPricingCases(catalog);

  return {
    schemaVersion: 2,
    datasetId: "v6-postgresql-migration-golden-002",
    generatedAt: FIXED_DATASET_TIME,
    currency: "EUR",
    purpose: "Equivalence baseline for app-state to PostgreSQL migration",
    appState,
    commercialConfiguration,
    pricingCases,
    expected: {
      catalog: {
        menuItemCount: appState.menuItems.length,
        legacyPriceListCount: 2,
        inheritedPriceListCount: 2,
        priceScheduleCount: 2,
        menuScheduleCount: 1,
        areaMenuCount: 1,
        allergenProductCount: 2,
      },
      identity: {
        userCount: 2,
        userGroupCount: 1,
        sessionCount: 3,
        activeSessionCount: 1,
        revokedSessionCount: 1,
        expiredSessionCount: 1,
        referenceTime: FIXED_DATASET_TIME,
      },
      order: {
        count: 1,
        lineCount: 3,
        variantLineCount: 1,
        grossCents: order.grossCents,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
      },
      payment: {
        containerCount: 1,
        partCount: 2,
        transactionCount: 2,
        rowCount: 2,
        settledCents: order.totalCents,
        methods: ["CARD", "CASH"],
      },
      reservation: { count: 1 },
      benefit: {
        redemptionCents: 300,
        remainingCents: 200,
        status: "partially_redeemed",
      },
      pricing: {
        caseCount: pricingCases.length,
        equivalencePercent: 100,
        includesOverlap: true,
        includesOvernight: true,
        includesWeekdayMiss: true,
      },
    },
  };
}

function minuteOfDay(value) {
  const [hour = "0", minute = "0"] = String(value).split(":");
  return Number(hour) * 60 + Number(minute);
}

function schedulesOverlap(left, right) {
  if (!(left.days ?? []).some((day) => (right.days ?? []).includes(day))) return false;
  const segments = (schedule) => {
    const start = minuteOfDay(schedule.start);
    const end = minuteOfDay(schedule.end);
    return start < end ? [[start, end]] : [[start, 1440], [0, end]];
  };
  return segments(left).some(([leftStart, leftEnd]) =>
    segments(right).some(([rightStart, rightEnd]) =>
      leftStart < rightEnd && rightStart < leftEnd,
    ),
  );
}

function compareExpected(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(label + " expected " + expected + ", got " + actual + ".");
  }
}

function validatePricing(dataset, errors) {
  try {
    const compiled = compileCommercialConfiguration(dataset.commercialConfiguration, {
      compiledAt: FIXED_DATASET_TIME,
    }).compiled;
    const canonicalAllergenProducts = Object.values(compiled.productsById ?? {}).filter(
      (product) => (product.allergens ?? []).length > 0,
    );
    compareExpected(
      errors,
      "Canonical allergen product count",
      canonicalAllergenProducts.length,
      dataset.expected?.catalog?.allergenProductCount,
    );
    if (!canonicalAllergenProducts.some((product) =>
      (product.metadata?.legacyIngredientLabels ?? []).length > 0,
    )) {
      errors.push("Canonical allergens and ingredient labels are not independently preserved.");
    }
    for (const pricingCase of dataset.pricingCases ?? []) {
      const resolution = resolveCommercialSellable(
        compiled,
        { dateTime: pricingCase.dateTime },
        {
          productId: pricingCase.productId,
          variantId: pricingCase.variantId,
          quantity: 1,
        },
      );
      compareExpected(
        errors,
        "Pricing case " + pricingCase.id,
        resolution.finalUnitPriceCents,
        pricingCase.expectedUnitPriceCents,
      );
      const chainIds = resolution.priceListChain.map((entry) => entry.id);
      if (JSON.stringify(chainIds) !== JSON.stringify(pricingCase.expectedPriceListChain)) {
        errors.push("Pricing case " + pricingCase.id + " resolved an unexpected price-list chain.");
      }
      if (JSON.stringify(resolution.appliedAssignmentIds) !==
          JSON.stringify(pricingCase.expectedAssignmentIds)) {
        errors.push("Pricing case " + pricingCase.id + " resolved unexpected assignments.");
      }
    }
  } catch (error) {
    errors.push("Commercial pricing fixture cannot be compiled: " + error.message);
  }
}

export function validateGoldenDataset(dataset) {
  const errors = [];
  const state = dataset?.appState ?? {};
  const expected = dataset?.expected ?? {};
  const orders = state.integration?.orders ?? [];
  const lines = orders.flatMap((order) => order.items ?? []);
  const orderTotalCents = orders.reduce((sum, order) => sum + Number(order.totalCents ?? 0), 0);
  const lineTotalCents = lines.reduce((sum, line) => sum + Number(line.lineTotalCents ?? 0), 0);
  const discountCents = orders.reduce((sum, order) => sum + Number(order.discountCents ?? 0), 0);
  const settledTransactions = (state.paymentTransactions ?? []).filter(
    (transaction) => String(transaction.status).toLowerCase() === "settled",
  );
  const settledPaymentCents = settledTransactions.reduce(
    (sum, transaction) => sum + Number(transaction.amountCents ?? 0),
    0,
  );
  const reservationCount = (state.posReservationStates ?? []).reduce(
    (sum, entry) => sum + (entry.reservations?.length ?? 0),
    0,
  );
  const redemptionCents = (state.commercialBenefitRedemptions ?? []).reduce(
    (sum, redemption) => sum + Number(redemption.amountCents ?? 0),
    0,
  );
  const priceLists = state.posSettings?.priceLists ?? [];
  const priceSchedules = state.posSettings?.priceListSchedules ?? [];
  const referenceTimeMs = Date.parse(expected.identity?.referenceTime ?? "");
  const activeSessions = (state.sessions ?? []).filter((session) =>
    !session.revokedAt && Date.parse(session.expiresAt ?? "") > referenceTimeMs,
  );
  const revokedSessions = (state.sessions ?? []).filter((session) => Boolean(session.revokedAt));
  const expiredSessions = (state.sessions ?? []).filter((session) =>
    !session.revokedAt && Date.parse(session.expiresAt ?? "") <= referenceTimeMs,
  );

  if (dataset?.schemaVersion !== 2) errors.push("The golden dataset schemaVersion must be 2.");
  if (priceLists.length < 2) errors.push("At least two legacy price lists are required.");
  if (priceLists.filter((list) => Boolean(list.inheritsFromId ?? list.parentPriceListId)).length < 2) {
    errors.push("The price-list inheritance chain is not covered.");
  }
  if (priceSchedules.length < 2) errors.push("At least two price-list schedules are required.");
  if (!priceSchedules.some((schedule) => minuteOfDay(schedule.start) >= minuteOfDay(schedule.end))) {
    errors.push("An overnight price-list schedule is required.");
  }
  if (!priceSchedules.some((left, index) =>
    priceSchedules.slice(index + 1).some((right) => schedulesOverlap(left, right)),
  )) {
    errors.push("Overlapping price-list schedules are required.");
  }
  if ((state.posSettings?.menuSchedules ?? []).length === 0) {
    errors.push("At least one menu schedule is required.");
  }
  if ((state.posSettings?.areaMenus ?? []).length === 0) {
    errors.push("At least one area-to-menu assignment is required.");
  }
  if ((state.users ?? []).length < 2 || (state.userGroups ?? []).length === 0) {
    errors.push("Users and user groups are required.");
  }
  if (activeSessions.length === 0 || revokedSessions.length === 0 || expiredSessions.length === 0) {
    errors.push("Active, revoked and expired sessions are all required.");
  }

  const allergenItems = (state.menuItems ?? []).filter((item) =>
    Array.isArray(item.allergens ?? item.allergeni) && (item.allergens ?? item.allergeni).length > 0,
  );
  if (allergenItems.length === 0) errors.push("At least one product with allergens is required.");
  if (!allergenItems.some((item) => Array.isArray(item.ingredients) && item.ingredients.length > 0)) {
    errors.push("Allergens and ingredient labels must be independently represented.");
  }
  if (orders.length === 0) errors.push("The golden dataset must include at least one order.");
  if (!orders.some((order) => (order.items ?? []).length >= 3)) {
    errors.push("A multi-line order is required.");
  }
  if (!lines.some((line) => Boolean(line.variantId))) {
    errors.push("An order line with a variant is required.");
  }
  if (discountCents <= 0) errors.push("An order-level discount is required.");
  if (orderTotalCents + discountCents !== lineTotalCents) {
    errors.push("Order gross totals, discounts and line totals are inconsistent.");
  }

  if ((state.paymentParts ?? []).length < 2 ||
      (state.paymentTransactions ?? []).length < 2 ||
      (state.payments ?? []).length < 2) {
    errors.push("A split payment with multiple parts, transactions and payment rows is required.");
  }
  if (new Set(settledTransactions.map((entry) => entry.method)).size < 2) {
    errors.push("The split payment must use at least two methods.");
  }
  compareExpected(errors, "Settled payment cents", settledPaymentCents, expected.payment?.settledCents);
  compareExpected(errors, "Reservation count", reservationCount, expected.reservation?.count);
  compareExpected(errors, "Benefit redemption cents", redemptionCents, expected.benefit?.redemptionCents);
  compareExpected(errors, "Order line count", lines.length, expected.order?.lineCount);
  compareExpected(errors, "Order gross cents", lineTotalCents, expected.order?.grossCents);
  compareExpected(errors, "Order discount cents", discountCents, expected.order?.discountCents);
  compareExpected(errors, "Order total cents", orderTotalCents, expected.order?.totalCents);
  compareExpected(errors, "User count", (state.users ?? []).length, expected.identity?.userCount);
  compareExpected(errors, "Session count", (state.sessions ?? []).length, expected.identity?.sessionCount);
  compareExpected(errors, "Active session count", activeSessions.length, expected.identity?.activeSessionCount);
  compareExpected(errors, "Revoked session count", revokedSessions.length, expected.identity?.revokedSessionCount);
  compareExpected(errors, "Expired session count", expiredSessions.length, expected.identity?.expiredSessionCount);

  for (const coupon of state.commercialBenefitCoupons ?? []) {
    if (coupon.balanceCents < 0 || coupon.balanceCents > coupon.faceValueCents) {
      errors.push("Coupon " + coupon.id + " has an invalid balance.");
    }
  }
  if (!(state.commercialBenefitCoupons ?? []).some((coupon) =>
    coupon.status === "partially_redeemed" &&
    coupon.balanceCents > 0 &&
    coupon.balanceCents < coupon.faceValueCents,
  )) {
    errors.push("A partially redeemed benefit with residual balance is required.");
  }

  if ((dataset.pricingCases ?? []).length < 5 ||
      (dataset.pricingCases ?? []).length !== expected.pricing?.caseCount) {
    errors.push("The declared pricing-case coverage is incomplete.");
  }
  validatePricing(dataset, errors);
  return { ok: errors.length === 0, errors };
}
