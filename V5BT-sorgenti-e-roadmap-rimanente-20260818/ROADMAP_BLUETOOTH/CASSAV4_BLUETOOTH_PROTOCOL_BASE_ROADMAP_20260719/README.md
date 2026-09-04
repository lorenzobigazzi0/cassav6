# V5BT - Roadmap base del protocollo Bluetooth

Questo pacchetto avvia l'implementazione del **nucleo Bluetooth** di V5BT senza ESP32 e senza gateway esterni.

Il primo obiettivo non è ancora costruire tutta la rete multi-hop. È creare una base comune, sicura e misurabile nella quale:

```text
Raspberry individua automaticamente smartphone e tablet autorizzati
smartphone/tablet individuano automaticamente il Raspberry
smartphone e tablet si individuano automaticamente tra loro
Android ↔ Raspberry stabiliscono una sessione BLE diretta
Android ↔ Android stabiliscono una sessione BLE diretta
ogni nodo pubblica identità temporanea, capability e stato di raggiungibilità
il protocollo trasferisce messaggi di test, heartbeat, ACK e route advertisement
```

## Fuori scope di questo primo pacchetto

```text
ESP32
routing multi-hop attivo
load balancing tra bridge
inoltro business attraverso altri palmari
pagamenti offline
modalità serverless operativa completa
fiscale differita
Wi-Fi Direct/Nearby come data plane
```

I contratti sono però progettati per non dover essere riscritti quando verranno aggiunti multi-hop e load balancing.

## Scelta tecnica iniziale

```text
Discovery comune: BLE advertising + scanning
Data plane iniziale: BLE GATT
Android: scanner + advertiser + GATT client/server
Raspberry: BlueZ scanner + advertiser + GATT server
Autorita business: Raspberry/backend V5BT
```

Android-to-Android usa BLE puro in questo MVP. Nearby Connections resta un'opzione futura per un data plane più veloce, ma non è necessario per chiudere questa fase.

## Sequenza consigliata

```text
B0  inventario hardware e capability gate
B1  protocollo, UUID, identità e provisioning
B2  discovery BLE automatica
B3  agent Android e lifecycle
B4  nodo Raspberry BlueZ
B5  sessione diretta Android↔Raspberry
B6  sessione diretta Android↔Android
B7  framing, ACK, retry e deduplica
B8  outbox/inbox locale minima
B9  route advertisement e server reachability
B10 integrazione col command bus in modalità shadow
B11 test, soak e pilot
```

## Prompt Codex

```text
prompts/PROMPT_CODEX_MASTER_BLUETOOTH_BASE.md
```

## Comandi di validazione del kit

```bash
node --test shared/protocol/advertisement-v1.test.mjs
node --test shared/protocol/hello-v1.test.mjs
node --test shared/protocol/mutual-auth-v1.test.mjs
node --test shared/provisioning/device-registry-v1.test.mjs
node --test shared/provisioning/enrollment-transport-v1.test.mjs
node --test raspberry/scripts/enrollment-server.test.mjs
node --test shared/discovery/peer-directory-v1.test.mjs
node --test shared/discovery/scan-window-policy-v1.test.mjs
node --test scripts/run-b2-android-adb-harness.test.mjs
node scripts/run-b2-android-adb-harness.mjs --self-test
node --test scripts/advanced-certification-targets.test.mjs
node scripts/run-b2-android-gate.mjs --self-test
node --test scripts/run-b3-android-service-gate.test.mjs
node scripts/run-b3-android-service-gate.mjs --self-test
node --test scripts/collect-b4-physical-device.test.mjs
node scripts/collect-b4-physical-device.mjs --self-test
cd raspberry && npm test
node scripts/simulate-discovery-soft-state.mjs --root .
node scripts/validate-contracts.mjs --root .
node scripts/simulate-dialer-election.mjs --root .
node scripts/simulate-connectivity-state.mjs --root .
node scripts/validate-roadmap-package.mjs --root .
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v raspberry/scripts/test_register_advertisement_v1.py
python3 raspberry/scripts/register_advertisement_v1.py --self-test
node raspberry/scripts/run-b5-mutual-auth-smoke.mjs --self-test
node raspberry/scripts/run-b5-direct-control-smoke.mjs --self-test
node raspberry/scripts/run-b5-hundred-session-gate.mjs --self-test
node raspberry/scripts/run-b5-campaign-supervisor.mjs --self-test
node --test raspberry/test/b5-campaign-supervisor.test.mjs
node --test scripts/run-b5-raspberry-continuity-monitor.test.mjs
node --test scripts/b5-campaign-governance.test.mjs
node --test raspberry/test/b5-promotion-gate.test.mjs
node --test scripts/run-api31-compat-non-gate.test.mjs
node scripts/run-api31-compat-non-gate.mjs --self-test
```

### Diagnostico compatibile API 31

La Postazione affiancata API 31 usa package
`com.sentrapa.postazione.advanced.partial`, profilo
`API31_COMPAT_NON_GATE`, discovery floor `31` ed enrollment HTTPS con path
esatto `/v2/enroll` e pin SPKI obbligatorio. La build normale certificata
mantiene il floor `33`; la partial senza Bluetooth resta invariata.

Il runner `scripts/run-api31-compat-non-gate.mjs` mantiene distinti due
contratti. `--self-test` e sempre `PREPHYSICAL_SELF_TEST` e valida soltanto il
banco; una cattura schema `2` e invece marcata `PHYSICAL_DIAGNOSTIC`. Entrambi
usano una cattura privata `0600` e pubblicano un report nuovo, anch'esso `0600`
e mai sovrascritto. Il contratto forza `NON_GATE_EVIDENCE`, `gateImpact: NONE`,
avanzamento ufficiale `49`, B0-B5 `PENDING`, B6 `BLOCKED` e ogni autorizzazione
o effetto di promozione a `false`. Un risultato completo puo quindi essere
`NON_GATE_PASS`, ma non puo diventare un PASS B0-B6.

Il contratto prephysical dichiara inoltre
`endpointEvidence: TEST_CONFIGURATION_ONLY`: URL e pin usati per le build
offline non sono evidenza fisica TLS. La modalita potra cambiare soltanto dopo
un preflight separato di certificato, SAN, hostname e SPKI sullo staging.

La cattura fisica accetta esclusivamente aggregati con chiavi esatte, senza
testo libero, seriali, MAC, identita enrollment, host o percorsi. Attesta
separatamente:

- build API `31`, package/versione/codice esatti ed enrollment v2 `READY` su
  staging con P-256;
- callback radio grezze, match UUID, osservazioni valide e payload invalidi;
- capacita scan/advertise/GATT e relativo uso runtime, senza confondere una
  capability con una connessione realmente osservata;
- concorrenza scan-advertise, health Wi-Fi durante BLE e ciclo
  background/foreground;
- campioni e anomalie dei monitor Android, Raspberry e staging, inclusi
  restart, crash, ANR, logout, cambio identita/versione, reboot, regressione
  clock, gap e failure dei servizi;
- intervallo batteria configurato obbligatoriamente a `120000 ms`, numero di
  notifiche osservate e claim derivato. Meno di due notifiche produce
  `INTERVAL_NOT_ATTESTED`; non viene promosso a PASS dalla sola configurazione.

I sedici controlli fisici sono ricalcolati dagli aggregati. Un controllo non
eseguito resta `NOT_RUN`, ogni incoerenza viene rifiutata e il verdetto globale
e `NON_GATE_PASS` soltanto con `16/16 PASS`. La suite del contratto chiude
`17/17 PASS`.

```bash
node scripts/run-api31-compat-non-gate.mjs \
  --evaluate \
  --input PRIVATE_API31_CAPTURE.json \
  --output API31_REDACTED_NON_GATE_REPORT.json
```

Il registry e l'enrollment amministrativo offline B1 sono documentati in
`shared/provisioning/README.md`. Il trasporto enrollment HTTPS nativo locale,
il servizio Raspberry separato e i gate ancora aperti sono documentati in
`reports/B1_NATIVE_ENROLLMENT_TRANSPORT_20260720.md`. Il servizio e
disabilitato per default, ascolta soltanto su loopback senza configurazione
esplicita e resta separato dal runtime radio. I valori fail-closed e i path
TLS di esempio sono in `configs/raspberry.env.example`; la finestra di recovery
della risposta e in `configs/security-policy.json`.

Il trasporto limita a quattro gli enrollment elaborati contemporaneamente e
il processo HTTPS a 32 connessioni. In saturazione risponde `503
ENROLLMENT_BUSY`, chiude la connessione e indica `Retry-After: 1`. La unit
systemd applica inoltre `MemoryMax=128M`, `CPUQuota=50%`, `TasksMax=64` e
`LimitNOFILE=256`. Il controllo `/health` e positivo soltanto se il registry
V5BT privato e realmente ispezionabile.

La recovery di una risposta gia impegnata dura al massimo 600 secondi. In
quella finestra la richiesta firmata originale, se catturata integralmente, e
equivalente a un bearer per il solo recupero della risposta: body, token e
prova firmata non devono mai essere registrati, conservati da proxy o inclusi
in report.

L'identita B1 nelle app Advanced, i test, gli APK e i gate ancora aperti sono
documentati in `reports/B1_ANDROID_IDENTITY_GATE_20260719.md`. Il flag runtime
resta disattivato nelle build standard. Il trasporto nativo e implementato
localmente, ma servono ancora un endpoint Lab TLS reale con certificato
corretto e le prove AndroidKeyStore sui dispositivi fisici.

Il registratore D-Bus transitorio e l'esito della cattura fisica BlueZ sono
documentati in `reports/B1_RASPBERRY_CONTROLLER_CAPTURE_20260719.md`. BlueZ
riordina le due strutture, ma il contratto interoperabile ammette ora entrambe
le sole permutazioni esatte: il gate fisico su contenuto e budget e `PASS`.

Il core B2 condiviso, la simulazione soft-state e l'integrazione Android
feature-gated sono documentati in `reports/B2_DISCOVERY_CORE_GATE_20260719.md`
e `reports/B2_ANDROID_DISCOVERY_IMPLEMENTATION_20260719.md`. Il banco ADB
redatto e il gate reciproco a 100 cicli sono descritti in
`testing/B2_ANDROID_ADB_HARNESS.md` e
`reports/B2_ANDROID_ADB_HARNESS_20260720.md`.

## Ripresa fisica autorevole al 2026-08-03

Il Raspberry e due telefoni Android sono raggiungibili; entrambi i telefoni
restano Palmare Advanced e il tablet Postazione certificato non e collegato.
Le build Palmare Lab `1.0.36` code 37 sono state installate in modo
conservativo sui due telefoni e le identita preesistenti sono ancora `READY`,
distinte e coerenti con il registry.

L'inventario read-only e `INCOMPLETE` soltanto per il probe dati UPS. B0 ha
prodotto `SUPPLEMENTAL_FAIL`; il primo diagnostico B2 e stato fermato al ciclo
1 da `STATUS_INVALID` e resta immutabile in attesa di remediation. B3 non e
stato eseguito senza la Postazione. La sintesi storica B4 `1/10` non e
riprendibile senza state, chiave ed evidenze private originarie. B5 e B6 non
sono stati eseguiti, i servizi osservati non sono stati riavviati e nessun gate
formale e stato promosso.

Il resoconto pubblico redatto e in
`reports/V5BT_TWO_ANDROID_PHYSICAL_RESUME_20260803.md`. Questa sezione
sostituisce le precedenti note operative sulla connettivita del banco.
L'avanzamento roadmap complessiva resta **49%**.

### Chiusura radio 2026-08-04

Le build Lab usate nella chiusura radio del 4 agosto erano Palmare `1.0.36`
code 37, SHA-256
`ccfd96034ad798649e95e41ac5404aab6be7f804bba095003be59bb6f4c95587`,
e Postazione `2.0.22` code 24, SHA-256
`60cee3c61f8aeb1a3c7fa2302f78202b59d58ba20f9b4504f52922b02402214f`.
Entrambe hanno firma APK v2 valida. La cattura B0 resta
`SUPPLEMENTAL_FAIL/PENDING`: su entrambi i Palmare registra PASS per scan,
advertising, concorrenza, coesistenza Wi-Fi/BLE e foreground/background.
Client e server GATT restano `FAIL/NOT_PROVEN`; tutti i controlli di
continuita sono PASS e il runner non inferisce capability mancanti.

La policy finale arma una sola deadline di advertising LOW_LATENCY di 8
secondi alla prima osservazione valida; duplicati e update non la estendono,
mentre FAILOVER, stop e cambio generazione la invalidano. La race di scheduling
distingue `ABORTED` da `FAILED`.

