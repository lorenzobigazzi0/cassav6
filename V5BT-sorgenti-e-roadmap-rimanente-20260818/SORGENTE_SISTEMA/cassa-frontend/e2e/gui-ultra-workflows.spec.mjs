import { test, expect } from "./fixtures/app-fixture.mjs";
import {
  TABLE_5,
  TABLE_6,
  TABLE_7,
  TABLE_8,
  TABLE_SALA_1,
  TABLE_SALA_2,
  TABLE_TERRACE_1,
  browserApi,
  cancelOrder,
  complexGroup,
  correctOrder,
  createOrder,
  findOrder,
  findTable,
  forceReleaseTableLock,
  latestPrintJobFor,
  line,
  moveTable,
  openFrontendPage,
  openMobileLoggedIn,
  payFreeSplit,
  payTable,
  prepOrder,
  printOrder,
  readyOrder,
  releaseTableLock,
  reservationAvailability,
  reservationCreate,
  reservationDelete,
  reservationList,
  reservationLockAcquire,
  reservationUpdate,
  saveGroups,
  setStationState,
  syncTable,
} from "./helpers/operational-gui.mjs";

test.describe.configure({ timeout: 90_000 });

const DAY_MS = 24 * 60 * 60 * 1000;

function serviceDate(offsetDays = 7) {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function reservationAt(date, time = "20:30") {
  return Date.parse(`${date}T${time}:00.000+02:00`);
}

async function openUltraRig(browser, app, label) {
  const manager = await openMobileLoggedIn(browser, app, { username: "ultra_manager", pin: "4444", deviceUuid: `${label}-manager` });
  const cashier = await openMobileLoggedIn(browser, app, { username: "ultra_cashier", pin: "2222", deviceUuid: `${label}-cashier` });
  const waiter = await openMobileLoggedIn(browser, app, { username: "ultra_waiter", pin: "3333", deviceUuid: `${label}-waiter` });
  const admin = await openMobileLoggedIn(browser, app, { username: "ultra_admin", pin: "1111", deviceUuid: `${label}-admin` });
  const stationA = await openFrontendPage(browser, app, "/postazione/", /Postazione/, { viewport: { width: 1280, height: 800 } });
  const stationB = await openFrontendPage(browser, app, "/postazione/", /Postazione/, { viewport: { width: 1280, height: 800 } });
  await setStationState(manager.page, {
    station: "BAR PRINCIPALE",
    active: true,
    operatorUserId: "u_ultra_manager",
    operatorUsername: "ultra_manager",
    operatorName: "Ultra Manager Test",
    operatorRole: "Bar",
  });
  await setStationState(admin.page, {
    station: "BAR SECONDARIO",
    active: true,
    operatorUserId: "u_ultra_admin",
    operatorUsername: "ultra_admin",
    operatorName: "Ultra Admin Test",
    operatorRole: "Bar",
  });
  return { manager, cashier, waiter, admin, stationA, stationB };
}

async function closeUltraRig(rig) {
  await Promise.allSettled([
    rig.manager.context.close(),
    rig.cashier.context.close(),
    rig.waiter.context.close(),
    rig.admin.context.close(),
    rig.stationA.context.close(),
    rig.stationB.context.close(),
  ]);
}

function expectPaid(order) {
  expect(order.paymentStatus).toBe("paid");
  expect(order.dueAmount).toBe(0);
}

async function waitForOrder(app, orderId) {
  let order = null;
  await expect
    .poll(async () => {
      order = findOrder(await app.readState(), orderId) ?? null;
      return Boolean(order);
    }, { timeout: 10_000, message: `order ${orderId} persisted` })
    .toBe(true);
  return order;
}

async function readyAssignedOrder(page, app, orderId) {
  const order = await waitForOrder(app, orderId);
  const station = order.lockedByStationId || order.ownerStation || order.assignedStationId || order.station || "BAR PRINCIPALE";
  return readyOrder(page, orderId, station);
}

async function prepAssignedOrder(page, app, orderId) {
  const order = await waitForOrder(app, orderId);
  const station = order.lockedByStationId || order.ownerStation || order.assignedStationId || order.station || "BAR PRINCIPALE";
  return prepOrder(page, orderId, station);
}

async function drainPreparationQueue(page, app, orders) {
  const isStationTerminal = (order) => ["ready", "delivered"].includes(order?.workflowStatus);
  let current = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await app.readState();
    current = orders.map((entry) => findOrder(state, entry.order.id));
    if (current.every(isStationTerminal)) return current;
    const preparing = current.find((order) => order?.workflowStatus === "prep");
    if (preparing?.id) {
      await readyAssignedOrder(page, app, preparing.id);
      await page.waitForTimeout(100);
      continue;
    }
    await page.waitForTimeout(250);
  }
  const statusSummary = current.map((order) => ({
    id: order?.id ?? null,
    workflowStatus: order?.workflowStatus ?? null,
    station: order?.station ?? order?.assignedStationId ?? null,
    ownerStation: order?.ownerStation ?? null,
  }));
  throw new Error(`Queued orders not ready after drain: ${JSON.stringify(statusSummary)}`);
}

