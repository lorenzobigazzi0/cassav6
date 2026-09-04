# Integrazione FrontendV2 su versione precedente

Data: 2026-05-22

## Cosa è stato fatto

- Sostituito `mobile-frontend` della versione precedente con il sorgente completo di FrontendV2.
- Generata la build production in `mobile-frontend/dist` con `base: /mobile/`, compatibile con `serve-frontends.mjs`.
- Mantenuto `public/config.json` / `dist/config.json` con API same-origin:
  - `apiBaseUrl: /api`
  - `sseBaseUrl: /api`
- Corretto l'ordine di lettura della runtime config: il frontend prova prima `/mobile/config.json` e poi `/config.json`, evitando il 404 iniziale quando è servito dal launcher della versione precedente.
- Allineato `mobile-frontend/package-lock.json` perché `npm ci` potesse installare correttamente le dipendenze del progetto Vite/React.

## Verifiche eseguite

Nel sorgente FrontendV2:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run test:static
npm run test
npm run lint
npm run format:check
npm run build
```

Risultati:

- typecheck: OK
- test statici: 9/9 OK
- test Vitest: 34/34 OK
- lint: OK con 34 warning già presenti come debito noto
- format check: OK
- build production: OK

Nella versione precedente integrata:

```bash
cd cassa-frontend
npm run check:backend
npm run test:frontend
```

Risultati:

- `check:backend`: OK
- `test:frontend`: OK, 60 test dichiarati; 22 passati e 38 legacy-mobile saltati perché riferiti agli asset bridge del vecchio mobile frontend rimossi da FrontendV2. Sono stati aggiunti test statici specifici per `mobile-frontend/dist` FrontendV2.

Smoke test runtime eseguito con backend su porta temporanea `52181` e frontend statico su `52180`:

- `GET /api/health` diretto backend: 200
- `GET /api/health` via proxy static frontend: 200
- `GET /mobile/`: 200, HTML valido con mount `#root`
- `GET /mobile/config.json`: 200
- asset JS principale `/mobile/assets/index-*.js`: 200
- `POST /api/auth/login` via proxy con utente di smoke temporaneo: OK
- `POST /api/auth/session/status`: OK
- `POST /api/pos/rooms`: OK

## Come avviare

Dal root della versione integrata:

```bash
cd cassa-frontend
npm run dev:backend
```

In un secondo terminale:

```bash
node serve-frontends.mjs
```

URL principale:

```text
http://127.0.0.1:5180/mobile/
```

Il backend resta:

```text
http://127.0.0.1:5181
```

## Note operative

- L'archivio non include `node_modules` del nuovo `mobile-frontend`; per rigenerare la build eseguire `npm ci` dentro `mobile-frontend` e poi `npm run build`.
- Il backend della versione precedente non è stato modificato: gli endpoint richiesti da FrontendV2 erano già presenti.
- Il database/app-state non è stato alterato. Lo smoke test ha usato un file temporaneo esterno all'archivio.

---

# Patch pagamento FrontendV2

Data patch: 2026-05-25

## Cosa è stato completato

Il flusso pagamento del mobile non usa più solo la sync generica dell'ordine. Ora, quando l'operatore conferma un incasso dal wizard del tavolo, il frontend chiama il dominio pagamenti reale del backend:

```text
POST /api/payments/free-split
```

Il payload inviato include:

- `splitType: FREE_SPLIT`
- `splitMode`: `single`, `roman`, `amount` oppure `article`
- `articleUnitIds` per il pagamento per articolo
- `idempotencyKey` / `clientPaymentId` generati dal chunk di pagamento mobile
- importo incassato e, per i contanti, `cashGiven`
- metodo backend corretto:
  - contanti -> `CASH` / `pay_cash`
  - carta -> `POS` / `pay_card` con `posProvider: mobile-pos`
  - buoni, Satispay, sospeso, assegno, bonifico -> `OTHER` / `pay_smart`
- dati fiscali base:
  - scontrino -> `fiscalDocType: RECEIPT`
  - fattura -> `fiscalDocType: INVOICE` e `invoiceRecipient`

Dopo il pagamento confermato dal backend, il mobile aggiorna il proprio stato locale del tavolo solo come refresh ottimistico/UX e riallinea il layout; la chiusura contabile resta in capo al backend pagamenti.

## File principali modificati

```text
mobile-frontend/src/api/tables.ts
mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx
mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx
mobile-frontend/src/pages/home/tables/components/TablePaymentWizard.tsx
mobile-frontend/tests/paymentBackendPayload.test.ts
cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs
cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs
```

## Verifiche aggiunte

- Test Vitest sul payload mobile -> backend per:
  - contanti per articolo;
  - carta/POS alla romana;
  - buono pasto/fattura su metodo smart.
- Test statico sul bundle `mobile/dist` per verificare che il mobile punti a `/api/payments/free-split` e includa i mapping `FREE_SPLIT`, `pay_cash`, `pay_card`, `mobile-pos`.
- Test backend e2e con payload reale stile FrontendV2: crea ordine consegnato, invia free-split dal mobile, verifica ordine pagato, dovuto a zero e pagamento registrato.

## Verifiche eseguite dopo la patch

Nel mobile frontend:

```bash
cd mobile-frontend
npm ci --ignore-scripts
npm run typecheck
npm run test:static
npm run test
npm run lint
npm run format:check
npm run build
```

Risultati:

- typecheck: OK
- test statici: 9/9 OK
- test Vitest: 37/37 OK
- lint: OK con 34 warning già presenti come debito noto
- format check: OK
- build production: OK

Nel backend/versione integrata:

```bash
cd cassa-frontend
npm run check:backend
node --test backend/tests/payments-fiscal.e2e.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs backend/tests/payment-provider-transactions.test.mjs backend/tests/relational-payments.test.mjs
npm run test:frontend
```

Risultati:

- `check:backend`: OK
- test backend pagamenti/invarianti/relazionale: 47/47 OK
- `test:frontend`: OK, 61 test dichiarati; 23 passati e 38 legacy-mobile saltati perché riferiti agli asset bridge del vecchio mobile frontend rimossi da FrontendV2.

## Nota

Non è stata cambiata la logica applicativa del backend pagamenti: l'endpoint `/api/payments/free-split` era già presente. La patch collega correttamente il mobile a quell'endpoint e aggiunge copertura test per evitare regressioni.
