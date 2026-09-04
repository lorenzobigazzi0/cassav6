# Simulazione Operativa V5BT 25+5

## Scopo

Questo profilo verifica il carico operativo massimo dichiarato di V5BT senza
usare hardware fisico: fino a 25 Palmare Advanced e 5 Postazioni Advanced,
per un totale di 30 device simulati. Il profilo esercita API, realtime,
persistenza e interfaccia mobile con I/O esterno confinato a mock loopback.

Non e una prova Bluetooth e non produce evidenze per i gate fisici B0-B6.
Non emula BLE, ADB, Raspberry, UPS, stampanti, fiscale o cassa automatica
reali. Di conseguenza il risultato non modifica l'avanzamento ufficiale della
roadmap, che resta al 49%.

## Profili

| Modalita | Palmare | Postazioni | Azioni/device | Azioni totali | Comande/Palmare | Comande totali |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full | 25 | 5 | 200 | 6.000 | 80 | 2.000 |
| Smoke | 25 | 5 | 40 | 1.200 | 16 | 400 |
| Micro | 25 | 5 | 10 | 300 | 4 | 100 |

I limiti sono parte del contratto: il runner deve rifiutare valori superiori
a 25 Palmare o 5 Postazioni. Micro e smoke conservano la stessa cardinalita
massima e riducono soltanto il numero di azioni per device. Il micro e il
primo gate applicativo da eseguire dopo una modifica anti-tempesta; non
autorizza da solo lo smoke o il full.

## Cadenze

Ogni device avvia una nuova azione ogni 3.000 ms. Con tutti i 30 device attivi
e fasi distribuite, il carico aggregato nominale e 10 avvii al secondo. La
misura deve restare per-device: un valore aggregato corretto non puo mascherare
un device troppo rapido o rimasto inattivo.

Il contratto scheduler v2 misura gli avvii sul dispatch reale. Se backpressure
o runtime ritardano un device, il suo turno successivo parte 3.000 ms dopo
l'invio effettivo: gli slot scaduti non vengono recuperati in raffica. Latenze,
code, drift e picco in-flight restano evidenze del limite applicativo.

Lo stack isolato usa quattro worker API e un worker dedicato ai lock tavolo.
La cardinalita dei processi e fissata dal launcher e compare nel report.

Su ciascun Palmare la creazione della comanda usa due posizioni ogni ciclo di
cinque azioni. I gap tra comande alternano 9.000 ms e 6.000 ms, con media
target 7.500 ms. Il gate accetta una media osservata compresa fra 7.000 e
8.000 ms. L'ordine delle altre operazioni non deve alterare questa cadenza.

Le finestre nominali degli avvii sono circa 600 secondi per il full, 120
secondi per lo smoke e 30 secondi per il micro, oltre al tempo necessario a
completare le ultime richieste e a generare il report.

## Coordinatori Anti-Tempesta

Il Palmare usa un coordinatore realtime condiviso dai refresh della home e dei
tavoli. Mantiene un solo lavoro attivo e un solo trailing con l'ultimo evento,
deduplica payload e refresh dello stesso evento e annulla lavoro e trailing al
logout o all'unmount.

La Postazione usa un coordinatore equivalente per la sincronizzazione
completa. Una raffica produce una sola sincronizzazione attiva e al massimo
una trailing; un nuovo trigger arrivato durante la trailing resta disponibile
per il passaggio successivo. Le letture layout concorrenti sono single-flight,
mentre logout e unmount cancellano la coda e invalidano la sessione in corso.

I coordinatori riducono l'amplificazione, ma il loro solo test unitario non
qualifica il profilo. Micro, smoke e full devono dimostrare i limiti osservabili
di concorrenza, latenza e traffico GUI definiti sotto.

## Catalogo Operativo

Il catalogo mobile deve coprire almeno queste famiglie:

- creazione e sincronizzazione comande, stato pronto e consegnato;
- correzione, annullo, omaggio, storno, sostituzione bar, split riga e cambio
  prezzo;
- pagamento libero, alla romana, per articolo, contanti e POS;
- stampa comanda e preconto tramite stampanti mock;
- occupazione, prenotazione, liberazione, raggruppamento e separazione tavoli;
- spostamento tavolo e richiesta di spostamento tra sale;
- passaggio Tavoli/Banco eseguito dalla UI Playwright reale e raccolta ordine
  al banco;
- notifiche di pronto e al cameriere, pausa e ripresa cameriere;
- trasferimento forzato della comanda e ciclo richiesta/risoluzione;
- cambio sala, ricerca, layout e lettura dello stato Postazioni;
- sincronizzazione impostazioni, cronologia e batteria.

Ogni tipo richiesto deve avere almeno un tentativo riuscito nel report. Le
eccezioni non gestite, i tipi mancanti o i tipi eseguiti senza alcun successo
fanno fallire il profilo.

Tavoli e Banco sono flussi applicativi distinti: il test verifica il cambio di
vista usando i controlli reali dell'interfaccia e non inventa una API di
trasferimento tavolo-banco. Storno e altre operazioni ordinarie sono eseguite
su dati isolati creati dal test.

## Isolamento I/O

Il profilo deve avviare esclusivamente endpoint loopback e mock locali per:

- cinque stampanti;
- fiscale;
- cassa automatica;
- batteria, con una sola notifica per device ogni 120 secondi.

Gli endpoint non-loopback devono essere vietati. Nessun indirizzo di rete del
banco deve entrare nella configurazione o nel report del test. Le operazioni
fiscali distruttive di amministrazione, come annullamenti fiscali reali o
void irreversibili, sono escluse dal carico ordinario e richiedono uno
scenario esplicito separato.

## Esecuzione

Dalla directory `SORGENTE_SISTEMA/cassa-frontend`:

```bash
npm run test:v5bt:operations:dry-run
npm run test:v5bt:operations:micro
npm run test:v5bt:operations:smoke
npm run test:v5bt:operations
npm run test:v5bt:operations:readiness
```

Il dry-run verifica contratto, browser, cardinalita, cadenze, mock e percorsi
di output senza avviare la campagna. Micro, smoke e full avviano uno stack
locale isolato; non richiedono ne autorizzano accessi ADB, SSH, Bluetooth o
UPS. La sequenza obbligatoria e micro, smoke, full: non saltare un profilo
fallito o non eseguito.

Prima del full eseguire anche i test del contratto:

```bash
npm run test:v5bt:operations:contract
```

Suite contratti corrente: **59/59 PASS**. La suite della receipt e
**25/25 PASS**.

## Criteri Di Accettazione

Il profilo e PASS soltanto quando risultano contemporaneamente veri:

- esattamente 25 Palmare e 5 Postazioni inizializzati;
- esattamente 200 azioni/device nel full, 40 nello smoke o 10 nel micro;
- nessuna quota mancante e nessuna azione oltre quota;
- cadenza media di dispatch per ogni device conforme al gate dei 3 secondi;
- zero partenze reali classificate come burst anticipato
  (`earlyDispatchActionGaps=0`);
- media delle comande per Palmare compresa fra 7 e 8 secondi;
- massimo 2 richieste in-flight per singolo device e massimo 60 globali;
- P95 delle azioni non superiore a 3.000 ms, P95 delle comande non superiore a
  8.000 ms e nessuna azione oltre 30.000 ms;
- catalogo operativo completo e almeno un successo per ogni tipo richiesto;
- zero eccezioni non gestite, request failure, risposta HTTP 5xx, errore console
  e anomalia del recorder;
- per ogni GUI e per ciascuna route calda layout/ordini, massimo
  `10 + 2 * azioniPerDevice` letture: 30 nel micro, 90 nello smoke e 410 nel
  full;
