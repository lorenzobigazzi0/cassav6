# B5.5 Android-Raspberry HELLO

Data: 2026-07-20

## Decisione

- contratto HELLO v1 fisso da 51 byte: PASS;
- adapter HELLO Raspberry: PASS;
- implementazione Palmare Advanced: PASS;
- implementazione Postazione Advanced: PASS;
- flag dedicati default-off: PASS;
- test JVM Palmare: 145/145;
- test JVM Postazione: 139/139;
- test Raspberry mirati: 24/24;
- suite Raspberry completa: 66/66;
- lint e build Lab delle due app: PASS;
- prova fisica Palmare-Raspberry: PASS;
- copertura fisica degli altri target: non eleggibile;
- sessioni autenticate: zero;
- mutual auth, chiave e heartbeat: non implementati;
- gate B5 da 100 sessioni: PENDING.

`HELLO_EXCHANGED` certifica soltanto lo scambio e il binding alla connessione
BlueZ. Non equivale a una sessione autenticata o `ACTIVE`.

## Contratto e stato

Il frame HELLO e lungo 51 byte:

```text
protocolVersion  1 byte
sessionId       16 byte raw
nodeId          16 byte UUID raw
bootId           1 byte
capabilities     1 byte
nonce           16 byte raw
```

Il minimo MTU e 54. Android scrive la richiesta; Raspberry risponde con lo
stesso `sessionId`, la propria identita e un nonce nuovo. Android verifica
anche `bootId` e capability contro l'advertisement che ha selezionato.

Le macchine a stati Android aggiungono:

```text
READY
WRITING_HELLO
READING_HELLO
HELLO_EXCHANGED
```

Il Raspberry mantiene binding per device BlueZ con capienza 32 e TTL 30
secondi. Retry identici sono idempotenti; sostituzioni, sessionId duplicati,
MTU insufficiente e callback fuori ordine falliscono chiusi. Owner loss e
stop cancellano i binding e azzerano i buffer risposta.

Solo la caratteristica HELLO ammette read/write. Tutte le altre restano
`NotAuthorized`.

## Feature gate

Android:

```text
cassaBluetoothHelloExchange=false
```

Raspberry:

```text
CASSA_BT_HELLO_ENABLED=0
```

Entrambi richiedono i rispettivi prerequisiti GATT. Gli esempi di produzione
restano disattivati.

## Prova fisica

Target eleggibile:

```text
Android: Palmare Advanced 1.0.24, API 36
Raspberry: arm64, BlueZ 5.82, hci0
```

Android:

```text
state: HELLO_EXCHANGED
profileValidated: true
negotiatedMtu: 517
connectionAttempts: 1
connectionsEstablished: 1
servicesValidated: 1
mtuNegotiated: 1
helloWritesStarted: 1
helloWritesCompleted: 1
helloReadsCompleted: 1
helloExchanged: 1
failures: 0
authenticatedSessionCount: 0
```

Raspberry:

```text
writesAccepted: 1
readsDelivered: 1
helloExchanged: 1
failures: 0
authenticatedSessions: 0
managedObjectCount: 8
characteristicCount: 7
durationMs: 20089
```

Lo stop ha eseguito unregister e cleanup. Bluetooth e rimasto attivo,
discovery e tornata disattivata e non sono rimasti processi gate.

Gli altri due smartphone erano `IDENTITY_NOT_READY`; il tablet Postazione
era `PLATFORM_UNSUPPORTED`. Il comportamento fail-closed e corretto, ma non
viene contato come copertura fisica.

Evidenze redatte:

```text
reports/physical/v5bt-b5-5-android-hello-20260720.json
SHA-256 9dcd97e0ed3a3ebc121d8e4ca5f0456d67bd021f20a41f138135ed454be9e9c4

reports/physical/v5bt-b5-5-raspberry-hello-20260720.json
SHA-256 5e7a74d22de58101d61560f97f512cf4eac67e66fb860ffa3ab62319593a862f
```

## Build certificate

```text
Palmare Advanced
versionName: 1.0.24
versionCode: 25
size: 16461061 byte
SHA-256: 35406973205d0eacfa6df8bab8a7763515a5ac9a7a33b8758cee997db9bcdc6b

Postazione Advanced
versionName: 2.0.19
versionCode: 21
size: 14991715 byte
SHA-256: 8d0a181a82110b423bfd8569d2e6d5fb3809a72afb008f7d08b30fabba23841f
```

Artefatti:

```text
artifacts/Palmare-Advanced-v1.0.24-V5BT-Bluetooth-B5.5-Lab-debug.apk
artifacts/Postazione-Advanced-v2.0.19-V5BT-Bluetooth-B5.5-Lab-debug.apk
```

## Prossimo incremento

B5.6 deve implementare la mutual authentication usando le identita enrollate,
senza ancora aprire traffico business. Devono essere coperti challenge,
response, replay, identita revocata, mismatch del peer e cleanup delle prove.
