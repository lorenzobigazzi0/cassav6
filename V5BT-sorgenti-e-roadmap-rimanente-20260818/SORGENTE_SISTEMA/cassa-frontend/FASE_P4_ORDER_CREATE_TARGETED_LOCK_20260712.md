# Fase P4 - Refresh lock puntuale in orders/create

Data: 2026-07-12

## Obiettivo

Sostituire, nel solo percorso `POST /api/integration/orders/create`, la lettura
di tutti i lock tavolo con il lookup MySQL del solo `tableId` richiesto. Gli
ordini banco non eseguono il refresh lock quando il flag e attivo.

La modifica e protetta da:

```text
BACKEND_ORDER_CREATE_TARGETED_LOCK_REFRESH=1
```

Default backend e runner: `0`. Rollback immediato: lasciare il flag assente o
impostarlo a `0`.

## Implementazione

- `orders/create` estrae `tableId` prima di `readDb`.
- Con flag ON passa `refreshExternalizedTableLockId` e usa `getLock(tableId)`.
- Con flag OFF conserva il refresh completo precedente.
- Il refresh stati postazione resta invariato: il repository non dispone
  ancora di un indice per categoria/stazione adatto a un lookup puntuale.
- Il report loadtest registra lo stato effettivo del flag.

## Test

- Architettura e budget `server.js`: **131/131 verdi**.
- Flussi lock, ordine, pagamenti e invarianti con flag ON: **24/24 verdi**.
- `server.js`: 38.799 righe fisiche, margine M5 conservato.

## Canary 50 device

| Metrica | Baseline full-lock | Target lock | Variazione |
| --- | ---: | ---: | ---: |
| Create p50 | 609 ms | 591 ms | -3,0% |
| Create p95 | 1.559 ms | 1.266 ms | -18,8% |
| SSE p95 | 709 ms | 441 ms | -37,8% |
| HTTP p95 | 1.192 ms | 1.017 ms | -14,7% |

Risultato funzionale: zero failure, 59/59 create, 50/50 SSE, 63 hit lock
target, zero miss e tutte le code drenate.

## Due load100 consecutivi

| Metrica | Baseline | Run 1 | Run 2 | Mediana target |
| --- | ---: | ---: | ---: | ---: |
| Durata | 97.655 ms | 98.187 ms | 91.143 ms | 94.665 ms |
| HTTP p50 | 562 ms | 401 ms | 400 ms | 401 ms |
| HTTP p95 | 8.143 ms | 9.910 ms | 7.998 ms | 8.954 ms |
| HTTP p99 | 25.878 ms | 15.321 ms | 20.518 ms | 17.920 ms |
| Create p50 | 4.296 ms | 4.486 ms | 4.332 ms | 4.409 ms |
| Create p95 | 7.956 ms | 11.512 ms | 8.941 ms | 10.227 ms |
| SSE p95 | 1.080 ms | 939 ms | 1.085 ms | 1.012 ms |
| Query MySQL | 24.957 | 14.560 | 20.665 | 17.613 |

Correttezza aggregata:

- zero failure nei due run;
- 494/494 refresh lock target assegnati, zero miss;
- 100/100 SSE connessi in entrambi;
- zero payment duplicate e fiscal duplicate;
- outbox, stampa e fiscale completamente drenati;
- canary lock cross-worker verde.

## Decisione

**NO-GO prestazionale.**

Il lookup puntuale riduce traffico e volume query, e il canary leggero
migliora. Sotto load100 non riduce pero il numero di round trip e non migliora
in modo stabile il tempo del `readDb`; la mediana create p95 peggiora del
28,5% rispetto al baseline immediato. Il flag resta nel codice per diagnosi,
ma non viene promosso nella configurazione live e il runner torna default OFF.

Il prossimo A/B deve parallelizzare, sotto flag, i due refresh indipendenti di
lock tavolo e stati postazione dopo la lettura app-state. Va aggiunta
telemetria create-specifica per separare i due round trip; aumentare worker o
filtrare soltanto le righe senza ridurre i round trip non e sufficiente.

## Evidenze

- Baseline 50: `logs/loadtest-p4_auth_payment_fix_canary50_20260712/`
- Canary 50: `logs/loadtest-p4_targeted_lock_canary50_20260712/`
- Baseline 100: `logs/loadtest-p4_auth_payment_fix_load100_r1_20260712/`
- Target run 1: `logs/loadtest-p4_targeted_lock_load100_r1_20260712/`
- Target run 2: `logs/loadtest-p4_targeted_lock_load100_r2_20260712/`