- esattamente 4, 16 o 80 comande persistite per ogni Palmare rispettivamente
  nel micro, smoke o full, senza perdite o duplicati;
- i retry della stessa creazione comanda mantengono una chiave idempotente
  stabile per run, device e ordinale;
- GUI Playwright completa, incluso il passaggio Tavoli/Banco;
- I/O limitato ai mock loopback e nessun contatto con hardware fisico.

Il report deve pubblicare cardinalita, quote, distribuzione per tipo, esiti,
latenza, drift, cadenza mobile e cadenza comande. Un PASS locale qualifica il
profilo di carico applicativo, non i gate Bluetooth della roadmap.

## Stato Corrente

Il flush asincrono degli ordini viene ora inoltrato dai worker API all'owner
prima di leggere l'app-state o acquisire il lock MySQL globale. Se l'inoltro
non e disponibile resta attivo il fallback locale protetto dal lock. Inoltre
`integration.lastWriteAt` entra nella stessa transazione bulk degli ordini,
senza una seconda transazione successiva. Le quattro esclusioni incrociate
delle lane restano disattivate nel profilo, la payment lane usa concorrenza `2`
e la print lane resta vincolata a `1`. La variante print con concorrenza `2`
e intenzionalmente non promuovibile e viene rifiutata dal contratto.

Il micro autorevole
`v5bt_operations_25x5_micro_300_20260806062339_76859e7a94` chiude `PASS`:

- `300/300` azioni riuscite e zero failure;
- P95 azioni `2.572` ms e massimo `5.231,17` ms;
- P95 comande `1.792` ms;
- cadenza mobile media `3.012,58` ms e comande `7.029,77` ms;
- massimo `24/60` richieste globali in-flight e zero burst anticipati;
- `25/25` SSE, copertura e persistenza complete, zero errori GUI;
- drain relazionale e cleanup completi, senza residui outbox o mirror.

Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_20260806062339_76859e7a94/report.json`.

Lo smoke successivo
`v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e` completa
`1.200/1.200` azioni ma chiude `FAIL`: `1.199` successi e una
`order.price_override` respinta con `TABLE_LOCKED`. P95 azioni `19.559` ms,
massimo `39.122,53` ms, cadenza mobile `3.632,89` ms e cadenza comande
`8.963,27` ms superano i rispettivi limiti. Il P95 comande resta conforme a
`4.748` ms, il picco globale resta entro soglia a `53/60` e non si osservano
burst anticipati.

Il collo di bottiglia prevalente e la coda pagamenti: su 89 pagamenti il
`laneWait.completed` misura media `14.219,90` ms e massimo `31.088` ms;
`payment.free_split` raggiunge P95 `30.550` ms e massimo `34.563` ms. Il drain
finale e comunque completo, con zero residui outbox, stampa, fiscale o payment
mirror e cleanup completo. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e/report.json`.

