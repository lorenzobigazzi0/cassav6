# V6 — Roadmap migrazione PostgreSQL (REV2)

Revisione del 2026-08-31 del pacchetto
`V6_POSTGRESQL_REDIS_TOTAL_MIGRATION_ROADMAP`, dopo verifica diretta sul sorgente
`V6.0.0.6`.

**Leggere prima `00_REVISIONE_20260831.md`**: elenca cosa è cambiato rispetto
alla REV1 e perché.

## Decisione architetturale

- **PostgreSQL** diventa l'unica *source of truth* persistente.
- Ogni stato non-PostgreSQL è ricostruibile: cache, presence, hint di
  coordinamento. La sua perdita totale non comporta perdita di
  ordini/pagamenti/fiscale/audit.
- **Node.js** deve diventare stateless rispetto ai dati business.
- **app_state, app_state_domain_records, split state, SQLite relazionale e
  MariaDB** sono ponti di migrazione e vanno rimossi a cutover concluso.
- Una API critica non risponde successo prima del **COMMIT PostgreSQL**.
- **Redis è fuori perimetro** in questa revisione: il profilo standard è
  monoprocesso e non esiste il problema che Redis risolve. Vedi
  `ANNEX_A_FUORI_PERIMETRO.md` A.3.

## Perimetro

| In perimetro | Fuori perimetro (progetti separati) |
|---|---|
| Identity, configurazione | Dominio ricette strutturato (A.1) |
| Product master, cataloghi, listini, offers | Motore promozioni automatiche (A.2) |
| Coupon/voucher/benefit esistenti | Redis (A.3) |
| Sale, tavoli, sessioni, prenotazioni | |
| Ordini e modello di concorrenza | |
| Pagamenti, provider, contanti | |
| Fiscale e stampa | |
| Report, import storico, cutover, decommission | |

Il criterio è uno solo: una migrazione sposta dati esistenti, non progetta
semantica di business nuova. Dove il sorgente non contiene il dominio, non c'è
niente da migrare.

## Risultati della scansione (verificati)

- file backend non-test analizzati: **365**; moduli backend: **36**;
- `readDb(` runtime/non-test: **228 occorrenze in 35 file**;
- `writeDb(` runtime/non-test: **91 occorrenze in 20 file**;
- **`backend/server.js`: 38.799 righe, 1,4 MB, con 86 `readDb` e 26 `writeDb`**;
- tabelle SQLite relational esistenti: **57**;
- top-level collections dell'app-state: **31**;
- profilo standard: **monoprocesso** (`BACKEND_API_WORKER_ENABLED=0`,
  `BACKEND_REALTIME_GATEWAY_ENABLED=0`).

### Il vincolo principale

`readDb()` non è un accessor: restituisce l'intero grafo di stato, gli handler lo
mutano in memoria e lo riscrivono. **Non esiste oggi un layer di accesso dati
sostituibile.** Per questo la fase P2b (decomposizione di `server.js`, a parità di
database) è prerequisito di ogni migrazione di dominio, non pulizia opzionale.

### Ricette

Nel sorgente non esiste un dominio `recipe`: gli articoli hanno
`ingredients`/`ingredienti` come **lista testuale**. La migrazione preserva quelle
label senza interpretarle. **Non vanno inventate quantità o unità che oggi non
esistono.**

## Ordine di lettura

0. `00_REVISIONE_20260831.md` — cosa è cambiato e perché
1. `01_SOURCE_AUDIT.md`
2. `02_TARGET_ARCHITECTURE.md`
3. `03_TOTAL_MIGRATION_ROADMAP.md` — fasi, stati terminali, stime
4. `13_HARDWARE_CAPACITY.md` — gate prima di P1
5. `14_SERVER_DECOMPOSITION.md` — fase P2b
6. `04_MENU_RECIPES_PRICING_PROMOTIONS.md`
7. `05_DATA_MODEL_AND_TRANSACTIONS.md`
8. `06_REALTIME_E_CACHE.md`
9. `15_CONCURRENCY_MODEL.md` — fase P6b
10. `07_DATA_MIGRATION_RECONCILIATION.md`
11. `08_TEST_PERFORMANCE_DURABILITY.md`
12. `09_CUTOVER_ROLLBACK.md`
13. `10_LEGACY_DECOMMISSION.md`
14. `11_CODEX_EXECUTION_GUIDE.md`
15. `16_PROGRAM_SEQUENCING.md` — collisione con Commerciale V2
16. `12_OPEN_DECISIONS.md`
17. `ANNEX_A_FUORI_PERIMETRO.md`
18. `ANNEX_B_REDIS_DESIGN_DIFFERITO.md`

## File operativi

- `tasks/MIGRATION_TASKS.csv`: backlog con dipendenze, rischio, stima e
  Definition of Done. **72 task, 305-530 giornate-uomo, 37 task non delegabili a
  esecuzione assistita.**
- `reports/domain_migration_matrix.csv`: matrice per dominio.
- `postgres/*.sql`: DDL target di riferimento.
- `postgres/060_retention_partitioning.sql`: retention e crescita (nuovo).
- `scripts/reconcile_legacy_vs_pg.mjs`: **riconciliazione legacy vs PostgreSQL**
  (nuovo, obbligatorio per il GO di cutover).
- `scripts/reconciliation_checks.sql`: invarianti interne a PostgreSQL. Non
  sostituisce il precedente.
- `scripts/scan_legacy_refs.py`: rigenera l'inventario dei riferimenti legacy.
- `scripts/check_no_legacy_runtime.sh`: gate finale contro i residui runtime.
- `config/*.example*`: configurazione target senza segreti.

## Regola di esecuzione

Niente riscrittura big-bang. Un bounded context alla volta. Ogni contesto che
passa a PostgreSQL smette **definitivamente** di scrivere su app-state. Il
dual-read/shadow è ammesso temporaneamente per verifica; il dual-write permanente
no.

## Se il programma completo non è sostenibile

`03_TOTAL_MIGRATION_ROADMAP.md` chiude con un sottoinsieme minimo consigliato:
P0, P2b, P1+P2, e un solo dominio portato end-to-end fino alla rimozione delle
scritture legacy. Dopo quel primo dominio si sa quanto costa davvero un dominio,
e le stime smettono di essere ordini di grandezza.