test("[GUI-ULTRA][01] prenotazione e cinque tavoli misti con 4 palmari e 2 postazioni", async ({ browser, app }) => {
  const rig = await openUltraRig(browser, app, "ultra-01");
  try {
    const date = serviceDate(8);
    const bookingTime = reservationAt(date, "20:30");
    const booking = await reservationCreate(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: bookingTime,
      customerName: "Ultra Cliente 01",
      customerPhone: "333000001",
      covers: 5,
      intolerances: ["glutine"],
      note: "Prenotazione ultra con tavoli misti",
      assignedTableId: TABLE_SALA_2.id,
    });
    const invalidBooking = await reservationCreate(
      rig.admin.page,
      {
        roomId: TABLE_SALA_2.roomId,
        serviceDate: date,
        reservationAt: bookingTime,
        customerName: "   ",
        customerPhone: "333000bad",
        covers: 5,
        assignedTableId: TABLE_SALA_1.id,
      },
      400
    );
    expect(invalidBooking.error).toMatch(/Nome prenotazione obbligatorio/i);
    const boundaryBooking = await reservationCreate(rig.admin.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: bookingTime + 4 * 60 * 60 * 1000,
      customerName: "Ultra Coperti Limite",
      customerPhone: "333999999",
      covers: 5000,
      intolerances: "x".repeat(400),
      note: "n".repeat(600),
      assignedTableId: TABLE_SALA_1.id,
    });
    expect(boundaryBooking.reservation.covers).toBe(100);
    expect(boundaryBooking.reservation.note.length).toBeLessThanOrEqual(280);
    await syncTable(rig.manager.page, TABLE_SALA_2, {
      occupancyState: "reserved",
      covers: 5,
      reservation: { customerName: "Ultra Cliente 01", time: "20:30" },
    });

    const orderA = await createOrder(rig.manager.page, {
      table: TABLE_5,
      lines: [line("Aperol Spritz", 8, 1, { productId: "menu_drink_aperol_spritz" })],
      total: 8,
    });
    const orderB = await createOrder(rig.cashier.page, {
      table: TABLE_6,
      lines: [line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" })],
      total: 2.6,
    });
    const orderC = await createOrder(rig.waiter.page, {
      table: TABLE_7,
      lines: [line("K Prosecco", 6, 2, { productId: "menu_vino_k_prosecco" })],
      total: 12,
    });

    await readyAssignedOrder(rig.manager.page, app, orderA.order.id);
    await payFreeSplit(rig.manager.page, TABLE_5, orderA.order.id, 3, { releaseTable: false, splitMode: "amount" });
    await prepAssignedOrder(rig.cashier.page, app, orderB.order.id);
    await saveGroups(rig.admin.page, complexGroup(TABLE_7, TABLE_8));
    await correctOrder(rig.waiter.page, orderC.order, TABLE_7, {
      changedItems: [{ lineId: orderC.order.items[0].lineId, nextQuantity: 3 }],
      reason: "Aggiunta prosecco tavolo complesso",
    });

    const availability = await reservationAvailability(rig.admin.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: bookingTime,
      tableIds: [TABLE_SALA_2.id, TABLE_SALA_1.id],
    });
    expect(availability.items.find((item) => item.tableId === TABLE_SALA_2.id)?.status).toBe("conflict");
    const badAvailability = await reservationAvailability(
      rig.admin.page,
      {
        roomId: TABLE_SALA_2.roomId,
        serviceDate: date,
        reservationAt: "non-data",
        tableIds: [TABLE_SALA_2.id],
      },
      400
    );
    expect(badAvailability.error).toMatch(/Orario prenotazione non valido/i);

    const state = await app.readState();
    await expect(reservationList(rig.manager.page, { roomId: TABLE_SALA_2.roomId, serviceDate: date })).resolves.toBeTruthy();
    expect(findOrder(state, orderA.order.id).dueAmount).toBe(5);
    expect(findOrder(state, orderB.order.id).workflowStatus).toBe("prep");
    expect(findOrder(state, orderC.order.id).total).toBe(18);
    expect(findTable(state, TABLE_SALA_2.id).covers).toBe(5);
    expect(state.posReservationStates.some((entry) => entry.reservations.some((item) => item.id === booking.reservation.id))).toBe(true);
  } finally {
    await closeUltraRig(rig);
  }
});

