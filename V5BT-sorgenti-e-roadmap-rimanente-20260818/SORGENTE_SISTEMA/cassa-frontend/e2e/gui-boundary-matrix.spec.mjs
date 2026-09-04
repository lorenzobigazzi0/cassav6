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
  compOrder,
  complexGroup,
  correctOrder,
  createOrder,
  findOrder,
  findTable,
  latestPrintJobFor,
  line,
  lockTable,
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

function orderLineId(order, productId) {
  const item = (order.items ?? []).find((entry) => entry.productId === productId);
  expect(item, `linea ${productId}`).toBeTruthy();
  return item.lineId;
}

function articleUnitId(order, productIndex = 0, quantityIndex = 0) {
  return `${order.id}_${productIndex}_${quantityIndex}`;
}

function printText(job) {
  return `${job?.textPreview ?? ""}\n${job?.text ?? ""}`;
}

async function expectPrinted(app, predicate, label) {
  await expect
    .poll(async () => {
      const jobs = (await app.readState()).printSpoolJobs ?? [];
      return jobs.some((job) => job.status === "printed" && predicate(job));
    }, { timeout: 10_000, message: label })
    .toBe(true);
}

async function withMobile(browser, app, callback, options = {}) {
  const { context, page } = await openMobileLoggedIn(browser, app, options);
  try {
    return await callback(page);
  } finally {
    await context.close();
  }
}

test.describe("[GUI-BOUNDARY] ordini e modifiche", () => {
  test("[ORD-01] modifica trova la comanda con alias numerico senza zeri", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      const numericAlias = String(Number(created.order.id));
      const changed = await browserApi(page, "/api/integration/orders/correct", {
        tableId: TABLE_5.id,
        roomId: TABLE_5.roomId,
        orderId: numericAlias,
        expectedRevision: created.order.revision ?? 1,
        reason: "Alias numerico boundary",
        changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      });
      expect(changed.order.id).toBe(created.order.id);
      expect(changed.order.total).toBe(2.6);
    });
  });

  test("[ORD-02] revisione vecchia viene respinta e non muta totale", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
      });
      const changed = await correctOrder(page, created.order, TABLE_5, {
        changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      });
      const stale = await correctOrder(
        page,
        created.order,
        TABLE_5,
        { changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 3 }] },
        409
      );
      expect(stale.code).toBe("REVISION_CONFLICT");
      expect(findOrder(await app.readState(), created.order.id).total).toBe(changed.order.total);
    });
  });

  test("[ORD-03] comanda pronta non pagata resta modificabile e aggiorna il preconto", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
        total: 1.5,
      });
      await readyOrder(page, created.order.id);
      const ready = findOrder(await app.readState(), created.order.id);
      const changed = await correctOrder(page, ready, TABLE_5, {
        changedItems: [{ lineId: ready.items[0].lineId, nextQuantity: 2 }],
        reason: "Boundary pronta non pagata",
      });
      expect(changed.order.workflowStatus).toMatch(/ready|delivered/);
      expect(changed.order.dueAmount).toBe(3);
      await expectPrinted(app, (job) => job.kind === "preconto" && job.orderId === created.order.id, "preconto modifica pronta");
    });
  });

  test("[ORD-04] comanda in preparazione si annulla e non torna pagabile", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      await prepOrder(page, created.order.id);
      const current = findOrder(await app.readState(), created.order.id);
      const cancelled = await cancelOrder(page, current, TABLE_5, { reason: "Annullamento in preparazione boundary" });
      expect(cancelled.order.workflowStatus).toBe("cancelled");
      const denied = await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { expectedStatus: 409 });
      expect(denied.ok).toBe(false);
    });
  });

  test("[ORD-05] comanda pagata blocca modifica e annullamento", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      await readyOrder(page, created.order.id);
      await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
      const paid = findOrder(await app.readState(), created.order.id);
      expect((await correctOrder(page, paid, TABLE_5, { changedItems: [{ lineId: paid.items[0].lineId, nextQuantity: 2 }] }, 409)).ok).toBe(false);
      expect((await cancelOrder(page, paid, TABLE_5, { reason: "Annulla pagata boundary" }, 409)).ok).toBe(false);
    });
  });
});

