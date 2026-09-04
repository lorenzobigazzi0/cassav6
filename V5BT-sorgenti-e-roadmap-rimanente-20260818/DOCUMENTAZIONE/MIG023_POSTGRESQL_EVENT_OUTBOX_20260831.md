# MIG-023 - transactional event outbox PostgreSQL

Data: 2026-08-31

## Obiettivo e source of truth

Prima di MIG-023, `messaging.event_outbox` esiste come struttura foundation ma
non ha un repository PostgreSQL né un worker applicativo. I percorsi runtime
legacy restano autorevoli e non vengono collegati a PostgreSQL da questo task.

Dopo MIG-023, PostgreSQL possiede la primitiva infrastrutturale per accodare un
evento nella stessa transazione della mutazione business e consumarlo con
consegna *at least once*. Nessun dominio viene migrato o attivato: il cutover
resta responsabilità dei task di dominio successivi.

## Confini architetturali

- `backend/db/postgresql/event-outbox.repository.js` possiede SQL e transizioni
  persistenti dell'outbox.
- il chiamante passa al metodo `enqueue` il client della propria transazione;
  il repository non apre una seconda transazione;
- `backend/modules/messaging/event-outbox-worker.js` orchestra claim, consumer,
  completamento e retry, senza contenere SQL;
- l'I/O esterno del consumer avviene soltanto dopo il commit della transazione
  di claim;
- handler e controller non conoscono lease, query o transazioni dell'outbox.

## Invarianti progettate prima dell'implementazione

1. Il claim è una sola `UPDATE ... FROM` alimentata da una selezione
   `FOR UPDATE SKIP LOCKED`, eseguita tramite il transaction helper MIG-021.
2. La transazione di claim termina prima di invocare qualunque consumer.
3. Due worker concorrenti non ricevono la stessa riga nello stesso intervallo
   di lease.
4. Ogni claim incrementa `attempt_count` esattamente una volta e assegna insieme
   `lease_owner` e `lease_until`.
5. Una riga non processata con lease scaduto torna claimable senza una procedura
   distruttiva di startup.
6. Soltanto il worker proprietario può completare, estendere o ripianificare una
   riga; una transizione stale restituisce esplicitamente `null`.
7. Il completamento richiede inoltre un lease non scaduto, così un worker lento
   non può dichiarare completato il lavoro già ripreso da un altro worker.
8. Il completamento azzera il lease; un evento processato non è più claimable.
9. Un errore rilascia il lease, sposta `available_at` con backoff e persiste solo
   un codice controllato, non payload o messaggi potenzialmente sensibili.
10. Ogni consumer è dichiarato tramite un contratto esplicito e riceve sempre
    `event.id` come `idempotencyKey`. Un crash dopo il side effect e prima del
    completamento può causare una nuova consegna con la stessa chiave, mai con
    una chiave casuale.
11. I limiti di batch, lease e backoff sono validati e bounded prima di accedere
    al database.
12. Il clock autorevole per claim, lease e retry è `now()` di PostgreSQL.

## Stati e transizioni

Lo stato è derivato dalle colonne, senza una seconda source of truth:

- `READY`: `processed_at IS NULL` e lease assente o scaduto, con
  `available_at <= now()`;
- `LEASED`: `processed_at IS NULL`, owner presente e lease futuro;
- `DELAYED`: non processato ma `available_at > now()`;
- `PROCESSED`: `processed_at IS NOT NULL`, stato terminale.

Transizioni ammesse:

```text
READY/lease scaduto -> LEASED -> PROCESSED
READY/lease scaduto -> LEASED -> DELAYED -> LEASED
LEASED -> LEASED (estensione dello stesso owner)
```

Non sono ammesse transizioni da `PROCESSED` né mutazioni da un owner diverso.

## Strategia di verifica

La sequenza è test-first perché MIG-023 è classificata critica:

1. test unitari del contratto e delle query;
2. test del worker e della chiave idempotente stabile;
3. test della migration per la coerenza del lease;
4. prova reale su PostgreSQL con due connessioni concorrenti;
5. crash simulato dopo un side effect idempotente e prima del completamento;
6. recupero reale di un lease scaduto e rifiuto del completamento stale.