test("[GUI-ULTRA][02] lock prenotazione, conflitti, ordini paralleli e saldo residui", async ({ browser, app }) => {
  const rig = await openUltraRig(browser, app, "ultra-02");
  try {
    const date = serviceDate(9);
    const at = reservationAt(date, "21:00");
    const booking = await reservationCreate(rig.manager.page, {
      roomId: TABLE_SALA_1.roomId,
      serviceDate: date,
      reservationAt: at,
      customerName: "Ultra Lock",
      customerPhone: "333000002",
      covers: 4,
      intolerances: [],
      note: "Lock multi palmare",
      assignedTableId: TABLE_SALA_1.id,
    });
    const lock = await reservationLockAcquire(rig.manager.page, {
      roomId: TABLE_SALA_1.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
    });
    const conflict = await reservationLockAcquire(
      rig.admin.page,
      {
        roomId: TABLE_SALA_1.roomId,
        serviceDate: date,
        reservationId: booking.reservation.id,
      },
      409
    );
    expect(conflict.error).toMatch(/modifica|operatore/i);
    const fakeUpdate = await reservationUpdate(
      rig.admin.page,
      {
        roomId: TABLE_SALA_1.roomId,
        serviceDate: date,
        reservationId: booking.reservation.id,
        lockId: "lock-falso",
        patch: {
          note: "non deve passare",
        },
      },
      409
    );
    expect(fakeUpdate.error).toMatch(/Blocco|modifica|scaduto/i);
    const missingLockUpdate = await reservationUpdate(
      rig.admin.page,
      {
        roomId: TABLE_SALA_1.roomId,
        serviceDate: date,
        reservationId: booking.reservation.id,
        patch: {
          note: "non deve passare",
        },
      },
      400
    );
    expect(missingLockUpdate.error).toMatch(/Blocco modifica non valido/i);

    const [paidSource, waitingSource] = await Promise.all([
      createOrder(rig.cashier.page, {
        table: TABLE_5,
        lines: [line("Cappuccino", 1.6, 2, { productId: "menu_caffetteria_cappuccino" })],
        total: 3.2,
      }),
      createOrder(rig.admin.page, {
        table: TABLE_TERRACE_1,
        lines: [line("Mojito", 9, 1, { productId: "menu_drink_mojito" })],
        total: 9,
      }),
    ]);
    await readyAssignedOrder(rig.cashier.page, app, paidSource.order.id);
    await payFreeSplit(rig.cashier.page, TABLE_5, paidSource.order.id, 1.6, { releaseTable: false, splitMode: "roman" });
    await readyAssignedOrder(rig.admin.page, app, waitingSource.order.id);

    const updated = await reservationUpdate(rig.manager.page, {
      roomId: TABLE_SALA_1.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
      lockId: lock.lock.lockId,
      patch: {
        reservationAt: at + 30 * 60 * 1000,
        customerName: "Ultra Lock Aggiornata",
        customerPhone: "333000002",
        covers: 5,
        intolerances: ["lattosio"],
        note: "Aggiornata mentre altri tavoli lavorano",
        assignedTableId: TABLE_SALA_1.id,
      },
    });
    await payFreeSplit(rig.cashier.page, TABLE_5, paidSource.order.id, 1.6);

    const state = await app.readState();
    expect(updated.reservation.covers).toBe(5);
    expectPaid(findOrder(state, paidSource.order.id));
    expect(findOrder(state, waitingSource.order.id).dueAmount).toBe(9);
    expect(findOrder(state, waitingSource.order.id).roomId).toBe(TABLE_TERRACE_1.roomId);
  } finally {
    await closeUltraRig(rig);
  }
});