Il diagnostico B2 schema 5 ha eseguito `100/100` cicli fra due Palmare: 95
`PASS`, 5 timeout e p95 19.145 ms contro il massimo di 8.000 ms. Il p95 dopo la
disponibilita dei reporter e 14.271 ms; gli errori scan, advertising, ingress e
payload sono zero. Il risultato migliora la variante con downgrade immediato,
ma e ancora `NON_GATE_EVIDENCE`: B2 resta `PENDING` e non sostituisce la prova
formale con la Postazione. B3 non e stato avviato.

L'inventario retry conferma Android, Raspberry, BlueZ, NTP, servizi, registry,
le due identita `READY` ed enrollment coerenti; il solo controllo incompleto
resta il probe dati UPS. Le verifiche chiudono Android `197/197` e `190/190`,
coerenza build `9/9`, matrice piu B3 `32/32`, B2 `34/34`, self-test B2
`128/128` e runner B0 `21/21`. L'attestazione Raspberry chiude PASS dopo
11.091.818 ms e 5.541 campioni, con gap massimo 3.490 ms e zero restart.

Lo snapshot intermedio di ricertificazione e in
`reports/V5BT_PALMARE_LAB_RECERTIFICATION_20260804.md`; la chiusura autorevole
e in `reports/V5BT_B2_RADIO_HYSTERESIS_20260804.md` e le evidenze redatte sono
sotto `reports/physical/`. Nessun gate formale e stato promosso e
l'avanzamento resta **49%**.

## Stato B3 al 2026-07-20

L'agent Android B3 e implementato localmente in Palmare Advanced e Postazione
Advanced tramite il foreground service nativo `BluetoothFailoverService`.
L'implementazione locale e `PASS`; il gate fisico B3 resta `PENDING`.
Dettagli, limiti, APK e risultati consolidati sono in
`reports/B3_ANDROID_CONNECTIVITY_AGENT_20260720.md`.

Il servizio e fail-closed. Il flag master `cassaBluetoothFailover` e `false`
per default e puo rendere attivo l'agent soltanto in una build Lab con identita
e discovery abilitate. Anche `cassaBluetoothDirectServer` e
`cassaBluetoothPeerLink` restano `false`: B3 non apre GATT server/client, non
crea sessioni e non puo entrare operativamente negli stati `DIRECT_SERVER` o
`PEER_CONNECTED`. Se uno dei due flag futuri viene richiesto durante B3, la
radio discovery viene bloccata e lo stato degrada senza aprire risorse GATT.

Prima di avviare scanner o advertiser, il coordinator richiede che il
foreground service abbia accettato il tipo `connectedDevice`. La perdita di
prerequisiti arresta la radio e rimuove tale eleggibilita. Lo stato Lab
aggregato viene scritto in un file privato separato da quello B2; la WebView,
quando il badge diagnostico e esplicitamente abilitato, riceve soltanto
`schemaVersion`, `source`, `sequence` e `state` tramite un bridge read-only.
Non esiste un comando WebView verso il servizio.

Il soak fisico obbligatorio dura esattamente 3600 secondi ed e descritto in
`testing/B3_ANDROID_SERVICE_GATE.md`. Non e stato eseguito perche il tablet
Postazione certificato non e disponibile; la coppia di Palmare non costituisce
evidenza sostitutiva. Nessun servizio V5BT e stato riavviato e server, database
e applicazioni V5BT restano intatti.

## Stato B4 al 2026-07-20

Il nodo Raspberry V5BT `cassav5bt-bluetooth-node` include ora il binding
D-Bus scanner B4.2. `DbusNextBluezPort` possiede system bus, match rule,
`Adapter1` e normalizzazione dei segnali `Device1`; `BluezAdapter` possiede
cache per-device, filtro locale UUID e recovery serializzato. Il registry
volatile continua a riusare il `PeerDirectoryV1` B2.

La feature resta `OFF` per default e il dry-run resta `ON`. Il template
systemd e isolato sotto il nome V5BT e non e stato installato o abilitato.

Sul Raspberry ARM64/BlueZ 5.82:

- typecheck e 39 test del nodo passano;
- la discovery passa da `no` a `yes` e torna a `no` dopo SIGTERM;
- un restart reale di `bluetooth.service` viene recuperato autonomamente;
- dopo ogni prova restano zero match rule, zero advertising e zero errori;
- un Palmare Advanced fisico ha prodotto 259 callback ServiceData valide in
  90 secondi, senza rifiuti, esercitando anche la rimozione di uno stream
  scaduto;
- backend V5BT e database MySQL restano sani.

Il runner B4.4 per il gate finale a dieci device e implementato e coperto da
14 test mirati. Rivalida ogni coppia report/log B4.3, usa il registry B1 per
dimostrare in memoria dieci identita attive distinte e genera soltanto un
report redatto. Il self-test non accede alla radio o al registry e non
promuove il gate.

La raccolta progressiva e posseduta separatamente da
`scripts/collect-b4-physical-device.mjs`, coperto da 17 test mirati. Il
collector usa ADB e un digest HMAC privato per impedire che lo stesso hardware
venga contato due volte, conserva le evidenze fuori dal repository e prepara
il manifest a `10/10`. Il runner accetta il collector report soltanto quando
i suoi dieci hash coincidono con le evidenze rivalidate. Il collector non puo
promuovere B4: il verdetto resta di esclusiva proprieta del runner Raspberry
e del registry B1.

La sintesi pubblica storica riporta uno slot `1/10` con 255 osservazioni
accettate in 90 secondi, zero errori e cleanup completo. Alla ripresa del
2026-08-03, tuttavia, state, chiave e coppie report/log private originarie non
sono disponibili. La sintesi pubblica non basta a rivalidare o riprendere il
ledger: non e stato ricostruito, sovrascritto o incrementato.

Il gate incrementale B4.3 ServiceData e `PASS`. Il gate B4 resta `PENDING`
perche richiede almeno 10 dispositivi fisici distinti consecutivi e gli
artefatti privati originari della raccolta storica non sono disponibili. Due
alias osservati dello stesso Palmare non valgono come due dispositivi. I
report sono
`reports/B4_RASPBERRY_BLUEZ_NODE_CORE_20260720.md` e
`reports/B4_RASPBERRY_BLUEZ_DBUS_ADAPTER_20260720.md` e
`reports/B4_3_RASPBERRY_PHYSICAL_SERVICEDATA_20260720.md` e
`reports/B4_4_PHYSICAL_COLLECTION_PROGRESS_20260720.md` e
`reports/B4_4_TEN_DEVICE_GATE_HARNESS_20260720.md`.

