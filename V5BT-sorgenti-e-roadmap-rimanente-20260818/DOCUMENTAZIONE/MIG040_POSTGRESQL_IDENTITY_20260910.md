# MIG-040 — Identity PostgreSQL, avanzamento 2026-09-10

## Stato

MIG-040 e `IN_PROGRESS`. MariaDB resta la source of truth del runtime: nessuna
lista PostgreSQL e stata attivata e nessun cutover e autorizzato.

Sono stati completati e verificati i primi anelli additivi:

- migration `010_identity_users_groups.sql`, repository e mapping canonico;
- importatore MariaDB -> PostgreSQL con riconciliazione per digest e retry
  idempotente;
- interruttore per dominio `off/shadow/primary/exclusive`, spento per default;
- store di lettura con snapshot sincrono, copie isolate, controllo di freschezza,
  latch per username duplicati e assenza di amministratori.
- innesto opzionale nello `AuthRepository`, con precedenza PostgreSQL esplicita,
  rifiuto del doppio source of truth e risposta 503 sugli snapshot non affidabili.
- composition root completo ma inerte con liste di dominio vuote;
- write-through transazionale, refresh dello snapshot dopo commit e confronto
  shadow riletto da PostgreSQL, con diagnostiche che espongono solo ID e nomi
  dei campi divergenti;
- guardie di commutazione `primary`: idratazione autorevole, esclusione dal blob
  legacy, disarmo degli scrittori puntuali incompatibili e health 503 quando
  PostgreSQL e autorevole;
- intenti distruttivi espliciti per `users.save`: sostituzione completa di utenti
  e gruppi e revoca sessioni nominata per ID, senza prune implicito per omissione.

Il limite dimensionale storico di `server.js` non e piu un gate, per decisione
del responsabile del prodotto. Restano obbligatori i confini repository, le
invarianti e le prove di cutover.

## Evidenza Raspberry DEV

Il 2026-09-10 PostgreSQL 17 e stato predisposto sul Raspberry DEV e le migration
`001`..`010` sono state applicate. L'import reale ha prodotto:

- 5 utenti e 0 gruppi sia in sorgente sia in destinazione;
- 2 amministratori;
- digest sorgente e destinazione identici;
- retry successivo con 5 record `unchanged`, 0 insert, 0 update e 0 delete.

Il report macchina e in
`SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig040/raspberry-dev-20260910.json`.
Al termine della verifica PostgreSQL e `cassav6.service` erano `active` e il
frontend rispondeva HTTP 200.

## Invarianti preservate

- Nessun PIN in chiaro, nei log o nei payload diagnostici.
- Almeno un amministratore deve restare presente.
- Username normalizzati univoci.
- Revisioni ottimistiche e prune solo con intento esplicito.
- Nessuna query nella superficie sincrona dello store.
- Configurazione PostgreSQL inerte in assenza delle tre liste di dominio.

## Prossimi anelli

1. Distribuire il nuovo runtime sul Raspberry mantenendo `identity=off` e ripetere
   la suite MIG-040 sul target ARM64.
2. Attivare un canary `identity=shadow`, verificare write-through, confronto e
   metriche senza cambiare la source of truth MariaDB.
3. Eseguire una prova controllata `primary` e il rollback a `shadow`, con backup,
   riconciliazione a zero differenze e smoke di login/salvataggio utenti.
4. Chiudere MIG-040; solo dopo potra iniziare MIG-041 sulle sessioni.

## Evidenza automatizzata locale

- suite MIG-040: 196/196;
- regressione auth, app-state e salvataggio utenti: 166/166;
- `app-meta` e health end-to-end: 6/6.
