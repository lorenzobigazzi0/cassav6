# CASSAv4 - P4.3 durable mirror payment.free_split

> Aggiornamento: il consumer stateless e la correzione auth report sono stati
> completati e verificati. Il seguito e' documentato in
> `FASE_P4_3_PAYMENT_FREE_SPLIT_STATELESS_MIRROR_20260714.md`.

Data: 2026-07-14

Target: Raspberry `192.168.1.79`, quattro core disponibili, release
`20260714-p4-payment-durable-mirror-042602`.

## Decisione

- Durabilita, idempotenza, drain e recovery: **GO**.
- Canary 20, correttezza mirror: **GO**.
- Canary 50, correttezza finale: **GO con un retry transitorio recuperato**.
- Gate prestazionale `payment.free_split` p95 <200 ms: **NO-GO**.
- Promozione live dei nuovi flag: **NO-GO, restano default OFF**.

Il mirror MySQL/app-state non e' piu nel percorso di risposta. L'ACK viene
emesso soltanto dopo il commit relazionale che contiene pagamento, quote,
transazioni, stato ordine/tavolo, outbox realtime e job mirror idempotente.
Il consumer post-commit completa il mirror con retry e crash recovery.

## Implementazione

- Migrazione `025_payment_mirror_outbox.sql`.
- Repository `PaymentMirrorOutboxRepository` con stati `pending`, `processing`,
  `retrying`, `completed` e `failed_final`.
- Enqueue nella stessa transazione SQLite del pagamento.
- Payload compatto versionato con i soli record prodotti dalla richiesta.
- Worker solo owner, claim con lease, backoff, reclaim startup e drain su
  `SIGINT`/`SIGTERM`.
- Merge di ordine e tavolo dalla snapshot relazionale autoritativa.
- Upsert MySQL puntuali per pagamento, container, quote, transazioni, provider,
  fiscale e benefici commerciali presenti nel payload.
- Skip del mirror legacy `posSettings.tables` consentito soltanto quando sono
  contemporaneamente attivi read-primary tavoli, read-primary layout e
  `tableStates` externalized.

Flag di rollback:

```text
BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR=0
BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES=0
```

Il primo flag viene ignorato senza
`BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1`. Il secondo viene
ignorato se manca anche uno solo dei tre prerequisiti relazionali.

## Test

- Test mirati payload, fast path, outbox, worker e metriche: 21/21.
- E2E write-primary, rollback atomico e policy architetturali: 144/144.
- Totale rilevante locale: 165/165.
- Totale rilevante ripetuto sul Raspberry: 165/165.
- Budget `backend/server.js`: 38.797/39.500, margine 703 righe.

L'E2E forza inoltre una failure dentro la transazione e verifica che pagamento,
outbox realtime e job mirror vengano annullati insieme. Il test di recovery
lascia un job `processing`, simula il riavvio e ne verifica il completamento.

## Canary

Tutti i run hanno usato 4 postazioni, 3 GUI mobile Playwright, 1 GUI
postazione, 2 API worker, 1 table-lock worker, simulatori loopback e:

```text
LOADTEST_PRINTING_ENABLED=0
LOADTEST_ALLOW_NON_LOOPBACK_IO=0
```

| Metrica | Baseline 20 | Finale 20 | Baseline 50 | Finale 50 |
| --- | ---: | ---: | ---: | ---: |
| Sonde HTTP 200 | 6/6 | 6/6 | 6/6 | 6/6 |
| Sonda p50 | 363 ms | 170 ms | 599 ms | 1.305 ms |
| Sonda p95/max | 830/830 ms | 495/495 ms | 6.026/6.026 ms | 3.237/3.237 ms |
| HTTP globale p50/p95 | 39/553 ms | 38/599 ms | 76/2.264 ms | 61/2.235 ms |
| HTTP globale p99/p99.9 | 1.030/1.883 ms | 1.025/1.750 ms | 9.013/19.019 ms | 11.665/24.146 ms |
| Realtime p95 | 250 ms | 260 ms | 306 ms | 350 ms |
| Mirror completed | n/d | 8 | n/d | 15 |
| Retry mirror | n/d | 0 | n/d | 1 recuperato |
| Pending/failed final | 0/0 | 0/0 | 0/0 | 0/0 |
| ID mirror/aggregati univoci | n/d | 8/8 | n/d | 15/15 |

Il p50 della sonda a 20 migliora del 53% e il p95 del 40%. A 50 il p95
migliora del 46%, ma il p50 peggiora e la coda lunga globale non migliora. Un
run intermedio con upsert puntuali ha misurato 124/271 ms a 20, confermando
anche una variabilita elevata sotto lo stesso profilo.

Artefatti:

- `reports/p4_payment_durable_mirror_20260714/measure20/`;
- `reports/p4_payment_durable_mirror_20260714/measure20-punctual/`;
- `reports/p4_payment_durable_mirror_20260714/measure20-relprimary/`;
- `reports/p4_payment_durable_mirror_20260714/measure50-relprimary/`.

## Diagnosi

Nel canary 50 il commit relazionale non e' il collo:

| Fase | Media | Max |
| --- | ---: | ---: |
| Payment lane wait, richieste completate | 1.574,73 ms | 4.960 ms |
| Domain prepare | 452,40 ms | 3.696 ms |
| Commit relazionale | 20,27 ms | 85 ms |
| Worker mirror completo | 1.306,80 ms | 3.064 ms |
| Singolo upsert record economico | 8-13 ms | 33-73 ms |

Il consumer continua a fare `readDb`, applica il payload al `dbCache` owner e
usa la stessa payment lane delle richieste live. A 50 device il lavoro
post-commit compete quindi ancora con i pagamenti e amplifica la coda, anche se
non ritarda direttamente l'ACK della propria richiesta.

Il retry mirror a 50 e' un deadlock InnoDB recuperato. Non ha prodotto
duplicati o residui. Le tre failure globali sono due `history.payments` HTTP
401 del runner e un click Playwright logout su nodo DOM sostituito; non sono
failure del pagamento, ma vanno eliminate prima del gate P4 finale.

## Prossimo sottostep P4.3

1. Rendere il consumer mirror stateless: niente `readDb`, niente mutazione del
   `dbCache` e niente payment lane.
2. Costruire snapshot minime direttamente dal payload e dalle righe
   relazionali autoritative, poi usare solo repository upsert per ID.
3. Conservare l'outbox come coordinamento, con retry/deadlock metriche e
   idempotenza invariati.
4. Correggere nel runner sessione report e click logout resiliente al rerender.
5. Ripetere canary 20/50; soltanto dopo un p95 <200 ms e zero retry crescente
   valutare il routing a un payment worker dedicato e l'A/B lane 2/4.

Fino ad allora P4.3 resta aperta e P4.4 non viene avviata.

## Stato runtime finale

- Owner, due API worker, realtime, table-lock worker e frontend attivi.
- `/api/health` HTTP 200 diretto e via HTTPS.
- Stampa TCP commerciale invariata e non usata dai canary.
- Fiscale e cassa automatica sul deploy puntano ai simulatori locali.
- `BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR` assente dal runtime live: OFF.
