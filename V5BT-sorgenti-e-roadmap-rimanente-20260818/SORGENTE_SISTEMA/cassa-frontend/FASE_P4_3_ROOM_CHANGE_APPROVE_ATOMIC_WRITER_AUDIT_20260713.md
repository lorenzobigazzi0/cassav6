# P4.3 - Audit writer atomico room-change approve

Data: 2026-07-13

## Obiettivo

Verificare se `POST /api/pos/room-change/approve` puo eliminare la richiesta
pendente e aggiornare sessione e ultima sala utente in un solo commit durevole,
senza introdurre un fast path che dichiari atomicita non reale.

## Owner e transazioni correnti

| Dato | Owner corrente | Repository | Confine transazionale |
| --- | --- | --- | --- |
| richiesta cambio sala pending | SQLite relazionale | `ReservationsRelationalRepository` | `BEGIN IMMEDIATE` / `COMMIT` SQLite |
| sessione mobile e sala corrente | MySQL InnoDB | `mysql-sessions-split.repository.js` | connessione e transazione MySQL proprie |
| ultima sala utente | MySQL InnoDB, dominio `users` | `mysql-domains-split.repository.js` | connessione e transazione MySQL proprie |
| mirror pending app-state | MySQL InnoDB, dominio `posRoomChangeRequests` | `mysql-domains-split.repository.js` | connessione e transazione MySQL propria |

La route esegue oggi, in ordine:

1. cancellazione della pending in SQLite;
2. mutazione dello snapshot applicativo;
3. sync MySQL di `sessions`;
4. sync MySQL dei domini `users` e `posRoomChangeRequests`;
5. eventuale write del contenitore app-state.

I repository split aprono autonomamente una connessione dal pool e chiudono la
propria transazione. Non accettano una connessione MySQL gia aperta dal caso
d'uso. SQLite e MySQL non possono inoltre partecipare alla stessa transazione
locale.

## Esito

**NO-GO per un writer atomico nel modello corrente.**

Comporre i metodi esistenti in una nuova funzione produrrebbe soltanto una
sequenza di commit. Chiamarla atomica nasconderebbe le seguenti finestre di
errore:

- SQLite commit riuscito e MySQL non disponibile: la pending canonica e gia
  sparita, ma sessione e utente possono restare sulla sala precedente;
- sessione MySQL aggiornata e dominio `users` fallito: la sala della sessione e
  l'ultima sala utente divergono;
- sessione e utente aggiornati, mirror pending fallito: un processo che legge
  un mirror non riallineato puo vedere una richiesta gia conclusa;
- retry dopo cancellazione SQLite: il CAS corrente risponde `missing`, quindi
  non esiste una prova durevole sufficiente per completare autonomamente il
  passo rimasto sospeso.

Non viene quindi introdotto alcun flag o fast path atomic-writer in questo step.

## Correzione applicata durante l'audit

`updatePosSessionRoom` modifica anche `users.lastSelectedRoomId`,
`users.lastSelectedRoomName`, `users.lastSelectedRoomAt` e
`users.lastSelectedRoomDeviceUuid`. La write della route dichiarava soltanto
`posRoomChangeRequests` e `sessions`: con dirty write e domini esternalizzati,
la modifica utente poteva restare solo in memoria.

La write dichiara ora anche `users`. Questo chiude la perdita di persistenza ma
non rende atomici i commit separati.

## Migrazione necessaria per un vero commit atomico

La soluzione coerente e spostare la pending nello stesso MySQL usato da
sessioni e utenti, mantenendo tutte le tabelle InnoDB nello stesso database.
Ordine minimo consigliato:

1. creare una tabella MySQL dedicata `pos_room_change_requests` con revisione,
   stato e timestamp terminali;
2. introdurre repository connection-bound che accettino la stessa connessione
   MySQL per pending, sessione e record utente;
3. fare shadow/dual comparison da SQLite a MySQL con conteggi e checksum;
4. promuovere MySQL a read/write owner della pending dietro un solo flag;
5. implementare un application service che apra una transazione, esegua CAS
   `pending -> approved`, aggiorni sessione e utente, quindi faccia un commit;
6. rendere il retry idempotente restituendo lo stesso esito per una richiesta
   gia approvata dallo stesso comando;
7. ritirare la cancellazione fisica immediata e conservare lo stato terminale
   per audit e recovery, con retention separata.

Spostare sessioni e utenti verso SQLite sarebbe una migrazione molto piu ampia
e invertirebbe l'owner condiviso gia usato dai processi API. Non e consigliato.

Se si deve mantenere il doppio store, l'alternativa e una saga persistente con
stati `pending`, `approving`, `approved` e retry/outbox. Essa puo garantire
recovery deterministico, ma non soddisfa il requisito di un singolo commit.

## Guardrail aggiunti

- il test architetturale verifica che la route dichiari `users` tra i domini
  modificati;
- il test registra esplicitamente che pending e sessione usano SQLite e MySQL
  con transazioni separate;
- il test verifica l'ordine corrente delete relazionale -> write app-state,
  cosi una futura modifica del confine richiede una decisione consapevole.

## Decisione roadmap

Room-change viene chiuso senza atomic fast path. Il PIN asincrono pre-lane resta
default OFF fino al gate load-100/Linux gia definito. Il prossimo dominio P4.3
e `waiter pause/start/stop`, iniziando da misura separata di lane wait, run,
scritture e fan-out notifiche.
