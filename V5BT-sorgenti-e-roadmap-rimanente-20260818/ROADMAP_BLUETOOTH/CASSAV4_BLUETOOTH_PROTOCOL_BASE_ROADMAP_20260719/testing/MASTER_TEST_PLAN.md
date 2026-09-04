# Master test plan

## Regola di evidenza

Un test locale, un self-test o una simulazione puo chiudere soltanto il proprio
incremento software. I gate B1/B2/B3 fisici richiedono i dispositivi, le radio
e le evidenze reali previste dalla rispettiva fase. Un p95 calcolato dal solo
scheduler non e discovery reciproca fisica; 3600 eventi simulati non sono un
soak foreground-service fisico di 3600 secondi.

## B1 - provisioning e trasporto

| Layer | Evidenza richiesta | Stato |
| --- | --- | --- |
| Contratti | request/response esatti, duplicate key, limiti body, encoding canonici | PASS locale |
| Registry | token monouso, commit atomico, recovery, permessi e isolamento V5BT | PASS locale |
| HTTPS | TLS 1.3, SAN e pin SPKI, health fail-closed, saturazione controllata | PASS locale; TLS reale PENDING |
| Android | Ed25519 Keystore, binding NodeId/SPKI, import aliasKey, retry `ENROLLMENT_PENDING` | PASS unitario; fisico PENDING |
| Segreti | nessun token/alias/private key in argv, log, report o WebView | PASS locale; cattura fisica PENDING |
| Fault injection | process kill e power loss sul filesystem Raspberry target | PENDING |

Il server ammette quattro enrollment concorrenti e al massimo 32 connessioni.
Il caso eccedente deve ottenere `503 ENROLLMENT_BUSY`, `Connection: close` e
`Retry-After: 1`. Il servizio deve rispettare `MemoryMax=128M`,
`CPUQuota=50%`, `TasksMax=64` e `LimitNOFILE=256`.

La stessa richiesta firmata puo recuperare per 600 secondi una risposta gia
impegnata. Durante questa finestra e bearer-equivalent per quella risposta e
non deve comparire in log, trace, proxy, shell history o report.

Comandi locali:

```bash
node --test shared/provisioning/device-registry-v1.test.mjs
node --test shared/provisioning/enrollment-transport-v1.test.mjs
node --test raspberry/scripts/enrollment-server.test.mjs
node scripts/validate-contracts.mjs --root .
```

## B2 - discovery Android

Il reporter Lab scrive soltanto stato aggregato nell'area privata
`no_backup`: readiness, radio attiva, profilo scan, numero di peer attivi e
metriche aggregate. Alias, NodeId, MAC, token, chiavi e certificati sono
vietati. Il file deve avanzare tramite `sampleSequence`; dati fuori allowlist
invalidano la prova.

Comandi locali:

```bash
node --test scripts/run-b2-android-adb-harness.test.mjs
node scripts/run-b2-android-adb-harness.mjs --self-test
node --test scripts/advanced-certification-targets.test.mjs
node scripts/run-b2-android-gate.mjs --self-test
node --test shared/discovery/peer-directory-v1.test.mjs
node --test shared/discovery/scan-window-policy-v1.test.mjs
node scripts/simulate-discovery-soft-state.mjs --root .
```

La chiusura fisica richiede:

1. due APK Lab Advanced gia enrollati con identita `READY`;
2. due device Android API 33 o superiore, BLE e permessi verificati;
3. 100 cicli di discovery reciproca con p95 non superiore a 8000 ms;
4. controller capture del layout AdvData e del budget di 31 byte;
5. revoca/ripristino permessi, background/foreground e comportamento OEM;
6. report del gate reciproco senza seriali; report operatore singolo limitato
   al seriale ADB esplicito e ai metadati tecnici, sempre senza indirizzi BLE o
   materiale di enrollment;
7. catture RF e controller non vuote, distinte e sottoposte a revisione
   indipendente prima della chiusura del gate fisico.

