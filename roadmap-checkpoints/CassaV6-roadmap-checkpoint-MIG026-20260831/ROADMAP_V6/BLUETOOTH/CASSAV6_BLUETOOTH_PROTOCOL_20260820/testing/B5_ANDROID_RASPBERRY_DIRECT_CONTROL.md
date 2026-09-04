# B5.7 Android-Raspberry direct control

## Scopo

Verificare una sola sessione fisica sequenziale dopo HELLO e autenticazione
reciproca:

```text
AUTHENTICATED
-> scambio X25519 e conferma della chiave derivata
-> KEY_ESTABLISHED
-> PING/PONG di attivazione
-> ACTIVE
-> almeno tre cicli PING/PONG autenticati
-> CLOSE/CLOSE_ACK autenticati
-> CLOSED
```

Il gate non abilita traffico business. Le relative caratteristiche devono
restare fail-closed per tutta la prova.

## Prerequisiti

- Raspberry ARM64 con BlueZ, `GattManager1` e adapter acceso;
- registry V6 `0600` leggibile dal solo utente runtime autorizzato;
- Palmare Advanced o Postazione Advanced enrollata e in stato `READY`;
- Android API 33 o superiore e permessi Nearby Devices concessi;
- MTU negoziato almeno 101;
- nessun altro server con lo stesso profilo GATT durante la prova;
- un solo client Advanced acceso e raggiungibile alla volta;
- `DirectServer` e `PeerLink` disattivati.

## Build Android

Da `APPLICATIVI/Palmare/android-app` oppure
`APPLICATIVI/Postazione/android-app`:

```powershell
.\gradlew.bat `
  -PcassaBluetoothLab=true `
  -PcassaBluetoothDiagnostics=true `
  -PcassaBluetoothIdentity=true `
  -PcassaBluetoothDiscovery=true `
  -PcassaBluetoothFailover=true `
  -PcassaBluetoothGattClient=true `
  -PcassaBluetoothHelloExchange=true `
  -PcassaBluetoothMutualAuth=true `
  -PcassaBluetoothSessionKey=true `
  -PcassaBluetoothHeartbeat=true `
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

I flag di chiave e heartbeat sono disattivati senza override. I flag di
server Android e peer link devono restare disattivati.

## Test locali

Dal package roadmap:

```bash
node --test shared/protocol/direct-control-v1.test.mjs
node --test \
  raspberry/test/direct-control-handshake.test.mjs \
  raspberry/test/gatt-direct-control.test.mjs \
  raspberry/test/gatt-application.test.mjs \
  raspberry/test/b5-direct-control-smoke.test.mjs
node raspberry/scripts/run-b5-direct-control-smoke.mjs --self-test
```

Eseguire in serie le build delle due app Android.

## Prova fisica

Installare l'APK soltanto sul ruolo corretto e preservare i dati enrollati:

```bash
adb -s <palmare> install -r -g <Palmare-B5.7-Lab.apk>
adb -s <tablet> install -r -g <Postazione-B5.7-Lab.apk>
```

Avviare il gate sul Raspberry per una finestra controllata. Il processo deve
usare un runtime versionato, non un servizio persistente:

```bash
sudo -u cassav6 node raspberry/scripts/run-b5-direct-control-smoke.mjs \
  --adapter hci0 \
  --hold-ms 60000 \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --server-node-id <uuid-server-canonico> \
  --boot-id 54 \
  --capabilities 72 \
  --output /tmp/v6-b5-7-direct-control.json
```

Da una seconda shell, dopo la registrazione GATT:

```bash
python3 raspberry/scripts/register_advertisement_v1.py \
  --duration 55 \
  --node-kind raspberry \
  --alias <alias-test-non-riutilizzato> \
  --boot-id 54 \
  --capabilities 72 \
  --sequence 1 \
  --server-reachable
```

Boot e capability devono coincidere. Attivare un solo client Android e
leggere il reporter privato senza copiarne identificatori:

```bash
adb -s <target> exec-out run-as <package> \
  cat no_backup/bluetooth-gatt-client-status-v1.json
```

Lasciare il client connesso. Dopo almeno tre PONG verificati il gate richiede
automaticamente la chiusura normale dell'unica sessione attiva. Il client
deve rispondere con `CLOSE_ACK` prima che scada la finestra del gate.

## Criteri PASS

Android:

- una sola chiave stabilita e stato `ACTIVE` raggiunto una sola volta;
- una share client scritta, una share server verificata e una conferma client
  scritta;
- almeno tre PING ricevuti e tre PONG scritti dopo l'attivazione;
- un frame CLOSE ricevuto, un CLOSE_ACK scritto e una sola chiusura pulita;
- zero failure, timeout, callback duplicate e mismatch di binding;
- nessun traffico business durante il gate.

Raspberry:

- un solo HELLO e una sola autenticazione reciproca completati;
- una share client accettata, una share server emessa e una conferma client
  verificata;
- una sola transizione `KEY_ESTABLISHED` e una sola transizione `ACTIVE`;
- almeno tre PING inviati e tre PONG autenticati;
- una sola chiusura pulita, senza timeout o chiusura forzata;
- zero sessioni attive, timer e buffer segreti trattenuti dopo la chiusura;
- caratteristiche business ancora `NotAuthorized`;
- unregister, export, match rule e bus riportati a zero.