Il diagnostico
`v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515`, eseguito con
payment concurrency `3`, e esplicitamente `NON_GATE/NON_PROMOTABLE`. Completa
`1.200/1.200` azioni con zero failure o eccezioni, esattamente 16 comande per
ciascuno dei 25 Palmari e drain e cleanup puliti. Resta pero `FAIL` sulle
soglie: cadenza mobile `3.530,34` ms, cadenza comande `8.746,91` ms, P95
azioni `14.060` ms e massimo `43.709,53` ms; il P95 comande e `PASS` a `5.432`
ms e il picco globale e `55/60`. Sulle 107 operazioni della payment lane
l'attesa media aggregata scende a circa `10.236` ms, ma il massimo sale a
`33.384` ms. La maggiore concorrenza riduce il backlog medio ma aumenta
contesa e coda estrema, quindi viene respinta come impostazione qualificabile.
Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515/report.json`.

Il retry business di `order.price_override` e fail-closed: ammette soltanto
HTTP `409` con codice esatto `TABLE_LOCKED`, per un massimo di due tentativi
totali, mantenendo invariati `logicalActionId` e `idempotencyKey`. Ogni altro
stato o codice termina subito; un secondo conflitto resta una failure. I test
dedicati e di contratto coprono classificazione stretta, limite tentativi,
identita stabile e assenza di retry sugli altri errori.

La classificazione corrente e quindi micro `PASS`, smoke `FAIL`, full
`NOT_RUN`. La readiness resta `NOT_READY`; il full non deve partire prima di
un nuovo smoke interamente verde. Questi risultati non modificano B4, B5, B6
o il 49% ufficiale.

## Preflight Pressione Host

Il preflight schema v2 legge in sola lettura `MemAvailable` e `SwapFree` da
`/proc/meminfo`, il load average a un minuto da `/proc/loadavg` e il numero di
CPU logiche. Prima di build, creazione report o avvio processi applica queste
soglie:

| Modalita | MemAvailable minima | SwapFree minima |
| --- | ---: | ---: |
| Micro | 1 GiB | 512 MiB |
| Smoke | 3 GiB | 2 GiB |
| Full | 4 GiB | 3 GiB |

In tutte le modalita il load average a un minuto diviso per le CPU logiche non
deve superare `0,75`. Il report deve attestare schema v2, stato `PASS`,
enforcement attivo e controllo scheduler verde. Il dry-run mostra un warning
ma resta non mutante. Un'esecuzione reale sotto soglia viene fermata prima di
ogni mutazione. Solo il valore esatto `LOADTEST_ALLOW_HOST_PRESSURE=1` consente
un override diagnostico, che resta attestato e non puo qualificare una
campagna. Micro e smoke autorevoli hanno superato il preflight senza override.

## Arresto E Diagnostica

In caso di quota errata, perdita di copertura, cadenza fuori soglia, eccezione,
I/O non-loopback, crescita anomala dello swap o gap di monitoraggio,
interrompere il profilo e conservare report e log locali come diagnostica non
promuovibile. Correggere la causa e avviare una nuova esecuzione; non sommare
risultati provenienti da campagne diverse.

Avanzamento roadmap complessiva: **49%**

## Contratto Diagnostico LastWrite Coalesce Del 2026-08-07

Il flag `BACKEND_STATION_STATE_LAST_WRITE_COALESCE=1` abilita soltanto un
canary `NON_GATE/NON_PROMOTABLE`; default e deploy ufficiale devono restare a
`0`. La coda deve conservare il `MAX` di `integration.lastWriteAt` e dei
timestamp station-state anche con enqueue fuori ordine o durante un flush,
reinserire il massimo dopo errore, eseguire recovery monotono all'avvio e
drenare prima della chiusura. Timestamp invalidi o futuri devono fallire
closed. Presenza, login/logout e notifiche non devono attraversare la coda.

Il report deve esporre almeno `enqueued`, `coalesced`, `covered`, `batches`,
`flushed`, `retries`, `errors`, `invalid`, `future`, `clockRegression`,
`recoveryWrites`, `recoveryNoops`, `pending`, `running` e `oldestAgeMs`.
L'audit schema `1` e PASS solo con contabilita coerente, marker persistito non
inferiore al massimo station-state e zero residui a fine run. In OFF tutte le
metriche della coda devono restare a zero.

Il confronto del 7 agosto respinge ON: OFF `300/300`, P95 azioni/comande
`5853/3652` ms, `135` lock wait per `74012` ms; ON `300/300`, P95
azioni/comande `9323/8448` ms, coda `91/91`, `71` coalesced in `20` batch e
`124` lock wait per `120055` ms. Non eseguire lo smoke da `1200`. Il prossimo
esperimento ammesso e `NOWAIT` fail-fast con reschedule esplicito, misurato
con sequenza A/B/A.

Verifica disponibile: focused `172/172 PASS`, contratti `100/100 PASS`, gate
`7/7 PASS`; full suite backend, rerun isolato: `1906/1906 PASS`. La prima
esecuzione aveva chiuso `1905/1906` con un solo errore non riprodotto. Nessun
hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`; roadmap **49%**.

