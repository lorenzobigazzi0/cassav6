# Postazione Advanced Android - V5BT

Wrapper Android landscape V5BT con package
`com.sentrapa.postazione.advanced`. L'app apre la WebView in modalita kiosk,
serve il bundle `/postazione` dall'APK e mantiene API, SSE e WebSocket sulla
stessa origine HTTPS configurata.

Tutti i flag Gradle Bluetooth sono `false` per default:
`cassaBluetoothLab`, `cassaBluetoothDiagnostics`,
`cassaBluetoothIdentity`, `cassaBluetoothDiscovery`,
`cassaBluetoothFailover`, `cassaBluetoothGattClient`,
`cassaBluetoothDirectServer`,
`cassaBluetoothPeerLink`, `cassaBluetoothDiagnosticBadge` e
`cassaBluetoothEnrollment`. Il master failover richiede insieme build Lab,
identity e discovery; la radio fallisce chiusa senza identita pronta, permessi
BLE, adapter attivo e classificazione `FULL_NODE`.

## Variante parziale senza Bluetooth

Per i test operativi su una Postazione API 31 con firma non aggiornabile si
puo generare una variante affiancata e non-gate:

```bash
./gradlew \
  -PcassaPartialDefaultServerUrl=https://192.168.1.79:5380/postazione/ \
  :app:testPartialUnitTest :app:lintPartial :app:assemblePartial
```

La variante usa package `com.sentrapa.postazione.advanced.partial`, label
`Postazione Advanced V5BT Partial`, storage separato e version name
`2.0.23-partial`. Anche se vengono passati per errore flag Bluetooth Lab, il
build parziale li forza tutti a `false`, disabilita il relativo servizio e si
dichiara nel manifest come `PARTIAL_NON_GATE`. Login, scelta Postazione,
frontend HTTPS e integrazioni operative restano disponibili. Questa variante
non puo produrre evidenza o promuovere i gate Bluetooth V5BT.

## Variante Bluetooth API 31 compat

La build `api31Compat` aggiorna in modo conservativo lo stesso package
affiancato della partial, quindi conserva login e storage senza sostituire la
Postazione base:

```bash
./gradlew \
  -PcassaPartialDefaultServerUrl=https://192.168.1.79:5380/postazione/ \
  -PcassaApi31CompatEnrollmentEndpointId=ENDPOINT_ID_PROVISIONATO \
  -PcassaApi31CompatEnrollmentUrl=https://192.168.1.79:9443/v2/enroll \
  -PcassaApi31CompatEnrollmentSpkiSha256=sha256/PIN_SPKI_BASE64_PROVISIONATO \
  :app:testApi31CompatUnitTest \
  :app:lintApi31Compat \
  :app:assembleApi31Compat
```

Il package resta `com.sentrapa.postazione.advanced.partial`; la versione e
`2.0.23-api31compat` code `25`. L'endpoint enrollment deve essere HTTPS, avere
path esatto `/v2/enroll`, non contenere credenziali, query o fragment ed essere
legato a un pin SPKI SHA-256 canonico e nonzero. La build fallisce prima della
compilazione se endpoint ID, URL o pin non sono validi.

Il comando mostra il target previsto per lo staging, non un endpoint gia
attestato. Il certificato attualmente esposto su `5380` non include
`192.168.1.79` nei SAN: non deve essere usato per enrollment perche la verifica
hostname di OkHttp fallirebbe prima del pin. Prima di installare la compat
serve un endpoint staging separato, previsto su `9443`, con SAN corretto e pin
SPKI ricavato dal certificato realmente distribuito. Gli APK compilati con URL
o pin fittizi sono soltanto artefatti di test e non vanno installati.

Questa variante abilita il percorso Lab Bluetooth compatibile da API 31 e usa
il profilo discovery esplicito `API31_COMPAT_NON_GATE`. I marker manifest
`PARTIAL_NON_GATE` e `API31_COMPAT_NON_GATE` sono entrambi `true`: anche un
diagnostico radio completamente riuscito non puo essere usato per promuovere
B0-B6. La partial senza Bluetooth rimane separata come build type e conserva
tutti i flag Bluetooth forzati a `false`.

L'installazione sul tablet usa esclusivamente aggiornamento conservativo:

```bash
adb install -r -g app/build/outputs/apk/api31Compat/app-api31Compat.apk
```

Non usare `uninstall` o `pm clear`. Poiche partial e compat condividono lo
stesso application ID, non possono essere installate contemporaneamente, ma
si aggiornano a vicenda mantenendo i dati.

## Integrazioni native

- HTTPS LAN per l'origine configurata.
- Permessi WebView per microfono, fotocamera e geolocalizzazione.
- NFC con sessione attiva solo mentre il frontend ascolta `native:nfc`.
- Feedback aptico tramite `window.AmaliaNativeHaptics`.
- PTT sul canale principale con pressione prolungata di Volume Su, quando il
  frontend e la sessione espongono il contesto radio.
- Ricezione radio nativa quando UI o schermo non sono attivi e l'identita e
  completa.
- Batteria inviata quando cambiano percentuale o stato di carica, piu heartbeat.
- Notifiche Android raggruppate e silenziose a UI aperta.

## Policy notifiche in background

- Chiamate cameriere, comande pronte e squilli palmare sono raggruppati per tipologia.
- Le notifiche generali visibili sono al massimo le ultime tre.
- Una raffica genera un solo suono e una sola vibrazione per tipologia.
- I segnali sono accodati e non si sovrappongono.
- Chiamate cameriere e comande pronte ancora attive vengono ricordate ogni 5 secondi.
- I messaggi FCM devono essere `data-only` per consentire all'app di applicare sempre
  filtro e raggruppamento. I payload FCM `notification` possono essere mostrati
  direttamente da Android prima del servizio applicativo.

## Build Windows

Prerequisiti: Android SDK 34 e Java 17 o 21.

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

APK generato:

`app/build/outputs/apk/debug/app-debug.apk`

Questo percorso contiene sempre l'ultima variante compilata e puo quindi
essere sovrascritto da una build Lab.

Build B5.6 Lab:

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
  :app:assembleDebug
```

La variante certificata e
`../../../artifacts/Postazione-Advanced-v2.0.20-V5BT-Bluetooth-B5.6-Lab-debug.apk`.
`DirectServer` e `PeerLink` non vengono passati e restano falsi. Il client
B5.6 accetta soltanto Raspberry autorizzabili annunciati come raggiungibili,
apre la connessione GATT, valida esattamente servizio e caratteristiche e
negozia l'MTU, lo scambio HELLO e l'autenticazione reciproca. Condivide il
package Advanced con la build standard.

Il package e `com.sentrapa.postazione.advanced`, installabile accanto alla
precedente app landscape. L'orientamento dell'activity e bloccato su
`landscape`.

Il file `local.properties` e specifico della macchina e non deve essere distribuito
come configurazione universale.
