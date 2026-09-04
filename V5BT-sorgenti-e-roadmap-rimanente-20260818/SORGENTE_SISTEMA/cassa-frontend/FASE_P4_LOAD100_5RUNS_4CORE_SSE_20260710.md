# Fase P4 - 5 run load100 multiprocesso, 4 core e 100 SSE

Data: 2026-07-10

## Obiettivo

Validare sul Raspberry target la topologia multiprocesso con tutti i quattro core disponibili,
100 device mobili, 10 postazioni, 5 GUI e 100 connessioni SSE reali. Le prove usano solo
stampante TCP e fiscale virtuali su loopback; cassa automatica e dispositivi reali restano esclusi.

## Profilo

- 1 owner API, 2 worker API, 1 gateway realtime e frontend proxy
- 100 palmari, 10 postazioni, 5 GUI Chromium headless
- 10 operazioni per device, 1.150 business operation per run
- 100 stream SSE concorrenti per run
- MariaDB, SQLite relazionale, Redis e outbox realtime attivi
- stampante virtuale `127.0.0.1:9109`
- fiscale virtuale `127.0.0.1:9290`
- accesso a stampante, fiscale e cassa automatica reali disabilitato

## Correzioni prima del test

- Rimossi `isolcpus=2,3`, `nohz_full=2,3` e `rcu_nocbs=2,3` dal kernel command line.
- Affinita' CASSAv4, MariaDB, Redis e Mosquitto estesa da CPU `0-1` a CPU `0-3`.
- Proxy realtime portato a oltre 100 socket concorrenti.
- Harness P4 esteso con 100 client SSE veri e audit autoritativo SQLite per outbox, stampa,
  fiscale, idempotenza e duplicati.
- Il mirror app-state del pagamento free-split puo' essere differito solo dopo il commit
  relazionale write-primary e solo per errori MySQL transient. Lo scope differito comprende
  record pagamento, ordine, tavolo e audit; gli errori permanenti continuano a propagarsi.
- Fixture E2E free-split riallineata al requisito applicativo di lock tavolo.

## Regressione

- Sintassi `backend/server.js`: OK
- Budget fisico `backend/server.js`: 38.799 / 39.500 righe
- Suite pagamenti, concorrenza, fiscale, outbox e architettura: **151/151 verdi**
- Canary 100 SSE dopo il fix: zero failure, 100/100 connessi, code completamente drenate

## Risultati richiesti

Latenza HTTP globale, in millisecondi:

| Run | Durata | P99.9 | P99 | P98 | P95 | P50 | Failure |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 94.699s | 17.557 | 15.936 | 14.434 | 12.003 | 608 | 0 |
| 2 | 94.716s | 25.062 | 14.484 | 12.070 | 10.501 | 572 | 0 |
| 3 | 103.489s | 35.215 | 30.855 | 28.624 | 15.701 | 859 | 0 |
| 4 | 92.652s | 27.632 | 18.038 | 13.387 | 9.666 | 817 | 0 |
| 5 | 87.441s | 15.310 | 13.452 | 11.861 | 10.087 | 655 | 0 |
| **Mediana** | **94.699s** | **25.062** | **15.936** | **13.387** | **10.501** | **655** | **0** |

Realtime SSE:

| Run | Connessioni | Delivery | P50 | P95 | P99 |
|---|---:|---:|---:|---:|---:|
| 1 | 100/100 | 313.510 | 238ms | 738ms | 1.360ms |
| 2 | 100/100 | 338.010 | 259ms | 908ms | 1.213ms |
| 3 | 100/100 | 338.710 | 246ms | 770ms | 1.083ms |
| 4 | 100/100 | 312.310 | 255ms | 654ms | 837ms |
| 5 | 100/100 | 310.610 | 250ms | 622ms | 974ms |
| **Mediana** | **100/100** | - | **250ms** | **738ms** | **1.083ms** |

Ordine create:

| Metrica | Mediana | Min | Max | Gate P4 |
|---|---:|---:|---:|---:|
| P50 | 6.384ms | 1.908ms | 7.028ms | - |
| P95 | 11.477ms | 6.465ms | 15.702ms | <300ms |
| P99 | 12.070ms | 7.381ms | 16.451ms | - |

## Correttezza aggregata

- 5.750 business operation e 10.494 richieste HTTP
- 500/500 connessioni SSE e 1.613.150 consegne evento
- 0 failure applicative registrate
- 2.661 job stampa virtuali confermati, 0 pending, 0 `failed_final`
- 11 emissioni fiscali virtuali `issued`, 0 pending, 0 `manual_required`
- 0 eventi outbox non pubblicati al termine di ogni run
- 0 payment idempotency key duplicate
- 0 fiscal attempt scope duplicati
- drain completato in tutte le run

## Drift

Confronto run 5 contro run 1:

| Metrica | Drift |
|---|---:|
| HTTP P50 | +7,7% |
| HTTP P95 | -16,0% |
| HTTP P98 | -17,8% |
| HTTP P99 | -15,6% |
| HTTP P99.9 | -12,8% |
| SSE P95 | -15,7% |
| SSE P99 | -28,4% |
| Durata totale | -7,7% |

Non emerge degradazione progressiva tra primo e ultimo invio. La run 3 mostra pero' una coda
lunga episodica molto piu' alta: il sistema recupera e resta coerente, ma la capacita' mantiene
una variabilita' incompatibile con il gate di latenza.

## Effetto dei quattro core

Il confronto diagnostico precedente, sullo stesso profilo senza fan-out SSE completo, passa da
`p4_percentiles_r1_20260710` (2 core) a `p4_4core_r1_20260710` (4 core):

| Metrica | 2 core | 4 core | Variazione |
|---|---:|---:|---:|
| Durata | 154.199ms | 86.478ms | -43,9% |
| P50 | 997ms | 518ms | -48,0% |
| P95 | 16.619ms | 10.466ms | -37,0% |
| P99 | 40.946ms | 14.989ms | -63,4% |

Questo confronto quantifica il beneficio CPU, ma non sostituisce le cinque run finali: il vecchio
profilo non apriva 100 stream SSE reali e conteneva ancora failure poi corrette.

## Stato gate P4

- **Correttezza multiprocesso: VERDE**
- **Sicurezza I/O reale: VERDE**
- **SSE P95 <500ms: ROSSO** (mediana 738ms, range 622-908ms)
- **order.create P95 <300ms: ROSSO** (mediana 11.477ms)
- **P4 complessivo: ROSSO per prestazioni**

La separazione owner/API worker/realtime elimina la dipendenza dal singolo event loop per tutto il
processo e mantiene lo stato coerente, ma le lane condivise e le sincronizzazioni persistence ancora
owner-bound producono code lunghe sotto il burst. Il prossimo lavoro deve ridurre o partizionare
questi percorsi condivisi; aumentare soltanto i retry non puo' chiudere il gate.

## Evidenze

- Directory: `reports/p4_final_5runs_sse100_4core_20260710/`
- Archivio: `p4_final_5runs_sse100_4core_20260710.tgz`
- SHA256: `2cb69dcc9011c0083cfb61c0f82cabe66eff5cdd09cd95ad456cbc3c77d8d47a`
- Ogni directory contiene `report.json`, `REPORT.md`, log backend/worker/realtime/frontend,
  database relazionale, seed ed eventi grezzi.
