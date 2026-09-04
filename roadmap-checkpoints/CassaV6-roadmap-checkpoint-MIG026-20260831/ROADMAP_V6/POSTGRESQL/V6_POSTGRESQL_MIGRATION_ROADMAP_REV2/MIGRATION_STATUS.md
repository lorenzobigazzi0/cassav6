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
| RET-01 retention | P11 | TODO | Control plane DEV fail-closed e proposte disabilitate in `DOCUMENTAZIONE/MIG026_POSTGRESQL_RETENTION_CONTROL_PLANE_20260831.md`; finestre e partizionamento attendono conferma |
| FMT-01 formato importi legacy | P12 | TODO | |
| ROL-01 rollback dopo cutover | P14 | TODO | |

## Fasi

| Fase | Stato | Gate superato | Evidenza |
|---|---|---|---|
| P0 Baseline e inventario | IN_PROGRESS | No | MIG-001, MIG-002 e MIG-003 chiuse; MIG-000 resta incompleta. Vedere `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p0/TEST_BASELINE_20260831.md` |
| P1 Infrastruttura PostgreSQL | IN_PROGRESS | DEV_ONLY | Driver, runner, backup/restore e PITR DEV verificati sul Raspberry; HW-01-PROD, backup su device indipendente e drill con dataset reale restano aperti; nessun cutover e autorizzato |
| P2 Foundation persistence | IN_PROGRESS | No | MIG-020..MIG-025 completate; control plane MIG-026 applicato con 13 policy disabilitate e viste attive, ma RET-01 e partizionamento restano aperti |
| P2b Decomposizione server.js | TODO | | |
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
| MIG-000 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p0/TEST_BASELINE_20260831.md` | Check principali verdi; suite Cassa 72/92 e Mobile 639/642, performance Raspberry mancante |
| MIG-001 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p0-artifacts.mjs`; `legacy-storage-inventory.csv` | 228 `readDb` runtime in 35 file, 91 `writeDb` runtime in 20 file |
| MIG-002 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p0/golden-dataset.json`; `golden-dataset.sha256` | SHA-256 `36f9a1f627664926439e0dba94fdb4b6e46293c8e6d05d1e63d42d12ed176180` |
| MIG-003 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig003/raspberry-production-20260831.json`; `DOCUMENTAZIONE/MIG003_RASPBERRY_BASELINE_20260831.md` | 61 campioni/301,4 s; Node RSS max 59.916.288 B, MariaDB 205.832.192 B, 49,4 C, throttling `0x0` |
| MIG-010 | IN_PROGRESS | workspace senza Git | `DOCUMENTAZIONE/HW01_SD_DEVELOPMENT_DECISION_20260831.md`; `DOCUMENTAZIONE/MIG010_MIG011_POSTGRESQL_DEV_SD_20260831.md` | PostgreSQL 17 DEV predisposto su microSD; `pg_test_fsync`/`fio` sullo storage definitivo e HW-01-PROD restano aperti |
| MIG-011 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-runtime.test.mjs`; `DOCUMENTAZIONE/MIG010_MIG011_POSTGRESQL_DEV_SD_20260831.md` | Driver `pg`, pool lazy opt-in, health, gauge pool e queue wait verificati; smoke Raspberry `ready` in 62,22 ms |
| MIG-012 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-migrations.test.mjs`; `DOCUMENTAZIONE/MIG012_POSTGRESQL_MIGRATION_RUNNER_20260831.md` | Runner idempotente con advisory lock, transazione, `schema_migrations` e checksum; smoke Raspberry applicato due volte, drift bloccato e rollback verificato |
| MIG-013 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig013/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG013_POSTGRESQL_BACKUP_PITR_DEV_SD_20260831.md` | Implementazione DEV completa: restore logico 21 ms e PITR 6.065 ms su hardware reale; certificazione con dataset reale e backup su storage indipendente ancora aperta |
| MIG-020 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-foundation-migration.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig020/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG020_POSTGRESQL_FOUNDATION_20260831.md` | Migration `001_foundation` applicata e idempotente; 5 tabelle, grant least-privilege e restore post-migration verificati sul Raspberry |
| MIG-021 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-transactions.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig021/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG021_POSTGRESQL_TRANSACTION_HELPER_20260831.md` | COMMIT/ROLLBACK standardizzati; retry limitato a `40001`/`40P01`; concorrenza `SERIALIZABLE` reale con 1 retry misurato e valore finale coerente |
| MIG-022 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/repository-boundary.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig022/repository-boundary-20260831.json`; `DOCUMENTAZIONE/MIG022_REPOSITORY_BOUNDARY_20260831.md` | Contratto repository strutturale; gate universale integrato nella release; 334 file runtime e 47 handler analizzati con 0 violazioni SQL fuori dagli owner persistence |
| MIG-023 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-event-outbox.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig023/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG023_POSTGRESQL_EVENT_OUTBOX_20260831.md` | Claim concorrente reale 6+6 con 0 duplicati; lease scaduto ripreso; stale owner rifiutato; due consegne con chiave stabile hanno prodotto un solo side effect; migration 002 applicata e idempotente sul DEV |
| MIG-024 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-audit-events.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig024/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG024_POSTGRESQL_APPEND_ONLY_AUDIT_20260831.md` | Audit e business write nello stesso commit; rollback atomico reale; runtime bloccato con `42501` e owner con `55000` su update/delete/truncate; migration 003 applicata e idempotente sul DEV |
| MIG-025 | DONE | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-idempotency-keys.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig025/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG025_POSTGRESQL_IDEMPOTENCY_STORE_20260831.md` | Concorrenza reale 8 chiamanti: 1 esecuzione e 7 replay identici; conflict con hash diverso senza side effect; rollback recuperabile; 0 processing orfani; migration 004 applicata e idempotente sul DEV |
| MIG-026 | IN_PROGRESS | workspace senza Git | `SORGENTE_SISTEMA/cassa-frontend/backend/tests/postgresql-retention.test.mjs`; `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig026/raspberry-dev-sd-20260831.json`; `DOCUMENTAZIONE/MIG026_POSTGRESQL_RETENTION_CONTROL_PLANE_20260831.md` | Control plane DEV applicato e idempotente: 13 policy, 0 abilitate, 5 protette; viste crescita/candidati attive; purge owner-only verificate in temp; RET-01 e strategia partizioni ancora da approvare |

Aggiungere una riga per task man mano che vengono presi in carico. L'elenco
completo con dipendenze, rischio e Definition of Done e in
`tasks/MIGRATION_TASKS.csv`.
