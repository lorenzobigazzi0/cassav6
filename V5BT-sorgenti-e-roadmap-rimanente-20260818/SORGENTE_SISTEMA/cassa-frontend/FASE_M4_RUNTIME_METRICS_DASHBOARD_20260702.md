# Fase M4 - dashboard metriche runtime

Data: 2026-07-02

## Obiettivo

Rendere visibili in modo operativo le metriche introdotte nelle fasi H/I/J/K/L/M:
outbox, idempotenza, fallback relazionale, concorrenza delle lane, retry fiscale
e p99 delle route calde.

Prima di M4 le metriche erano gia' raccolte in punti diversi del runtime, ma non
avevano una sintesi leggibile dal monitor e non esponevano un lag effettivo
dell'outbox basato sul record non pubblicato piu' vecchio.

## Modifiche

- `backend/db/relational/realtime-backbone.repo.js`
  - `EventOutboxRepository.countSummary()` ora restituisce anche
    `oldestUnpublishedAt`.

- `backend/modules/realtime-backbone/event-outbox.js`
  - La metrica `eventOutboxLagMs` viene calcolata dalla differenza fra `now` e il
    piu' vecchio evento outbox non pubblicato.
  - Il lag torna a `0` quando non ci sono eventi pendenti.

- `backend/modules/realtime-backbone/payment-idempotency.js`
  - Il coordinator accetta `metrics`.
  - Aggiunti counter per claim, conflitti, hit, replay falliti, in-progress,
    completati e falliti.

- `backend/server.js`
  - `runtimeMetrics` viene passato al payment idempotency coordinator.

- `backend/modules/runtime-metrics.js`
  - Aggiunto `buildRuntimeMetricsDashboard(snapshot)`.
  - Lo snapshot runtime ora contiene anche `dashboard`.
  - La dashboard sintetizza:
    - `realtimeBackbone.outboxLagMs`, backlog, failure e righe pubblicate;
    - `idempotency.attempts`, hit rate, conflitti, in-progress e replay falliti;
    - `relational.fallbackRate`, fallback ed errori read-primary;
    - `lanes.crossDomainConcurrencyFamiliesActive`, overlap e retry fiscale;
    - top route p99 e top wait delle code.
  - Aggiunti counter/gauge mancanti per idempotenza, fallback relazionale e
    outbox lag.

- `monitor-frontend/dist/index.html`
  - Aggiunto pannello `Metriche Runtime`.

- `monitor-frontend/dist/app.js`
  - Aggiunto caricamento di `/api/monitor/runtime-metrics`.
  - Aggiunta renderizzazione sintetica delle metriche operative M4.
  - Il monitor gestisce anche assenza token o errore runtime senza aprire modali.

- Test aggiornati:
  - `backend/tests/runtime-metrics.test.mjs`
  - `backend/tests/realtime-backbone.test.mjs`
  - `backend/tests/route-policy-architecture.test.mjs`

## Invarianti mantenuti

- L'endpoint runtime metrics resta compatibile: i dati precedenti restano nello
  snapshot e la nuova sintesi e' aggiuntiva.
- Il monitor non blocca l'overview se le metriche runtime non sono disponibili.
- L'outbox misura il lag senza modificare lo stato degli eventi.
- L'idempotenza pagamento continua a usare gli stessi esiti applicativi; sono
  stati aggiunti solo segnali di osservabilita'.
- La fiscal retry lane resta isolata dalle lane real time e viene solo esposta in
  dashboard.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
```

Risultato: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check ../monitor-frontend/dist/app.js
```

Risultato: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/realtime-backbone.test.mjs backend/tests/route-policy-architecture.test.mjs
```

Risultato: 30/30 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 991/991 pass.

Durata full run: `duration_ms=803962.671627`, circa 804,0s / 13m24s.

## Verifica operativa consigliata

Nel monitor controllare il pannello `Metriche Runtime` durante un canary reale:

- `Outbox lag`
- `Idempotenza hit`
- `Fallback relazionale`
- `Lane overlap max`
- `Retry fiscale`
- `Route p99`
- `Queue wait`

Se un gateway o una lane rallenta, il pannello deve mostrare pressione mirata
sul dominio coinvolto senza confonderla con un blocco globale del sistema.

## STOP/REVIEW

M4 e' chiusa lato codice, test e dashboard monitor. Il prossimo passo della Fase
M e' M5: verificare se l'estrazione K-PRE.1 ha lasciato margine sufficiente su
`server.js` per le fasi successive o se serve un'ulteriore estrazione modulare.
