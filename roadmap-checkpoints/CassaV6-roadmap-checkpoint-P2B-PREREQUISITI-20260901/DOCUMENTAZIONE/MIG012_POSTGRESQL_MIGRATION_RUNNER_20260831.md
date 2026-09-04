# MIG-012 - PostgreSQL migration runner

Data: 2026-08-31

## Risultato

MIG-012 e completata nel sorgente V6. Il backend dispone ora di un migration
runner PostgreSQL deterministico, idempotente e separato dal runtime dei domini.

Nessuna migrazione applicativa V6 e stata applicata al database `cassav6`:
l'introduzione degli schemi foundation resta responsabilita di MIG-020.

## Contratto del runner

- discovery dei file nel formato `NNN_nome.sql`;
- ordinamento deterministico e rifiuto di versioni duplicate;
- checksum SHA-256 calcolato sul contenuto SQL;
- registro canonico `app_meta.schema_migrations` con `version`, `applied_at` e
  `checksum`;
- advisory lock PostgreSQL fail-fast per impedire runner concorrenti;
- una transazione gestita dal runner per ogni migrazione;
- `ROLLBACK` su errore senza registrare la versione fallita;
- seconda esecuzione idempotente tramite skip delle versioni gia applicate;
- blocco immediato se il checksum di una versione applicata non coincide;
- divieto di `BEGIN`, `COMMIT` e `ROLLBACK` nei file SQL;
- credenziali e dettagli di connessione non inclusi nell'output.

## Confini architetturali

- implementazione infrastrutturale:
  `SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/migrations.js`;
- CLI di sola orchestrazione:
  `SORGENTE_SISTEMA/cassa-frontend/backend/scripts/migrate-postgresql.mjs`;
- directory applicativa:
  `SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/migrations`;
- smoke reale:
  `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/mig012-runner-smoke.mjs`.

La directory applicativa resta intenzionalmente senza file `.sql` fino a
MIG-020. I file `DRAFT TARGET` forniti dalla roadmap contengono ancora gestione
transazionale interna e non vengono eseguiti direttamente.

## Smoke sul Raspberry reale

Lo smoke e stato eseguito sulla microSD usando un database temporaneo dedicato,
`cassav6_mig012_smoke_20260831`, con owner `cassav6_migrator`.

Esito:

```text
prima esecuzione: 2 applied, 0 skipped
seconda esecuzione: 0 applied, 2 skipped
checksum drift: bloccato
migrazione volutamente errata: rollback osservato
schema_migrations: 2 righe valide
tabella della migration fallita: assente
riga registro della migration fallita: assente
```

Tempi osservati sulla prima esecuzione:

- `900001_mig012_smoke_schema`: 2,09 ms;
- `900002_mig012_smoke_table`: 5,18 ms.

Checksum delle due migration di smoke:

- `49436a15cb0bc0f1fdfa4ad05f9d4f25044f1e6425520beb4179beafba58516d`;
- `ac7c40a43c09e32a802c6a97a62f9a99c4e0e6337d595357c771227b1b695dd8`.

Al termine, il database temporaneo e lo staging sotto `/home/admin` sono stati
rimossi. La verifica sul database DEV `cassav6` ha confermato l'assenza dello
schema `app_meta`; quindi lo smoke non ha lasciato modifiche sul target reale.

`cassav5bt.service`, MariaDB e PostgreSQL sono rimasti `active`.

## Comandi

```text
npm run test:migration:pg:mig012
npm run migrate:postgresql:plan
npm run migrate:postgresql
```

Il comando applicativo fallisce esplicitamente se la directory non contiene
migrazioni valide. Le credenziali del ruolo `cassav6_migrator` devono essere
fornite dall'ambiente esterno alla repository.
