# CASSA V4.6 - Codex changelog

Data: 2026-07-15

Base di lavoro: copia estratta da `/home/sentrapa/Downloads/v4.5.zip`.
L'archivio originale non e stato modificato; SHA-256 verificato:
`b2648bfc2d2c78594ae0c1a1df8d5ba6e12656393312d26b4dee3bfbd5a4707e`.

## Comportamento precedente

- La pressione lunga del pulsante stampa usava il vecchio timeout breve, non offriva una progressione persistente e completa tra stampa avanzata, emissione e annullamento fiscale.
- Emissione e annullamento non erano esposte dal dettaglio movimento con un ciclo UI/backend verificabile e senza esiti ottimistici.
- Il comando indietro e il titolo della fase pagamento erano nel corpo, separati da Tavolo e Sala e con informazioni duplicate.
- Il pannello pagamento non condivideva in modo esplicito geometria e contenimento della card workspace tavoli.
- `APPLICA` nella rettifica aggiornava lo stato temporaneo e chiudeva la modale senza garantire persistenza della nuova ripartizione; `APPLICA E RISCUOTI` poteva quindi proseguire con il totale precedente.

## Perimetro implementato

### Dettaglio movimenti e stato stampa fiscale

- Il pulsante `.smallbtn.mobile-analytics-detail-print` usa una macchina a stati esplicita.
- Il click breve in modalita normale esegue la ristampa ordinaria.
- La pressione di almeno 2000 ms passa a `STAMPA AVANZATA`, resta persistente e non stampa al rilascio.
- Non esiste piu una seconda pressione lunga: il pulsante stampa gestisce soltanto stampa normale
  e stampa avanzata.
- Per gli amministratori e presente un secondo pulsante fiscale separato: mostra `EMETTI FISCALE`
  sugli esiti KO/mancanti e `ANNULLA DOCUMENTO` sui documenti emessi.
- Emissione e annullamento usano endpoint backend reali, con stato busy, messaggi d'errore e nessun esito fiscale simulato.
- Dopo un'emissione valida, la conferma di `ANNULLA DOCUMENTO` usa una modale dedicata e lo stato
  diventa `ANNULLATO` soltanto dopo risposta positiva del gateway.
- L'annullamento conserva i riferimenti del documento originale e salva separatamente provider,
  movimento, data e numero del documento di annullamento.
- Dopo l'annullamento, `STAMPA` accoda la ristampa del documento di annullamento e non quella del
  documento fiscale originale. Le chiavi di claim e idempotenza distinguono i due documenti.
- La stampa avanzata riporta sia il documento fiscale originale sia il documento di annullamento.
- Gestiti `pointerdown`, `pointerup`, `pointercancel`, `pointerleave`, perdita focus e smontaggio, con soppressione del click successivo a una pressione lunga.
- Migliorate etichette accessibili, stato disabilitato e feedback operativi.

Endpoint aggiunti:

- `POST /api/reports/payment-movement/fiscal/issue`
- `POST /api/reports/payment-movement/fiscal/void`

Entrambi riusano il flusso fiscale POS esistente, il gateway configurato, il tracking ricevute e le regole di autorizzazione. Non sono presenti risposte fiscali finte.

### Pagamento tavolo

- Il comando indietro e stato spostato nell'header del pannello pagamento.
- `Tavolo`, `Sala` e fase corrente (`Ricevuta` o fase equivalente) sono nello stesso gruppo informativo.
- Rimossa l'intestazione duplicata nel corpo.
- `.table-payment-panel` condivide raggio, bordo e geometria della workspace tavoli; il contenuto interno scorre senza uscire dagli angoli arrotondati.
- Aggiunti vincoli responsive per evitare sovrapposizioni su schermi stretti.

### Rettifica amministrativa del pagamento