test("[GUI-ULTRA][03] quattro ordini in coda, due postazioni e avanzamento automatico", async ({ browser, app }) => {
  const rig = await openUltraRig(browser, app, "ultra-03");
  try {
    const date = serviceDate(10);
    await reservationCreate(rig.admin.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: reservationAt(date, "19:45"),
      customerName: "Ultra Coda",
      customerPhone: "333000003",
      covers: 3,
      intolerances: [],
      note: "Prenotazione durante coda",
      assignedTableId: TABLE_SALA_2.id,
    });
    const invalidAvailability = await reservationAvailability(
      rig.manager.page,
      {
        roomId: TABLE_SALA_2.roomId,
        serviceDate: date,
        reservationAt: "abc",
        tableIds: [TABLE_SALA_2.id],
      },
      400
    );
    expect(invalidAvailability.error).toMatch(/Orario prenotazione non valido/i);

    const orders = [
      await createOrder(rig.manager.page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      }),
      await createOrder(rig.cashier.page, {
        table: TABLE_6,
        lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
      }),
      await createOrder(rig.waiter.page, {
        table: TABLE_7,
        lines: [line("Aperol Spritz", 8, 1, { productId: "menu_drink_aperol_spritz" })],
        total: 8,
      }),
      await createOrder(rig.admin.page, {
        table: TABLE_SALA_1,
        lines: [line("K Chardonnay", 6, 1, { productId: "menu_vino_k_chardonnay" })],
        total: 6,
      }),
    ];

    let state = await app.readState();
    let current = orders.map((entry) => findOrder(state, entry.order.id));
    const initialPreparingCount = current.filter((order) => order.workflowStatus === "prep").length;
    const initialWaitingCount = current.filter((order) => order.workflowStatus === "waiting").length;
    expect(initialPreparingCount).toBeGreaterThanOrEqual(1);
    expect(initialPreparingCount).toBeLessThanOrEqual(2);
    expect(initialPreparingCount + initialWaitingCount).toBe(4);

    await drainPreparationQueue(rig.manager.page, app, orders);
    await payTable(rig.cashier.page, TABLE_5, { amountPaid: 1.3, cashGiven: 1.3 });
    await payTable(rig.cashier.page, TABLE_6, { amountPaid: 1.6, cashGiven: 1.6 });
    const forbiddenPay = await payTable(rig.waiter.page, TABLE_7, { amountPaid: 8, cashGiven: 8, expectedStatus: 403 });
    expect(forbiddenPay.code).toBe("PERMISSION_DENIED");
    await forceReleaseTableLock(rig.manager.page, TABLE_7.id);
    await payFreeSplit(rig.admin.page, TABLE_SALA_1, orders[3].order.id, 6);
    expectPaid(findOrder(await app.readState(), orders[3].order.id));
  } finally {
    await closeUltraRig(rig);
  }
});

