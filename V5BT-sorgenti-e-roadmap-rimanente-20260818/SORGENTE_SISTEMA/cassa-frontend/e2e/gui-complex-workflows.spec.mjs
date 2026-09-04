import { test, expect } from "./fixtures/app-fixture.mjs";
import {
  TABLE_5,
  TABLE_6,
  TABLE_7,
  TABLE_SALA_1,
  TABLE_TERRACE_1,
  browserApi,
  cancelOrder,
  compOrder,
  complexGroup,
  correctOrder,
  createOrder,
  findOrder,
  findTable,
  latestPrintJobFor,
  line,
  moveTable,
  openMobileLoggedIn,
  payFreeSplit,
  payTable,
  prepOrder,
  printOrder,
  publishNotification,
  pullNotifications,
  readyOrder,
  saveGroups,
  setStationState,
  syncTable,
} from "./helpers/operational-gui.mjs";

function expectPaid(order) {
  expect(order.paymentStatus).toBe("paid");
  expect(order.dueAmount).toBe(0);
}

function orderLineId(order, productId) {
  const item = (order.items ?? []).find((entry) => entry.productId === productId);
  expect(item, `linea articolo ${productId}`).toBeTruthy();
  return item.lineId;
}

function printJobText(job) {
  return `${job?.textPreview ?? ""}\n${job?.text ?? ""}`;
}

async function expectPrintedJob(app, predicate, label) {
  await expect
    .poll(async () => {
      const jobs = (await app.readState()).printSpoolJobs ?? [];
      return jobs.some((job) => job.status === "printed" && predicate(job));
    }, { timeout: 10_000, message: label })
    .toBe(true);
}

async function expectPrinterOutput(app, pattern) {
  await expect.poll(() => app.printer.text(), { timeout: 10_000 }).toMatch(pattern);
}

