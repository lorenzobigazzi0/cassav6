# V5BT - Smoke Qualificabile 1200 Isolato - 2026-08-06

## Scopo

Eseguire il nuovo smoke ufficiale da `1200` operazioni con il profilo V5BT
completamente conservativo, dopo aver chiuso due lacune del banco:

- backend di prova vincolati a `127.0.0.1`;
- spool stampa dedicato al singolo run e rimosso dopo lo stop dei processi.

Il test usa `25` Palmari e `5` Postazioni simulate, azioni a `3000 ms`, comande
con target medio `7500 ms` e notifica batteria ogni `120000 ms`. Non usa
Bluetooth, ADB, SSH o hardware fisico.

## Preparazione E Contratti

Il backend accetta `BACKEND_PRINT_SPOOL_DIR` con default operativo invariato.
Il runner calcola internamente `runtime/print-spool` sotto la directory del
report, impedisce path esterni o symlink e rende il cleanup bloccante. Tutti i
processi backend ricevono inoltre `BACKEND_HOST=127.0.0.1`.

Verifiche prima del run:

```text
Node --check:                   PASS (4/4 file)
Contratti V5BT:                86/86 PASS
Gate architetturale backend:   143/143 PASS
Margine server.js:             705 righe, minimo 700
Host preflight enforced:       PASS, nessun override
MemAvailable iniziale:         3894661120 byte
SwapFree iniziale:             7043440640 byte
Load 1m / CPU:                 0,5325, limite 0,75
Binding live porte di prova:   solo 127.0.0.1
```

## Risultato

Run:
`v5bt_operations_25x5_smoke_1200_off_isolated_202608061541`.

Esito ufficiale: `FAIL`. Il full non e autorizzato.

```text
Azioni avviate/completate:      1200/1200
Azioni riuscite/fallite:        1194/6
P95 / max azioni:               17358 / 54134,22 ms
P95 comande:                    8167 ms
Cadenza mobile media:           3862,75 ms
Cadenza comande media:          9606,89 ms
Picco in-flight:                60/60
Comande persistite mancanti:    4, duplicati 0
Drain relazionale:              PASS
Audit auto-print owner:         PASS
Audit marker station-state OFF: PASS
Latency attribution:            COMPLETE
GUI/errori browser:             PASS
Cleanup sessioni/processi/log:  PASS
Cleanup spool per-run:          PASS
```

Le sei azioni fallite derivano da quattro creazioni/sincronizzazioni ordine
non completate, una indisponibilita del contatore ordini relazionale e un
deadlock nello spostamento sala. Le quattro comande mancanti corrispondono ai
fallimenti di creazione; non sono presenti duplicati.

## Diagnosi

Il collo di bottiglia dominante e la serializzazione MySQL su righe calde:

```text
Innodb_row_lock_waits:             450
Innodb_row_lock_time totale:       697149 ms
stationState.mysqlWrite P95:       10000 ms
stationState.route P95:            10000 ms
proxy owner round-trip P95:        10000 ms
proxy owner lane wait P95:         10000 ms
print spool workflow P95:          2500 ms
dispatch lag P95 / max:            5793 / 26046,62 ms
```

La prima finestra da 120 azioni era gia oltre soglia a P95 `3695 ms`; le
finestre 7 e 8 hanno raggiunto P95 `34844` e `26537 ms`. Le azioni piu lente
sono `waiter.pause_resume`, pagamenti, raccolta banco, gruppi tavolo e
spostamenti. Il backpressure globale ha raggiunto il limite `60`, allungando
anche le cadenze senza produrre raffiche anticipate.

Il marker station-state diagnostico resta disattivato: il suo precedente
canary non ha superato il gate e questo smoke non ne autorizza la promozione.
La prossima ipotesi deve intervenire sulla riga condivisa
`integration.lastWriteAt` e sull'ordine dei lock tra station-state, pagamenti,
ordini e spostamenti, preservando monotonicita, recovery e atomicita.

## Evidenza E Cleanup

Report interno:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_off_isolated_202608061541/report.json`.

Il report contiene `34` file attestati. Manifest:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_off_isolated_202608061541.MANIFEST.sha256`.

SHA-256 del manifest:
`b614357ca690dde05dc27ddafb2d4122460d7d1764655c3e3c4f71e323adaf93`.

Report e manifest sono sigillati con file `0400` e directory `0500`. Dopo il
sigillo sono state rimosse esclusivamente le sei tabelle MySQL del prefisso
del run. Sono stati verificati:

- zero porte e processi di prova residui;
- zero chiavi Redis del prefisso;
- spool storico invariato: `16225` file, `16112792` byte, SHA-256 aggregato
  `6cd2f283163b557bc9758ba982db1096bd6da910f74509c7d1e0fc38421a0613`;
- nessuna nuova directory Chromium residua;
- swap temporaneo disattivato e rimosso; swap permanente invariato.

## Decisione

Classificazione corrente: micro `PASS`, smoke `FAIL`, full `NOT_RUN`. Il
prossimo passo offline e un canary mirato sulla contesa di
`integration.lastWriteAt`, con test MySQL reali su monotonicita, deadlock,
recovery e lock ordering, seguito da un micro ufficiale OFF. Non ripetere lo
smoke prima che quel micro rispetti tutti i gate.

Nessuna evidenza fisica nuova: B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**
