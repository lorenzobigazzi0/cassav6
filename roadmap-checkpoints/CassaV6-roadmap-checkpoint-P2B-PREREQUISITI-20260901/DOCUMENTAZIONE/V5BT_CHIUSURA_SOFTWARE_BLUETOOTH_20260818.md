# V5BT - Chiusura software Bluetooth B6-B11

Data: 2026-08-18, Europe/Rome.

## Esito

Il perimetro software Bluetooth previsto da B6 a B11 ha verdetto
**SOFTWARE PASS OFFLINE / NON-GATE** per Raspberry, Palmare Advanced e
Postazione Advanced. La baseline comprende sessioni Android-Android
autenticate, canale affidabile, persistenza locale legata al peer, route
advertisement, command bus diagnostico in shadow e un harness B11
deterministico. La matrice software finale non lascia blocker residui nel core
transport/software Bluetooth coperto dal documento: non dichiara completata
l'intera roadmap, il carico applicativo o la certificazione fisica.

Questo risultato e classificato **SOFTWARE NON-GATE**. Non e una
certificazione radio, non autorizza l'attivazione in produzione e non cambia
lo stato ufficiale della roadmap:

| Gate | Stato ufficiale | Evidenza ancora necessaria |
| --- | --- | --- |
| B4 | `PENDING`, `2/10` hardware fisici | altri 8 hardware distinti, monitorati e accettati |
| B5 | `PENDING`, `0/100` sessioni ufficiali | prerequisiti B0-B4, campagna fisica e sign-off indipendente |
| B6 | `PENDING/BLOCKED` | B5 promosso e sessione Android-Android fisica certificata |
| B7-B11 | software `NON_GATE_PASS`, fisico `PENDING` | prove radio, lifecycle e soak reali sui target previsti |

Avanzamento roadmap complessiva: **49%**.

## Confine Della Chiusura

La baseline software copre:

- elezione deterministica dei ruoli GATT Android e arbitraggio delle
  connessioni duplicate;
- directory di fiducia firmata, cache Android privata e autenticazione A2
  reciproca fra peer Android;
- framing v1, cifratura AEAD, frammentazione, ACK, retry, deduplica e TTL;
- data plane GATT `DATA_RX`, `DATA_TX` e `ACK_TX`, con reset e cleanup;
- outbox, inbox dedup, peer conosciuti, cronologia sessioni e stato route in
  SQLite;
- binding di outbox e dedup al `peerTrustId`, per impedire il ripristino di
  messaggi A verso un peer B;
- route advertisement osservativo con sequenza persistente e rifiuto di replay
  o messaggi fuori ordine;
- command bus tipizzato `HEALTH`, `PING`, `TEST` in sola modalita shadow;
- baseline B11 schema 2 con 10 Palmari, 3 Postazioni, 1 Raspberry, 1 cassa
  automatica e 1 RT, tutti virtualizzati; 91 link BT, 100 cicli per link e soak
  virtuale di due ore.
- profilo massimo B11 schema 3 fissato a 2 Palmari fisici + 8 virtuali, 1
  Postazione fisica + 2 virtuali, 1 Raspberry fisico, cassa automatica e RT
  virtuali; il preflight corrente e `MIXED_NON_GATE_INCOMPLETE`.

Restano deliberatamente fuori dalla chiusura:

- qualunque inoltro di comande, pagamenti, storni, tavoli o altri messaggi
  business via Bluetooth;
- routing multi-hop, load balancing e modalita serverless operativa;
- un PASS fisico Android-Android o Android-Raspberry;
- un soak radio reale e la certificazione del tablet Postazione;
- caratterizzazione fisica della latenza B9 e della perdita/riacquisizione
  della route su radio reale;
- una sorgente Raspberry verificata per batteria/UPS, che nel software resta
  intenzionalmente `UNKNOWN`;
- promozione dei gate o aumento della percentuale ufficiale.

