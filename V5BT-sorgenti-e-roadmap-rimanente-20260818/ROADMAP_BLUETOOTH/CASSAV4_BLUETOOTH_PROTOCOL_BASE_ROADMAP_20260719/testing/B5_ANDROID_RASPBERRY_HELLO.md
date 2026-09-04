# B5.5 Android-Raspberry HELLO

## Scopo

Verificare il solo primo scambio del core sessione:

```text
Android READY
-> write HELLO v1
-> Raspberry valida e lega la richiesta alla connessione BlueZ
-> read HELLO v1
-> Android valida sessionId e identita pubblicizzata del Raspberry
-> HELLO_EXCHANGED
```

Questo gate non esegue autenticazione reciproca, derivazione della chiave,
heartbeat, traffico applicativo o transizione ad `ACTIVE`.

## Prerequisiti

- Raspberry ARM64 con BlueZ, `GattManager1` e adapter acceso;
- Palmare o Postazione Advanced gia enrollata con identita `READY`;
- permessi Nearby Devices concessi;
- nessun altro server con lo stesso profilo GATT durante la prova;
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
  :app:lintDebug :app:assembleDebug
```

`cassaBluetoothHelloExchange` e `false` senza override e richiede il client
GATT.

## Test locali

```powershell
cd raspberry
npm run build
node --test `
  test/b5-android-hello-smoke.test.mjs `
  test/gatt-hello-exchange.test.mjs `
  test/gatt-application.test.mjs `
  test/gatt-server-port.test.mjs

node scripts/run-b5-android-hello-smoke.mjs --self-test
```

Eseguire in serie le build delle due app Android.

## Prova fisica

Installare l'APK soltanto sul ruolo corretto e preservare i dati:

```powershell
adb -s <palmare> install -r -g <Palmare-B5.5-Lab.apk>
adb -s <tablet> install -r -g <Postazione-B5.5-Lab.apk>
```

Avviare sul Raspberry il gate per una finestra controllata:

```bash
cd raspberry
npm run gate:b5-hello-smoke -- \
  --adapter hci0 \
  --hold-ms 20000 \
  --server-node-id 123e4567-e89b-12d3-a456-426614174000 \
  --boot-id 54 \
  --capabilities 72 \
  --output /tmp/v5bt-b5-5-hello.json
```

Da una seconda shell, dopo la registrazione GATT:

```bash
python3 scripts/register_advertisement_v1.py \
  --duration 15 \
  --node-kind raspberry \
  --alias <alias-test-non-riutilizzato> \
  --boot-id 54 \
  --capabilities 72 \
  --sequence 1 \
  --server-reachable
```

Boot e capability dell'advertisement devono coincidere con quelli del server
HELLO. Leggere il reporter privato senza copiarne identificatori:

```powershell
adb -s <target> exec-out run-as <package> `
  cat no_backup/bluetooth-gatt-client-status-v1.json
```

## Criteri PASS

Android:

- `state=HELLO_EXCHANGED`;
- `profileValidated=true`;
- `helloEnabled=true`, `helloExchanged=true`;
- MTU da 54 a 517;
- un tentativo, una connessione, una validazione profilo e un MTU;
- un write iniziato/completato e un read HELLO;
- zero failure, disconnect e sessioni autenticate.

Raspberry:

- un write accettato e un read consegnato;
- una sola transizione HELLO;
- zero duplicati, conflitti, expiry, capacity reject e failure;
- zero sessioni autenticate;
- tutte le caratteristiche diverse da HELLO ancora fail-closed;
- unregister, export, match rule e bus riportati a zero.

Il report non deve contenere MAC, seriali ADB, NodeId, sessionId, nonce,
chiavi o payload.

## Cleanup

```bash
systemctl is-active bluetooth.service
bluetoothctl show
pgrep -af 'run-b5-android-hello|register_advertisement_v1'
```

Bluetooth deve restare attivo, discovery deve tornare allo stato iniziale e
non devono rimanere processi del gate.