- `APPLICA` valida gli importi, distribuisce il nuovo totale in centesimi interi e persiste la correzione reale della comanda.
- `APPLICA E RISCUOTI` esegue prima la persistenza e apre il pagamento con il nuovo totale solo dopo esito positivo.
- In caso di errore la modale resta aperta e nessun incasso viene avviato.
- La distribuzione e proporzionale con largest remainder, mantiene il totale esatto e gestisce aumenti, diminuzioni, quantita multiple, righe non rettificabili, centesimi e prezzo esplicito pari a zero.
- Gli identificativi unita, IVA, reparto fiscale, varianti, note e metadati di correzione vengono conservati lungo trasformazioni, snapshot e persistenza relazionale.
- Le righe a prezzo differente vengono separate in modo deterministico; rettifiche successive ritrovano le unita tramite identificativi stabili.
- Il flusso banco applica le stesse righe canoniche prima dell'eventuale pagamento.

## File modificati

Backend:

- `cassa-frontend/backend/db/relational/orders.repo.js`
- `cassa-frontend/backend/modules/orders/order-correction-changes.js` (nuovo)
- `cassa-frontend/backend/modules/orders/order-line-snapshots.js`
- `cassa-frontend/backend/modules/payments/fiscal-reprint-reference.domain.js` (nuovo)
- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/modules/payments/payments.routes.js`
- `cassa-frontend/backend/modules/reports/reports.handlers.js`
- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/tests/fiscal-receipts-domain.test.mjs`
- `cassa-frontend/backend/tests/fiscal-reprint-reference-domain.test.mjs` (nuovo)
- `cassa-frontend/backend/tests/order-correction-changes.test.mjs` (nuovo)
- `cassa-frontend/backend/tests/order-line-snapshots.test.mjs`
- `cassa-frontend/backend/tests/payment-movement-fiscal-actions.test.mjs` (nuovo)
- `cassa-frontend/backend/tests/payment-weird-cases.e2e.test.mjs`
- `cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs`
- `cassa-frontend/backend/tests/relational-orders.test.mjs`
- `cassa-frontend/backend/tests/route-policy-architecture.test.mjs`

Frontend mobile:

- `mobile-frontend/src/api/analyticsPaymentMovements.ts`
- `mobile-frontend/src/api/orderServiceRecovery.ts`
- `mobile-frontend/src/api/tables.ts`
- `mobile-frontend/src/domain/tables/integrationOrderTransforms.ts`
- `mobile-frontend/src/domain/tables/integrationParsers.ts`
- `mobile-frontend/src/domain/tables/integrationTypes.ts`
- `mobile-frontend/src/domain/tables/types.ts`
- `mobile-frontend/src/pages/home/analytics/AnalyticsWorkspace.tsx`
- `mobile-frontend/src/pages/home/analytics/FiscalVoidConfirmDialog.tsx` (nuovo)
- `mobile-frontend/src/pages/home/analytics/analyticsPrintState.ts` (nuovo)
- `mobile-frontend/src/pages/home/analytics/paymentDetailLines.ts`
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`
- `mobile-frontend/src/pages/home/tables/components/AdminPaymentAdjustmentDialog.tsx`
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`
- `mobile-frontend/src/pages/home/tables/components/TablePaymentWizard.tsx`
- `mobile-frontend/src/pages/home/tables/counter/CounterWorkspace.tsx`
- `mobile-frontend/src/pages/home/tables/payment/paymentAdjustmentDistribution.ts` (nuovo)
- `mobile-frontend/src/pages/home/tables/payment/paymentArticleUnits.ts`
- `mobile-frontend/src/styles/tables.css`
- `mobile-frontend/tests/adminPaymentAdjustmentDialog.test.tsx`
- `mobile-frontend/tests/analyticsFiscalActions.test.ts` (nuovo)
- `mobile-frontend/tests/analyticsPrintState.test.ts` (nuovo)
- `mobile-frontend/tests/paymentAdjustmentDistribution.test.ts` (nuovo)
- `mobile-frontend/tests/static/analyticsPaymentDetailModal.test.ts`
- `mobile-frontend/tests/static/paymentActionButtonsVisual.test.ts`

