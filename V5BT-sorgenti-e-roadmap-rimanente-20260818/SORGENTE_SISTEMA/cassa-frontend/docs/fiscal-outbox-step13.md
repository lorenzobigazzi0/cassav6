# Fiscal outbox - Step 13A

Step 13A introduce una coda fiscale durabile separata da `fiscal_receipts`.
`fiscal_receipts` resta il registro della ricevuta; `fiscal_outbox` e' la coda
operativa recuperabile per emissione, retry e intervento manuale.

Step 13B aggiunge claim atomico e lease sul repository, cosi' un worker futuro
puo' prendere un solo job alla volta, recuperare processing sospesi e rispettare
il backoff `next_attempt_at`.

Step 13C aggiunge il worker applicativo testabile
`backend/modules/fiscal-pos/fiscal-outbox-worker.js`. Il worker orchestra
`claimNext -> processClaim -> markIssued/markFailed` senza conoscere il provider
fiscale reale. In questo modo il collegamento runtime al provider puo' essere
abilitato in uno step separato, senza doppie emissioni rispetto ai path legacy
ancora attivi.

Step 13D collega il worker al provider POS gia' esistente dietro flag
`BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1`. Il bridge costruisce il job POS dalla
riga `fiscal_outbox`, chiama il processor fiscale esistente, sincronizza
`fiscal_receipts` relazionale e poi aggiorna lo stato della coda. Quando il
worker e' attivo, il vecchio recovery app-state dei job POS non viene avviato,
cosi' la stessa ricevuta non viene schedulata due volte.

Step 13E aggiunge un canary end-to-end con POS API simulata: il test emette un
pagamento ticket fiscale, verifica la riga `fiscal_outbox`, attende il worker
abilitato fino allo stato `issued`, controlla `fiscal_receipts` relazionale e
assicura che l'endpoint provider `/api/fiscal/receipt` venga chiamato una sola
volta. Il bridge POS usa la chiave idempotente della ricevuta fiscale, non la
chiave idempotente del pagamento.

Step 13F estende lo stesso canary ai pagamenti tavolo e split libero. Con il
worker `fiscal_outbox` attivo, anche gli handler modulari non schedulano piu'
il vecchio job POS app-state: l'emissione resta di proprieta' del worker
relazionale e il provider riceve una sola chiamata per ricevuta fiscale.

Step 13G aggiunge un profilo staging dedicato
`fiscal-outbox-worker-staging`: accende il worker solo insieme ai tre
write-primary pagamento, alle ricevute fiscali relazionali e alla coda
`fiscal_outbox`. Il runtime profile segnala warning se il worker viene acceso
con pagamenti write-primary parziali.

Step 13H aggiunge uno smoke read-only per staging:
`npm run smoke:fiscal-outbox-worker`. Lo smoke legge il DB relazionale,
controlla stati `manual_required`/`failed`, backlog `requested`/`retrying`,
processing stale e duplicati tra `fiscal_outbox` e `fiscal_receipts`, senza
creare pagamenti reali e senza chiamare il provider fiscale.

Step 13I completa lo smoke con output persistibile in `reports/`: l'opzione
`--output` salva il report su file, `.json` forza il formato machine-readable
e `npm run smoke:fiscal-outbox-worker:report` produce il report testuale
standard per staging.

Step 13J aggiunge il comando schema-only `npm run migrate:relational:schema`.
Serve ad applicare le migrazioni relazionali versionate al DB di staging senza
richiedere una sorgente app-state e senza importare dati applicativi.

Step 13K rende verificabile il profilo staging su Windows: `npm run dev:backend`
usa un launcher Node cross-platform, l'esempio
`configs/fiscal-outbox-worker-staging.env.example` usa `NODE_ENV=staging` e lo
smoke con `--base-url` valida anche `/api/health`. La creazione automatica di
un pagamento fiscale reale resta esclusa se il backend punta a un provider
fiscale non chiaramente simulato.