## Sicurezza E Fiducia A2

Il flusso Android-Android non usa il precedente trust implicito del peer. La
directory `peer-trust-directory-v1` e firmata da un'autorita P-256 distinta
dalla chiave TLS dell'endpoint. Contiene soltanto materiale pubblico,
revisione, scadenza, stato `ACTIVE/REVOKED`, alias correnti e successivi e il
binding dell'identita. La chiave privata dell'autorita non appartiene ai
sorgenti o ai report esportabili.

Il client Android accetta esclusivamente HTTPS sul path canonico
`/v1/peer-trust-directory`, TLS 1.3, pin SPKI esplicito, nessun redirect e
risposta `no-store`. La cache vive in `noBackupFilesDir`, viene aggiornata
atomicamente e resta privata. Directory scadute, revisioni regressive,
identita revocate, alias non risolvibili, clock regressivo, prova non canonica
o firma errata chiudono il collegamento senza promuovere una sessione sicura.

L'handshake A2 lega entrambe le firme a HELLO, advertisement, alias epoch,
ruoli e transcript. Le chiavi di sessione e il `peerTrustId` diventano
utilizzabili dal reliable channel soltanto dopo la conferma reciproca. Non
esiste downgrade automatico ad A1 per un peer Android.

Il service collega al runtime una sola porta affidabile autenticata tramite
multiplexer. La porta diventa pronta soltanto dopo DATA, ACK e CCCD; una
deadline unica impedisce che una configurazione parziale resti attiva. Timeout
o callback stale chiudono il tentativo. Restore o tick falliti revocano la
lease, mentre il rifiuto dello scheduler e un errore di startup, non uno stato
`RUNNING` apparente.

## Canale Affidabile E Durabilita

Il codec comune usa frame v1 con `messageId`, indice e conteggio frammenti,
tipo e payload autenticato. Il payload e protetto con AES-256-GCM e le chiavi
sono separate per direzione. Il reliable channel gestisce retry con backoff e
jitter, ACK, deduplica, TTL, limite payload e cleanup del materiale sensibile.

Lo store e allo schema `3`. Le righe affidabili sono vincolate al
`peerTrustId`; restore, ACK e dedup richiedono lo stesso peer autenticato. La
migrazione da schema `2` rifiuta in modo esplicito righe affidabili non
attribuibili, invece di assegnarle arbitrariamente. La sequenza delle route e
persistente nello stesso schema. Transazioni, close e recovery non dichiarano
completato un messaggio prima del commit locale.

## Route E Command Bus Shadow

B9 pubblica soltanto stato osservativo: raggiungibilita server, tipo route,
fascia RTT, eta, profondita coda e fascia batteria. Publisher e ingress
conservano la sequenza e rifiutano replay e regressioni. Nessun nodo inoltra
messaggi per conto di un altro nodo.

Sul Raspberry il provider B9 e ora dinamico e fail-closed. Quando il relativo
feature flag viene abilitato esplicitamente, il runtime interroga l'endpoint
health loopback canonico. Il ServiceData BlueZ conserva il formato v1 e riceve
soltanto il bit `serverReachable`; route `LAN/NONE`, fascia RTT, eta, queue
depth e batteria `UNKNOWN` restano nel frame affidabile
`RouteAdvertisementV1`. Health assente, scaduto o regressivo forza
`serverReachable=false`; la batteria Raspberry e l'UPS non sono campionati e
restano `UNKNOWN`. Il budget operativo end-to-end e `<=4750 ms`, comprensivo
di scheduling, probe e sostituzione D-Bus, entro la SLA fail-closed di 5 s.

L'advertiser BlueZ usa alias privato persistente con file `0600` in directory
`0700`, alias rotante ogni 60 s, `bootId` non nullo ruotato a ogni avvio e
sequenza modulo 256 incrementata soltanto ai cambi semantici. Gestisce timeout
di register/unregister, perdita del proprietario BlueZ, recupero e cleanup.
La funzione resta OFF per default e non e stata provata sul Raspberry fisico.