## Stato B5.1 al 2026-07-20

Il core puro della sessione diretta Android-Raspberry e implementato in
`shared/session/direct-session-v1.mjs` e coperto da 19 test. Congela ruoli,
sequenza lifecycle, sessionId da 128 bit, limiti MTU, barriera di
autenticazione, PING/PONG, tre heartbeat mancati e chiusura deterministica.

Questo incremento non e collegato al runtime: non registra GATT su BlueZ, non
apre `BluetoothGatt` Android, non implementa crittografia e non trasporta
messaggi. Il gate B4 resta `PENDING` a 1/10 e il gate B5 resta `PENDING`.
Dettagli in `reports/B5_1_DIRECT_SESSION_CORE_20260720.md`.

## Stato B5.2 al 2026-07-20

Il server GATT Raspberry e implementato dietro
`CASSA_BT_GATT_SERVER_ENABLED=0`. Registra ObjectManager, servizio e sette
caratteristiche tramite `GattManager1`, recupera dopo il riavvio di BlueZ e
rilascia export, match rule e bus allo stop.

Le caratteristiche sono intenzionalmente fail-closed: ogni accesso restituisce
`NotAuthorized` finche un incremento successivo non collega autenticazione e
sessione. I test Raspberry sono 54/54 localmente, i test GATT mirati sono
12/12 su ARM64 e la suite condivisa Linux e 103/103. La registrazione fisica
espone 9 interfacce, 8 managed object e 7 caratteristiche; BlueZ consuma
l'ObjectManager una volta e lo stop riporta export, match rule e bus a zero.
Lo smoke fisico B5.3 e `PASS`. Al termine di B5.3 il client Android e la
prova delle 100 sessioni non erano ancora implementati; B4 restava 1/10 e il
gate B5 `PENDING`. Dettagli in
`reports/B5_2_RASPBERRY_GATT_SERVER_20260720.md` e
`reports/B5_3_RASPBERRY_GATT_PHYSICAL_20260720.md`.

## Stato B5.4 al 2026-07-20

Il client GATT Android e implementato in Palmare Advanced e Postazione
Advanced dietro un flag dedicato `false` per default. Seleziona soltanto un
nuovo Raspberry raggiungibile con capability `GATT_SERVER`, apre
`BluetoothGatt`, valida servizio, sette caratteristiche e capability esatte,
quindi negozia l'MTU.

Le suite finali passano 138/138 test sul Palmare e 132/132 sulla Postazione;
lint e build B5.4 Lab passano su entrambe. Una prova fisica su Palmare API 36
e Raspberry ARM64/BlueZ 5.82 ha raggiunto `READY` con profilo valido, MTU 517,
un tentativo e zero failure. Gli altri due target disponibili erano
fail-closed su `IDENTITY_NOT_READY` e non vengono conteggiati come copertura.

Questo incremento non legge, scrive o sottoscrive caratteristiche, non esegue
HELLO o autenticazione e non apre sessioni. Il gate B5 da 100 sessioni resta
`PENDING`. Dettagli in `reports/B5_4_ANDROID_GATT_CLIENT_20260720.md` e
`testing/B5_ANDROID_GATT_CLIENT.md`.

## Stato B5.5 al 2026-07-20

Il contratto HELLO v1 da 51 byte e implementato sui due client Android e sul
server Raspberry. Il flag Android `cassaBluetoothHelloExchange` e il flag
Raspberry `CASSA_BT_HELLO_ENABLED` restano `false` per default.

Le suite complete passano 145/145 sul Palmare e 139/139 sulla Postazione;
lint e build Lab passano su entrambe. Una prova fisica pulita su Palmare API
36 e Raspberry ARM64/BlueZ 5.82 ha completato un write e un read HELLO con
MTU 517, zero failure e zero sessioni autenticate. Il cleanup BlueZ e
completo.

`HELLO_EXCHANGED` non equivale ad autenticazione o stato `ACTIVE`. Mutual
auth, chiave, heartbeat e gate B5 da 100 sessioni restano pendenti. Dettagli
in `reports/B5_5_ANDROID_RASPBERRY_HELLO_20260720.md` e
`testing/B5_ANDROID_RASPBERRY_HELLO.md`.

## Stato B5.6 al 2026-07-21

L'autenticazione reciproca Android-Raspberry e implementata dopo HELLO sui
due client Advanced e sul server Raspberry. Il client firma il transcript con
l'identita enrollata; il server verifica il registry, restituisce la propria
prova e accetta il finish soltanto se tutti i binding coincidono. Replay,
revoca, ordine errato, mismatch e timeout falliscono chiusi.

Due prove fisiche sequenziali, una per ciascun Palmare Advanced, hanno
raggiunto `AUTHENTICATED`. Ogni prova ha registrato esattamente un HELLO, una
prova client verificata, una prova server emessa, un finish verificato, una
sessione autenticata prima del cleanup e zero dopo. Non sono emersi failure e
le caratteristiche business sono rimaste `NotAuthorized`; al termine BlueZ
non conservava risorse del gate. Le evidenze pubblicate sono redatte e non
contengono identificatori o materiale crittografico.

B5.6 e quindi `PASS` locale, ARM64 e fisico su due Palmari. Il gate B5 da 100
sessioni resta `PENDING`: B5.7 deve ancora introdurre derivazione della chiave
di sessione e heartbeat prima dello stato `ACTIVE`. Dettagli in
`reports/B5_6_MUTUAL_AUTH_20260721.md` e
`testing/B5_ANDROID_RASPBERRY_MUTUAL_AUTH.md`.

## Stato B5.7 al 2026-08-03

Session key X25519/HKDF, conferma chiave, attivazione, heartbeat autenticato e
chiusura pulita sono implementati sui due client Advanced e sul Raspberry. Le
build Lab passano localmente; la prova fisica B5.7 e la campagna da 100
sessioni restano `PENDING` perche i prerequisiti fisici B0-B4 non sono chiusi.

Il collector schema v2 e riprendibile e fail-closed. Ogni cattura riserva un
`bootId` CSPRNG nonzero e diverso dal precedente, lo condivide soltanto tra
runner B5.7 e advertiser transitorio e non lo esporta. Stati legacy vuoti
vengono migrati atomicamente; quelli con record sono rifiutati. Stato, lock,
journal ed evidenze restano privati e il manifest nasce soltanto a `100/100`.