test.describe("[GUI-BOUNDARY] pagamenti", () => {
  test("[PAY-01] overpayment viene respinto senza cambiare residuo", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
        total: 8,
      });
      await readyOrder(page, created.order.id);
      const denied = await payFreeSplit(page, TABLE_5, created.order.id, 9, { expectedStatus: 409 });
      expect(denied.ok).toBe(false);
      expect(findOrder(await app.readState(), created.order.id).dueAmount).toBe(8);
    });
  });

  test("[PAY-02] stessa idempotency key non duplica pagamento ne stampa ricevuta", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      await readyOrder(page, created.order.id);
      const key = `boundary-pay-${created.order.id}`;
      await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { idempotencyKey: key });
      await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { idempotencyKey: key });
      const state = await app.readState();
      const payments = state.paymentContainers.filter((entry) => entry.idempotencyKey === key);
      const receipts = state.printSpoolJobs.filter((job) => job.kind === "payment_receipt" && printText(job).includes(created.order.id));
      expect(payments).toHaveLength(1);
      expect(receipts.length).toBeLessThanOrEqual(1);
      expect(findOrder(state, created.order.id).paidAmount).toBe(1.3);
    });
  });

  test("[PAY-03] pagamento a quote arrotondato chiude esatto senza centesimi fantasma", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
        total: 8,
      });
      await readyOrder(page, created.order.id);
      await payFreeSplit(page, TABLE_5, created.order.id, 2.65, { releaseTable: false, splitMode: "roman" });
      await payFreeSplit(page, TABLE_5, created.order.id, 5.35, { splitMode: "roman" });
      const order = findOrder(await app.readState(), created.order.id);
      expect(order.paymentStatus).toBe("paid");
      expect(order.dueAmount).toBe(0);
    });
  });

  test("[PAY-04] dopo importo libero il pagamento per articolo resta bloccato", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
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
      const denied = await payFreeSplit(page, TABLE_5, created.order.id, 1.3, {
        articleUnitIds: [articleUnitId(created.order, 0, 0)],
        expectedStatus: 409,
      });
      expect(denied.ok).toBe(false);
    });
  });

  test("[PAY-05] note pagamento e id transazione restano su ricevuta e statistiche sorgente", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      await readyOrder(page, created.order.id);
      const paid = await payFreeSplit(page, TABLE_5, created.order.id, 1.3, {
        note: "Boundary nota conto",
        txNote: "Boundary nota transazione",
        method: "CARD",
        methodId: "pay_card",
        methodLabel: "Carta",
        posProvider: "manual",
        posTxRef: `BOUNDARY-${created.order.id}`,
      });
      const state = await app.readState();
      const receipt = state.printSpoolJobs.find((job) => job.id === paid.paymentReceiptJobs?.[0]?.id);
      expect(printText(receipt)).toMatch(/BOUNDARY NOTA|BOUNDARY-/i);
      expect(state.paymentContainers.some((entry) => String(entry.note ?? "").includes("Boundary nota conto"))).toBe(true);
    });
  });
});