Documentazione:

- `CODEX_CHANGELOG.md` (nuovo)

## Verifiche locali

Completate senza deploy, device, emulatori, stampanti o gateway reali:

- Backend syntax/check: superato.
- Backend matrice funzionale finale: 60/60 test superati.
- Repository ordini relazionale: 28/28 test superati.
- Correzione relazionale CAS end-to-end, incluso prezzo zero esplicito: superata.
- Test frontend mirati: 33/33 superati.
- TypeScript typecheck: superato.
- ESLint: 0 errori; 50 warning gia presenti in aree non modificate.
- Build Vite production: superata, 404 moduli trasformati.
- Budget `server.js`: 38.697 righe su limite 38.800.

Validazione finale da `v4.6_updated.zip` estratto in una directory temporanea vuota:

- `npm ci --ignore-scripts --no-audit --no-fund` backend: superato, 207 pacchetti dal lockfile.
- `npm run check:backend`: superato.
- Test backend mirati da archivio: 44/44 superati.
- `npm run smoke:package-runtime`: superato; backend locale isolato, database JSON temporaneo, hardware disattivato, probe `/api/health`, order workflow, payment methods e monitor tutti `ok=true`.
- `npm ci --ignore-scripts --no-audit --no-fund` frontend: superato, 293 pacchetti dal lockfile.
- Test frontend mirati da archivio: 33/33 superati.
- `npm run build`: superato; typecheck e build Vite, 404 moduli trasformati.

Suite frontend generale: 416/431 test superati. I 15 fallimenti residui appartengono a controlli statici o prerequisiti gia non allineati nella base v4.5 (guide esterne assenti, budget architetturali storici, stringhe/CSS esatti e test che cercano handler modularizzati dentro `server.js`). Nessuno dei test mirati al nuovo stato stampa, alle API fiscali o alla rettifica economica e fallito.

Route policy completa: 139/140. L'unico fallimento e il controllo sul file precompilato `monitor-frontend/dist/index.html`, non incluso nel sorgente originale e intenzionalmente escluso dal pacchetto sorgente.

`package-preflight --source` segnala inoltre `settings-frontend/dist` mancante. E un requisito storico del guardrail non coerente con questa consegna sorgente, nella quale le cartelle di build devono essere escluse; non indica un import runtime backend mancante.

Il pacchetto finale esclude `node_modules`, `dist`, `build`, cache, risultati temporanei, backup runtime, certificati/chiavi LAN e `.env.lanhttps`. Conserva `.env.example`, che e il solo template di configurazione destinato alla distribuzione.

## Verifica aggiuntiva 2026-07-17

- Test dominio fiscale e handler: 11/11.
- E2E pagamenti anomali: 16/16, incluso il ciclo emissione simulata, annullamento,
  retry idempotente e ristampa del solo movimento di annullamento.
- Gate budget `server.js` M5: superato dopo l'estrazione della logica nel modulo di dominio.
- Test frontend mirati: 15/15 nel sorgente canonico e 17/17 nel frontend Palmare.
- TypeScript e build Vite: superati in entrambi i frontend.
- Build backend e validazione static dist: superate.
- Palmare `1.0.13` (`versionCode 14`) compilato con test Android, lint e assemble, poi installato
  sul device SM-A165F `RFGYA0ZAGFW`.
- Verifica ADB reale: due pulsanti affiancati e leggibili; dopo 2,2 secondi `STAMPA` diventa
  `STAMPA AVANZATA` senza eseguire la stampa al rilascio.

Non sono stati inviati comandi a un dispositivo fiscale reale. Il ciclo fiscale e stato validato
contro un gateway controllato in test; la certificazione hardware resta separata.
