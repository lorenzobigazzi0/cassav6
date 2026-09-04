/**
 * MIG-032/033 - le route dei domini `catalog` e `commerce` viste da fuori.
 *
 * Serve a una cosa in particolare: `printCoupon` legge l'app-state, accoda il
 * job di stampa e poi rilegge prima di scrivere. Se qualcuno collassasse le due
 * letture in una, il job di stampa sparirebbe senza che nulla fallisse. Qui
 * fallisce.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apiPost, authPayload, loginJson, readJson, startBackend } from "./helpers/test-server.mjs";

test("collaudo catalog: catalogo, suggerimenti, menu in lettura e in scrittura", async (t) => {
  const { baseUrl } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "collaudo-admin",
    clientApp: "cassa-frontend",
  });
  const auth = () => authPayload(admin, "collaudo-admin");

  const catalogo = await apiPost(baseUrl, "/api/menu/catalog", auth());
  assert.equal(catalogo.response.status, 200);
  assert.ok(catalogo.body.categories.length > 0);
  assert.ok(Array.isArray(catalogo.body.activePriceListIds));

  const suggerimenti = await apiPost(baseUrl, "/api/settings/menu/suggestions", auth());
  assert.equal(suggerimenti.response.status, 200, JSON.stringify(suggerimenti.body));
  assert.equal(suggerimenti.body.ok, true);

  // Ramo di lettura: nessun `items` nel payload.
  const lettura = await apiPost(baseUrl, "/api/settings/menu", auth());
  assert.equal(lettura.response.status, 200);
  assert.ok(Array.isArray(lettura.body.items));
  const prima = lettura.body.items.length;

  // Ramo di scrittura: stesso path, `items` presente.
  const scrittura = await apiPost(baseUrl, "/api/settings/menu", {
    ...auth(),
    items: [
      ...lettura.body.items,
      { name: "Collaudo MIG-032", category: "Collaudo", price: 1.5, enabled: true },
    ],
  });
  assert.equal(scrittura.response.status, 200, JSON.stringify(scrittura.body));
  assert.equal(scrittura.body.items.length, prima + 1);
  assert.ok(scrittura.body.items.some((voce) => voce.name === "Collaudo MIG-032"));

  const menuIntegrazione = await fetch(`${baseUrl}/api/integration/menu`);
  assert.equal(menuIntegrazione.status, 200);
  const corpoIntegrazione = await menuIntegrazione.json();
  assert.equal(corpoIntegrazione.ok, true);
  assert.ok(Array.isArray(corpoIntegrazione.products));

  // Seconda chiamata: passa dalla cache veloce, che restituisce JSON gia serializzato.
  const dallaCache = await fetch(`${baseUrl}/api/integration/menu`);
  assert.equal(dallaCache.status, 200);
  assert.deepEqual((await dallaCache.json()).products, corpoIntegrazione.products);

  const piuVenduti = await fetch(`${baseUrl}/api/integration/menu/top-sold?days=7&limit=5`);
  assert.equal(piuVenduti.status, 200);
  const corpoPiuVenduti = await piuVenduti.json();
  assert.equal(corpoPiuVenduti.days, 7);
  assert.equal(corpoPiuVenduti.limit, 5);
});

test("collaudo commerce: campagna, stampa buono e job di stampa conservato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "collaudo-benefit",
    clientApp: "cassa-frontend",
  });
  const auth = () => authPayload(admin, "collaudo-benefit");

  const elenco = await apiPost(baseUrl, "/api/commercial-benefits/campaigns/list", auth());
  assert.equal(elenco.response.status, 200, JSON.stringify(elenco.body));
  assert.equal(elenco.body.ok, true);

  const creazione = await apiPost(baseUrl, "/api/commercial-benefits/campaigns", {
    ...auth(),
    title: "Collaudo MIG-033",
    benefitKind: "value_voucher",
    faceValueCents: 1000,
    residualPolicy: "keep_balance",
    codes: ["MIG0-3300-COLL"],
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2030-12-31T23:59:59.000Z",
  });
  assert.equal(creazione.response.status, 201, JSON.stringify(creazione.body));
  const buono = creazione.body.campaign?.coupons?.[0] ?? creazione.body.coupons?.[0];
  assert.ok(buono?.id, JSON.stringify(creazione.body));

  const primaDellaStampa = await readJson(dbPath);
  const jobPrima = (primaDellaStampa.printSpoolJobs ?? []).length;

  const stampa = await apiPost(baseUrl, "/api/commercial-benefits/print", {
    ...auth(),
    couponId: buono.id,
  });
  assert.equal(stampa.response.status, 200, JSON.stringify(stampa.body));
  assert.ok(stampa.body.printJob?.id, JSON.stringify(stampa.body));

  // Il cuore del collaudo: la scrittura che segue l'accodamento non deve
  // cancellare il job che l'accodamento ha appena inserito.
  const dopoLaStampa = await readJson(dbPath);
  const job = (dopoLaStampa.printSpoolJobs ?? []).find((voce) => voce.id === stampa.body.printJob.id);
  assert.ok(job, "il job di stampa e sparito dopo la scrittura successiva");
  assert.equal((dopoLaStampa.printSpoolJobs ?? []).length, jobPrima + 1);
  assert.ok(
    (dopoLaStampa.auditEvents ?? []).some((evento) => evento.action === "commercial_benefit.coupon_printed"),
    "manca l'evento di audit della stampa",
  );

  const aggiornamento = await apiPost(baseUrl, "/api/commercial-benefits/campaigns/update", {
    ...auth(),
    campaignId: creazione.body.campaign.id,
    title: "Collaudo MIG-033 aggiornato",
    benefitKind: "value_voucher",
    faceValueCents: 1000,
    residualPolicy: "keep_balance",
    status: "disabled",
  });
  assert.equal(aggiornamento.response.status, 200, JSON.stringify(aggiornamento.body));
  assert.equal(aggiornamento.body.campaign.title, "Collaudo MIG-033 aggiornato");
});
