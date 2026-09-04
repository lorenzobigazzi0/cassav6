/**
 * Rete di protezione per il dominio `app_meta`, scritta **prima** di toccare
 * `status.handlers.js`.
 *
 * Serve a una cosa precisa: `buildMonitorOverview` e la proiezione che la
 * circonda -- 590 righe -- stanno per essere estratte dalla chiusura della
 * factory, e oggi `monitor.control` e sfiorata da due sole menzioni in un altro
 * file mentre `appState.get`/`sync` non hanno alcun e2e. Senza queste
 * asserzioni un danno all'estrazione non avrebbe modo di farsi vedere.
 *
 * La stessa proiezione compare in **due posti** -- il corpo di
 * `/api/monitor/overview` e il campo `overview` della risposta di
 * `/api/monitor/control` -- e il test li confronta fra loro: e esattamente il
 * legame che un'estrazione sbagliata spezzerebbe.
 *
 * `reset_all_tables` non viene mai eseguita: e distruttiva. Si verifica solo
 * che venga rifiutata senza la conferma testuale.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost,
  authPayload,
  createSimpleOrder,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

const DISPOSITIVO = "collaudo-app-meta";

async function admin(baseUrl) {
  return loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: DISPOSITIVO,
    clientApp: "cassa-frontend",
  });
}

async function leggiOverview(baseUrl) {
  const risposta = await fetch(`${baseUrl}/api/monitor/overview`);
  assert.equal(risposta.status, 200);
  return risposta.json();
}

/** Le sezioni che la proiezione deve produrre, con il tipo atteso. */
const SEZIONI = {
  counts: "object",
  system: "object",
  api: "object",
  rooms: "array",
  tables: "array",
  orders: "array",
  payments: "array",
  fiscalReceipts: "array",
  operationMetrics: "object",
  stations: "array",
  missingPayments: "array",
  recentEvents: "array",
};

function verificaSezioni(overview, dove) {
  for (const [nome, tipo] of Object.entries(SEZIONI)) {
    const valore = overview[nome];
    if (tipo === "array") {
      assert.ok(Array.isArray(valore), `${dove}: ${nome} non e un array`);
    } else {
      assert.ok(
        valore && typeof valore === "object" && !Array.isArray(valore),
        `${dove}: ${nome} non e un oggetto`,
      );
    }
  }
  // `counts` porta due sottosezioni che si costruiscono a valle di tutto il
  // resto: se la proiezione si rompe a meta, spariscono queste.
  assert.ok(overview.counts.operations, `${dove}: manca counts.operations`);
  assert.ok(overview.counts.stations, `${dove}: manca counts.stations`);
  for (const chiave of ["total", "active", "stale"]) {
    assert.equal(
      typeof overview.counts.stations[chiave],
      "number",
      `${dove}: counts.stations.${chiave} non e un numero`,
    );
  }
  assert.equal(overview.ok, true, `${dove}: ok non e true`);
  assert.equal(typeof overview.generatedAt, "string", `${dove}: generatedAt assente`);
}

test("app_meta: /api/monitor/overview espone tutte le sezioni della proiezione", async (t) => {
  const { baseUrl } = await startBackend(t);
  const overview = await leggiOverview(baseUrl);

  verificaSezioni(overview, "overview");

  // Le sale arrivano da `posSettings` e sono deduplicate per id.
  const idSale = overview.rooms.map((sala) => sala.id);
  assert.equal(new Set(idSale).size, idSale.length, "sale duplicate");
  assert.ok(overview.rooms.every((sala) => sala.id && sala.name), "sala senza id o nome");

  // I tavoli portano il nome della sala risolto dalla mappa costruita sopra:
  // e il punto in cui `compactTable` e `roomNameById` devono restare insieme.
  assert.ok(overview.tables.length > 0, "nessun tavolo nella proiezione");
  const conSala = overview.tables.filter((tavolo) => tavolo.roomId);
  assert.ok(conSala.length > 0, "nessun tavolo con sala");

  assert.ok("runtimeFeatureProfile" in overview, "manca runtimeFeatureProfile");
});

