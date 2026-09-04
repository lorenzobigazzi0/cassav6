# B5.6 Android-Raspberry mutual authentication

## Scopo

Verificare la sola autenticazione reciproca legata ai due HELLO gia accettati:

```text
Android HELLO_EXCHANGED
-> subscribe controlTx
-> write client proof Ed25519 su controlRx
-> Raspberry valida registry e pubblica server proof HMAC su controlTx
-> Android valida server proof e scrive finish HMAC su controlRx
-> AUTHENTICATED
```

Il gate non deriva chiavi di sessione, non avvia heartbeat, non raggiunge
`ACTIVE` e non abilita traffico business.

## Prerequisiti

- Raspberry ARM64 con BlueZ, `GattManager1` e adapter acceso;
- registry V6 `0600` leggibile dal solo utente runtime autorizzato;
- Palmare o Postazione Advanced enrollata e in stato `READY`;
- Android API 33 o superiore e permessi Nearby Devices concessi;
- MTU negoziato almeno 101;
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
  -PcassaBluetoothMutualAuth=true `
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

`cassaBluetoothMutualAuth` e `false` senza override e richiede HELLO. I flag
di server Android, peer link, session key e heartbeat restano disattivati.

## Test locali

Dal package roadmap:

```bash
node --test shared/protocol/mutual-auth-v1.test.mjs
node --test \
  raspberry/test/gatt-mutual-auth.test.mjs \
  raspberry/test/mutual-auth-handshake.test.mjs \
  raspberry/test/gatt-application.test.mjs \
  raspberry/test/b5-mutual-auth-smoke.test.mjs
node raspberry/scripts/run-b5-mutual-auth-smoke.mjs --self-test
```

Eseguire in serie le build delle due app Android.

## Prova fisica

Installare l'APK soltanto sul ruolo corretto e preservare i dati enrollati:

```bash
adb -s <palmare> install -r -g <Palmare-B5.6-Lab.apk>
adb -s <tablet> install -r -g <Postazione-B5.6-Lab.apk>
```

Avviare il gate sul Raspberry per una finestra controllata. Il processo deve
usare un runtime versionato, non un servizio persistente:

```bash
sudo -u cassav6 node raspberry/scripts/run-b5-mutual-auth-smoke.mjs \
  --adapter hci0 \
  --hold-ms 30000 \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --server-node-id <uuid-server-canonico> \
  --boot-id 54 \
  --capabilities 72 \
  --output /tmp/v6-b5-6-mutual-auth.json
```

Da una seconda shell, dopo la registrazione GATT:

```bash
python3 raspberry/scripts/register_advertisement_v1.py \
  --duration 25 \
  --node-kind raspberry \
  --alias <alias-test-non-riutilizzato> \
  --boot-id 54 \
  --capabilities 72 \
  --sequence 1 \
  --server-reachable
```

Boot e capability devono coincidere. Attivare un solo client Android alla
volta e leggere il reporter privato senza copiarne identificatori:

```bash
adb -s <target> exec-out run-as <package> \
  cat no_backup/bluetooth-gatt-client-status-v1.json
```

## Criteri PASS

Android:

- `state=AUTHENTICATED` e `authenticatedSessionCount=1`;
- profilo valido, HELLO scambiato e MTU da 101 a 517;
- una sottoscrizione controlTx iniziata e completata;
- un client proof scritto, un server proof verificato e un finish scritto;
- zero failure, timeout, callback duplicate e mismatch di binding;
- nessuna chiave di sessione, heartbeat o sessione business.

Raspberry:

- un HELLO write/read e una sola transizione HELLO;
- un client proof verificato, un server proof emesso e un finish verificato;
- una sessione autenticata prima del cleanup e zero dopo il cleanup;
- zero duplicati, replay, auth failure, expiry, conflitti e failure;
- caratteristiche business ancora `NotAuthorized`;
- unregister, export, match rule e bus riportati a zero.

Il report non deve contenere MAC, seriali ADB, NodeId, certificateId,
sessionId, nonce, chiavi o payload.

## Esito del 2026-07-21

Il gate B5.6 e `PASS` su due Palmari Advanced fisici, provati in sequenza con
un solo client attivo alla volta. In entrambe le prove Android e Raspberry
hanno completato HELLO, prova client, prova server e finish, raggiungendo una
sola sessione `AUTHENTICATED` con zero failure. Il cleanup ha riportato a zero
le sessioni autenticate e le risorse BlueZ; le caratteristiche business sono
rimaste fail-closed.

Le evidenze pubblicate sono i due report redatti sotto `reports/physical/`.
B5.6 non chiude il gate B5 da 100 sessioni, che resta `PENDING`. Il prossimo
incremento B5.7 deve implementare chiave di sessione e heartbeat prima dello
stato `ACTIVE`.

## Cleanup

```bash
systemctl is-active bluetooth.service
bluetoothctl show
pgrep -af 'run-b5-mutual-auth|register_advertisement_v1'
```

Bluetooth deve restare attivo, discovery deve tornare allo stato iniziale e
non devono rimanere processi o advertising del gate. Il servizio enrollment
deve essere fermato e disabilitato prima della prova radio.