Step 13L aggiunge il canary controllato `npm run canary:fiscal-outbox-payment`.
Di default fa solo preflight: health, login, snapshot configurazione e safety
gate sui fiscal devices. Il pagamento viene inviato solo con `--execute` e solo
se i fiscal devices attivi sono mock/staging/test/sandbox, oppure se viene
passato `--allow-real-fiscal` in modo esplicito.

Step 13M aggiunge il canary eseguibile isolato
`npm run canary:fiscal-outbox-payment:mock:report`. Lo script avvia un backend
temporaneo e un provider POS fiscale mock locale, crea un pagamento ticket
fiscale, attende il worker `fiscal_outbox` e verifica che il provider riceva
una sola chiamata `/api/fiscal/receipt`.

Step 13N aggiunge l'evidenza consolidata
`npm run evidence:fiscal-outbox-step13:report`. Il comando raccoglie in un solo
report lo smoke live read-only, il preflight live senza pagamento e il canary
mock isolato, producendo sia JSON sia Markdown in `reports/`.

## Flag

```env
BACKEND_FISCAL_OUTBOX_ENABLED=1
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
```

Dipendenze:

```env
BACKEND_RELATIONAL_ENABLED=1
EVENT_OUTBOX_ENABLED=1
BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1
```

## Stati

```text
requested
processing
issued
failed
retrying
manual_required
```

## Boundary

- `PaymentsRelationalRepository` registra pagamenti e `fiscal_receipts`.
- `FiscalOutboxRepository` registra `fiscal_outbox`.
- `recordRelationalTicketPayment`, `recordRelationalTablePayment`,
  `recordRelationalFreeSplitPayment` e `recordRelationalFiscalCommandResult`
  accodano `fiscal_outbox` dentro la stessa transazione relazionale gia' usata
  per pagamento/fiscale e `event_outbox`.
- `FiscalOutboxRepository.claimNext()` e' il punto unico di claim worker-safe.
- `reclaimExpiredLeases()` recupera job `processing` con lease scaduto.
- `reclaimAllProcessing()` e' il recovery da usare allo startup del futuro
  worker fiscale.
- `createFiscalOutboxWorker()` e' il boundary applicativo del worker: riceve un
  repository e una funzione `processClaim`, poi marca l'esito sulla coda.
- `buildPosFiscalJobFromFiscalOutboxEntry()` e' il boundary di mapping tra
  `fiscal_outbox` e il job POS fiscale esistente.
- `BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1` avvia il worker solo nel processo
  owner backend.

## Rollback

```env
BACKEND_FISCAL_OUTBOX_ENABLED=0
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
```

Il rollback disattiva nuovi enqueue. La tabella resta compatibile e non cambia
le letture legacy.

## Verifica

```bash
npm run test:phase13a
npm run test:phase13b
npm run test:phase13c
npm run test:phase13d
npm run test:phase13e
npm run test:phase13f
npm run test:phase13g
npm run test:phase13h
npm run test:phase13i
npm run test:phase13j
npm run test:phase13k
npm run test:phase13l
npm run test:phase13m
npm run test:phase13n
npm run check:backend
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
npm run profile:runtime
npm run migrate:relational:schema
node scripts/fiscal-outbox-staging-smoke.mjs --db-path backend/backend-relational.sqlite --base-url http://127.0.0.1:5280
node scripts/fiscal-outbox-staging-smoke.mjs --db-path backend/backend-relational.sqlite --base-url http://127.0.0.1:5280 --output reports/fiscal-outbox-worker-staging-smoke.txt
node scripts/fiscal-outbox-payment-canary.mjs --base-url http://127.0.0.1:5280 --output reports/fiscal-outbox-payment-canary.txt
npm run canary:fiscal-outbox-payment:mock:report
npm run evidence:fiscal-outbox-step13:report
```