test("app_meta: monitor/control rifiuta senza conferma e su bersaglio inesistente", async (t) => {
  const { baseUrl } = await startBackend(t);
  const sessione = await admin(baseUrl);
  const auth = (extra = {}) => authPayload(sessione, DISPOSITIVO, extra);

  const senzaConferma = await apiPost(
    baseUrl,
    "/api/monitor/control",
    auth({ action: "order_update", orderId: "qualsiasi" }),
  );
  assert.equal(senzaConferma.response.status, 400, JSON.stringify(senzaConferma.body));

  const inesistente = await apiPost(
    baseUrl,
    "/api/monitor/control",
    auth({ action: "order_update", orderId: "ordine_inesistente", confirm: true, patch: {} }),
  );
  assert.equal(inesistente.response.status, 404, JSON.stringify(inesistente.body));

  // `reset_all_tables` e distruttiva: qui si verifica **solo** che senza la
  // conferma testuale venga rifiutata. Non va mai eseguita davvero.
  const resetSenzaTesto = await apiPost(
    baseUrl,
    "/api/monitor/control",
    auth({ action: "reset_all_tables", confirm: true }),
  );
  assert.equal(resetSenzaTesto.response.status, 400, JSON.stringify(resetSenzaTesto.body));
  assert.match(String(resetSenzaTesto.body?.error ?? ""), /RESET/);
});

test("app_meta: monitor/control aggiorna una comanda e restituisce la stessa proiezione della overview", async (t) => {
  const { baseUrl } = await startBackend(t);
  const sessione = await admin(baseUrl);
  const auth = (extra = {}) => authPayload(sessione, DISPOSITIVO, extra);

  // La comanda arriva dal palmare e l'admin agisce dalla cassa: due sessioni
  // distinte, perche una sessione aperta con un `clientApp` non ne accetta un
  // altro (`SESSION_CLIENT_APP_MISMATCH`).
  const cameriere = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "collaudo-app-meta-palmare",
    clientApp: "mobile-frontend",
  });
  const creata = await createSimpleOrder(baseUrl, cameriere, {
    deviceUuid: "collaudo-app-meta-palmare",
  });
  assert.equal(creata.response.status, 200, JSON.stringify(creata.body));
  const idComanda = creata.body.order.id;

  const primaOverview = await leggiOverview(baseUrl);
  assert.ok(
    primaOverview.orders.some((ordine) => ordine.id === idComanda),
    "la comanda creata non compare nella overview",
  );

  const controllo = await apiPost(
    baseUrl,
    "/api/monitor/control",
    auth({
      action: "order_update",
      orderId: idComanda,
      confirm: true,
      patch: { workflowStatus: "ready" },
    }),
  );
  assert.equal(controllo.response.status, 200, JSON.stringify(controllo.body));
  assert.equal(controllo.body.ok, true);
  assert.equal(controllo.body.action, "order_update");
  assert.equal(controllo.body.result.order.id, idComanda);
  assert.equal(controllo.body.result.order.workflowStatus, "ready");

  // **Il legame che l'estrazione rischia di spezzare**: la risposta di control
  // incorpora la stessa proiezione servita da /api/monitor/overview.
  verificaSezioni(controllo.body.overview, "control.overview");
  const dopoOverview = await leggiOverview(baseUrl);
  assert.deepEqual(
    controllo.body.overview.rooms,
    dopoOverview.rooms,
    "le sale di control.overview non coincidono con quelle di monitor/overview",
  );
  // Sui tavoli non si confronta l'oggetto intero: porta campi che si muovono da
  // soli fra una chiamata e l'altra (tempi trascorsi, timestamp). Si confronta
  // cio che la proiezione deve garantire -- la struttura e lo stato -- che e
  // quello che un'estrazione sbagliata romperebbe.
  assert.deepEqual(
    Object.keys(controllo.body.overview.tables[0] ?? {}).sort(),
    Object.keys(dopoOverview.tables[0] ?? {}).sort(),
    "i tavoli di control.overview hanno campi diversi da quelli di monitor/overview",
  );
  // Nemmeno lo **stato** del tavolo si puo confrontare fra le due chiamate: e
  // stato misurato che `room_pedana_t05` passa da `waiting` a `payment_due`
  // fra la risposta di control e la lettura successiva, perche la conseguenza
  // finanziaria dell'aggiornamento si assesta dopo. Sarebbe un test sui tempi,
  // non sulla proiezione. Resta l'elenco dei tavoli, che invece deve coincidere.
  assert.deepEqual(
    controllo.body.overview.tables.map((tavolo) => tavolo.id),
    dopoOverview.tables.map((tavolo) => tavolo.id),
    "i tavoli di control.overview non coincidono con quelli di monitor/overview",
  );
  assert.deepEqual(
    controllo.body.overview.orders.map((ordine) => [ordine.id, ordine.workflowStatus]),
    dopoOverview.orders.map((ordine) => [ordine.id, ordine.workflowStatus]),
    "le comande di control.overview non coincidono con quelle di monitor/overview",
  );
  assert.deepEqual(
    controllo.body.overview.counts.stations,
    dopoOverview.counts.stations,
    "il riepilogo postazioni non coincide",
  );

  // L'aggiornamento e davvero passato dall'app-state, non solo dalla risposta.
  const aggiornata = dopoOverview.orders.find((ordine) => ordine.id === idComanda);
  assert.equal(aggiornata?.workflowStatus, "ready");
});

