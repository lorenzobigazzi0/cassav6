# V5BT B6-B11 - Software Closure Non-Gate

Data: 2026-08-18, Europe/Rome.

## Classificazione

```text
scope: B6-B11 SOFTWARE BASELINE
evidenceClass: NON_GATE_EVIDENCE
softwareVerdict: PASS_OFFLINE
gateImpact: NONE
physicalRadioEvidence: false
productionActivationAuthorized: false
businessBleTransportAuthorized: false
officialRoadmapProgress: 49
```

Il rapporto registra il verdetto **SOFTWARE PASS OFFLINE / NON-GATE**. La
matrice finale non lascia blocker nel core transport/software coperto. Non e
la chiusura dell'intera roadmap o del carico applicativo, non e un report di
gate fisico, non sostituisce le evidenze B0-B5 e non autorizza la promozione
automatica di B6-B11.

## Stato Ufficiale Invariato

| Gate | Stato | Contatore autorevole |
| --- | --- | ---: |
| B4 | `PENDING` | `2/10` hardware fisici |
| B5 | `PENDING` | `0/100` sessioni ufficiali |
| B6 | `PENDING/BLOCKED` | nessuna sessione fisica certificata |
| B7-B11 | software `NON_GATE_PASS`, fisico `PENDING` | nessuna promozione fisica |

B6 resta bloccata dai prerequisiti precedenti anche quando tutte le sue suite
software sono verdi. B7-B11 non ricevono un PASS formale per effetto di questo
rapporto. Avanzamento roadmap complessiva: **49%**.

## Matrice Di Implementazione

| Fase | Baseline software | Protezione fail-closed | Evidenza fisica |
| --- | --- | --- | --- |
| B6 | role election comune, arbitration, trust directory e A2 Android-Android | nessun downgrade A1, sessione negata senza directory/firma/alias validi | `NOT_RUN` formale |
| B7 | frame v1, AES-256-GCM, fragment/reassembly, ACK, retry, dedup, TTL | frame o transcript non canonico rifiutato, cleanup chiavi e code | `NOT_RUN` formale |
| B8 | SQLite schema 3, outbox/inbox legati al peer, history e route sequence | nessun restore cross-peer; migrazione ambigua rifiutata | `NOT_RUN` formale |
| B9 | health dinamico, publisher/sequence/ingress/store/cadence e advertiser BlueZ | stale/regressioni/replay rifiutati; route assente forza `NONE`; batteria/UPS Raspberry `UNKNOWN` | `NOT_RUN` formale |
| B10 | bus `HEALTH/PING/TEST` e shadow adapter | frame business rifiutati; trasporto business sempre LAN | `NOT_RUN` formale |
| B11 | harness massimo deterministico | profilo ridotto non puo dichiararsi soak richiesto; digest ricalcolato | solo `NON_GATE_PASS` sintetico |

## Tratti Verificati End-To-End Nel Software

Per "end-to-end software" si intende una catena eseguita fra componenti in
memoria o store temporanei, senza attribuirle valore radio:

- encode, cifratura, frammentazione, consegna, ACK, retry e deduplica;
- commit outbox, restore sullo stesso peer e rifiuto del restore su un peer
  diverso;
- probe health loopback Raspberry, fail-closed per dato stale e aggiornamento
  del solo `serverReachable` nel ServiceData BlueZ v1;
- aggiornamento completo `RouteAdvertisementV1` sul canale affidabile con
  route, RTT, eta, queue depth, batteria `UNKNOWN`, persistenza e rifiuto
  replay;
- emissione diagnostica, ricezione shadow e soppressione duplicati;
- role election e duplicate connection arbitration con vettori comuni;
- directory firmata, verifica cache, autenticazione A2 e derivazione del
  contesto affidabile dopo conferma reciproca;
- binding della porta autenticata al multiplexer, setup DATA/ACK/CCCD con
  deadline unica e revoca della lease sui fault runtime;
- teardown del GATT data plane, reset subscription e rilascio del materiale
  di sessione.

## Tratti Non Dimostrati End-To-End

Questo report non dimostra:

- pacchetti A2 e `DATA_RX/DATA_TX/ACK_TX` realmente scambiati via etere fra
  due Android certificati;
- comportamento reale con screen-off, Doze, RF congestionata, movimento e
  process death;
- continuita radio per due ore o 4.500 cicli fisici;
- interoperabilita della Postazione certificata assente;
- latenza reale di perdita/recupero della route e sostituzione advertisement
  sul Raspberry fisico;
- stato reale di batteria/UPS del Raspberry, che resta `UNKNOWN` nel payload;
- inoltro business via Bluetooth, che resta intenzionalmente vietato.

La presenza di callback, bridge e codec non va trasformata in un claim
fisico. Solo una cattura monitorata puo chiudere questi punti.