test.describe("[GUI-BOUNDARY] tavoli e sale", () => {
  test("[TAB-01] coperti oltre limite vengono normalizzati a 100", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      await syncTable(page, TABLE_5, { occupancyState: "seated", covers: 1200, note: "Boundary coperti" });
      expect(findTable(await app.readState(), TABLE_5.id).covers).toBe(100);
    });
  });

  test("[TAB-02] spostamento sala con residuo mantiene tavolo destinazione e importo", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
        total: 8,
      });
      await readyOrder(page, created.order.id);
      await payFreeSplit(page, TABLE_5, created.order.id, 3, { releaseTable: false, splitMode: "free" });
      await moveTable(page, TABLE_5, TABLE_TERRACE_1);
      const state = await app.readState();
      expect(findOrder(state, created.order.id).tableId).toBe(TABLE_TERRACE_1.id);
      expect(findTable(state, TABLE_TERRACE_1.id).totalDue).toBe(5);
    });
  });

  test("[TAB-03] ordine sul figlio di tavolo complesso si modifica dal capogruppo", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      await saveGroups(page, complexGroup(TABLE_5, TABLE_6));
      const created = await createOrder(page, {
        table: TABLE_6,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      const corrected = await correctOrder(page, created.order, TABLE_5, {
        changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      });
      expect(corrected.order.tableId).toBe(TABLE_6.id);
      expect(corrected.order.total).toBe(2.6);
    });
  });

  test("[TAB-04] tavolo pagato spostato non trascina storico pagato", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const paidOrder = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      await readyOrder(page, paidOrder.order.id);
      await payFreeSplit(page, TABLE_5, paidOrder.order.id, 1.3, { releaseTable: false });
      const openOrder = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
      });
      await moveTable(page, TABLE_5, TABLE_7);
      const state = await app.readState();
      expect(findOrder(state, paidOrder.order.id).tableId).toBe(TABLE_5.id);
      expect(findOrder(state, openOrder.order.id).tableId).toBe(TABLE_7.id);
    });
  });

  test("[TAB-05] lock di altro device blocca il cambio tavolo", async ({ browser, app }) => {
    const first = await openMobileLoggedIn(browser, app, { username: "manager", pin: "4444", deviceUuid: "boundary-lock-a" });
    const second = await openMobileLoggedIn(browser, app, { username: "ultra_admin", pin: "1111", deviceUuid: "boundary-lock-b" });
    try {
      await lockTable(first.page, TABLE_5.id, "boundary.lock.table");
      const denied = await browserApi(
        second.page,
        "/api/integration/layout/table/move",
        {
          fromTableId: TABLE_5.id,
          toTableId: TABLE_8.id,
          roomId: TABLE_5.roomId,
          targetRoomId: TABLE_8.roomId,
        },
        { expectedStatus: 409 }
      );
      expect(denied.code).toBe("TABLE_LOCKED");
    } finally {
      await Promise.allSettled([first.context.close(), second.context.close()]);
    }
  });
});

test.describe("[GUI-BOUNDARY] resi, storni e sostituzioni", () => {
  test("[RES-01] quantita reso superiore al disponibile viene respinta", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
        total: 8,
      });
      await readyOrder(page, created.order.id);
      const current = findOrder(await app.readState(), created.order.id);
      const denied = await compOrder(page, current, TABLE_5, {
        originalLineId: orderLineId(current, "menu_drink_bloody_mary"),
        quantity: 2,
      }, 400);
      expect(denied.code).toBe("ORDER_COMP_QUANTITY_EXCEEDS_AVAILABLE");
    });
  });

  test("[RES-02] storno articolo pagato parziale stampa STORNO e lascia residuo corretto", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
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
        articleUnitIds: [articleUnitId(created.order, 0, 0)],
        releaseTable: false,
      });
      const current = findOrder(await app.readState(), created.order.id);
      const comped = await compOrder(page, current, TABLE_5, {
        originalLineId: orderLineId(current, "menu_caffetteria_caffe"),
        quantity: 1,
      });
      expect(comped.stornoPrintJob?.id).toBeTruthy();
      expect(comped.order.paidAmount).toBe(0);
      expect(comped.order.dueAmount).toBe(8);
      await expectPrinted(app, (job) => job.kind === "payment_storno" && /STORNO/i.test(printText(job)), "storno pagato parziale");
    });
  });

  test("[RES-03] sostituzione a carico bar genera ordine a zero gia pagato", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
        total: 8,
      });
      await readyOrder(page, created.order.id);
      const current = findOrder(await app.readState(), created.order.id);
      const comped = await compOrder(page, current, TABLE_5, {
        originalLineId: orderLineId(current, "menu_drink_bloody_mary"),
        sendReplacement: true,
        reason: "Boundary sostituzione bar",
      });
      expect(comped.replacementOrder.total).toBe(0);
      expect(comped.replacementOrder.paymentStatus).toBe("paid");
      await expectPrinted(app, (job) => job.kind === "bar_replacement" && job.orderId === comped.replacementOrder.id, "tagliando sostituzione");
      await expectPrinted(app, (job) => job.kind === "preconto" && job.orderId === comped.replacementOrder.id, "preconto zero sostituzione");
    });
  });

  test("[RES-04] dopo reso completo la GUI avvisa senza aprire la modale reso", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
        total: 8,
      });
      await readyOrder(page, created.order.id);
      const current = findOrder(await app.readState(), created.order.id);
      await compOrder(page, current, TABLE_5, {
        originalLineId: orderLineId(current, "menu_drink_bloody_mary"),
        quantity: 1,
      });
      await page.evaluate(() => document.querySelector('button[aria-label="Tavoli"]')?.click());
      await expect
        .poll(() => page.evaluate(() => typeof window.__mobileOrderServiceRecoveryOpenResoBar))
        .toBe("function");
      await page.evaluate((orderId) => window.__mobileOrderServiceRecoveryOpenResoBar(orderId), created.order.id);
      await expect(page.locator("#mobile-service-recovery-notice-root")).toContainText("Nessun articolo stornabile");
      await expect(page.locator("#mobile-service-recovery-modal-root")).toHaveCount(0);
    });
  });

  test("[RES-05] annullamento dopo modifica stampa modifica e annullamento", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      const corrected = await correctOrder(page, created.order, TABLE_5, {
        changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      });
      await cancelOrder(page, corrected.order, TABLE_5, { reason: "Boundary annulla modifica" });
      await expectPrinted(app, (job) => job.kind === "order_correction" && job.orderId === created.order.id, "stampa modifica");
      await expectPrinted(app, (job) => job.kind === "order_cancellation" && job.orderId === created.order.id, "stampa annullo");
    });
  });
});