Il runner reciproco vincola esattamente 100 cicli ai due target certificati,
all'utente Android corrente, ai package/versioni Advanced attesi e a campioni
freschi con sequenza crescente. Richiede attivita effettiva di scan e
advertising, peer anonimi osservati e contatori critici a zero. Il campo
`localMeasurementVerdict` puo diventare `PASS`; il campo `gate` resta
`PENDING` finche la revisione indipendente delle evidenze fisiche non e
registrata.

## B3 - Android connectivity agent

| Layer | Evidenza richiesta | Stato |
| --- | --- | --- |
| Feature gate | master false per default; attivazione solo Lab con identity e discovery | PASS locale |
| Lifecycle | transizioni esplicite, eventi duplicati idempotenti, backoff e stop deterministici | PASS locale |
| Foreground service | tipo `connectedDevice` accettato prima di scanner/advertiser e rimosso allo stop radio | PASS locale |
| Scope B3 | Direct Server e Peer Link false; GATT server/client inattivi; zero sessioni | PASS locale |
| Redazione | file Lab aggregato separato; snapshot WebView a quattro campi, read-only | PASS locale |
| Soak fisico | due target Advanced per esattamente 3600 secondi e revisione dell'evidenza | PENDING |

Il servizio nativo e fail-closed. `BLUETOOTH_FAILOVER_ENABLED` richiede
contemporaneamente build Lab, master B3, identita e discovery. I flag
`BLUETOOTH_DIRECT_SERVER_ENABLED` e `BLUETOOTH_PEER_LINK_ENABLED` restano
false in B3; se richiesti, bloccano la discovery invece di aprire una sessione
futura. B3 riusa scanner, advertiser e peer directory B2, ma non installa un
GATT server, non apre un GATT client e non trasporta messaggi.

Il reporter Lab scrive atomicamente il solo stato aggregato in
`no_backup/bluetooth-connectivity-agent-status-v1.json`. Il file e distinto
dal reporter discovery B2 e contiene lifecycle, contatori aggregati e booleani
di risorsa. Seriali, NodeId, alias, indirizzi BLE, token, chiavi, certificati e
materiale di enrollment sono vietati. La superficie WebView e ancora piu
stretta: esattamente `schemaVersion`, `source`, `sequence` e `state`, senza
metriche o identificatori e senza metodi di scrittura.

Comandi locali del gate:

```bash
node --check scripts/run-b3-android-service-gate.mjs
node --test scripts/advanced-certification-targets.test.mjs
node scripts/run-b3-android-service-gate.mjs --self-test
node --test scripts/run-b3-android-service-gate.test.mjs
node scripts/run-b3-android-service-gate.mjs \
  --dry-run \
  --handheld-serial <seriale-palmare> \
  --station-serial <seriale-postazione>
```

Le suite JVM/Android dell'implementazione B3 sono `PASS` localmente. I conteggi
finali di build, Lab e audit vengono consolidati nel report B3 e non devono
essere usati per promuovere il gate fisico.

La chiusura fisica richiede:

1. i due target certificati Palmare Advanced e Postazione Advanced, entrambi
   Lab, debuggable, API 33 o superiore e con i tre permessi Nearby Devices;
2. osservazione non abbreviabile di 3600 secondi con reporter unico, sequenze e
   timestamp crescenti e nessun silenzio di 30 secondi;
3. `startCount` esattamente uno, `stopCount` e
   `invalidTransitionCount` a zero, contatori mai regressivi;
4. nessuno stato `STOPPED`, `DIRECT_SERVER` o `PEER_CONNECTED`, nessuna risorsa
   GATT attiva e `sessionCount` sempre zero;
5. HOME prima del timer, almeno 61 audit FGS con `dataSync` sempre presente,
   `connectedDevice` durante la radio e nessun nuovo crash/ANR;
6. report fisico redatto e revisione separata prima di cambiare il gate da
   `PENDING`.

## B4 - Raspberry BlueZ node