B10 collega un bus diagnostico tipizzato all'adapter shadow. Il producer di
servizio emette `HEALTH`; `PING` e `TEST` seguono lo stesso contratto
diagnostico. Il router rifiuta esplicitamente frame `DATA` business e dichiara
sempre `businessMessagesForwarded=0` e `businessTransport=LAN_HTTP_SSE`.

I flag normali restano disattivati per default, inclusi:

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

Una build che non riceve configurazione A2 completa e valida deve fallire in
compilazione o lasciare il runtime bloccato; non deve inventare endpoint, pin
o chiavi.

## Verifica Software

Snapshot di consolidamento del 18 agosto:

| Area | Risultato | Significato |
| --- | ---: | --- |
| Raspberry/Node 24 | `318/318 PASS` | include telemetria, commitment B5 e profilo B11 massimo virtualizzato |
| Contratti condivisi | `169/169 PASS` | protocollo, provisioning, role election e golden |
| Focus B6/B8/B11 Node | `39/39 PASS` | regressioni mirate di sessione, peer binding e B11 |
| Golden B6 condivisi | `7/7 PASS` | parita elezione ruoli e arbitraggio Node/Kotlin |
| Palmare debug Bluetooth | `59 classi, 340/340 PASS, 0 failure/error/skip` | matrice finale A2, client/server, CCCD, queue, deadline e runtime |
| Postazione debug Bluetooth | `59 classi, 340/340 PASS, 0 failure/error/skip` | stessa matrice sulla seconda app |
| Watchdog advertiser Postazione `api31Compat` | `7/7 PASS` | test mirato della deadline; non e una suite full `api31Compat` |
| Postazione `api31Compat` full offline | `374/374 PASS`, lint e assemble `PASS` | configurazione offline verificata ma `NON_INSTALLATA`; incluso il fix di compatibilita API 24 |
| Palmare A2 mirato | `18/18 PASS` | autenticazione A2 e relativi percorsi fail-closed |
| Badge diagnostico frontend | `PASS` | parser bounded fail-closed, bridge/evento, cleanup, accessibilita e quattro viewport; typecheck/build positivi |
| Commitment account/device B5 | mirati `83/83`, Raspberry nel full `303/303` | attestazione Android `1.1`, aggregate `1.5` e promotion `1.3` legati agli input raw; nessun hardware o promotion |
| Copertura A2 per app | `PASS nel full 340/340` | directory, refresh, cache, firme, transcript, revoca e fail-closed |
| Copertura DATA/ACK per app | `PASS nel full 340/340` | deadline CCCD, lifecycle, arbiter e integrazione B7-B10 |
| Consistenza/isolation | `24/24 PASS` | parita sorgenti e separazione V5BT |
| B11 storico schema 1 | `NON_GATE_PASS`, `4500/4500` | 10 nodi generici, 45 coppie, digest invariato |
| B11 baseline schema 2 | `NON_GATE_PASS`, `9100/9100` | 16 attori tutti virtuali; 14 BT, cassa automatica e RT applicative |
| B11 massimo misto schema 3 | `MIXED_NON_GATE_INCOMPLETE` | 2/4 attori fisici osservati: i due Palmari; Postazione e Raspberry 0/1; campagna fisica `NOT_RUN` |

Entrambe le simulazioni B11 esercitano frammentazione, retry, duplicati, transizioni
background, recovery durevole dopo reboot logico, route, shadow, certificato
non valido e cleanup. Il soak da `7.200.000 ms` usa tempo virtuale
deterministico: e utile come prova software, ma non misura radio, scheduler,
batteria o lifecycle reali.

Lo storico schema 1 registra `64.760` frame, `2.250` messaggi frammentati,
`643` retry, `818` duplicati, `9.000` record history e `90` peer. Il soak
comprende `7.200` tick e `121` campioni, con leak e risorse residue entrambi a
zero. Digest canonico:
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.