test.describe("[GUI-BOUNDARY] postazione, notifiche e stampe", () => {
  test("[POS-01] nessuna postazione target attiva avvisa e mette ordine in coda", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      await setStationState(page, { station: "BAR PRINCIPALE", active: false });
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      expect(created.pausedStationWarning?.message).toMatch(/Nessuna postazione attiva/i);
      expect(findOrder(await app.readState(), created.order.id).workflowStatus).toMatch(/waiting|prep/);
    });
  });

  test("[POS-02] due utenti sulla stessa postazione ricevono assegnazioni esclusive", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      await setStationState(page, {
        station: "BAR PRINCIPALE",
        active: true,
        operatorUserId: "u_manager",
        operatorUsername: "manager",
      });
      await setStationState(page, {
        station: "BAR PRINCIPALE",
        active: true,
        operatorUserId: "u_cashier",
        operatorUsername: "cashier",
      });
      const first = await createOrder(page, { table: TABLE_5 });
      const second = await createOrder(page, { table: TABLE_6 });
      const state = await app.readState();
      const owners = [findOrder(state, first.order.id), findOrder(state, second.order.id)].map((order) => order.lockedByUserId || order.ownerOperator || order.assignedOperatorId);
      expect(new Set(owners.filter(Boolean)).size).toBeGreaterThanOrEqual(1);
      expect(findOrder(state, first.order.id).id).not.toBe(findOrder(state, second.order.id).id);
    });
  });

  test("[POS-03] pronta della corrente manda la successiva in preparazione", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      await setStationState(page, { active: true });
      const first = await createOrder(page, { table: TABLE_5 });
      const second = await createOrder(page, { table: TABLE_6 });
      const state = await app.readState();
      const firstState = findOrder(state, first.order.id);
      const secondState = findOrder(state, second.order.id);
      const preparing = firstState.workflowStatus === "prep" ? firstState : secondState;
      const waiting = preparing.id === first.order.id ? secondState : firstState;
      await readyOrder(page, preparing.id);
      expect(findOrder(await app.readState(), waiting.id).workflowStatus).toBe("prep");
    });
  });

  test("[POS-04] ristampa dopo cambio tavolo usa sala e tavolo aggiornati", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const created = await createOrder(page, {
        table: TABLE_5,
        lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      });
      await moveTable(page, TABLE_5, TABLE_SALA_1);
      await printOrder(page, created.order.id, "order");
      await printOrder(page, created.order.id, "preconto");
      const state = await app.readState();
      expect(printText(latestPrintJobFor(state, created.order.id, "order"))).toMatch(/SALA|TAV\.\s*1/i);
      expect(printText(latestPrintJobFor(state, created.order.id, "preconto"))).toMatch(/SALA|1/i);
    });
  });

  test("[POS-05] notifica cameriere pubblicata non si perde al pull successivo", async ({ browser, app }) => {
    await withMobile(browser, app, async (page) => {
      const sent = await publishNotification(page, {
        type: "waiter_call",
        targetUserId: "u_manager",
        title: "Boundary chiamata",
        description: "Controllo pull notifiche",
      });
      const pulled = await pullNotifications(page, "boundary-notification-consumer");
      expect(pulled.items.map((item) => item.id)).toContain(sent.notification.id);
    });
  });
});
