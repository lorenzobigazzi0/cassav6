import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const roadmap = readFileSync(
  new URL("../../../ROADMAP_ARCHITETTURA_v4.1.0.md", import.meta.url),
  "utf8",
);
const adr0001 = readFileSync(
  new URL("../../../docs/architecture/ADR-0001-modular-monolith.md", import.meta.url),
  "utf8",
);
const adr0002 = readFileSync(
  new URL(
    "../../../docs/architecture/ADR-0002-modular-monolith-revision-20260703.md",
    import.meta.url,
  ),
  "utf8",
);

test("Fase O riconcilia roadmap architetturale e realtime senza backlog duplicato", () => {
  assert.match(
    roadmap,
    /Aggiornamento Fase O: 2026-07-03/,
    "la roadmap architetturale deve dichiarare la riconciliazione Fase O",
  );
  assert.match(
    roadmap,
    /ROADMAP_REALTIME_CASSAV4_v4\.md/,
    "la roadmap architetturale deve referenziare il filone realtime riconciliato",
  );
  assert.match(
    roadmap,
    /Fase 2[\s\S]+completata per backbone realtime[\s\S]+idempotency_keys[\s\S]+event_outbox/i,
    "Fase 2 deve segnare backbone/outbox/idempotenza come assorbiti dal filone realtime",
  );
  assert.match(
    roadmap,
    /Fase 3[\s\S]+pagamenti e fiscale: completati[\s\S]+cassa automatica: non marcata completata/i,
    "Fase 3 deve distinguere pagamenti/fiscale completati da cassa automatica residua",
  );
  assert.match(
    roadmap,
    /Fase 4[\s\S]+ordini: completati[\s\S]+tavoli, postazioni e load balancing: non marcati completati/i,
    "Fase 4 deve distinguere ordini completati da tavoli/postazioni/load balancing residui",
  );
  assert.match(
    roadmap,
    /non si\s+aprono duplicati/i,
    "la roadmap deve vietare il doppio backlog tra i due filoni",
  );
});

test("ADR-0002 registra revisione reale di ADR-0001 dopo K-L-M-N", () => {
  assert.match(
    adr0001,
    /ADR-0002-modular-monolith-revision-20260703\.md/,
    "ADR-0001 deve puntare alla revisione ADR-0002",
  );
  assert.match(
    adr0002,
    /La decisione di `ADR-0001` resta valida[\s\S]+\*\*modular monolith\*\*/i,
    "ADR-0002 deve confermare la decisione modular monolith",
  );
  assert.match(
    adr0002,
    /38\.773 righe/,
    "ADR-0002 deve usare il conteggio server.js reale della Fase O",
  );
  assert.match(
    adr0002,
    /event_outbox[\s\S]+idempotency_keys[\s\S]+payment-state-machine[\s\S]+order-state-machine[\s\S]+print-state-machine/,
    "ADR-0002 deve registrare backbone e state machine consolidate",
  );
  assert.match(
    adr0002,
    /Fase P[\s\S]+endurance[\s\S]+go\/no-go/i,
    "ADR-0002 deve rinviare la decisione successiva alla validazione finale",
  );
});