La matrice di certificazione condivisa fissa ora Palmare `1.0.39` code 40 e
Postazione `2.0.23` code 25, inclusi gli SHA-256. Lo snapshot corrente usa
rispettivamente
`d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65` e
`3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5`.
Il monitor ADB continuo lega
la campagna a target, versione/APK, utente, UID, PID, reporter, lifecycle
Agent, sessione autenticata e ApplicationExitInfo. Le prove radio restano
`PENDING`.

Il secondo giro offline aggiunge un supervisor con ledger tentativi schema
v1 separato dallo state collector v2. Solo
`DIRECT_CONTROL_ORCHESTRATION_TIMEOUT` con cleanup verificato e ritentabile;
tre timeout consecutivi sospendono la campagna, un successo azzera il
contatore e ogni altro errore la invalida. Ledger, journal e recovery sono
atomici, concatenati tramite hash e protetti con file `0600`, divieto di
symlink, hardlink e overwrite.

Un secondo monitor continuo copre Raspberry e controlla
`cassav5bt.service`, `bluetooth.service`, boot ID, clock, `MainPID`,
`NRestarts`, `ActiveEnterTimestampMonotonic` ed
`ExecMainStartTimestampMonotonic`. Produce un'attestazione redatta legata
alla campagna, senza hostname, PID, path o identificatori.

Il terzo giro offline estende la copertura di entrambi i monitor a ogni
tentativo registrato dal ledger, inclusi timeout e riprese prima del primo o
dopo l'ultimo commit. La finestra deve contenere esattamente
`coverageFromMs..coverageUntilMs`, l'autorizzazione deve precedere il primo
tentativo e l'attestazione Android deve avere ruolo `handheld`. Il campionamento
Android usa `ceil(duration/poll)+1` scadenze con l'ultima clampata alla durata
richiesta, anche quando la divisione non e esatta.

Ogni monitor pubblica risultato privato e attestazione come coppia
recuperabile. Il journal privato
`<private-output>.publication-v1.journal.json` lega path, campagna, documenti e
SHA-256; un riavvio con la stessa CLI completa la pubblicazione senza
sovrascrivere artefatti esistenti e poi rimuove il journal.

Il gate tecnico richiede manifest, state collector, ledger tentativi,
autorizzazione fisica B0-B4 e attestazioni Android/Raspberry della stessa
campagna. Pubblica nella stessa directory privata una coppia immutabile:
l'aggregato redatto e un receipt conforme a
`contracts/b5-technical-receipt-v1.schema.json`, creato da
`scripts/b5-technical-receipt.mjs`. Il receipt lega gli SHA-256 byte-exact di
aggregato, state, autorizzazione, matrice e attestazioni, oltre ai commitment di
campagna, raccolta, testa del ledger, prerequisiti e operatore.

Anche con tutti i controlli positivi il gate produce soltanto
`TECHNICAL_PASS`, con `b5HundredSessionGate: PENDING_REVIEW`, B5 ufficialmente
`PENDING` e B6 `PENDING`. Il parser dell'aggregato in promozione accetta solo lo
schema esatto e il promotion gate richiede anche il receipt originale. Soltanto
il gate di promozione, dopo sign-off di un revisore distinto legato allo
SHA-256 esatto dell'aggregato tecnico, puo produrre
`b5HundredSessionGate: PASS`.

L'inventario unico read-only del banco include ADB, Raspberry, BlueZ, NTP,
UPS, servizi, registry, enrollment e permessi. L'UPS e soltanto rilevato:
nessun driver o protocollo e assunto prima di vedere l'hardware reale. Il
verificatore offline confronta inoltre matrice, Gradle, package, versioni,
SHA-256 e parita dei sorgenti Bluetooth condivisi.

Tutto questo incremento e stato implementato senza contattare hardware. Non
genera evidenze fisiche, non promuove B5 e lascia l'avanzamento ufficiale al
**49%**. Dettagli in
`reports/B5_OFFLINE_CAMPAIGN_GOVERNANCE_20260803.md` e
`reports/B5_OFFLINE_EVIDENCE_BINDING_20260803.md`.

Procedure complete in `testing/B5_ANDROID_RASPBERRY_DIRECT_CONTROL.md` e
`testing/B5_PHYSICAL_CAMPAIGN_RUNBOOK.md`.

## Ricertificazione Palmare Del 2026-08-05

Il target Palmare Lab corrente e `1.0.38` code `39`, package
`com.sentrapa.palmare.advanced`. L'artefatto
`artifacts/Palmare-Advanced-v1.0.38-V5BT-B5.7-Lab-Logout-Transport-20260805-debug.apk`
ha SHA-256
`c410cae24d5f6663edb9016346842721ea94b944640df49d79ce836a861d1323`.
Postazione resta `2.0.22` code `24` con il digest gia certificato.

La ricertificazione chiude Android `210/210` e lint con `0` errori e `23`
warning. La build e stata installata in-place su due Palmare con firma, dati,
identita ed enrollment preservati. Nuovi login hanno restituito HTTP `200` con
epoch ruotato, mentre token precedenti e revocati hanno restituito HTTP `401`.
Il logout ha azzerato preferenze auth, servizi e notifiche su entrambi i
device. Per `135` secondi, oltre il tick batteria di `120` secondi, il perimetro
strettamente filtrato per package/UID ha registrato zero poller, trasporto,
batteria, audio, fatal e ANR. Il rilancio e rimasto sulla schermata di login
con tutti i contatori a zero.

Le catture B0/B1/B2, l'inventario e il monitor del 4 agosto appartengono alla
precedente build Palmare `1.0.36` e restano evidenze storiche. Non possono
essere trasferiti al nuovo APK: inventario, controlli build, monitor e prove
fisiche di gate applicabili devono essere acquisiti di nuovo con `1.0.38`.
La regressione appena eseguita e `PASS` soltanto come
`PHYSICAL_APPLICATION_REGRESSION / NON_GATE_EVIDENCE`; creazione e routing
degli eventi restano `NOT_RUN`. B0-B5 restano `PENDING`, nessun pilot o
campagna B5 e autorizzato e l'avanzamento ufficiale resta **49%**. Dettagli in
`reports/V5BT_PALMARE_NOTIFICATION_SESSION_RECERTIFICATION_20260805.md` e
`reports/V5BT_PALMARE_NOTIFICATION_SESSION_PHYSICAL_REGRESSION_20260805.md`.

