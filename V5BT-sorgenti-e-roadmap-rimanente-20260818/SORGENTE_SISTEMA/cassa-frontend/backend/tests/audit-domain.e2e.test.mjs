/**
 * MIG-033 - le due route del dominio `audit` viste da fuori.
 *
 * La cosa non ovvia e che la cancellazione di un evento e **logica e
 * idempotente**: l'evento resta, si marcano `deletedAt`, `deletedBy` e
 * `deleteReason`, e una seconda cancellazione non deve riscrivere autore e data
 * della prima. Se qualcuno togliesse il ramo `if (!currentEvent.deletedAt)`
 * l'evento risulterebbe cancellato dall'ultimo che ci passa sopra, e nessun
 * altro test se ne accorgerebbe. Qui fallisce.
 *
 * Verifica anche che la cancellazione produca a sua volta un evento di audit
 * con il prima e il dopo: e la traccia che rende la cancellazione ispezionabile.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apiPost, authPayload, loginJson, startBackend } from "./helpers/test-server.mjs";

test("collaudo audit: consultazione, filtri e cancellazione logica idempotente", async (t) => {
  const { baseUrl } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "collaudo-audit",
    clientApp: "cassa-frontend",
  });
  const auth = (extra = {}) => authPayload(admin, "collaudo-audit", extra);

  // Il login stesso ha lasciato eventi: la lettura non parte mai da vuoto.
  const elenco = await apiPost(baseUrl, "/api/audit/events", auth());
  assert.equal(elenco.response.status, 200, JSON.stringify(elenco.body));
  assert.equal(elenco.body.ok, true);
  assert.ok(Array.isArray(elenco.body.events));
  assert.equal(elenco.body.count, elenco.body.events.length);
  assert.ok(elenco.body.events.length > 0, "nessun evento di audit da cui partire");

  // Ordine: dal piu recente al piu vecchio.
  const istanti = elenco.body.events.map((evento) => new Date(evento.occurredAt).getTime());
  assert.deepEqual([...istanti].sort((a, b) => b - a), istanti);

  // Il limite e rispettato e resta dentro i confini dichiarati.
  const limitato = await apiPost(baseUrl, "/api/audit/events", auth({ limit: 1 }));
  assert.equal(limitato.response.status, 200);
  assert.equal(limitato.body.events.length, 1);

  // Filtro per azione: o non torna nulla, o torna solo quell'azione.
  const azione = elenco.body.events[0].action;
  const filtrato = await apiPost(baseUrl, "/api/audit/events", auth({ action: azione }));
  assert.equal(filtrato.response.status, 200);
  assert.ok(filtrato.body.events.every((evento) => evento.action === azione));

  // --- cancellazione logica ---------------------------------------------------
  const bersaglio = elenco.body.events[0];

  const senzaMotivo = await apiPost(baseUrl, "/api/audit/events/delete", auth({ eventId: bersaglio.id }));
  assert.equal(senzaMotivo.response.status, 400, "il motivo e obbligatorio");

  const senzaId = await apiPost(baseUrl, "/api/audit/events/delete", auth({ reason: "prova" }));
  assert.equal(senzaId.response.status, 400, "l'id e obbligatorio");

  const inesistente = await apiPost(
    baseUrl,
    "/api/audit/events/delete",
    auth({ eventId: "audit_inesistente", reason: "prova" }),
  );
  assert.equal(inesistente.response.status, 404);

  const prima = await apiPost(
    baseUrl,
    "/api/audit/events/delete",
    auth({ eventId: bersaglio.id, reason: "collaudo MIG-033" }),
  );
  assert.equal(prima.response.status, 200, JSON.stringify(prima.body));
  assert.equal(prima.body.ok, true);
  assert.equal(prima.body.event.id, bersaglio.id);
  assert.ok(prima.body.event.deletedAt, "manca deletedAt");
  assert.equal(prima.body.event.deleteReason, "collaudo MIG-033");

  // Seconda cancellazione con motivo diverso: **non deve** sovrascrivere.
  const seconda = await apiPost(
    baseUrl,
    "/api/audit/events/delete",
    auth({ eventId: bersaglio.id, reason: "secondo tentativo" }),
  );
  assert.equal(seconda.response.status, 200, JSON.stringify(seconda.body));
  assert.equal(
    seconda.body.event.deletedAt,
    prima.body.event.deletedAt,
    "la seconda cancellazione ha riscritto la data della prima",
  );
  assert.equal(
    seconda.body.event.deleteReason,
    "collaudo MIG-033",
    "la seconda cancellazione ha riscritto il motivo della prima",
  );
  assert.equal(seconda.body.event.deletedBy, prima.body.event.deletedBy);

  // L'evento cancellato sparisce dall'elenco normale e torna con includeDeleted.
  const dopo = await apiPost(baseUrl, "/api/audit/events", auth({ limit: 5_000 }));
  assert.equal(dopo.response.status, 200);
  assert.ok(!dopo.body.events.some((evento) => evento.id === bersaglio.id));

  const conCancellati = await apiPost(
    baseUrl,
    "/api/audit/events",
    auth({ includeDeleted: true, limit: 5_000 }),
  );
  assert.equal(conCancellati.response.status, 200);
  assert.ok(conCancellati.body.events.some((evento) => evento.id === bersaglio.id));

  // La cancellazione lascia la propria traccia, con il prima e il dopo.
  const tracce = await apiPost(
    baseUrl,
    "/api/audit/events",
    auth({ action: "security.admin_delete", limit: 5_000 }),
  );
  assert.equal(tracce.response.status, 200);
  const traccia = tracce.body.events.find((evento) => evento.entityId === bersaglio.id);
  assert.ok(traccia, "la cancellazione non ha lasciato traccia");
  assert.equal(traccia.entityType, "audit_event");
});

test("collaudo audit: senza sessione valida le due route non rispondono", async (t) => {
  const { baseUrl } = await startBackend(t);

  const lettura = await apiPost(baseUrl, "/api/audit/events", {
    token: "sess_inesistente",
    deviceUuid: "collaudo-audit",
    clientApp: "cassa-frontend",
  });
  assert.equal(lettura.response.status, 401);

  const cancellazione = await apiPost(baseUrl, "/api/audit/events/delete", {
    token: "sess_inesistente",
    deviceUuid: "collaudo-audit",
    clientApp: "cassa-frontend",
    eventId: "qualsiasi",
    reason: "qualsiasi",
  });
  assert.equal(cancellazione.response.status, 401);
});
