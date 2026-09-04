# Architettura Operativa

## Stato attuale

- `backend/server.js` resta il punto di ingresso unico per API, spool di stampa, integrazione postazione/mobile e persistenza.
- `cassa`, `postazione` e `mobile` sono frontend statici serviti da `nginx`.
- `postazione` e `mobile` sono disponibili solo come build compilate, quindi le correzioni lato UI vengono applicate con asset custom caricati da `dist/index.html`.

## Problemi architetturali osservati

- Il backend e ancora molto monolitico: `server.js` mescola bootstrap HTTP, modello dati, normalizzazione POS, spool, integrazione e logica fiscale.
- I frontend compilati hanno accumulato asset custom indipendenti; se caricati tutti subito possono interferire fra loro.
- Alcuni default POS/stampa erano definiti e ricostruiti a mano in piu punti, con rischio di divergenza futura.

## Intervento 2026-03-28

- Estratti i default POS/stampa in `backend/lib/pos-defaults.js`.
- Centralizzata la clonazione sicura di:
  - `DEFAULT_POS_SETTINGS`
  - `printPreferences`
  - catalogo modelli stampante
- `server.js` ora usa questi helper nei punti piu sensibili:
  - bootstrap DB iniziale
  - recovery di `posSettings` mancanti
  - payload API impostazioni POS

## Frontend custom

- `cassa`: gli asset custom restano separati per responsabilita, ma il pannello stampa e stato protetto dai loop di render/osservazione.
- `postazione`: il bootstrap custom e stato ridotto al minimo per non rompere login e render del bundle compilato.

## Prossimi split consigliati

- Estrarre dal backend un modulo `printing/` per:
  - spool TCP
  - risoluzione stampanti per area/cassa/postazione
  - drawer open
  - formatter ESC/POS
- Estrarre un modulo `integration/` per:
  - ordini postazione
  - notifiche
  - camerieri attivi
  - stato stazioni
- Introdurre un bootstrap manifesto anche per `cassa`, con caricamento dei fix solo quando serve, per ridurre side effect globali.

## Intervento 2026-05-30 — split incrementale core security/route

Per ridurre il rischio del monolite senza spezzare flussi P0/P1, sono stati estratti moduli core a basso accoppiamento:

- `backend/core/security.js`: header auth, bearer token, IP privati/loopback, confronto token a digest fisso e hash HMAC sessione.
- `backend/core/http-client.js`: wrapper `fetchWithTimeout()` per chiamate esterne.
- `backend/core/route-builders.js`: DSL route condivisa da registry root e moduli.
- `backend/modules/integration/integration.routes.js`: route `/api/integration/*` fuori da `backend/routes/index.js`.

Il gate `backend-architecture-security-audit.mjs` blocca il ritorno degli helper sensibili dentro `server.js`.

### Refactor ancora consigliati dopo cutover

- Estrarre `modules/payments/` iniziando da validazione input e invarianti, non dal commit DB.
- Estrarre `modules/fiscal-pos/` separando payload fiscale, job queue e client provider.
- Estrarre `modules/integration-orders/` per `sanitizeIntegrationOrder`, compensazioni e trasferimenti.
- Estrarre `modules/db-migrations/` per ridurre `migrateDbSecurity()`.