## Diagnostica Fisica B0/B2 Del 2026-08-05

Due Palmare `1.0.38` code `39` hanno completato un nuovo giro non-gate. B0
ha misurato scan e advertising su entrambi, ma e rimasto
`SUPPLEMENTAL_FAIL`: GATT client/server non sono stati provati e tre
controlli dipendenti dalla concorrenza non sono stati provati sul primo
Palmare. B2 ha completato `100/100` cicli senza timeout, ma il p95 e
`16.465` ms contro il massimo di `8.000` ms. L'attestazione Raspberry ha
chiuso `PASS` su 919 campioni, mentre il logout finale ha mantenuto a zero
poller, trasporto, batteria, audio, fatal, ANR, auth, servizi, notifiche e
waiter.

La diagnosi ha separato i limiti del banco dai risultati radio: il B0 attuale
richiede un server GATT Android persistente non avviato dalla build, il test
client richiede il Raspberry e la concorrenza e campionata in modo puntuale.
Per B2, il ritardo si concentra dopo la readiness ed e compatibile con la
sequenza di finestre FAILOVER e con avvii scan troppo ravvicinati.

Le catture future B2 usano lo schema 6 con binding SHA-256 canonico alla
matrice certificata. Le future attestazioni del monitor Raspberry includono
lo SHA-256 del journal privato finalizzato. Le evidenze gia raccolte restano
immutate. B0-B5 restano `PENDING`, B6 resta chiusa e l'avanzamento ufficiale
resta **49%**. Dettagli in
`reports/V5BT_B0_B2_TWO_HANDHELD_PHYSICAL_DIAGNOSTIC_20260805.md`.

## Pilot Fisico Cooldown Del 2026-08-05

La matrice certificata corrente usa Palmare Advanced `1.0.39` code `40`,
SHA-256
`d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65`,
e Postazione Advanced `2.0.23` code `25`, SHA-256
`3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5`.
Android chiude `212/212` e `196/196`, con lint a zero errori. Il tablet
Postazione certificato era assente, quindi la relativa build e rimasta
soltanto compilata e verificata offline.

Il consolidamento finale chiude test root `49/49`, roadmap Node `300 PASS` con
`2 SKIP` storici attesi, suite Raspberry `196/196`, self-test B2 `140/140` e
suite Android `212/212` e `196/196`.

B0 supplementare su due Palmare chiude `6/7` per dispositivo in `120`
secondi. Scan, advertising, GATT server, concorrenza, Wi-Fi/BLE e
foreground/background sono PASS; GATT client e `NOT_PROVEN`; la continuita e
interamente PASS. B0 resta `PENDING`.

Il nuovo pilot B2 con cooldown completo chiude `20/20`, zero timeout o errori,
venti quiescenze da almeno `31.000` ms, p95 `5.825` ms, minimo `3.486` ms,
massimo `5.832` ms e p95 post-readiness `1.940` ms. Il risultato locale e
PASS ma resta `NON_GATE_EVIDENCE`: non sostituisce i `100` cicli formali e B2
resta `PENDING`.

Il monitor Raspberry chiude PASS su `758` campioni, `1.517.378` ms, gap
massimo `3.720` ms e zero restart. Il logout osservato per `135` secondi
mantiene a zero auth, servizi nativi target, notifiche Advanced, tag processo
rilevanti, crash, ANR e waiter. L'inventario e incompleto esclusivamente per
il protocollo UPS non disponibile.

Il ledger B4 non e stato alterato. B5 e B6 restano chiusi. Il prossimo giro
attende il tablet Postazione certificato e procede con B0 formale, B1, B2
formale da `100` cicli e B3 da `3.600` secondi. Report pubblico redatto:
`reports/physical/V5BT_B0_B2_COOLDOWN_TWO_HANDHELD_PHYSICAL_20260805.md`.
L'avanzamento ufficiale resta **49%**.

## Readiness Formale Offline B0-B3 Del 2026-08-05

Il runner B0 formale e separato dal supplementare e vincola modelli, ruoli,
matrice, sette capacita radio e continuita completa. Il dry-run non accede ad
ADB e ogni controllo assente o non PASS resta `NON_GATE_EVIDENCE/PENDING`.

B2 usa lo schema `7` e richiede `100` quiescenze monotone da almeno `31.000`
ms, una prima di ogni ciclo formale. Il pilot da `20` cicli resta separato e
non-gate. B3 e allineato alle build correnti e al controllo firma obbligatorio
prima dell'update Postazione.

Il tablet e assente e nessun gate fisico e stato promosso. B4 non e stato
ricostruito: una nuova raccolta partira da `0/10` in stato privato distinto,
dopo l'allineamento isolato del runtime Raspberry. Suite: root `49/49`, Node
roadmap `315 PASS + 2 SKIP`, Raspberry `196/196`, B0 `51/51`, B2 `151/151`,
B3 `41/41`, contratti `22/22`. Report:
`reports/V5BT_B0_B3_FORMAL_OFFLINE_READINESS_20260805.md`. Avanzamento
ufficiale: **49%**.

## Preparazione B4 Matrix 3 Del 2026-08-05

La matrice certificata passa allo schema `3` e vincola anche lo SHA-256 del
singolo certificato di firma. Verifier, inventario, B0 e B2 consumano il
medesimo binding canonico; il controllo build reale chiude `10/10` PASS.

Il collector B4 usa ora state schema `2`, rifiuta lo schema legacy e verifica
il binding completo alla matrice prima e dopo ogni operazione. Un nuovo state
privato e stato inizializzato a `0/10`, senza importare il precedente
riepilogo storico. I due preflight sui Palmare collegati hanno correttamente
restituito `ANDROID_EVIDENCE_STALE`; state invariato e zero evidenze create.

La seconda release Lab Raspberry, preparata dopo queste modifiche, contiene
`168` file piu `SHA256SUMS`, e isolata, non contiene dati privati e non e
collegata ad alcun servizio o processo. La prima release e `SUPERSEDED`.
Servizio principale e Bluetooth sono rimasti attivi e senza restart.

Suite: root `52/52`, Node roadmap `320 PASS + 2 SKIP` storici, Raspberry
`196/196`, build reale `10/10`, collector `27 PASS + 2 SKIP`. Dettagli in
`reports/V5BT_B4_MATRIX3_LEDGER_INITIALIZATION_20260805.md`. B4 resta
`PENDING` a `0/10`; B5 e B6 restano chiusi. Avanzamento ufficiale: **49%**.

