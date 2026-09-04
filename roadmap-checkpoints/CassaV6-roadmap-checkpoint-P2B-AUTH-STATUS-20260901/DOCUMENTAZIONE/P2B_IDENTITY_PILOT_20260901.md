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