test("[GUI-COMPLEX][01] pagamento parziale poi spostamento mantiene residuo e ristampe aggiornate", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 3, { releaseTable: false, splitMode: "free" });
    await moveTable(page, TABLE_5, TABLE_6);
    await printOrder(page, created.order.id, "order");
    await printOrder(page, created.order.id, "preconto");

    const state = await app.readState();
    const order = findOrder(state, created.order.id);
    expect(order.tableId).toBe(TABLE_6.id);
    expect(order.dueAmount).toBe(5);
    expect(latestPrintJobFor(state, created.order.id, "order").textPreview).toMatch(/TAV\. 6/);
    expect(latestPrintJobFor(state, created.order.id, "preconto").textPreview).toMatch(/6/);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][02] saldo dopo spostamento chiude ordine e tavolo destinazione", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 2, { releaseTable: false, splitMode: "amount" });
    await moveTable(page, TABLE_5, TABLE_6);
    await payFreeSplit(page, TABLE_6, created.order.id, 6);

    const state = await app.readState();
    expectPaid(findOrder(state, created.order.id));
    expect(findTable(state, TABLE_6.id).totalDue).toBe(0);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][03] unione tavoli permette modifica da tavolo principale su ordine del figlio", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await saveGroups(page, complexGroup());
    const created = await createOrder(page, {
      table: TABLE_6,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    const corrected = await correctOrder(page, created.order, TABLE_5, {
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Modifica da tavolo unito",
    });
    expect(corrected.order.total).toBe(3.2);
    expect(findOrder(await app.readState(), created.order.id).items).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][04] unione e divisione aggiornano etichetta di ristampa", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    await saveGroups(page, complexGroup());
    await printOrder(page, created.order.id, "order");
    expect(latestPrintJobFor(await app.readState(), created.order.id, "order").textPreview).toMatch(/TAV\. 5\/6/);

    await saveGroups(page, []);
    await printOrder(page, created.order.id, "order");
    const textPreview = latestPrintJobFor(await app.readState(), created.order.id, "order").textPreview;
    expect(textPreview).toMatch(/TAV\. 5/);
    expect(textPreview).not.toMatch(/TAV\. 5\/6/);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][05] preparazione blocca pagamento poi pronta lo sblocca", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await prepOrder(page, created.order.id);
    const denied = await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { expectedStatus: 409 });
    expect(denied.code).toBe("ORDER_NOT_PAYABLE");
    await readyOrder(page, created.order.id);
    const paid = await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
    expect(paid.payment.status).toBe("COMPLETED");
    expectPaid(findOrder(await app.readState(), created.order.id));
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][06] due ordini sullo stesso tavolo mantengono pagato e residuo separati", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const first = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(page, first.order.id);
    await payFreeSplit(page, TABLE_5, first.order.id, 1.3, { releaseTable: false });
    const second = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    await readyOrder(page, second.order.id);

    const state = await app.readState();
    expectPaid(findOrder(state, first.order.id));
    expect(findOrder(state, second.order.id).dueAmount).toBe(1.6);
    expect(findTable(state, TABLE_5.id).totalDue).toBe(1.6);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][07] iniziato pagamento a quote poi pagamento per articolo viene bloccato", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" }),
      ],
      total: 2.9,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1, { releaseTable: false, splitMode: "roman" });
    const denied = await payFreeSplit(page, TABLE_5, created.order.id, 1.3, {
      articleUnitIds: [`${created.order.id}_0_0`],
      expectedStatus: 409,
      releaseTable: false,
    });
    expect(denied.ok).toBe(false);
    expect(findOrder(await app.readState(), created.order.id).paymentStatus).toBe("partial");
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][08] importo libero parziale poi conto unico chiude tutto", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" }),
      ],
      total: 2.9,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1, { releaseTable: false, splitMode: "amount" });
    await payTable(page, TABLE_5, { amountPaid: 1.9, cashGiven: 1.9 });
    expectPaid(findOrder(await app.readState(), created.order.id));
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][09] pagamento di due quote scala il residuo corretto", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 2, { productId: "menu_drink_bloody_mary" })],
      total: 16,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 8, { releaseTable: false, splitMode: "roman" });
    const order = findOrder(await app.readState(), created.order.id);
    expect(order.paymentStatus).toBe("partial");
    expect(order.dueAmount).toBe(8);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][10] nota pagamento arriva nella stampa ricevuta", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    await readyOrder(page, created.order.id);
    const paid = await payFreeSplit(page, TABLE_5, created.order.id, 8, {
      note: "Nota conto GUI complessa",
      txNote: "Nota transazione GUI",
    });
    expect(paid.paymentReceiptJobs?.[0]?.id).toMatch(/^print_/);
    const receipt = (await app.readState()).printSpoolJobs.find((job) => job.id === paid.paymentReceiptJobs[0].id);
    expect(receipt.textPreview).toMatch(/NOTA CONTO GUI COMPLESSA|NOTA TRANSAZIONE GUI/i);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][11] notifica cameriere pubblicata viene consegnata al pull", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const notification = await publishNotification(page, {
      type: "waiter_call",
      title: "GUI chiamata tavolo",
      description: "Richiesta test complesso",
      targetUserId: "u_manager",
    });
    const pulled = await pullNotifications(page, "gui-complex-consumer");
    expect(notification.notification.id).toBeTruthy();
    expect(pulled.items.map((entry) => entry.id)).toContain(notification.notification.id);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][12] postazione in pausa genera avviso ordine in coda", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await setStationState(page, { active: false });
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    expect(created.pausedStationWarning?.code).toBe("station_paused_only_target");
    expect(created.pausedStationWarning?.message).toMatch(/Nessuna postazione attiva/i);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][13] postazione riattivata completa ordine creato in coda", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    await setStationState(page, { active: false });
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    expect(created.pausedStationWarning?.code).toBe("station_paused_only_target");
    const returned = await setStationState(page, { active: true });
    expect(returned.station.active).toBe(true);
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 8);
    await expect
      .poll(async () => findOrder(await app.readState(), created.order.id)?.paymentStatus, { timeout: 10_000 })
      .toBe("paid");
    expect(findOrder(await app.readState(), created.order.id).dueAmount).toBe(0);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][14] coda postazione assegna una sola comanda in preparazione", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await setStationState(page, { active: true });
    const first = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const second = await createOrder(page, {
      table: TABLE_6,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
      total: 1.5,
    });
    const orders = [findOrder(await app.readState(), first.order.id), findOrder(await app.readState(), second.order.id)];
    expect(orders.filter((order) => order.workflowStatus === "prep")).toHaveLength(1);
    expect(orders.filter((order) => order.workflowStatus === "waiting")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][15] pronta della prima comanda manda automaticamente la successiva in preparazione", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await setStationState(page, { active: true });
    const first = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const second = await createOrder(page, {
      table: TABLE_6,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
      total: 1.5,
    });
    const state = await app.readState();
    const firstState = findOrder(state, first.order.id);
    const secondState = findOrder(state, second.order.id);
    const preparing = firstState.workflowStatus === "prep" ? firstState : secondState;
    const waiting = preparing.id === first.order.id ? secondState : firstState;

    await readyOrder(page, preparing.id);
    expect(findOrder(await app.readState(), waiting.id).workflowStatus).toBe("prep");
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][16] lock contemporaneo sullo stesso tavolo viene respinto", async ({ browser, app }) => {
  const first = await openMobileLoggedIn(browser, app, { username: "manager", pin: "4444", deviceUuid: "gui-lock-manager" });
  const second = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222", deviceUuid: "gui-lock-cashier" });
  try {
    await browserApi(first.page, "/api/tables/lock/acquire", { tableId: TABLE_5.id, purpose: "gui.lock.first" });
    const denied = await browserApi(
      second.page,
      "/api/tables/lock/acquire",
      { tableId: TABLE_5.id, purpose: "gui.lock.second" },
      { expectedStatus: 409 }
    );
    expect(denied.code).toBe("TABLE_LOCKED");
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("[GUI-COMPLEX][17] reload mobile dopo pagamento parziale conserva il residuo", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 3, { releaseTable: false, splitMode: "free" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".system-status .mobile-battery-widget")).toBeVisible({ timeout: 15_000 });
    expect(findOrder(await app.readState(), created.order.id).dueAmount).toBe(5);
    await payFreeSplit(page, TABLE_5, created.order.id, 5);
    expectPaid(findOrder(await app.readState(), created.order.id));
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][18] comanda pagata non puo essere annullata", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
    const denied = await cancelOrder(page, created.order, TABLE_5, { reason: "Tentativo annullo pagata" }, 409);
    expect(denied.ok).toBe(false);
    expectPaid(findOrder(await app.readState(), created.order.id));
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][19] comanda pagata non puo essere modificata", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
    const denied = await correctOrder(
      page,
      created.order,
      TABLE_5,
      { changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }] },
      409
    );
    expect(denied.ok).toBe(false);
    expectPaid(findOrder(await app.readState(), created.order.id));
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][20] flusso lungo: occupa, paga parziale, sposta, riordina, salda e libera", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await syncTable(page, TABLE_5, { occupancyState: "seated", covers: 3, note: "Flusso lungo GUI" });
    const first = await createOrder(page, {
      table: TABLE_5,
      lines: [
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }),
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
      ],
      total: 9.3,
    });
    await correctOrder(page, first.order, TABLE_5, {
      changedItems: [{ lineId: first.order.items[1].lineId, nextQuantity: 2 }],
      reason: "Aggiunto caffe nel flusso lungo",
    });
    await readyOrder(page, first.order.id);
    await payFreeSplit(page, TABLE_5, first.order.id, 4.3, { releaseTable: false, splitMode: "free" });
    await moveTable(page, TABLE_5, TABLE_SALA_1);

    const second = await createOrder(page, {
      table: TABLE_SALA_1,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
      total: 1.5,
    });
    await readyOrder(page, second.order.id);
    await payTable(page, TABLE_SALA_1, { amountPaid: 7.8, cashGiven: 7.8 });
    await syncTable(page, TABLE_SALA_1, { occupancyState: "free" });

    const state = await app.readState();
    expectPaid(findOrder(state, first.order.id));
    expectPaid(findOrder(state, second.order.id));
    expect(findTable(state, TABLE_SALA_1.id).status).toBe("free");
    expect(findTable(state, TABLE_SALA_1.id).totalDue).toBe(0);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][21] annullamento dopo cambio tavolo azzera importi e stampa annullo", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" }),
      ],
      total: 2.8,
    });

    await moveTable(page, TABLE_5, TABLE_7);
    const moved = findOrder(await app.readState(), created.order.id);
    expect(moved.tableId).toBe(TABLE_7.id);

    const cancelled = await cancelOrder(page, moved, TABLE_7, { reason: "Cliente annulla dopo cambio tavolo" });
    expect(cancelled.order.workflowStatus).toBe("cancelled");
    expect(cancelled.order.total).toBe(0);
    expect(cancelled.order.dueAmount).toBe(0);

    const state = await app.readState();
    expect(findOrder(state, created.order.id).workflowStatus).toBe("cancelled");
    expect(findTable(state, TABLE_5.id).totalDue).toBe(0);
    expect(findTable(state, TABLE_7.id).totalDue).toBe(0);
    await expectPrintedJob(
      app,
      (job) => job.kind === "order_cancellation" && job.orderId === created.order.id && /ANNULL/i.test(printJobText(job)),
      "stampa annullamento comanda"
    );
    await expectPrinterOutput(app, /ANNULL/i);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][22] storno di articolo gia pagato dopo cambio sala mantiene residuo e stampa STORNO", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }),
      ],
      total: 9.3,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3, {
      articleUnitIds: [`${created.order.id}_0_0`],
      releaseTable: false,
    });

    await moveTable(page, TABLE_5, TABLE_TERRACE_1);
    const moved = findOrder(await app.readState(), created.order.id);
    expect(moved.tableId).toBe(TABLE_TERRACE_1.id);

    const comped = await compOrder(page, moved, TABLE_TERRACE_1, {
      originalLineId: orderLineId(moved, "menu_caffetteria_caffe"),
      quantity: 1,
      reason: "Storno articolo gia riscosso dopo cambio sala",
    });

    expect(comped.stornoPrintJob?.id).toMatch(/^print_/);
    expect(comped.order.total).toBe(8);
    expect(comped.order.paidAmount).toBe(0);
    expect(comped.order.dueAmount).toBe(8);
    await expectPrintedJob(
      app,
      (job) => job.kind === "payment_storno" && /STORNO/i.test(printJobText(job)) && /CAFFE/i.test(printJobText(job)),
      "stampa storno pagamento"
    );
    await expectPrinterOutput(app, /STORNO/i);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][23] reso con sostituzione su tavoli uniti genera comanda e preconto a zero", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await saveGroups(page, complexGroup(TABLE_5, TABLE_6));
    const created = await createOrder(page, {
      table: TABLE_6,
      lines: [
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }),
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
      ],
      total: 9.3,
    });
    await readyOrder(page, created.order.id);
    const current = findOrder(await app.readState(), created.order.id);

    const comped = await compOrder(page, current, TABLE_5, {
      originalLineId: orderLineId(current, "menu_drink_bloody_mary"),
      quantity: 1,
      reason: "Spritz caduto durante servizio tavolo unito",
      sendReplacement: true,
    });

    expect(comped.replacementOrder?.id).toBeTruthy();
    expect(comped.replacementOrder.total).toBe(0);
    expect(comped.replacementOrder.dueAmount).toBe(0);
    expect(comped.replacementOrder.paymentStatus).toBe("paid");
    expect(comped.replacementOrder.nonChargeableReplacement).toBe(true);
    await expectPrintedJob(app, (job) => job.kind === "bar_replacement" && job.orderId === comped.replacementOrder.id, "tagliando sostituzione");
    await expectPrintedJob(app, (job) => job.kind === "order" && job.orderId === comped.replacementOrder.id, "comanda sostituzione");
    await expectPrintedJob(app, (job) => job.kind === "preconto" && job.orderId === comped.replacementOrder.id, "preconto sostituzione a zero");
    await expectPrinterOutput(app, /SOSTITUZIONE|ABBUONO|PRECONTO/i);

    await saveGroups(page, []);
    expect((await app.readState()).integration.tableGroups).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][24] comanda modificata poi annullata conserva audit e stampe aggiornate", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
      total: 1.6,
    });
    const corrected = await correctOrder(page, created.order, TABLE_5, {
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      orderUpdates: {
        note: "Nota modificata prima dell'annullo",
        communications: "Comunicazione interna annullo",
      },
      reason: "Raddoppio errato da annullare",
    });
    expect(corrected.order.total).toBe(3.2);
    await printOrder(page, corrected.order.id, "order");
    await printOrder(page, corrected.order.id, "preconto");

    const cancelled = await cancelOrder(page, corrected.order, TABLE_5, { reason: "Cliente cambia idea dopo modifica" });
    expect(cancelled.order.workflowStatus).toBe("cancelled");

    await expectPrintedJob(
      app,
      (job) => job.kind === "order_correction" && job.orderId === created.order.id && /MODIFICA/i.test(printJobText(job)),
      "stampa modifica comanda"
    );
    await expectPrintedJob(
      app,
      (job) => job.kind === "order_cancellation" && job.orderId === created.order.id && /ANNULL/i.test(printJobText(job)),
      "stampa annullamento dopo modifica"
    );
    const state = await app.readState();
    expect(state.auditEvents.some((event) => event.action === "order.correction_applied" && event.entityId === created.order.id)).toBe(true);
    expect(state.auditEvents.some((event) => event.action === "order.cancelled" && event.entityId === created.order.id)).toBe(true);
  } finally {
    await context.close();
  }
});

