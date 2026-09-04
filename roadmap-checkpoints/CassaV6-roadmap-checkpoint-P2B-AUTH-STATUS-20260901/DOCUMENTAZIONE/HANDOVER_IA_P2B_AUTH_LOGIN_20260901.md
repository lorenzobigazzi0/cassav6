# Handover IA — prossimo slice P2b `auth.login`

Data: 2026-09-01  
Root: `D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818`

## Stato verificato

Il lavoro su `auth.sessionStatus` è concluso. Il nuovo owner è
`SORGENTE_SISTEMA/cassa-frontend/backend/auth/session-status-write-model.js`;
il handler non contiene più `readDb()`/`writeDb()`. Sono invariati retry nella
lane presenza, copia isolata fast-path, writer puntuali, fallback app-state,
refresh Redis e risposta HTTP.

Gate identity: **4/7 route** senza accesso globale; residuo **3 read / 7 write**.
P3 resta bloccata. Nessun cambio database o contratto API.

## Da dove ripartire

Riprendere dal primo punto ancora aperto dell'ordine del pilot: `auth.login` in
`backend/auth/auth.handlers.js`, funzione `handleLogin`. Oggi vale 1 read / 3
write diretti. Estrarre un unico `login-write-model.js` iniettato dal
composition root; il handler deve conservare soltanto validazione del body,
risoluzione del contesto HTTP e mapping esito→risposta.

Preservare con test espliciti:

- audit e metric label identici per credenziali errate;
- normalizzazione autorizzazioni utente e vincoli app/postazione;
- revoca sessioni e invalidazione Redis prima della persistenza;
- fast writer e fallback con gli stessi `splitDomains`/`sessionsSync`;
- refresh Redis e disconnessione stream mobile soltanto dopo la scrittura;
- payload 200 completo per Cassa, Postazione e Palmare.

## File da seguire

1. `ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md`
2. `DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md`
3. `SORGENTE_SISTEMA/cassa-frontend/backend/auth/auth.handlers.js`
4. `SORGENTE_SISTEMA/cassa-frontend/backend/auth/session-status-write-model.js`
5. `SORGENTE_SISTEMA/cassa-frontend/backend/auth/select-workstation-write-model.js`
6. `SORGENTE_SISTEMA/cassa-frontend/backend/auth/volatile-session-cache.js`
7. `SORGENTE_SISTEMA/cassa-frontend/backend/tests/auth-session.e2e.test.mjs`
8. `SORGENTE_SISTEMA/cassa-frontend/backend/tests/auth-session-redis-cache.test.mjs`
9. `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p2b-identity-boundaries.mjs`

## Evidenze dell'ultimo slice

- `auth-session-status-handler`: 5/5
- test identity focalizzati: 36/36
- `auth-session.e2e`: 25/25
- `continuity.e2e`: 69/69
- gate identity: 3/3
- gate baseline: verde, stesso insieme esatto (Cassa 72/92; Mobile 639/642)

Non iniziare P3 e non commutare identity a PostgreSQL finché tutte le sette
route identity non sono a zero accessi globali diretti.