| Layer | Evidenza richiesta | Stato |
| --- | --- | --- |
| Configurazione | feature OFF e dry-run ON per default; valori invalidi rifiutati | PASS locale/ARM64 |
| Lifecycle | macchina a stati serializzata e stop idempotente | PASS locale/ARM64 |
| Discovery core | Service Data v1 verso il `PeerDirectoryV1` canonico | PASS locale/ARM64 |
| Cleanup | zero timer, match rule e sessioni dopo stop | PASS locale/ARM64 |
| BlueZ live lifecycle | Adapter1 start/stop e recovery dopo restart BlueZ | PASS ARM64 |
| ServiceData live | callback Device1 da un advertiser V1 fisico | PASS ARM64, un Palmare |
| Collector progressivo | ADB, deduplica hardware, staging privato, ripresa | PASS locale, progresso fisico 1/10 |
| Aggregatore gate | collector report, stessi 10 hash e identita B1 distinte | PASS locale, fisico PENDING |
| Gate fisico | almeno 10 nodi consecutivi senza leak | PENDING |

Comandi del core:

```bash
cd raspberry
npm ci
npm run check
npm test
npm run gate:b4-servicedata -- --self-test
npm run gate:b4-ten-device -- --self-test
```

Comandi del collector workstation:

```bash
node --test scripts/collect-b4-physical-device.test.mjs
node scripts/collect-b4-physical-device.mjs --self-test
```

Il comando `--preflight` esegue gli stessi controlli Android canonici e la
deduplica HMAC prima del run fisico, senza leggere evidenze Raspberry, creare
slot o scrivere lo stato privato.

Il test a 10 peer e deterministico e non sostituisce il gate radio. Sul
Raspberry la validazione OFF/DRY_RUN deve mantenere `Discovering: no` e
`ActiveInstances: 0`. B4.2 verifica inoltre `Discovering: yes` durante lo
smoke, recovery dopo restart reale di BlueZ e ritorno a zero risorse. B4.3
aggiunge un gate fisico da 90 secondi: 259 callback valide da un Palmare,
zero rifiuti/errori, rimozione di uno stream scaduto e cleanup completo.
B4.4 aggiunge il gate fail-closed per dieci acquisizioni: richiede il report
del collector, confronta gli stessi dieci hash, rivalida ogni log, correla gli
alias al registry B1 senza esportare identita e rifiuta duplicati o finestre
sovrapposte. GATT e sessioni restano separati.

Al 2026-07-20 un Palmare fisico era disponibile per B4.3. Il soak B3 richiede
comunque due target Android certificati per 3600 secondi e resta `PENDING`;
la prova singola B4.3 non lo sostituisce.

## B5 - Android-Raspberry direct session

