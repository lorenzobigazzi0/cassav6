# MIG-025 - idempotency store PostgreSQL

Data: 2026-08-31

## Obiettivo e source of truth

La foundation MIG-020 contiene `messaging.idempotency_keys`, ma prima di
MIG-025 la tabella non possiede un repository PostgreSQL, una macchina a stati
vincolata dallo schema o una primitiva applicativa per il replay deterministico.
Le implementazioni SQLite e app-state correnti restano invariate e autorevoli
per i percorsi runtime gia attivi.

MIG-025 introduce una primitiva PostgreSQL DEV riusabile dai futuri cutover di
dominio. Nessuna route viene commutata in questo task.

## Confine architetturale

- `backend/db/postgresql/idempotency-keys.repository.js` e l'unico owner SQL;
- il repository riceve sempre il client transazionale del chiamante per
  `begin` e `finish`;
- `backend/modules/messaging/postgresql-idempotency.service.js` orchestra il
  transaction helper MIG-021, la mutazione business e la risposta terminale;
- la callback applicativa puo contenere soltanto lavoro database: rete,
  provider, hardware e altri I/O esterni restano fuori dalla transazione;
- request payload e header non vengono persistiti: viene conservato soltanto
  uno SHA-256 canonico.

## Macchina a stati e invarianti progettate prima del codice

```text
assente --begin--> processing --finish--> completed
                              `---------> failed

