# CASSAv4 - P4.3 stateless mirror payment.free_split

Data: 2026-07-14

Target: Raspberry `192.168.1.79`, quattro core disponibili, release
`20260714-p4-payment-stateless-050858`.

## Decisione

- Correttezza consumer stateless, durabilita e recovery: **GO**.
- Canary 20 e 50, integrita e drain: **GO**.
- Correzione sessioni report multi-processo: **GO**.
- Gate prestazionale `payment.free_split` p95 <200 ms: **NO-GO**.
- Promozione live dei tre flag: **NO-GO, restano default OFF**.

Il consumer post-commit non legge piu `dbCache`, non esegue `readDb` e non
entra nella payment lane. Il payload conserva gli indici delle collezioni e il
worker costruisce uno stato sparso usando gli ordini relazionali autoritativi,
quindi applica solo upsert MySQL puntuali.

## Implementazione

- `payment-free-split-mirror-payload.js` conserva `id`, `position` e `value`
  per ogni record e le posizioni dei campi oggetto.
- `payment-free-split-stateless-mirror.js` valida il payload, ricostruisce lo
  snapshot minimo e rifiuta payload legacy o domini non puntuali.
- `payment-free-split-durable-mirror.js` usa il percorso stateless senza lane;
  il payload legacy mantiene il fallback protetto esistente.
- Metriche separate per claim/write/fallback stateless e claim legacy.
- Gating del flag stateless sui prerequisiti durable mirror, skip tavoli e
  split MySQL domini/audit.
- Gli handler report riusano `req.__authContext`: non rivalidano piu la
  sessione su uno snapshot locale API-worker potenzialmente stale.

Flag di rollback, tutti default OFF:

```text
BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR=0
BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES=0
BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER=0
```

## Test

- Suite rilevante locale: **174/174**.
- Stessa suite su Raspberry ARM: **174/174**.
- Include payload posizionale, worker senza `readDb`/lane, retry dello stesso
  snapshot, fallback legacy, crash recovery, rollback atomico, E2E
  write-primary, runtime metrics, policy architetturali e auth report stale.
- Budget `backend/server.js`: invariato a 38.797/39.500 righe.

## Canary

Profilo comune: 50 palmari, 4 postazioni, 3 GUI mobile Playwright, 1 GUI
postazione, 2 API worker, 1 table-lock worker, 50 SSE e simulatori loopback.
Stampa reale sempre esclusa dal test:

```text
LOADTEST_PRINTING_ENABLED=0
LOADTEST_ALLOW_NON_LOOPBACK_IO=0
```

Run conclusivo:
`p43_payment_stateless50_clean_20260714_0639`.

| Metrica | Durable 50 | Stateless 50 precedente | Stateless 50 finale |
| --- | ---: | ---: | ---: |
| Sonde HTTP 200 | 6/6 | 6/6 | 6/6 |
| Sonda p50 | 1.305 ms | 590 ms | 216 ms |
| Sonda p95/max | 3.237/3.237 ms | 2.502/2.502 ms | 1.860/1.860 ms |
| HTTP globale p50/p95 | 61/2.235 ms | 70/2.294 ms | 63/1.987 ms |
| HTTP globale p99/p99.9 | 11.665/24.146 ms | 11.090/20.965 ms | 11.097/24.251 ms |
| Realtime p50/p95/p99 | n/d/350/n/d ms | 156/322/600 ms | 159/283/360 ms |
| Failure globali | 3 | 2 | 0 |
| Mirror completed | 15 | 10 | 13 |
| Claim/write stateless | n/d | 10/10 | 14/13 |
| Retry recuperati | 1 | 0 | 1 |
| Fallback/legacy | n/d | 0/0 | 0/0 |
| Pending/failed final | 0/0 | 0/0 | 0/0 |
| Duplicati pagamento/fiscale | 0/0 | 0/0 | 0/0 |

Rispetto al durable 50 la sonda migliora dell'83,4% al p50 e del 42,5% al
p95. Rispetto al primo stateless 50 migliora del 63,4% al p50 e del 25,7% al
p95. Il p95 globale migliora dell'11,1% rispetto al durable e il realtime p95
del 19,1%.

Il retry unico e' stato causato da un conflitto transitorio sulla riga
`integration.orders`/station index. Il job e' stato ripreso dopo 250 ms e ha
terminato senza duplicati, fallback o residui.

La stampa ha 88 job `failed_final` perche il canary la disabilita
intenzionalmente; il gate del runner li esclude quando
`LOADTEST_PRINTING_ENABLED=0`. Il fiscale mock ha emesso 1/1 ricevuta e
l'outbox fiscale e' drenato senza errori.

Artefatti completi:

- `reports/p4_payment_stateless_mirror_20260714/canary20-clean/`;
- `reports/p4_payment_stateless_mirror_20260714/canary50/`;
- `reports/p4_payment_stateless_mirror_20260714/canary50-clean-final/`.

## Breakdown finale

| Fase | Media | Max |
| --- | ---: | ---: |
| Payment lane wait, completati | 468,08 ms | 1.535 ms |
| Domain prepare richiesta | 309,46 ms | 1.171 ms |
| Commit relazionale | 15,00 ms | 33 ms |
| Workflow richiesta totale | 410,62 ms | 1.222 ms |
| Enqueue mirror nel commit | 0 ms | 0 ms |
| Worker mirror completo | 517,15 ms | 1.007 ms |
| Upsert mirror ordini | 282,57 ms | 677 ms |
| Upsert mirror audit | 63,92 ms | 297 ms |

La lane wait e' ora attesa delle richieste concorrenti, non uso della lane da
parte del consumer. Il commit relazionale e l'enqueue non sono il collo.

## Sessioni report

Il canary precedente aveva due `history.payments` 401. Il middleware aveva
gia autenticato correttamente tramite Redis, ma l'handler report ripeteva la
validazione sulla cache locale dell'API worker. Il fix usa il contesto
middleware e mantiene la validazione locale solo come fallback.

Risultato finale:

- `history.payments`: 5/5 HTTP 200, p50 34 ms, p95 41 ms;
- `history.payments.final`: 1/1 HTTP 200, 15 ms;
- errori sessione: 0.

## Prossimo sottostep P4.3

Aggiornamento: il primo punto e' stato eseguito con profilo CPU ARM e riuso
del contesto POS sanificato sotto flag. L'A/B 20 migliora il p95 sonda da 587
a 329 ms, ma non supera il gate di 200 ms; il flag resta OFF e il canary 50 non
e' stato eseguito. Vedere
`FASE_P4_3_PAYMENT_FREE_SPLIT_SETTINGS_REUSE_AB_20260714.md`.

1. Profilare e ridurre `paymentFreeSplitWorkflow:domain.prepare`, ora 309,46
   ms medi e 1.171 ms max.
2. Rendere atomico/batch l'upsert mirror di ordine e station index per ridurre
   282,57 ms medi e il conflitto transitorio osservato.
3. Ripetere A/B 20/50 con gli stessi seed e mantenere i flag OFF finche il
   p95 sonda non scende sotto 200 ms in due run consecutivi.
4. Solo dopo il gate valutare un payment worker dedicato e load-100.

P4.3 resta aperta sul gate prestazionale; il sottostep consumer stateless e'
completato.