## Componenti Principali

### Contratti condivisi

```text
shared/session/android-peer-role-election-v1.mjs
shared/provisioning/peer-trust-directory-v1.mjs
shared/provisioning/peer-trust-transport-v1.mjs
shared/protocol/android-peer-auth-v2.mjs
contracts/peer-trust-directory-v1.schema.json
```

### Raspberry

```text
raspberry/src/protocol/FrameCodec.ts
raspberry/src/protocol/ReliableChannel.ts
raspberry/src/bluez/LeAdvertiser.ts
raspberry/src/bluez/DbusNextLeAdvertisementPort.ts
raspberry/src/routing/RouteHealthBudgetV1.ts
raspberry/src/session/GattReliableDataPlaneV1.ts
raspberry/src/storage/BluetoothTransportStore.ts
raspberry/src/routing/RouteAdvertisementV1.ts
raspberry/src/backend/BluetoothShadowIngress.ts
raspberry/src/security/PeerTrustDirectoryPublisherV1.ts
raspberry/src/security/PeerTrustDirectoryRuntimeV1.ts
raspberry/scripts/run-b11-software-non-gate.mjs
```

### Android, presenti in entrambe le app

```text
bluetooth/AndroidPeerTrustDirectoryV1.kt
bluetooth/AndroidPeerTrustDirectoryClientV1.kt
bluetooth/AndroidPeerAuthV2.kt
bluetooth/AndroidGattPeerAuthSessionV2.kt
bluetooth/AndroidGattReliableEndpointV1.kt
bluetooth/AndroidGattReliableSetupDeadlineV1.kt
bluetooth/AndroidGattReliableDataPlaneBridgeV1.kt
bluetooth/GattReliableDataPlaneV1.kt
bluetooth/ReliableChannel.kt
bluetooth/AndroidBluetoothTransportRuntimeV1.kt
bluetooth/AndroidBluetoothTransportStore.kt
bluetooth/RouteAdvertisementV1.kt
bluetooth/BluetoothDiagnosticCommandBusV1.kt
bluetooth/BluetoothShadowV1.kt
bluetooth/BluetoothTransportMessageRouterV1.kt
bluetooth/BluetoothFailoverService.kt
```

## Invarianti Di Sicurezza

1. I flag Bluetooth di prodotto sono OFF per default.
2. A2 richiede configurazione HTTPS canonica, TLS 1.3, pin SPKI e autorita
   P-256 distinta dal certificato di trasporto.
3. Materiale privato, seriali, hostname, PID e identificatori non entrano nei
   report esportabili.
4. Directory scaduta, revisione regressiva o peer revocato impediscono la
   promozione della sessione.
5. Outbox e inbox dedup sono legate al peer autenticato.
6. La sequenza del frame affidabile `RouteAdvertisementV1` e monotona e
   persistente; replay e out-of-order falliscono. La distinta sequenza
   discovery del ServiceData Raspberry avanza modulo 256 soltanto per cambi
   semantici e l'advertiser forza `serverReachable=false` quando health e
   stale.
7. `ReliableChannel.close()` attende la coda e azzera i payload sensibili
   anche nei percorsi di errore.
8. DATA, ACK e CCCD devono completarsi entro una deadline unica; timeout e
   callback stale non lasciano una porta pronta.
9. Restore/tick falliti revocano la lease e un rifiuto dello scheduler
   impedisce lo stato `RUNNING`.
10. B10 accetta soltanto diagnostica shadow e rifiuta `DATA` business.
11. Il budget operativo B9 e `<=4750 ms`, entro la SLA fail-closed di 5 s.
12. Nessun valore di configurazione critico viene inventato se manca.

## Risultati Software

| Suite | Risultato registrato |
| --- | ---: |
| Raspberry con Node 24 | `318/318 PASS`; include telemetria, commitment B5 e profilo B11 massimo virtualizzato |
| Contratti condivisi | `169/169 PASS` |
| Focus B6/B8/B11 Node | `39/39 PASS` |
| Golden role/arbitration B6 | `7/7 PASS` |
| Palmare debug Bluetooth | `59 classi, 340/340 PASS, 0 failure/error/skip` |
| Postazione debug Bluetooth | `59 classi, 340/340 PASS, 0 failure/error/skip` |
| Watchdog advertiser Postazione `api31Compat` | `7/7 PASS`, test mirato |
| Postazione `api31Compat` full offline | `374/374 PASS`, lint e assemble `PASS`, configurazione `NON_INSTALLATA`, fix API 24 incluso |
| Palmare A2 mirato | `18/18 PASS` |
| Badge diagnostico frontend | Palmare `6/6`, Postazione `39/39`, typecheck/build `PASS`, quattro viewport |
| Commitment account/device B5 | mirati `83/83`, Raspberry full `303/303`; attestazione `1.1`, aggregate `1.5`, promotion `1.3`; nessun hardware/promotion |
| Copertura A2 per app | `PASS nel full 340/340` |
| Copertura DATA/ACK per app | `PASS nel full 340/340` |
| Consistenza e isolamento | `24/24 PASS` |
| B11 storico schema 1 | `NON_GATE_PASS`, `4500/4500`, digest invariato |
| B11 baseline schema 2 | `NON_GATE_PASS`, `9100/9100`, 16 attori tutti virtuali |
| B11 massimo misto schema 3 | `MIXED_NON_GATE_INCOMPLETE` | 2/4 attori fisici osservati: i due Palmari; Postazione e Raspberry 0/1; campagna fisica `NOT_RUN` |