completed/failed --stessa richiesta--> replay immutabile
completed/failed --hash differente----> conflict
```

1. La chiave logica e `(scope, key)` ed e protetta dalla primary key esistente.
2. Stesso scope, stessa key e stesso request hash restituiscono esattamente
   status, response code e response JSON gia persistiti.
3. Stessa chiave con hash diverso non esegue la callback e produce `conflict`.
4. Scope diversi possono riusare la stessa key senza collisione.
5. `processing` e solo uno stato interno alla transazione: un constraint trigger
   deferred impedisce di committarlo.
6. Crash o errore prima di `finish` annullano insieme business write e claim;
   un retry puo quindi acquisire la chiave senza stale lease.
7. Le sole transizioni valide sono `processing -> completed|failed`; gli stati
   terminali e i loro payload sono immutabili.
8. `created_at`, `completed_at` ed `expires_at` derivano dal clock PostgreSQL;
   il chiamante fornisce soltanto un TTL bounded.
9. La scadenza e un hint per la futura retention MIG-026, non autorizza il
   riuso o la cancellazione silenziosa della chiave.
10. Scope, key, hash, TTL, response code e response JSON sono validati e
    bounded prima dell'I/O.
11. Il ruolo runtime mantiene `SELECT`, `INSERT`, `UPDATE`, ma non ottiene
    `DELETE` o `TRUNCATE`; i trigger rendono l'UPDATE utilizzabile soltanto per
    la transizione terminale.
12. Il servizio restituisce `executed`, `replayed` o `conflict` in modo
    esplicito; non trasforma errori transazionali ambigui in un falso replay.

## Strategia test-first

1. contratto, hashing canonico e validazione input;
2. claim atomico `INSERT ... ON CONFLICT DO NOTHING` e lettura bloccante;
3. replay e conflitto senza riesecuzione della callback;
4. completamento owner della stessa transazione e rollback su errore;
5. vincoli e trigger statici della migration;
6. concorrenza reale multi-connessione su database temporaneo Raspberry;
7. applicazione idempotente della migration al database DEV `cassav6`.

La verifica e limitata al DEV su microSD. Non richiede SSD, dati reali o
cutover produzione.

## Implementazione

- aggiunto il repository PostgreSQL con `begin`, `finish` e `get`;
- aggiunto hashing SHA-256 canonico con JSON bounded a 1 MiB;
- aggiunto il servizio applicativo che orchestra claim, business write e
  risposta terminale attraverso il transaction helper MIG-021;
- aggiunta la migration `004_idempotency_store_contract` con vincoli di
  formato/coerenza, `completed_at`, trigger di transizione e constraint trigger
  deferred contro i claim incompleti;
- aggiunti smoke concorrente, wrapper DEV microSD e verifica post-condizioni.

La fase rossa test-first ha prodotto 0 test superati su 10. Dopo
l'implementazione la suite mirata e passata 10/10 e la suite completa MIG-025
33/33.

## Verifica reale Raspberry/microSD

Lo smoke e stato eseguito su Raspberry `aarch64`, PostgreSQL 17.11 e filesystem
`ext4` sul device `/dev/mmcblk0p2`, usando il database temporaneo
`cassav6_mig025_20260831a`:

- 8 chiamanti concorrenti sulla stessa coppia `(scope, key)` hanno prodotto 1
  sola esecuzione business e 7 replay;
- tutte le 8 risposte avevano code e JSON identici; durata concorrente 102,67
  ms;
- stesso scope/key con hash diverso: `conflict` e 0 callback business;
- stessa key in scope diverso: nuova esecuzione consentita;
- errore dopo la business write: 0 righe business e 0 claim; il retry successivo
  ha acquisito ed eseguito la chiave;
- esito terminale `failed` con HTTP 422 rigiocato senza seconda esecuzione;
- commit di `processing` rifiutato con SQLSTATE `55000` e 0 record orfani;
- modifica di un terminale rifiutata con `55000` sia al runtime sia all'owner;
- `DELETE` e `TRUNCATE` runtime rifiutati con `42501`; hash non valido rifiutato
  con `23514`;
- conteggio finale temporaneo: 3 business row, 4 chiavi terminali e 0
  `processing`.

Il primo tentativo di smoke aveva evidenziato un errore nel solo harness: la
riga owner usata per testare l'immutabilita non veniva rimossa prima del
conteggio. Il database temporaneo era stato eliminato dal trap; il wrapper e
stato corretto e l'intero smoke e stato ripetuto con esito verde.

## Applicazione al database DEV

La migration `004` e stata applicata a `cassav6` una volta e saltata alla
seconda esecuzione. Checksum registry:

`c66c1804dff7ecd3abcbeed01845194688f386f93ce4e6bb9a0e12c7978ef2de`

Tutti gli otto vincoli risultano validati, i trigger
`idempotency_keys_enforce_transition` e
`idempotency_keys_require_terminal` sono abilitati, `request_hash` ed
`expires_at` sono `NOT NULL`, la matrice privilegi e
`SELECT/INSERT/UPDATE=true`, `DELETE/TRUNCATE=false`. Le quattro tabelle
foundation sono rimaste vuote e i servizi PostgreSQL/Cassa attivi.

Gate finali locali:

- suite MIG-025: 33/33;
- policy route: 144/144;
- repository boundary: 340 file runtime, 47 handler, 66 owner persistence e 0
  violazioni;
- audit architettura/sicurezza: 0 finding bloccanti;
- gate architettura/sicurezza, check backend e preflight sorgente: superati.

I nove warning sul monolite `backend/server.js` restano debito architetturale
gia noto e non sono stati aumentati da MIG-025.

Evidenza machine-readable:

- `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig025/raspberry-dev-sd-20260831.json`;
- SHA-256 `83172a81f0a71d17d3318e678bdad48d01b89d0666e9fc1040edfbfb102c1149`.

## Decisione

MIG-025 e `DONE` in ambito DEV. Il replay deterministico e protetto sia dal
servizio applicativo sia dalla macchina a stati PostgreSQL. Le route legacy
restano sulla source of truth corrente: ogni futuro dominio dovra integrare la
primitiva insieme alla propria business write, non come scrittura separata.
MIG-026 dovra definire retention/cancellazione delle chiavi scadute con un
percorso owner esplicito. SSD e cutover produzione restano fuori ambito.