Il report deve essere rigidamente redatto: nessun MAC, seriale ADB, NodeId,
certificateId, sessionId, nonce, chiave, payload o percorso locale.

Questo smoke convalida una singola sessione fisica. Non chiude il gate B5 da
100 sessioni, che resta `PENDING` fino alla campagna dedicata.

## Preparazione del gate B5 da 100 sessioni

Validatore, collector, supervisor e monitor hanno test offline che non
modificano runtime e non promuovono gate:

```bash
node raspberry/scripts/collect-b5-direct-control-session.mjs --self-test
node scripts/run-b5-android-continuity-monitor.mjs --self-test
node --test scripts/run-b5-raspberry-continuity-monitor.test.mjs
node raspberry/scripts/run-b5-campaign-supervisor.mjs --self-test
node raspberry/scripts/run-b5-hundred-session-gate.mjs --self-test
```

Ogni `PASS` usa fixture sintetiche, lascia
`b5HundredSessionGate=PENDING` e non vale come evidenza fisica.

La campagna ufficiale deve passare dal supervisor, che e l'unico owner del
collector riprendibile. Il collector non accetta report da importare, un
runner alternativo o uno slot scelto dall'operatore:
invoca direttamente il runner B5.7, avvia l'advertising solo dopo la
registrazione GATT e assegna il successivo slot canonico `001`..`100`. Ogni
cattura riserva nello state privato un `bootId` CSPRNG nonzero e diverso dal
precedente; non impostare `CASSA_BT_HELLO_BOOT_ID` manualmente.

Preparare una directory privata, inizializzare uno state nuovo e il ledger
tentativi sullo stesso `campaignRunId`, quindi usare il preflight supervisor
non mutante:

```bash
install -d -m 0700 -o cassav6 -g cassav6 \
  /var/lib/cassav6-bluetooth/b5-campaign

sudo -u cassav6 node raspberry/scripts/collect-b5-direct-control-session.mjs \
  --init \
  --state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json

sudo -u cassav6 node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --init \
  --ledger /var/lib/cassav6-bluetooth/b5-campaign/b5-official-attempts.json \
  --state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json

sudo -u cassav6 node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --preflight \
  --ledger /var/lib/cassav6-bluetooth/b5-campaign/b5-official-attempts.json \
  --state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json
```

La matrice condivisa fissa Palmare `1.0.39` code 40, SHA-256
`d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65`,
artefatto
`artifacts/Palmare-Advanced-v1.0.39-V6-B0-B2-Cooldown-Lab-20260805-debug.apk`,
e Postazione `2.0.23` code 25 con il rispettivo SHA-256 Lab. Lo stesso Palmare,
Android user, account,
package e APK devono restare invariati per tutti i 100 record. Prima dello
slot `001`, l'autorizzazione B0-B4 deve essere emessa e i monitor Android e
Raspberry devono catturare le baseline e partire con il medesimo
`campaignRunId` dello state. L'autorizzazione deve precedere il primo tentativo
del ledger. Entrambi i monitor devono coprire tutti i tentativi, inclusi timeout
e riprese, da `coverageFromMs` a `coverageUntilMs`; il target Android ufficiale
deve avere ruolo `handheld`. La CLI completa e la config esatta sono in
`testing/B5_PHYSICAL_CAMPAIGN_RUNBOOK.md`.

Le evidenze fisiche raccolte con Palmare `1.0.36` sono storiche e non
autorizzano questa procedura. Prima del pilot e della campagna occorre
riacquisire con `1.0.39` inventario, attestazioni e tutti i prerequisiti fisici
applicabili. B0-B5 restano `PENDING`.

Risultato privato e attestazione di ciascun monitor sono una coppia
recuperabile tramite
`<private-output>.publication-v1.journal.json`. Il campionamento usa
`ceil(duration/poll)+1` scadenze e clampa l'ultima alla durata richiesta. Un
journal residuo si recupera rieseguendo la stessa CLI completa; non modificare
o sovrascrivere gli artefatti.

Nella shell privata Raspberry impostare la configurazione Lab. Identita e
registry non devono apparire in report o log:

```bash
sudo -u cassav6 -H bash

export CASSA_BT_FEATURE_ENABLED=1
export CASSA_BT_DRY_RUN=0
export CASSA_BT_GATT_SERVER_ENABLED=1
export CASSA_BT_HELLO_ENABLED=1
export CASSA_BT_MUTUAL_AUTH_ENABLED=1
export CASSA_BT_DIRECT_CONTROL_ENABLED=1
export CASSA_BT_ADAPTER=hci0
export CASSA_BT_DEVICE_REGISTRY_PATH=/var/lib/cassav6-bluetooth/devices.json
export CASSA_BT_NODE_ID=<uuid-server-canonico>
export CASSA_BT_HELLO_CAPABILITIES=72
```

Con un solo client Advanced attivo, acquisire una sessione alla volta
esclusivamente tramite il supervisor:

