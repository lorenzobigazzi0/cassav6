# Pilot P2b — dominio identity

Data: 2026-09-01

## Esito del primo taglio

Il pilot non modifica comportamento o database. Rende falsificabile il lavoro
P2b sul dominio piu piccolo prima di estenderlo al resto del monolite.

Le sette route identity sono gia estratte da `server.js` in due handler:

- `backend/auth/auth.handlers.js`;
- `backend/users/users.handlers.js`.

L'inventario automatico misura:

- 7 route assegnate al dominio `identity`;
- 1.141 righe nei due file handler;
- 7 chiamate dirette a `readDb()`;
- 11 fallback diretti a `writeDb()`;
- 7 route su 7 con almeno una dipendenza cross-domain;
- `server.js` ancora a 38.730 righe.

Le dipendenze esterne al dominio sono dichiarate per route: audit,
configurazione POS/workstation, Redis session cache, notification handoff e
presenza delle postazioni. Il CSV non nasconde queste dipendenze dentro una
generica lettura dell'intero app-state.

Evidenze:

- `reports/postgresql-migration/p2b/identity-route-boundaries.csv`;
- `reports/postgresql-migration/p2b/identity-pilot-baseline-20260901.json`;
- `scripts/postgresql-migration/p2b-identity-boundaries.mjs`;
- `scripts/postgresql-migration/p2b-identity-boundaries.test.mjs`.

Il gate fallisce se una route non e piu registrata sullo stesso handler oppure
se cambia il numero di accessi globali senza aggiornare esplicitamente il
confine. Non sostituisce il gate completo P2b.1 su tutte le route.

## Ordine di estrazione misurabile

Il percorso piu piccolo che conserva il comportamento e:

1. `users.list`: un reader scoped, nessun writer;
2. `auth.changePin`: reader user/session e due intent writer audit/PIN;
3. `auth.selectWorkstation`: session writer con dipendenza POS esplicita;
4. `auth.login`: creazione/revoca sessione, audit e cache Redis;
5. `auth.sessionStatus`: heartbeat e presenza postazione;
6. `auth.logout`: revoca con handoff postazione/mobile;
7. `users.save`: sostituzione utenti/gruppi e revoca sessioni non piu valide.

Stato verificato al 2026-09-01: completati i punti 1, 2, 3 e 5. Il punto 5
`auth.sessionStatus` e stato anticipato alla ripresa esplicita del lavoro e ora
usa `backend/auth/session-status-write-model.js`; restano `auth.login`,
`auth.logout` e `users.save`. Il prossimo slice torna al primo punto ancora
aperto dell'ordine dichiarato: `auth.login`.

`users.save` e `logout` restano per ultime perche coordinano piu domini. Spostare
solo le chiamate in un wrapper che continui a esporre l'intero `db` non
soddisferebbe P2b.3/P2b.4.

## Gate successivo

Il pilot passa allo stato successivo solo quando i sette handler hanno zero
chiamate dirette a `readDb()` e `writeDb()`. I reader dichiarano i dati letti; i
writer ricevono intenti, mantengono gli invarianti di sessione e audit e sono
gli unici owner del read-mutate-write legacy durante la transizione.

P3 resta bloccata fino a quel gate. Il pilot attuale rende misurato il backlog,
ma non dichiara completata P2b.

## Esito — gate raggiunto il 2026-09-02

Le sette route sono state estratte nell'ordine dichiarato sopra. L'inventario
automatico misura ora:

- 7 route su 7 con **zero** chiamate dirette a `readDb()` e `writeDb()`
  (erano 7 e 11);
- `backend/auth/auth.handlers.js` da 819 a 188 righe, `backend/users/users.handlers.js`
  da 306 a 25: entrambi contengono soltanto handler che leggono il body,
  applicano validazioni pure e mappano l'esito sulla risposta;
- `behaviorChanged: false`, `databaseChanged: false`: nessun contratto HTTP,
  nessuno schema e nessun percorso dati e stato modificato.

Owner dell'app-state, uno per route:

| route | owner |
|---|---|
| `users.list` | `backend/users/users-list-read-model.js` |
| `auth.changePin` | `backend/auth/change-pin-write-model.js` |
| `auth.selectWorkstation` | `backend/auth/select-workstation-write-model.js` |
| `auth.sessionStatus` | `backend/auth/session-status-write-model.js` |
| `auth.login` | `backend/auth/login-write-model.js` |
| `auth.logout` | `backend/auth/logout-write-model.js` |
| `users.save` | `backend/users/users-save-write-model.js` |

`backend/auth/volatile-session-cache.js` raccoglie i side effect Redis condivisi
fra login, logout e session status. `users.save` non la usa di proposito: la sua
revoca attende le `deleteSession` e lancia un 503 invece di restituire un
booleano, e l'ordine dei side effect e osservabile nei test.

Copertura aggiunta dal pilot, dove prima non esisteva: `auth-change-pin-handler`
7, `auth-select-workstation-handler` 11, `auth-session-status-handler` 5,
`auth-login-handler` 17, `auth-logout-handler` 12 e `user-app-users-handler` 15
casi, oltre alle suite gia presenti `auth-session.e2e` 25 e `continuity.e2e` 69,
tutte verdi, con la baseline congelata invariata (`comparison.ok: true`).

Il gate del **pilot** e raggiunto. Il gate della **fase P2b** no: MIG-030..MIG-034
hanno Definition of Done su tutte le 198 route del monolite, non sulle sette
identity, e `server.js` resta a circa 38.800 righe contro le 25.000 chieste da
MIG-031. Il passo successivo e MIG-030, l'inventario dei confini esteso a tutte
le route. P3 resta bloccata.
