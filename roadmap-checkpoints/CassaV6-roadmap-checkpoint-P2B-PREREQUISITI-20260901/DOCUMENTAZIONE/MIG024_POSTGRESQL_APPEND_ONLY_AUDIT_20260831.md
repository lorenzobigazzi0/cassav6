# MIG-024 - audit append-only PostgreSQL

Data: 2026-08-31

## Obiettivo e source of truth

Prima di MIG-024, `audit.events` esiste come tabella foundation e il ruolo
runtime possiede soltanto `SELECT` e `INSERT`, ma manca un repository
PostgreSQL e il vincolo append-only dipende ancora principalmente dai grant.
Gli audit operativi correnti restano in app-state/MySQL/SQLite relazionale.

Dopo MIG-024, PostgreSQL offre la primitiva per inserire un audit critico nello
stesso commit della mutazione business. Nessun audit legacy viene migrato e
nessuna route cambia source of truth in questo task.

## Confine architetturale

- `backend/db/postgresql/audit-events.repository.js` e l'unico owner SQL;
- `append(client, event)` richiede il client transazionale del chiamante e non
  apre connessioni o transazioni autonome;
- il transaction helper MIG-021 orchestra `BEGIN`, business write, audit e
  `COMMIT`/`ROLLBACK`;
- handler e controller non inseriscono direttamente in `audit.events`;
- letture puntuali e per aggregato possono acquisire una connessione, le
  scritture no.

## Invarianti progettate prima dell'implementazione

1. Un audit critico e confermato soltanto nello stesso commit del dato business.
2. Se l'audit fallisce, anche la mutazione business viene annullata.
3. Se la transazione fallisce dopo entrambi gli insert, non resta nessuna riga.
4. Il repository esegue esclusivamente `INSERT`: nessun upsert, update, delete o
   sostituzione silenziosa di un ID gia esistente.
5. `occurred_at` deriva da `now()`/default PostgreSQL, non dall'orologio client.
6. `id`, `domain` e `action` sono obbligatori e bounded; aggregate type e ID
   sono entrambi presenti oppure entrambi assenti.
7. `payload` e un oggetto JSON serializzabile, limitato a 1 MiB e clonato prima
   della query.
8. Chiavi payload che possono contenere password, PIN, token, cookie, secret o
   credenziali vengono rifiutate ricorsivamente.
9. ID duplicato produce un errore di vincolo e non rende idempotente un evento
   diverso. L'idempotenza appartiene al caso d'uso che genera l'ID.
10. Il ruolo runtime conserva soltanto `SELECT` e `INSERT`.
11. Trigger di schema rifiutano `UPDATE`, `DELETE` e `TRUNCATE`, anche se una
    futura regressione nei grant concedesse accidentalmente tali privilegi.
12. Le letture sono bounded e ordinate deterministicamente per
    `occurred_at DESC, id DESC`.

## Modello canonico

Il repository segue direttamente `audit.events`:

```text
id, domain, aggregateType?, aggregateId?, action,
actorUserId?, actorUsername?, payload
```

Informazioni aggiuntive come ruolo, device, correlation ID, before/after devono
essere inserite nel payload gia sanificato dal servizio applicativo del dominio.
Il repository non copia implicitamente l'intero oggetto richiesta.

## Strategia test-first

1. test del contratto repository e del solo `INSERT` transazionale;
2. test di rollback dopo business write + audit;
3. test di rollback della business write quando l'audit fallisce;
4. test input/payload sensibili e query di lettura bounded;
5. test statico della migration append-only;
6. smoke reale in database temporaneo `cassav6_mig024_*`;
7. applicazione idempotente della migration al database DEV `cassav6`.

La verifica resta DEV su microSD. Non richiede SSD, non abilita nuovi percorsi
runtime e non autorizza il cutover.

## Implementazione

- aggiunto il repository PostgreSQL con contratto esplicito e mapping in
  camelCase;
- `append(client, event)` usa esclusivamente il client transazionale ricevuto;
- aggiunte letture bounded `getById` e `listByAggregate`;
- aggiunta la migration `003_audit_events_append_only`, con vincoli sul payload
  e sulla coppia aggregato, revoca dei privilegi distruttivi e trigger contro
  `UPDATE`, `DELETE` e `TRUNCATE`;
- aggiunti smoke DEV isolato e wrapper di applicazione idempotente su microSD.

La fase rossa test-first ha prodotto 0 test superati su 8: il repository non
era esportato e la migration non esisteva. Dopo l'implementazione la suite
mirata MIG-024 e risultata verde con 31 test su 31.

## Verifica reale Raspberry/microSD

Lo smoke e stato eseguito su Raspberry `aarch64`, PostgreSQL 17.11 e filesystem
`ext4` sul device `/dev/mmcblk0p2`, usando un database temporaneo
`cassav6_mig024_20260831a`:

- commit business + audit: 1 riga business e 1 audit, 6,87 ms;
- rollback dopo entrambi gli insert: 0 righe business e 0 audit, 3,83 ms;
- audit duplicato: SQLSTATE `23505` e rollback della business write;
- ruolo `cassav6_app`: `SELECT`/`INSERT` concessi, `UPDATE`/`DELETE`/`TRUNCATE`
  negati con SQLSTATE `42501`;
- proprietario dello schema: `UPDATE`/`DELETE`/`TRUNCATE` respinti dai trigger
  con SQLSTATE `55000`;
- vincoli coppia aggregato e payload oggetto verificati con SQLSTATE `23514`;
- servizi `postgresql` e `cassa` rimasti attivi; database e staging temporanei
  rimossi.

La migration e stata poi applicata al database DEV `cassav6`: prima esecuzione
con `003` applicata, seconda con tutte e tre le migration saltate per checksum
gia registrato. I due vincoli risultano validati, i due trigger abilitati e le
tabelle foundation sono rimaste vuote.

Gate finali locali:

- suite MIG-024: 31/31;
- policy route: 144/144;
- repository boundary: 338 file runtime, 47 handler, 65 owner persistence e 0
  violazioni;
- audit architettura/sicurezza: 0 finding bloccanti;
- gate architettura/sicurezza, check sintattico backend e preflight sorgente:
  superati.

I nove warning architetturali sul monolite `backend/server.js` erano gia noti e
non sono stati aumentati o aggirati da MIG-024.

Evidenza machine-readable:

- `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig024/raspberry-dev-sd-20260831.json`;
- SHA-256 `da3884c05d9fcb462e502d3d66d44fa893004d8cc981530ccea16c4a019ec7cc`.

## Decisione

MIG-024 e `DONE` in ambito DEV. L'append-only e difeso sia dalla matrice dei
privilegi sia dallo schema, mentre l'atomicita e responsabilita della
transazione applicativa MIG-021. MIG-026 dovra introdurre un percorso di
manutenzione esplicito e controllato per la retention: non dovra aggirare
silenziosamente questi trigger. SSD, dati reali e cutover produzione restano
fuori ambito e non sono prerequisiti per lo sviluppo corrente.