| Layer | Evidenza richiesta | Stato |
| --- | --- | --- |
| Contratto lifecycle | ruoli fissi e sequenze distinte client/server | PASS locale |
| Invarianti | auth/key prima di ACTIVE, MTU 23..517, sessionId 128 bit | PASS locale |
| Heartbeat | PING/PONG e close al terzo miss senza timer nascosti | PASS locale |
| Privacy | snapshot senza identita, sessionId, chiavi o payload | PASS locale |
| Profilo GATT | UUID/flag v1 e accesso pre-sessione fail-closed | PASS locale |
| Server GATT Raspberry | register/unregister, rollback e owner recovery | PASS locale |
| Smoke GATT Raspberry | registrazione reale e cleanup BlueZ | PASS ARM64 |
| Client GATT Android | connessione, discovery servizi e MTU reali | PASS locale; PASS fisico Palmare 1 target |
| HELLO Android-Raspberry | frame 51 byte, binding, write/read e cleanup | PASS locale; PASS fisico Palmare 1 target |
| Mutual auth Android-Raspberry | proof/finish, binding, anti-replay e cleanup | PASS locale/ARM64; PASS fisico 2 Palmari |
| Session key e heartbeat | derivazione, conferma chiave e liveness prima di ACTIVE | PASS locale/build Lab; gate fisico PENDING |
| Matrice build | package, versione, code e SHA-256 condivisi da tutti i gate | PASS locale |
| Coerenza build Advanced | matrice/Gradle/APK e parita sorgenti/test Bluetooth | PASS locale; hardware non richiesto |
| Collector campagna | state v2, bootId privato, recovery, slot 001..100 e manifest | PASS locale; radio PENDING |
| Supervisor campagna | ledger v1, timeout mirato, suspend/resume, invalidazione e recovery | PASS locale; campagna PENDING |
| Continuita Android | target handheld, APK, user, PID, reporter, tutti i tentativi e exit-info | PASS locale; campagna PENDING |
| Continuita Raspberry | due servizi, boot, clock, PID, restart, gap e tutti i tentativi | PASS locale; campagna PENDING |
| Inventario banco | ADB/Raspberry/BlueZ/NTP/UPS/servizi/registry/enrollment/permessi read-only | PASS fixture; banco PENDING |
| Autorizzazione | B0-B4 e vincoli di campagna impegnati prima del primo tentativo | PASS locale; evidenze PENDING |
| Aggregatore tecnico | state, ledger, 100 report e due attestazioni della stessa campagna | PASS locale; evidenze PENDING |
| Receipt tecnico | hash byte-exact e commitment campagna in coppia immutabile con l'aggregato | PASS locale; evidenze PENDING |
| Review/promozione | aggregate+receipt, parser esatto, commitment distinti e sign-off indipendente | PASS locale; review fisica PENDING |
| Gate fisico | 100 sessioni open/close senza crash | PENDING |

Comandi:

```bash
node --test shared/session/direct-session-v1.test.mjs
node --test shared/protocol/gatt-profile-v1.test.mjs
node --test shared/protocol/hello-v1.test.mjs
node --test shared/protocol/mutual-auth-v1.test.mjs
node --test scripts/advanced-certification-targets.test.mjs
node --test scripts/run-b5-android-continuity-monitor.test.mjs
node --test scripts/run-b5-raspberry-continuity-monitor.test.mjs
node --test scripts/b5-campaign-governance.test.mjs
npm --prefix raspberry run gate:b5-gatt-smoke -- --self-test
npm --prefix raspberry run gate:b5-hello-smoke -- --self-test
npm --prefix raspberry run gate:b5-mutual-auth-smoke -- --self-test
npm --prefix raspberry run collect:b5-direct-control -- --self-test
npm --prefix raspberry run supervise:b5-campaign -- --self-test
npm --prefix raspberry run gate:b5-hundred-session -- --self-test
node --test raspberry/test/b5-direct-control-session-collector.test.mjs
node --test raspberry/test/b5-campaign-supervisor.test.mjs
node --test raspberry/test/b5-hundred-session-gate.test.mjs
node --test raspberry/test/b5-promotion-gate.test.mjs
node scripts/validate-contracts.mjs --root .

# Dalla root del workspace
node --test tests/run-v5bt-bench-inventory.test.mjs
node --test tests/verify-v5bt-advanced-build-consistency.test.mjs
node scripts/verify-v5bt-advanced-build-consistency.mjs --root .
```