La baseline schema 2 copre 10 Palmari, 3 Postazioni e un Raspberry su 91 link,
con `9100/9100` cicli, `130948` frame, `4550` sessioni frammentate, `1300`
retry, `1656` duplicati, `18200` history e `182` peer. Completa anche
`2600/2600` azioni, 800 comande e `100/100` transazioni su ciascuna periferica
virtuale. Business Bluetooth, attori fisici, sessioni, outbox e residui sono
zero. Digest:
`6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37`.

Il massimo schema 3 conserva 16 attori ma ne fissa 4 come fisici: 2 Palmari,
1 Postazione e 1 Raspberry. Gli altri 12 sono 8 Palmari, 2 Postazioni, cassa
automatica e RT virtuali. I 91 link sono partizionati in 6 real-real, 40
cross-domain e 45 virtual-only: il software riceve credito per `4000/4000` e
`4500/4500`, mentre i `600` cicli e le `600` azioni degli slot fisici, incluse
160 comande, richiedono evidenza fisica distinta.

Lo stato corrente e `MIXED_NON_GATE_INCOMPLETE`: `2/4` attori fisici
osservati, cioe 2/2 Palmari, 0/1 Postazione e 0/1 Raspberry.
Radio, business fisico, monitor continui e soak fisico sono `NOT_RUN`.

Il contratto eseguibile schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only e non puo
emettere un PASS. Readiness 4/4, `600/600` HELLO/auth/data
bidirezionale/cleanup, `600/600` azioni incluse 160 comande, monitor 4/4 e
almeno `7200000 ms` wall-clock sono criteri per una futura versione del
contratto/harness. Servono prima manifest e receipt fisici byte-bound, record
verificabili per-link e per-actor, timestamp e provenance live. Il receipt
corrente resta `gateImpact: NONE`, B11 `PENDING` e avanzamento 49%.

`WAIVED_NON_GATE` nel v3 corrente e solo metadato per una policy futura e non
soddisfa readiness. L'inventario certifica l'APK con SHA-256 byte-esatto e
deriva la copertura signer dallo stesso binding: un signer ignorato lascia
l'APK non certificato e il risultato `INCOMPLETE`. Non viene aggiunta una
probe signer separata.

La matrice completa Bluetooth Android sul sorgente congelato ha chiuso
`340/340 PASS`, 59 classi e zero failure, errori o skip su ciascuna app. I run
sono stati eseguiti serialmente; compile Kotlin, inventory e core condiviso
byte-identico sono coerenti. Il successivo giro completo della variante
`api31Compat` ha chiuso `374/374 PASS`, con lint e assemble positivi. La sua
configurazione e rimasta offline e `NON_INSTALLATA`, quindi questo risultato
non sostituisce la precedente evidenza fisica ne certifica il tablet. Il fix
di compatibilita API 24 e incluso; il focus A2 Palmare chiude `18/18 PASS`.

## Consolidamento Frontend E Telemetria

Il badge diagnostico di connettivita Bluetooth e completato sui frontend
Palmare e Postazione. Consuma soltanto il bridge nativo e l'evento diagnostico,
resta completamente nascosto quando il flag o il contratto nativo non sono
disponibili e non espone identificatori. Il parser accetta esclusivamente lo
snapshot bounded previsto e fallisce chiuso; subscription e listener vengono
rilasciati al cleanup. Le verifiche dedicate chiudono `6/6` sul Palmare e la
suite Postazione `39/39`; typecheck e build sono `PASS`, con controllo visuale
su quattro viewport. Il badge descrive stato diagnostico e non rivendica
routing o trasporto business.

