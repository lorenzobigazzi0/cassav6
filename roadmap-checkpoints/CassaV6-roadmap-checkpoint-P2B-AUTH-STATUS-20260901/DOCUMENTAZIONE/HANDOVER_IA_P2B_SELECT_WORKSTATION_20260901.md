# Handover IA — avanzamento P2b e prossimo slice `auth.selectWorkstation`

Data: 2026-09-01  
Root di lavoro: `D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818`

## Dove siamo

Programma: migrazione PostgreSQL V6 (REV2). Lo stato ufficiale è in
`ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md`
— **non** in `DOCUMENTAZIONE/`, dove l'handover precedente lo cercava per errore.

| Fase | Stato |
|---|---|
| P0 baseline e inventario | IN_PROGRESS — MIG-001 e MIG-003 chiuse, MIG-002 riaperta, MIG-000 incompleta |
| P1 infrastruttura PostgreSQL | IN_PROGRESS, gate DEV_ONLY su microSD; HW-01-PROD aperta |
| P2 foundation persistence | IN_PROGRESS, gate DEV_ONLY; MIG-020..025 chiuse, MIG-026 aperta su RET-01 |
| **P2b decomposizione `server.js`** | **IN_PROGRESS — è qui che si lavora** |
| P3 … P15 | TODO, bloccate dal gate P2b |

Nessun percorso dati è commutato a PostgreSQL. Nessun cutover autorizzato.

## Avanzamento P2b, slice identity

Il pilot ha un ordine di estrazione dichiarato in
`DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md:42-50`. Stato route per route:

| # | Route | Stato | Owner dell'app-state |
|---|---|---|---|
| 1 | `users.list` | **fatto** (P2b.3) | `backend/users/users-list-read-model.js` |
| 2 | `auth.changePin` | **fatto** (P2b.4) | `backend/auth/change-pin-write-model.js` |
| 3 | `auth.selectWorkstation` | **prossimo** | — |
| 4 | `auth.login` | aperto | — |
| 5 | `auth.sessionStatus` | aperto | — |
| 6 | `auth.logout` | aperto | — |
| 7 | `users.save` | aperto | — |

Metriche del gate identity, misurate non stimate:

| | inizio pilot | oggi |
|---|---:|---:|
| `readDb()` diretti negli handler | 7 | **5** |
| `writeDb()` diretti negli handler | 11 | **9** |
| route senza accesso globale | 0 | **2 su 7** |

Il gate P2b passa **solo a 0/0**. Fino ad allora P3 resta bloccata.

Evidenze rigenerabili con `npm run migration:pg:p2b-identity`:
`reports/postgresql-migration/p2b/identity-route-boundaries.csv` e
`identity-pilot-baseline-20260901.json`.

## Cosa è stato fatto nell'ultimo slice (P2b.4)

`handleChangePin` è passato da 89 a 40 righe e non tocca più l'app-state.

- Nuovo `backend/auth/change-pin-write-model.js`: unico owner della transazione
  read-mutate-write per la route. Una sola `readDb({ refreshExternalizedSessions: true })`,
  poi due intenti distinti e nominati — `recordFailedPinChange` e `applyPinChange` —
  ciascuno proprietario del proprio `appendAuditEvent` + `meta.lastWriteAt` +
  `writeDb`, con `metricLabel` e `splitDomains` invariati. All'esterno escono solo
  tre esiti: `invalid_current_pin`, `user_not_found`, `changed`. `db` non
  attraversa mai il confine.
- `backend/auth/auth.handlers.js`: restano le tre validazioni pure del body
  (400 prima di qualsiasi lettura) e la mappatura esito → HTTP. `hashPin` tolto
  dalla firma di `createAuthHandlers` perché usato solo qui; `verifyPin` resta,
  serve a `handleLogin`.
- `backend/server.js`: import e costruzione del modello subito prima di
  `createAuthHandlers`.
- Nuovo `backend/tests/auth-change-pin-handler.test.mjs`, 7 test: la route non
  aveva alcuna copertura automatica prima di questo slice.

Vincolo emerso e da riusare per gli slice successivi: `validateSessionContext`
**non è una lettura pura** — su sessione scaduta filtra `db.sessions`, chiama
`appendAuditEvent`, imposta `db.meta.lastWriteAt` e solleva 401. Reader e writer
devono quindi insistere sullo **stesso** oggetto app-state: una seconda `readDb`
perderebbe quella mutazione. Per questo il modulo espone una sola porta
d'ingresso invece di un reader e due writer indipendenti.

Verifica eseguita: `auth-change-pin-handler` 7/7, `user-app-users-handler` 6/6,
`auth-session.e2e` 25/25, `continuity.e2e` 69/69 (avvia il backend reale),
`architecture-line-budget` 1/1, gate identity 3/3, gate baseline 4/4 con
`comparison.ok: true`. Collaudo funzionale su backend isolato: 400 body invalido,
400 conferma diversa, 401 PIN errato, 200 cambio, 401 vecchio PIN riusato, 200
ripristino; audit `pin_change_failed, pin_changed, pin_change_failed, pin_changed`;
relogin con il PIN originale 200. Corpi di risposta identici a prima.