B5.1 resta un core condiviso non importato dal runtime. B5.2 collega soltanto
la registrazione GATT Raspberry e nega ogni accesso alle caratteristiche.
B5.3 certifica sul Raspberry 9 export, 8 managed object, una richiesta
ObjectManager, 7 caratteristiche e cleanup completo: zero export, match rule
e bus residui, con discovery invariata e nessun advertising avviato. I flag
sessione Android restano disattivati e questo PASS non promuove B4 o il gate
B5. B5.4 aggiunge il client Android default-off in entrambe le app: selezione
Raspberry fail-closed, connect, validazione esatta del profilo e MTU. La prova
fisica su un Palmare ha raggiunto `READY` con MTU 517; non sono avvenuti read,
write, subscribe, HELLO, autenticazione o apertura sessione. B5.5 apre la sola
caratteristica HELLO: il run fisico pulito ha completato un write e un read,
raggiunto `HELLO_EXCHANGED` su entrambi i lati e mantenuto a zero le sessioni
autenticate. B5.6 aggiunge la mutual auth legata alle identita enrollate: due
prove fisiche sequenziali su due Palmari hanno raggiunto `AUTHENTICATED`, una
sola volta per target e senza failure; ogni cleanup ha riportato a zero
sessioni autenticate e risorse BlueZ. B5.7 implementa session key, heartbeat e
`ACTIVE`; build Lab e test locali passano. Il collector schema v2 esegue
direttamente runner e advertising, riserva un `bootId` privato CSPRNG per
cattura, usa commit riprendibili e non accetta report importati. Il monitor ADB
continuo produce un'attestazione redatta.

Il secondo giro offline introduce il supervisor come unico owner dei capture
ufficiali. Il ledger v1 e separato dallo state collector v2 e registra una
hash-chain di tentativi: solo `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT` con
cleanup verificato e ritentabile, tre timeout consecutivi producono
`SUSPENDED`, un successo azzera il contatore e ogni altro errore produce
`INVALIDATED`. Recovery atomico, clock regressivo, manomissione, symlink,
hardlink e overwrite falliscono chiusi.

Il monitor Raspberry osserva continuativamente `cassav5bt.service` e
`bluetooth.service`, boot ID, clock, `MainPID`, `NRestarts`,
`ActiveEnterTimestampMonotonic` ed `ExecMainStartTimestampMonotonic`. Entrambi i
monitor devono coprire `attemptLedger.coverageFromMs..coverageUntilMs`, inclusi
timeout e riprese, e l'autorizzazione deve precedere il primo tentativo. Il
target Android accettato e esclusivamente `handheld`. Il campionamento usa
`ceil(duration/poll)+1` scadenze con clamp finale, anche per durate non
divisibili.

Risultato privato e attestazione di ogni monitor vengono pubblicati come coppia
recuperabile tramite `<private-output>.publication-v1.journal.json`. Journal,
digest, path e campagna non coerenti falliscono chiusi; una ripetizione della
stessa CLI completa una pubblicazione interrotta. Il supervisor invalida anche
una regressione del clock rilevata durante `--resume`, senza tornare `ACTIVE`.

Il gate tecnico richiede manifest, state, ledger, autorizzazione B0-B4 e
attestazioni Android/Raspberry. Pubblica come coppia immutabile l'aggregato e un
receipt conforme a `contracts/b5-technical-receipt-v1.schema.json`, prodotto da
`scripts/b5-technical-receipt.mjs`. Il receipt lega SHA-256 byte-exact di
aggregato, collector state, autorizzazione, matrice e attestazioni, oltre a
campaign/collection commitment, attempt ledger head, prerequisite bundle e
operator commitment. Il massimo risultato tecnico e `TECHNICAL_PASS` con
`b5HundredSessionGate: PENDING_REVIEW`.

La promozione e separata: il parser dell'aggregato richiede il set esatto di
campi e il gate richiede `--technical-receipt` oltre all'aggregato. Serve un
sign-off successivo, di un revisore distinto, legato allo SHA-256 dei byte
esatti dell'aggregato tecnico e agli stessi commitment della campagna. Assenza
o mismatch di aggregate, receipt o review lascia B5 `PENDING`. Solo il
promotion gate puo produrre PASS per B5; B6 resta comunque `PENDING`.

L'inventario unico e read-only. Per l'UPS rileva soltanto presenza e unita di
servizio: nessun driver viene assunto prima della futura ispezione fisica.
Anche il terzo giro non ha contattato ADB, SSH, Bluetooth, UPS o servizi reali
e non produce evidenza di gate. B5 e B6 restano `PENDING`; l'avanzamento
ufficiale resta **49%**.

## Stato Consolidato Al 2026-08-03

