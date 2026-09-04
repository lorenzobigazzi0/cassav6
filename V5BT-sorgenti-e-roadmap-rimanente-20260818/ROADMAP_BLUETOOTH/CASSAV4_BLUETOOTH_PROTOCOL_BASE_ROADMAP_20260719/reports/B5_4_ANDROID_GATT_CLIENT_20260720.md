# B5.4 Android GATT client

Data: 2026-07-20

## Decisione

- implementazione Palmare Advanced: PASS;
- implementazione Postazione Advanced: PASS;
- flag dedicato default-off: PASS;
- test JVM Palmare: 138/138;
- test JVM Postazione: 132/132;
- lint e build Lab delle due app: PASS;
- prova fisica Palmare-Raspberry: PASS;
- copertura fisica Postazione e secondo Palmare: non eleggibile, identita B1
  non pronta;
- letture, scritture e sottoscrizioni GATT: non implementate;
- HELLO, autenticazione e session key: non implementati;
- sessioni aperte: zero;
- gate B5 da 100 sessioni: PENDING.

Il PASS chiude solo l'incremento B5.4. `READY` indica che connessione,
profilo e MTU sono validi; non indica una sessione autenticata.

## Implementazione

Palmare e Postazione hanno la stessa implementazione in:

```text
app/src/main/java/com/sentrapa/webkiosk/bluetooth/
  AndroidGattProfileV1.kt
  AndroidGattClientStateMachine.kt
  AndroidGattClient.kt
  BluetoothGattClientLabReporter.kt
  BleScanner.kt
  BluetoothDiscoveryCoordinator.kt
  BluetoothFailoverFeaturePolicy.kt
  BluetoothFailoverService.kt
```

`AndroidGattProfileV1` congela il servizio, le sette caratteristiche e le
capability esatte del contratto v1. Il client richiede un MTU preferito di
247 e accetta soltanto valori tra 23 e 517.

La policy seleziona soltanto un peer appena osservato che soddisfa tutte le
condizioni:

```text
nodeKind = RASPBERRY
serverReachable = true
capability GATT_SERVER presente
osservazione ADDED oppure CAPACITY_EVICTED_ADDED
```

Duplicati e aggiornamenti dello stesso stream non generano nuove connessioni.
Il lifecycle e posseduto da una macchina a stati unica:

```text
IDLE -> CONNECTING -> DISCOVERING_SERVICES
     -> NEGOTIATING_MTU -> READY

errore -> FAILED
close  -> CLOSED
```

Eventi fuori ordine vengono rifiutati senza modificare lo stato. `FAILED`
puo essere resettato all'arrivo di un nuovo candidato; `CLOSED` e terminale.
Il callback GATT ha un solo owner e le risorse vengono chiuse in modo
idempotente.

## Feature gate

Il nuovo flag Gradle e:

```text
cassaBluetoothGattClient=false
```

Per abilitarlo servono anche Lab, diagnostics, identity, discovery e
failover. `cassaBluetoothDirectServer` e `cassaBluetoothPeerLink` restano
false. Se uno dei flag di sessione futura viene richiesto, il servizio
fallisce chiuso e non apre il client.

Il reporter Lab scrive soltanto stato e metriche aggregate in:

```text
no_backup/bluetooth-gatt-client-status-v1.json
```

Il file non contiene seriale, indirizzo BLE, alias, NodeId, sessionId, chiavi
o payload.

## Prova fisica

Target:

```text
Android: Palmare Advanced 1.0.23, API 36, GATT client
Raspberry: arm64, BlueZ 5.82, hci0, GATT server
```

Il Raspberry ha esposto il profilo B5.2 e, durante la stessa finestra, un
advertisement v1 connectable con `serverReachable=true` e capability
`GATT_SERVER`.

Risultato Android:

```text
state: READY
profileValidated: true
negotiatedMtu: 517
connectionAttempts: 1
connectionsEstablished: 1
servicesValidated: 1
mtuNegotiated: 1
disconnects: 0
failures: 0
sessionsOpened: 0
```

Il server ha mantenuto otto managed object e sette caratteristiche, poi ha
eseguito unregister e cleanup. Il secondo Palmare e la Postazione sono
rimasti `IDLE` perche la discovery era fail-closed su
`IDENTITY_NOT_READY`; non vengono conteggiati come prove fisiche passate.

Evidenza redatta:

```text
reports/physical/v5bt-b5-4-android-gatt-client-20260720.json
```

## Build certificate

```text
Palmare Advanced
versionName: 1.0.23
versionCode: 24
size: 16447125 byte
SHA-256: e142862618f2de0dcdd1a2381d92344ec998fce001c6c259a4c40f52c91179dc

Postazione Advanced
versionName: 2.0.18
versionCode: 20
size: 14977787 byte
SHA-256: 0bf744a185033875e4a9060aa4896bac5a00383d1a8d986ecea48a9d10963086
```

Artefatti:

```text
artifacts/Palmare-Advanced-v1.0.23-V5BT-Bluetooth-B5.4-Lab-debug.apk
artifacts/Postazione-Advanced-v2.0.18-V5BT-Bluetooth-B5.4-Lab-debug.apk
```

## Limiti e prossimo incremento

B5.4 non usa alcuna caratteristica e non importa il core B5.1 nel runtime.
Il prossimo incremento B5.5 deve collegare i due trasporti al solo scambio
HELLO, con test di mismatch, timeout, duplicate callback e cleanup. Mutual
auth, session key, heartbeat e gate delle 100 sessioni restano separati.
