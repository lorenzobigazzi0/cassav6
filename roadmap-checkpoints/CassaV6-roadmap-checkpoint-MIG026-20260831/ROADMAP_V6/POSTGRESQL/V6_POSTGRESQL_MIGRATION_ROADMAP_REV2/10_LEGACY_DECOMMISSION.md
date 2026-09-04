# 10 — Decommission legacy

La migrazione non è conclusa finché il runtime contiene dipendenze dal vecchio modello.

## Da eliminare

- `readDb()` runtime;
- `writeDb()` runtime;
- `/api/app-state` come meccanismo operativo;
- `app_state` e `app_state_domain_records` dal runtime;
- split repositories/state;
- hydration/dirty tracking/mirror/reconciliation legacy;
- `backend-relational.sqlite`;
- `app-state-split.sqlite`;
- `node:sqlite` lato server, salvo tool offline esplicitamente separati;
- `mysql2` runtime;
- credenziali/health/startup MariaDB;
- feature flags di shadow/write-primary non più utili.

## Sono ammessi temporaneamente

Tool di import offline in `tools/legacy-import/`, non caricati dal backend production, possono leggere MariaDB/SQLite per un periodo limitato. Devono essere marcati `legacy-only` e rimossi dalla dependency graph del server.

## Gate statico finale

`scripts/check_no_legacy_runtime.sh` deve passare. Gli unici match eventualmente permessi sono documentazione e tool offline espressamente allowlisted.

## Definition of Done

- PostgreSQL unico DB persistente server-side;
- Redis ricostruibile;
- zero dual write;
- zero global app-state;
- zero SQLite runtime;
- zero MariaDB runtime;
- tutti i report finanziari PG;
- tutti i worker durabili PG;
- restart/crash/Redis-down test verdi;
- migration e rollback docs archiviate.
