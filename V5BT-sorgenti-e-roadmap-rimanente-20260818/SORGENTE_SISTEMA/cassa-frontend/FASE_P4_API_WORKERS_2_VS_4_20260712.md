# Fase P4 - A/B 2 contro 4 API worker

Data: 2026-07-12

## Obiettivo

Verificare se il gate P4 puo essere chiuso aumentando da due a quattro i
processi API worker, usando tutti i quattro core del Raspberry senza cambiare
durabilita, routing o protocolli applicativi.

Il profilo usa 100 palmari, 10 postazioni, 5 GUI, 100 stream SSE e 10
operazioni per device. Stampante e fiscale sono simulatori loopback; cassa
automatica e I/O hardware reali restano disabilitati.

## Runner

`run-p4-load100-raspberry.sh` accetta ora:

```text
LOADTEST_API_WORKERS=1..4
```

Il default resta `2`. Il preflight blocca valori fuori intervallo e verifica
anche le porte `5295` e `5296` prima di fermare i servizi live. Test statici e
preflight ARM: **12/12 verdi**.

## Risultati

| Metrica | 2 worker | 4 worker | Variazione |
| --- | ---: | ---: | ---: |
| Durata | 97.655 ms | 93.606 ms | -4,1% |
| HTTP p50 | 562 ms | 609 ms | +8,4% |
| HTTP p95 | 8.143 ms | 8.892 ms | +9,2% |
| HTTP p99 | 25.878 ms | 30.680 ms | +18,6% |
| HTTP p99.9 | 30.933 ms | 45.800 ms | +48,1% |
| Create p50 | 4.296 ms | 2.531 ms | -41,1% |
| Create p95 | 7.956 ms | 7.902 ms | -0,7% |
| Create p99 | 9.179 ms | 9.112 ms | -0,7% |
| SSE p50 | 279 ms | 384 ms | +37,6% |
| SSE p95 | 1.080 ms | 3.138 ms | +190,6% |
| SSE p99 | 1.440 ms | 4.958 ms | +244,3% |

Entrambi i run hanno concluso con:

- zero failure applicative;
- 100/100 stream SSE connessi;
- zero payment duplicate e fiscal duplicate;
- outbox, stampa e fiscale drenati;
- canary lock cross-worker verde.

## Pressione interna

| Metrica | 2 worker | 4 worker |
| --- | ---: | ---: |
| RSS media processi monitorati | 1.357 MB | 1.760 MB |
| Somma RSS massima | 1.699 MB | 2.233 MB |
| CPU tick/s medi aggregati | 182 | 197 |
| `orderCreateInternal:readDb` medio | 954,6 ms | 1.299,2 ms |
| Write relazionale create media | 13,9 ms | 51,4 ms |
| Errori Redis recuperati API worker | 1 | 15 |

I quattro worker distribuiscono correttamente le richieste, circa 108-113
mutazioni order lane ciascuno, e riducono il p50 create. La maggiore
concorrenza aumenta pero la contesa su MySQL/Redis e sul realtime condiviso:
il p95 create non cambia, mentre code lunghe e SSE peggiorano nettamente.

Il Raspberry non ha mostrato throttling: temperatura da 50,2 a 56,8 gradi,
mask `0x0` per tutta la prova.

## Decisione

**NO-GO per quattro API worker.**

- La produzione resta con due worker su `5283/5284`.
- Il default del runner resta `LOADTEST_API_WORKERS=2`.
- Non sono stati creati nuovi servizi systemd live.
- La possibilita 1-4 resta disponibile solo per benchmark controllati.

Il prossimo step deve ridurre le letture condivise nel path create, iniziando
dal refresh puntuale del lock del solo tavolo e dalla lettura mirata degli
stati postazione. Aumentare ancora il numero dei processi non e una soluzione.

## Evidenze

- 2 worker: `logs/loadtest-p4_auth_payment_fix_load100_r1_20260712/`
- 4 worker: `logs/loadtest-p4_apiworkers4_load100_r1_20260712/`