- suite Raspberry completa con build TypeScript: 196/196 PASS;
- contratti JSON: 20/20 PASS;
- suite shared: 128/128 PASS;
- suite scripts roadmap: 111 PASS, 2 SKIP dichiarati per il log storico B4
  esterno assente, 0 failure;
- advertiser Python: 7/7 PASS;
- matrice certificazione: 3/3 PASS;
- harness ADB B2: 17/17 PASS; self-test reciproco 53/53;
- runner B3: 28/28 PASS; self-test 41/41;
- monitor Android B5: 21/21 PASS;
- monitor Raspberry B5: 19/19 PASS mirati;
- collector B5: 26/26 PASS;
- governance B5: 4/4 PASS mirati;
- inventario banco read-only: 5/5 PASS su fixture;
- coerenza build Advanced: 5/5 PASS e verifica reale locale positiva;
- gate tecnico B5: 33/33 PASS;
- promotion gate B5: 12/12 PASS;
- supervisor B5: 18/18 PASS; blocco mirato terzo giro: 103/103 PASS;
- supervisor incluso nella suite Raspberry consolidata; nessun risultato
  sintetico promuove B5;
- inventario manifest bidirezionale: 4/4 PASS;
- isolamento workspace: 13/13 PASS;
- generatore archivio sorgente: 4/4 PASS;
- build Lab Android: Palmare 180/180, Postazione 176/176, lint senza errori;
- B4 fisico conserva soltanto il progresso storico `1/10`, da rivalidare;
- B2 discovery fisico, B3 soak 3600 s, pilot B5.7 e campagna B5 restano
  `PENDING`; Raspberry e Android sono disconnessi;
- sei evidenze storiche assenti sono dichiarate esterne e non sintetizzabili;
- B6 resta `PENDING` e non e stata avviata.

I controlli locali non aumentano la percentuale della roadmap, che resta
**49%**. Il pilot
diagnostico e consentito dopo PASS B0-B3 e rivalidazione del ledger B4
parziale; la campagna ufficiale richiede il PASS B0-B4 e revisione separata.

## Verifica Consolidata Al 2026-08-04

- suite Raspberry completa con build TypeScript: 196/196 PASS;
- contratti JSON: 22/22 PASS;
- suite shared: 124/124 PASS;
- suite script roadmap: 168 PASS, 2 SKIP storici, 0 failure;
- test root: 40/40 PASS;
- verifica build Advanced: 9/9 PASS, inclusa la parita dei sorgenti Bluetooth;
- advertiser Python: 7/7 PASS e self-test PASS;
- generatore archivio sorgente: 4/4 PASS;
- build Android: Palmare `197/197` e Postazione `190/190` PASS, entrambe
  assemblate e sottoposte a lint senza errori;
- B0 capability runner: 21/21 PASS; cattura fisica di 120 secondi
  `SUPPLEMENTAL_FAIL`, gate formale `PENDING`;
- B1: due identita `READY`, distinte e coerenti con il registry;
- B2 diagnostico con isteresi: `100/100` cicli, 95 PASS, 5 timeout, p95
  19.145 ms rispetto al massimo di 8.000 ms, `NON_GATE_EVIDENCE/PENDING`;
- monitor Raspberry: `PASS`, 11.091.818 ms, 5.541 campioni, gap massimo
  3.490 ms, nessun reboot o restart dei servizi;
- inventario finale valido salvo il probe dati UPS non disponibile;
- B3 non eseguito senza la Postazione; B4 non ripreso senza state e chiave
  privati originari; B5 e B6 restano `PENDING`.

Le evidenze fisiche redatte del 4 agosto non promuovono alcun gate formale;
l'avanzamento ufficiale resta **49%**.

## B11 - Massimo Misto Fisico/Virtuale Non-Gate

Il test massimo usa lo schema 3, profilo `mixed-physical` e mode
`MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE`.

