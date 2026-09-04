# B5.4 Android GATT client

## Scopo

Verificare il solo trasporto Android verso il server GATT Raspberry:

```text
discovery del candidato
connect GATT
service discovery
validazione esatta del profilo
negoziazione MTU
stato READY
cleanup
```

Il test non deve leggere o scrivere caratteristiche, attivare notifiche,
eseguire HELLO o autenticazione, creare sessioni o trasportare messaggi.

## Prerequisiti

- Raspberry ARM64 con BlueZ, `GattManager1` e adapter acceso;
- app Advanced Lab gia enrollata con identita `READY`;
- permessi Nearby Devices concessi;
- `DirectServer` e `PeerLink` disattivati;
- nessun altro server che registri lo stesso profilo durante la prova.

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
  :app:assembleDebug
```

Il flag `cassaBluetoothGattClient` e `false` senza override.

## Test locali

```powershell
.\gradlew.bat :app:testDebugUnitTest --no-daemon --max-workers=2
.\gradlew.bat `
  -PcassaBluetoothLab=true `
  -PcassaBluetoothDiagnostics=true `
  -PcassaBluetoothIdentity=true `
  -PcassaBluetoothDiscovery=true `
  -PcassaBluetoothFailover=true `
  -PcassaBluetoothGattClient=true `
  :app:lintDebug :app:assembleDebug `
  --no-daemon --max-workers=2
```

Eseguire le due app in serie per evitare contesa sulla cache Gradle condivisa.

## Prova fisica

Installare la variante corretta sul ruolo corretto:

```powershell
adb -s <palmare> install -r -g <Palmare-B5.4-Lab.apk>
adb -s <tablet> install -r -g <Postazione-B5.4-Lab.apk>
```

Sul Raspberry, da uno staging isolato, aprire il server per una finestra
controllata:

```bash
cd raspberry
npm run gate:b5-gatt-smoke -- \
  --adapter hci0 \
  --hold-ms 10000 \
  --output /tmp/v5bt-b5-4-gatt-server.json
```

Durante il hold pubblicare un advertisement v1 sintetico:

```bash
python3 scripts/register_advertisement_v1.py \
  --duration 8 \
  --node-kind raspberry \
  --alias 445566778899 \
  --boot-id 54 \
  --capabilities 8 \
  --sequence 1 \
  --server-reachable
```

Leggere il reporter privato senza copiarne identificatori:

```powershell
adb -s <target> exec-out run-as <package> `
  cat no_backup/bluetooth-gatt-client-status-v1.json
```

## Criteri PASS

- un solo tentativo per il nuovo stream candidato;
- `state=READY`;
- `profileValidated=true`;
- `negotiatedMtu` tra 23 e 517;
- una connessione, una validazione servizio e una negoziazione MTU;
- zero failure prima del campione PASS;
- nessuna read, write, subscribe o sessione;
- nessun identificatore o payload nel reporter;
- unregister e cleanup completi sul Raspberry.

`IDENTITY_NOT_READY`, permesso negato o capability assente devono lasciare il
client inattivo e non costituiscono un PASS fisico.

## Cleanup

Arrestare l'app o il servizio Lab e verificare sul Raspberry:

```bash
systemctl is-active bluetooth
busctl get-property org.bluez /org/bluez/hci0 \
  org.bluez.Adapter1 Discovering
pgrep -af run-b5-raspberry-gatt-smoke
```

La prova non deve installare unita systemd, modificare il runtime cassa
attivo o lasciare advertising, discovery o processi harness residui.
