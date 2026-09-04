import assert from "node:assert/strict";
import test from "node:test";
import {
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

/**
 * Sul sync del tavolo un campo vuoto e una richiesta esplicita di cancellare.
 *
 * Questi casi esistono perche la loro assenza ha nascosto un difetto silenzioso:
 * il vuoto veniva letto come "nessuna richiesta" e si ricadeva sempre sul valore
 * gia salvato, quindi allergie, intolleranza manuale e nota non si potevano piu
 * togliere da un tavolo se non liberandolo. La modale di rimozione lato cassa
 * sembrava funzionare e al ricarico le pastiglie tornavano tutte.
 *
 * Il campo **assente** deve invece continuare a valere "non toccare": e cio che
 * protegge un tavolo da un client che sincronizza senza conoscere l'anagrafica.
 */

const TABLE_ID = "room_pedana_t05";
const ROOM_ID = "room_pedana";
const DEVICE = "table-sync-intolerance-device";

function seedIntolerances(state) {
  const table = state.posSettings.tables.find((entry) => entry.id === TABLE_ID);
  assert.ok(table, `il fixture deve avere ${TABLE_ID}`);
  table.status = "waiting";
  table.covers = 2;
  table.note = "ALLERGIE / INTOLLERANZE";
  table.allergens = ["Latte", "Crostacei"];
  table.manualIntolerance = "Nickel";
}

const sync = (baseUrl, session, extra) =>
  apiPost(
    baseUrl,
    "/api/integration/layout/table/sync",
    authPayload(session, DEVICE, {
      roomId: ROOM_ID,
      tableId: TABLE_ID,
      tableNumber: 5,
      status: "waiting",
      occupancyState: "occupied",
      covers: 2,
      ...extra,
    }),
    { headers: authHeaders(session, DEVICE) },
  );

const tabella = (db) => db.posSettings.tables.find((entry) => entry.id === TABLE_ID);

test("il sync con i campi vuoti cancella allergie, intolleranza manuale e nota", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, { stateOverrides: seedIntolerances });
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE,
    clientApp: "mobile-frontend",
  });

  const esito = await sync(baseUrl, session, {
    note: "",
    allergens: [],
    manualIntolerance: "",
  });
  assert.equal(esito.response.status, 200, JSON.stringify(esito.body));

  const salvata = tabella(await readJson(dbPath));
  assert.deepEqual(salvata.allergens, []);
  assert.equal(salvata.manualIntolerance, "");
  assert.equal(salvata.note, "");
});

test("il sync senza quei campi lascia intatto cio che c'era", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, { stateOverrides: seedIntolerances });
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE,
    clientApp: "mobile-frontend",
  });

  const esito = await sync(baseUrl, session, {});
  assert.equal(esito.response.status, 200, JSON.stringify(esito.body));

  const salvata = tabella(await readJson(dbPath));
  assert.deepEqual(salvata.allergens, ["Latte", "Crostacei"]);
  assert.equal(salvata.manualIntolerance, "Nickel");
  assert.equal(salvata.note, "ALLERGIE / INTOLLERANZE");
});

test("si puo togliere una sola intolleranza lasciando le altre", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, { stateOverrides: seedIntolerances });
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE,
    clientApp: "mobile-frontend",
  });

  const esito = await sync(baseUrl, session, {
    note: "ALLERGIE / INTOLLERANZE",
    allergens: ["Latte"],
    manualIntolerance: "",
  });
  assert.equal(esito.response.status, 200, JSON.stringify(esito.body));

  const salvata = tabella(await readJson(dbPath));
  assert.deepEqual(salvata.allergens, ["Latte"]);
  assert.equal(salvata.manualIntolerance, "");
});

/**
 * I coperti di un tavolo che resta occupato non possono scendere a zero.
 *
 * Questo caso esiste perche la sua assenza ha lasciato passare tavoli occupati
 * con zero coperti: nella griglia la pastiglia dei coperti sparisce, perche non
 * c'e niente da mostrare. Il campo **assente** aveva gia il minimo a 1; uno
 * `covers: 0` esplicito no.
 */
test("un tavolo che non si libera conserva almeno un coperto", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, { stateOverrides: seedIntolerances });
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE,
    clientApp: "mobile-frontend",
  });

  const esito = await sync(baseUrl, session, { covers: 0 });
  assert.equal(esito.response.status, 200, JSON.stringify(esito.body));
  assert.equal(tabella(await readJson(dbPath)).covers, 1);
});

test("liberando il tavolo i coperti tornano a zero", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, { stateOverrides: seedIntolerances });
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE,
    clientApp: "mobile-frontend",
  });

  const esito = await apiPost(
    baseUrl,
    "/api/integration/layout/table/sync",
    authPayload(session, DEVICE, {
      roomId: ROOM_ID,
      tableId: TABLE_ID,
      tableNumber: 5,
      status: "free",
      occupancyState: "free",
      covers: 0,
    }),
    { headers: authHeaders(session, DEVICE) },
  );
  assert.equal(esito.response.status, 200, JSON.stringify(esito.body));
  assert.equal(tabella(await readJson(dbPath)).covers, 0);
});