test("[GUI-ULTRA][04] tavolo complesso, cambio tavolo, residuo, ristampe e nuovo ordine", async ({ browser, app }) => {
  const rig = await openUltraRig(browser, app, "ultra-04");
  try {
    const date = serviceDate(11);
    const booking = await reservationCreate(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: reservationAt(date, "22:00"),
      customerName: "Ultra Spostamento",
      customerPhone: "333000004",
      covers: 6,
      intolerances: ["frutta secca"],
      note: "Da spostare dopo ordine",
      assignedTableId: TABLE_SALA_2.id,
    });
    await syncTable(rig.manager.page, TABLE_SALA_2, {
      occupancyState: "reserved",
      covers: 6,
      reservation: { customerName: "Ultra Spostamento", time: "22:00" },
    });

    await saveGroups(rig.manager.page, complexGroup(TABLE_5, TABLE_6));
    const first = await createOrder(rig.manager.page, {
      table: TABLE_5,
      lines: [
        line("K Prosecco", 6, 2, { productId: "menu_vino_k_prosecco" }),
        line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" }),
      ],
      total: 14.6,
    });
    await readyAssignedOrder(rig.manager.page, app, first.order.id);
    await payFreeSplit(rig.manager.page, TABLE_5, first.order.id, 6, { releaseTable: false, splitMode: "amount" });
    await moveTable(rig.manager.page, TABLE_5, TABLE_SALA_1);
    await printOrder(rig.manager.page, first.order.id, "order");
    await printOrder(rig.manager.page, first.order.id, "preconto");

    const second = await createOrder(rig.admin.page, {
      table: TABLE_SALA_1,
      lines: [line("Latte Macchiato", 1.5, 2, { productId: "menu_caffetteria_latte_macchiato" })],
      total: 3,
    });
    await readyAssignedOrder(rig.admin.page, app, second.order.id);
    await releaseTableLock(rig.admin.page, TABLE_SALA_1.id);
    await payTable(rig.manager.page, TABLE_SALA_1, { amountPaid: 11.6, cashGiven: 11.6 });

    const lock = await reservationLockAcquire(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
    });
    const deleted = await reservationDelete(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
      lockId: lock.lock.lockId,
    });
    await syncTable(rig.manager.page, TABLE_SALA_2, { occupancyState: "free" });

    const state = await app.readState();
    expect(deleted.deleted).toBe(true);
    expectPaid(findOrder(state, first.order.id));
    expectPaid(findOrder(state, second.order.id));
    expect(latestPrintJobFor(state, first.order.id, "order").textPreview).toMatch(/TAV\. 1/);
    expect(findTable(state, TABLE_SALA_1.id).totalDue).toBe(0);
    expect(findTable(state, TABLE_SALA_2.id).status).toBe("free");
  } finally {
    await closeUltraRig(rig);
  }
});

