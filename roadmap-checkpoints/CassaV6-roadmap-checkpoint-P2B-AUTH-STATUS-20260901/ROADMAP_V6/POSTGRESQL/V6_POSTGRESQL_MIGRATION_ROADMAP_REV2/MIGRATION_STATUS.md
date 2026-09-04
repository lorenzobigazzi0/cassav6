# Migration status (REV2)

Aggiornare con evidenze verificabili. Stati ammessi: `TODO`, `IN_PROGRESS`,
`BLOCKED`, `DONE`.

**Non usare percentuali stimate come sostituto dei gate.** Un task e `DONE`
quando la sua Definition of Done in `tasks/MIGRATION_TASKS.csv` e soddisfatta e
c'e un riferimento a un'evidenza (commit, test, report archiviato), non quando
"sembra fatto".

## Decisioni bloccanti

Nessuna fase oltre P2b parte con la sua decisione bloccante aperta.

| Decisione | Blocca | Stato | Evidenza |
|---|---|---|---|
| HW-01 storage e coesistenza motori | P1 | IN_PROGRESS | Eccezione DEV formalizzata in `DOCUMENTAZIONE/HW01_SD_DEVELOPMENT_DECISION_20260831.md`: sviluppo consentito su microSD; produzione e cutover restano bloccati fino alla rivalutazione sullo storage definitivo |
| SEQ-01 sequenziamento Commerciale V2 | P4 | TODO | |
| BIZ-01 business date | P5 | TODO | |
| CONC-01 ambizione cambio concorrenza | P6b | TODO | |
| CASH-01 Glory e contanti | P7 | TODO | |
| FIS-01 fiscale | P8 | TODO | |
| RET-01 retention | P11 | TODO | Control plane DEV fail-closed e proposte disabilitate; partizionamento mensile audit con ID globale applicato e verificato sul Raspberry/microSD; le finestre e l'automazione distruttiva attendono conferma |
| FMT-01 formato importi legacy | P12 | TODO | |
| ROL-01 rollback dopo cutover | P14 | TODO | |

## Fasi

| Fase | Stato | Gate superato | Evidenza |
|---|---|---|---|
| P0 Baseline e inventario | IN_PROGRESS | No | MIG-001 e MIG-003 chiuse; MIG-002 riaperta con fixture v2 non vuota e MIG-000 resta incompleta. Vedere `DOCUMENTAZIONE/P2B_PREREQUISITES_20260901.md` |
| P1 Infrastruttura PostgreSQL | IN_PROGRESS | DEV_ONLY | Driver, runner, backup/restore e PITR DEV verificati sul Raspberry; HW-01-PROD, backup su device indipendente e drill con dataset reale restano aperti; nessun cutover e autorizzato |
| P2 Foundation persistence | IN_PROGRESS | DEV_ONLY | MIG-020..MIG-025 completate; migration 006 applicata e idempotente sul Raspberry: audit partizionato con 16 partizioni, default e ID globale; 13 policy restano disabilitate e RET-01 resta aperta |
| P2b Decomposizione server.js | IN_PROGRESS | Pilot only | Slice identity inventariato e avviato: 7 route gia estratte, 4 di 7 senza accesso globale (`users.list`, `auth.changePin`, `auth.selectWorkstation`, `auth.sessionStatus`), da 7/11 a 3 `readDb` e 7 `writeDb` diretti; gate globale non superato. Vedere `DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md` |
| P3 Identity e configurazione | TODO | | |
| P4 Catalogo, menu, commerciale | TODO | | |
| P4b Coupon/voucher/benefit | TODO | | |
| P5 Sale, tavoli, sessioni, prenotazioni | TODO | | |
| P6 Ordini | TODO | | |
| P6b Modello di concorrenza | TODO | | |
| P7 Pagamenti, provider, contanti | TODO | | |
| P8 Fiscale e stampa | TODO | | |
| P9 Realtime e cache | TODO | | |
| P10 Domini secondari | TODO | | |
| P11 Report e analytics | TODO | | |
| P12 Import storico e verifica | TODO | | |
| P13 Hardening e load test | TODO | | |
| P14 Cutover | TODO | | |
| P15 Decommission | TODO | | |

## Task

