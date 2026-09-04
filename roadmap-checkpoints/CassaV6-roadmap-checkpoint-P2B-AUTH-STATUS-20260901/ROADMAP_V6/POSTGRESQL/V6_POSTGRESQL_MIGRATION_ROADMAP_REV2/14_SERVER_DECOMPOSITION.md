# 14 — Decomposizione di `server.js` (fase P2b, prerequisito)

## Perche esiste questa fase

La REV1 assumeva di poter sostituire un layer di accesso dati. Quel layer non
esiste.

Stato verificato:

- `backend/server.js`: **38.799 righe, 1,4 MB**;
- contiene **86 occorrenze di `readDb(`** e **26 di `writeDb(`**, cioe il 38% e il
  29% dei totali di progetto;
- `readDb()` non legge un'entita: chiama `appStateRepository.readDb()` e poi
  applica in sequenza `refreshExternalizedSessionsForRead`,
  `refreshExternalizedIntegrationOrderTarget`, `refreshExternalizedTableLocksForRead`,
  `refreshExternalizedIntegrationStationStatesForRead`,
  `refreshExternalizedIntegrationSequenceForRead`, e **ritorna l'intero grafo di
  stato**;
- gli handler mutano quell'oggetto in memoria e lo riscrivono con `writeDb()`,
  che applica dirty tracking sui domini split.

Conseguenza diretta: **"migrare un bounded context alla volta" non e eseguibile**
finche i contesti condividono un singolo oggetto mutabile. Ogni task `MIG-0xx` di
dominio, preso alla lettera, si trascina dietro una porzione arbitraria del
monolite, e il gate "zero read/write app-state per il dominio X" non e verificabile
perche il dominio X non ha un confine.

`MIG-022` della REV1 ("no SQL negli HTTP handlers") limitava la regola ai **nuovi**
domini. E il modo in cui il problema sopravvive alla migrazione.

## Regola della fase

**Zero cambi di comportamento e zero cambi di database.** Questa fase e una
rifattorizzazione a parita di funzionalita, verificabile con la suite esistente.
Se un test cambia, o e stato introdotto un bug o il test testava la struttura
invece del comportamento: entrambi i casi vanno risolti prima di procedere.

## Sequenza

### P2b.1 — Inventario dei confini

Per ogni gruppo di route in `server.js`, produrre una riga:

```text
route | dominio | collezioni app-state lette | collezioni scritte | dipendenze cross-dominio
```

Output: `reports/server_route_boundaries.csv`. Questo file e il vero backlog:
sostituisce la stima "228 readDb da azzerare" con una mappa di dipendenze.

**Gate**: ogni route ha un dominio assegnato, oppure e esplicitamente marcata
`cross-domain` con motivazione.

### P2b.2 — Estrazione delle route senza logica

Spostare fuori da `server.js` le route che sono solo parsing, validazione e
delega. Nessun accesso dati cambia: continuano a chiamare `readDb`/`writeDb`
importati.

**Gate**: `server.js` sotto le 25.000 righe, suite verde.

### P2b.3 — Introduzione dei reader scoped

Per ogni dominio, introdurre funzioni di lettura che dichiarano **cosa** leggono:

```js
// prima
const db = await readDb();
const order = db.integration.orders.find(o => o.id === id);

// dopo
const order = await orderReader.byId(id);   // internamente ancora app-state
```

L'implementazione resta app-state. Cambia solo che la dipendenza diventa
esplicita e sostituibile. Questo e il punto in cui la migrazione per dominio
diventa possibile.

**Gate**: nessun handler di dominio chiama `readDb()` direttamente; i reader sono
gli unici chiamanti per quel dominio.

### P2b.4 — Introduzione dei writer scoped

Stesso trattamento per le mutazioni. Il writer riceve l'intento, non lo stato
mutato:

```js
// prima
db.integration.orders[i].status = "closed"; await writeDb(db, {...});

// dopo
await orderWriter.close({ orderId, actor, revision });
```

Il writer internamente fa ancora read-mutate-write su app-state. La differenza e
che ora esiste **un solo punto per dominio** da riscrivere quando arriva
PostgreSQL.

**Gate**: `writeDb()` non compare piu negli handler di dominio; solo dentro i
writer e nel layer app-state.

### P2b.5 — Isolamento del residuo

Quello che resta in `server.js` dopo P2b.4 e il vero nucleo condiviso: bootstrap,
middleware, realtime, coordinamento lane. Va documentato come tale, non
ulteriormente frammentato in questa fase.

**Gate**: `server.js` sotto le 10.000 righe; il residuo e descritto in
`reports/server_core_residual.md`.

## Perche non si puo saltare

Senza P2b:

- il gate "0 read/write app-state per dominio migrato" e non falsificabile;
- ogni PR di migrazione tocca `server.js` e collide con le altre;
- il rollback per dominio e impossibile, perche non esiste un dominio da
  rollbackare;
- l'esecuzione assistita da agente (doc 11) opera su un file da 1,4 MB che non
  entra in nessun contesto utile, quindi lavora alla cieca.

## Relazione con le altre fasi

- P2b **dipende da** P2 (foundation): serve che repository/transaction helper
  esistano come destinazione.
- P2b **blocca** P3 e tutte le fasi di dominio successive.
- P2b **non tocca** P0/P1.

## Costo e rischio

E la fase con il rapporto sforzo/visibilita peggiore del programma: molto lavoro,
nessuna funzionalita nuova, nessun numero che migliora. E anche la fase senza la
quale le altre non sono eseguibili come descritte. Va comunicata come tale prima
di iniziarla, non a meta.