Lo smoke mutativo deve usare esclusivamente un database temporaneo con nome
`cassav6_mig023_*` e deve rimuoverlo al termine. Lo sviluppo resta consentito su
microSD; questa verifica non certifica lo storage di produzione e non autorizza
il cutover.

## Esito

MIG-023 e completata nel profilo PostgreSQL DEV. Sono stati aggiunti:

- migration `002_event_outbox_lease_contract`, con vincoli validati sulla
  coerenza owner/scadenza e sull'assenza di lease nello stato terminale;
- repository PostgreSQL con `enqueue`, claim batch, estensione lease,
  completamento owner-bound, retry e lettura puntuale;
- worker applicativo con consumer dichiarati, chiave idempotente `event.id`,
  backoff bounded e telemetria non bloccante;
- smoke protetto per database temporanei e applicatore protetto per il database
  DEV `cassav6`.

Il worker PostgreSQL non e stato collegato agli handler o ai domini legacy.
MariaDB, SQLite relazionale e il vecchio event outbox continuano quindi a
servire il runtime attuale. Questa separazione evita di introdurre una seconda
source of truth prima dei task di cutover dei singoli domini.

## Sequenza test-first eseguita

1. documento degli invarianti scritto prima dell'implementazione;
2. suite iniziale: fallimento `ERR_MODULE_NOT_FOUND` atteso, perché repository e
   worker non esistevano;
3. implementazione dei due owner architetturali e della migration;
4. suite finale MIG-023: 32/32 test superati;
5. test runtime metrics: 15/15 superati;
6. test architetturali route: 144/144 superati;
7. gate repository: 337 file runtime, 47 handler, 64 owner persistence, zero
   violazioni;
8. gate architettura/security: zero finding bloccanti.

I test verificano anche limiti di input, nessuna transazione autonoma durante
`enqueue`, codice errore controllato, owner stale, lease scaduto, assenza di SQL
nel worker e riconsegna con chiave idempotente stabile.

## Prova reale sul Raspberry

Ambiente:

- host `raspberrypi`, `aarch64`;
- PostgreSQL `17.11 (Debian 17.11-0+deb13u1)`;
- storage `/dev/mmcblk0p2`, `ext4`, microSD;
- ruolo runtime `cassav6_app`;
- database isolato `cassav6_mig023_20260831a`, rimosso al termine.

Risultati misurati:

```text
eventi concorrenti:             12
claim worker A / worker B:      6 / 6
claim duplicati:                0
durata claim concorrente:       19,19 ms
recupero lease scaduto:         355,04 ms
attempt_count dopo recupero:    2
completamento stale rifiutato:  si
consegne dopo crash simulato:   2
side effect durevoli:           1
durata smoke totale:            484,53 ms
```

Il crash e stato simulato dopo il commit di un side effect protetto da vincolo
unico e prima di `markProcessed`. La seconda consegna ha ricevuto la stessa
chiave `mig023-idempotent-redelivery`; il consumer ha eseguito una sola volta il
side effect e l'evento e terminato con `attempt_count=2`.

La migration 002 e stata poi applicata al database DEV `cassav6`: prima
esecuzione `UP 002`, seconda esecuzione zero migration applicate e due saltate.
Il registry contiene i checksum attesi, entrambi i constraint risultano
validati e le quattro tabelle foundation sono rimaste vuote. Al termine
PostgreSQL e `cassav5bt.service` erano `active` e non restavano database o file
temporanei MIG-023.

## Evidenza e file

Implementazione principale:

```text
SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/event-outbox.repository.js
SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/migrations/002_event_outbox_lease_contract.sql
SORGENTE_SISTEMA/cassa-frontend/backend/modules/messaging/event-outbox-worker.js
SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-event-outbox.test.mjs
SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/mig023-event-outbox-smoke.mjs
```

Report machine-readable:

```text
SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig023/raspberry-dev-sd-20260831.json
SHA-256 7a60f5fb22706f3b6d0b813a4fdca5a120ac6dfe39dffdcb8a5853ea75c769ac
```

## Gate non autorizzati

La prova certifica la concorrenza funzionale dell'outbox sul PostgreSQL DEV in
microSD. Non rende l'SSD obbligatorio per lo sviluppo, non certifica lo storage
di produzione, non abilita il worker nel servizio Cassa e non autorizza alcun
cutover di dominio.
