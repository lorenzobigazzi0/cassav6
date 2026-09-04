# Fase P4 - CAS MySQL ibrida per table lock

Data: 2026-07-11

## Obiettivo

Separare il costo worker, pool MySQL, proxy HTTPS e LAN; ridurre i round-trip
MySQL senza indebolire la mutua esclusione tra processi.

## Profilo del confine

Canary identico: 56 tavoli, 3 round, concorrenza 50, 504 richieste
`acquire -> heartbeat -> release`.

| Percorso | Acquire p95 | Heartbeat p95 | Release p95 |
| --- | ---: | ---: | ---: |
| Client LAN -> HTTPS proxy -> worker | 398ms | 180ms | 174ms |
| Raspberry -> HTTPS proxy -> worker | 353ms | 161ms | 152ms |
| Raspberry -> worker diretto | 263ms | 160ms | 113ms |

Il worker/MySQL resta il costo principale. Il proxy aggiunge circa 90ms al p95
acquire e la LAN circa 45ms nel campione iniziale.

Con telemetria pool e limite 6:

- attesa connessione: media 35,58ms, p95 nel bucket 100ms;
- possesso connessione: media 8,92ms, p95 25ms;
- pool 12: acquire p95 420ms e hold medio 16,09ms, respinto;
- pool 8: acquire p95 298/336ms su due run, respinto;
- configurazione finale: pool 6.

## Protocollo A/B

Il protocollo originario eseguiva per ogni mutazione:

1. `GET_LOCK` nominativo;
2. transazione e `SELECT ... FOR UPDATE`;
3. write e commit;
4. `RELEASE_LOCK`.

La variante senza advisory lock e' risultata piu rapida sul traffico ordinario,
ma sotto gara cross-process su riga assente ha prodotto molti deadlock
recuperati. Il canary usa due processi distinti, porte 5285 e 5286, e pretende
esattamente un 200 e un 409 per gara.

| Profilo contesa | Gare corrette | Doppio 200 | Doppio 409 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Transazione pura | 280/280 | 0 | 0 | 603ms | 1.104ms | 1.113ms |
| Named lock completo | 280/280 | 0 | 0 | 231ms | 246ms | 257ms |

La transazione pura ha recuperato 843 retry complessivi sulle due istanze,
senza errori finali, ma la latenza di contesa la rende inadatta agli acquire.

## Soluzione finale

Protocollo ibrido:

- acquire: named lock + transazione `FOR UPDATE`;
- heartbeat: sola transazione;
- release/force-release: sola transazione;
- retry deadlock invariati, massimo 8 tentativi;
- pool dedicato confermato a 6;
- telemetria stage e contatori attiva solo sul worker lock.

Flag:

```text
BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS=1
BACKEND_MYSQL_TABLE_LOCK_HYBRID=1
```

Rollback del solo comportamento ibrido:

```text
BACKEND_MYSQL_TABLE_LOCK_HYBRID=0
```

Con il rollback tutte le mutazioni tornano al named lock completo.

## Risultato finale LAN

Confronto con il fast path richieste dello step precedente:

| Operazione | p50 prima/dopo | p95 prima/dopo | Delta p95 |
| --- | ---: | ---: | ---: |
| Acquire | 123/123ms | 398/338ms | -15,1% |
| Heartbeat | 116/87ms | 180/125ms | -30,6% |
| Release | 98/86ms | 174/132ms | -24,1% |

Confronto cumulativo con la baseline prima di fast-auth:

- acquire p95: 535ms -> 338ms, -36,8%;
- heartbeat p95: 317ms -> 125ms, -60,6%;
- release p95: 281ms -> 132ms, -53,0%.

Nel run finale completo:

- 504/504 richieste riuscite e instradate al worker dedicato;
- 336 skip advisory esatti su heartbeat/release;
- 27 retry acquire recuperati, 0 errori;
- writeDb attribuiti alle route lock: 0;
- lock test rimasti: 0;
- warning journal: 0.

## Verifiche e deploy

- test repository, e2e lock, policy e architettura: 145/145 locali;
- test ARM finali: 9/9;
- contesa reale a due processi: 280/280 gare corrette in entrambi i profili;
- `backend/server.js`: 38.798 righe `wc`, margine M5 701;
- release attiva: `/opt/cassav4/releases/20260711-p4-lock-tx-cas-035146`;
- tutti i servizi commerciali attivi; istanza canary 5286 rimossa;
- stampa, fiscale e cassa automatica reali disabilitati; carte in mock.

## Prossimo collo

L'auth sessione puntuale costa ancora circa 14-16ms medi e compete sullo
stesso pool del CAS. Il prossimo passo deve progettare invalidazione sessione
cross-process affidabile, tramite Redis o versione condivisa, prima di
introdurre una cache positiva; non va accettata una finestra in cui un token
gia disconnesso resta valido.
