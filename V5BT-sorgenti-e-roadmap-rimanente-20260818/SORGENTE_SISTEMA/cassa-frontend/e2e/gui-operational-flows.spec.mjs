import { test, expect } from "./fixtures/app-fixture.mjs";
import {
  TABLE_5,
  TABLE_6,
  TABLE_SALA_1,
  browserApi,
  cancelOrder,
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
  prepOrder,
  printOrder,
  readyOrder,
  saveGroups,
  setStationState,
  syncTable,
} from "./helpers/operational-gui.mjs";

test("[GUI-FLOW][01] catalogo mobile contiene articoli K cercabili", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const catalog = await browserApi(page, "/api/menu/catalog", {});
    const names = catalog.items.map((item) => item.name);
    expect(names).toContain("K Prosecco");
    expect(names).toContain("K Chardonnay");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][02] catalogo mobile trova gin e vodka nelle bevande", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const catalog = await browserApi(page, "/api/menu/catalog", {});
    const names = catalog.items.map((item) => item.name.toLowerCase());
    expect(names.some((name) => name.includes("gin"))).toBe(true);
    expect(names.some((name) => name.includes("vodka"))).toBe(true);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][03] mobile crea ordine con variante e note mantenendo dettagli riga", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      note: "Nota comanda GUI",
      communications: "Comunicazione interna",
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino", note: "Tiepido" })],
    });
    expect(created.order.items[0].note).toBe("Tiepido");
    expect(created.order.note).toBe("Nota comanda GUI");
    expect(created.order.communications).toBe("Comunicazione interna");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][04] ordine inviato da mobile appare nelle comande pubbliche", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    const orders = await browserApi(page, "/api/integration/orders", { includeDone: 1 }, { method: "GET" });
    expect(orders.orders.map((order) => order.id)).toContain(created.order.id);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][05] postazione pronta rende la comanda pagabile", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, { table: TABLE_5, lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })] });
    await readyOrder(page, created.order.id);
    const paid = await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
    expect(paid.payment.status).toBe("COMPLETED");
    expect(findOrder(await app.readState(), created.order.id).paymentStatus).toBe("paid");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][06] comanda in preparazione non e pagabile", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    await prepOrder(page, created.order.id);
    const denied = await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { expectedStatus: 409 });
    expect(denied.code).toBe("ORDER_NOT_PAYABLE");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][07] pagamento parziale aggiorna residuo tavolo", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" })],
      total: 2.6,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { releaseTable: false });
    const order = findOrder(await app.readState(), created.order.id);
    expect(order.paymentStatus).toBe("partial");
    expect(order.dueAmount).toBe(1.3);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][08] due pagamenti parziali chiudono la comanda", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" })],
      total: 2.6,
    });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3, { releaseTable: false });
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
    expect(findOrder(await app.readState(), created.order.id).paymentStatus).toBe("paid");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][09] pagamento per articolo mantiene gli altri articoli residui", async ({ browser, app }) => {
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
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3, {
      releaseTable: false,
      articleUnitIds: [`${created.order.id}_0_0`],
    });
    const order = findOrder(await app.readState(), created.order.id);
    expect(order.paymentStatus).toBe("partial");
    expect(order.dueAmount).toBe(1.6);
    expect(order.paidArticleUnits).toEqual([`${created.order.id}_0_0`]);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][10] occupazione tavolo salva coperti note e stato", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await syncTable(page, TABLE_5, { occupancyState: "seated", covers: 4, note: "Compleanno" });
    const table = findTable(await app.readState(), TABLE_5.id);
    expect(table.status).not.toBe("free");
    expect(table.covers).toBe(4);
    expect(table.note).toBe("Compleanno");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][11] tavolo pagato puo essere liberato", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app, { username: "cashier", pin: "2222" });
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    await readyOrder(page, created.order.id);
    await payFreeSplit(page, TABLE_5, created.order.id, 1.3);
    await syncTable(page, TABLE_5, { occupancyState: "free" });
    expect(findTable(await app.readState(), TABLE_5.id).status).toBe("free");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][12] cambio tavolo aggiorna la comanda digitale", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    await moveTable(page, TABLE_5, TABLE_6);
    const order = findOrder(await app.readState(), created.order.id);
    expect(order.tableId).toBe(TABLE_6.id);
    expect(order.tableNumber).toBe(TABLE_6.number);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][13] ristampa comanda e preconto restituisce job", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    const orderPrint = await printOrder(page, created.order.id, "order");
    const precontoPrint = await printOrder(page, created.order.id, "preconto");
    expect(orderPrint.jobId).toMatch(/^print_/);
    expect(precontoPrint.jobId).toMatch(/^print_/);

    const state = await app.readState();
    expect(latestPrintJobFor(state, created.order.id, "order").textPreview).toMatch(/TAV\./);
    expect(latestPrintJobFor(state, created.order.id, "preconto").textPreview).toMatch(/Tavolo|TAV\./i);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][14] unione tavoli viene salvata e riletta dal mobile", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const saved = await saveGroups(page, complexGroup());
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0].children.map((child) => child.id)).toEqual([TABLE_5.id, TABLE_6.id]);

    const listed = await browserApi(page, "/api/integration/table-groups", {}, { method: "GET" });
    expect(listed.groups).toEqual(saved.groups);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][15] divisione tavoli rimuove il gruppo complesso", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await saveGroups(page, complexGroup());
    const cleared = await saveGroups(page, []);
    expect(cleared.groups).toEqual([]);

    const listed = await browserApi(page, "/api/integration/table-groups", {}, { method: "GET" });
    expect(listed.groups).toEqual([]);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][16] modifica comanda cambia quantita e totale", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    const corrected = await correctOrder(page, created.order, TABLE_5, {
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Aggiunta cappuccino GUI",
    });
    expect(corrected.order.revision).toBe(2);
    expect(corrected.order.total).toBe(3.2);
    expect(findOrder(await app.readState(), created.order.id).items).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][17] modifica con revisione vecchia viene bloccata", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    const denied = await correctOrder(
      page,
      created.order,
      TABLE_5,
      {
        expectedRevision: 99,
        changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      },
      409
    );
    expect(denied.code).toBe("REVISION_CONFLICT");
    expect(findOrder(await app.readState(), created.order.id).revision).toBe(1);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][18] annullamento comanda aggiorna stato e residuo", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, { table: TABLE_5 });
    const cancelled = await cancelOrder(page, created.order, TABLE_5);
    expect(cancelled.order.workflowStatus).toMatch(/cancel/i);

    const order = findOrder(await app.readState(), created.order.id);
    expect(order.workflowStatus).toMatch(/cancel/i);
    expect(order.dueAmount).toBe(0);
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][19] articolo esaurito viene respinto dall'invio ordine", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await browserApi(page, "/api/actions", {
      type: "item_disable",
      itemName: "Bloody Mary",
      scope: "global",
      station: "BAR PRINCIPALE",
    });
    const denied = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
      expectedStatus: 409,
    });
    expect(denied.code).toBe("ITEM_UNAVAILABLE");
  } finally {
    await context.close();
  }
});

test("[GUI-FLOW][20] articolo riabilitato torna ordinabile", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    await browserApi(page, "/api/actions", {
      type: "item_disable",
      itemName: "Bloody Mary",
      scope: "global",
      station: "BAR PRINCIPALE",
    });
    await browserApi(page, "/api/actions", {
      type: "item_enable",
      itemName: "Bloody Mary",
      scope: "global",
      station: "BAR PRINCIPALE",
    });
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      total: 8,
    });
    expect(created.order.total).toBe(8);
  } finally {
    await context.close();
  }
});