| Task | Stato | Commit | Test/evidenza | Note |
|---|---|---|---|---|
| MIG-000 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p2b/baseline-known-failures-20260901.json`; `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p2b-baseline-allowlist.json` | Baseline non verde ma ora esatta e falsificabile: Cassa 72/92 con 20 rossi noti, Mobile 639/642 con 3; gate blocca nuovi rossi, failure mancanti e deriva conteggi; performance Raspberry mancante |
| MIG-001 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p0-artifacts.mjs`; `legacy-storage-inventory.csv` | 228 `readDb` runtime in 35 file, 91 `writeDb` runtime in 20 file |
| MIG-002 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p0/golden-dataset.json`; `golden-dataset.sha256`; `DOCUMENTAZIONE/P2B_PREREQUISITES_20260901.md` | Fixture v2 SHA-256 `ac184311c9c96bb8b2d02ff23f71f284afaebfca94437e6435fd501b24edfa01`: listini ereditati/overlap/overnight, 5 casi prezzo, identity/sessioni, allergeni distinti, ordine scontato, split payment e benefit parziale; resta aperta finche importer/equivalence gate la consumano |
| MIG-003 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig003/raspberry-production-20260831.json`; `DOCUMENTAZIONE/MIG003_RASPBERRY_BASELINE_20260831.md` | 61 campioni/301,4 s; Node RSS max 59.916.288 B, MariaDB 205.832.192 B, 49,4 C, throttling `0x0` |
| MIG-010 | IN_PROGRESS | workspace senza Git | `DOCUMENTAZIONE/HW01_SD_DEVELOPMENT_DECISION_20260831.md`; `DOCUMENTAZIONE/MIG010_MIG011_POSTGRESQL_DEV_SD_20260831.md` | PostgreSQL 17 DEV predisposto su microSD; `pg_test_fsync`/`fio` sullo storage definitivo e HW-01-PROD restano aperti |
| MIG-011 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-runtime.test.mjs`; `DOCUMENTAZIONE/MIG010_MIG011_POSTGRESQL_DEV_SD_20260831.md` | Driver `pg`, pool lazy opt-in, health, gauge pool e queue wait verificati; smoke Raspberry `ready` in 62,22 ms |
| MIG-012 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-migrations.test.mjs`; `DOCUMENTAZIONE/MIG012_POSTGRESQL_MIGRATION_RUNNER_20260831.md` | Runner idempotente con advisory lock, transazione, `schema_migrations` e checksum; smoke Raspberry applicato due volte, drift bloccato e rollback verificato |
| MIG-013 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig013/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG013_POSTGRESQL_BACKUP_PITR_DEV_SD_20260831.md` | Restore 21 ms e PITR 6.065 ms riguardano soltanto `temporary_mig013_probe` vuoto e non stimano la manutenzione; dataset reale, capacity gate e backup su storage indipendente restano aperti |
| MIG-020 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-foundation-migration.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig020/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG020_POSTGRESQL_FOUNDATION_20260831.md` | Migration `001_foundation` applicata e idempotente; 5 tabelle, grant least-privilege e restore post-migration verificati sul Raspberry |
| MIG-021 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-transactions.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig021/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG021_POSTGRESQL_TRANSACTION_HELPER_20260831.md` | COMMIT/ROLLBACK standardizzati; retry limitato a `40001`/`40P01`; concorrenza `SERIALIZABLE` reale con 1 retry misurato e valore finale coerente |
| MIG-022 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/repository-boundary.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig022/repository-boundary-20260831.json`; `DOCUMENTAZIONE/MIG022_REPOSITORY_BOUNDARY_20260831.md` | Contratto repository strutturale; gate universale integrato nella release; 334 file runtime e 47 handler analizzati con 0 violazioni SQL fuori dagli owner persistence |
| MIG-023 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-event-outbox.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig023/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG023_POSTGRESQL_EVENT_OUTBOX_20260831.md` | Claim concorrente reale 6+6 con 0 duplicati; lease scaduto ripreso; stale owner rifiutato; due consegne con chiave stabile hanno prodotto un solo side effect; migration 002 applicata e idempotente sul DEV |
| MIG-024 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-audit-events.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig024/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG024_POSTGRESQL_APPEND_ONLY_AUDIT_20260831.md` | Audit e business write nello stesso commit; rollback atomico reale; runtime bloccato con `42501` e owner con `55000` su update/delete/truncate; migration 003 applicata e idempotente sul DEV |
| MIG-025 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-idempotency-keys.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig025/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG025_POSTGRESQL_IDEMPOTENCY_STORE_20260831.md` | Concorrenza reale 8 chiamanti: 1 esecuzione e 7 replay identici; conflict con hash diverso senza side effect; rollback recuperabile; 0 processing orfani; migration 004 applicata e idempotente sul DEV |
| MIG-026 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig026/raspberry-dev-sd-partitioned-20260901.json`; `SORGENTE_SISTEMA/cassa-frontend/backend/db/postgresql/migrations/006_audit_events_partitioned_retention.sql`; `DOCUMENTAZIONE/MIG026_POSTGRESQL_RETENTION_CONTROL_PLANE_20260831.md` | Migration 006 applicata e idempotente sul Raspberry/microSD dopo backup+restore: relkind `p`, 16 partizioni, default e registro ID globale, 0 eventi, health 200/200; 13 policy restano disabilitate e MIG-026 resta aperta fino a RET-01 |
| P2B-ID-01 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p2b/identity-route-boundaries.csv`; `identity-pilot-baseline-20260901.json`; `DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md` | Inventario/gate identity verde: 7 route, 2 handler, P2b.2 gia presente nello slice; chiuse e verificate `users.list` (`backend/users/users-list-read-model.js`), `auth.changePin` (`backend/auth/change-pin-write-model.js`), `auth.selectWorkstation` (`backend/auth/select-workstation-write-model.js`) e `auth.sessionStatus` (`backend/auth/session-status-write-model.js`, retry serializzato e fast/fallback write invariati), da 7/11 a 3 read e 7 write globali; restano 3 route (`login`, `logout`, `users.save`); nessun cambio di comportamento o database. Test nuovi `backend/tests/auth-session-status-handler.test.mjs` 5/5; auth session 25/25, continuity 69/69, gate identity 3/3 e baseline esatta verde (`comparison.ok: true`) |

Aggiungere una riga per task man mano che vengono presi in carico. L'elenco
completo con dipendenze, rischio e Definition of Done e in
`tasks/MIGRATION_TASKS.csv`.