```bash
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --capture \
  --ledger /var/lib/cassav6-bluetooth/b5-campaign/b5-official-attempts.json \
  --state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json
```

Ogni cattura valida crea un report `0600` nella directory evidence, aggiorna
lo stato con scrittura atomica e rimuove il journal soltanto dopo il commit.
Un riavvio successivo rivalida un commit gia completato; se l'interruzione e
avvenuta prima del commit, elimina journal ed evidenza staged e ripete lo
stesso slot. Un fallimento radio, un cambio target, timestamp sovrapposti, una
variazione dei servizi o un'evidenza manomessa lasciano il conteggio invariato.
Un lock kernel protegge lo stato e un secondo lock, condiviso per adattatore,
impedisce a due campagne di usare contemporaneamente lo stesso controller.
Solo un timeout RF isolato e ritentabile sullo stesso slot; tre timeout
consecutivi sospendono la campagna. Crash, ANR, logout, restart, ADB gap,
cambio target/versione/account, clock regression, tamper o cleanup incompleto
invalidano lo state.

Controllare il progresso senza avviare una nuova cattura:

```bash
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --status \
  --ledger /var/lib/cassav6-bluetooth/b5-campaign/b5-official-attempts.json \
  --state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json
```

A `100/100`, finalizzare il manifest. Il collector rifiuta la finalizzazione
anticipata e continua a dichiarare il gate `PENDING`:

```bash
node raspberry/scripts/collect-b5-direct-control-session.mjs \
  --finalize \
  --state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json \
  --manifest /var/lib/cassav6-bluetooth/b5-campaign/b5-hundred-session-manifest.json
```

Lasciare terminare naturalmente entrambi i monitor e aggregare la raccolta
completa:

```bash
node raspberry/scripts/run-b5-hundred-session-gate.mjs \
  --manifest /var/lib/cassav6-bluetooth/b5-campaign/b5-hundred-session-manifest.json \
  --campaign-state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json \
  --attempt-state /var/lib/cassav6-bluetooth/b5-campaign/b5-official-attempts.json \
  --android-attestation /var/lib/cassav6-bluetooth/b5-campaign/b5-android-attestation.json \
  --raspberry-attestation /var/lib/cassav6-bluetooth/b5-campaign/b5-raspberry-attestation.json \
  --campaign-authorization /var/lib/cassav6-bluetooth/b5-campaign/b5-campaign-authorization.json \
  --output /var/lib/cassav6-bluetooth/b5-campaign/b5-technical-aggregate.json \
  --technical-receipt /var/lib/cassav6-bluetooth/b5-campaign/b5-technical-receipt.json
```

Il validatore richiede per ogni slot un report B5.7 con `mode=PHYSICAL`,
`verdict=PASS`, `physicalRadioAccessed=true`, tutti i campi privacy falsi,
una sola catena HELLO/autenticazione/chiave/ACTIVE/chiusura, almeno quattro
PING e quattro PONG, zero failure e zero risorse residue. Rifiuta report
identici, timestamp duplicati, finestre sovrapposte, target cambiato,
commitment/finestra monitor incoerenti e contatori non conformi.

L'aggregato contiene soltanto totali redatti. Non contiene commitment, UUID,
nomi o percorsi dei file, digest per sessione, identificatori, indirizzi,
materiale crittografico o corpi messaggio. Il gate pubblica nella stessa
directory privata anche un receipt schema v1 immutabile. Il receipt lega gli
SHA-256 byte-exact di aggregate, state, authorization, matrice e attestazioni,
oltre ai commitment campaign/collection, alla testa del ledger tentativi, ai
prerequisiti B0-B4 e all'operatore.

Dopo `TECHNICAL_PASS` serve una revisione umana indipendente. La promozione
richiede sempre entrambi gli artefatti:

```bash
node raspberry/scripts/run-b5-promotion-gate.mjs \
  --technical-aggregate /var/lib/cassav6-bluetooth/b5-campaign/b5-technical-aggregate.json \
  --technical-receipt /var/lib/cassav6-bluetooth/b5-campaign/b5-technical-receipt.json \
  --campaign-state /var/lib/cassav6-bluetooth/b5-campaign/campaign.b5-session-gate-state.json \
  --campaign-authorization /var/lib/cassav6-bluetooth/b5-campaign/b5-campaign-authorization.json \
  --review-attestation /var/lib/cassav6-bluetooth/b5-campaign/b5-independent-review.json \
  --output /var/lib/cassav6-bluetooth/b5-campaign/b5-promotion.json
```

Il parser dell'aggregato accetta soltanto il set esatto di campi. Assenza o
mismatch del receipt lascia B5 `PENDING`; B6 resta `PENDING` fino alla
promozione formale e al successivo avvio separato della fase.

## Cleanup

```bash
systemctl is-active bluetooth.service
bluetoothctl show
pgrep -af 'collect-b5-direct-control|run-b5-direct-control|register_advertisement_v1'
```

Bluetooth deve restare attivo, discovery deve tornare allo stato iniziale e
non devono rimanere processi o advertising del gate. Il servizio enrollment
deve essere fermato e disabilitato prima della prova radio.