Il vecchio run B11 usa 10 nodi generici e tutte le 45 coppie, con 100 cicli per
coppia. Resta riproducibile a `4500/4500`, `64.760` frame, `2.250` messaggi
frammentati, `643` retry, `818` duplicati, `9.000` record history e `90` peer.
Il digest storico resta:
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.

La baseline schema 2 usa 10 Palmari, 3 Postazioni, 1 Raspberry, 1 cassa automatica
e 1 RT: 16 attori tutti virtualizzati e zero fisici. I 14 nodi BT coprono 78
coppie Android e 13 link Android-Raspberry, per `9100/9100` cicli. Il run conta
`130948` frame, `4550` sessioni frammentate, `1300` retry, `1656` duplicati,
`18200` record history e `182` peer. Il workload applicativo completa
`2600/2600` azioni, 800 comande e `100/100` transazioni per ciascuna periferica;
business BT, sessioni, outbox e residui finali sono zero. Digest schema 2:
`6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37`.
Il report dedicato e
`reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.md`.

Il massimo corrente e il profilo schema 3 `mixed-physical`: 2 Palmari fisici
e 8 virtuali, 1 Postazione fisica e 2 virtuali, 1 Raspberry fisico, cassa
automatica e RT virtuali. La partizione dei 91 link e 6 real-real, 40
cross-domain e 45 virtual-only. I domini software coprono `4000/4000` e
`4500/4500`; i `600` cicli real-real e le `600` azioni fisiche, incluse 160
comande Palmare, non ricevono credito dai surrogati software.

Il risultato corrente e `MIXED_NON_GATE_INCOMPLETE`: `2/4` attori fisici
osservati, cioe 2/2 Palmari, 0/1 Postazione e 0/1 Raspberry;
campagna radio, business fisico, monitor continui e soak sono `NOT_RUN`.

Il contratto eseguibile schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only e non puo
emettere un PASS. Readiness 4/4, `600/600` cicli con HELLO/auth/data
bidirezionale/cleanup, `600/600` azioni incluse 160 comande, monitor 4/4 e
soak fisico wall-clock >= `7200000 ms` restano criteri per una futura versione
del contratto/harness. La revisione resta bloccata finche non esistono manifest
e receipt fisici byte-bound, record verificabili per ciascuno dei 6 link e dei
4 attori, timestamp e provenance live. Il report corrente non promuove alcun
gate e lascia l'avanzamento al 49%. Il report canonico schema 3 e
`reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.md`.

`WAIVED_NON_GATE` nel v3 corrente e soltanto metadato per una policy futura e
non soddisfa readiness. L'inventario certifica l'APK con SHA-256 byte-esatto e
deriva la copertura signer dallo stesso binding: un signer ignorato lascia
l'APK non certificato e il risultato `INCOMPLETE`. Non viene introdotta una
probe signer separata.

La suite Bluetooth Android sul sorgente congelato ha chiuso `340/340 PASS`,
59 classi e zero failure, errori o skip sia su Palmare sia su Postazione.
Compile Kotlin, inventory e parita byte del core condiviso sono positivi. Il
`7/7` `api31Compat` resta il giro storico mirato al watchdog; il successivo
full offline chiude `374/374 PASS`, lint e assemble `PASS`. La configurazione
usata per quel full e `NON_INSTALLATA`, quindi non produce evidenza fisica. Il
fix API 24 e incluso e il focus A2 Palmare chiude `18/18 PASS`. Dopo qualsiasi
modifica a bridge, operation queue o callback GATT, il responsabile deve:

1. rieseguire entrambe le suite Android senza parallelizzare Gradle;
2. rieseguire i golden condivisi e la suite Raspberry con Node 24;
3. rieseguire lo schema 2 come regressione e B11 nel profilo massimo misto;
4. aggiornare qui e nel documento workspace sia il numeratore sia il
   denominatore, se la suite e cresciuta;
5. non rigenerare evidenze fisiche o promuovere gate con risultati sintetici.