test("[GUI-ULTRA][05] rientro postazione, articolo esaurito, annullo, modifica e liberazione tavoli", async ({ browser, app }) => {
  const rig = await openUltraRig(browser, app, "ultra-05");
  try {
    const date = serviceDate(12);
    await setStationState(rig.manager.page, {
      station: "BAR PRINCIPALE",
      active: false,
      operatorUserId: "u_ultra_manager",
      operatorUsername: "ultra_manager",
      operatorName: "Ultra Manager Test",
    });
    await setStationState(rig.admin.page, {
      station: "BAR SECONDARIO",
      active: false,
      operatorUserId: "u_ultra_admin",
      operatorUsername: "ultra_admin",
      operatorName: "Ultra Admin Test",
    });
    const queued = await createOrder(rig.manager.page, {
      table: TABLE_5,
      lines: [line("Aperol Spritz", 8, 1, { productId: "menu_drink_aperol_spritz" })],
      total: 8,
    });
    expect(queued.pausedStationWarning?.code).toBe("station_paused_only_target");
    await setStationState(rig.admin.page, { station: "BAR PRINCIPALE", active: true });

    await browserApi(rig.admin.page, "/api/actions", {
      type: "item_disable",
      itemName: "Mojito",
      scope: "global",
      station: "BAR PRINCIPALE",
    });
    const unavailable = await createOrder(
      rig.waiter.page,
      {
        table: TABLE_6,
        lines: [line("Mojito", 9, 1, { productId: "menu_drink_mojito" })],
        total: 9,
        expectedStatus: 409,
      }
    );
    expect(unavailable.code).toBe("ITEM_UNAVAILABLE");
    await releaseTableLock(rig.waiter.page, TABLE_6.id);
    const missingVariant = await createOrder(rig.admin.page, {
      table: TABLE_SALA_1,
      lines: [line("Capri", 12, 1, { productId: "menu_drink_premium_capri" })],
      total: 12,
      expectedStatus: 400,
    });
    expect(missingVariant.code).toBe("PREMIUM_ALCOHOL_VARIANT_REQUIRED");
    await releaseTableLock(rig.admin.page, TABLE_SALA_1.id);
    await browserApi(rig.admin.page, "/api/actions", {
      type: "item_enable",
      itemName: "Mojito",
      scope: "global",
      station: "BAR PRINCIPALE",
    });

    const cancellable = await createOrder(rig.cashier.page, {
      table: TABLE_6,
      lines: [line("Mojito", 9, 1, { productId: "menu_drink_mojito" })],
      total: 9,
    });
    const corrected = await correctOrder(rig.cashier.page, cancellable.order, TABLE_6, {
      changedItems: [{ lineId: cancellable.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Raddoppio prima annullo",
    });
    expect(corrected.order.total).toBe(18);
    const cancelled = await cancelOrder(rig.cashier.page, corrected.order, TABLE_6, {
      reason: "Cliente cambia tavolo e annulla",
    });
    expect(cancelled.order.dueAmount).toBe(0);

    const booking = await reservationCreate(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: reservationAt(date, "18:30"),
      customerName: "Ultra Cleanup",
      customerPhone: "333000005",
      covers: 2,
      intolerances: [],
      note: "Liberazione finale",
      assignedTableId: TABLE_SALA_2.id,
    });
    const lock = await reservationLockAcquire(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
    });
    await reservationUpdate(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
      lockId: lock.lock.lockId,
      patch: { ...booking.reservation, note: "Aggiornata e mantenuta" },
    });

    await readyAssignedOrder(rig.manager.page, app, queued.order.id);
    await payFreeSplit(rig.manager.page, TABLE_5, queued.order.id, 8);
    await syncTable(rig.manager.page, TABLE_5, { occupancyState: "free" });
    await releaseTableLock(rig.cashier.page, TABLE_6.id);
    await syncTable(rig.manager.page, TABLE_6, { occupancyState: "free" });

    const state = await app.readState();
    expectPaid(findOrder(state, queued.order.id));
    expect(findOrder(state, cancelled.order.id).workflowStatus).toMatch(/cancel/i);
    expect(findTable(state, TABLE_5.id).status).toBe("free");
    expect(findTable(state, TABLE_6.id).status).toBe("free");
    expect((await reservationList(rig.manager.page, { roomId: TABLE_SALA_2.roomId, serviceDate: date })).reservations).toHaveLength(1);
  } finally {
    await closeUltraRig(rig);
  }
});