| Ruolo | Fisici obbligatori | Virtuali | Totale |
| --- | ---: | ---: | ---: |
| Palmare | 2 | 8 | 10 |
| Postazione | 1 | 2 | 3 |
| Raspberry | 1 | 0 | 1 |
| Cassa automatica | 0 | 1 | 1 |
| Registratore RT | 0 | 1 | 1 |
| **Totale** | **4** | **12** | **16** |

La matrice dei 14 nodi Bluetooth conserva 91 link logici e 100 cicli per
link, ma l'attribuzione e separata: 6 link real-real richiedono `600/600`
cicli fisici; 40 link cross-domain forniscono `4000/4000` cicli software; 45
link virtual-only forniscono `4500/4500` cicli software. I 600 cicli surrogati
dei quattro slot fisici sono esclusi dal credito del profilo misto.

Il contratto eseguibile schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only e non puo
emettere un PASS. `600/600` azioni business fisiche, incluse `160/160` comande
Palmare, monitor continui su 4/4 attori e soak wall-clock di almeno
`7200000 ms` restano criteri per una futura versione del contratto/harness.
Ogni ciclo fisico dovra completare HELLO, autenticazione, dati bidirezionali e
cleanup; inventario, campagna fisica e simulazione dovranno avere commitment
distinti.

La futura versione resta bloccata finche non esistono manifest e receipt
fisici verificabili e byte-bound, record per ciascuno dei 6 link e dei 4
attori, timestamp verificabili e provenance live.

Le azioni business fisiche restano su `LAN_HTTP_SSE` e il business Bluetooth
deve essere zero. Nel v3 corrente `WAIVED_NON_GATE` e soltanto metadato per
una policy futura e non puo soddisfare readiness. L'inventario certifica l'APK
con SHA-256 byte-esatto e deriva la copertura signer dallo stesso binding; un
signer ignorato implica APK non certificato e risultato `INCOMPLETE`. Questa
versione non introduce una probe signer separata.

Lo stato corrente e `MIXED_NON_GATE_INCOMPLETE`: sono osservati `2/4` attori
fisici, precisamente i due Palmari; Postazione e Raspberry risultano `0/1`.
Campagna radio, workload business fisico, monitor e soak sono
`NOT_RUN`. La sostituzione virtuale dei target mancanti e vietata.

I criteri futuri non cambiano il receipt corrente: B11 resta `PENDING`, con
`gateImpact: NONE`, promozione vietata e avanzamento `49%`.

## B11 - Baseline Virtualizzata Storica Schema 2

Il test software piu grande usa lo schema 2
`MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE`. La topologia e fissa: 10 Palmari, 3
Postazioni e 1 Raspberry nel dominio Bluetooth; una cassa automatica e un
registratore fiscale RT partecipano soltanto al carico applicativo. Tutti i 16
attori sono virtuali e gli attori fisici conteggiati devono essere zero.

| Controllo | Valore obbligatorio |
| --- | ---: |
| Nodi Bluetooth | 14 |
| Coppie Android-Android | 78 |
| Link Android-Raspberry | 13 |
| Link utili | 91 |
| Cicli per link | 100 |
| Connect/disconnect | 9.100 |
| Azioni applicative | 2.600 |
| Comande Palmare | 800 |
| Transazioni cassa automatica | 100 |
| Transazioni RT | 100 |

Il workload business resta `LAN_HTTP_SSE`; nessun frame business passa su
Bluetooth. ADB, SSH, radio, servizi e periferiche reali non vengono consultati.
Il report puo essere soltanto `NON_GATE_PASS` o `NON_GATE_FAIL`, conserva B11
`PENDING`, `gateImpact: NONE`, promozione vietata e avanzamento `49%`. Lo schema
1 storico da 10 nodi, 45 coppie e `4500/4500` resta una regressione separata e
deve conservare il proprio digest canonico.

## Target generali

- zero crash/ANR;
- zero duplicate upper-layer delivery;
- discovery reciproca entro il limite p95;
- direct session recovery;
- outbox persistence across process/device restart.
