# ADR-0002 - Revisione Modular Monolith Dopo Roadmap Realtime

Data: 2026-07-03

Stato: accettata

## Contesto

`ADR-0001` ha scelto di mantenere Sistema Cassa v4.1.x come modular monolith,
rimandando eventuali servizi separati a quando i domini fossero piu' stabili.

Dopo le fasi K/L/M/N di `ROADMAP_REALTIME_CASSAV4_v4.md`, il sistema ha
consolidato parti importanti della roadmap architetturale:

- backbone realtime con `idempotency_keys` ed `event_outbox`;
- write-primary canary per pagamenti, fiscale e ordini;
- lane e metriche runtime per ridurre la contesa della coda globale;
- state machine esplicite per pagamenti, ordini e stampa;
- guardrail architetturali e report di fase aggiornati.

Metriche rilevate nel ramo operativo il 2026-07-03:

- `cassa-frontend/backend/server.js`: 38.773 righe;
- budget automatico corrente `server.js`: 39.500 righe;
- test backend `.mjs`: 134;
- ultimo full gate completo registrato: 991/991 test passati dopo M4;
- test mirati N3: 45/45 e 55/55 pass.

## Decisione

La decisione di `ADR-0001` resta valida: il sistema continua come
**modular monolith**.

Non si estrae ancora nessun servizio separato. I progressi su outbox,
idempotenza, write-primary e state machine riducono il rischio interno, ma non
sono ancora sufficienti per introdurre confini di rete tra domini fiscali,
stampa, radio o pagamenti.

`ROADMAP_ARCHITETTURA_v4.1.0.md` diventa il documento di governance
riconciliato. `ROADMAP_REALTIME_CASSAV4_v4.md` resta il riferimento esecutivo
per Fase P e per le evidenze gia' prodotte, senza aprire un secondo backlog
parallelo.

## Stato Dei Criteri ADR-0001

| Criterio | Stato 2026-07-03 | Nota |
|---|---|---|
| `server.js` sotto 15.000 righe | Non soddisfatto | 38.773 righe; budget corrente 39.500 rispettato |
| `event_outbox` in produzione/canary | Parzialmente soddisfatto | Migrazione 010, repository e test presenti; usato sui percorsi pagamenti/fiscale write-primary |
| `idempotency_keys` in produzione/canary | Parzialmente soddisfatto | Migrazione 010, repository e test presenti; usato sui pagamenti |
| State machine pagamenti | Soddisfatto | `modules/payments/payment-state-machine.js` |
| State machine ordini | Soddisfatto | `modules/orders/order-state-machine.js` |
| State machine stampa | Soddisfatto | `modules/print-spool/print-state-machine.js` |
| State machine fiscale/cassa automatica completa | Non soddisfatto | Fiscale coperto dal flusso pagamento; cassa automatica resta dominio da consolidare |
| Simulatori ufficiali fiscal/cassa/POS/stampanti | Parziale | Test e simulatori esistono, ma serve validazione P unica |
| Endurance 100 device/50 postazioni | Non soddisfatto | Da eseguire in Fase P |
| Nessun IP operativo hardcoded | Non verificato come chiuso | Resta criterio di gate/configurazione |

## Conseguenze

- Fase 2 e Fase 3 della roadmap architetturale non vengono piu' gestite come
  backlog parallelo per pagamenti/fiscale/ordini: lo stato reale e' quello del
  filone realtime.
- Il lavoro residuo passa a Fase P: endurance, caos, riconnessione, stampante e
  fiscale virtuali/reali, doppio incasso concorrente e decisione go/no-go.
- Ogni nuova estrazione da `server.js` deve continuare a ridurre rischio reale,
  non solo spostare righe.
- La soglia 15.000 righe resta criterio di revisione, non gate immediato.

## Prossima Revisione

Creare una nuova ADR solo dopo Fase P, se le prove di endurance e caos mostrano
che un dominio e' abbastanza stabile da valutare come servizio separato.
