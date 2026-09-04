import { test, expect } from "./fixtures/app-fixture.mjs";
import {
  TABLE_5,
  TABLE_6,
  TABLE_SALA_1,
  TABLE_SALA_2,
  browserApi,
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
  printOrder,
  readyOrder,
  saveGroups,
  setStationState,
  syncTable,
} from "./helpers/operational-gui.mjs";

function orderLineId(order, productId) {
  const item = (order.items ?? []).find((entry) => String(entry.productId ?? "") === productId);
  expect(item, `linea ${productId}`).toBeTruthy();
  return item.lineId;
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

test("[GUI-MAX-BOUNDARY] maxisimulazione limiti con totale >999, storno pagato, pausa postazione, unione, sostituzione e saldo", async ({
  browser,
  app,
}) => {
  test.setTimeout(90_000);
  const { context, page } = await openMobileLoggedIn(browser, app, {
    username: "manager",
    pin: "4444",
    deviceUuid: "max-boundary-manager",
  });
  try {
    await setStationState(page, { station: "BAR PRINCIPALE", active: true });
    await syncTable(page, TABLE_5, {
      occupancyState: "seated",
      covers: 1200,
      note: "Max boundary: coperti oltre soglia, totale alto, storni e cambio sala",
    });
    expect(findTable(await app.readState(), TABLE_5.id).covers).toBe(100);

    const big = await createOrder(page, {
      table: TABLE_5,
      covers: 100,
      lines: [line("Bloody Mary", 8, 126, { productId: "menu_drink_bloody_mary" })],
      total: 1008,
      note: "Ordine boundary totale >999",
      communications: "Controllare ristampe dopo spostamento",
    });
    await readyOrder(page, big.order.id);

    await payFreeSplit(page, TABLE_5, big.order.id, 8, {
      articleUnitIds: [`${big.order.id}_0_0`],
      releaseTable: false,
      note: "Quota articolo da stornare",
      txNote: "Transazione boundary articolo pagato",
    });
    const afterArticlePay = findOrder(await app.readState(), big.order.id);
    const comped = await compOrder(page, afterArticlePay, TABLE_5, {
      originalLineId: orderLineId(afterArticlePay, "menu_drink_bloody_mary"),
      quantity: 1,
      reason: "Storno boundary articolo pagato prima dello spostamento",
    });
    expect(comped.stornoPrintJob?.id).toBeTruthy();
    expect(comped.order.total).toBe(1000);
    expect(comped.order.dueAmount).toBe(1000);

    await payFreeSplit(page, TABLE_5, big.order.id, 333.35, { releaseTable: false, splitMode: "amount" });
    const overpay = await payFreeSplit(page, TABLE_5, big.order.id, 1000, { expectedStatus: 409, splitMode: "amount" });
    expect(overpay.code).toBe("PAYMENT_OVERPAYMENT");

    await moveTable(page, TABLE_5, TABLE_SALA_2);
    await printOrder(page, big.order.id, "order");
    await printOrder(page, big.order.id, "preconto");
    let state = await app.readState();
    expect(findOrder(state, big.order.id).tableId).toBe(TABLE_SALA_2.id);
    expect(findOrder(state, big.order.id).dueAmount).toBe(666.65);
    expect(printText(latestPrintJobFor(state, big.order.id, "order"))).toMatch(/SALA|TAV\.\s*2/i);

    await setStationState(page, { station: "BAR PRINCIPALE", active: false });
    const queued = await createOrder(page, {
      table: TABLE_6,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
      total: 1.3,
      note: "Creato mentre la postazione e in pausa",
    });
    expect(queued.pausedStationWarning?.message).toMatch(/Nessuna postazione attiva/i);
    await setStationState(page, { station: "BAR PRINCIPALE", active: true });
    await readyOrder(page, queued.order.id);

    await saveGroups(page, complexGroup(TABLE_SALA_2, TABLE_SALA_1));
    const child = await createOrder(page, {
      table: TABLE_SALA_1,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
      total: 1.5,
      note: "Ordine su figlio del tavolo complesso",
    });
    const correctedChild = await correctOrder(page, child.order, TABLE_SALA_2, {
      changedItems: [{ lineId: child.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Correzione dal capogruppo nella maxisimulazione",
    });
    expect(correctedChild.order.total).toBe(3);
    await readyOrder(page, correctedChild.order.id);
    const childReady = findOrder(await app.readState(), correctedChild.order.id);
    const replacement = await compOrder(page, childReady, TABLE_SALA_2, {
      originalLineId: childReady.items[0].lineId,
      quantity: 1,
      sendReplacement: true,
      reason: "Sostituzione boundary da tavolo complesso",
    });
    expect(replacement.replacementOrder.total).toBe(0);
    expect(replacement.replacementOrder.paymentStatus).toBe("paid");

    await payFreeSplit(page, TABLE_SALA_2, big.order.id, 666.65, { splitMode: "amount" });
    const remainingChild = findOrder(await app.readState(), child.order.id);
    await payFreeSplit(page, TABLE_SALA_1, remainingChild.id, remainingChild.dueAmount);
    await syncTable(page, TABLE_SALA_2, { occupancyState: "free" });
    await syncTable(page, TABLE_SALA_1, { occupancyState: "free" });
    await syncTable(page, TABLE_6, { occupancyState: "free" });
    await saveGroups(page, []);

    state = await app.readState();
    expect(findOrder(state, big.order.id).paymentStatus).toBe("paid");
    expect(findOrder(state, child.order.id).paymentStatus).toBe("paid");
    expect(findTable(state, TABLE_SALA_2.id).totalDue).toBe(0);
    expect(findTable(state, TABLE_SALA_1.id).totalDue).toBe(0);
    await expectPrinted(app, (job) => job.kind === "payment_storno" && /STORNO/i.test(printText(job)), "storno articolo pagato");
    await expectPrinted(app, (job) => job.kind === "bar_replacement" && job.orderId === replacement.replacementOrder.id, "tagliando sostituzione");
    await expectPrinted(app, (job) => job.kind === "preconto" && job.orderId === big.order.id, "preconto ordine alto");
  } finally {
    await context.close();
  }
});