## Prossimo slice — `auth.selectWorkstation` (terzo dell'ordine del pilot)

`backend/auth/auth.handlers.js:455-531`. È più difficile dei due precedenti:

- tre uscite anticipate **prima** di qualsiasi scrittura: 403
  `WORKSTATION_CLIENT_REQUIRED`, 409 `WORKSTATION_CHANGE_REQUIRES_LOGOUT`, più
  l'eccezione di `assertWorkstationLoginAvailable`;
- **doppio percorso di scrittura**: `writeAuthSessionFastDb` (metricLabel
  `auth.workstationSelect.sessionFastWrite`) con fallback a `writeDb`
  (`auth.workstationSelect.appStateWrite`, `splitDomains: ["sessions","auditEvents"]`,
  `sessionsSync: { deleteMissing: false }`). Il gate conta solo `writeDb`, ma il
  fast path va conservato: è quello che di norma viene eseguito;
- side effect fuori app-state: `rememberVolatileSession` sulla cache Redis, da
  lasciare **dopo** la scrittura e nell'ordine attuale;
- dipendenze POS: `resolveLoginWorkstationContext`, `assertUserLoginWorkstationAllowed`,
  `assertWorkstationLoginAvailable` leggono `db` e vanno spostate dentro il modello.

Confine dichiarato nel gate (da **non** modificare): reads `users|sessions|posSettings`,
writes `sessions|auditEvents|meta`, cross-domain `audit|pos-settings/workstations|redis/session-cache`.
Da aggiornare a fine slice: `directReadDbExpected: 1 → 0`,
`directWriteDbExpected: 1 → 0` in
`scripts/postgresql-migration/p2b-identity-boundaries.mjs`, e gli aggregati
`directReadDb 5 → 4`, `directWriteDb 9 → 8` in
`p2b-identity-boundaries.test.mjs:15-16`.

Forma da riusare: quella di `change-pin-write-model.js`, cioè una sola funzione
pubblica che restituisce un esito discriminato, con gli esiti che mappano sui
codici HTTP attuali. La risposta 200 include `selectedWorkstation`: farla
comporre dal modello, non ricostruirla nel handler.

## File da leggere, in ordine

1. `ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md`
2. `DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md`
3. `SORGENTE_SISTEMA/cassa-frontend/backend/auth/change-pin-write-model.js` — il precedente da imitare
4. `SORGENTE_SISTEMA/cassa-frontend/backend/auth/auth.handlers.js:455-531`
5. `SORGENTE_SISTEMA/cassa-frontend/backend/server.js` — wiring `createAuthHandlers`
6. `SORGENTE_SISTEMA/cassa-frontend/backend/tests/auth-change-pin-handler.test.mjs`
7. `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p2b-identity-boundaries.mjs`

## Criteri di accettazione

- `auth.selectWorkstation` a zero `readDb`/`writeDb` diretti; gli altri handler invariati.
- 403, 409, errore di disponibilità e 200 con `selectedWorkstation` identici a oggi.
- Fast write e fallback entrambi conservati, con gli stessi `metricLabel`.
- `rememberVolatileSession` invocata nello stesso punto della sequenza.
- Nessuna nuova failure rispetto alla baseline congelata.
- Non dichiarare iniziata P3.

```powershell
# da SORGENTE_SISTEMA/cassa-frontend
node --test --test-concurrency=1 backend/tests/auth-change-pin-handler.test.mjs
npm run test:migration:pg:p2b-identity
npm run migration:pg:p2b-identity
npm run test:migration:pg:p2b-baseline
npm run gate:migration:pg:p2b-baseline
node --test --test-concurrency=1 backend/tests/continuity.e2e.test.mjs
```

## Aperti, non toccati da questo slice

- **MIG-002** e **MIG-000** restano `IN_PROGRESS`: P0 non è chiusa.
- **RET-01** blocca la chiusura di MIG-026.
- **SEQ-01** (Commerciale V2 vs migrazione) va chiusa prima di P4, non ora.
- **Attivazione Postazione**: `posSettings.workstations` è vuoto e lorenzo ha
  `workstationIds: []`. Servono due scritture di settings, in attesa di via
  libera. Da notare: senza questo, `auth.selectWorkstation` non è collaudabile
  end-to-end sul sistema reale, solo via test.
- **Campagna di test POS** su palmare reale (ordini, resi, sconti, pagamenti,
  carte sconto, cambi sala/tavolo, unioni, carichi/scarichi): interrotta, da riprendere.
- Il workspace non è gestito con Git: preservare le evidenze esistenti e creare
  checkpoint/ZIP soltanto a slice concluso e verificato.
