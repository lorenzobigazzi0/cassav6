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

1. Cablaggio dello store nel composition root mantenendo `identity=off`.
2. Shadow-read con confronto campionato e diagnostiche prive di dati sensibili.
3. Write-through transazionale e refresh dello snapshot dopo commit riuscito.
4. Prove di primary/rollback e guardia degli scrittori legacy.
5. Chiusura MIG-040; solo dopo potra iniziare MIG-041 sulle sessioni.
