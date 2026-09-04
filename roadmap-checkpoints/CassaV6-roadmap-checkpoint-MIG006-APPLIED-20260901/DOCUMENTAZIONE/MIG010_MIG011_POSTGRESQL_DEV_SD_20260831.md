# MIG-010 / MIG-011 - PostgreSQL DEV su microSD

Data: 2026-08-31

## Risultato

PostgreSQL 17 e stato installato e predisposto sul Raspberry per sviluppo, senza
commutare alcun percorso dati dell'applicazione. Il modulo pool PostgreSQL del
backend e stato aggiunto alla repository ed e disabilitato per default.

## Provisioning Raspberry

- sistema: Debian 13 arm64;
- pacchetto server: PostgreSQL `17.11-0+deb13u1`;
- cluster: `17/main`, porta `5432`, stato `online`;
- bind: solo `127.0.0.1:5432`;
- data directory: `/var/lib/postgresql/17/main` sulla microSD;
- database di sviluppo: `cassav6`;
- owner/migration role: `cassav6_migrator`, senza privilegi superuser,
  `CREATEDB` o `CREATEROLE`;
- application role: `cassav6_app`, senza privilegi DDL, superuser, `CREATEDB` o
  `CREATEROLE`;
- credenziali casuali salvate esclusivamente sul Raspberry:
  - `/etc/cassav6/postgresql-app.env` (`0640`, `root:admin`);
  - `/etc/cassav6/postgresql-migration.env` (`0600`, `root:root`).

Il test negativo `CREATE TABLE` con `cassav6_app` ha restituito `permission
denied for schema public`, come previsto.

## Profilo conservativo microSD / 4 GiB

- `max_connections=30`;
- `shared_buffers=256MB`;
- `effective_cache_size=1GB`;
- `work_mem=2MB`;
- `maintenance_work_mem=64MB`;
- `fsync=on`;
- `full_page_writes=on`;
- `synchronous_commit=on`;
- data page checksums: `on`;
- pool applicativo previsto: massimo 6 connessioni per processo.

Non sono stati eseguiti carichi `fio` aggressivi sulla microSD. Il gate di
durabilita/prestazioni sullo storage definitivo resta aperto per produzione.

## MIG-011 nel backend

Responsabilita aggiunte sotto `backend/db/postgresql`:

- parsing e validazione centralizzata della configurazione;
- caricamento lazy del driver `pg` e pool disabilitato per default;
- acquisizione connessioni con misura del queue wait;
- health check `SELECT 1` senza esposizione di host, database, utente, errori o
  credenziali nell'endpoint pubblico;
- gauge pool (totali, idle, attese) e contatori health/acquisizione;
- chiusura del pool durante lo shutdown.

Smoke reale del modulo sul Raspberry con le credenziali applicative:

```text
enabled=true
ok=true
status=ready
latencyMs=62.22
pool total=1 idle=1 waiting=0 max=6
```

MariaDB, `cassav5bt.service` e PostgreSQL sono rimasti contemporaneamente
`active` al termine della verifica. Lo spazio root e rimasto 41 GiB disponibili
su 58 GiB (27% utilizzato).

## Riparazione preesistente del package manager

Prima dell'installazione PostgreSQL, `dpkg` risultava interrotto da un precedente
aggiornamento kernel. `dpkg --configure -a` falliva perche
`/etc/initramfs-tools/initramfs.conf` usava `MODULES=dep` e la root esposta come
`/dev/root` non era risolvibile dal generatore.

E stato applicato il workaround indicato da `initramfs-tools`, impostando
`MODULES=most`. La copia precedente e conservata in
`/etc/initramfs-tools/initramfs.conf.before-cassav6-pg-20260831`. Al termine,
`dpkg --audit` non ha prodotto segnalazioni. Non e stato eseguito alcun riavvio.

Il completamento del precedente aggiornamento ha segnalato che il kernel Debian
RT `6.12.96` non e supportato dallo script firmware Raspberry; il kernel in
esecuzione durante le verifiche e rimasto `6.18.37-rt+`. Prima di un futuro
riavvio va verificata esplicitamente la configurazione di boot.

## Rollback e confini

- backup configurazione PostgreSQL: directory con prefisso
  `/var/backups/cassav6-postgresql/pre-dev-sd-`;
- backup initramfs: percorso riportato sopra;
- script idempotente e senza segreti:
  `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/provision-postgresql-dev-sd.sh`;
- `BACKEND_POSTGRES_ENABLED` resta `0` per default;
- nessuna tabella applicativa V6 e stata ancora creata;
- nessun dato reale e stato migrato;
- nessun cutover e autorizzato.