La telemetria periodica Raspberry conserva lo snapshot `292/292 PASS`; il
successivo consolidamento commitment B5 porta il full a `303/303 PASS`.
Quando una metrica non e osservabile, il contratto pubblica esplicitamente
`UNAVAILABLE` invece di inferire un valore. Batteria e UPS nel route
advertisement restano separatamente `UNKNOWN`, come gia definito dal
protocollo.

Il commitment account/device B5 usa un digest canonico domain-separated e
redatto nello state schema `3`, nei `100` record, nell'attestazione Android
`1.1`, nell'aggregate `1.5` e nel receipt `1.1`. La promotion `1.3` ricalcola
ledger head e SHA-256 dei byte esatti delle attestazioni, confrontandoli con
aggregate e receipt; il legacy resta read-only e `PENDING`. I mirati chiudono
`83/83 PASS` e il full Raspberry `303/303 PASS`. Non e stato usato hardware e
nessun gate e stato promosso.

## Debito Applicativo E Workload Non-Gate

P-010 e avanzato per tranche senza essere dichiarato integralmente chiuso. Ha
eliminato l'uso diretto dello storage nel perimetro previsto, separato tipi,
normalizzatori e builder puri dal facade analytics ed estratto
`reservationModel.ts`, la policy prodotto del composer e il modello recovery.
I mirati chiudono rispettivamente `21/21`, `6/6` e `11/11 PASS` per tree. La
rimozione di `38` priorita CSS ridondanti e stata verificata su `84` varianti e
due viewport con stile e pixel invariati; `!important` passa da `305` al budget
`267`. Architecture chiude `11/12 PASS` per tree: resta soltanto il gate LOC
sui quattro monoliti TSX `TablePaymentWizard`, `TablesWorkspace`,
`PaymentSettlementSection` e `AnalyticsWorkspace`. Le verifiche funzionali
analytics restano `465/465` e `469/469`, con typecheck e build positivi nei due
frontend.

I tre nuovi run DOM del 18 agosto sono immutabili e restano separati dalle
prove Bluetooth fisiche:

- primo: `160/160`, `114` successi e `46` failure, conteggio HTTP `565`;
- secondo: abort a `87/160`;
- terzo: `130/160`, `113` successi e `17` failure, zero HTTP failure e
  `stopReason=PAGE_CLOSED`.

Il verdetto aggregato e `NON_GATE_FAIL` e non sono autorizzati altri retry.
Le suite delle correzioni chiudono `75/75 PASS` e quelle aggiuntive
`55/55 PASS`, ma il residuo sotto carico resta aperto. Questo punto non
modifica la chiusura del core transport/software B7-B11 e non promuove alcun
gate fisico.

## Effetti Operativi Del Giro

Questo giro non ha usato ADB, SSH, Bluetooth o UPS reali. Non ha installato
APK, modificato enrollment, scritto nel registry fisico, fermato o riavviato
`cassav5bt.service` o `bluetooth.service`. API business, server operativo e
database non sono stati modificati dalla chiusura B6-B11.

## Ripresa Fisica

Il lavoro Bluetooth residuo e una campagna di prova e certificazione, non
un'autorizzazione implicita a sviluppare trasporto business:

1. completare B0-B3 con Palmare e Postazione certificati e monitor continui;
2. portare B4 da `2/10` a `10/10` usando hardware realmente distinto;
3. eseguire e revisionare B5 `100/100` secondo collector e supervisor;
4. eseguire B6 Android-Android su radio reale, inclusi A2, DATA/ACK, retry,
   disconnect, reconnect e cleanup;
5. eseguire il pilot/soak B11 fisico prima di qualsiasi promozione.

La baseline del core transport/software puo essere congelata e il lavoro puo
passare alle successive attivita applicative. B7-B11 sono `NON_GATE_PASS`
soltanto sul piano software; la certificazione fisica resta `PENDING`, il
commitment account/device B5 e implementato ma non ha usato hardware ne
prodotto promotion, e i flag Bluetooth restano OFF. Avanzamento roadmap
complessiva: **49%**.