## Raccolta B4 Monitorata Del 2026-08-05

Ogni futuro slot B4 e ora vincolato fail-closed a due attestazioni continue:
Android sul Palmare certificato e Raspberry sul servizio e runner esatti. Il
monitor Android `1.0.2` ricava collection e matrice solo dallo state privato, tollera
soltanto duplicati reporter ancora freschi e pubblica atomicamente con rollback.
Il monitor Raspberry ha superato anche lo smoke SSH snapshot in sola lettura.

Il collector protegge lo state da sostituzioni durante la raccolta, verifica il
commitment HMAC dell'hardware e produce un manifest privato schema `2` con
capture UUID, riferimenti e SHA-256 di entrambi i monitor. Il gate autorevole
ripete parsing canonico, binding, copertura, target e controlli sui file privati
prima di poter valutare B4.

Il primo slot fisico della nuova raccolta e stato registrato con Palmare
Advanced `1.0.39` code `40`, Android API `36`, modello `SM-A165F`. Il runner
B4.3 ha chiuso `PASS` dopo `90` secondi: `229` osservazioni accettate, zero
rifiutate, zero errori e cleanup completo. I tentativi precedenti respinti dal
contratto fail-closed non sono stati conteggiati.

Il monitor Android ha chiuso `PASS` su `61` campioni in `120` secondi, gap
massimo `2003` ms. Il monitor Raspberry ha chiuso `PASS` su `22` campioni in
`106063` ms, gap massimo `5004` ms, zero restart dei servizi e cleanup
completo. Dopo il record, il logout ha rimosso notifiche attive e servizi
Bluetooth del package; il monitor canonico ha restituito
`SESSION_LOGGED_OUT` senza produrre attestazioni.

Verifica finale: root `87/87`, monitor Android `19/19`, monitor Raspberry
`16/16`, collector `37 PASS + 2 SKIP` storici, gate slot `14/14`, gate
autorevole `16/16`, catena B4 `67 PASS + 2 SKIP`, integrazione monitor Android
`70 PASS + 2 SKIP`, Raspberry `198/198` e contratti `22/22`.

Il nuovo ledger e `1/10`, con `9` hardware distinti ancora necessari. B4 resta
`PENDING`, B5 e B6 restano chiusi. Report pubblico redatto:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_1_20260805.md`. Avanzamento ufficiale:
**49%**.

## Secondo Slot B4 Monitorato Del 2026-08-05

Il secondo Palmare fisico distinto e stato registrato una sola volta. Il run
B4.3 valido ha chiuso `PASS` su `90` secondi, `270` osservazioni accettate,
zero rifiutate, zero errori e cleanup completo. Due tentativi precedenti con
copertura monitor incompleta sono stati esclusi prima del record.

Continuita Android: `180` secondi, `91` campioni e gap massimo `2003` ms.
Continuita Raspberry: `146657` ms, `30` campioni, gap massimo `5004` ms, zero
restart e cleanup completo. State e attestazioni dello slot sono file regolari
`0600`, senza symlink o hardlink aggiuntivi.

Il logout finale ha lasciato zero notifiche attive e zero servizi nativi
target; il monitor canonico ha restituito `SESSION_LOGGED_OUT`. Sul Raspberry
i servizi sono rimasti attivi e invariati e BlueZ ha chiuso senza discovery o
advertiser.

Il ledger corrente e `2/10`, con altri `8` hardware distinti necessari. B4
resta `PENDING`, B5 e B6 restano chiusi. Report:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_2_20260805.md`. Avanzamento ufficiale:
**49%**.

## Simulazione B4 Due Piu Otto Del 2026-08-06

Il runner ibrido offline ha letto in sola lettura i due slot fisici correnti e
ha costruito soltanto in memoria gli otto slot mancanti. Il flusso logico a
dieci elementi supera ordine, unicita, hash-chain e redazione con verdetto
`NON_GATE_PASS`; test mirati `7/7 PASS` e self-test `PASS`.

Lo state e rimasto identico byte per byte e l'output privato e `0600`, senza
identificatori o riferimenti alle evidenze fisiche. Nessun manifest e stato
creato e nessun gate autorevole e stato eseguito. I simulati contano `0`: B4 e
B5 restano `PENDING`, B6 resta `BLOCKED` e servono ancora otto hardware
distinti. Report:
`reports/V5BT_B4_TWO_PHYSICAL_EIGHT_SIMULATED_NON_GATE_20260806.md`.
Avanzamento ufficiale: **49%**.

## Banco B4 Otto Palmare Web Del 2026-08-10

Gli otto slot logici mancanti sono ora disponibili anche come otto finestre
Chrome grafiche del frontend Palmare Advanced, con contesti, account, storage e
sessioni distinti. Il banco isolato usa soltanto loopback, blocca richieste
esterne, non accede ad ADB, SSH, Bluetooth o UPS e sorveglia in sola lettura il
ledger fisico ogni cinque secondi.

Il run verificato ha raggiunto `8/8` finestre e sessioni, con screenshot privati
`0600`, rendering non vuoto e test launcher `10/10 PASS`. La copertura logica
web e quindi `SIMULATED_10_OF_10` con verdetto `NON_GATE_PASS`.

Il ledger autorevole e rimasto identico a `2/10`; i web simulati contano `0`
verso il gate. B4 e B5 restano `PENDING`, B6 resta `BLOCKED` e la campagna B5
non e autorizzata. Dettagli in
`testing/B4_EIGHT_CHROME_GUI_NON_GATE.md` e
`reports/V5BT_B4_EIGHT_CHROME_GUI_NON_GATE_20260810.md`. Avanzamento
ufficiale: **49%**.

### Workload DOM B4 Su Otto Chrome

Il launcher del banco supporta ora `--workload` su otto sessioni Chrome
mobile/touch gia attive. Il profilo pianifica `20` azioni DOM per Palmare,
`160` totali, e `8` invii comanda per Palmare, `64` totali. Le azioni dello
stesso Palmare sono seriali, con massimo una in-flight e cadenza `3000 ms`; la
media richiesta fra gli invii comanda e `7000-8000 ms`. Il reporting batteria
resta configurato a `120000 ms`.

