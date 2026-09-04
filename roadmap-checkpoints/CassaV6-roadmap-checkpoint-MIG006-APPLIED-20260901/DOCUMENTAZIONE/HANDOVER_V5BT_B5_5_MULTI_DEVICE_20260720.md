# Handover Cassa V5BT B5.5 multi-device

Data: 2026-07-20

## Workspace autorevole

```text
D:\cassav2\CASSAV5BT_CURRENT\cassa V5BT
```

Le modifiche applicative vanno eseguite in `SORGENTE_SISTEMA`. Le app Android
sono in `APPLICATIVI/Palmare/android-app` e
`APPLICATIVI/Postazione/android-app`. La roadmap Bluetooth autorevole e:

```text
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719
```

## Stato validato

- due Palmare Advanced su SM-A165F, Android API 36: installati e operativi;
- un tablet Postazione Advanced su SM-T503, Android API 31: installato;
- discovery simultanea tra i due palmari: PASS applicativo per 30 secondi;
- ogni palmare ha visto un peer attivo, con p95 prima osservazione di 3069 ms
  e 1798 ms;
- scan e advertising: zero failure su entrambi;
- HELLO Palmare-Raspberry: PASS separato su entrambi i palmari;
- ogni HELLO ha prodotto un write, un read, MTU 517 e zero failure;
- sessioni autenticate aperte: zero, come richiesto da B5.5;
- UI smoke: HOME Palmare-1, login Palmare-2 e login landscape Postazione;
- processi app vivi e zero crash/ANR osservati dopo il lancio.

Il tablet Android API 31 non supporta il requisito Ed25519 hardware adottato
dal gate. L'app fallisce chiusa con `ED25519_UNSUPPORTED` e
`PLATFORM_UNSUPPORTED`: non e un PASS Bluetooth e non deve essere contato
come target certificato. Per la certificazione Postazione serve Android API
33 o superiore.

L'evidenza redatta, priva di seriali, MAC, NodeId, token e chiavi, e:

```text
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/
  reports/physical/v5bt-b5-5-multi-device-20260720.json
```

## APK installati

Palmare Advanced:

```text
artifacts/physical-b5-5/
  Palmare-Advanced-1.0.24-v5bt-b5.5-hello-lab-20260720-debug.apk
Package: com.sentrapa.palmare.advanced
Version: 1.0.24 (25)
SHA-256: 35406973205D0EACFA6DF8BAB8A7763515A5AC9A7A33B8758CEE997DB9BCDC6B
```

Postazione Advanced:

```text
artifacts/physical-b5-5/
  Postazione-Advanced-2.0.19-v5bt-b5.5-hello-lab-20260720-debug.apk
Package: com.sentrapa.postazione.advanced
Version: 2.0.19 (21)
SHA-256: 8D0A181A82110B423BFD8569D2E6D5FB3809A72AFB008F7D08B30FABBA23841F
```

Palmare va installata soltanto sugli smartphone. Postazione va installata
soltanto sui tablet.

## Build Android B5.5

Da una delle due directory `android-app`:

```powershell
.\gradlew.bat `
  -PcassaBluetoothLab=true `
  -PcassaBluetoothDiagnostics=true `
  -PcassaBluetoothIdentity=true `
  -PcassaBluetoothDiscovery=true `
  -PcassaBluetoothFailover=true `
  -PcassaBluetoothGattClient=true `
  -PcassaBluetoothHelloExchange=true `
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

I flag `cassaBluetoothDirectServer` e `cassaBluetoothPeerLink` devono restare
false. La build B5.5 non abilita mutual auth, session key, heartbeat o
traffico business.

## Runtime Raspberry

Runtime Cassa V5BT:

```text
Host:       192.168.0.67
Directory:  /home/admin/cassav5bt-current/cassa V5BT
Frontend:   https://192.168.0.67:5380
Backend:    http://127.0.0.1:5381
Database:   cassa_v5bt
```

Harness Bluetooth B5.5 usato nelle prove:

```text
/home/admin/cassav5bt-b5-5-20260720/raspberry
```

Al termine:

- `bluetooth.service`: active;
- adapter `hci0`: powered, non discovering e non discoverable;
- processi GATT/advertisement temporanei: zero;
- `cassav5bt-bluetooth-enrollment.service`: inactive e disabled.

Il servizio enrollment va acceso soltanto durante il provisioning e poi
fermato. Non lasciare token monouso o wrapper di enrollment nei pacchetti.

## Prossimo incremento

Il prossimo task architetturale e B5.6, mutual authentication. Deve restare
separato da session key, heartbeat e traffico business. I test minimi sono:

1. challenge/response valido su entrambi i palmari;
2. replay e identita revocata rifiutati;
3. mismatch peer e callback duplicate fail-closed;
4. cleanup dopo disconnect, timeout e owner loss;
5. zero apertura sessione prima della verifica reciproca.

La discovery a due nodi ha evidenza applicativa positiva, ma il gate formale
B2 resta aperto fino alla correlazione con una cattura controller redatta.

## Ripristino su un altro PC

1. Estrarre il pacchetto in un percorso corto.
2. Installare Node.js, JDK 17 e Android SDK 34 o superiore.
3. Eseguire `npm ci` nei progetti Node interessati.
4. Rigenerare `local.properties` per l'Android SDK locale.
5. Verificare gli hash degli APK prima dell'installazione.
6. Leggere `README_V5BT.md`, `DOCUMENTAZIONE/WORKSPACE_ATTIVA.md` e questo
   handover prima di modificare o distribuire.

Cache, `node_modules`, build Gradle, stato `.runtime` e report temporanei con
seriali ADB non sono necessari per riprendere lo sviluppo. Certificati
privati, chiavi, file `.env` reali e configurazioni restricted non devono
essere distribuiti nello ZIP sorgente: vanno rigenerati o trasferiti con un
canale separato e protetto.
