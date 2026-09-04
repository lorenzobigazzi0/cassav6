# Fase O - Riconciliazione roadmap architetturale e realtime

Data: 2026-07-03

## Obiettivo

Chiudere la duplicazione tra `ROADMAP_ARCHITETTURA_v4.1.0.md` e
`ROADMAP_REALTIME_CASSAV4_v4.md`, registrando nello stato architetturale quello
che e' gia' stato completato dalle fasi K/L/M/N del filone realtime.

## Modifiche

- Aggiornata `ROADMAP_ARCHITETTURA_v4.1.0.md` con sezione
  "Aggiornamento Fase O: 2026-07-03".
- Marcata Fase 2 come completata per backbone realtime, `idempotency_keys`,
  `event_outbox`, pagamenti/fiscale write-primary e ordini write-primary
  canary.
- Marcata Fase 3 come completata per pagamenti/fiscale, lasciando cassa
  automatica esplicitamente residua.
- Marcata Fase 4 come completata per ordini/state machine, lasciando tavoli,
  postazioni e load balancing alla validazione successiva.
- Aggiornato il primo backlog architetturale con stato riconciliato, evitando
  un backlog parallelo.
- Aggiornato `ADR-0001-modular-monolith.md` con riferimento alla revisione.
- Aggiunto `docs/architecture/ADR-0002-modular-monolith-revision-20260703.md`.
- Aggiunto test statico
  `backend/tests/architecture-roadmap-reconciliation.test.mjs`.

## Stato ADR

Decisione confermata: Sistema Cassa resta un modular monolith.

Motivo: `event_outbox`, `idempotency_keys` e le state machine principali hanno
ridotto il rischio, ma `server.js` e' ancora a 38.773 righe, cassa automatica e
radio/postazioni non sono consolidate allo stesso livello, e manca ancora la
validazione P con endurance/chaos.

## Verifiche

Sintassi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/architecture-roadmap-reconciliation.test.mjs
```

Risultato: ok.

Test documentali/architetturali:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-roadmap-reconciliation.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Risultato: 23/23 pass, durata `duration_ms=4159.573721`.

## Note operative

Il full gate backend completo non e' stato rilanciato in questa fase; l'ultimo
full gate registrato resta quello post M4 da 991/991 test passati.

## Prossimo step

Fase P - Validazione finale, endurance, chaos e go/no-go.