## Contratto LastWrite NOWAIT A/B/A Del 2026-08-07

Con il canary attivo, i flush ordinari di `integration.lastWriteAt` devono
richiedere `FOR UPDATE NOWAIT`; la recovery iniziale deve mantenere il lock
bloccante. MySQL `3572/ER_LOCK_NOWAIT` e MariaDB
`1205/ER_LOCK_WAIT_TIMEOUT` devono essere contabilizzati come contention
deferral, reinseriti con retry/backoff e fusi conservando il `MAX`. Il gate
lastWrite schema `2` deve attestare `flushLockMode=NOWAIT`, uguaglianza tra
enqueue e flush, retry uguali a deferral piu errori, zero errori e zero
residui.

L'attestazione con MySQL reale deve trattenere la riga marker da una seconda
connessione: il flush `NOWAIT` deve fallire rapidamente e rollbackare, poi
riuscire dopo il rilascio senza regressione; la recovery deve restare pendente
fino al rilascio e persistere il `MAX`. Il confronto deve accettare sia JSON
quotato sia lo scalare gia decodificato dal driver MySQL. Quest'ultimo caso ha
esposto e fatto correggere un difetto che poteva permettere la regressione di
`lastWriteAt`.

Il deadlock di bootstrap e stato riprodotto anche nello stress combinato. Il
trace InnoDB lo ha localizzato sul marker, tra chiave `PRIMARY` e gap degli
indici. La correzione separa l'upsert marker e applica il mutex marker solo
alle entry nuove; gli heartbeat su entry esistenti restano paralleli. I test
MySQL reali usano un marker preesistente con `16` coppie concorrenti, `25` ID
nuovi e lo stesso ID con conservazione del `MAX`. `INVOCATION_ID` e
`JOURNAL_STREAM` sono isolati nel processo di test.

Verifica: focused `248/248 PASS`, contratti `103/103 PASS`, stress combinato
per `10` giri `50/50 PASS`, blocco ambiente `23/23 PASS` e full suite finale
`1918/1918 PASS`.

| Segmento | Azioni | P95 azioni | P95 comande | Lock wait | Tempo lock | Esito |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A1 OFF | 300/300 | 3212 ms | 2247 ms | 115 | 30233 ms | FAIL |
| B NOWAIT | 300/300 | 3490 ms | 2165 ms | 104 | 15738 ms | FAIL |
| A2 OFF | 300/300 | 2831 ms | 2521 ms | 112 | 27851 ms | PASS |

A1 fallisce sul P95 azioni e registra anche un GUI 5xx. B supera il gate
lastWrite con `86` enqueue, `60` coalescenze, `24` batch, `6/6` deferral e
zero errori, ma fallisce il P95 azioni. Contro il midpoint A, B misura P95
azioni `+468,5 ms/+15,51%`, P95 comande `-219 ms/-9,19%` e tempo lock
`-45,81%`.

Verdetto `REJECTED_ACTION_P95`. Il flag operativo resta OFF; lo smoke da
`1200` non e autorizzato. Manifest A1
`7684907648ca561099d4ab96bda8724658a97e747e4d461ecf046f7f1e85e526`, B
`148d3c3d33d39117f2517df780d0c7968159661bea217f961a00297242df915d`, A2
`dc69dd51149db7b4fac9d0bc376ec6ed38ec80032c97bcb95bba20aaa3948b58`;
aggregato
`ed0fe6f771ad4250d6514deb9ccf6a7db385a4ff462de63020bba1b92f579742`.
Bundle: `SORGENTE_SISTEMA/logs/v5bt-lastwrite-nowait-aba-20260807`.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`; roadmap
**49%**.
