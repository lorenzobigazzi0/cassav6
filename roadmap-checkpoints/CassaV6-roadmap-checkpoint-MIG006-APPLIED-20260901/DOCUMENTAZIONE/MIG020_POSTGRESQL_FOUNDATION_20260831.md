# MIG-020 - foundation PostgreSQL

Data: 2026-08-31

## Esito

MIG-020 e completata nel database PostgreSQL DEV `cassav6` sul Raspberry. La
migration applicativa `001_foundation` crea gli oggetti minimi richiesti per le
fasi P2 successive senza commutare alcun dominio o percorso runtime.

Checksum immutabile della migration:

```text
f4dfc85778f84394cbe21eb313abd0d55932ac899200bb5448fb6b99c1271de7
```

## Oggetti creati

Schemi:

- `app_meta`, proprietario del registro del migration runner;
- `audit`;
- `messaging`.

Tabelle:

- `app_meta.schema_migrations`;
- `audit.events`;
- `messaging.idempotency_keys`;
- `messaging.command_inbox`;
- `messaging.event_outbox`.

Indici applicativi:

- `audit_events_aggregate_time_idx`;
- `idempotency_expiry_idx`;
- `event_outbox_claimable_idx`;
- `event_outbox_lease_idx`.

Il DRAFT della roadmap non e stato eseguito direttamente: il controllo
transazionale esterno e rimasto al runner, le tabelle sono create in modo
stretto e una presenza manuale/incompatibile provoca errore invece di essere
silenziosamente accettata.

## Confine dei privilegi

Il provisioning ora separa tre responsabilita:

- `cassav6_migrator`: login proprietario DDL, senza privilegi amministrativi;
- `cassav6_runtime`: ruolo tecnico `NOLOGIN`, senza privilegi amministrativi;
- `cassav6_app`: login del backend, membro `INHERIT` di
  `cassav6_runtime`, senza `SUPERUSER`, `CREATEDB` o `CREATEROLE`.

Il runtime non vede `app_meta` e non possiede `CREATE` sugli schemi. Su audit ha
solo `SELECT` e `INSERT`; non puo alterare o cancellare eventi. Sulle tabelle
messaging ha `SELECT`, `INSERT` e `UPDATE`, ma non `DELETE`.

Questi grant preparano i repository senza anticipare le regole critiche:

- claim con lease e `SKIP LOCKED`: MIG-023;
- audit append-only applicativo e relativi invarianti: MIG-024;
- protocollo idempotency e transizioni: MIG-025.

MIG-020 crea soltanto la persistenza foundation; non duplica quelle regole in
trigger o nel frontend.

## Smoke su database temporaneo

Database: `cassav6_mig020_smoke_20260831`, rimosso al termine.

Esito:

- prima applicazione: 1 migration applicata in 14,37 ms;
- seconda applicazione: 1 migration saltata per idempotenza;
- durata complessiva dello smoke: 86,74 ms;
- tabelle, indici, owner e membership verificati via catalogo PostgreSQL;
- INSERT/SELECT runtime riusciti;
- UPDATE e DELETE su `audit.events` rifiutati;
- DELETE su `messaging.event_outbox` rifiutato;
- DDL runtime e accesso ad `app_meta` rifiutati;
- `attempt_count=-1` rifiutato con `CHECK`;
- duplicato `(scope,key)` rifiutato dalla chiave primaria.

## Applicazione al database DEV

Prima dell'applicazione e stato eseguito il backup logico tramite il servizio
MIG-013. La migration e stata applicata a `cassav6`, poi eseguita di nuovo:

```text
prima esecuzione: 1 applicata, 0 gia presenti
seconda esecuzione: 0 applicate, 1 gia presente
```

La verifica read-only sul database DEV e terminata in 28,59 ms. Tutte le quattro
tabelle applicative erano vuote dopo l'applicazione: nessun dato fixture e stato
lasciato nel database DEV.

Un nuovo dump post-migration e stato ripristinato in un database isolato:

```text
archivio: logical-cassav6-20260831T115216Z.dump
tempo restore: 31 ms
oggetti catalogo ripristinati: 5
```

Il database di restore e stato eliminato. Non risultano database
`cassav6_mig020_smoke_*` o `cassav6_restore_verify_*` residui.

## Stato operativo finale

- Cassa, MariaDB e PostgreSQL: `active`;
- timer backup logico e base backup: `enabled`;
- `fsync`, `full_page_writes`, `synchronous_commit`, `archive_mode`: `on`;
- WAL archiver: 22 file archiviati, 0 errori;
- spazio microSD: 41 GiB disponibili su 58 GiB;
- configurazione pre-riprovisioning:
  `/var/backups/cassav6-postgresql/pre-dev-sd-20260831T114813Z`;
- nessun reboot eseguito.

## Comandi

```text
npm run migrate:postgresql:plan
npm run test:migration:pg:mig020
sudo scripts/postgresql-migration/run-mig020-foundation-smoke.sh \
  --database cassav6_mig020_smoke_YYYYMMDD
sudo scripts/postgresql-migration/run-mig020-foundation-smoke.sh \
  --database cassav6 --verify-only
```

L'evidenza machine-readable e in
`SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig020/raspberry-dev-sd-20260831.json`
con SHA-256
`c35d5108e1e6da3c8030629620d43e39c711b01d2e82007b115b9a310bdf23ad`.

## Gate non autorizzati

Questa applicazione riguarda solo PostgreSQL DEV sulla microSD. Nessun dominio
legge o scrive ancora PostgreSQL, il backend resta disabilitato per default e
non sono autorizzati cutover, spegnimento MariaDB o certificazione produzione.