test("[GUI-COMPLEX][25] storni multipli esauriscono gli articoli e la GUI mostra avviso senza aprire reso", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 2, { productId: "menu_drink_bloody_mary" })],
      total: 16,
    });
    await readyOrder(page, created.order.id);
    const firstCurrent = findOrder(await app.readState(), created.order.id);
    const lineId = orderLineId(firstCurrent, "menu_drink_bloody_mary");
    await compOrder(page, firstCurrent, TABLE_5, {
      originalLineId: lineId,
      quantity: 1,
      reason: "Primo storno GUI complessa",
    });
    const secondCurrent = findOrder(await app.readState(), created.order.id);
    await compOrder(page, secondCurrent, TABLE_5, {
      originalLineId: lineId,
      quantity: 1,
      reason: "Secondo storno GUI complessa",
    });
    const exhausted = findOrder(await app.readState(), created.order.id);
    const denied = await compOrder(page, exhausted, TABLE_5, {
      originalLineId: lineId,
      quantity: 1,
      reason: "Tentativo storno oltre disponibilita",
    }, 409);
    expect(denied.ok).toBe(false);
    expect(denied.error ?? denied.message).toMatch(/Nessun importo pagabile disponibile/i);

    await page.evaluate(() => document.querySelector('button[aria-label="Tavoli"]')?.click());
    await expect
      .poll(() => page.evaluate(() => typeof window.__mobileOrderServiceRecoveryOpenResoBar))
      .toBe("function");
    await page.evaluate((orderId) => window.__mobileOrderServiceRecoveryOpenResoBar(orderId), created.order.id);
    await expect(page.locator("#mobile-service-recovery-notice-root")).toBeVisible();
    await expect(page.locator("#mobile-service-recovery-notice-root")).toContainText("Nessun articolo stornabile");
    await expect(page.locator("#mobile-service-recovery-modal-root")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
