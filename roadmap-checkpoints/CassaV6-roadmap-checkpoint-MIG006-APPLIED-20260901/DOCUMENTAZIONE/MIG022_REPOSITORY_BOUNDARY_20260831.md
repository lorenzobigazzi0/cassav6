# MIG-022 - contratto repository e confine SQL

Data: 2026-08-31  
Stato: completato

## Esito

MIG-022 e completata. Il backend ha ora un contratto repository strutturale e
un gate sintattico universale che impedisce SQL fuori da `backend/db`,
`*.repo.js` e `*.repository.js`. Il gate e parte sia dell'audit sia del gate
architetturale eseguiti dalla release.

Il task non ha cambiato database, schema, flag o source of truth. Le query
esistenti sono state spostate nei proprietari infrastrutturali mantenendo
ordine transazionale, risultati, metriche e codici errore.

## Source of truth e responsabilita

MIG-022 non cambia database e non sposta alcun dominio. La source of truth resta
quella configurata dai runtime legacy/relazionali esistenti. Il task definisce
il confine che permettera ai task successivi di sostituire una persistenza senza
portare SQL dentro controller, handler o servizi applicativi.

Responsabilita:

- handler/controller: parsing, validazione di confine, autorizzazione, chiamata
  del caso d'uso e serializzazione della risposta;
- application service: orchestrazione del caso d'uso e della transazione;
- domain: invarianti e transizioni pure;
- repository: letture e scritture espresse nel linguaggio del dominio;
- `backend/db`: connessioni, driver, lock, migration e primitive infrastrutturali.

## Contratto repository

Ogni contratto dichiara:

- un nome dominio stabile;
- i metodi pubblici richiesti;
- per ogni metodo, tipo `read` o `write`;
- requisito transazionale `none`, `supported` o `required`.

L'implementazione deve fornire funzioni per tutti i metodi dichiarati. Puo
aggiungere dettagli privati, ma non puo ricevere `req`/`res`, costruire risposte
HTTP o prendere decisioni di autorizzazione.

Per PostgreSQL il service apre la transazione tramite
`runtime.withTransaction(...)`; il repository usa il client legato a quella
transazione e non esegue `BEGIN`, `COMMIT` o `ROLLBACK` autonomamente. Un metodo
marcato `required` non puo essere invocato fuori dal confine transazionale del
caso d'uso.

## Regola SQL universale

SQL eseguibile e ammesso soltanto:

- sotto `backend/db/`;
- in file con suffisso `.repo.js` o `.repository.js`.

La regola vale per tutti i domini, legacy inclusi. E vietato SQL in:

- `backend/server.js`;
- `*.handlers.js`;
- `*.routes.js`;
- controller, domain e application service;
- moduli applicativi generici non classificati come repository.

Script amministrativi e test sono fuori dal runtime e vengono verificati con
regole specifiche proprie. Comandi di protocolli non SQL, ad esempio Redis
`SELECT`, non sono classificati come query SQL.

## Invarianti del gate

1. Il controllo analizza tutti i sorgenti runtime JavaScript del backend, non
   soltanto i nuovi moduli.
2. Il riconoscimento usa la sintassi JavaScript e le stringhe/template literal,
   non una ricerca testuale nei commenti.
3. Una chiamata database diretta in un handler viene segnalata anche quando la
   query arriva da una variabile.
4. Il report contiene solo percorso, riga e tipo violazione; non stampa payload
   o credenziali.
5. Il gate entra nell'audit architetturale gia usato dal release gate.
6. Le violazioni esistenti vengono spostate nel proprietario canonico senza
   cambiare query, ordine transazionale o comportamento.

## Violazioni iniziali da chiudere

- verifica del residuo tavolo con due query SQLite in `backend/server.js`;
- acquisizione/rilascio del named lock MySQL per async flush ordini in
  `backend/server.js`;
- binding `last_event_id` realtime con SQL in un modulo applicativo non
  repository.

Tutte le violazioni sono state chiuse:

- `TablesBillsRelationalRepository.verifyDueInvariant()` possiede ora la
  verifica del residuo tavolo;
- `createOrderAsyncFlushMysqlLockRunner()` possiede acquisizione e rilascio del
  named lock MySQL, conservando il codice
  `ORDERS_ASYNC_FLUSH_MYSQL_LOCK_TIMEOUT` e le metriche legacy;
- `aggregate-last-event.repository.js` possiede il binding realtime e applica
  concretamente il nuovo contratto; il vecchio modulo resta come re-export di
  compatibilita senza SQL.

## Sequenza di verifica

1. test del contratto e fixture che viola il confine;
2. esecuzione rossa sul sorgente corrente;
3. implementazione del contratto e del gate;
4. estrazione delle tre violazioni senza cambio di comportamento;
5. test unitari dei proprietari infrastrutturali;
6. audit reale con zero violazioni;
7. suite backend pertinente e preflight.

## Evidenza test-first e audit

Fasi rosse osservate:

```text
contratto/gate assenti: modulo repository-contract non trovato
gate implementato sul sorgente pre-estrazione: 5/6 test verdi
violazioni rilevate: 9 occorrenze, riconducibili a 3 responsabilita
```

Esito finale:

```text
test contratto e boundary: 7/7
suite MIG-022: 27/27
route-policy architecture: 144/144
backend check: OK
source preflight: OK
architecture/security audit: 0 finding bloccanti
architecture/security gate: OK
```

Scansione completa:

```text
file runtime analizzati: 334
handler/controller/route analizzati: 47
owner persistence: 63
violazioni SQL/repository: 0
```

`server.js` e passato da 38.799 righe della baseline roadmap a 38.731 righe.
Resta intenzionalmente monolitico: la sua decomposizione a comportamento
invariato appartiene alla successiva fase P2b, non a MIG-022.

## File e comandi

File principali:

```text
SORGENTE_SISTEMA/cassa-frontend/backend/core/repository-contract.js
SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/mig022-repository-boundary.mjs
SORGENTE_SISTEMA/cassa-frontend/backend/tests/repository-boundary.test.mjs
SORGENTE_SISTEMA/cassa-frontend/backend/db/relational/aggregate-last-event.repository.js
SORGENTE_SISTEMA/cassa-frontend/backend/db/app-state/order-async-flush-mysql-lock.js
```

Comandi riproducibili:

```text
npm run test:migration:pg:mig022
npm run audit:repository-boundary
npm run audit:repository-boundary:report
npm run audit:architecture-security
npm run gate:architecture-security
npm run check:backend
npm run preflight:source
```

L'evidenza machine-readable e in
`SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig022/repository-boundary-20260831.json`
con SHA-256
`f50ee05ed4ad28618860d94492b7f5833f8ab5d5271734ef11ade48c3c8eae70`.

## Limiti intenzionali

MIG-022 definisce e rende bloccante il confine; non estrae tutte le route e non
sostituisce gli accessi `readDb`/`writeDb` degli handler legacy. Questi lavori
sono i gate espliciti di P2b (`MIG-030` e successivi). Nessun cutover o
disattivazione di MariaDB e autorizzato.