## Consolidamenti Successivi Del 18 Agosto

La telemetria periodica Raspberry conserva lo snapshot `292/292 PASS`; il
consolidamento del commitment B5 porta il full Node a `303/303 PASS`. Le
metriche che il runtime non puo osservare sono pubblicate come `UNAVAILABLE`,
senza valori dedotti. Questo non cambia il valore protocollare `UNKNOWN` gia
previsto per batteria e UPS del Raspberry.

Il commitment account/device B5 usa un digest canonico domain-separated e
redatto nello state schema `3`, nei `100` record, nell'attestazione Android
`1.1`, nell'aggregate `1.5` e nel receipt `1.1`. Il promotion gate `1.3`
ricalcola ledger head e hash byte-esatti delle attestazioni prima del match
con aggregate e receipt. Il percorso legacy e read-only e resta `PENDING`.
Verifiche: mirati `83/83 PASS` e Raspberry `303/303 PASS`. Nessun hardware e
stato usato e nessuna promotion e avvenuta.

Il badge diagnostico Bluetooth e completato su Palmare e Postazione. Usa
soltanto il bridge e l'evento nativi, e nascosto se il flag o il contratto non
sono disponibili, non contiene identificatori e non dichiara routing
business. Parser bounded fail-closed, cleanup, accessibilita e rendering sono
coperti da `6/6` test Palmare, `39/39` Postazione, typecheck/build e quattro
viewport.

P-010 e avanzato per tranche senza essere dichiarato integralmente chiuso. Ha
eliminato lo storage diretto nel perimetro applicativo, separato tipi,
normalizzatori e builder puri dal facade analytics ed estratto
`reservationModel.ts`, la policy prodotto del composer e il modello recovery.
I mirati chiudono rispettivamente `21/21`, `6/6` e `11/11 PASS` per tree. Sono
state inoltre rimosse `38` priorita CSS ridondanti con equivalenza verificata su
`84` varianti e due viewport: `!important` passa da `305` al budget `267`.
Architecture chiude `11/12 PASS` per tree e resta bloccata soltanto dal gate
LOC sui quattro monoliti TSX `TablePaymentWizard`, `TablesWorkspace`,
`PaymentSettlementSection` e `AnalyticsWorkspace`. I test funzionali analytics
restano `465/465` e `469/469`, con typecheck e build `PASS`.

I run DOM immutabili del 18 agosto restano evidenza applicativa separata:

- `160/160`, con `114` successi, `46` failure e conteggio HTTP `565`;
- abort a `87/160`;
- `130/160`, con `113` successi, `17` failure, zero HTTP failure e
  `stopReason=PAGE_CLOSED`.

Verdetto: `NON_GATE_FAIL`, senza ulteriori retry. Le correzioni sono verdi a
`75/75` e la suite aggiuntiva a `55/55`, ma il residuo sotto carico resta
aperto. Non e un blocker del core transport/software gia chiuso, ne un PASS
fisico B7-B11.

## Configurazione E Attivazione

Le configurazioni normali restano disabilitate:

```text
BLUETOOTH_FAILOVER_ENABLED=0
BLUETOOTH_PEER_LINK_ENABLED=0
BLUETOOTH_ANDROID_PEER_AUTH_V2_ENABLED=0
BLUETOOTH_ROUTE_ADVERTISEMENT_ENABLED=0
BLUETOOTH_COMMAND_BUS_SHADOW=0
CASSA_BT_FEATURE_ENABLED=0
CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED=0
CASSA_BT_COMMAND_BUS_SHADOW_ENABLED=0
```

Anche in Lab, B10 mantiene `businessMessagesForwarded=0` e
`businessTransport=LAN_HTTP_SSE`. La modalita shadow osserva soltanto
`HEALTH`, `PING` e `TEST`.

## Assenza Di Effetti Sul Banco

Durante questa chiusura non sono stati eseguiti accessi ADB o SSH, prove BLE
fisiche o interrogazioni UPS. Non sono stati installati APK e non sono stati
fermati, riavviati o ricaricati `cassav5bt.service` e `bluetooth.service`.
Registry, enrollment, database e API business non sono stati modificati.

## Criterio Per La Ripresa

Il core transport/software e congelabile con verdetto `PASS_OFFLINE` e senza
blocker nel proprio perimetro. B7-B11 sono `NON_GATE_PASS` software ma
`PENDING` fisico. La roadmap non e formalmente conclusa: restano B0-B4 fisici,
B5 `100/100` con sign-off, B6 Android-Android fisico e il pilot/soak B11 reale.
Il meccanismo account/device commitment B5 e implementato, ma non ha prodotto
evidenza hardware o promotion. Nessuno di questi passi puo essere sostituito
dal report presente.

Avanzamento roadmap complessiva: **49%**.
