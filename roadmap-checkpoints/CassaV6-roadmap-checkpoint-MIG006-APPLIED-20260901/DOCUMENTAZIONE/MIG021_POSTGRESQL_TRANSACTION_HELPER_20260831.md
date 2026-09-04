# MIG-021 - transaction helper PostgreSQL

Data: 2026-08-31

## Esito

MIG-021 e completata per il runtime PostgreSQL DEV. Il runtime espone ora
`withTransaction(label, callback, options)` con `BEGIN`, `COMMIT`, `ROLLBACK` e
retry limitato agli SQLSTATE PostgreSQL di serializzazione e deadlock.

Nessun handler o dominio applicativo e stato collegato a PostgreSQL. Il task
introduce una primitiva infrastrutturale per i repository dei task successivi e
non cambia la source of truth corrente.

## Confine architetturale

Il transaction helper appartiene a `backend/db/postgresql`. Controller e UI non
aprono, confermano o annullano transazioni. L'intero tentativo usa una sola
connessione del pool e il callback riceve il client vincolato alla transazione,
oltre al contesto `{ attempt, maxAttempts }`.

La callback viene rieseguita interamente in caso di retry. Deve quindi contenere
solo operazioni database ripetibili o protette da idempotency key; I/O esterno e
side effect non transazionali non sono ammessi. Le transazioni annidate non
fanno parte del contratto.

## Invarianti implementate

1. Il livello di isolamento e sempre esplicito e in whitelist: `READ COMMITTED`,
   `REPEATABLE READ` o `SERIALIZABLE`.
2. Il risultato del callback viene restituito soltanto dopo un `COMMIT` riuscito.
3. Ogni errore successivo a `BEGIN` tenta `ROLLBACK` prima di essere propagato o
   ritentato.
4. L'errore applicativo originale resta primario anche se falliscono rollback o
   rilascio della connessione.
5. Sono ritentabili soltanto `40001` (`serialization_failure`) e `40P01`
   (`deadlock_detected`), anche nella catena `cause`; il testo dell'errore non
   viene usato per decidere.
6. Il retry richiede transazione iniziata, nessun commit e rollback riuscito. Un
   errore ambiguo di connessione durante il commit non viene ritentato.
7. I tentativi sono limitati: 3 per default, massimo 5.
8. Il backoff e esponenziale, deterministico e limitato: 25 ms di base e 250 ms
   di limite per default, senza jitter nascosto.
9. Errori di metriche o logger non cambiano l'esito dell'operazione database.
10. Label e codici nei log sono controllati; query, payload, credenziali e
    messaggi originali del database non vengono registrati.

Le metriche aggiunte misurano invocazioni, tentativi, commit, rollback, retry,
fallimenti, durata dei tentativi, backoff e durata totale.

## Sequenza test-first

La sequenza prevista dalla guida per i task critici e stata rispettata:

1. invarianti scritte prima del codice;
2. suite iniziale eseguita senza helper: 0/11 test superati, fallimento atteso
   per API assente;
3. implementazione del transaction runner e integrazione nel runtime;
4. suite mirata finale: 18/18 test superati;
5. prova di concorrenza sul PostgreSQL reale;
6. misura archiviata in formato JSON.

I test coprono successo, rollback, errori permanenti, `40001`, `40P01` nella
catena `cause`, esaurimento tentativi, errore durante commit, commit ambiguo,
rollback fallito, `BEGIN` fallito, whitelist dell'isolation level e telemetria
difettosa.

## Smoke reale sul Raspberry

Ambiente:

- host: `raspberrypi`, architettura `aarch64`;
- PostgreSQL `17.11 (Debian 17.11-0+deb13u1)`;
- storage root: `/dev/mmcblk0p2`, `ext4`, microSD;
- ruolo runtime: `cassav6_app`;
- database isolato: `cassav6_mig021_20260831a`, rimosso al termine.

Due transazioni `SERIALIZABLE` hanno letto lo stesso contatore prima di tentare
l'aggiornamento. PostgreSQL ha annullato una transazione con SQLSTATE `40001` e
l'helper ha rieseguito l'intero callback:

```text
durata concorrenza: 19,29 ms
callback worker A: 1
callback worker B: 2
retry misurati: 1
backoff misurato: 5 ms
valore iniziale: 0
valore finale: 2
```

Il probe separato di rollback ha aggiunto 100 nella transazione e poi sollevato
un errore intenzionale. Dopo il rollback il valore e rimasto 2 e l'identita
dell'errore originale e stata preservata. Per questo il report contiene un
`postgresTransactionFailures`: e il fallimento intenzionale del probe, non un
errore dello smoke.

Lo staging ha usato `pg@8.23.0` in una directory temporanea, perche il tree
attualmente in esecuzione sul Raspberry precede l'aggiunta del driver. Nessun
file del servizio Cassa e stato sostituito e nessun riavvio e stato eseguito.

Verifiche finali sul Raspberry:

- database temporaneo assente;
- directory e archivi di staging assenti;
- tabelle foundation nel database DEV `cassav6` ancora vuote (`0|0|0|0`);
- `cassav5bt.service`, `mariadb` e `postgresql@17-main`: `active`.

## File e comandi

Implementazione e test:

```text
SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/transactions.js
SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/connection.js
SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-transactions.test.mjs
SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-runtime.test.mjs
SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/mig021-transaction-smoke.mjs
```

Comandi locali:

```text
npm run test:migration:pg:mig021
npm run check:backend
node --check scripts/postgresql-migration/mig021-transaction-smoke.mjs
```

Lo smoke mutativo rifiuta database che non rispettano il pattern
`cassav6_mig021_*` e richiede `MIG021_ALLOW_SMOKE=1`.

L'evidenza machine-readable e in
`SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig021/raspberry-dev-sd-20260831.json`
con SHA-256
`2ee49cd15e8fd4d4071f8142e3fd61de744af9cc521c0ef308ccbe8e07e82ea3`.

## Gate non autorizzati

La verifica riguarda esclusivamente lo sviluppo PostgreSQL su microSD. L'SSD
non e un requisito per proseguire lo sviluppo, ma la certificazione produzione
e il cutover restano separati e non sono autorizzati. MariaDB e i percorsi
legacy rimangono attivi.
