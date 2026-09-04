# Fase 0 Baseline Realtime - CASSAv4

Data: 2026-06-30
Sorgente: `estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`

## Scopo

Seguire la Fase 0 della roadmap `ROADMAP_REALTIME_CASSAV4.md`: misurare il sistema prima di toccare l'architettura, con runtime metrics su code, read/write DB, byte serializzati e latenze operative.

## Strumentazione Attivata

- Endpoint admin runtime metrics: `GET /api/monitor/runtime-metrics`
- Reset metriche: `POST /api/monitor/runtime-metrics/reset`
- Metriche raccolte:
  - profondita e campioni recenti `dbMutationQueue` / `orderLane`
  - wait/run per label
  - `readDb` e `writeDb` per richiesta
  - byte comparabili/persistiti per `writeDb`
  - durata `readDb` / `writeDb`
- Report automatici aggiornati:
  - `cassa-frontend/scripts/loadtest-full-capacity.mjs`
  - `cassa-frontend/scripts/endurance-sim-50k.mjs`

## Correzioni Harness Prima Della Baseline

- Il loadtest ora usa Playwright dalla dipendenza locale `mobile-frontend/node_modules/playwright` se il package non e disponibile nel frontend cassa.
- Le operazioni protette da lock tavolo non proseguono piu se `lock.acquire` non torna `200`.
- Prima di pagamento/rettifica/reso il runner rinfresca la comanda con cache-buster, per evitare pagamenti su tavolo vecchio dopo uno spostamento.
- Reso/rettifica selezionano solo righe attive, evitando righe gia rese/stornate.

## Baseline Loadtest

Parametri comuni: stampa disabilitata/simulata, RT fiscale non usato (`LOADTEST_FISCAL_SAMPLE_LIMIT=0`), runtime metrics abilitate.

| Run | Palmari | Postazioni | GUI | Durata | Business ops | HTTP | Failure | Ordine p95 | Pagamento p95 | Lock p95 | Station heartbeat p95 | Table move p95 | writeComparable p95 | DB written |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline10_2026063001` | 10 | 3 | 0 | 35s | 104 | 346 | 0 | 804ms | 1220ms | 387ms | 21461ms | 6331ms | <=4194304B | 33.61MB |
| `baseline25_2026063002` | 25 | 5 | 0 | 61s | 240 | 658 | 0 | 2159ms | 3547ms | 667ms | 42483ms | 18023ms | <=4194304B | 53.09MB |
| `baseline50_2026063002` | 50 | 10 | 0 | 137s | 480 | 1145 | 0 | 7152ms | 15571ms | 928ms | 111738ms | 48604ms | <=4194304B | 106.73MB |
| `baseline100_2026063002` | 100 | 10 | 5 | 376s | 920 | 2000 | 2 | 23611ms | 46653ms | 3213ms | 42160ms | 116805ms | <=16777216B | 287.64MB |

Report:

- `logs/loadtest-baseline10_2026063001/REPORT.md`
- `logs/loadtest-baseline25_2026063002/REPORT.md`
- `logs/loadtest-baseline50_2026063002/REPORT.md`
- `logs/loadtest-baseline100_2026063002/REPORT.md`

## Baseline Endurance Breve

Run: `endurance-50k-20260630094750`

Parametri: 500 azioni, 20 device mobili, 10 postazioni, 10 radio WS, concorrenza 20 con headroom critico 4.

- Esito invarianti: OK
- Finding: 0
- Warning: 0
- Durata: 133s
- HTTP: 1125
- Ordine create p95: 6804.1ms
- Pagamento p95: 12442.8ms
- Radio frames TX: 4504
- Radio busy responses: 23
- Riconnessioni: 3
- `readDb` / `writeDb`: 2001 / 439
- `writeComparableBytes` p95: <=4194304B
- `writeDb run` p95: <=1000ms

Report:

- `cassa-frontend/logs/endurance-50k-20260630094750/REPORT.md`

## Finding Fase 0

1. La write amplification e confermata.
   - A 10/25/50 palmari il p95 dei byte comparabili per scrittura e gia nel bucket `<=4MB`.
   - A 100 palmari arriva al bucket `<=16MB`.
   - Questo corrisponde alla causa radice descritta dalla Fase A: il path caldo serializza ancora porzioni enormi dello stato per operazioni piccole.

2. La coda globale e il collo di bottiglia primario.
   - A 50 palmari `dbMutation wait` per pagamenti/postazioni e gia `>10000ms`.
   - A 100 palmari anche `orderLane create wait` e `>10000ms`.
   - Il backend isolato e rimasto vicino al 100% CPU durante il drenaggio del run 100.

3. Le latenze percepite superano largamente i target finali.
   - Target finale ordine corto p95: <300ms; baseline 100: 23611ms.
   - Target finale pagamento p95: <400ms; baseline 100: 46653ms.
   - Target finale lock p95: <120ms; baseline 100: 3213ms.

4. Sotto pieno carico rimangono problemi postazioni/realtime.
   - Run 100: 11 log `no_eligible_active_station`.
   - Run 100: 2 failure `station.heartbeat` con `fetch failed`.
   - Questi sintomi sono coerenti con saturazione/coda: le postazioni risultano non eleggibili o non aggiornate in tempo utile.

5. Endurance breve coerente ma non ancora sufficiente come tenuta finale.
   - Invarianti OK, radio e riconnessioni OK nel run breve.
   - Anche in endurance breve il pagamento p95 resta oltre 12s.
   - Serve un endurance lungo dopo Fase A/C/D, non prima, per misurare il delta reale.

## STOP/REVIEW

Fase 0 completata per strumentazione e baseline progressiva.

Non conviene procedere con fix cosmetici o tuning superficiali: i numeri indicano che il prossimo passo corretto e la Fase A, cioe ridurre la write amplification nel repository app-state, dietro feature flag `APP_STATE_DIRTY_TRACKING=1`.

Prima della Fase A, review consigliata:

- accettare questi report come baseline ufficiale;
- mantenere `baseline100_2026063002` come riferimento 100 palmari;
- trattare `no_eligible_active_station` e `station.heartbeat fetch failed` come finding da rivalidare dopo A/C/D, non come singoli bug isolati;
- usare `writeComparableBytes p95` e `dbMutation wait p95` come metriche principali di successo della Fase A.