test("app_meta: reset_all_tables va a buon fine sul fixture isolato", async (t) => {
  // Questo caso esiste perche la sua assenza ha nascosto un difetto: il modello
  // di `monitor.control` usava `MONITOR_RESET_ALL_WRITE_DOMAINS` senza
  // riceverla, e sarebbe stato un 500 **solo** su questo ramo. La rete lo
  // saltava perche il reset e distruttivo -- ma lo e sul dataset reale, non sul
  // fixture che ogni test si crea da zero.
  const { baseUrl } = await startBackend(t);
  const sessione = await admin(baseUrl);
  const auth = (extra = {}) => authPayload(sessione, DISPOSITIVO, extra);

  const cameriere = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "collaudo-app-meta-reset",
    clientApp: "mobile-frontend",
  });
  const creata = await createSimpleOrder(baseUrl, cameriere, {
    deviceUuid: "collaudo-app-meta-reset",
  });
  assert.equal(creata.response.status, 200, JSON.stringify(creata.body));

  const reset = await apiPost(
    baseUrl,
    "/api/monitor/control",
    auth({ action: "reset_all_tables", confirm: true, confirmText: "RESET" }),
  );
  assert.equal(reset.response.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.ok, true);
  assert.equal(reset.body.action, "reset_all_tables");
  verificaSezioni(reset.body.overview, "reset.overview");

  // Dopo il reset nessun tavolo resta occupato.
  const dopo = await leggiOverview(baseUrl);
  const occupati = dopo.tables.filter((tavolo) => tavolo.status !== "free");
  assert.deepEqual(occupati, [], "il reset ha lasciato tavoli non liberi");
});

test("app_meta: /api/app-state e /api/app-state/sync espongono contatori coerenti", async (t) => {
  const { baseUrl } = await startBackend(t);
  const sessione = await admin(baseUrl);
  const auth = (extra = {}) => authPayload(sessione, DISPOSITIVO, extra);

  const stato = await apiPost(baseUrl, "/api/app-state", auth(), { method: "GET" });
  const lettura =
    stato.response.status === 200
      ? stato
      : await apiPost(baseUrl, "/api/app-state/sync", auth());
  assert.equal(lettura.response.status, 200, JSON.stringify(lettura.body));

  const corpo = lettura.body;
  assert.ok(Array.isArray(corpo.users), "users non e un array");
  assert.equal(corpo.users.length > 0, true, "nessun utente");
  for (const contatore of [
    "sessionsCount",
    "menuItemsCount",
    "paymentsCount",
    "auditEventsCount",
    "saleSessionsCount",
  ]) {
    assert.equal(typeof corpo[contatore], "number", `${contatore} non e un numero`);
  }
  assert.ok(corpo.posSettings, "manca posSettings");
  assert.ok(corpo.meta, "manca meta");
  assert.ok(Array.isArray(corpo.sampleMenuItems), "sampleMenuItems non e un array");
  assert.ok(corpo.sampleMenuItems.length <= 5, "sampleMenuItems oltre i cinque");

  // Il sync riporta `changed` e non deve alterare i conteggi quando non c'e
  // nulla da chiudere.
  const sync = await apiPost(baseUrl, "/api/app-state/sync", auth());
  assert.equal(sync.response.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.ok, true);
  assert.equal(typeof sync.body.changed, "boolean");
  assert.equal(sync.body.users.length, corpo.users.length);
  assert.equal(sync.body.menuItemsCount, corpo.menuItemsCount);
});

test("app_meta: /api/health porta settingsVersion, che e il ramo che legge l'app-state", async (t) => {
  const { baseUrl } = await startBackend(t);
  const risposta = await fetch(`${baseUrl}/api/health`);
  assert.equal(risposta.status, 200);
  const corpo = await risposta.json();

  assert.equal(corpo.ok, true);
  assert.equal(corpo.service, "cash-backend");
  assert.ok(corpo.database, "manca la sezione database");
  assert.equal(typeof corpo.database.mode, "string");
  // `settingsVersion` arriva dallo snapshot di salute oppure, in mancanza, da
  // `db.meta`: e l'unico accesso all'app-state di questa route.
  assert.equal(typeof corpo.settingsVersion, "number", "settingsVersion assente o non numerico");
});