Il workload usa soltanto il DOM reale e il runtime loopback isolato. Il
supervisore mantiene il controllo delle otto sessioni e del ledger; richiesta e
risultato sono privati `0600`, vincolati e non sovrascrivibili, mentre il report
esportabile e redatto. Nessun accesso ad ADB, SSH, Bluetooth, GATT, Raspberry o
UPS e consentito.

L'esecuzione live e ancora `NOT_RUN`: un eventuale `NON_GATE_PASS` richiede
`160/160` azioni, `64/64` comande, cadenze conformi, otto sessioni preservate,
zero errori e ledger byte-identico. Il ledger fisico resta `2/10`; i Chrome
contano `0`, B4 e B5 restano `PENDING`, B5 resta `0/100` e B6 resta `BLOCKED`.
Dettagli in `testing/B4_EIGHT_CHROME_GUI_NON_GATE.md` e
`reports/V5BT_B4_EIGHT_CHROME_DOM_WORKLOAD_NON_GATE_20260810.md`.
Avanzamento ufficiale: **49%**.

## Rehearsal Web B5.7 Del 2026-08-10

Sul banco grafico `8/8` e stato aggiunto un rehearsal B5.7 rigorosamente
separato dal protocollo fisico. Il Palmare web dello slot logico `3` ha
raggiunto `ACTIVE`, completato `4/4` PING/PONG e un `CLOSE_ACK`, con zero
errori, cleanup a zero connessioni/timer e sessione autenticata preservata.
Il verdetto e `NON_GATE_PASS` su `LOOPBACK_HTTP_SIMULATION`.

Un primo tentativo WebSocket terminato per timeout resta conservato come
`NON_GATE_FAIL` privato e non e stato sovrascritto. Il run HTTP successivo e
separato. Suite launcher e pilot `19/19 PASS`; anche i quattro self-test
canonici B5 hanno chiuso PASS, esclusivamente su dati sintetici.

Nessun accesso hardware e stato eseguito, il ledger fisico resta identico a
`2/10` e le sessioni B5 ufficiali restano `0/100`. B4 e B5 sono `PENDING`, B6
e `BLOCKED`. Dettagli in `testing/B5_WEB_GUI_LOOPBACK_DIAGNOSTIC.md` e
`reports/V5BT_B5_WEB_GUI_LOOPBACK_DIAGNOSTIC_20260810.md`. Avanzamento
ufficiale: **49%**.

## Chiusura Software B6-B11 Del 2026-08-18

B6-B11 hanno verdetto `SOFTWARE PASS OFFLINE / NON-GATE`, senza blocker
software residui: elezione ruoli e A2 Android-Android, canale affidabile
DATA/ACK, store schema `3` peer-bound, route sequence persistente, diagnostica
shadow e harness B11 massimo. Il trasporto business resta `LAN_HTTP_SSE`, i
frame business BLE sono rifiutati e tutti i feature flag di prodotto restano
OFF.

Sul Raspberry B9 usa health loopback dinamico e advertiser BlueZ integrato.
Il ServiceData v1 espone soltanto `serverReachable`; route `LAN/NONE`, RTT e
queue depth restano nel frame affidabile. Health stale o regressivo forza
`serverReachable=false`. Il budget operativo
e `<=4750 ms`; batteria e UPS Raspberry restano `UNKNOWN`. I flag sono OFF
per default e non e stata raccolta evidenza fisica.

Lo storico B11 schema 1 resta `NON_GATE_PASS 4500/4500` su 10 nodi generici e
45 coppie, con digest invariato
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.
La baseline storica schema 2 usa 10 Palmari, 3 Postazioni, 1 Raspberry, 1
cassa automatica e 1 RT, tutti virtualizzati. Ha completato `9100/9100` cicli
su 91 link BT, `2600/2600` azioni, 800 comande e `100/100` transazioni per
ciascuna periferica, con business BT zero e digest
`6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37`.
La suite Raspberry corrente chiude `318/318 PASS`; focus B11+helper `17/17`.
Palmare debug e Postazione debug chiudono entrambi 59 classi e `340/340 PASS`,
zero failure, errori o skip. Il watchdog advertiser Postazione `api31Compat`
chiude `7/7 PASS` come test mirato, non come suite full della variante. Il
soak da due ore e virtuale e il report e `NON_GATE_EVIDENCE`.

Il nuovo test massimo e lo schema 3
`MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE`: 2 Palmari fisici e 8
virtuali, 1 Postazione fisica e 2 virtuali, 1 Raspberry fisico, cassa
automatica e RT virtuali. Dei 91 link logici, 6 richiedono `600/600` cicli
real-real fisici; 40 e 45 restano rispettivamente cross-domain e virtual-only
software, per `4000/4000` e `4500/4500`.

Il receipt corrente e `MIXED_NON_GATE_INCOMPLETE`: sono osservati `2/4`
attori fisici, precisamente i due Palmari; Postazione e Raspberry risultano
`0/1`. Radio, `600/600` azioni business fisiche incluse 160
comande, monitor 4/4 e soak wall-clock di almeno `7200000 ms` sono `NOT_RUN`.
I quattro slot fisici non possono essere sostituiti dai simulatori. Il
contratto eseguibile schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only e non puo
emettere un PASS. I target 4/4, 600+600, monitor e soak restano criteri di una
futura versione, bloccata finche non esistono manifest e receipt fisici
byte-bound, record verificabili per-link e per-actor, timestamp e provenance
live.

Nel v3 corrente `WAIVED_NON_GATE` e solo metadato per una policy futura e non
rende operativa la readiness. L'inventario certifica l'APK con SHA-256
byte-esatto e deriva la copertura signer dallo stesso binding: ignorare il
signer lascia l'APK non certificato e il receipt `INCOMPLETE`. Non viene
aggiunta una probe signer separata.

Nel run storico schema 2 non e stato usato o modificato hardware e nessun
servizio e stato riavviato.
Stati ufficiali invariati: B4 `2/10`, B5 `0/100`, B6 `PENDING/BLOCKED`.
Rapporto:
`reports/V5BT_B6_B11_SOFTWARE_CLOSURE_NON_GATE_20260818.md`. Documento
workspace:
`DOCUMENTAZIONE/V5BT_CHIUSURA_SOFTWARE_BLUETOOTH_20260818.md`.
Report storico schema 2:
`reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.md`.
Report massimo misto schema 3:
`reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.md`.
Avanzamento ufficiale: **49%**.
