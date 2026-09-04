# Handover P4-P7

## Stato al 2026-07-13

- P3: completato e mantenuto come prerequisito del multi-processo.
- P4: implementazione e canary disponibili, ma gate prestazionale ancora rosso sotto carico 100 device.
- P5-P7: non completati; seguire `ROADMAP_COMPLETAMENTO_P4_P7_20260713.md` e la roadmap v5 originale.

## Aggiornamento P4.2 del 2026-07-13

- Aggiunta telemetria create-specifica per app-state, refresh esterni, auth,
  write-primary, outbox e risposta.
- Implementato il refresh parallelo atomico di lock tavolo e stati postazione
  dietro `BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH=1`, default OFF.
- Runner A/B aggiornato con
  `LOADTEST_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH=1` e breakdown dedicato.
- Regressione locale: 163/163; check backend e smoke runtime isolato verdi.
- Il flag resta NO-GO finche canary 20/50 e due load-100 sul target non sono
  verdi. Vedere
  `../cassa-frontend/FASE_P4_2_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH_20260713.md`.

## Ultime evidenze P4 incluse

### Profilo realistico 20 palmari / 4 postazioni

Run `realistic_preflight14_20260712_1700`:

- 3 frontend mobile reali Playwright e 1 frontend postazione reale.
- 20 client SSE connessi su 20.
- 1.065 richieste HTTP, 240 operazioni business, 0 risposte inattese.
- HTTP P50/P95/P98/P99/P99.9/max: 31/292/430/582/1.319/1.471 ms.
- SSE P50/P95/P99/P99.9: 128/249/268/438 ms.
- `order.create` P95: 165 ms.
- `payment.free_split` P95: 297 ms, sopra il gate di 200 ms.
- `notification.waiter` P95: 1.019 ms, sopra il gate di 500 ms.
- Drain finale completo; outbox, stampa e fiscale senza elementi pendenti o falliti.

### Carico 100 palmari / 10 postazioni

Run `p4_targeted_lock_load100_r2_20260712`:

- 5 frontend reali Playwright e 100 client SSE su 100.
- 2.114 richieste HTTP, 1.150 operazioni business, 0 risposte inattese.
- HTTP P50/P95/P98/P99/P99.9/max: 400/7.998/11.182/20.518/29.395/30.519 ms.
- SSE P50/P95/P99/P99.9: 292/1.085/1.564/1.791 ms.
- Drain finale completo; outbox, stampa e fiscale senza elementi pendenti o falliti.

I file `REPORT.md` sono la sintesi leggibile. I rispettivi `report.json` sono le evidenze complete e devono essere usati per ogni nuova comparazione formale.

## Sicurezza test

Le prove incluse hanno usato stampanti TCP, fiscale e cassa automatica simulati o disabilitati. Non sono stati usati dispositivi reali.
